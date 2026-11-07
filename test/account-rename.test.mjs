import test from 'node:test';
import assert from 'node:assert/strict';
import { src } from './helpers/server.mjs';
import { realStore, aggregatorFile } from './helpers/ingest.mjs';

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
