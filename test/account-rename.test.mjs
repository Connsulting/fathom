import test from 'node:test';
import assert from 'node:assert/strict';
import { src } from './helpers/server.mjs';
import { realStore, aggregatorFile, NOW } from './helpers/ingest.mjs';

test('a display name survives a re-import and a SimpleFIN refresh, and clearing returns the default', async () => {
  const s = await realStore();
  const P = await src('src/ingest/pipeline.mjs');
  const SF = await src('src/ingest/simplefin.mjs');
  const { accountRename } = await src('src/api/accounts.mjs');
  const row = { date: '2032-02-01', amount: '10.00', type: 'Checking', account: 'Chase 2738 2738', number: '9992738', inst: 'Chase', description: 'Synthetic' };
  try {
    const first = await P.ingestFile(s.db, aggregatorFile('first.csv', [row]), s.opts(null));
    assert.equal(first.status, 'imported');
    const acct = s.db.prepare('SELECT * FROM accounts').get();
    const renamed = accountRename({ db: s.db, config: s.config, params: { id: acct.id }, body: { displayName: 'Household cash' } });
    assert.equal(renamed.account.name, 'Household cash');
    assert.equal(renamed.account.displayName, 'Household cash');

    const again = await P.ingestFile(s.db, aggregatorFile('second.csv', [{ ...row, date: '2032-02-02', description: 'Later' }]), s.opts(null));
    assert.equal(again.status, 'imported');
    assert.equal(s.db.prepare('SELECT display_name, name FROM accounts WHERE id = ?').get(acct.id).display_name, 'Household cash');

    const doc = {
      format: 'fathom-simplefin-1',
      accounts: [{
        accountId: acct.id,
        identity: acct.identity,
        account: { inst: 'Chase', mask: '2738', name: 'Chase 2738 2738', kind: 'checking' },
        balance: { date: '2032-02-03', amount: 12 },
        transactions: [],
      }],
    };
    const refreshed = await P.ingestFile(s.db, {
      name: 'SimpleFIN sync 2032-02-03.json',
      bytes: Buffer.from(JSON.stringify(doc)),
      mime: 'application/json',
    }, { ...s.opts(null), parser: SF.parser });
    assert.equal(refreshed.status, 'imported');
    const after = s.db.prepare('SELECT display_name, name, mirror FROM accounts WHERE id = ?').get(acct.id);
    assert.equal(after.display_name, 'Household cash');
    assert.equal(after.name, 'Chase 2738 2738');

    const cleared = accountRename({ db: s.db, config: s.config, params: { id: acct.id }, body: { displayName: '  ' } });
    assert.equal(cleared.account.displayName, null);
    assert.equal(cleared.account.name, 'Chase savings ending 2738');
    assert.equal(cleared.account.name.includes('2738 2738'), false);
    assert.equal(s.db.prepare('SELECT display_name FROM accounts WHERE id = ?').get(acct.id).display_name, null);
  } finally {
    s.close();
  }
});

test('a rename updates the trend, the source and the question, and list_accounts hides a holder name', async () => {
  const s = await realStore();
  const P = await src('src/ingest/pipeline.mjs');
  const { accountRename } = await src('src/api/accounts.mjs');
  const { buildScenario } = await src('src/scenario/build.mjs');
  const { callTool } = await src('src/tools/index.mjs');
  const { seriesKey } = await src('src/jobs/planner/series.mjs');
  const { upsertFact } = await src('src/store/facts.mjs');
  const row = { date: '2032-02-01', amount: '10.00', type: 'Brokerage', account: 'Avery Example', number: '9993046', inst: 'Harbor', description: 'Synthetic' };
  try {
    upsertFact(s.db, { key: 'household.names', value: { me: 'Avery Example', spouse: 'Blair Example' }, src: 'you', asOf: '2032-02-01', confirmed: true, now: NOW });
    const imported = await P.ingestFile(s.db, aggregatorFile('holder.csv', [row]), s.opts(null));
    assert.equal(imported.status, 'imported');
    const acct = s.db.prepare('SELECT * FROM accounts').get();
    s.db.prepare('INSERT INTO account_holders (account_id, holder, created_at) VALUES (?, ?, ?)').run(acct.id, 'Avery Example', NOW);
    const listed = await callTool('list_accounts', {}, { db: s.db, now: NOW });
    const got = listed.find((a) => a.id === acct.id);
    assert.equal(got.name, 'Harbor brokerage ending 3046');
    assert.equal(got.name.includes('Avery'), false);

    const key = seriesKey(acct.id);
    s.db.prepare('INSERT INTO content (key, value, src, updated_at) VALUES (?, ?, ?, ?)').run(
      'series', JSON.stringify({ [key]: { label: 'Individual 3046', unit: '$', src: 'balances', points: [] } }), 'test', NOW);
    s.db.prepare('INSERT INTO sources (id, label, as_of, kind) VALUES (?, ?, ?, ?)').run(`acct:${acct.id}`, 'Individual 3046', '2032-02-01', 'account');

    accountRename({ db: s.db, config: s.config, params: { id: acct.id }, body: { displayName: 'Household reserve' } });
    const scenario = buildScenario(s.db, {});
    assert.equal(scenario.series[key].label, 'Household reserve 3046');
    assert.equal(scenario.src[`acct:${acct.id}`].label, 'Household reserve ...3046');
    s.db.prepare(`INSERT INTO figures (key, v, src, kind, label, updated_at) VALUES (?, 10, ?, 'a', ?, ?)`).run(
      `bal.${acct.id}`, `acct:${acct.id}`, 'Balance, Individual 3046', NOW);
    const figures = await callTool('get_figures', { keys: [`bal.${acct.id}`] }, { db: s.db, now: NOW });
    assert.equal(figures[0].label, 'Balance, Household reserve');
    assert.equal(figures[0].source.label, 'Household reserve ...3046');
    const question = scenario.live.ingest.items.find((i) => i.subject === acct.id);
    assert.ok(question, 'the import asked about the account');
    assert.equal(question.question.includes('Household reserve'), true);
    assert.equal(question.question.includes('Avery'), false);
  } finally {
    s.close();
  }
});

test('renaming a mortgage does not drop its 1098, and year end hides a holder name', async () => {
  const s = await realStore();
  const { yearendChecklist } = await src('src/yearend/expected.mjs');
  const { upsertFact } = await src('src/store/facts.mjs');
  try {
    upsertFact(s.db, { key: 'household.names', value: { me: 'Avery Example' }, src: 'you', asOf: '2032-02-01', confirmed: true, now: NOW });
    s.db.prepare(`INSERT INTO accounts (id, inst, mask, name, kind, display_name) VALUES ('loan1', 'Harbor', '3046', 'Avery Example', 'taxable', NULL)`).run();
    s.db.prepare('INSERT INTO account_holders (account_id, holder, created_at) VALUES (?, ?, ?)').run('loan1', 'Avery Example', NOW);
    s.db.prepare(`INSERT INTO accounts (id, inst, name, kind, display_name) VALUES ('mtg', 'Harbor', 'Home mortgage', 'loan', 'Primary residence debt')`).run();
    s.db.prepare(`INSERT INTO transactions (account_id, date, amount, description) VALUES ('loan1', '2032-02-01', 1, 'Synthetic'), ('mtg', '2032-02-01', -1, 'Synthetic')`).run();
    const list = yearendChecklist(s.db, { year: 2032, clock: '2032-06-01' });
    const brokerage = list.items.find((i) => i.key === '1099-composite:loan1');
    assert.ok(brokerage, 'the brokerage is on the checklist');
    assert.equal(brokerage.t.includes('Avery'), false);
    assert.equal(brokerage.t.includes('Harbor'), true);
    assert.ok(list.items.some((i) => i.key === '1098:mtg'), 'the renamed mortgage still needs a 1098');
  } finally {
    s.close();
  }
});
