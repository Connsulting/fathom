import { seedHistoricalRows, seedHistoricalDocument, historicalNorthwindRows, historicalTaxRows } from '../helpers/historical-import.mjs';
// AC1 (plan feat-confirm-context, Interfaces): every confirm card carries the context needed to
// answer it. cardDetail gives an account view (institution, mask, holder, files, range, row counts,
// latest balance and recent rows with their file) with its same-named accounts and the fields that
// differ; a side-by-side compare for near_duplicate, withholding_conflict and account_match; and a
// values list with the file for the other kinds. Holder names come only from the source's own
// columns and never change dedupe keys. Every value here is synthetic.

import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mapSeries, findSeries } from '../../src/shared/series.mjs';
import { src } from '../helpers/server.mjs';
import { fixture, textFile, northwindFile, realStore, fakeEngine, offEngine, aggregatorFile, positionsFile, one, all, count, NOW } from '../helpers/ingest.mjs';

let P;
let C;
before(async () => {
  P = await src('src/ingest/pipeline.mjs');
  C = await src('src/ingest/confirm.mjs');
});

const AGG_FILE = 'aggregator-household.csv';
const CHASE_FILE = 'Chase4455_Activity_20261031.csv';
const POS_FILE = 'positions-household.csv';
const household = () => [AGG_FILE, CHASE_FILE, POS_FILE].map((name) => fixture(`household/${name}`, 'text/csv'));
const ACCOUNT_FIELDS = ['institution', 'mask', 'holder', 'owner', 'kind', 'balance', 'from', 'to', 'files'];

async function withStore(fn) {
  const s = await realStore();
  try { return await fn(s); } finally { await s.close(); }
}
// The three household files in one ingestFiles call, engine off.
const withHousehold = async (fn) => withStore(async (s) => {
  await P.ingestFiles(s.db, household(), s.opts(await offEngine()));
  return await fn(s);
});

// Account id by mask and institution ('' for the positions accounts, which carry none).
const acct = async (db, mask, inst) => (await one(db, "SELECT id FROM accounts WHERE mask = ? AND coalesce(inst, '') = ?", mask, inst)).id;
const fileIdOf = async (db, name) => (await one(db, 'SELECT id FROM files WHERE name = ?', name)).id;
const pendingFor = async (db, kind, subject) => {
  const item = (await C.pendingItems(db)).find((i) => i.kind === kind && i.subject === subject);
  assert.ok(item, `a pending ${kind} for ${subject}`);
  return item;
};

describe('account cards', () => {
  let X;
  before(async () => { X = await src('src/ingest/context.mjs'); });

  test('Everyday Checking: institution, mask, holder, both files, range, row counts, latest balance and recent rows with provenance', async () => await withHousehold(async (s) => {
    const id = await acct(s.db, '4455', 'Chase');
    const d = (await X.cardDetail(s.db, (await pendingFor(s.db, 'account_owner', id))));
    assert.equal(d.type, 'account');
    const v = d.account;
    assert.equal(v.id, id);
    assert.equal(v.institution, 'Chase');
    assert.equal(v.name, 'Everyday Checking');
    assert.equal(v.mask, '4455');
    assert.equal(v.holder, 'Avery Example');
    const names = v.files.map((f) => f.name);
    assert.ok(names.includes(AGG_FILE) && names.includes(CHASE_FILE), `both source files, got ${names}`);
    assert.ok(v.files.every((f) => typeof f.id === 'string' && f.id.length > 0));
    assert.equal(v.from, '2026-10-01');
    assert.equal(v.to, '2026-10-14');
    assert.equal(v.rows.transactions, await count(s.db, 'transactions', 'account_id = ?', id), 'the stored transaction count');
    assert.equal(v.rows.balances, await count(s.db, 'balances', 'account_id = ?', id));
    assert.equal(v.rows.positions, 0);
    const chase = await fileIdOf(s.db, CHASE_FILE);
    assert.deepEqual(v.balance, {
      amount: 5551.96, date: '2026-10-14', fileId: chase, fileName: CHASE_FILE, basis: 'balance', sources: [{ fileId: chase, fileName: CHASE_FILE }],
    });
    assert.equal(v.recent.length, 3);
    assert.deepEqual(v.recent[0], { date: '2026-10-14', amount: -8.75, description: 'SQ *CORNER CF', name: 'Corner Cf', fileName: CHASE_FILE });
    assert.deepEqual(v.recent[1], { date: '2026-10-12', amount: -8.75, description: 'Corner Cafe', name: 'Corner Cafe', fileName: AGG_FILE });
    for (let i = 1; i < v.recent.length; i++) assert.ok(v.recent[i - 1].date >= v.recent[i].date, 'newest first');
    assert.ok(v.recent.every((r) => [AGG_FILE, CHASE_FILE].includes(r.fileName)));
  }));

  test('Individual TOD: the other three same-named accounts are listed and mask, holder and institution differ', async () => await withHousehold(async (s) => {
    const id = await acct(s.db, '1111', 'Example Brokerage');
    const spouseTod = await acct(s.db, '2222', 'Example Brokerage');
    const d = (await X.cardDetail(s.db, (await pendingFor(s.db, 'account_owner', id))));
    assert.equal(d.type, 'account');
    assert.equal(d.account.holder, 'Avery Example');
    assert.deepEqual(d.sameName.map((v) => v.id).sort(), [spouseTod, await acct(s.db, '1111', ''), await acct(s.db, '2222', '')].sort());
    assert.ok(d.sameName.every((v) => v.name === 'Individual TOD'));
    assert.equal(d.sameName.find((v) => v.id === spouseTod).holder, 'Blair Example');
    for (const field of ['mask', 'holder', 'institution']) assert.ok(d.differs.includes(field), `differs names ${field}, got ${d.differs}`);
    assert.ok(d.differs.every((f) => ACCOUNT_FIELDS.includes(f)), `only view fields, got ${d.differs}`);
  }));

  test('a positions account shows its holdings total as the balance, from the positions file', async () => await withHousehold(async (s) => {
    const id = await acct(s.db, '1111', '');
    const v = (await X.cardDetail(s.db, (await pendingFor(s.db, 'account_owner', id)))).account;
    const pos = await fileIdOf(s.db, POS_FILE);
    assert.deepEqual(v.balance, {
      amount: 1250, date: '2026-10-31', fileId: pos, fileName: POS_FILE, basis: 'holdings', sources: [{ fileId: pos, fileName: POS_FILE }],
    });
    assert.equal(v.rows.positions, 2);
    assert.equal(v.holder ?? null, null, 'the positions export names no holder');
    assert.deepEqual(v.files.map((f) => f.name), [POS_FILE]);
  }));

  // Review finding: a holdings balance names every file that contributed rows, not only the last.
  // Two positions exports of one account (Z5550002222) as of 2032-03-05 with different symbols. The
  // second carries a truncated record of that account, so removeOmittedPositions treats its snapshot
  // as incomplete and keeps the first file's FUNDA row: both files' rows stay stored.
  test('a holdings balance from two positions files on one account and date lists both files as sources', async () => withStore(async (s) => {
    const first = positionsFile('positions-part-a.csv', [{ symbol: 'FUNDA', quantity: '6', price: '100.00', value: '600.00' }]);
    const second = positionsFile('positions-part-b.csv', [{ symbol: 'FUNDB', quantity: '4', price: '100.00', value: '400.00' }], { extra: ['Z5550002222'] });
    await P.ingestFiles(s.db, [first], s.opts(await offEngine()));
    await P.ingestFiles(s.db, [second], s.opts(await offEngine()));
    const id = await acct(s.db, '2222', '');
    const stored = await all(s.db, 'SELECT symbol, as_of, file_id FROM positions WHERE account_id = ? ORDER BY symbol', id);
    const a = await fileIdOf(s.db, first.name);
    const b = await fileIdOf(s.db, second.name);
    assert.deepEqual(stored, [{ symbol: 'FUNDA', as_of: '2032-03-05', file_id: a }, { symbol: 'FUNDB', as_of: '2032-03-05', file_id: b }],
      'precondition: both files keep their rows on the same account and date');
    const item = (await C.listItems(s.db, { status: 'all' })).find((i) => i.kind === 'account_owner' && i.subject === id);
    assert.ok(item, 'precondition: an owner question for the positions account');
    const bal = (await X.cardDetail(s.db, item)).account.balance;
    assert.equal(bal.basis, 'holdings');
    assert.equal(bal.amount, 1000, 'the sum of both files');
    assert.equal(bal.date, '2032-03-05');
    const byName = (x, y) => (x.fileName < y.fileName ? -1 : 1);
    assert.deepEqual([...bal.sources].sort(byName), [{ fileId: a, fileName: first.name }, { fileId: b, fileName: second.name }]);
    assert.equal(bal.fileName, bal.sources.map((f) => f.fileName).join(', '), 'fileName joins every source file');
    assert.ok(bal.fileName.includes(first.name) && bal.fileName.includes(second.name));
  }));

  test('an account_kind card uses the same view; an account with no same-named sibling differs in nothing', async () => await withHousehold(async (s) => {
    const id = await acct(s.db, '3344', 'Example Card');
    await C.reopenItem(s.db, (await C.listItems(s.db, { status: 'answered' })).find(i => i.kind === 'account_kind' && i.subject === id).id, { now: NOW });
    const d = (await X.cardDetail(s.db, (await pendingFor(s.db, 'account_kind', id))));
    assert.equal(d.type, 'account');
    assert.equal(d.account.name, 'Rewards Card');
    assert.equal(d.account.holder, 'Blair Example');
    assert.deepEqual(d.sameName, []);
    assert.deepEqual(d.differs, []);
  }));
});

describe('compare cards', () => {
  let X;
  let S;
  before(async () => {
    X = await src('src/ingest/context.mjs');
    S = await src('src/ingest/simplefin.mjs');
  });

  test('near_duplicate: the Corner Cafe pair side by side; date, description and file differ, amount does not', async () => await withHousehold(async (s) => {
    const items = (await C.pendingItems(s.db)).filter((i) => i.kind === 'near_duplicate');
    const found = (await mapSeries(items, async (item) => [item, await X.cardDetail(s.db, item)]))
      .find(([, d]) => d.entries?.some((e) => e.description === 'Corner Cafe'));
    assert.ok(found, 'the Corner Cafe pair is a pending near_duplicate');
    const [item, d] = found;
    assert.equal(d.type, 'compare');
    assert.deepEqual(d.fields, ['date', 'amount', 'description', 'account', 'file']);
    assert.equal(d.entries.length, 2);
    assert.deepEqual(new Set(d.entries.map((e) => e.key)), new Set(item.context.keys));
    assert.deepEqual(d.entries.map((e) => e.description).sort(), ['Corner Cafe', 'SQ *CORNER CF']);
    assert.deepEqual(d.entries.map((e) => e.date).sort(), ['2026-10-12', '2026-10-14']);
    assert.deepEqual(d.entries.map((e) => e.amount), [-8.75, -8.75]);
    assert.deepEqual(d.entries.map((e) => e.account), ['Everyday Checking', 'Everyday Checking']);
    assert.deepEqual(d.entries.map((e) => e.file).sort(), [CHASE_FILE, AGG_FILE].sort());
    for (const field of ['date', 'description', 'file']) assert.ok(d.differs.includes(field), `differs names ${field}`);
    assert.ok(!d.differs.includes('amount'));
    assert.ok(!d.differs.includes('account'));
  }));

  // The two-W-2 withholding_conflict setup of extract.test.mjs (K1): same employer and year,
  // federal withholding 12000 then 13000, the employer answered as the owner's.
  const W2_FIRST = {
    taxYear: 2032, employerName: 'Example Employer LLC', wages: 90000, federalWithheld: 12000, socialSecurityWages: 90000,
    medicareWages: 90000, state: 'CO', stateWages: 90000, stateWithheld: 0, retirementPlan: true, box12: [{ code: 'D', amount: 6000 }], confidence: 0.92,
  };
  const importW2 = async (s, copy, extracted) => {
    const file = textFile(`w2-${copy}-2032.txt`, `Synthetic wage and tax statement for 2032, copy ${copy}`, 'text/plain');
    const r = await seedHistoricalDocument(s, file, [[{ docType: 'w2', taxYear: 2032, confidence: 0.9 }], [extracted]]);
    assert.equal(r.status, 'imported');
    return file.name;
  };

  test('withholding_conflict: both tax payment rows side by side; amount and file differ', async () => withStore(async (s) => {
    const first = await importW2(s, 'first', W2_FIRST);
    const second = await importW2(s, 'second', { ...W2_FIRST, federalWithheld: 13000 });
    const employer = (await C.pendingItems(s.db)).find((i) => i.kind === 'employer_recipient');
    await C.answer(s.db, employer.id, 'owner', { now: NOW });
    const item = (await C.pendingItems(s.db)).find((i) => i.kind === 'withholding_conflict');
    assert.ok(item, 'a withholding_conflict is pending');
    const d = (await X.cardDetail(s.db, item));
    assert.equal(d.type, 'compare');
    assert.deepEqual(d.fields, ['date', 'amount', 'payer', 'jurisdiction', 'taxYear', 'recipient', 'file']);
    assert.equal(d.entries.length, 2);
    assert.deepEqual(d.entries.map((e) => e.amount).sort((a, b) => a - b), [12000, 13000]);
    assert.deepEqual(d.entries.map((e) => e.file).sort(), [first, second].sort());
    assert.ok(d.entries.every((e) => e.jurisdiction === 'federal' && e.taxYear === 2032 && e.recipient === 'owner'));
    assert.ok(d.differs.includes('amount'));
    assert.ok(d.differs.includes('file'));
    assert.ok(!d.differs.includes('jurisdiction'));
    assert.ok(!d.differs.includes('taxYear'));
  }));

  // The unsure-match setup of simplefin.test.mjs: an imported "Joint checking" at Other bank with no
  // mask, and the fake bridge's "Checking" at Other bank (balance 3120.00).
  const TODAY = NOW.slice(0, 10);
  const sfOpts = (s) => ({ config: s.config, household: s.household, now: NOW, clock: TODAY, fetch: S.createFakeSimplefin({ today: () => TODAY }) });

  test('account_match: the imported candidate beside the SimpleFIN snapshot, with no bridge account ids', async () => withStore(async (s) => {
    await P.ingestFile(s.db, aggregatorFile('other.csv', [
      { date: '2032-01-05', amount: '5.00', inst: 'Other bank', account: 'Joint checking', number: '', description: 'Old' },
    ]), s.opts(null));
    await S.connectSimplefin(s.db, S.fakeToken(), sfOpts(s));
    await S.syncSimplefin(s.db, sfOpts(s));
    const item = (await C.pendingItems(s.db)).find((i) => i.kind === 'account_match');
    assert.ok(item, 'an account_match is pending');
    const d = (await X.cardDetail(s.db, item));
    assert.equal(d.type, 'compare');
    assert.ok(d.fields.includes('balanceDate'), `fields names balanceDate, got ${d.fields}`);
    assert.deepEqual(d.fields.filter((f) => f !== 'balanceDate'), ['institution', 'name', 'mask', 'balance', 'from', 'to', 'count', 'file']);
    assert.equal(d.entries.length, 2);
    assert.ok(d.entries.every((e) => 'balanceDate' in e), 'each entry carries balanceDate');
    const [imported, bridge] = d.entries;
    assert.equal(imported.name, 'Joint checking');
    assert.equal(imported.institution, 'Other bank');
    assert.equal(imported.file, 'other.csv');
    assert.equal(bridge.file, 'SimpleFIN');
    assert.equal(bridge.institution, 'Other bank');
    assert.equal(bridge.name, 'Checking');
    const amount = bridge.balance && typeof bridge.balance === 'object' ? bridge.balance.amount : bridge.balance;
    assert.equal(amount, 3120);
    assert.ok(d.differs.includes('name'));
    const text = JSON.stringify(d);
    assert.ok(!/ACT-|CON-/.test(text), 'no bridge account or connection id leaks into the card');
  }));
  // Review finding: the account_match detail keeps the full context next to the compare rows: the
  // candidate's full account view, the other accounts with its normalized name, and the stored
  // SimpleFIN snapshot's newest postings and balance date. A second "Joint checking" at another
  // institution is the same-named account.
  const HELD_HEADER = 'Date,Original Date,Account Type,Account Name,Account Number,Institution Name,Name,Custom Name,Amount,Description,Category,Note,Ignored From,Tax Deductible,Transaction Tags,Account Holder';
  const heldRow = (date, account, number, inst, amount, description, holder) => [date, '', 'Checking', account, number, inst, '', '', amount, description, 'Other', '', '', '', '', holder].join(',');

  test('account_match: the detail carries the candidate view, its same-named accounts and the SimpleFIN snapshot', async () => withStore(async (s) => {
    await P.ingestFile(s.db, textFile('other.csv', [HELD_HEADER,
      heldRow('2032-01-05', 'Joint checking', '', 'Other bank', '5.00', 'Old', 'Avery Example'),
      heldRow('2032-01-09', 'Joint checking', '', 'Other bank', '7.50', 'Older still', 'Avery Example'),
    ].join('\n') + '\n', 'text/csv'), s.opts(null));
    await P.ingestFile(s.db, textFile('namesake.csv', [HELD_HEADER,
      heldRow('2032-01-07', 'Joint checking', '0009876', 'Example Bank', '3.00', 'Namesake', 'Blair Example'),
    ].join('\n') + '\n', 'text/csv'), s.opts(null));
    await S.connectSimplefin(s.db, S.fakeToken(), sfOpts(s));
    await S.syncSimplefin(s.db, sfOpts(s));
    const item = (await C.pendingItems(s.db)).find((i) => i.kind === 'account_match');
    assert.ok(item, 'an account_match is pending');
    const { candidateId, sfKey } = item.context;
    const candidate = (await one(s.db, "SELECT id FROM accounts WHERE inst = 'Other bank' AND name = 'Joint checking'")).id;
    assert.equal(candidateId, candidate, 'precondition: the Other bank account is the candidate');
    const namesake = await acct(s.db, '9876', 'Example Bank');
    const viewOf = async (id) => (await X.cardDetail(s.db, (await C.listItems(s.db, { status: 'all' })).find((i) => i.kind === 'account_owner' && i.subject === id))).account;
    const d = (await X.cardDetail(s.db, item));
    assert.equal(d.type, 'compare');

    assert.deepEqual(d.account, (await viewOf(candidate)), 'the candidate is the full account view');
    assert.equal(d.account.id, candidate);
    assert.equal(d.account.holder, 'Avery Example');
    assert.deepEqual(d.account.files.map((f) => f.name), ['other.csv']);
    assert.equal(d.account.rows.transactions, 2);
    assert.ok('balance' in d.account, 'the view carries its balance (with provenance when one is stored)');
    assert.deepEqual(d.account.recent.map((r) => [r.date, r.description, r.fileName]), [['2032-01-09', 'Older still', 'other.csv'], ['2032-01-05', 'Old', 'other.csv']]);

    assert.deepEqual(d.sameName.map((v) => v.id), [namesake]);
    assert.deepEqual(d.sameName[0], (await viewOf(namesake)), 'each same-named account is a full view');
    assert.equal(d.sameName[0].holder, 'Blair Example');

    const stored = JSON.parse((await one(s.db, 'SELECT snapshot FROM simplefin_snapshots WHERE sf_key = ?', sfKey)).snapshot);
    assert.deepEqual(d.snapshot, {
      recent: stored.recent.slice(0, 3).map((r) => ({ date: r.date, amount: Number(r.amount), description: r.description, name: r.description })),
      balanceDate: stored.balanceDate,
    });
    assert.equal(d.snapshot.recent.length, 1, 'the fake bridge checking has one posting');
    assert.equal(d.snapshot.recent[0].description, 'Coffee shop');
    assert.equal(d.snapshot.recent[0].amount, -25);
    assert.ok(typeof d.snapshot.balanceDate === 'string' && d.snapshot.balanceDate.length > 0, 'the snapshot balance date is stored');

    assert.ok(d.fields.includes('balanceDate'));
    assert.equal(d.entries[1].balanceDate, d.snapshot.balanceDate, 'the bridge entry carries the snapshot balance date');
    assert.ok(!/ACT-|CON-/.test(JSON.stringify(d)), 'no bridge account or connection id leaks into the card');
  }));
});

describe('values cards', () => {
  let X;
  before(async () => { X = await src('src/ingest/context.mjs'); });

  const valuesOf = async (db, kind) => {
    const item = (await C.pendingItems(db)).find((i) => i.kind === kind);
    assert.ok(item, `a pending ${kind}`);
    const d = (await X.cardDetail(db, item));
    assert.equal(d.type, 'values');
    assert.ok(Array.isArray(d.values) && d.values.length > 0, 'values are listed');
    assert.ok(d.values.every((v) => typeof v.label === 'string' && v.label.length > 0 && 'value' in v));
    return { item, d };
  };

  test('fact_check names its file, the fact key and the imported value', async () => withStore(async (s) => {
    const facts = [{ key: 'household.state', value: 'CO', confidence: 0.6 }];
    const r = await seedHistoricalDocument(s, fixture('notes.md'), [[{ facts, goals: [] }]]);
    const { d } = (await valuesOf(s.db, 'fact_check'));
    assert.deepEqual(d.file, { id: r.fileId, name: 'notes.md' });
    const text = JSON.stringify(d.values);
    assert.ok(text.includes('household.state') && text.includes('CO'), text);
  }));

  test('tax_year names its file and the sheet year', async () => withStore(async (s) => {
    const r = await seedHistoricalRows(s, fixture('tax-payments.xlsx'), historicalTaxRows(false), { parser: 'tax-payments', sourceKind: 'tax_payments', period: { from: '2031-12-31', to: '2032-03-31' } });
    const { item, d } = (await valuesOf(s.db, 'tax_year'));
    assert.deepEqual(d.file, { id: r.fileId, name: 'tax-payments.xlsx' });
    assert.ok(JSON.stringify(d.values).includes(String(item.context.sheetYear)));
  }));

  test('entity_alias names its file and the alias', async () => withStore(async (s) => {
    const r = await seedHistoricalRows(s, northwindFile(), historicalNorthwindRows(200), { parser: 'pnl-workbook', sourceKind: 'pnl_workbook', period: { from: '2032-04-01', to: '2032-04-30' } });
    const { d } = (await valuesOf(s.db, 'entity_alias'));
    assert.deepEqual(d.file, { id: r.fileId, name: 'northwind-pnl.xlsx' });
    assert.ok(JSON.stringify(d.values).includes('Northwind'));
  }));
});

describe('holder columns', () => {
  let AGG;
  let POS;
  let M;
  let D;
  before(async () => {
    AGG = await src('src/ingest/parsers/aggregator.mjs');
    POS = await src('src/ingest/parsers/brokerage-positions.mjs');
    D = await src('src/ingest/dedupe.mjs');
  });

  const COLUMNS = ['Account Holder', 'Account Owner', 'Owner', 'Holder'];
  const AGG_HEAD = 'Date,Original Date,Account Type,Account Name,Account Number,Institution Name,Name,Custom Name,Amount,Description,Category,Note,Ignored From,Tax Deductible,Transaction Tags';
  const AGG_ROW = '2026-10-01,,Checking,Everyday Checking,9914455,Chase,Grocery Mart,,54.20,Grocery Mart,Groceries,,,,';
  const aggCsv = (column, value) => textFile('holder.csv', column ? `${AGG_HEAD},${column}\n${AGG_ROW},${value}\n` : `${AGG_HEAD}\n${AGG_ROW}\n`, 'text/csv');
  const POS_HEAD = "Account number,Account name,Symbol,Description,Quantity,Last price,Last price change,Current value,Today's gain/loss dollar,Today's gain/loss percent,Total gain/loss dollar,Total gain/loss percent,Percent of account,Cost basis total,Average cost basis,Type";
  const POS_ROW = 'Z00001111,Individual TOD,FUNDA,Example Total Market Fund,10,$100.00,+0.10,$1000.00,0,0,0,0,100%,$900.00,$90.00,Cash';
  const posCsv = (column, value) => textFile('positions-holder.csv',
    [`${POS_HEAD},${column}`, `${POS_ROW},${value}`, '', 'Date downloaded Oct-31-2026 10:00 a.m ET'].join('\n') + '\n', 'text/csv');

  for (const column of COLUMNS) {
    test(`aggregator and positions read the holder from a "${column}" column, trimmed`, () => {
      const [tx] = AGG.parse(aggCsv(column, ' Avery Example ')).rows;
      assert.equal(tx.account.holder, 'Avery Example');
      const [pos] = POS.parse(posCsv(column, ' Blair Example ')).rows;
      assert.equal(pos.kind, 'position');
      assert.equal(pos.account.holder, 'Blair Example');
    });
  }

  test('no holder column or an empty holder gives no holder', () => {
    assert.equal(AGG.parse(aggCsv(null)).rows[0].account.holder, undefined);
    assert.equal(AGG.parse(aggCsv('Account Holder', '')).rows[0].account.holder, undefined);
    assert.equal(POS.parse(posCsv('Account Holder', '')).rows[0].account.holder, undefined);
    const fromFixture = POS.parse(fixture(`household/${POS_FILE}`, 'text/csv')).rows;
    assert.ok(fromFixture.length > 0 && fromFixture.every((r) => r.account.holder === undefined));
  });

  test('a holder never changes the transaction dedupe key', () => {
    const [withHolder] = AGG.parse(aggCsv('Account Holder', 'Avery Example')).rows;
    const [without] = AGG.parse(aggCsv(null)).rows;
    assert.equal(withHolder.account.holder, 'Avery Example');
    assert.equal(D.dedupeKey(withHolder), D.dedupeKey(without));
  });


});
