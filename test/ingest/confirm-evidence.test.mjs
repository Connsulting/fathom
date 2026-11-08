import { seedHistoricalRows, historicalTaxRows } from '../helpers/historical-import.mjs';
// AC2 (plan feat-confirm-context, Interfaces): every best guess carries evidence that names a field
// or a document and quotes stored values. Rule guesses (account kind from the account name, same
// date and amount for a near duplicate, joint for a holder naming both household members) win over
// stored engine guesses; an engine guess's fixed reason sentence is rendered from the card's own
// detail, never shown as is. ingestState items carry the guess with its source, the detail, a rank
// and a group, ordered by rank. Every value here is synthetic.

import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { src, tempDb } from '../helpers/server.mjs';
import { fixture, realStore, offEngine, activityFile, one, NOW } from '../helpers/ingest.mjs';

let P;
let C;
let F;
let G;
let X;
let B;
before(async () => {
  P = await src('src/ingest/pipeline.mjs');
  C = await src('src/ingest/confirm.mjs');
  F = await src('src/store/facts.mjs');
  G = await src('src/ingest/guess.mjs');
  X = await src('src/ingest/context.mjs');
  B = await src('src/ingest/bestguess.mjs');
});

const AGG_FILE = 'aggregator-household.csv';
const household = () => [AGG_FILE, 'Chase4455_Activity_20261031.csv', 'positions-household.csv'].map((name) => fixture(`household/${name}`, 'text/csv'));
const NAMES = { me: 'Avery Example', spouse: 'Blair Example' };
const TAX_KINDS = ['tax_year', 'employer_relation', 'employer_recipient', 'document_recipient', 'withholding_conflict'];
const ACCOUNT_KINDS = ['account_owner', 'account_kind'];

async function withStore(fn) {
  const s = await realStore();
  try { return await fn(s); } finally { await s.close(); }
}
// The household files in one ingestFiles call, engine off; names: set household.names first.
const withHousehold = async (fn, { names = false, extra = [] } = {}) => withStore(async (s) => {
  if (names) F.upsertFact(s.db, { key: 'household.names', value: NAMES, src: 'you', asOf: NOW.slice(0, 10), confirmed: true, now: NOW });
  await P.ingestFiles(s.db, [...household(), ...extra], s.opts(await offEngine()));
  return await fn(s);
});

const acct = async (db, mask, inst) => (await one(db, "SELECT id FROM accounts WHERE mask = ? AND coalesce(inst, '') = ?", mask, inst)).id;
const pendingFor = (db, kind, subject) => {
  const item = C.pendingItems(db).find((i) => i.kind === kind && i.subject === subject);
  assert.ok(item, `a pending ${kind} for ${subject}`);
  return item;
};
const guessOf = (db, item) => B.bestGuess(db, item, X.cardDetail(db, item));
const labelOf = (options, id) => options.find((o) => o.id === id).label;
// A stored engine guess, as guessPending writes it (option NULL when the engine gave none).
const storeGuess = async (db, itemId, option, reason) => await db.prepare(`INSERT INTO confirm_guesses (item_id, option_id, reason, model, ts) VALUES (?, ?, ?, 'test-model', ?)
  ON CONFLICT(item_id) DO UPDATE SET option_id = excluded.option_id, reason = excluded.reason`).run(itemId, option, reason, NOW);
const notReasonText = (evidence) => {
  assert.equal(typeof evidence, 'string');
  assert.ok(evidence.trim().length > 0, 'evidence is not empty');
  assert.ok(!Object.values(G.REASON_TEXT).includes(evidence), `evidence is not a fixed reason sentence: ${evidence}`);
};

describe('rule guesses', () => {
  test('account_kind from the account name: Rewards Card is a card, and the evidence quotes the name', async () => await withHousehold(async (s) => {
    const subject = await acct(s.db, '3344', 'Example Card');
    C.reopenItem(s.db, C.listItems(s.db, { status: 'answered' }).find(i => i.kind === 'account_kind' && i.subject === subject).id, { now: NOW });
    const item = pendingFor(s.db, 'account_kind', subject);
    const g = guessOf(s.db, item);
    assert.equal(g.option, 'card');
    assert.equal(g.label, labelOf(item.options, 'card'));
    assert.equal(g.source, 'rule');
    notReasonText(g.evidence);
    assert.ok(g.evidence.includes('Rewards Card'), g.evidence);
  }));

  test('near_duplicate on the same date with the same amount guesses same, with evidence from the rows', async () => withStore(async (s) => {
    const off = await offEngine();
    const row = (description) => [{ date: '03/09/2032', amount: '-54.21', balance: '', description }];
    await P.ingestFile(s.db, activityFile('Chase4321_Activity_A.csv', row('SYNTH GROCERY NORTH')), s.opts(off));
    await P.ingestFile(s.db, activityFile('Chase4321_Activity_B.csv', row('SYNTH PHARMACY SOUTH')), s.opts(off));
    const item = C.pendingItems(s.db).find((i) => i.kind === 'near_duplicate');
    assert.ok(item, 'the same-day collision is asked about');
    const g = guessOf(s.db, item);
    assert.equal(g.option, 'same');
    assert.equal(g.label, labelOf(item.options, 'same'));
    assert.equal(g.source, 'rule');
    notReasonText(g.evidence);
    assert.ok(['SYNTH GROCERY NORTH', 'SYNTH PHARMACY SOUTH', '2032-03-09', '54.21'].some((v) => g.evidence.includes(v)), `quotes a stored value: ${g.evidence}`);
  }));

  test('a holder naming both household members guesses joint for Rainy Day', async () => await withHousehold(async (s) => {
    const item = pendingFor(s.db, 'account_owner', await acct(s.db, '5566', 'Example Credit Union'));
    const g = guessOf(s.db, item);
    assert.equal(g.option, 'joint');
    assert.equal(g.label, labelOf(item.options, 'joint'));
    assert.equal(g.source, 'rule');
    notReasonText(g.evidence);
    assert.ok(g.evidence.includes('Avery Example') && g.evidence.includes('Blair Example'), g.evidence);
  }, { names: true }));
});

describe('engine guesses', () => {
  let parserLabel;
  before(async () => { parserLabel = (await src('src/ingest/parsers/aggregator.mjs')).label; });

  // Each basis code's fixed sentence, stored on the Rewards Card owner question (no rule applies to
  // it) or on the Corner Cafe near duplicate (dates differ, so no rule applies), rendered from detail.
  const CASES = [
    { basis: 'account_name', on: 'owner', option: 'spouse', quotes: () => ['Rewards Card'] },
    { basis: 'institution', on: 'owner', option: 'spouse', quotes: () => ['Example Card', '3344'] },
    { basis: 'source_file', on: 'owner', option: 'spouse', quotes: () => [AGG_FILE] },
    { basis: 'document_type', on: 'owner', option: 'spouse', quotes: () => [parserLabel] },
    { basis: 'question', on: 'owner', option: 'spouse', quotes: () => ['Rewards Card'] },
    { basis: 'imported_values', on: 'near', option: 'different', anyOf: ['Corner Cafe', 'SQ *CORNER CF', '8.75'] },
  ];
  const target = async (db, on) => (on === 'owner'
    ? pendingFor(db, 'account_owner', await acct(db, '3344', 'Example Card'))
    : C.pendingItems(db).find((i) => i.kind === 'near_duplicate'));

  test('every basis code is covered', () => {
    assert.deepEqual(CASES.map((c) => c.basis).sort(), [...G.REASON_CODES].sort());
  });

  for (const c of CASES) {
    test(`${c.basis}: the stored reason renders as concrete evidence from the card`, async () => await withHousehold(async (s) => {
      const item = await target(s.db, c.on);
      assert.ok(item, `a pending ${c.on} item`);
      await storeGuess(s.db, item.id, c.option, G.REASON_TEXT[c.basis]);
      const g = guessOf(s.db, item);
      assert.equal(g.option, c.option);
      assert.equal(g.label, labelOf(item.options, c.option));
      assert.equal(g.source, 'engine');
      notReasonText(g.evidence);
      if (c.quotes) for (const v of c.quotes()) assert.ok(g.evidence.includes(v), `evidence quotes ${v}: ${g.evidence}`);
      if (c.anyOf) assert.ok(c.anyOf.some((v) => g.evidence.includes(v)), `evidence quotes an imported value: ${g.evidence}`);
    }));
  }

  test('a rule guess wins over an engine guess on the same item', async () => await withHousehold(async (s) => {
    const subject = await acct(s.db, '3344', 'Example Card');
    C.reopenItem(s.db, C.listItems(s.db, { status: 'answered' }).find(i => i.kind === 'account_kind' && i.subject === subject).id, { now: NOW });
    const item = pendingFor(s.db, 'account_kind', subject);
    await storeGuess(s.db, item.id, 'checking', G.REASON_TEXT.account_name);
    const g = guessOf(s.db, item);
    assert.equal(g.option, 'card');
    assert.equal(g.source, 'rule');
  }));

  test('a stored guess row with no option gives no guess', async () => await withHousehold(async (s) => {
    const item = pendingFor(s.db, 'account_owner', await acct(s.db, '3344', 'Example Card'));
    await storeGuess(s.db, item.id, null, null);
    assert.equal(guessOf(s.db, item), null);
  }));
});

describe('ingestState', () => {
  let FR;
  before(async () => { FR = await src('src/ingest/freshness.mjs'); });

  test('items carry detail, guess with source and evidence, rank and group, ordered by rank', async () => await withHousehold(async (s) => {
    await seedHistoricalRows(s,fixture('tax-payments.xlsx'),historicalTaxRows(),{parser:'tax-payments',sourceKind:'tax_payments',period:{from:'2031-12-31',to:'2032-03-31'}});
    const owner = pendingFor(s.db, 'account_owner', await acct(s.db, '3344', 'Example Card'));
    const subject = await acct(s.db, '3344', 'Example Card');
    C.reopenItem(s.db, C.listItems(s.db, { status: 'answered' }).find(i => i.kind === 'account_kind' && i.subject === subject).id, { now: NOW });
    const kind = pendingFor(s.db, 'account_kind', subject);
    await storeGuess(s.db, owner.id, 'spouse', G.REASON_TEXT.institution);
    const state = FR.ingestState(s.db);
    assert.equal(state.pending, state.items.length);
    assert.ok(state.items.some((i) => i.kind === 'tax_year'), 'the tax workbook adds tax_year items');

    for (const item of state.items) {
      assert.equal(typeof item.rank, 'number', `rank on ${item.kind}`);
      assert.equal(item.group, ACCOUNT_KINDS.includes(item.kind) ? item.kind : null, `group on ${item.kind}`);
      assert.ok(item.detail && typeof item.detail.type === 'string', `detail on ${item.kind}`);
      if (ACCOUNT_KINDS.includes(item.kind)) assert.equal(item.detail.type, 'account');
      if (item.kind === 'near_duplicate') assert.equal(item.detail.type, 'compare');
      if (item.kind === 'tax_year') assert.equal(item.detail.type, 'values');
      if (item.guess) {
        assert.ok(['rule', 'engine'].includes(item.guess.source));
        assert.equal(item.guess.reason, item.guess.evidence, 'reason is the evidence text');
        notReasonText(item.guess.evidence);
      }
    }

    const kindGuess = state.items.find((i) => i.id === kind.id).guess;
    assert.deepEqual([kindGuess.option, kindGuess.source], ['card', 'rule']);
    assert.ok(kindGuess.evidence.includes('Rewards Card'));
    const ownerGuess = state.items.find((i) => i.id === owner.id).guess;
    assert.deepEqual([ownerGuess.option, ownerGuess.label, ownerGuess.source], ['spouse', labelOf(owner.options, 'spouse'), 'engine']);
    assert.ok(ownerGuess.evidence.includes('Example Card') && ownerGuess.evidence.includes('3344'), ownerGuess.evidence);

    // Ordered by rank: tax kinds, then account kinds, then near_duplicate. Ties go by id, except
    // that account items may order by latest balance within their rank (plan, Ingest state 2).
    const at = (pred) => state.items.flatMap((i, n) => (pred(i) ? [n] : []));
    const tax = at((i) => TAX_KINDS.includes(i.kind));
    const accounts = at((i) => ACCOUNT_KINDS.includes(i.kind));
    const near = at((i) => i.kind === 'near_duplicate');
    assert.ok(tax.length && accounts.length && near.length);
    assert.ok(Math.max(...tax) < Math.min(...accounts), 'tax kinds before account kinds');
    assert.ok(Math.max(...accounts) < Math.min(...near), 'account kinds before near_duplicate');
    for (let n = 1; n < state.items.length; n++) {
      const [a, b] = [state.items[n - 1], state.items[n]];
      assert.ok(a.rank <= b.rank, `rank order at ${n}`);
      if (a.rank === b.rank && !ACCOUNT_KINDS.includes(a.kind) && !ACCOUNT_KINDS.includes(b.kind)) assert.ok(a.id < b.id, `id order within rank at ${n}`);
    }
  }));

  test('the demo seed guess renders concrete evidence from the seeded account', async () => {
    const { seedDemo } = await src('demo/seed.mjs');
    const t = await tempDb();
    try {
      await seedDemo(t.db);
      // The seeded institution is a scenario name placeholder the web resolves, so the check is on
      // the stored mask, which the institution basis renders as "account ending <mask>".
      const account = await one(t.db, "SELECT mask FROM accounts WHERE id = 'a_tod'");
      assert.match(account.mask ?? '', /^\d{4}$/, 'the seeded account has a mask');
      const item = FR.ingestState(t.db).items.find((i) => i.kind === 'account_owner' && i.subject === 'a_tod');
      assert.ok(item?.guess, 'the seeded owner question carries a guess');
      assert.equal(item.guess.option, 'owner');
      assert.equal(item.guess.source, 'engine');
      notReasonText(item.guess.evidence);
      assert.ok(item.guess.evidence.includes(account.mask), item.guess.evidence);
    } finally {
      try { await t.db.close(); } catch { /* closed */ }
      rmSync(t.dataDir, { recursive: true, force: true });
    }
  });
});
