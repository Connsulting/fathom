// The planner on ingest's contract (plan Revision 6: MGI1, MGI2, MGI5; driver decisions D9 to D12).
// Every store is built by test/helpers/real-store.mjs, so every W-2, paystub, K-1 and form1040 goes
// through ingest's own extraction, pipeline and confirm code (a scripted engine plays the model and
// returns ingest's extraction shape), and every owner answer goes through confirm.mjs answer().
// No document, tax payment or answer row is written by hand. Each test carries its hand
// calculation and the rule it rests on. Every employer, person and amount is synthetic.
//
// Sources cited below:
//   IRS, General Instructions for Forms W-2 and W-3 (2026), box 1 and box 12 codes: D (401(k)
//     elective deferrals), E (403(b)), F (408(k)(6) SARSEP), G (457(b)), S (408(p) SIMPLE) are
//     excluded from box 1; AA (designated Roth 401(k)), BB (designated Roth 403(b)), EE (designated
//     Roth 457(b)) are included in box 1; W is employer and cafeteria-plan HSA contributions.
//   IRC 402(g)(1) and (3): the elective deferral limit covers 401(k), SARSEP, 403(b) and SIMPLE
//     deferrals (24,500 for 2026, Notice 2025-67); IRC 402A(c)(2) counts designated Roth
//     contributions as elective deferrals. IRC 457(c): 457(b) deferrals have their own limit.
//   IRC 414(v)(2)(B) and Reg. 1.414(v)-1(b)(1): catch-ups are deferrals above the 402(g) limit;
//     8,000 for ages 50 to 59 in 2026 (Notice 2025-67).
//   IRC 6654(d)(1)(B) and (C): the prior-year safe harbor is 100 percent of last year's tax, 110
//     percent when last year's AGI exceeded 150,000.
//   Form 8959 Part V, lines 19 to 22: Additional Medicare Tax withholding is box 6 Medicare tax
//     withheld less 1.45 percent of box 5 Medicare wages.
//   IRC 1402(a) and 199A(c)(4)(B): a partner's self-employment earnings and qualified business
//     income exclude guaranteed payments from QBI.
//   IRC 223(b)(2), (b)(3): HSA family limit 8,750 and the 1,000 catch-up at 55 (Rev. Proc. 2025-19).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { runPlanning } from '../../src/jobs/planner.mjs';
import { computeFigures } from '../../src/jobs/planner/figures.mjs';
import { loadPlanningData, resolveEntities } from '../../src/jobs/planner/data.mjs';
import { deriveFacts, mergeFacts, ownerFactsOf } from '../../src/jobs/planner/facts.mjs';
import { notesFor } from '../../src/jobs/planner/assumptions.mjs';
import { reasonText } from '../../src/jobs/triggers/missing-data.mjs';
import { confirmTask } from '../../src/jobs/triggers/common.mjs';
import { nameKey } from '../../src/ingest/extract.mjs';
import {
  scratch, addFact, addFile, addNotes, addPayroll, factRow, answerPending, figureRow, plannerFigures, recRow, activeRecIds, parseJson, pnlWorkbook,
  PACKS_DIR, SCORP, SOLE_PROP, INST, MASKS,
} from '../helpers/real-store.mjs';

const NOW = '2026-11-05';
const S = scratch('fathom-ingest-contract-');
after(() => S.cleanup());

const plan = db => runPlanning(db, null, { now: NOW, packDirs: [PACKS_DIR] });
const near = (actual, expected, what) =>
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= 0.011, `${what}: expected ${expected}, got ${actual}`);
const fig = (db, key) => {
  const row = figureRow(db, key);
  assert.ok(row, `figure ${key} exists`);
  return row;
};

// The planner's own path to computeFigures, for reading `info` (blocked and withheld codes).
function computeFor(db, clock = NOW) {
  const data = loadPlanningData(db, clock);
  const stored = {};
  for (const r of db.prepare('SELECT key, value, src, confirmed FROM facts').all()) {
    stored[r.key] = { value: parseJson(r.value, null), src: r.src, confirmed: !!r.confirmed };
  }
  const owner = ownerFactsOf(stored);
  const values = Object.fromEntries(Object.entries(stored).map(([k, r]) => [k, r.value]));
  const entities = resolveEntities(data, values);
  const merged = mergeFacts(stored, deriveFacts(data, { entities }));
  return { data, entities, ...computeFigures(data, merged.values, { clock, entities, owner }) };
}

async function planned(variant = {}) {
  const db = await S.store({ variant });
  const result = await plan(db);
  return { db, result, info: computeFor(db).info };
}
async function replan(db) {
  const result = await plan(db);
  return { db, result, info: computeFor(db).info };
}

// A code matches itself or a code carrying a subject after a colon (as entity_unclassified does).
const hasCode = (list, code) => (list || []).some(c => typeof c === 'string' && (c === code || c.startsWith(`${code}:`)));
const codesOf = info => [...(info.blocked || []), ...Object.values(info.withheld || {})];
const GENERIC = reasonText({ info: {}, entities: [] }, 'not_a_reason_code');

// Blocked with a visible reason: the code is reported, it has its own reason text (not the generic
// fallback), and the missing-data rec is active.
function assertBlocked(db, info, code, keys = []) {
  assert.ok(hasCode(codesOf(info), code), `${code} reported; got blocked ${JSON.stringify(info.blocked)}, withheld ${JSON.stringify(info.withheld)}`);
  assert.notEqual(reasonText({ info, entities: [] }, code), GENERIC, `${code} has its own reason text`);
  assert.ok(activeRecIds(db).includes('missing-data'), 'missing-data lists the reason');
  for (const k of keys) assert.equal(figureRow(db, k), null, `${k} is not published while ${code} holds`);
}
function assertNotBlocked(info, code) {
  assert.ok(!hasCode(codesOf(info), code), `${code} lifted; got blocked ${JSON.stringify(info.blocked)}, withheld ${JSON.stringify(info.withheld)}`);
}

// R6-2's pure payments module. Loaded through an assertion, so a missing module or export fails the
// test as missing behavior rather than crashing it.
async function paymentsExport(name) {
  const mod = await import('../../src/jobs/planner/payments.mjs').catch(() => null);
  assert.ok(mod, 'src/jobs/planner/payments.mjs exists (plan R6-2 item 1)');
  assert.equal(typeof mod[name], 'function', `payments.mjs exports ${name}`);
  return mod[name];
}

const wageParts = db => fig(db, 'agi.est').locator.parts.wages;
const outsideParts = (db, person) => wageParts(db).filter(w => w.source === 'outside employer' && (!person || w.person === person));
const sumOf = (list, k) => Math.round(list.reduce((a, b) => a + b[k], 0) * 100) / 100;
const businesses = db => fig(db, 'agi.est').locator.parts.businesses;
const assumptionsOf = row => (row && row.locator && row.locator.assumptions) || [];

const W2 = (employerName, fields, answers = {}) => ({ docType: 'w2', fields: { taxYear: 2026, employerName, ...fields }, ...answers });
const STUB = (employerName, fields, answers = {}) => ({ docType: 'paystub', fields: { employerName, ...fields }, ...answers });
const OUTSIDE_OWNER = Object.freeze({ recipient: 'owner', relation: 'outside' });
const OUT_A = 'Example Employer Inc';
const OUT_B = 'Example Logistics Co';

// ================================================================ MGI1: readers on ingest's document shape

// Owner, both employers answered owner and outside. Employer B first: box 1 40,000, box 12 D 3,000
// and AA 2,000; employer A second: box 1 60,000, box 12 D 5,000.
//   inc.ytd.w2 = 60,000 + 40,000 = 100,000 (the bug keeps the last W-2 only: 60,000).
//   gross per employer = box 1 + excluded codes (D): A 60,000 + 5,000 = 65,000; B 40,000 + 3,000 =
//   43,000 (AA is designated Roth, already inside box 1). AGI wages = 100,000.
//   Owner 402(g) total = D 5,000 + D 3,000 + AA 2,000 = 10,000 (402A(c)(2)); Roth 2,000.
const TWO_W2 = Object.freeze([
  W2(OUT_B, { wages: 40000, federalWithheld: 4800, state: 'VA', stateWithheld: 1800, box12: [{ code: 'D', amount: 3000 }, { code: 'AA', amount: 2000 }] }, OUTSIDE_OWNER),
  W2(OUT_A, { wages: 60000, federalWithheld: 7200, state: 'VA', stateWithheld: 2700, box12: [{ code: 'D', amount: 5000 }] }, OUTSIDE_OWNER),
]);

test('MGI1: two ingested W-2s sum per recipient and employer', async () => {
  const { db } = await planned({ payroll: TWO_W2 });
  const inc = fig(db, 'inc.ytd.w2');
  near(inc.v, 100000, 'outside wages received (the bug reports 60,000)');
  assert.equal(inc.label, 'Outside employer wages received this year');
  const parts = outsideParts(db, 'owner');
  assert.deepEqual(parts.map(p => p.gross).sort((a, b) => a - b), [43000, 65000], 'gross per employer: box 1 plus box 12 D');
  near(sumOf(parts, 'agi'), 100000, 'AGI wages are box 1');
});

// Test 1's W-2s plus the base S corp (owner, age 45, officer salary 5,000 a month), no
// retirement.contributions fact. Employee room = 24,500 - 10,000 = 14,500 (IRC 402(g)(1); Roth
// counts, 402A(c)(2)).
test('MGI1: box 12 deferrals reduce solo 401(k) employee room', async () => {
  const { db } = await planned({ payroll: TWO_W2, facts: { 'retirement.contributions': undefined } });
  near(fig(db, 'room.solo401k.employee').v, 14500, 'employee room after 10,000 of outside deferrals');
});

// Box 1 50,000; D 4,000; G 6,000. pretax = D + G = 10,000, gross 60,000, AGI wages 50,000.
// 402(g) total = D only = 4,000 (G is a 457(b) deferral under 457(c)), so employee room = 24,500 -
// 4,000 = 20,500.
test('MGI1: code G lowers box 1 but not the 402(g) total', async () => {
  const { db } = await planned({ payroll: [W2(OUT_A, { wages: 50000, federalWithheld: 6000, box12: [{ code: 'D', amount: 4000 }, { code: 'G', amount: 6000 }] }, OUTSIDE_OWNER)] });
  const [part] = outsideParts(db, 'owner');
  assert.ok(part, 'one outside wage part');
  near(part.gross, 60000, 'gross = box 1 + D + G');
  near(part.agi, 50000, 'AGI wages = box 1');
  near(fig(db, 'room.solo401k.employee').v, 20500, 'employee room: G does not count toward 402(g)');
});

// Owner age 52 (catch-up limit 8,000), prior-year Social Security wages from the S corp 60,000 (not
// over 150,000, so the catch-up may be pre-tax, IRC 414(v)(7)). One outside W-2 with D 30,000:
// regular = min(30,000, 24,500) = 24,500; catch-up = 5,500; catch-up room = 8,000 - 5,500 = 2,500;
// employee room = 24,500 - 24,500 = 0.
const AGE52 = Object.freeze({ 'household.ownerAge': 52, 'retirement.priorYearFicaWages': { owner: 60000 } });

test('MGI1: catch-up is the excess over 402(g) at one plan', async () => {
  const { db } = await planned({ facts: AGE52, payroll: [W2(OUT_A, { wages: 100000, federalWithheld: 15000, box12: [{ code: 'D', amount: 30000 }] }, OUTSIDE_OWNER)] });
  near(fig(db, 'room.solo401k.catchUp').v, 2500, 'catch-up room');
  near(fig(db, 'room.solo401k.employee').v, 0, 'employee room');
});

// Same owner, outside D 20,000 plus a household S corp W-2 (the owner's own Northwind Advisory) with
// D 10,000: 30,000 > 24,500 across a household plan and another plan, so which plan holds the 5,500
// catch-up is unknown: solo room and tax keys are withheld (deferral_split_unknown). The owner's
// retirement.otherPlanDeferrals {deferral 20,000, catchUp 0} settles the split.
test('MGI1: an unsplittable catch-up blocks', async () => {
  const payroll = [
    W2(OUT_A, { wages: 80000, federalWithheld: 12000, box12: [{ code: 'D', amount: 20000 }] }, OUTSIDE_OWNER),
    W2(SCORP.name, { wages: 50000, federalWithheld: 6000, box12: [{ code: 'D', amount: 10000 }] }, { recipient: 'owner' }),
  ];
  const blocked = await planned({ facts: AGE52, payroll });
  assertBlocked(blocked.db, blocked.info, 'deferral_split_unknown', ['agi.est', 'tax.fed.proj', 'room.solo401k.employee', 'room.solo401k.catchUp']);

  const split = await planned({ facts: { ...AGE52, 'retirement.otherPlanDeferrals': { owner: { deferral: 20000, catchUp: 0 } } }, payroll });
  assertNotBlocked(split.info, 'deferral_split_unknown');
  fig(split.db, 'agi.est');
});

// Paystub only, paid 2026-06-30, year-to-date gross 30,000, no deferrals this period.
//   inc.ytd.w2 = 30,000, labeled gross pay (ytdGross is not box 1).
//   projected gross = 30,000 * 12 / 6 = 60,000; AGI wages = 60,000 with section125_unknown.
const JUNE_STUB = Object.freeze({ payDate: '2026-06-30', periodStart: '2026-06-16', periodEnd: '2026-06-30', gross: 2500, net: 1900, federalWithholding: 300, ytdGross: 30000, retirementDeferral: 0, hsaDeferral: 0 });

test('MGI1: paystub-only wages project ytdGross', async () => {
  const { db } = await planned({ payroll: [STUB(OUT_A, JUNE_STUB, OUTSIDE_OWNER)] });
  const inc = fig(db, 'inc.ytd.w2');
  near(inc.v, 30000, 'year-to-date gross pay');
  assert.equal(inc.label, 'Outside employer gross pay received this year');
  const [part] = outsideParts(db, 'owner');
  assert.ok(part, 'one outside wage part');
  near(part.gross, 60000, 'projected gross = ytdGross * 12 / 6');
  near(part.agi, 60000, 'AGI wages = projected gross');
  const codes = [...assumptionsOf(fig(db, 'agi.est')), ...assumptionsOf(inc)];
  assert.ok(codes.includes('section125_unknown'), `section125_unknown noted: ${codes}`);
  assert.equal(notesFor(['section125_unknown']).length, 1, 'section125_unknown has a readable note');
});

// Same stub with retirementDeferral 500 this period: the year-to-date deferral is unknown, so wages
// block (paystub_deferrals_unknown). An outside-401k deferral fact of 6,000 gives AGI wages =
// 60,000 - 6,000 = 54,000.
test('MGI1: paystub deferrals without a year-to-date total block', async () => {
  const stub = STUB(OUT_A, { ...JUNE_STUB, retirementDeferral: 500 }, OUTSIDE_OWNER);
  const blocked = await planned({ payroll: [stub] });
  assertBlocked(blocked.db, blocked.info, 'paystub_deferrals_unknown', ['agi.est']);

  const known = await planned({ payroll: [stub], facts: { 'retirement.contributions': [{ person: 'owner', plan: 'outside-401k', type: 'deferral', amount: 6000 }] } });
  assertNotBlocked(known.info, 'paystub_deferrals_unknown');
  const [part] = outsideParts(known.db, 'owner');
  near(part.gross, 60000, 'projected gross');
  near(part.agi, 54000, 'AGI wages = projected gross - stated deferral');
});

// Employer answered 'both'. W-2 1 (box 1 30,000) is answered 'spouse' per document; W-2 2 (box 1
// 45,000) is unanswered: wages block with the employer named. Answering W-2 2 'owner' gives the
// spouse 30,000 and the owner 45,000 of outside wages (75,000 together).
test('MGI1: recipients come from the answers', async () => {
  const { db, info } = await planned({
    payroll: [
      W2(OUT_B, { wages: 30000, federalWithheld: 3000 }, { recipient: 'both', relation: 'outside', document: 'spouse' }),
      W2(OUT_B, { wages: 45000, federalWithheld: 5000 }),
    ],
  });
  assertBlocked(db, info, 'w2_recipient_unknown', ['agi.est', 'inc.ytd.w2']);
  assert.ok(JSON.stringify(recRow(db, 'missing-data').def).includes(OUT_B), 'the reason names the employer');

  assert.equal(answerPending(db, 'document_recipient', 'owner').length, 1, 'W-2 2 is asked about by document');
  const after2 = await replan(db);
  assertNotBlocked(after2.info, 'w2_recipient_unknown');
  near(sumOf(outsideParts(db, 'spouse'), 'agi'), 30000, 'the spouse W-2');
  near(sumOf(outsideParts(db, 'owner'), 'agi'), 45000, 'the owner W-2');
  near(fig(db, 'inc.ytd.w2').v, 75000, 'both outside W-2s');
});

// A W-2 with no withholding read gives ingest no tax_payments row, so ingest never asks whose it
// is. The planner raises ingest's own employer_recipient question (D9) and blocks; the answer
// lifts it.
test('MGI1: a W-2 with no withholding rows asks its recipient through ingest', async () => {
  const employer = 'Example Robotics Inc';
  const { db, info } = await planned({ payroll: [W2(employer, { wages: 20000 }, { relation: 'outside' })] });
  assertBlocked(db, info, 'w2_recipient_unknown', ['agi.est']);
  const asked = db.prepare("SELECT * FROM confirm_items WHERE kind = 'employer_recipient' AND subject = ?").get(nameKey(employer));
  assert.ok(asked, 'an employer_recipient question is queued for the employer key');
  assert.equal(asked.status, 'pending');
  assert.deepEqual(parseJson(asked.context, {}), { employerKey: nameKey(employer), employer });

  answerPending(db, 'employer_recipient', 'owner', i => i.subject === nameKey(employer));
  const lifted = await replan(db);
  assertNotBlocked(lifted.info, 'w2_recipient_unknown');
  near(fig(db, 'inc.ytd.w2').v, 20000, 'the answered W-2 counts');
});

// "Northwind Advisory, LLC" normalizes differently from the entity "Northwind Advisory", so ingest
// asks employer_relation. 'household' plus an entity alias (made through ingest's own entity_alias
// question on a P&L sheet named for the alias) maps it to the S corp: not outside wages. Without
// the alias, 'household' matches nothing and blocks.
const NW_LLC = 'Northwind Advisory, LLC';
const nwLlcW2 = () => W2(NW_LLC, { wages: 60000, federalWithheld: 6000 }, { recipient: 'owner', relation: 'household' });

test('MGI1: a household employer is matched by name or alias', async () => {
  const unmatched = await planned({ payroll: [nwLlcW2()] });
  assertBlocked(unmatched.db, unmatched.info, 'household_employer_unmatched', ['agi.est']);

  const db = await S.store({ variant: { payroll: [nwLlcW2()] } });
  await addFile(db, pnlWorkbook([{ name: NW_LLC, income: 0, expenses: { Software: 10 } }], [], { months: 1 }));
  assert.equal(answerPending(db, 'entity_alias', `entity:${SCORP.name}`).length, 1, 'ingest asks whether the alias is the S corp');
  const { info } = await replan(db);
  assertNotBlocked(info, 'household_employer_unmatched');
  assert.equal(figureRow(db, 'inc.ytd.w2'), null, 'not outside wages');
  assert.deepEqual(outsideParts(db), [], 'no outside wage part');
});

// form1040 for 2025: agi 180,000, totalTax 30,000. AGI over 150,000, so 110 percent:
// prior target = 33,000, noted as the return's total tax (D10). With the owner's tax.prior.federal
// 29,000 the fact wins: 31,900, no note.
test('MGI1: the uploaded prior return is read', async () => {
  const { db, result } = await planned({ priorReturn: { agi: 180000, totalTax: 30000, filingStatus: 'mfj' } });
  const target = fig(db, 'sh.fed.priorTarget');
  near(target.v, 33000, 'prior-year target from form1040 totalTax');
  assert.ok(assumptionsOf(target).includes('prior_tax_total_line'), `noted: ${assumptionsOf(target)}`);
  assert.equal(notesFor(['prior_tax_total_line']).length, 1, 'prior_tax_total_line has a readable note');
  assert.ok(!result.warnings.includes('prior_year_missing'), 'the uploaded return is not reported missing');

  const owned = await planned({ priorReturn: { agi: 180000, totalTax: 30000, filingStatus: 'mfj' }, facts: { 'tax.prior.federal': 29000 } });
  const t2 = fig(owned.db, 'sh.fed.priorTarget');
  near(t2.v, 31900, 'the owner fact wins: 29,000 * 1.1');
  assert.ok(!assumptionsOf(t2).includes('prior_tax_total_line'));
});

// A spouse-owned classified partnership and one partnership K-1: ordinary 20,000, guaranteed
// payments 10,000, self-employment earnings 30,000. Business AGI = 30,000; QBI = 20,000 (guaranteed
// payments excluded, 199A(c)(4)(B)); SE input = 30,000 (1402(a)); person = the entity's owner.
const ALDER = Object.freeze({ name: 'Alder Partners', type: 'partnership', owner: 'spouse', income: 0, expenses: {} });
const BIRCH = Object.freeze({ name: 'Birch Partners', type: 'partnership', owner: 'owner', income: 0, expenses: {} });
const K1 = (fields) => ({ docType: 'k1', fields: { taxYear: 2026, ...fields } });
const ALDER_K1 = K1({ entityKind: 'partnership', ordinaryIncome: 20000, guaranteedPayments: 10000, selfEmploymentEarnings: 30000, distributions: 5000 });

test('MGI1: K-1 fields and person', async () => {
  const { db } = await planned({ entities: [SCORP, SOLE_PROP, ALDER], payroll: [ALDER_K1] });
  const parts = businesses(db).filter(b => b.kind === 'partnership');
  assert.equal(parts.length, 1, 'one partnership part');
  assert.equal(parts[0].person, 'spouse');
  near(parts[0].income, 30000, 'business AGI = ordinary + guaranteed payments');
  near(parts[0].qbi, 20000, 'QBI = ordinary income');
  near(parts[0].seInput, 30000, 'SE input = selfEmploymentEarnings');

  const two = await planned({ entities: [SCORP, SOLE_PROP, ALDER, BIRCH], payroll: [ALDER_K1] });
  assertBlocked(two.db, two.info, 'k1_unmatched', ['agi.est']);
});

test('MGI1: an S corp K-1 alongside the S corp P&L adds nothing', async () => {
  const base = await planned({});
  const withK1 = await planned({ payroll: [K1({ entityKind: 's_corp', ordinaryIncome: 50000, distributions: 10000 })] });
  assert.deepEqual(businesses(withK1.db).filter(b => b.kind === 'partnership'), [], 'no partnership part');
  near(fig(withK1.db, 'agi.est').v, fig(base.db, 'agi.est').v, 'AGI unchanged by the S corp K-1');

  // With no classified S corp holding P&L lines, the S corp K-1's income has nowhere to go: block
  // k1_scorp_unmatched (R6-1 item 4.1), never count it as a partnership.
  const orphan = await planned({ entities: [SOLE_PROP], payroll: [K1({ entityKind: 's_corp', ordinaryIncome: 50000, distributions: 10000 })] });
  assertBlocked(orphan.db, orphan.info, 'k1_scorp_unmatched', ['agi.est']);
});

// The HSA and the rollover IRA answered 'spouse' (ingest stores the label "Your spouse"). The spouse
// is 56: HSA room = family 8,750 + catch-up 1,000 - 3,000 personal = 6,750 (the bug treats the
// owner, 45, as holder: 5,750). The pre-tax IRA is the spouse's: ira.pretax.spouse = 50,000.
test('MGI1: account owner labels map to people', async () => {
  const { db } = await planned({
    hints: { [`${INST.hsa}|${MASKS.hsa}`]: { kind: 'hsa', owner: 'spouse' }, [`${INST.broker}|${MASKS.ira}`]: { kind: 'retirement', owner: 'spouse' } },
    facts: { 'household.spouseAge': 56 },
  });
  const owners = db.prepare('SELECT owner FROM accounts WHERE mask IN (?, ?)').all(MASKS.hsa, MASKS.ira).map(r => r.owner);
  assert.deepEqual(owners, ['Your spouse', 'Your spouse'], 'ingest stores the option label');
  near(fig(db, 'room.hsa').v, 6750, 'HSA room for a 56 year old holder');
  near(fig(db, 'ira.pretax.spouse').v, 50000, "the spouse's pre-tax IRA");
  assert.equal(figureRow(db, 'ira.pretax.owner'), null);
});

// facts.mjs reads ingest's fields: an outside W-2 (employerName) gives income.w2; a W-2 from the
// household S corp with no P&L lines gives income.sCorp; a K-1 with entityKind partnership and no
// partnership entity gives income.partnership. Each cites its document.
test('MGI1: income facts read employerName and entityKind', async () => {
  const db = await S.store({
    variant: {
      entities: [{ ...SCORP, income: 0, expenses: {} }, SOLE_PROP],
      payroll: [
        W2(OUT_A, { wages: 50000, federalWithheld: 5000 }, OUTSIDE_OWNER),
        W2(SCORP.name, { wages: 40000, federalWithheld: 4000 }, { recipient: 'owner', relation: 'household' }),
        K1({ entityKind: 'partnership', ordinaryIncome: 1000, guaranteedPayments: 0, selfEmploymentEarnings: 1000 }),
      ],
    },
  });
  const { data, entities } = computeFor(db);
  const derived = deriveFacts(data, { entities });
  const docId = (type, test = () => true) => data.documents.find(d => d.docType === type && test(d)).id;
  const cites = (key, id) => assert.ok(derived[key] && derived[key].rows.some(r => r.table === 'documents' && r.id === id), `${key} cites document ${id}: ${JSON.stringify(derived[key])}`);
  cites('income.w2', docId('w2', d => d.fields.employerName === OUT_A));
  cites('income.sCorp', docId('w2', d => d.fields.employerName === SCORP.name));
  cites('income.partnership', docId('k1'));
});

// D13 (coordinator ruling): the planner overwrites an unconfirmed ingest fact only when the key is
// one it derives (PLANNER_KEYS) and the fact came from a document or parser source (src 'ing:' but
// not 'ing:notes:'). A fact from the owner's notes is never overwritten; when the planner's value
// disagrees it raises ingest's fact_check question instead (subject <source>|<key>|<JSON value>,
// as recordFact builds it). Agreement raises nothing. Notes facts go through ingest's notes path
// with a scripted extract-notes engine at confidence 0.95, above ingest's 0.8 floor, so ingest
// itself asks nothing about them.
const factChecks = (db, key) => db.prepare("SELECT * FROM confirm_items WHERE kind = 'fact_check'").all()
  .map(r => ({ ...r, context: parseJson(r.context, {}) })).filter(r => r.context.key === key);
const notesFact = (key, value) => ({ facts: [{ key, value: String(value), confidence: 0.95 }] });
const unchanged = (db, key, before) => {
  const now = factRow(db, key);
  assert.ok(now, `${key} still stored`);
  for (const c of ['value', 'src', 'confirmed', 'file_id', 'parser', 'updated_at']) assert.deepEqual(now[c], before[c], `${key}.${c} unchanged`);
};

test('MGI1: D13 a notes fact the planner disagrees with is kept and asked about once', async () => {
  const db = await S.store({ variant: {} });
  await addNotes(db, notesFact('income.agiEstimate', 150000));
  const before = factRow(db, 'income.agiEstimate');
  assert.ok(before && before.value === 150000 && String(before.src).startsWith('ing:notes:') && before.confirmed === 0, `notes fact stored: ${JSON.stringify(before)}`);
  assert.equal(factChecks(db, 'income.agiEstimate').length, 0, 'ingest asked nothing (confidence above the floor)');

  await plan(db);
  const agi = fig(db, 'agi.est').v;
  assert.notEqual(agi, 150000, 'the planner disagrees');
  unchanged(db, 'income.agiEstimate', before);
  const asked = factChecks(db, 'income.agiEstimate');
  assert.equal(asked.length, 1, `one fact_check for the planner's value: ${JSON.stringify(asked)}`);
  assert.equal(asked[0].status, 'pending');
  assert.equal(asked[0].context.value, agi, "the question carries the planner's value");
  assert.ok(asked[0].subject.endsWith(`|income.agiEstimate|${JSON.stringify(agi)}`), `subject shape: ${asked[0].subject}`);

  await plan(db);
  unchanged(db, 'income.agiEstimate', before);
  assert.equal(factChecks(db, 'income.agiEstimate').length, 1, 'a second run does not duplicate the question');
});

test('MGI1: D13 a notes fact the planner agrees with is kept and nothing is asked', async () => {
  const twin = await S.store({ variant: {} });
  await plan(twin);
  const agi = fig(twin, 'agi.est').v;

  const db = await S.store({ variant: {} });
  await addNotes(db, notesFact('income.agiEstimate', agi));
  const before = factRow(db, 'income.agiEstimate');
  assert.ok(before && before.value === agi && String(before.src).startsWith('ing:notes:'), `notes fact stored: ${JSON.stringify(before)}`);
  await plan(db);
  near(fig(db, 'agi.est').v, agi, 'the planner computes the same value');
  unchanged(db, 'income.agiEstimate', before);
  assert.equal(factChecks(db, 'income.agiEstimate').length, 0, 'agreement raises nothing');
});

// Liveness for the allowed path: income.w2 written by the W-2 extraction (src ing:extract-w2:...)
// is unconfirmed and a planner key, so the planner's derived fact replaces it.
test('MGI1: D13 a document-sourced planner key is overwritten by the planner', async () => {
  const db = await S.store({ variant: { payroll: [W2(OUT_A, { wages: 50000, federalWithheld: 5000 }, OUTSIDE_OWNER)] } });
  const before = factRow(db, 'income.w2');
  assert.ok(before && String(before.src).startsWith('ing:') && !String(before.src).startsWith('ing:notes:') && before.confirmed === 0,
    `document fact stored: ${JSON.stringify(before)}`);
  await plan(db);
  const after = factRow(db, 'income.w2');
  assert.equal(after.src, 'planner', 'the planner wrote its derived fact');
  assert.equal(after.value, true);
  assert.equal(factChecks(db, 'income.w2').length, 0, 'no question for an allowed overwrite');
});

// benefits.employer401k is not a key the planner derives: a W-2's fact for it is never touched.
test('MGI1: D13 a document-sourced key the planner does not derive is never overwritten', async () => {
  const db = await S.store({ variant: { payroll: [W2(OUT_A, { wages: 50000, federalWithheld: 5000, retirementPlan: true, box12: [{ code: 'D', amount: 3000 }] }, OUTSIDE_OWNER)] } });
  const before = factRow(db, 'benefits.employer401k');
  assert.ok(before && String(before.src).startsWith('ing:') && before.confirmed === 0, `document fact stored: ${JSON.stringify(before)}`);
  await plan(db);
  unchanged(db, 'benefits.employer401k', before);
  await plan(db);
  unchanged(db, 'benefits.employer401k', before);
});

// Final review E1 and E2. A wage-only single filer: no default files (no business, account or
// estimate), no prior return, no dependents, so federal tax is income tax on box 1 less the 2026
// single standard deduction (16,100, OBBBA as indexed) plus Additional Medicare Tax.
// 2026 single brackets (Rev. Proc. 2025-32): 10% to 12,400; 12% to 50,400; 22% to 105,700; 24% to
// 201,775; 32% above, to 256,225.
const SINGLE_WAGES = Object.freeze({
  files: false, priorReturn: false, entities: [],
  facts: { 'household.filingStatus': 'single', 'household.dependents': 0, 'household.dependentAges': [], 'household.expectingChild': false },
});
const errorsOf = info => [...(info.blocked || []), ...Object.values(info.withheld || {})].filter(c => typeof c === 'string');
const missingDataText = db => JSON.stringify((recRow(db, 'missing-data') || {}).def || {});

// E1. Box 1 190,000, box 5 214,500, box 12 not read (the field is absent). Box 1 already excludes
// pretax deferrals and box 5 is Medicare wages as the employer reported them, so AGI and federal
// tax need nothing from box 12 and publish; Medicare wages are never rebuilt from box 1 plus
// deferrals assumed to be zero (the bug: 190,000 + 0 = 190,000 Medicare wages, no Additional
// Medicare Tax, federal tax 34,334). Single filer, Form 8959 Part I and its instructions:
//   taxable = 190,000 - 16,100 = 173,900.
//   income tax = 1,240 + 12% * 38,000 + 22% * 55,300 + 24% * 68,200
//              = 1,240 + 4,560 + 12,166 + 16,368 = 34,334.
//   Additional Medicare = 0.9% * (214,500 - 200,000) = 0.9% * 14,500 = 130.50.
//   federal tax = 34,334 + 130.50 = 34,464.50.
// Only what needs the year's actual deferrals is blocked: the owner's 402(g) total is unknown, so
// the owner's solo 401(k) room (base household, S corp owned by the owner) is withheld with a
// visible reason (the retirement rec's question), while AGI still publishes.
const E1_W2 = box12 => W2(OUT_A, { wages: 190000, medicareWages: 214500, socialSecurityWages: 184500, federalWithheld: 38000, ...(box12 ? { box12 } : {}) }, OUTSIDE_OWNER);

test('MGI1: E1 an unread box 12 still publishes AGI and federal tax from boxes 1 and 5', async () => {
  const { db } = await planned({ ...SINGLE_WAGES, payroll: [E1_W2(null)] });
  assert.equal(db.prepare("SELECT fields FROM documents WHERE doc_type = 'w2'").all().map(r => parseJson(r.fields, {}).box12).filter(b => b !== undefined).length, 0, 'ingest stored no box 12');
  near(fig(db, 'agi.est').v, 190000, 'AGI is box 1');
  near(fig(db, 'tax.fed.taxable').v, 173900, 'taxable income');
  near(fig(db, 'tax.fed.proj').v, 34464.5, 'federal tax with 130.50 of Additional Medicare Tax on box 5');
});

test('MGI1: E1 an unread box 12 blocks only the deferral-dependent retirement room', async () => {
  const { db, info } = await planned({ payroll: [E1_W2(null)] });
  fig(db, 'agi.est');
  fig(db, 'tax.fed.proj');
  for (const k of ['room.solo401k', 'room.solo401k.employee']) assert.equal(figureRow(db, k), null, `${k} is not published on assumed-zero deferrals`);
  const code = (info.withheld || {})['room.solo401k.employee'];
  assert.ok(typeof code === 'string' && code, `room.solo401k.employee withheld with a code: ${JSON.stringify(info.withheld)}`);
  assert.notEqual(reasonText({ info, entities: [] }, code), GENERIC, `${code} has its own reason text`);
  // An owner-answerable gap is shown on the retirement rec as the question to answer.
  const task = confirmTask(code);
  assert.ok(JSON.stringify((recRow(db, 'year-end-retirement') || {}).def || {}).includes(task), `the retirement rec asks: ${task}`);
});

// Liveness, box 12 read. Form 8959 Part I: Additional Medicare Tax is 0.9% of Medicare wages (box 5)
// above the 200,000 single threshold.
//   Matching inputs, box 12 D 24,500 (401(k) deferrals are in box 5, not box 1):
//     taxable = 190,000 - 16,100 = 173,900.
//     income tax = 1,240 + 12% * 38,000 + 22% * 55,300 + 24% * 68,200
//                = 1,240 + 4,560 + 12,166 + 16,368 = 34,334.
//     Additional Medicare = 0.9% * (214,500 - 200,000) = 0.9% * 14,500 = 130.50.
//     federal tax = 34,334 + 130.50 = 34,464.50 (the reviewer's figure).
//   Box 5 read on its own: box 12 D 20,000 and Y 4,500 (409A deferrals, out of box 1 but in box 5
//   under IRC 3121(v)(2)). Box 1 plus the box 12 pretax codes is 210,000, but box 5 is 214,500, so
//   Additional Medicare is still 130.50 and federal tax 34,464.50 (rebuilding gives 90 and 34,424).
test('MGI1: E1 with box 12 read, federal tax includes Additional Medicare Tax on box 5', async () => {
  for (const box12 of [[{ code: 'D', amount: 24500 }], [{ code: 'D', amount: 20000 }, { code: 'Y', amount: 4500 }]]) {
    const { db } = await planned({ ...SINGLE_WAGES, payroll: [E1_W2(box12)] });
    const what = `box 12 ${box12.map(b => b.code).join('+')}`;
    near(fig(db, 'agi.est').v, 190000, `${what}: AGI is box 1`);
    near(fig(db, 'tax.fed.taxable').v, 173900, `${what}: taxable income`);
    near(fig(db, 'tax.fed.proj').v, 34464.5, `${what}: federal tax with 130.50 of Additional Medicare Tax`);
  }
});

// E2. Two outside employers, each with one paystub paid 2026-10-31 showing year-to-date gross
// 100,000 and a 500 deferral this period: projected gross = 100,000 * 12 / 10 = 120,000 each.
// The owner's confirmed answer gives Alpha's year deferral of 6,000 only. Beta's stays unknown, so
// AGI and federal tax block with a reason naming Beta; Alpha's answer never applies to Beta (the
// bug: 240,000 - 6,000 - 6,000 = 228,000).
// Liveness: Beta answered 3,000. Elective deferrals (IRC 402(g)(3)) are excluded from gross income
// (IRC 402(e)(3)): AGI = (120,000 - 6,000) + (120,000 - 3,000) = 231,000.
//   taxable = 231,000 - 16,100 = 214,900.
//   income tax = 1,240 + 4,560 + 12,166 + 24% * 96,075 + 32% * 13,125
//              = 1,240 + 4,560 + 12,166 + 23,058 + 4,200 = 45,224.
//   Medicare wages are gross pay (401(k) deferrals stay in them): 240,000; Additional Medicare =
//   0.9% * 40,000 = 360. federal tax = 45,224 + 360 = 45,584 (the reviewer's figure).
const ALPHA = 'Alpha Example Systems';
const BETA = 'Beta Example Labs';
const E2_STUB = employer => STUB(employer, { payDate: '2026-10-31', periodStart: '2026-10-01', periodEnd: '2026-10-31', gross: 10000, federalWithholding: 1800, ytdGross: 100000, retirementDeferral: 500, hsaDeferral: 0 }, OUTSIDE_OWNER);
const deferralAnswer = (employer, amount) => ({ person: 'owner', plan: 'outside-401k', type: 'deferral', amount, employer });

test('MGI1: E2 a deferral answer applies only to its own employer', async () => {
  const facts = { ...SINGLE_WAGES.facts, 'retirement.contributions': [deferralAnswer(ALPHA, 6000)] };
  const { db, info } = await planned({ ...SINGLE_WAGES, facts, payroll: [E2_STUB(ALPHA), E2_STUB(BETA)] });
  assertBlocked(db, info, 'paystub_deferrals_unknown', ['agi.est', 'tax.fed.proj']);
  const md = missingDataText(db);
  assert.ok(md.includes(BETA), 'the reason names the unresolved employer');
  assert.ok(!md.includes(ALPHA), 'the answered employer is not listed as unresolved');
});

test('MGI1: E2 liveness: with both employers answered AGI is 231,000', async () => {
  const facts = { ...SINGLE_WAGES.facts, 'retirement.contributions': [deferralAnswer(ALPHA, 6000), deferralAnswer(BETA, 3000)] };
  const { db, info } = await planned({ ...SINGLE_WAGES, facts, payroll: [E2_STUB(ALPHA), E2_STUB(BETA)] });
  assertNotBlocked(info, 'paystub_deferrals_unknown');
  near(fig(db, 'agi.est').v, 231000, 'AGI = 114,000 + 117,000');
  near(fig(db, 'tax.fed.proj').v, 45584, 'federal tax with 360 of Additional Medicare Tax');
});

// ================================================================ MGI2: payments counted once, by kind and jurisdiction

// Owner W-2 (employer A): box 1 60,000, federal withheld 9,000, VA withheld 3,000. Workbook: Federal
// April, June, September 6,000 each; State the same months 1,000 each; tax_year answered tax_year.
// form1040 2025: agi 120,000, totalTax 30,000.
//   tax.fed.paid = 18,000 (paid rows only); tax.fed.withheld = 9,000 (withholding rows only).
//   tax.va.paid = 3,000; tax.va.withheld = 3,000 from the 'VA' withholding row.
//   Prior target: agi not over 150,000, 100 percent = 30,000; remaining = 30,000 - 9,000 - 18,000 =
//   3,000. (The bug counts the 9,000 withholding row as a payment too: 30,000 - 9,000 - 27,000 < 0,
//   shown as 0.)
const MGI2_BASE = Object.freeze({
  taxPayments: { state: 1000 },
  priorReturn: { agi: 120000, totalTax: 30000 },
  payroll: [W2(OUT_A, { wages: 60000, federalWithheld: 9000, state: 'VA', stateWithheld: 3000 }, OUTSIDE_OWNER)],
});

test('MGI2: withholding and estimates are each counted once', async () => {
  const { db } = await planned(MGI2_BASE);
  const ids = (jurisdiction, kind) => db.prepare('SELECT id FROM tax_payments WHERE jurisdiction = ? AND kind = ? ORDER BY id').all(jurisdiction, kind).map(r => r.id);

  const fedPaid = fig(db, 'tax.fed.paid');
  near(fedPaid.v, 18000, 'federal estimates');
  assert.equal(fedPaid.label, 'Federal estimated payments logged this year');
  assert.equal(fedPaid.src, 'tax-payments');
  assert.ok(assumptionsOf(fedPaid).includes('paid_rows_as_estimates'), `noted: ${assumptionsOf(fedPaid)}`);
  assert.deepEqual([...fedPaid.locator.rows.ids].sort((a, b) => a - b), ids('federal', 'paid'));

  const fedW = fig(db, 'tax.fed.withheld');
  near(fedW.v, 9000, 'federal withholding');
  assert.equal(fedW.src, 'tax-withholding');
  assert.equal(fedW.locator.rows.table, 'tax_payments');
  assert.deepEqual(fedW.locator.rows.ids, ids('federal', 'withholding'));

  const vaPaid = fig(db, 'tax.va.paid');
  near(vaPaid.v, 3000, 'Virginia estimates');
  assert.equal(vaPaid.label, 'Virginia estimated payments logged this year');
  const vaW = fig(db, 'tax.va.withheld');
  near(vaW.v, 3000, 'Virginia withholding from the VA row');
  assert.deepEqual(vaW.locator.rows.ids, ids('VA', 'withholding'));

  near(fig(db, 'sh.fed.priorTarget').v, 30000, 'prior target at 100 percent');
  near(fig(db, 'sh.fed.priorRemaining').v, 3000, 'prior-year remaining (the bug shows 0)');

  const source = id => db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
  const paidSrc = source('tax-payments');
  assert.ok(paidSrc, 'tax-payments source');
  assert.match(paidSrc.as_of, /^through Sep(tember)? 2026$/, 'as of the latest paid month');
  const whSrc = source('tax-withholding');
  assert.ok(whSrc, 'tax-withholding source');
  assert.equal(whSrc.label, 'Withholding from your W-2s, paystubs and 1099s');
  assert.equal(whSrc.kind, 'docs');
});

// D11 as revised (Form 8959 Part V). The Additional Medicare Tax withholding credit is box 6 less
// 1.45 percent of box 5. Ingest does not extract W-2 box 6, so that credit is a known limit until
// ingest extracts it: the planner counts it as zero and attaches a visible note (this understates
// withholding, so it errs toward paying more).
//   Box 1 240,000 (D 10,000), box 5 250,000, federal withheld 50,000.
//   tax.fed.withheld = 50,000 + 0 = 50,000 with addl_medicare_withholding_not_read.
const HIGH_W2 = W2(OUT_A, { wages: 240000, federalWithheld: 50000, medicareWages: 250000, socialSecurityWages: 184500, box12: [{ code: 'D', amount: 10000 }] }, OUTSIDE_OWNER);

test('MGI2: Additional Medicare withholding counts zero with a note because ingest does not read box 6', async () => {
  const { db } = await planned({ payroll: [HIGH_W2] });
  const fedW = fig(db, 'tax.fed.withheld');
  near(fedW.v, 50000, 'no Additional Medicare credit without box 6');
  assert.ok(assumptionsOf(fedW).includes('addl_medicare_withholding_not_read'), `noted: ${assumptionsOf(fedW)}`);
  assert.equal(notesFor(['addl_medicare_withholding_not_read']).length, 1, 'the note is readable');
});

// Paystubs paid 2026-01-31 and 2026-02-28 withhold 750 federal each; then the W-2 withholds 9,000,
// recipient owner. Ingest archives both paystub rows as summarized, so withholding = 9,000, not
// 10,500.
const STUBS_THEN_W2 = (answers) => [
  STUB(OUT_A, { payDate: '2026-01-31', periodStart: '2026-01-01', periodEnd: '2026-01-31', gross: 5000, federalWithholding: 750, ytdGross: 5000 }, answers),
  STUB(OUT_A, { payDate: '2026-02-28', periodStart: '2026-02-01', periodEnd: '2026-02-28', gross: 5000, federalWithholding: 750, ytdGross: 10000 }, answers),
  W2(OUT_A, { wages: 60000, federalWithheld: 9000 }, answers),
];

test('MGI2: paystub withholding summarized by the W-2 counts once', async () => {
  const { db } = await planned({ payroll: STUBS_THEN_W2(OUTSIDE_OWNER) });
  assert.equal(db.prepare("SELECT count(*) AS n FROM superseded_rows WHERE table_name = 'tax_payments' AND reason = 'summarized'").get().n, 2, 'ingest archived the paystub rows');
  const fedW = fig(db, 'tax.fed.withheld');
  near(fedW.v, 9000, 'the W-2 total alone');
  // Counted from the active tax_payments row (R6-2 item 3), not from document fields.
  const active = db.prepare("SELECT id FROM tax_payments WHERE jurisdiction = 'federal' AND kind = 'withholding' ORDER BY id").all().map(r => r.id);
  assert.equal(active.length, 1, 'only the W-2 row is active');
  assert.equal(fedW.src, 'tax-withholding');
  assert.equal(fedW.locator.rows.table, 'tax_payments');
  assert.deepEqual(fedW.locator.rows.ids, active);
});

// Same files with the recipient unanswered: the paystub rows and the W-2 row of one employer and
// year are all active (summarizing waits for the recipient), so counting them would double count.
// Withholding is held with withholding_recipient_unknown; answering owner gives 9,000.
test('MGI2: unknown recipients mixing paystub and W-2 rows block', async () => {
  const { db, info } = await planned({ payroll: STUBS_THEN_W2({ relation: 'outside' }) });
  assertBlocked(db, info, 'withholding_recipient_unknown', ['tax.fed.withheld']);
  answerPending(db, 'employer_recipient', 'owner', i => i.subject === nameKey(OUT_A));
  await replan(db);
  near(fig(db, 'tax.fed.withheld').v, 9000, 'summarized once the recipient is known');
});

test('MGI2: jurisdictions normalize', async () => {
  const jurisdictionOf = await paymentsExport('jurisdictionOf');
  for (const j of ['VA', 'va', 'Virginia', ' virginia ']) assert.equal(jurisdictionOf(j), 'virginia', JSON.stringify(j));
  assert.equal(jurisdictionOf('federal'), 'federal');
  assert.equal(jurisdictionOf('state'), 'unknown-state');
  assert.equal(jurisdictionOf('MD'), 'other-state');
});

// A W-2 with no state read and 2,000 state withholding is stored under jurisdiction 'state':
// Virginia withholding is held (withholding_state_unknown) while federal figures stay. A Maryland
// W-2 withholding 1,500 is left out of Virginia withholding with a warning; the Virginia W-2's 3,000
// alone counts.
test('MGI2: unknown and other-state withholding stays out of Virginia', async () => {
  const unknown = await planned({ payroll: [W2(OUT_A, { wages: 60000, federalWithheld: 9000, state: '', stateWithheld: 2000 }, OUTSIDE_OWNER)] });
  assert.equal(unknown.db.prepare("SELECT count(*) AS n FROM tax_payments WHERE kind = 'withholding' AND jurisdiction = 'state'").get().n, 1, 'ingest stores jurisdiction state');
  assertBlocked(unknown.db, unknown.info, 'withholding_state_unknown', ['tax.va.withheld', 'sh.va.remaining']);
  near(fig(unknown.db, 'tax.fed.withheld').v, 9000, 'federal withholding is unaffected');

  const md = await planned({
    payroll: [
      W2(OUT_A, { wages: 60000, federalWithheld: 9000, state: 'VA', stateWithheld: 3000 }, OUTSIDE_OWNER),
      W2(OUT_B, { wages: 30000, federalWithheld: 3000, state: 'MD', stateWithheld: 1500 }, OUTSIDE_OWNER),
    ],
  });
  near(fig(md.db, 'tax.va.withheld').v, 3000, 'Virginia withholding excludes Maryland');
  assert.ok(md.result.warnings.includes('other_state_withholding'), `warnings: ${md.result.warnings}`);
});

// Workbook sheet 2026: Federal January 6,000 and April 6,000; the tax_year question unanswered.
// Estimates are held (tax_year_unconfirmed). Answer payment_year: January moves to 2025, so 6,000.
// A fresh store answered tax_year: 12,000.
const JAN_APR = Object.freeze({ fed: 6000, state: null, months: [1, 4] });

test('MGI2: an unconfirmed sheet year blocks estimates', async () => {
  const { db, info } = await planned({ taxPayments: JAN_APR, taxYear: null });
  assertBlocked(db, info, 'tax_year_unconfirmed', ['tax.fed.paid']);
  answerPending(db, 'tax_year', 'payment_year');
  await replan(db);
  near(fig(db, 'tax.fed.paid').v, 6000, 'January counts toward 2025');

  const asTaxYear = await planned({ taxPayments: JAN_APR, taxYear: 'tax_year' });
  near(fig(asTaxYear.db, 'tax.fed.paid').v, 12000, 'both rows count toward 2026');
});

test('MGI2: an unknown payment kind blocks', async () => {
  const classifyPayments = await paymentsExport('classifyPayments');
  const db = await S.store({ variant: {} });
  const data = loadPlanningData(db, NOW);
  data.taxPayments.push({ id: 999999, jurisdiction: 'federal', tax_year: 2026, date: '2026-05-31', amount: 500, kind: null, payer: 'Owner', recipient: null, tax_year_basis: 'confirmed_tax_year', file_id: null });
  const out = classifyPayments(data, { persons: ['owner', 'spouse'], f: 'mfj', isVa: true });
  assert.equal(out.fed.paid.blocked, 'tax_payment_kind_unknown');
  assert.equal(out.fed.withheld.blocked, 'tax_payment_kind_unknown');
  assert.ok(!out.va.paid.blocked, 'Virginia is unaffected');
});

test('MGI2: brief and Q4 prose name estimates and withholding separately', async () => {
  const { db } = await planned(MGI2_BASE);
  const brief = db.prepare('SELECT value FROM content').all().map(r => r.value).join('\n');
  assert.ok(brief.includes('Paid {f:tax.fed.paid} in estimates and had {f:tax.fed.withheld} withheld, toward {f:sh.fed.required} federal safe harbor.'), 'brief tax note');
  const def = id => JSON.stringify((recRow(db, id) || {}).def || {});
  assert.ok(def('fed-q4-estimate').includes('you have paid {f:tax.fed.paid} in estimated payments so far'), 'federal Q4 prose');
  assert.ok(def('va-q4-estimate').includes('you have paid {f:tax.va.paid} in estimated payments so far'), 'Virginia Q4 prose');
});

// ================================================================ MGI5: a corrected W-2 never double counts

// Original W-2 (employer A, 2026): box 1 60,000, federal 9,000, VA 2,700. Corrected W-2 (later
// file): box 1 65,000, federal 9,800, VA 2,925. The employer is answered owner on the first import,
// so the second import asks two withholding_conflict questions (federal and VA).
const ORIGINAL = () => W2(OUT_A, { wages: 60000, federalWithheld: 9000, state: 'VA', stateWithheld: 2700 }, OUTSIDE_OWNER);
const CORRECTED = (conflict) => W2(OUT_A, { wages: 65000, federalWithheld: 9800, state: 'VA', stateWithheld: 2925 }, conflict ? { conflict } : {});
const noFigureIs = (db, v) => {
  for (const f of plannerFigures(db)) assert.notEqual(f.v, v, `${f.key} must not be ${v}`);
};

test('MGI5: a pending correction blocks wages and withholding', async () => {
  const { db, info } = await planned({ payroll: [ORIGINAL(), CORRECTED()] });
  assert.equal(db.prepare("SELECT count(*) AS n FROM confirm_items WHERE kind = 'withholding_conflict' AND status = 'pending'").get().n, 2, 'ingest asked federal and VA');
  assertBlocked(db, info, 'w2_correction_pending', ['inc.ytd.w2', 'agi.est', 'tax.fed.withheld', 'tax.va.withheld', 'room.solo401k.employee']);
  noFigureIs(db, 125000);
});

test('MGI5: the kept form alone counts', async () => {
  const later = await planned({ payroll: [ORIGINAL(), CORRECTED('second')] });
  near(fig(later.db, 'inc.ytd.w2').v, 65000, 'the corrected W-2 only');
  near(fig(later.db, 'tax.fed.withheld').v, 9800, 'corrected federal withholding');
  near(fig(later.db, 'tax.va.withheld').v, 2925, 'corrected Virginia withholding');

  const earlier = await planned({ payroll: [ORIGINAL(), CORRECTED('first')] });
  near(fig(earlier.db, 'inc.ytd.w2').v, 60000, 'the original W-2 only (the bug keeps the last: 65,000)');
  near(fig(earlier.db, 'tax.fed.withheld').v, 9000, 'original federal withholding');
  near(fig(earlier.db, 'tax.va.withheld').v, 2700, 'original Virginia withholding');
});

// 'both': two real W-2s. 60,000 + 65,000 = 125,000; 9,000 + 9,800 = 18,800; 2,700 + 2,925 = 5,625.
test('MGI5: both forms count when the owner says both', async () => {
  const { db } = await planned({ payroll: [ORIGINAL(), CORRECTED('both')] });
  near(fig(db, 'inc.ytd.w2').v, 125000, 'both W-2s');
  near(fig(db, 'tax.fed.withheld').v, 18800, 'both federal rows');
  near(fig(db, 'tax.va.withheld').v, 5625, 'both Virginia rows');
});

test('MGI5: answers that keep different forms block', async () => {
  const { db, info } = await planned({ payroll: [ORIGINAL(), CORRECTED({ federal: 'second', VA: 'first' })] });
  assert.equal(db.prepare("SELECT count(*) AS n FROM confirm_items WHERE kind = 'withholding_conflict' AND status = 'pending'").get().n, 0, 'both questions answered');
  assertBlocked(db, info, 'w2_correction_conflicting', ['inc.ytd.w2', 'agi.est']);
  noFigureIs(db, 125000);
});

// Same wages, new withholding: the same payer identity, so ingest asks one federal conflict
// (askConflict). 'second': wages 60,000 once, not 120,000; federal withholding 9,500. 'first':
// the original is kept, so withholding is 9,000 (the bug reads the last W-2's field: 9,500).
const sameWages = conflict => [
  W2(OUT_A, { wages: 60000, federalWithheld: 9000 }, OUTSIDE_OWNER),
  W2(OUT_A, { wages: 60000, federalWithheld: 9500 }, { conflict }),
];

test('MGI5: a same-wages correction keeps one form', async () => {
  const { db } = await planned({ payroll: sameWages('second') });
  near(fig(db, 'inc.ytd.w2').v, 60000, 'one W-2');
  const fedW = fig(db, 'tax.fed.withheld');
  near(fedW.v, 9500, 'the kept withholding');
  assert.equal(fedW.locator.rows.table, 'tax_payments', 'withholding cites the kept tax_payments row');
  noFigureIs(db, 120000);

  const first = await planned({ payroll: sameWages('first') });
  near(fig(first.db, 'inc.ytd.w2').v, 60000, 'one W-2');
  near(fig(first.db, 'tax.fed.withheld').v, 9000, 'the original withholding is kept');
  noFigureIs(first.db, 120000);
});

// Two forms with equal wages and withholding, box 12 D 5,000 then 6,000: the withholding rows
// collapse as duplicates, so ingest asks nothing, but the documents differ. Nothing reconciles them
// (D12): the wage figures block with a visible reason, never summed (120,000).
test('MGI5: an unreconciled pair blocks', async () => {
  const { db, info } = await planned({
    payroll: [
      W2(OUT_A, { wages: 60000, federalWithheld: 9000, box12: [{ code: 'D', amount: 5000 }] }, OUTSIDE_OWNER),
      W2(OUT_A, { wages: 60000, federalWithheld: 9000, box12: [{ code: 'D', amount: 6000 }] }),
    ],
  });
  assert.equal(db.prepare("SELECT count(*) AS n FROM documents WHERE doc_type = 'w2'").get().n, 2, 'two documents stored');
  assert.equal(db.prepare("SELECT count(*) AS n FROM confirm_items WHERE kind = 'withholding_conflict'").get().n, 0, 'ingest had nothing to ask');
  assertBlocked(db, info, 'w2_duplicate_unresolved', ['inc.ytd.w2', 'agi.est']);
  noFigureIs(db, 120000);
});
