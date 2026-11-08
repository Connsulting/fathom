// AC5: revise and reopen a confirm answer through the per-answer change log (plan D1 to D5). For
// every confirm kind, answering A and then revising to B leaves the store equal to answering B
// directly (no row lost or duplicated), and reopening restores the store as it was before the
// answer. Unsafe reverts are refused as final with a reason, and every refusal changes nothing.

import { seedHistoricalRows, seedHistoricalDocument, historicalNorthwindRows, historicalTaxRows } from '../helpers/historical-import.mjs';
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { src, spawnServer, request, postJson, SERVER_TIMEOUT } from '../helpers/server.mjs';
import {
  fixture, fixturePath, textFile, aggregatorFile, aggregatorCsv, northwindFile, paystubText, realStore, fakeEngine, offEngine, one, count, NOW,
} from '../helpers/ingest.mjs';

let P;
let C;
let DB;
before(async () => {
  P = await src('src/ingest/pipeline.mjs');
  C = await src('src/ingest/confirm.mjs');
  DB = await src('src/store/db.mjs');
});

// The answer under test is stamped ANSWER_AT; the revise, and the direct answer it is compared to,
// are stamped NOW. Answers that only build the fixture are stamped SETUP_AT.
const SETUP_AT = '2032-03-08T09:00:00.000Z';
const ANSWER_AT = '2032-03-09T09:00:00.000Z';

// Tables left out of the equivalence dump: bookkeeping that legitimately differs between a revised
// store and a directly answered one. confirm_auto_declined is the marker a reopen leaves so the item
// is always asked again and never auto-answered; it is bookkeeping by design, not a row the answer
// touched, so a reopen is expected to add it.
// store_identity names each store's own platform household, so two separately built stores differ there.
const BOOKKEEPING = ['schema_migrations', 'store_identity', 'confirm_undo', 'confirm_guesses', 'ingest_epoch', 'spend_ledger', 'settings', 'confirm_auto_declined'];
const canon = (v) => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' && !ArrayBuffer.isView(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);

// Every table's rows as canonical JSON strings, sorted. superseded_rows is compared without its id,
// simplefin_connection without its ciphertext.
async function dataDump(db, skip = BOOKKEEPING) {
  const out = {};
  for (const t of DB.listTables(db)) {
    if (skip.includes(t)) continue;
    out[t] = (await db.prepare(`SELECT * FROM "${t}"`).all()).map((r) => {
      const row = { ...r };
      if (t === 'superseded_rows') delete row.id;
      // Ciphertext under each store's own key and a random IV: never equal across stores.
      if (t === 'simplefin_connection') delete row.access_blob;
      return JSON.stringify(canon(row));
    }).sort();
  }
  return out;
}
// Everything but the migration record, for "a refusal changes nothing".
const fullDump = async (db) => await dataDump(db, ['schema_migrations']);
const withoutQuestions = async (db) => await dataDump(db, [...BOOKKEEPING, 'confirm_items']);

async function withStore(fn) {
  const s = await realStore();
  try { return await fn(s); } finally { await s.close(); }
}
// Building a store's household context refreshes its pack state stamped with the wall clock (as a
// server start does); two stores built moments apart are normalized to one setup time before the
// test acts, so the comparisons see only what the test's answers wrote.
async function pairedStore() {
  const s = await realStore();
  await s.db.prepare('UPDATE packs_state SET updated_at = ?').run(SETUP_AT);
  return s;
}
async function withTwoStores(fn) {
  const x = await pairedStore();
  const y = await pairedStore();
  try { return await fn(x, y); } finally { x.close(); y.close(); }
}

const STATUS = { final: 409, not_answered: 409, stale: 409, bad_option: 400, not_found: 404 };
// fn must throw ConfirmError(code) with err.reason (when given) and leave every table unchanged.
async function refused(db, fn, code, reason) {
  const before = await fullDump(db);
  assert.throws(fn, (err) => {
    assert.ok(err instanceof C.ConfirmError, `ConfirmError, got ${err && err.name}: ${err && err.message}`);
    assert.equal(err.code, code);
    assert.equal(err.status, STATUS[code]);
    if (reason !== undefined) assert.equal(err.reason, reason);
    return true;
  });
  assert.deepEqual(await fullDump(db), before, `a ${code} refusal changes nothing`);
}

// Synthetic extraction fixtures (the extract.test.mjs shapes).
const CLASSIFY_PAYSTUB = [{ docType: 'paystub', taxYear: 2032, confidence: 0.95 }];
const PAYSTUB = {
  payDate: '2032-03-15', periodStart: '2032-03-01', periodEnd: '2032-03-15', employerName: 'Example Employer LLC',
  gross: 5000, net: 3600, federalWithholding: 700, stateWithholding: 250, state: 'CO', socialSecurity: 310,
  medicare: 72.5, retirementDeferral: 0, hsaDeferral: 0, ytdGross: 30000, confidence: 0.95,
};
const W2_2032 = {
  taxYear: 2032, employerName: 'Example Employer LLC', wages: 90000, federalWithheld: 12000, socialSecurityWages: 90000,
  medicareWages: 90000, state: 'CO', stateWages: 90000, stateWithheld: 3500, retirementPlan: true, box12: [{ code: 'D', amount: 6000 }], confidence: 0.92,
};
const STUB_B = { ...PAYSTUB, gross: 2500, net: 1900, federalWithholding: 300, stateWithholding: 100, ytdGross: 15000 };
const W2_FIRST = { ...W2_2032, stateWithheld: 0, federalWithheld: 12000 };
const W2_SECOND = { ...W2_FIRST, federalWithheld: 13000 };
const NOTES = { facts: [{ key: 'household.dependents', value: '2', confidence: 0.5 }, { key: 'household.state', value: 'CO', confidence: 0.6 }], goals: [] };
const NOTES_LATER = { facts: [{ key: 'household.dependents', value: '2', confidence: 0.5 }, { key: 'household.state', value: 'NM', confidence: 0.6 }], goals: [] };
const paystubResponses = (extracted) => [CLASSIFY_PAYSTUB, [extracted]];
const paystubFile = (opts = {}, name) => textFile(name || `paystub-${opts.payDate || '2032-03-15'}.txt`, paystubText(opts), 'text/plain');
const w2Responses = (extracted) => [[{ docType: 'w2', taxYear: 2032, confidence: 0.9 }], [extracted]];
const int1099Responses = () => [[{ docType: '1099-int', taxYear: 2032, confidence: 0.9 }],
  [{ taxYear: 2032, payerKind: 'bank', payerName: 'Example Savings Bank', interest: 1200, earlyWithdrawalPenalty: 0, federalWithheld: 240, confidence: 0.9 }]];
const near = { date: '2032-03-10', amount: '54.21', description: 'SYNTH GROCERY' };
const nearLater = { date: '2032-03-12', amount: '54.21', description: 'SYNTH GROCERY STORE 0042' };
// A file for an account no fixture above touches, so importing it re-applies no remembered answer.
const otherAccountFile = (name = 'other-account.csv') => aggregatorFile(name, [
  { date: '2032-03-02', amount: '12.50', type: 'Checking', account: 'Other synthetic checking', number: '5550004444', inst: 'Example Credit Union', description: 'Synthetic later row' },
]);

async function imported(s, file, responses) {
  const r = responses ? await seedHistoricalDocument(s,file,responses)
    : file.name.startsWith('northwind-pnl') ? await seedHistoricalRows(s,file,historicalNorthwindRows(), { parser: 'pnl-workbook', sourceKind: 'pnl_workbook', period: { from: '2032-04-01', to: '2032-04-30' } })
    : file.name === 'tax-payments.xlsx' ? await seedHistoricalRows(s,file,historicalTaxRows(), { parser: 'tax-payments', sourceKind: 'tax_payments', period: { from: '2031-12-31', to: '2032-03-31' } })
    : await P.ingestFile(s.db, file, s.opts(await offEngine()));
  assert.equal(r.status, 'imported', `${file.name} imports`);
  return r.fileId;
}
function firstPending(db, kind, pred = () => true) {
  const item = C.pendingItems(db).find((i) => i.kind === kind && pred(i));
  assert.ok(item, `a pending ${kind} item`);
  return item.id;
}
const answerFixture = (db, id, option) => C.answerItem(db, id, option, { now: SETUP_AT });

// Each kind: setup(s) builds the store through real imports and returns the item id under test.
// pairs are [A, B] revisions; reopen lists the answers reopened. Every pair has a real effect in at
// least one direction (asserted below).
const categoryHistory = () => aggregatorFile('category-history.csv',Array.from({length:8},(_,i)=>['Groceries','Income'].map(category=>({date:`2032-${String(i+1).padStart(2,'0')}-15`,amount:category==='Income' ? -3000 : 100,description:'Covered '+category,category}))).flat());
const CASES = {
  transaction_payment: {
    setup: async s => {
      const SF = await src('src/ingest/simplefin.mjs');
      const file = textFile('connected-payment.json', JSON.stringify({ accounts: [{
        account: { inst: 'Example Bank', name: 'Synthetic checking' }, accountId: 'synthetic-checking', identity: 'simplefin:synthetic',
        transactions: [{ date: '2032-03-02', amount: -125, description: 'IRS PAYMENT 2032', externalId: 'synthetic-tax-payment' }],
      }] }), 'application/json');
      const result = await P.ingestFile(s.db, file, s.opts(await offEngine(), { parser: SF.parser, now: SETUP_AT }));
      assert.equal(result.status, 'imported');
      return firstPending(s.db, 'transaction_payment');
    },
    pairs: [['estimate', 'not_estimate'], ['not_estimate', 'estimate']],
    reopen: ['estimate', 'not_estimate'],
  },
  resolver_fact: {
    setup: async s => C.ask(s.db, { kind: 'resolver_fact', subject: 'benefits.hsaEligible',
      question: 'Is the synthetic health plan HSA eligible?',
      options: [{ id: 'true', label: 'Yes' }, { id: 'false', label: 'No' }],
      context: { key: 'benefits.hsaEligible', values: { true: true, false: false } }, now: SETUP_AT }).id,
    pairs: [['true', 'false'], ['false', 'true']],
    reopen: ['true', 'false'],
  },
  stated_value: {
    setup: async s => C.ask(s.db, { kind: 'stated_value', subject: 'business.salaryRange|{"max":120000,"min":90000}',
      question: 'Your note says "My salary range from the advisor is 90k to 120k." Use it?',
      options: [{ id: 'use', label: 'Use it' }, { id: 'not_this', label: 'Not this' }],
      context: { key: 'business.salaryRange', value: { min: 90000, max: 120000 }, quote: 'My salary range from the advisor is 90k to 120k.',
        ref: 'notes:synthetic:0', description: 'Save a household detail you told Fathom.' }, now: SETUP_AT }).id,
    pairs: [['use', 'not_this'], ['not_this', 'use']],
    reopen: ['use', 'not_this'],
  },
  transaction_category: {
    setup: async s => {
      await imported(s,categoryHistory());
      await imported(s,aggregatorFile('uncategorized.csv',[{date:'2032-03-01',amount:250,category:'Uncategorized',description:'Example Service'}]));
      const {queueCategoryChecks}=await src('src/categories/store.mjs');
      await queueCategoryChecks(s.db,{clock:'2032-11-05',now:SETUP_AT});
      return firstPending(s.db,'transaction_category');
    },
    pairs: [['always:Business','Shopping'],['Shopping','always:Business']],
    reopen: ['always:Business','Shopping'],
  },
  category_mapping: {
    setup: async s => {
      await imported(s,aggregatorFile('unknown-category.csv',[{date:'2032-03-01',amount:250,category:'A new category'}]));
      const {queueCategoryChecks}=await src('src/categories/store.mjs');
      await queueCategoryChecks(s.db,{clock:'2032-11-05',now:SETUP_AT});
      return firstPending(s.db,'category_mapping');
    },
    pairs: [['household','business'],['business','tax']],
    reopen: ['household','business'],
  },
  account_owner: {
    setup: async (s) => { await imported(s, fixture('aggregator.csv', 'text/csv')); return firstPending(s.db, 'account_owner'); },
    pairs: [['owner', 'spouse'], ['spouse', 'business']],
    reopen: ['owner'],
  },
  account_kind: {
    setup: async (s) => { await imported(s, fixture('Chase7766_Activity_20320305.csv', 'text/csv')); return firstPending(s.db, 'account_kind'); },
    pairs: [['checking', 'card'], ['card', '529']],
    reopen: ['checking'],
  },
  entity_alias: {
    setup: async (s) => { await imported(s, northwindFile()); return firstPending(s.db, 'entity_alias'); },
    pairs: [['entity:Northwind Design', 'separate'], ['separate', 'entity:Northwind Design']],
    reopen: ['entity:Northwind Design', 'separate'],
  },
  tax_year: {
    setup: async (s) => { await imported(s, fixture('tax-payments.xlsx')); return firstPending(s.db, 'tax_year', (i) => /2032/.test(i.subject)); },
    pairs: [['tax_year', 'payment_year'], ['payment_year', 'tax_year']],
    reopen: ['tax_year', 'payment_year'],
  },
  fact_check: {
    setup: async (s) => {
      await imported(s, fixture('notes.md'), [[NOTES]]);
      return firstPending(s.db, 'fact_check', (i) => i.subject.endsWith('|household.state|"CO"'));
    },
    pairs: [['yes', 'no'], ['no', 'yes']],
    reopen: ['yes', 'no'],
  },
  near_duplicate: {
    setup: async (s) => {
      await imported(s, aggregatorFile('near-a.csv', [near]));
      await imported(s, aggregatorFile('near-b.csv', [nearLater]));
      return firstPending(s.db, 'near_duplicate');
    },
    pairs: [['same', 'different'], ['different', 'same']],
    reopen: ['same'],
  },
  account_match: {
    // A SimpleFIN account (synthetic fake bridge) at the same bank as an imported account with no
    // mask: the sync asks instead of guessing.
    setup: async (s) => {
      const SF = await src('src/ingest/simplefin.mjs');
      await imported(s, aggregatorFile('other.csv', [{ date: '2032-01-05', amount: '5.00', inst: 'Other bank', account: 'Joint checking', number: '', description: 'Old' }]));
      const o = { config: s.config, household: s.household, now: SETUP_AT, clock: SETUP_AT.slice(0, 10), fetch: SF.createFakeSimplefin({ today: () => SETUP_AT.slice(0, 10) }) };
      await SF.connectSimplefin(s.db, SF.fakeToken(), o);
      await SF.syncSimplefin(s.db, o);
      return firstPending(s.db, 'account_match');
    },
    pairs: [['same', 'different'], ['different', 'same']],
    reopen: ['same'],
  },
  employer_relation: {
    setup: async (s) => {
      await imported(s, paystubFile(), paystubResponses({ ...PAYSTUB, retirementDeferral: 400, hsaDeferral: 100 }));
      return firstPending(s.db, 'employer_relation');
    },
    pairs: [['outside', 'household'], ['household', 'outside']],
    reopen: ['outside', 'household'],
  },
  // A W-2 and two paystubs of one employer, recipient unknown. owner or spouse rekeys every row and
  // lets the W-2 summarize the paystubs; both asks one document_recipient question per document.
  employer_recipient: {
    setup: async (s) => {
      await imported(s, textFile('w2-member-a-2032.txt', 'Synthetic wage and tax statement for 2032, member A', 'text/plain'), w2Responses(W2_2032));
      await imported(s, paystubFile({}, 'paystub-member-a.txt'), paystubResponses(PAYSTUB));
      await imported(s, paystubFile({ gross: '2500.00' }, 'paystub-member-b.txt'), paystubResponses(STUB_B));
      return firstPending(s.db, 'employer_recipient');
    },
    pairs: [['owner', 'spouse'], ['both', 'owner'], ['owner', 'both']],
    reopen: ['owner', 'both'],
  },
  // Two members' identical 1099-INTs from one payer. The first is answered owner during setup; the
  // second answered owner collapses into it (archived as duplicate), spouse keeps both.
  document_recipient: {
    setup: async (s) => {
      const a = await imported(s, textFile('1099-int-member-a-2032.txt', 'Synthetic 1099-int for tax year 2032, member a', 'text/plain'), int1099Responses());
      const b = await imported(s, textFile('1099-int-member-b-2032.txt', 'Synthetic 1099-int for tax year 2032, member b', 'text/plain'), int1099Responses());
      answerFixture(s.db, firstPending(s.db, 'document_recipient', (i) => i.subject.endsWith(`:doc:${a}`)), 'owner');
      return firstPending(s.db, 'document_recipient', (i) => i.subject.endsWith(`:doc:${b}`));
    },
    pairs: [['owner', 'spouse'], ['spouse', 'owner']],
    reopen: ['owner', 'spouse'],
  },
  // Two W-2s of one employer with differing federal withholding, resolved to the owner in setup.
  withholding_conflict: {
    setup: async (s) => {
      await imported(s, textFile('w2-first-2032.txt', 'Synthetic wage and tax statement for 2032, copy first', 'text/plain'), w2Responses(W2_FIRST));
      await imported(s, textFile('w2-second-2032.txt', 'Synthetic wage and tax statement for 2032, copy second', 'text/plain'), w2Responses(W2_SECOND));
      answerFixture(s.db, firstPending(s.db, 'employer_recipient'), 'owner');
      return firstPending(s.db, 'withholding_conflict');
    },
    pairs: [['first', 'second'], ['second', 'both'], ['both', 'first']],
    reopen: ['first', 'second'],
  },
};

test('the revise cases cover every confirm kind', () => {
  assert.deepEqual(Object.keys(CASES).sort(), [...C.KINDS].sort());
  for (const [kind, c] of Object.entries(CASES)) {
    const options = new Set([...c.pairs.flat(), ...c.reopen]);
    assert.ok(options.size >= 2, `${kind} exercises at least two options`);
  }
});

describe('revise equals answering the new option directly', () => {
  for (const [kind, c] of Object.entries(CASES)) {
    for (const [a, b] of c.pairs) {
      test(`${kind}: answering ${a} then revising to ${b} leaves the store equal to answering ${b}`, async () => withTwoStores(async (x, y) => {
        const id = await c.setup(x);
        assert.equal(await c.setup(y), id, 'both stores give the item the same id');
        assert.deepEqual(await dataDump(x.db), await dataDump(y.db), 'precondition: both stores are built identically');
        const options = C.getItem(x.db, id).options.map((o) => o.id);
        assert.ok(options.includes(a) && options.includes(b), `${a} and ${b} are offered`);

        C.answerItem(x.db, id, a, { now: ANSWER_AT });
        const afterA = await withoutQuestions(x.db);
        const out = C.reviseItem(x.db, id, b, { now: NOW });
        assert.equal(out.item.id, id);
        assert.equal(out.item.status, 'answered');
        assert.equal(out.item.answer, b);
        assert.equal(typeof out.factsChanged, 'boolean');

        C.answerItem(y.db, id, b, { now: NOW });
        assert.deepEqual(await dataDump(x.db), await dataDump(y.db), 'no row lost, duplicated or left on the old answer');
        assert.notDeepEqual(afterA, await withoutQuestions(y.db), `${a} and ${b} have different effects, so the revise did real work`);
      }));
    }
  }
});

describe('reopen restores the store as it was before the answer', () => {
  for (const [kind, c] of Object.entries(CASES)) {
    for (const a of c.reopen) {
      test(`${kind}: answering ${a} then reopening restores every row and leaves the item pending`, async () => withStore(async (s) => {
        const id = await c.setup(s);
        const before = await dataDump(s.db);
        C.answerItem(s.db, id, a, { now: ANSWER_AT });
        assert.notDeepEqual(await dataDump(s.db), before, 'the answer changed the store');

        const out = C.reopenItem(s.db, id, { now: NOW });
        assert.equal(out.item.id, id);
        assert.equal(out.item.status, 'pending');
        assert.equal(out.item.answer, null);
        assert.equal(typeof out.factsChanged, 'boolean');
        assert.deepEqual(await dataDump(s.db), before, 'every row the answer touched is restored');
        assert.deepEqual(await one(s.db, 'SELECT status, answer, answered_at FROM confirm_items WHERE id = ?', id), { status: 'pending', answer: null, answered_at: null });
        assert.equal((await one(s.db, 'SELECT count(*) AS n FROM confirm_auto_declined WHERE item_id = ?', id)).n, 1, 'the reopen records exactly one auto-decline marker');
        assert.ok(C.pendingItems(s.db).some((i) => i.id === id), 'the item is back in the pending queue');
        assert.equal(C.finalReason(s.db, C.getItem(s.db, id)), null, 'a pending item is not final');

        const again = C.answerItem(s.db, id, a, { now: NOW });
        assert.equal(again.item.answer, a, 'a reopened item can be answered again');
      }));
    }
  }
});

describe('revise liveness and results', () => {
  test('an ordinary revise right after an answer succeeds, and the item can be revised again', async () => withStore(async (s) => {
    const id = await CASES.account_owner.setup(s);
    const subject = C.getItem(s.db, id).subject;
    C.answerItem(s.db, id, 'owner', { now: ANSWER_AT });
    assert.equal(C.finalReason(s.db, C.getItem(s.db, id)), null, 'not final right after the answer');
    const first = C.reviseItem(s.db, id, 'spouse', { now: NOW });
    assert.equal(first.item.answer, 'spouse');
    assert.equal(first.factsChanged, false, 'an owner answer touches no facts');
    assert.equal((await one(s.db, 'SELECT owner FROM accounts WHERE id = ?', subject)).owner, 'Your spouse');
    assert.equal(C.finalReason(s.db, C.getItem(s.db, id)), null, 'not final right after a revise');
    const second = C.reviseItem(s.db, id, 'joint', { now: NOW });
    assert.equal(second.item.answer, 'joint');
    assert.equal((await one(s.db, 'SELECT owner FROM accounts WHERE id = ?', subject)).owner, 'Joint');
    assert.equal((await one(s.db, 'SELECT answered_at FROM confirm_items WHERE id = ?', id)).answered_at, NOW);
  }));

  test('a fact_check revise and reopen report factsChanged', async () => withStore(async (s) => {
    const id = await CASES.fact_check.setup(s);
    C.answerItem(s.db, id, 'yes', { now: ANSWER_AT });
    assert.equal((await one(s.db, "SELECT confirmed FROM facts WHERE key = 'household.state'")).confirmed, 1);
    const revised = C.reviseItem(s.db, id, 'no', { now: NOW });
    assert.equal(revised.factsChanged, true);
    assert.equal(await one(s.db, "SELECT * FROM facts WHERE key = 'household.state'"), undefined, 'no removes the unconfirmed fact');
    const reopened = C.reopenItem(s.db, id, { now: NOW });
    assert.equal(reopened.factsChanged, true);
    const restored = await one(s.db, "SELECT value, confirmed FROM facts WHERE key = 'household.state'");
    assert.ok(restored, 'the imported fact is back');
    assert.equal(JSON.parse(restored.value), 'CO');
    assert.equal(restored.confirmed, 0, 'and unconfirmed again');
  }));

  test('revising to the stored answer changes nothing', async () => withStore(async (s) => {
    const id = await CASES.account_owner.setup(s);
    C.answerItem(s.db, id, 'owner', { now: ANSWER_AT });
    const before = await fullDump(s.db);
    const out = C.reviseItem(s.db, id, 'owner', { now: NOW });
    assert.equal(out.item.answer, 'owner');
    assert.equal(out.item.status, 'answered');
    assert.deepEqual(await fullDump(s.db), before);
    assert.equal((await one(s.db, 'SELECT answered_at FROM confirm_items WHERE id = ?', id)).answered_at, ANSWER_AT);
  }));
});

describe('refusals', () => {
  test('a pending item refuses revise and reopen with not_answered', async () => withStore(async (s) => {
    const id = await CASES.account_owner.setup(s);
    await refused(s.db, () => C.reviseItem(s.db, id, 'owner', { now: NOW }), 'not_answered');
    await refused(s.db, () => C.reopenItem(s.db, id, { now: NOW }), 'not_answered');
    assert.equal(C.finalReason(s.db, C.getItem(s.db, id)), null);
  }));

  test('an unknown item refuses with not_found', async () => withStore(async (s) => {
    await CASES.account_owner.setup(s);
    await refused(s.db, () => C.reviseItem(s.db, 999999, 'owner', { now: NOW }), 'not_found');
    await refused(s.db, () => C.reopenItem(s.db, 999999, { now: NOW }), 'not_found');
  }));

  test('a bad option refuses with bad_option and changes nothing', async () => withStore(async (s) => {
    const id = await CASES.account_owner.setup(s);
    C.answerItem(s.db, id, 'owner', { now: ANSWER_AT });
    await refused(s.db, () => C.reviseItem(s.db, id, 'nobody', { now: NOW }), 'bad_option');
    assert.equal((await one(s.db, 'SELECT owner FROM accounts WHERE id = ?', C.getItem(s.db, id).subject)).owner, 'You');
  }));

  test('an import after the answer makes it final (imported_since); finalReason reports it', async () => withStore(async (s) => {
    const id = await CASES.account_owner.setup(s);
    const subject = C.getItem(s.db, id).subject;
    C.answerItem(s.db, id, 'owner', { now: ANSWER_AT });
    assert.equal(C.finalReason(s.db, C.getItem(s.db, id)), null, 'not final right after the answer');
    await imported(s, otherAccountFile());
    assert.equal(C.finalReason(s.db, C.getItem(s.db, id)), 'imported_since');
    await refused(s.db, () => C.reviseItem(s.db, id, 'spouse', { now: NOW }), 'final', 'imported_since');
    await refused(s.db, () => C.reopenItem(s.db, id, { now: NOW }), 'final', 'imported_since');
    assert.equal((await one(s.db, 'SELECT owner FROM accounts WHERE id = ?', subject)).owner, 'You');
  }));

  test('an import that re-applies the remembered answer makes it final', async () => withStore(async (s) => {
    const id = await CASES.account_owner.setup(s);
    C.answerItem(s.db, id, 'owner', { now: ANSWER_AT });
    // The same account in another export: ask() re-applies the remembered owner answer.
    await imported(s, fixture('Chase7766_Activity_20320305.csv', 'text/csv'));
    const reason = C.finalReason(s.db, C.getItem(s.db, id));
    assert.ok(['used_since', 'imported_since'].includes(reason), `final, got ${reason}`);
    await refused(s.db, () => C.reviseItem(s.db, id, 'spouse', { now: NOW }), 'final', reason);
  }));

  test('a later change to a row the answer touched makes it final (changed_since)', async () => withStore(async (s) => {
    const id = await CASES.account_owner.setup(s);
    const subject = C.getItem(s.db, id).subject;
    C.answerItem(s.db, id, 'owner', { now: ANSWER_AT });
    await s.db.prepare("UPDATE accounts SET owner = 'Joint' WHERE id = ?").run(subject);
    await refused(s.db, () => C.reviseItem(s.db, id, 'spouse', { now: NOW }), 'final', 'changed_since');
    await refused(s.db, () => C.reopenItem(s.db, id, { now: NOW }), 'final', 'changed_since');
    assert.equal((await one(s.db, 'SELECT owner FROM accounts WHERE id = ?', subject)).owner, 'Joint');
  }));

  test('answering a document_recipient question that both asked makes the employer answer final (changed_since)', async () => withStore(async (s) => {
    const id = await CASES.employer_recipient.setup(s);
    C.answerItem(s.db, id, 'both', { now: ANSWER_AT });
    const docs = C.pendingItems(s.db).filter((i) => i.kind === 'document_recipient');
    assert.ok(docs.length >= 1, 'both asked per document');
    C.answerItem(s.db, docs[0].id, 'owner', { now: NOW });
    await refused(s.db, () => C.reviseItem(s.db, id, 'owner', { now: NOW }), 'final', 'changed_since');
    await refused(s.db, () => C.reopenItem(s.db, id, { now: NOW }), 'final', 'changed_since');
    assert.equal(C.getItem(s.db, docs[0].id).answer, 'owner', 'the later answer stands');
  }));

  test('a refusal after a many-row answer rolls back every partial restore', async () => withStore(async (s) => {
    const id = await CASES.employer_recipient.setup(s);
    C.answerItem(s.db, id, 'owner', { now: ANSWER_AT });
    assert.ok(await count(s.db, 'superseded_rows', "reason = 'summarized'") > 0, 'the answer archived and removed rows');
    // The earliest-touched row (the W-2's, lowest id) is checked last when walking the log backwards.
    await s.db.prepare('UPDATE tax_payments SET amount = amount + 1 WHERE id = (SELECT min(id) FROM tax_payments)').run();
    await refused(s.db, () => C.reviseItem(s.db, id, 'spouse', { now: NOW }), 'final', 'changed_since');
    await refused(s.db, () => C.reopenItem(s.db, id, { now: NOW }), 'final', 'changed_since');
  }));

  test('an answer with no undo row is final (no_undo)', async () => withStore(async (s) => {
    const id = await CASES.account_owner.setup(s);
    C.answerItem(s.db, id, 'owner', { now: ANSWER_AT });
    assert.equal(await count(s.db, 'confirm_undo', 'item_id = ?', id), 1, 'the answer stored an undo row');
    await s.db.prepare('DELETE FROM confirm_undo WHERE item_id = ?').run(id);
    assert.equal(C.finalReason(s.db, C.getItem(s.db, id)), 'no_undo');
    await refused(s.db, () => C.reviseItem(s.db, id, 'spouse', { now: NOW }), 'final', 'no_undo');
    await refused(s.db, () => C.reopenItem(s.db, id, { now: NOW }), 'final', 'no_undo');
  }));

  test('a superseded item refuses revise and reopen with stale', async () => withStore(async (s) => {
    const id = await CASES.fact_check.setup(s);
    await imported(s, textFile('notes-later.md', '# Household goals\n\nSynthetic follow-up note with the same content.\n', 'text/markdown'), [[NOTES_LATER]]);
    const item = C.getItem(s.db, id);
    assert.equal(item.answer, 'superseded', 'precondition: the newer value superseded the question');
    assert.equal(C.finalReason(s.db, item), 'stale');
    await refused(s.db, () => C.reviseItem(s.db, id, 'no', { now: NOW }), 'stale');
    await refused(s.db, () => C.reopenItem(s.db, id, { now: NOW }), 'stale');
  }));
});

describe('revise and reopen over HTTP', () => {
  const T = { timeout: SERVER_TIMEOUT };
  const FINAL_IMPORTED = 'A file was imported after this answer, so it is final.';
  const NOT_ANSWERED = 'that question is not answered yet';
  let s;
  let fileId;
  let owner;
  let kind;

  const upload = (name, bytes) => {
    const boundary = 'fathom-revise-test-boundary';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: text/csv\r\n\r\n`),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return request(s.baseUrl, { method: 'POST', path: '/api/files', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body });
  };

  before(async () => {
    s = await spawnServer({ env: { FATHOM_DEMO: '1', FATHOM_ENGINE: 'fake' } });
    const up = await upload('Chase7766_Activity_20320305.csv', readFileSync(fixturePath('Chase7766_Activity_20320305.csv')));
    assert.equal(up.status, 200, up.text.slice(0, 300));
    fileId = up.json.files[0].fileId;
    const list = (await request(s.baseUrl, { path: '/api/confirm' })).json.items.filter((i) => i.fileId === fileId);
    owner = list.find((i) => i.kind === 'account_owner');
    kind = list.find((i) => i.kind === 'account_kind');
    assert.ok(owner && kind, 'the upload asks the owner and kind questions');
  }, T);
  after(async () => {
    if (!s) return;
    await s.stop();
    rmSync(s.dataDir, { recursive: true, force: true });
  });

  test('POST answer with revise: true revises an answered item', async () => {
    const path = `/api/confirm/${owner.id}/answer`;
    const first = await postJson(s.baseUrl, path, { answer: 'owner' });
    assert.equal(first.status, 200, first.text.slice(0, 300));
    const r = await postJson(s.baseUrl, path, { answer: 'spouse', revise: true });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(r.json.scenario && typeof r.json.scenario === 'object', 'the body carries the scenario');
    assert.equal(r.json.item.id, owner.id);
    assert.equal(r.json.item.status, 'answered');
    assert.equal(r.json.item.answer, 'spouse');
    assert.equal(r.json.item.final, null);
    assert.equal(r.json.scenario.accounts.find((a) => a.id === owner.subject).owner, 'Your spouse');
  });

  test('POST reopen puts the item back to pending', async () => {
    const r = await postJson(s.baseUrl, `/api/confirm/${owner.id}/reopen`, {});
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(r.json.item.status, 'pending');
    assert.equal(r.json.item.answer, null);
    assert.ok(r.json.scenario.live.ingest.items.some((i) => i.id === owner.id), 'pending again in the scenario');
  });

  test('revise and reopen on a pending item are 409 not answered', async () => {
    const reopen = await postJson(s.baseUrl, `/api/confirm/${owner.id}/reopen`, {});
    assert.equal(reopen.status, 409);
    assert.deepEqual(reopen.json, { error: NOT_ANSWERED, code: 'not_answered' });
    const revise = await postJson(s.baseUrl, `/api/confirm/${owner.id}/answer`, { answer: 'joint', revise: true });
    assert.equal(revise.status, 409);
    assert.deepEqual(revise.json, { error: NOT_ANSWERED, code: 'not_answered' });
  });

  test('an import after the answer makes revise and reopen 409 final with the fixed message', async () => {
    const ok = await postJson(s.baseUrl, `/api/confirm/${kind.id}/answer`, { answer: 'checking' });
    assert.equal(ok.status, 200, ok.text.slice(0, 300));
    const later = await upload('other-account.csv', aggregatorCsv([
      { date: '2032-03-02', amount: '12.50', type: 'Checking', account: 'Other synthetic checking', number: '5550004444', inst: 'Example Credit Union', description: 'Synthetic later row' },
    ]));
    assert.equal(later.status, 200, later.text.slice(0, 300));
    const revise = await postJson(s.baseUrl, `/api/confirm/${kind.id}/answer`, { answer: 'card', revise: true });
    assert.equal(revise.status, 409);
    assert.deepEqual(revise.json, { error: FINAL_IMPORTED });
    const reopen = await postJson(s.baseUrl, `/api/confirm/${kind.id}/reopen`, {});
    assert.equal(reopen.status, 409);
    assert.deepEqual(reopen.json, { error: FINAL_IMPORTED });
    const all = await postJson(s.baseUrl, '/api/confirm/list', { status: 'answered' });
    assert.equal(all.json.items.find((i) => i.id === kind.id).answer, 'checking', 'the answer stands');
  });
});
