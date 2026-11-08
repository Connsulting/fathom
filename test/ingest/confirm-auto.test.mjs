import { importProposedRows } from '../helpers/import-proposal-fixture.mjs';
// AC3 (plan feat-confirm-context, Revisions 2 and 3, Interfaces): Fathom answers a question itself
// only when stored rows settle it. Each rule (cross_format_duplicate, holder_match, shared_mask)
// records its answer through the normal answer path with an undo log and evidence; answers made by
// the owner propagate; undoing an auto answer declines it for good; undoing a basis reverts the
// answers that rest on it; auto owner and kind answers stay undoable after ordinary later imports.
// Every value here is synthetic.

import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { src } from '../helpers/server.mjs';
import { fixture, textFile, aggregatorFile, activityFile, positionsFile, realStore, offEngine, all, one, count, NOW } from '../helpers/ingest.mjs';

let P;
let C;
let A;
let F;
let FR;
before(async () => {
  P = await src('src/ingest/pipeline.mjs');
  C = await src('src/ingest/confirm.mjs');
  A = await src('src/ingest/auto.mjs');
  F = await src('src/store/facts.mjs');
  FR = await src('src/ingest/freshness.mjs');
});

const LATER = '2032-03-11T09:00:00.000Z';
const NAMES = { me: 'Avery Example', spouse: 'Blair Example' };
const AGG_FILE = 'aggregator-household.csv';
const CHASE_FILE = 'Chase4455_Activity_20261031.csv';
const POS_FILE = 'positions-household.csv';
const householdFiles = () => [AGG_FILE, CHASE_FILE, POS_FILE].map((name) => ({ ...fixture(`household/${name}`, 'text/csv'), name }));

async function withStore(fn) {
  const s = await realStore();
  try { return await fn(s); } finally { s.close(); }
}
const setNames = (db, value) => F.upsertFact(db, { key: 'household.names', value, src: 'you', asOf: NOW.slice(0, 10), confirmed: true, now: NOW });

// The household fixture in one ingestFiles call (autoResolve runs at its end).
async function withHousehold(fn, { names = null } = {}) {
  return withStore(async (s) => {
    if (names) setNames(s.db, names);
    await P.ingestFiles(s.db, householdFiles(), s.opts(await offEngine()));
    return fn(s);
  });
}

const accountId = (db, mask, inst) => {
  const row = one(db, "SELECT id FROM accounts WHERE mask = ? AND coalesce(inst, '') = ?", mask, inst);
  assert.ok(row, `an account ${inst || '(no institution)'} ${mask}`);
  return row.id;
};
// The household accounts by role.
const H = {
  brokerage1111: (db) => accountId(db, '1111', 'Example Brokerage'),
  brokerage2222: (db) => accountId(db, '2222', 'Example Brokerage'),
  positions1111: (db) => accountId(db, '1111', ''),
  positions2222: (db) => accountId(db, '2222', ''),
  checking: (db) => accountId(db, '4455', 'Chase'),
  card: (db) => accountId(db, '3344', 'Example Card'),
  rainyDay: (db) => accountId(db, '5566', 'Example Credit Union'),
};
const itemFor = (db, kind, subject) => {
  const item = C.listItems(db, { status: 'all' }).find((i) => i.kind === kind && i.subject === subject);
  assert.ok(item, `a ${kind} item for ${subject}`);
  return C.getItem(db, item.id);
};
const ownerItem = (db, role) => itemFor(db, 'account_owner', H[role](db));
const kindItem = (db, role) => itemFor(db, 'account_kind', H[role](db));
const accountOf = (db, id) => one(db, 'SELECT * FROM accounts WHERE id = ?', id);
const status = (db, id) => C.getItem(db, id).status;
const textOf = (evidence) => (typeof evidence === 'string' ? evidence : evidence?.text);
const declined = (db, id) => count(db, 'confirm_auto_declined', 'item_id = ?', id);

function assertAuto(db, item, { rule, answer }) {
  const now = C.getItem(db, item.id);
  assert.equal(now.status, 'answered', `${item.question} is answered`);
  assert.equal(now.answer, answer, `${item.question} is answered ${answer}`);
  const info = C.autoInfo(db, item.id);
  assert.ok(info, `${item.question} was answered by Fathom`);
  assert.equal(info.rule, rule);
  assert.equal(typeof textOf(info.evidence), 'string');
  assert.ok(textOf(info.evidence).length > 0, 'the evidence has text');
  assert.ok(Array.isArray(info.evidence.basis), 'evidence.basis is a list of item ids');
  assert.ok(Array.isArray(info.evidence.ancestors), 'evidence.ancestors is a list of item ids');
  assert.equal(typeof info.createdAt, 'string');
  assert.equal(count(db, 'confirm_undo', 'item_id = ?', item.id), 1, 'the auto answer stored an undo log');
  return info;
}
function assertPending(db, item, why) {
  assert.equal(status(db, item.id), 'pending', why);
  assert.equal(C.autoInfo(db, item.id), null, why);
}

// Dates a stored or archived transaction key stands for.
function dateOfKey(db, key) {
  const live = one(db, 'SELECT date FROM transactions WHERE dedupe_key = ?', key);
  if (live) return live.date;
  const archived = one(db, "SELECT row FROM superseded_rows WHERE table_name = 'transactions' AND dedupe_key = ? ORDER BY id DESC", key);
  return archived ? JSON.parse(archived.row).date : null;
}
const datesOf = (db, item) => item.subject.split('|').map((k) => dateOfKey(db, k)).sort();
const nearItems = (db) => C.listItems(db, { status: 'all' }).filter((i) => i.kind === 'near_duplicate');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Assumption: the evidence may write a date as ISO, as MM/DD/YYYY or with the month name.
function mentionsDate(text, iso) {
  const [y, m, d] = iso.split('-');
  const month = MONTHS[Number(m) - 1];
  return [iso, `${m}/${d}/${y}`, `${month} ${Number(d)}, ${y}`, `${month.slice(0, 3)} ${Number(d)}, ${y}`].some((form) => text.includes(form));
}

describe('multiHolder', () => {
  test('joined holder names are multi-holder; single names are not', () => {
    for (const text of ['Avery Example & Blair Example', 'Avery Example and Blair Example', 'Avery + Blair', 'Avery/Blair', 'Example, Avery', 'Avery OR Blair']) {
      assert.equal(A.multiHolder(text), true, text);
    }
    for (const text of ['Avery Example', 'Blair Anderson', 'Morgan Orly']) assert.equal(A.multiHolder(text), false, text);
  });
});

describe('recordAutoAnswer', () => {
  test('records an answer with its rule and evidence through the undo log, and refuses like answerItem', () => withHousehold((s) => {
    const card = kindItem(s.db, 'card');
    const rainy = kindItem(s.db, 'rainyDay');
    C.reopenItem(s.db, card.id, { now: NOW });
    assert.equal(C.getItem(s.db, card.id).status, 'pending');
    const evidence = { text: 'Synthetic evidence for a test.', basis: [], ancestors: [] };
    C.recordAutoAnswer(s.db, card.id, 'card', { rule: 'shared_mask', evidence, now: NOW });
    const info = assertAuto(s.db, card, { rule: 'shared_mask', answer: 'card' });
    assert.equal(textOf(info.evidence), evidence.text);
    assert.equal(accountOf(s.db, card.subject).kind, 'card');
    const refuse = (fn, code) => assert.throws(fn, (err) => err instanceof C.ConfirmError && err.code === code);
    refuse(() => C.recordAutoAnswer(s.db, card.id, 'cash', { rule: 'shared_mask', evidence, now: NOW }), 'answered');
    refuse(() => C.recordAutoAnswer(s.db, rainy.id, 'nobody', { rule: 'shared_mask', evidence, now: NOW }), 'bad_option');
    refuse(() => C.recordAutoAnswer(s.db, 999999, 'card', { rule: 'shared_mask', evidence, now: NOW }), 'not_found');
    assert.equal(status(s.db, rainy.id), 'pending', 'a refusal changes nothing');
  }));
});

describe('cross_format_duplicate', () => {
  test('the household checking: the AMZN collision and the City Water check are answered same; the Corner Cafe pair stays asked', () => withHousehold((s) => {
    const near = nearItems(s.db);
    assert.equal(near.length, 3, 'precondition: three near-duplicate pairs were found');
    const byDate = (iso) => near.find((i) => datesOf(s.db, i).includes(iso));
    const amzn = byDate('2026-10-03');
    const water = byDate('2026-10-07');
    const cafe = byDate('2026-10-12');
    assert.ok(amzn && water && cafe);
    assert.deepEqual(datesOf(s.db, cafe), ['2026-10-12', '2026-10-14']);

    for (const [item, iso, amount] of [[amzn, '2026-10-03', '23.99'], [water, '2026-10-07', '61.10']]) {
      const info = assertAuto(s.db, item, { rule: 'cross_format_duplicate', answer: 'same' });
      const text = textOf(info.evidence);
      assert.ok(mentionsDate(text, iso), `the evidence names the date: ${text}`);
      assert.ok(text.includes(AGG_FILE) && text.includes(CHASE_FILE), `the evidence names both files: ${text}`);
      assert.ok(text.includes(amount), `the evidence names the amount: ${text}`);
    }
    assertPending(s.db, cafe, 'two days apart is never auto-resolved');

    // Aggregator 10/01, 10/03, 10/05, 10/07, 10/12 plus the bank's 10/14; the bank's 10/03 and 10/07
    // rows are archived as confirmed duplicates.
    const checking = H.checking(s.db);
    const rows = all(s.db, 'SELECT date FROM transactions WHERE account_id = ? ORDER BY date', checking).map((r) => r.date);
    assert.deepEqual(rows, ['2026-10-01', '2026-10-03', '2026-10-05', '2026-10-07', '2026-10-12', '2026-10-14']);
    assert.equal(count(s.db, 'superseded_rows', "reason = 'duplicate_confirmed'"), 2);
  }));

  // R1 and R2-1: one posting in export A, two equal postings in export B. Descriptions share no word,
  // so nothing dedupes silently and both pairs are asked. Only the one-to-one collision pair may be
  // answered; two real postings must survive.
  const aggOne = () => aggregatorFile('multi-agg.csv', [
    { date: '2032-03-09', amount: '54.21', type: 'Checking', account: 'Synthetic checking', number: '9994321', inst: 'Chase', description: 'ALPHA' },
  ]);
  const bankTwo = () => activityFile('Chase4321_Activity_multi.csv', [
    { date: '03/09/2032', amount: '-54.21', balance: '', description: 'BRAVO' },
    { date: '03/09/2032', amount: '-54.21', balance: '', description: 'CHARLIE' },
  ]);
  for (const [label, order] of [['export A then B', () => [aggOne(), bankTwo()]], ['export B then A', () => [bankTwo(), aggOne()]]]) {
    test(`multiplicity (${label}): no real posting is lost and no auto answer merges two distinct postings`, () => withStore(async (s) => {
      await P.ingestFiles(s.db, order(), s.opts(await offEngine()));
      A.autoResolve(s.db, { now: NOW });
      assert.equal(count(s.db, 'accounts'), 1, 'precondition: one account for both formats');
      const near = nearItems(s.db);
      assert.equal(near.length, 2, 'precondition: both pairs were asked');
      const auto = near.filter((i) => C.autoInfo(s.db, i.id));
      assert.equal(auto.length, 1, 'exactly one pair is answered by Fathom');
      assert.equal(C.autoInfo(s.db, auto[0].id).rule, 'cross_format_duplicate');
      assert.equal(count(s.db, 'transactions'), 2, 'export B holds two real postings; both are kept');
    }));
  }

  // A reviewed ledger and bank check disagree on their external ids.
  const checkFile = () => activityFile('Chase0042_Activity_ext.csv', [{ date: '03/01/2032', amount: '-125.00', balance: '', description: 'CHECK 1042', check: '1042' }]);

  test('conflicting non-empty external ids never auto resolve', () => withStore(async (s) => {
    await P.ingestFiles(s.db, [checkFile()], s.opts(await offEngine()));
    const accountId = one(s.db, 'SELECT id FROM accounts').id;
    const reviewed = await importProposedRows(s,[{ target:'transaction',fields:{accountId,postedDate:'2032-03-01',amount:-125,description:'Synthetic transfer',externalId:'2001'} }]);
    assert.equal(reviewed.status,'imported');
    A.autoResolve(s.db, { now: NOW });
    assert.equal(count(s.db, 'accounts'), 1, 'precondition: one account for both formats');
    const ext = all(s.db, 'SELECT external_id FROM transactions ORDER BY external_id').map((r) => r.external_id);
    assert.deepEqual(ext, ['1042', '2001'], 'precondition: two rows with different external ids');
    const near = nearItems(s.db);
    assert.equal(near.length, 1, 'precondition: the pair is asked');
    assertPending(s.db, near[0], 'different reference numbers are different postings');
    assert.equal(count(s.db, 'transactions'), 2);
  }));
});

describe('holder_match', () => {
  test('with household names known before import, single-holder accounts are answered and positions follow', () => withHousehold((s) => {
    const expected = { brokerage1111: ['owner', 'You'], brokerage2222: ['spouse', 'Your spouse'], checking: ['owner', 'You'], card: ['spouse', 'Your spouse'] };
    for (const [role, [answer, label]] of Object.entries(expected)) {
      const item = ownerItem(s.db, role);
      const info = assertAuto(s.db, item, { rule: 'holder_match', answer });
      assert.equal(accountOf(s.db, item.subject).owner, label, `${role} owner is ${label}`);
      const holder = role.startsWith('brokerage1111') || role === 'checking' ? 'Avery Example' : 'Blair Example';
      assert.ok(textOf(info.evidence).includes(holder), `the evidence quotes the holder: ${textOf(info.evidence)}`);
    }
    for (const [pos, brok, answer] of [['positions1111', 'brokerage1111', 'owner'], ['positions2222', 'brokerage2222', 'spouse']]) {
      const info = assertAuto(s.db, ownerItem(s.db, pos), { rule: 'shared_mask', answer });
      assert.ok(info.evidence.ancestors.includes(ownerItem(s.db, brok).id), `${pos} rests on the ${brok} answer`);
    }
    assertPending(s.db, ownerItem(s.db, 'rainyDay'), 'a multi-holder account is never auto answered');
    assert.equal(C.pendingItems(s.db).length, 3);
  }, { names: NAMES }));

  test('without the names fact nothing is answered by holder at import', () => withHousehold((s) => {
    for (const role of Object.keys(H)) assertPending(s.db, ownerItem(s.db, role), `${role} owner stays asked`);
    assert.equal(C.pendingItems(s.db).filter((i) => i.kind === 'account_owner').length, 7);
  }));

  test('learned: answering the checking owner answers the brokerage with the same holder, and its positions follow', () => withHousehold((s) => {
    const checking = ownerItem(s.db, 'checking');
    C.answerItem(s.db, checking.id, 'owner', { now: LATER });
    const out = A.autoResolve(s.db, { now: LATER });
    const brokerage = ownerItem(s.db, 'brokerage1111');
    const positions = ownerItem(s.db, 'positions1111');
    assert.ok(out.answered.includes(brokerage.id) && out.answered.includes(positions.id), 'autoResolve reports what it answered');
    const b = assertAuto(s.db, brokerage, { rule: 'holder_match', answer: 'owner' });
    assert.ok(b.evidence.basis.includes(checking.id), 'the brokerage answer rests on the checking answer');
    assert.ok(textOf(b.evidence).includes('Avery Example'));
    assert.equal(accountOf(s.db, brokerage.subject).owner, 'You');
    const p = assertAuto(s.db, positions, { rule: 'shared_mask', answer: 'owner' });
    assert.ok(p.evidence.ancestors.includes(checking.id) && p.evidence.ancestors.includes(brokerage.id), 'positions rest on brokerage and checking');
    assert.equal(accountOf(s.db, positions.subject).owner, 'You');
    for (const role of ['brokerage2222', 'positions2222', 'card', 'rainyDay']) assertPending(s.db, ownerItem(s.db, role), `${role} has no known holder`);
  }));

  test('conflicting sources ask: the names fact says spouse for a holder the owner answered as theirs', () => withHousehold((s) => {
    setNames(s.db, { me: 'Casey Sample', spouse: 'Avery Example' });
    C.answerItem(s.db, ownerItem(s.db, 'checking').id, 'owner', { now: LATER });
    A.autoResolve(s.db, { now: LATER });
    assertPending(s.db, ownerItem(s.db, 'brokerage1111'), 'the fact and the learned answer disagree');
    assertPending(s.db, ownerItem(s.db, 'positions1111'), 'nothing to follow');
  }));
});

describe('shared_mask', () => {
  test('positions account kinds follow the export kind of the same-mask brokerage accounts', () => withHousehold((s) => {
    for (const role of ['positions1111', 'positions2222']) {
      const item = kindItem(s.db, role);
      const info = assertAuto(s.db, item, { rule: 'shared_mask', answer: 'taxable' });
      assert.ok(textOf(info.evidence).includes(role.slice(-4)), `the evidence names the mask: ${textOf(info.evidence)}`);
      assert.equal(accountOf(s.db, item.subject).kind, 'taxable');
    }
    assertAuto(s.db, kindItem(s.db, 'card'), { rule: 'account_name', answer: 'card' });
    assertPending(s.db, kindItem(s.db, 'rainyDay'), 'no same-mask sibling');
  }));

  test('a SimpleFIN account never supports nor receives a shared-mask answer', () => withStore(async (s) => {
    const SF = await src('src/ingest/simplefin.mjs');
    // A positions account (no institution) ending in 4821, the mask of the fake bridge's checking.
    await P.ingestFiles(s.db, [positionsFile('positions-4821.csv', [{ symbol: 'FUNDA', quantity: '1', price: '10.00', value: '10.00', account: 'Z00004821', accountName: 'Synthetic brokerage' }])], s.opts(await offEngine()));
    const o = { config: s.config, household: s.household, now: NOW, clock: NOW.slice(0, 10), fetch: SF.createFakeSimplefin({ today: () => NOW.slice(0, 10) }) };
    await SF.connectSimplefin(s.db, SF.fakeToken(), o);
    await SF.syncSimplefin(s.db, o);
    A.autoResolve(s.db, { now: NOW });
    const bridge = one(s.db, "SELECT * FROM accounts WHERE identity LIKE 'simplefin:%' AND mask = '4821'");
    assert.ok(bridge, 'precondition: the bridge checking has its own account with mask 4821');
    assert.ok(bridge.kind, 'precondition: its kind came from the bridge');
    const positions = accountId(s.db, '4821', '');
    assertAuto(s.db, itemFor(s.db, 'account_kind', positions), { rule: 'account_name', answer: 'taxable' });

    C.answerItem(s.db, itemFor(s.db, 'account_owner', positions).id, 'owner', { now: LATER });
    A.autoResolve(s.db, { now: LATER });
    assertPending(s.db, itemFor(s.db, 'account_owner', bridge.id), 'a SimpleFIN account never receives shared_mask');
  }));

  test('an answered account_match "different" between two accounts blocks it', () => withHousehold((s) => {
    // The sync asks account_match about a bridge account and a file account; here the two file
    // accounts sharing mask 1111 are named directly in the question's context, the shape the sync
    // writes ({sfKey, candidateId, ownId}), so the rule sees an owner's "different" between them.
    const match = C.ask(s.db, {
      kind: 'account_match', subject: 'sf:synthetic-key', question: 'Is this the same account?', options: C.ACCOUNT_MATCH_OPTIONS,
      context: { sfKey: 'synthetic-key', candidateId: H.brokerage1111(s.db), ownId: H.positions1111(s.db) }, now: NOW,
    });
    assert.equal(match.queued, true);
    C.answerItem(s.db, match.id, 'different', { now: NOW });
    C.answerItem(s.db, ownerItem(s.db, 'brokerage1111').id, 'owner', { now: LATER });
    C.answerItem(s.db, ownerItem(s.db, 'brokerage2222').id, 'spouse', { now: LATER });
    A.autoResolve(s.db, { now: LATER });
    assertAuto(s.db, ownerItem(s.db, 'positions2222'), { rule: 'shared_mask', answer: 'spouse' });
    assertPending(s.db, ownerItem(s.db, 'positions1111'), 'the owner said these are different accounts');
  }));

  test('differing known holders block it', () => withStore(async (s) => {
    const header = 'Date,Original Date,Account Type,Account Name,Account Number,Institution Name,Name,Custom Name,Amount,Description,Category,Note,Ignored From,Tax Deductible,Transaction Tags,Account Holder';
    const row = (account, number, inst, holder, description) => ['2032-03-02', '', 'Checking', account, number, inst, '', '', '10.00', description, 'Other', '', '', '', '', holder].join(',');
    const file = textFile('holders.csv', [header,
      row('Shared savings', '0007788', 'Example Bank', 'Avery Example', 'Alpha'),
      row('Savings mirror', '0017788', '', 'Blair Example', 'Bravo'),
      row('Spending', '0006699', 'Example Bank', 'Avery Example', 'Charlie'),
      row('Spending mirror', '0016699', '', '', 'Delta'),
    ].join('\n') + '\n', 'text/csv');
    await P.ingestFiles(s.db, [file], s.opts(await offEngine()));
    const owner = (mask, inst) => itemFor(s.db, 'account_owner', accountId(s.db, mask, inst));
    C.answerItem(s.db, owner('6699', 'Example Bank').id, 'owner', { now: LATER });
    A.autoResolve(s.db, { now: LATER });
    assertAuto(s.db, owner('7788', 'Example Bank'), { rule: 'holder_match', answer: 'owner' });
    assertAuto(s.db, owner('6699', ''), { rule: 'shared_mask', answer: 'owner' });
    assertPending(s.db, owner('7788', ''), 'its holder differs from the same-mask account it would follow');
  }));
});

// Review finding: when holder matching is ambiguous (a multi-holder name, or holder sources that
// disagree), shared_mask must not answer the owner question instead. Holder ambiguity vetoes
// every owner auto answer; an account with no holder at all still follows its same-mask siblings.
describe('holder ambiguity vetoes owner auto answers', () => {
  const HELD_HEADER = 'Date,Original Date,Account Type,Account Name,Account Number,Institution Name,Name,Custom Name,Amount,Description,Category,Note,Ignored From,Tax Deductible,Transaction Tags,Account Holder';
  const heldExport = (name, holder) => textFile(name, [HELD_HEADER,
    ['2032-03-06', '', 'Investment', 'Shared brokerage', '0004321', 'Example Brokerage', '', '', '15.00', 'Synthetic fee', 'Other', '', '', '', '', holder].join(','),
  ].join('\n') + '\n', 'text/csv');
  const plainExport = (name) => aggregatorFile(name, [
    { date: '2032-03-06', amount: '15.00', type: 'Investment', account: 'Shared brokerage', number: '0004321', inst: 'Example Brokerage', description: 'Synthetic fee' },
  ]);

  // A positions account ending in 4321 (no institution, no holder) imported first; its owner
  // question answered "owner" through the answer path.
  async function answeredPositions(s) {
    await P.ingestFiles(s.db, [positionsFile('positions-4321.csv', [
      { symbol: 'FUNDA', quantity: '1', price: '10.00', value: '10.00', account: 'Z00004321', accountName: 'Synthetic brokerage' },
    ])], s.opts(await offEngine()));
    const item = itemFor(s.db, 'account_owner', accountId(s.db, '4321', ''));
    C.answerItem(s.db, item.id, 'owner', { now: LATER });
    A.autoResolve(s.db, { now: LATER });
    assert.equal(C.getItem(s.db, item.id).answer, 'owner', 'precondition: the positions owner is answered');
    return item;
  }

  test('a multi-holder export account never follows its answered same-mask sibling', () => withStore(async (s) => {
    await answeredPositions(s);
    await P.ingestFiles(s.db, [heldExport('shared-4321.csv', 'Casey Sample & Drew Sample')], s.opts(await offEngine()));
    const exported = accountId(s.db, '4321', 'Example Brokerage');
    assert.equal(one(s.db, 'SELECT holder FROM account_holders WHERE account_id = ?', exported)?.holder, 'Casey Sample & Drew Sample', 'precondition: the holder is stored');
    const out = A.autoResolve(s.db, { now: LATER });
    const item = itemFor(s.db, 'account_owner', exported);
    assert.ok(!out.answered.includes(item.id));
    assertPending(s.db, item, 'a multi-holder name is ambiguous, so shared_mask may not answer it');
    assert.equal(accountOf(s.db, exported).owner, null);
  }));

  test('conflicting holder sources (names fact versus a learned answer) veto a same-mask answer', () => withHousehold((s) => {
    // The fact names the brokerage holder "Avery Example" as the spouse; the owner answered the
    // checking (same holder) as theirs; the same-mask positions 1111 is answered "owner".
    setNames(s.db, { me: 'Casey Sample', spouse: 'Avery Example' });
    C.answerItem(s.db, ownerItem(s.db, 'checking').id, 'owner', { now: LATER });
    C.answerItem(s.db, ownerItem(s.db, 'positions1111').id, 'owner', { now: LATER });
    const brokerage = ownerItem(s.db, 'brokerage1111');
    assert.equal(brokerage.status, 'pending', 'precondition: the brokerage owner is still asked');
    const out = A.autoResolve(s.db, { now: LATER });
    assert.ok(!out.answered.includes(brokerage.id));
    assertPending(s.db, brokerage, 'the holder sources disagree, so shared_mask may not answer it');
    assert.equal(accountOf(s.db, brokerage.subject).owner, null);
  }));

  test('liveness: an export account with no holder still follows its answered same-mask sibling', () => withStore(async (s) => {
    const positions = await answeredPositions(s);
    await P.ingestFiles(s.db, [plainExport('plain-4321.csv')], s.opts(await offEngine()));
    const exported = accountId(s.db, '4321', 'Example Brokerage');
    assert.equal(one(s.db, 'SELECT holder FROM account_holders WHERE account_id = ?', exported) ?? null, null, 'precondition: no holder');
    A.autoResolve(s.db, { now: LATER });
    const info = assertAuto(s.db, itemFor(s.db, 'account_owner', exported), { rule: 'shared_mask', answer: 'owner' });
    assert.ok(info.evidence.basis.includes(positions.id), 'the answer rests on the positions answer');
  }));
});

describe('undo', () => {
  test('reopening an auto answer restores the row, declines it, and autoResolve never answers it again', () => withHousehold((s) => {
    const item = kindItem(s.db, 'positions2222');
    assertAuto(s.db, item, { rule: 'shared_mask', answer: 'taxable' });
    assert.equal(C.finalReason(s.db, C.getItem(s.db, item.id)), null);
    const out = C.reopenItem(s.db, item.id, { now: LATER });
    assert.equal(out.item.status, 'pending');
    assert.equal(accountOf(s.db, item.subject).kind, null, 'the kind the auto answer set is gone');
    assert.equal(C.autoInfo(s.db, item.id), null, 'the auto record is reverted with the answer');
    assert.equal(declined(s.db, item.id), 1, 'the item is declined');
    const again = A.autoResolve(s.db, { now: LATER });
    assert.ok(!again.answered.includes(item.id));
    assertPending(s.db, item, 'a declined item is never auto answered again');
  }));

  test('an owner answer the owner reopened is never re-answered, even when another account with the same holder supports it', () => withHousehold((s) => {
    const checking = ownerItem(s.db, 'checking');
    C.answerItem(s.db, checking.id, 'owner', { now: LATER });
    A.autoResolve(s.db, { now: LATER });
    assertAuto(s.db, ownerItem(s.db, 'brokerage1111'), { rule: 'holder_match', answer: 'owner' });
    C.answerItem(s.db, ownerItem(s.db, 'rainyDay').id, 'joint', { now: LATER });

    C.reopenItem(s.db, checking.id, { now: LATER });
    assertPending(s.db, checking, 'the reopened owner answer is pending');
    A.autoResolve(s.db, { now: LATER });
    assertPending(s.db, checking, 'Fathom never re-answers an item the owner reopened');
    assert.equal(declined(s.db, checking.id), 1, 'the reopened item is declined');
  }));

  test('reopening the basis answer reverts every answer that rests on it', () => withHousehold((s) => {
    const checking = ownerItem(s.db, 'checking');
    C.answerItem(s.db, checking.id, 'owner', { now: LATER });
    A.autoResolve(s.db, { now: LATER });
    const brokerage = ownerItem(s.db, 'brokerage1111');
    const positions = ownerItem(s.db, 'positions1111');
    assert.equal(status(s.db, brokerage.id), 'answered');
    assert.equal(status(s.db, positions.id), 'answered');

    C.reopenItem(s.db, checking.id, { now: LATER });
    for (const item of [checking, brokerage, positions]) {
      assertPending(s.db, item, `${item.question} is pending again`);
      assert.equal(accountOf(s.db, item.subject).owner, null);
    }
    A.autoResolve(s.db, { now: LATER });
    for (const item of [brokerage, positions]) assertPending(s.db, item, 'nothing supports it any more');
  }));

  // Chain A (checking, the owner's answer) -> B (brokerage 1111, holder_match) -> C (positions 1111,
  // shared_mask). No import path re-applies an account_owner answer to an existing account
  // (upsertAccounts asks only for new accounts), so C is made final the way markUsed does it: by
  // setting confirm_undo.used_at.
  async function chain(s) {
    const a = ownerItem(s.db, 'checking');
    C.answerItem(s.db, a.id, 'owner', { now: LATER });
    A.autoResolve(s.db, { now: LATER });
    const b = ownerItem(s.db, 'brokerage1111');
    const c = ownerItem(s.db, 'positions1111');
    assert.ok(C.autoInfo(s.db, b.id).evidence.ancestors.includes(a.id));
    assert.ok(C.autoInfo(s.db, c.id).evidence.ancestors.includes(b.id));
    s.db.prepare('UPDATE confirm_undo SET used_at = ? WHERE item_id = ?').run(LATER, c.id);
    assert.equal(C.finalReason(s.db, C.getItem(s.db, c.id)), 'used_since', 'precondition: C is final');
    return { a, b, c };
  }

  test('chain with a final tail: revising A reverts B, C stays, and C never supports its own ancestors', () => withHousehold(async (s) => {
    const { a, b, c } = await chain(s);
    const out = C.reviseItem(s.db, a.id, 'spouse', { now: LATER });
    assert.equal(out.item.answer, 'spouse');
    assertPending(s.db, b, 'B rested on A and is reverted');
    assert.equal(accountOf(s.db, b.subject).owner, null);
    assert.equal(C.getItem(s.db, c.id).answer, 'owner', 'the final C stays answered');
    assert.equal(accountOf(s.db, c.subject).owner, 'You');

    // B now follows A's new answer (same holder). C (same mask, answered owner) rests on B and A, so
    // it never supports B; if it did, B would be owner or left asked.
    A.autoResolve(s.db, { now: LATER });
    assertAuto(s.db, b, { rule: 'holder_match', answer: 'spouse' });
  }));

  test('chain with a final tail: reopening A reverts B, and a later autoResolve never uses C to answer A or B', () => withHousehold(async (s) => {
    const { a, b, c } = await chain(s);
    C.reopenItem(s.db, a.id, { now: LATER });
    assertPending(s.db, b, 'B rested on A and is reverted');
    assert.equal(status(s.db, c.id), 'answered', 'the final C stays answered');
    A.autoResolve(s.db, { now: LATER });
    assertPending(s.db, a, 'C rests on A, so it never answers A');
    assertPending(s.db, b, 'C rests on B, so it never answers B');
  }));

  test('an auto owner answer stays undoable after a later import of another format updated the account source', () => withHousehold(async (s) => {
    const item = ownerItem(s.db, 'checking');
    assertAuto(s.db, item, { rule: 'holder_match', answer: 'owner' });
    const sourceBefore = accountOf(s.db, item.subject).source_id;
    await P.ingestFiles(s.db, [aggregatorFile('checking-later.csv', [
      { date: '2026-10-25', amount: '5.00', type: 'Checking', account: 'Everyday Checking', number: '9914455', inst: 'Chase', description: 'Library fee' },
    ])], s.opts(await offEngine()));
    const sourceAfter = accountOf(s.db, item.subject).source_id;
    assert.notEqual(sourceAfter, sourceBefore, 'precondition: the later import changed the account source');
    assert.equal(C.finalReason(s.db, C.getItem(s.db, item.id)), null, 'an auto owner answer is not final on imported_since');
    C.reopenItem(s.db, item.id, { now: LATER });
    const acct = accountOf(s.db, item.subject);
    assert.equal(acct.owner, null, 'the owner is reverted');
    assert.equal(acct.source_id, sourceAfter, 'the later source is kept');
  }, { names: NAMES }));

  test('an auto owner answer stays undoable after the kind answer on the same account', () => withHousehold((s) => {
    const owner = ownerItem(s.db, 'card');
    assertAuto(s.db, owner, { rule: 'holder_match', answer: 'spouse' });
    assertAuto(s.db, kindItem(s.db, 'card'), { rule: 'account_name', answer: 'card' });
    C.reopenItem(s.db, owner.id, { now: LATER });
    const acct = accountOf(s.db, owner.subject);
    assert.equal(acct.owner, null);
    assert.equal(acct.kind, 'card', 'the kind answer stands');
  }, { names: NAMES }));

  test('an auto owner answer refuses undo when the owner itself changed since', () => withHousehold((s) => {
    const owner = ownerItem(s.db, 'card');
    assertAuto(s.db, owner, { rule: 'holder_match', answer: 'spouse' });
    s.db.prepare("UPDATE accounts SET owner = 'Joint' WHERE id = ?").run(owner.subject);
    assert.throws(() => C.reopenItem(s.db, owner.id, { now: LATER }), (err) => {
      assert.ok(err instanceof C.ConfirmError);
      assert.equal(err.code, 'final');
      assert.equal(err.reason, 'changed_since');
      return true;
    });
    assert.equal(accountOf(s.db, owner.subject).owner, 'Joint');
    assert.equal(status(s.db, owner.id), 'answered');
  }, { names: NAMES }));
});

describe('ingestState', () => {
  test('pending items carry rank and group; decided lists auto answers newest first', () => withHousehold((s) => {
    // Import-time auto answers are stamped NOW; these two, LATER.
    C.answerItem(s.db, ownerItem(s.db, 'checking').id, 'owner', { now: LATER });
    A.autoResolve(s.db, { now: LATER });
    const state = FR.ingestState(s.db);

    const groups = { account_owner: 'account_owner', account_kind: 'account_kind', near_duplicate: null, category_mapping: null, transaction_category: null };
    assert.ok(state.items.length > 0);
    for (const i of state.items) {
      assert.equal(typeof i.rank, 'number', `${i.kind} has a rank`);
      assert.equal(i.group, groups[i.kind], `${i.kind} group`);
    }
    for (let n = 1; n < state.items.length; n++) assert.ok(state.items[n - 1].rank <= state.items[n].rank, 'items are sorted by rank');
    const rankOf = (kind) => state.items.find((i) => i.kind === kind).rank;
    assert.ok(rankOf('account_owner') < rankOf('near_duplicate') && rankOf('account_kind') < rankOf('near_duplicate'), 'account questions come before near duplicates');

    const auto = C.listItems(s.db, { status: 'answered' }).filter((i) => C.autoInfo(s.db, i.id));
    assert.equal(state.decided.length, auto.length);
    assert.deepEqual(new Set(state.decided.map((d) => d.id)), new Set(auto.map((i) => i.id)));
    assert.deepEqual(new Set(state.decided.slice(0, 2).map((d) => d.id)), new Set([ownerItem(s.db, 'brokerage1111').id, ownerItem(s.db, 'positions1111').id]),
      'the answers made later come first');
    const labels = { card: 'Credit card', owner: 'You', taxable: 'Taxable brokerage', same: 'Same transaction, keep one' };
    for (const d of state.decided) {
      const item = C.getItem(s.db, d.id);
      assert.equal(d.kind, item.kind);
      assert.equal(d.question, item.question);
      assert.equal(d.answer, item.answer);
      assert.equal(d.answerLabel, labels[d.answer]);
      assert.equal(d.rule, C.autoInfo(s.db, d.id).rule);
      assert.ok(typeof textOf(d.evidence) === 'string' && textOf(d.evidence).length > 0, 'decided carries the evidence');
      assert.equal(d.final, null);
    }
  }));
});
