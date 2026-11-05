// Code review round 1 regression tests for the merge-gate fix round (findings C1 to C6). Each test
// cites its primary source and carries the hand calculation it checks. Every household, business
// and amount is synthetic. Store-level tests build fresh synthetic stores
// (test/helpers/real-store.mjs), run the planner and read figures, recs and the scenario API; `info`
// (withheld codes, confirm keys, war-game invalid codes) is read by running computeFigures over the
// same store the way the planner does. Test names start with the criterion tag and the finding.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { planRun } from '../helpers/plan.mjs';
import { computeFigures } from '../../src/jobs/planner/figures.mjs';
import { loadPlanningData, resolveEntities } from '../../src/jobs/planner/data.mjs';
import { deriveFacts, mergeFacts, ownerFactsOf } from '../../src/jobs/planner/facts.mjs';
import { checkProse } from '../../src/jobs/planner/prose.mjs';
import { createEngine } from '../../src/engine/index.mjs';
import { getScenario } from '../../src/api/handlers.mjs';
import {
  scratch, addFact, removeFact, figureRow, recRow, plannerRec, activeRecIds, contentValue, parseJson,
  SCORP, SOLE_PROP, INST, MASKS,
} from '../helpers/real-store.mjs';

const NOW = '2026-11-05';
const JAN = '2027-01-10';
const S = scratch('fathom-review-fixes-');
after(() => S.cleanup());

const plan = (db, now = NOW, engine = null) => planRun(db, { engine, now });
const api = (db, clock = NOW) => ({ db, config: { clock }, params: {}, body: {} });
const near = (actual, expected, what) =>
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= 0.011, `${what}: expected ${expected}, got ${actual}`);
const fig = (db, key) => {
  const row = figureRow(db, key);
  assert.ok(row, `figure ${key} exists`);
  return row;
};
const nonEmpty = v => typeof v === 'string' && v.trim().length > 0;

// The planner's own path to computeFigures, for reading `info` off a store (as in tax-rules.test.mjs).
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
  return computeFigures(data, merged.values, { clock, entities, owner });
}

async function planned(variant = {}, now = NOW) {
  const db = await S.store({ variant });
  const result = await plan(db, now);
  return { db, result, info: computeFor(db, now).info };
}

// Wren Studio: the owner's only business, a sole proprietorship billing 10,000 a month for ten
// months (projected 120,000), with the business checking account mapped to it so the invoice
// deferral game has its cash. The spouse keeps Bluebird Studio from the default household.
const WREN = Object.freeze({ name: 'Wren Studio', type: 'sole_prop', owner: 'owner', income: 10000, expenses: {} });
const WREN_HOUSEHOLD = Object.freeze({
  entities: [WREN, SOLE_PROP],
  hints: { [`${INST.bank}|${MASKS.business}`]: { name: 'Business checking', kind: 'business', owner: null, entity: WREN.name } },
});
const sepFact = amount => [{ person: 'owner', plan: 'sep', type: 'employer', amount }];
const withFacts = (variant, facts) => ({ ...variant, facts: { ...(variant.facts || {}), ...facts } });

// ================================================================ C1 (MG5): SEP contributions use solo 401(k) employer room
// Sources: IRS Publication 560 chapter 5, Deduction Worksheet for Self-Employed (steps 1 to 21) and
// "Multiple plans"/"Deduction limit for multiple plans" (a SEP and a 401(k) of the same employer
// share one employer limit); IRC 404(a)(3)(A), 404(a)(7) and 404(a)(8)(C) (self-employed rate is
// the plan rate over one plus the rate: 25% / 1.25 = 20%); IRC 415(c)(1) and 415(f) (plans of one
// employer aggregate for annual additions); IRC 402(g)(1); Notice 2025-67 (402(g) 24,500, 415(c)
// 72,000, 401(a)(17) 360,000).
//
// Hand calculation, owner age 45, Wren Studio projected net profit 120,000 (100,000 x 12 / 10):
//   SE earnings 120,000 x 0.9235 = 110,820.00 (under the 184,500 wage base)
//   Social Security 110,820 x 12.4% = 13,741.68; Medicare 110,820 x 2.9% = 3,213.78
//   Deductible half (13,741.68 + 3,213.78) / 2 = 8,477.73                       (worksheet step 2)
//   Step 3 compensation 120,000 - 8,477.73 = 111,522.27
//   Step 6 111,522.27 x 20% = 22,304.45; step 7 360,000 x 25% = 90,000; step 8 22,304.45
//   Step 13 (111,522.27 - 24,500) / 2 = 43,511.14, not binding
//   Employer limit for both plans together 22,304.45; SEP already paid 22,000; left 304.45
//   Employee deferral min(24,500; 72,000 - 22,000 - 304.45 = 49,695.55;
//     111,522.27 - 22,304.45 = 89,217.82) = 24,500
//   Solo 401(k) room 24,500 + 304.45 = 24,804.45 (reviewer figure verified).
//   Ignoring the SEP gives 24,500 + 22,304.45 = 46,804.45, the overstated figure.

test('MG5: C1 an existing SEP contribution reduces solo 401(k) room', async () => {
  const base = await planned(WREN_HOUSEHOLD);
  near(fig(base.db, 'room.solo401k.employer').v, 22304.45, 'precondition: employer room with no SEP');
  near(fig(base.db, 'room.solo401k').v, 46804.45, 'precondition: total room with no SEP');

  const sep = await planned(withFacts(WREN_HOUSEHOLD, { 'retirement.contributions': sepFact(22000) }));
  assert.deepEqual(sep.info.blocked, [], 'a 22,000 SEP is within 22,304.45, so nothing blocks');
  // room.sep sums both spouses: owner 22,304.45 - 22,000 = 304.45 plus spouse Bluebird
  // 20% x (66,000 - 4,662.75) = 12,267.45; total 12,571.90. The SEP side already nets the SEP.
  near(fig(sep.db, 'room.sep').v, 12571.9, 'household SEP room left');
  near(fig(sep.db, 'room.solo401k.employee').v, 24500, 'room.solo401k.employee');
  near(fig(sep.db, 'room.solo401k.employer').v, 304.45, 'room.solo401k.employer after the SEP');
  near(fig(sep.db, 'room.solo401k').v, 24804.45, 'room.solo401k after the SEP');
});

// C1b, the mirror of C1: a solo 401(k) employer contribution already made by the same person's
// business uses the same employer limit, so SEP room must net it. Same sources as C1 (Pub 560
// multiple-plan coordination and the self-employed worksheet; IRC 404(a)(3)(A), 404(a)(7),
// 404(a)(8)(C), 415(f)).
//
// Hand calculation, Wren Studio 120,000, owner age 45, solo 401(k) employer contribution 10,000:
//   Step 3 compensation 111,522.27 (as in C1); step 6 20% = 22,304.45; step 8 22,304.45
//   Worksheet check: 10,000 <= 22,304.45 and 10,000 <= (111,522.27 - 0) / 2, valid, no block
//   Owner SEP room 22,304.45 - 10,000 = 12,304.45
//   Spouse Bluebird SEP room 20% x (66,000 - 4,662.75) = 12,267.45, no other plan
//   room.sep (household sum) 12,304.45 + 12,267.45 = 24,571.90
// Liveness: with no other plan the owner's room stays 22,304.45; room.sep 22,304.45 + 12,267.45 =
//   34,571.90.

test('MG5: C1b an existing solo 401(k) employer contribution reduces SEP room', async () => {
  const solo = await planned(withFacts(WREN_HOUSEHOLD, {
    'retirement.contributions': [{ person: 'owner', plan: 'own-corp-401k', type: 'employer', amount: 10000 }],
  }));
  assert.deepEqual(solo.info.blocked, [], 'a 10,000 employer contribution is within the limit, so nothing blocks');
  near(fig(solo.db, 'room.sep').v, 24571.9, 'household SEP room after the solo 401(k) employer contribution');
});

test('MG5: C1b liveness: with no other plan SEP room is unchanged', async () => {
  const base = await planned(WREN_HOUSEHOLD);
  near(fig(base.db, 'room.sep').v, 34571.9, 'household SEP room with no other plan');
});

// ================================================================ C2 (MG12, MG5): deferral game revalidates contributions
// Sources: IRC 62(a)(6) and 404(a)(8) (the self-employed deduction is capped by earned income);
// IRS Publication 560 Deduction Worksheet for Self-Employed (the permitted employer contribution
// moves with net profit); D3 (an option built on invalid inputs is not a current choice).
//
// Hand calculation, Wren Studio 120,000 with a stored 22,000 SEP. Monthly invoices 100,000 / 10 =
// 10,000, so "Move it all to January" shifts 10,000 and "Move half" shifts 5,000.
//   Shift 10,000, profit 110,000: SE earnings 101,585.00; Social Security 12,596.54; Medicare
//     2,945.97; deductible half 7,771.26 (7,771.255); step 3 102,228.74; 20% = 20,445.75
//     (reviewer figure verified). 22,000 > 20,445.75: the SEP is over the limit by 1,554.25.
//   Shift 5,000, profit 115,000: SE earnings 106,202.50; Social Security 13,169.11; Medicare
//     3,079.87; half 8,124.49; step 3 106,875.51; 20% = 21,375.10 < 22,000: also over.
//   No shift: 22,304.45 >= 22,000, valid.
// Liveness: a 20,000 SEP stays valid at every shift (20,445.75 >= 20,000).

const OVER_OPTIONS = ['d50', 'd100'];
const optionReason = o => (nonEmpty(o.unavailable) ? o.unavailable : nonEmpty(o.blocked) ? o.blocked : null);

// A current deferral game (not marked unavailable) may not offer an option whose shift makes the
// stored SEP invalid unless that option carries a reason and no current-year tax cut.
function assertNoOverLimitClaim(scenario, what) {
  const g = scenario.wargame && scenario.wargame.deferral;
  if (!g || g.status === 'unavailable') return g ? 'unavailable' : 'absent';
  for (const id of OVER_OPTIONS) {
    const o = (g.options || []).find(x => x.id === id);
    if (!o) continue;
    assert.ok(optionReason(o), `${what}: option ${id} is offered as a current choice with no reason: ${JSON.stringify(o)}`);
    assert.ok(!(o.tax2026 < 0), `${what}: option ${id} claims a current-year tax cut of ${o.tax2026} on an over-limit SEP`);
  }
  return 'options';
}

test('MG12: C2 a deferral shift that makes the stored SEP exceed its limit is not a current choice', async () => {
  // Single run with the SEP already stored: no current option may claim the tax cut.
  const once = await planned(withFacts(WREN_HOUSEHOLD, { 'retirement.contributions': sepFact(22000) }));
  assertNoOverLimitClaim(getScenario(api(once.db)), 'single run');

  // A game built before the SEP was recorded must turn visibly unavailable (or mark the options).
  const { db } = await planned(WREN_HOUSEHOLD);
  const before = contentValue(db, 'wargame').deferral;
  assert.ok(before && before.options.length === 3, 'precondition: the game is built without the SEP');
  addFact(db, 'retirement.contributions', sepFact(22000));
  await plan(db);
  const scenario = getScenario(api(db));
  const g = scenario.wargame.deferral;
  assert.ok(g, 'the game stays as history');
  const shape = assertNoOverLimitClaim(scenario, 'after the SEP');
  if (shape === 'unavailable') {
    assert.ok(nonEmpty(contentValue(db, 'wargame').deferral.unavailable), 'the unavailable game names its reason');
  } else {
    for (const id of OVER_OPTIONS) assert.ok(optionReason(g.options.find(x => x.id === id)), `option ${id} names its reason`);
  }
});

test('MG12: C2 liveness: a shift that keeps the SEP valid still builds the deferral game', async () => {
  const { db, info } = await planned(withFacts(WREN_HOUSEHOLD, { 'retirement.contributions': sepFact(20000) }));
  assert.equal((info.wargameInvalid || {}).deferral, undefined, `deferral invalid: ${(info.wargameInvalid || {}).deferral}`);
  const g = getScenario(api(db)).wargame.deferral;
  assert.ok(g, 'the deferral game is served');
  assert.notEqual(g.status, 'unavailable');
  assert.equal(g.options.length, 3);
  for (const o of g.options) assert.equal(optionReason(o), null, `option ${o.id} is not marked`);
  const all = g.options.find(o => o.id === 'd100');
  assert.ok(all.tax2026 < 0, `moving 10,000 lowers this year's tax: ${all.tax2026}`);
});

// ================================================================ C3 (MG7): deadline sponsor follows the sizing sponsor
// Sources: IRC 401(b)(2) as amended by SECURE 2.0 section 317 (a sole proprietor who is the only
// employee may adopt a first plan after year end and make the first year's elective deferrals by
// the unextended return due date); IRC 6072(a) (Apr 15); Treas. Reg. 1.401(k)-1(a)(6)(iii).
//
// The owner's S corp pays no officer salary, so it has no compensation to defer from and sizing
// uses the spouse's sole proprietorship (Bluebird Studio, 66,000 projected). The spouse confirmed
// being the only owner and employee and has no plan, so both recs follow the first-year Apr 15
// window and never describe payroll.

const ZERO_SALARY_CORP = Object.freeze({ name: SCORP.name, type: 's_corp', owner: 'owner', income: 20000, expenses: { Software: 300 } });
const C3_VARIANT = Object.freeze({ entities: [ZERO_SALARY_CORP, SOLE_PROP], facts: { 'business.onlyEmployee': true } });
const C3_RECS = ['solo401k-setup', 'year-end-retirement'];
const recTexts = def => [
  def.title, def.summary, ...(def.why || []), ...(def.qa || []).flatMap(q => [q.q, ...q.a]),
  ...(def.tasks || []).map(t => t.t), ...(def.value || []).map(v => v.text), ...(def.cross || []),
].filter(s => typeof s === 'string');

test('MG7: C3 a zero-salary S corp owner with a sole proprietor spouse gets the sole proprietor windows', async () => {
  const { db, info } = await planned(C3_VARIANT);
  assert.ok(figureRow(db, 'room.solo401k.employee'), 'precondition: the spouse sole proprietorship is sized');
  assert.equal(fig(db, 'room.solo401k.employee').locator.inputs.kind, 'self-employed', 'precondition: sized as self-employed');
  for (const id of C3_RECS) {
    const r = recRow(db, id);
    assert.ok(r, `${id} is raised`);
    assert.equal(r.window_close, '2027-04-15', `${id} window`);
    assert.equal(r.window_label, 'Apr 15', `${id} label`);
    for (const s of recTexts(r.def)) assert.doesNotMatch(s, /payroll/i, `${id}: "${s}"`);
  }
  assert.deepEqual(info.solo && { person: info.solo.person, kind: info.solo.kind }, { person: 'spouse', kind: 'sole' }, `info.solo: ${JSON.stringify(info.solo)}`);
  // In January the first-year window is still open: neither rec is closed or dismissed.
  await plan(db, JAN);
  for (const id of C3_RECS) {
    const r = recRow(db, id);
    assert.ok(r, `${id} still exists in January`);
    assert.equal(plannerRec(db, id).retired_at, null, `${id} is not retired in January (${plannerRec(db, id).retired_reason})`);
    assert.notEqual(r.status, 'dismissed', `${id} is not dismissed in January`);
    assert.equal(r.window_close, '2027-04-15', `${id} keeps the Apr 15 window in January`);
    assert.ok(activeRecIds(db).includes(id));
  }
});

// ================================================================ C4 (MG6): an invalid outside-deferral fact blocks dependent room
// Sources: IRC 402(g)(1) (one regular deferral limit per person across every plan, so an unusable
// statement of outside deferrals leaves every dependent room figure unknown); IRC 414(v)(2).
//
// Default household: Northwind salary 60,000, owner age 45. retirement.otherPlanDeferrals
// {owner: {deferral: 10,000, catchUp: -1}} is invalid (a negative catch-up). The known 10,000 must
// not be dropped: with no outside documents the code currently falls through, counts zero outside
// deferrals and publishes 24,500 employee room. A valid fact {deferral: 10,000, catchUp: 0} gives
// employee room 24,500 - 10,000 = 14,500.

const SOLO_KEYS = ['room.solo401k', 'room.solo401k.employee', 'room.solo401k.employer', 'room.solo401k.catchUp', 'room.solo401k.rothCatchUp', 'room.solo401k.pretax'];
const INVALID_OUTSIDE = { owner: { deferral: 10000, catchUp: -1 } };
const VALID_OUTSIDE = { owner: { deferral: 10000, catchUp: 0 } };

test('MG6: C4 an invalid outside-deferral fact withholds solo room and the salary curve with a reason', async () => {
  const { db, info } = await planned({ facts: { 'retirement.otherPlanDeferrals': INVALID_OUTSIDE } });
  for (const k of SOLO_KEYS) assert.equal(figureRow(db, k), null, `${k} is not published from an invalid fact (got ${figureRow(db, k) && figureRow(db, k).v})`);
  assert.ok(nonEmpty(info.withheld['room.solo401k.employee']), `withheld reason: ${JSON.stringify(info.withheld)}`);
  assert.equal(db.prepare("SELECT count(*) AS n FROM figures WHERE key LIKE 'wg.salary.%'").get().n, 0, 'no salary war-game figures');
  assert.ok(nonEmpty((info.wargameInvalid || {}).salary), `salary game invalid code: ${JSON.stringify(info.wargameInvalid)}`);
  const ye = recRow(db, 'year-end-retirement');
  if (ye) assert.doesNotMatch(ye.def.summary, /\{f:room\.solo401k/, 'the year-end rec is not sized from the invalid fact');

  // Visible: a curve and room built from a valid fact turn unavailable when the fact goes bad.
  const s = await S.store({ variant: { facts: { 'retirement.otherPlanDeferrals': VALID_OUTSIDE } } });
  await plan(s);
  assert.ok(contentValue(s, 'wargame').salary, 'precondition: the salary game is built');
  addFact(s, 'retirement.otherPlanDeferrals', INVALID_OUTSIDE);
  await plan(s);
  const scenario = getScenario(api(s));
  assert.equal(scenario.wargame.salary.status, 'unavailable');
  assert.ok(nonEmpty(contentValue(s, 'wargame').salary.unavailable), 'the salary game names its reason');
  const room = scenario.fig['room.solo401k.employee'];
  assert.ok(!room || nonEmpty(room.unavailable), `employee room is absent or marked unavailable: ${JSON.stringify(room)}`);
});

test('MG6: C4 liveness: a valid outside-deferral fact sizes room and the curve', async () => {
  for (const other of [VALID_OUTSIDE, { owner: { deferral: 10000 } }]) {
    const { db, info } = await planned({ facts: { 'retirement.otherPlanDeferrals': other } });
    near(fig(db, 'room.solo401k.employee').v, 14500, `employee room with ${JSON.stringify(other)}`);
    assert.ok(contentValue(db, 'wargame').salary, 'salary game built');
    assert.equal((info.wargameInvalid || {}).salary, undefined);
  }
});

// ================================================================ C5 (MG6): employer room waits for prior-year sponsor wages
// Sources: IRC 414(v)(7)(A) (catch-ups must be Roth for a participant whose prior-year FICA wages
// from the sponsor exceeded the threshold); Treas. Reg. 1.414(v)-2(b)(2) (no Roth program means no
// catch-up for that participant); Notice 2025-67 (threshold 150,000; catch-up 11,250 at 60 to 63).
//
// Cedar Advisory S corp, officer salary 2,500 a month, projected 30,000; owner age 61; no 2025 W-2
// and no fact, so box 3 wages are unknown. The employer room depends on the answer:
//   Not affected (box 3 <= 150,000): employee 24,500; catch-up min(11,250, 30,000 - 24,500) =
//     5,500 pre-tax; employer min(7,500, 47,500, 30,000 - 24,500 - 5,500 = 0) = 0.
//   Affected, plan offers Roth: same allocation, catch-up Roth; employer 0.
//   Affected, no Roth: catch-up disabled; employer min(7,500, 47,500, 30,000 - 24,500) = 5,500
//     (reviewer figure verified).
// So publishing employer room 0 now is unsupported; it is withheld with a reason. The regular
// employee room (24,500 in every case) may publish.
// Liveness: at a 180,000 salary the employer room is 45,000 in every case, so it still publishes.

const CEDAR = 'Cedar Advisory';
const cedar = (monthlySalary, income, facts = {}) => ({
  entities: [{ name: CEDAR, type: 's_corp', owner: 'owner', income, expenses: { 'Officer salary': monthlySalary, 'Payroll taxes': monthlySalary * 0.0765 } }, SOLE_PROP],
  facts: { 'household.ownerAge': 61, ...facts },
});

test('MG6: C5 unknown prior-year sponsor wages withhold employer room that depends on the catch-up', async () => {
  const { db, info } = await planned(cedar(2500, 10000));
  assert.equal(info.retireCatchUp, 'retirement.priorYearFicaWages', 'the owner is asked for box 3 wages');
  const employer = figureRow(db, 'room.solo401k.employer');
  assert.equal(employer, null, `employer room is withheld, not published as ${employer && employer.v}`);
  assert.ok(nonEmpty(info.withheld['room.solo401k.employer']), `withheld reason: ${JSON.stringify(info.withheld)}`);
  for (const k of ['room.solo401k', 'room.solo401k.catchUp', 'room.solo401k.rothCatchUp', 'room.solo401k.pretax']) {
    assert.equal(figureRow(db, k), null, `${k} waits for the wages`);
  }

  // Visible: an employer figure published once the wages were known turns unavailable when they go.
  const s = await S.store({ variant: cedar(2500, 10000, { 'retirement.priorYearFicaWages': { owner: 140000 } }) });
  await plan(s);
  assert.equal(fig(s, 'room.solo401k.employer').v, 0, 'precondition: not affected, employer 0');
  removeFact(s, 'retirement.priorYearFicaWages');
  await plan(s);
  const f = getScenario(api(s)).fig['room.solo401k.employer'];
  assert.ok(!f || nonEmpty(f.unavailable), `employer room is absent or marked unavailable: ${JSON.stringify(f)}`);
});

test('MG6: C5 liveness: employer room that does not depend on the catch-up still publishes', async () => {
  // Cedar salary 15,000 a month, projected 180,000: employer min(45,000, 47,500, 180,000 - 24,500 -
  // 11,250 = 144,250) = 45,000 with or without the catch-up.
  const { db, info } = await planned(cedar(15000, 40000));
  assert.equal(info.retireCatchUp, 'retirement.priorYearFicaWages');
  assert.equal(fig(db, 'room.solo401k.employee').v, 24500);
  assert.equal(fig(db, 'room.solo401k.employer').v, 45000);
});

// ================================================================ C6 (MG13): words between a number and a money word
// The planner-side check (R2-7, D5) blanks "in YYYY" and date forms only when no money word follows;
// it looked at the next word alone, so a word in between ("US", "taxable") let an amount through.
// Revision 5 K5 drops bare "in YYYY" and the money-word context: only strict full dates, "tax year
// YYYY" and the identifiers are masked (see mg-review-fixes-2.test.mjs).

const ALLOWED = { fig: { 'sh.fed.remaining': 15000 }, law: {}, pct: {}, names: {} };
const fieldsWith = summary => ({ summary, why: ['The figures behind this come from your data.'], qa: [] });
const SNEAKY = [
  'Pay in 2026 US dollars.',
  'Pay 2026 taxable dollars.',
  'Set aside in 2026 extra after-tax dollars.',
];
const STILL_FINE = [
  'Pay {f:sh.fed.remaining} by Jan 15, 2027.',
  'It applies for tax year 2026.',
  'Open the account by Dec 31, 2026 before you file.',
  'Defer more into your solo 401(k) this year.',
];
const VALID = {
  summary: '{n:household} has a window to act on this.',
  why: ['The figures behind this come from your data.'],
  qa: [{ q: 'What should I do first?', a: ['Start with the first task on the list.'] }],
};

// Answers every call through a one-shot fake gateway (as in prose.test.mjs).
function scripted(reply) {
  const calls = [];
  return {
    calls,
    async call(args) {
      calls.push(args);
      const engine = createEngine({ mode: 'fake', responses: [{ text: reply(args), costUsd: 0.01 }] });
      return engine.call(args);
    },
  };
}

test('MG13: C6 a money word a few words after a number fails the planner check', () => {
  for (const text of SNEAKY) {
    const res = checkProse(fieldsWith(text), ALLOWED);
    assert.equal(res.ok, false, `accepted: "${text}"`);
    assert.equal(res.reason, 'literal', `"${text}"`);
    assert.equal(checkProse({ ...VALID, qa: [{ q: 'How much?', a: [text] }] }, ALLOWED).ok, false, `accepted in a qa answer: "${text}"`);
  }
});

test('MG13: C6 liveness: dates and identifiers with ordinary words after them still pass', () => {
  for (const text of STILL_FINE) {
    const res = checkProse(fieldsWith(text), ALLOWED);
    assert.ok(res.ok, `rejected (${res.reason}): "${text}"`);
  }
});

test('MG13: C6 writeProse rejects the model reply and falls back to the template', async () => {
  const db = await S.store();
  const engine = scripted(() => JSON.stringify({ ...VALID, summary: 'Pay in 2026 US dollars.' }));
  await plan(db, NOW, engine);
  assert.ok(engine.calls.length > 0, 'the engine was asked');
  const src = db.prepare('SELECT rec_id, prose_src FROM planner_recs WHERE retired_at IS NULL').all();
  for (const r of src) assert.equal(r.prose_src, 'template', `${r.rec_id} kept model prose`);
  assert.doesNotMatch(recRow(db, 'fed-q4-estimate').def.summary, /US dollars/);
});

test('MG13: C6 stored prose with the phrase is not kept on the next run', async () => {
  const db = await S.store();
  await plan(db);
  const id = 'fed-q4-estimate';
  const template = recRow(db, id).def;
  const def = parseJson(db.prepare('SELECT def FROM recs WHERE id = ?').get(id).def, {});
  def.summary = 'Pay in 2026 US dollars.';
  db.prepare('UPDATE recs SET def = ? WHERE id = ?').run(JSON.stringify(def), id);
  db.prepare("UPDATE planner_recs SET prose_src = 'model' WHERE rec_id = ?").run(id);
  const result = await plan(db);
  assert.equal(recRow(db, id).def.summary, template.summary, 'the template summary is back');
  assert.equal(plannerRec(db, id).prose_src, 'template');
  assert.ok(result.counts.prose.template >= 1, 'the rec was rewritten, not kept');
});
