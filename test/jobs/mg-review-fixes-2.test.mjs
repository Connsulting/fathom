// Code review round 2 regression tests for the merge-gate fix round (findings D1 to D5, plan
// Revision 5 K1 to K5). Each test cites its primary source and carries the hand calculation it
// checks. Every household, business and amount is synthetic. Store-level tests build fresh
// synthetic stores (test/helpers/real-store.mjs), run the planner and read figures, the scenario API
// and wargamePick; `info` is read by running computeFigures over the same store the way the planner
// does. Test names start with the criterion tag and the finding.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { planRun } from '../helpers/plan.mjs';
import { computeFigures } from '../../src/jobs/planner/figures.mjs';
import { loadPlanningData, resolveEntities } from '../../src/jobs/planner/data.mjs';
import { deriveFacts, mergeFacts, ownerFactsOf } from '../../src/jobs/planner/facts.mjs';
import { checkProse } from '../../src/jobs/planner/prose.mjs';
import { createEngine } from '../../src/engine/index.mjs';
import { getScenario, wargamePick } from '../../src/api/handlers.mjs';
import {
  scratch, addFact, w2Doc, figureRow, recRow, plannerRec, contentValue, parseJson, SCORP, SOLE_PROP, INST, MASKS,
} from '../helpers/real-store.mjs';

const NOW = '2026-11-05';
const JAN = '2027-01-10';
const S = scratch('fathom-review-fixes-2-');
after(() => S.cleanup());

const plan = (db, now = NOW, engine = null) => planRun(db, { engine, now });
const api = (db, clock = NOW, params = {}, body = {}) => ({ db, config: { clock }, params, body });
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

const withFacts = (variant, facts) => ({ ...variant, facts: { ...(variant.facts || {}), ...facts } });
const sepFact = (amount, entity) => [{ person: 'owner', plan: 'sep', type: 'employer', amount, ...(entity ? { entity } : {}) }];
const ownPlan = (type, amount, entity) => ({ person: 'owner', plan: 'own-corp-401k', type, amount, ...(entity ? { entity } : {}) });

// An owner-only sole proprietorship (the spouse has no business, so room.sep is the owner's alone).
// `monthly` is billed for ten months and projected over twelve (x 12 / 10). No children, so a low
// income never trips the refundable child credit block (IRC 24(d), not modeled).
const NO_CHILDREN = Object.freeze({ 'household.dependents': 0, 'household.dependentAges': [], 'household.expectingChild': false });
const wrenOnly = monthly => ({
  entities: [{ name: 'Wren Studio', type: 'sole_prop', owner: 'owner', income: monthly, expenses: {} }],
  hints: { [`${INST.bank}|${MASKS.business}`]: { name: 'Business checking', kind: 'business', owner: null, entity: 'Wren Studio' } },
  facts: NO_CHILDREN,
});

// ================================================================ D1 (MG5, K1): SEP room nets the same business's 401(k) deferrals
// Sources: IRS Publication 560 chapter 5, Deduction Worksheet for Self-Employed (steps 7 to 13: with
// elective deferrals, step 10 is the 415(c) dollar limit less the deferrals, step 12 half of
// compensation less the deferrals, step 13 the smallest of steps 7, 10 and 12) and "Deduction limit
// for multiple plans" (a SEP and a 401(k) of one employer share the limits); IRC 415(c)(1) and 415(f)
// (annual additions of all defined contribution plans of one employer aggregate, and elective
// deferrals are annual additions); IRC 404(a)(3)(A) and 404(a)(8)(C); IRC 402(g)(1); Notice 2025-67
// (402(g) 24,500, 415(c) 72,000, 401(a)(17) 360,000).
//
// Case 1, owner Wren Studio 33,333.33 a month (ytd 333,333.30, projected 399,999.96, the reviewer's
// 400,000 to the cent of rounding), 24,500 deferred to the business's solo 401(k), age 45:
//   SE earnings 399,999.96 x 0.9235 = 369,399.96; Social Security on the 184,500 base = 22,878.00;
//   Medicare 369,399.96 x 2.9% = 10,712.60; deductible half 16,795.30
//   Step 3 compensation 399,999.96 - 16,795.30 = 383,204.66
//   Step 5 383,204.66 x 20% = 76,640.93; step 6 360,000 x 25% = 90,000; step 7 76,640.93
//   Step 8 72,000; step 9 deferrals 24,500; step 10 72,000 - 24,500 = 47,500
//   Step 11 383,204.66 - 24,500 = 358,704.66; step 12 179,352.33
//   Step 13 min(76,640.93; 47,500; 179,352.33) = 47,500 (reviewer figure verified)
//   The bug ignores the deferral: min(76,640.93, 72,000) = 72,000.
// Case 2, Wren Studio 2,500 a month (projected 30,000 exactly), 24,500 deferred:
//   SE earnings 27,705.00; Social Security 3,435.42; Medicare 803.45 (803.445, rounded per line);
//   deductible half (3,435.42 + 803.45) / 2 = 2,119.44 (2,119.435)
//   Step 3 30,000 - 2,119.44 = 27,880.56; step 7 27,880.56 x 20% = 5,576.11
//   Step 10 47,500; step 11 27,880.56 - 24,500 = 3,380.56; step 12 1,690.28
//   Step 13 min(5,576.11; 47,500; 1,690.28) = 1,690.28 (reviewer figure verified); the bug: 5,576.11.
// In both cases the solo 401(k) employer room runs the same worksheet, so room.sep must equal
// room.solo401k.employer (K1: sepRoom becomes that employer room).

test('MG5: D1 SEP room nets employee deferrals to the same business solo 401(k) (400,000 profit)', async () => {
  const { db, info } = await planned(withFacts(wrenOnly(33333.33), { 'retirement.contributions': [ownPlan('deferral', 24500)] }));
  assert.deepEqual(info.blocked, [], 'a 24,500 deferral is within every limit');
  near(fig(db, 'room.solo401k.employer').v, 47500, 'precondition: solo 401(k) employer room');
  near(fig(db, 'room.sep').v, 47500, 'SEP room after the 24,500 deferral (the bug publishes 72,000)');
});

test('MG5: D1 SEP room nets employee deferrals at low profit (30,000 profit)', async () => {
  const { db, info } = await planned(withFacts(wrenOnly(2500), { 'retirement.contributions': [ownPlan('deferral', 24500)] }));
  assert.deepEqual(info.blocked, [], 'a 24,500 deferral fits 27,880.56 of compensation');
  near(fig(db, 'room.solo401k.employer').v, 1690.28, 'precondition: solo 401(k) employer room');
  near(fig(db, 'room.sep').v, 1690.28, 'SEP room after the 24,500 deferral (the bug publishes 5,576.11)');
});

test('MG5: D1 liveness: with no deferral SEP room is the full employer limit', async () => {
  const big = await planned(wrenOnly(33333.33));
  near(fig(big.db, 'room.sep').v, 72000, '400,000 profit: min(76,640.93, 72,000)');
  const small = await planned(wrenOnly(2500));
  near(fig(small.db, 'room.sep').v, 5576.11, '30,000 profit: 20% of 27,880.56');
});

// The S corp SEP path (room.sep from W-2 compensation, used when no sole proprietorship is sized).
// Sources: IRC 404(a)(3)(A)(i) (25% of compensation; IRC 404(a)(12) and 415(c)(3)(D) count elective
// deferrals as compensation); IRC 415(c)(1)(B) (annual additions within 100% of compensation) and
// 415(f); Pub 560 "Deduction limit for multiple plans".
//   Cedar Advisory salary 2,500 a month, projected 30,000; 24,500 deferred to its 401(k); age 45:
//     25% x 30,000 = 7,500; 415(c) min(72,000, 30,000) - 24,500 = 5,500; employer room 5,500
//     (the bug ignores the deferral: 7,500).
//   Salary 20,000 a month, projected 240,000; 24,500 deferred:
//     25% x 240,000 = 60,000; 415(c) min(72,000, 240,000) - 24,500 = 47,500; employer room 47,500
//     (the bug: 60,000).
// Solo 401(k) employer room, same inputs: min(7,500; 5,500 - 0; 30,000 - 24,500 - 0) = 5,500 and
// min(60,000; 47,500; 240,000 - 24,500) = 47,500, so room.sep matches it.

const CEDAR = 'Cedar Advisory';
const cedarOnly = (monthlySalary, income, facts = {}) => ({
  entities: [{ name: CEDAR, type: 's_corp', owner: 'owner', income, expenses: { 'Officer salary': monthlySalary, 'Payroll taxes': monthlySalary * 0.0765 } }],
  facts,
});

test('MG5: D1 the S corp SEP path nets employee deferrals to the same employer', async () => {
  for (const [monthly, income, expected, bug] of [[2500, 10000, 5500, 7500], [20000, 30000, 47500, 60000]]) {
    const { db, info } = await planned(cedarOnly(monthly, income, { 'retirement.contributions': [ownPlan('deferral', 24500)] }));
    assert.deepEqual(info.blocked, [], `salary ${monthly * 12}: nothing blocks`);
    near(fig(db, 'room.solo401k.employer').v, expected, `salary ${monthly * 12}: solo 401(k) employer room`);
    near(fig(db, 'room.sep').v, expected, `salary ${monthly * 12}: SEP room (the bug publishes ${bug})`);
  }
});

test('MG5: D1 liveness: the S corp SEP path with no deferral is 25% of salary', async () => {
  const { db } = await planned(cedarOnly(2500, 10000));
  near(fig(db, 'room.sep').v, 7500, '25% x 30,000');
});

// ================================================================ D4 (MG5, K4): one record per contribution
// Sources: IRS Publication 560 (employer contributions and the 25% limit, IRC 404(a)(3)(A)); K4
// precedence: documents and P&L records win, and an owner fact of a type already recorded for that
// sponsor is skipped (SEP and employer are one type).
//
// Northwind Advisory S corp with no P&L officer salary; its 2026 W-2 to the owner shows 100,000 of
// wages and no deferrals, so compensation is 100,000. Owner age 45, the spouse has no business. The
// one 10,000 employer contribution is a P&L line (1,000 a month for ten months, ytd 10,000) and also
// an owner fact.
//   Counted once: 25% x 100,000 = 25,000 - 10,000 = 15,000 SEP room.
//   Solo 401(k): employee min(24,500; 100,000 - 10,000 = 90,000 annual-additions headroom; 90,000)
//     = 24,500; employer min(25,000 - 10,000 = 15,000; 90,000 - 24,500 = 65,500;
//     100,000 - 24,500 - 10,000 = 65,500) = 15,000.
//   Counted twice (the bug): 25,000 - 20,000 = 5,000 for both.

const NW_NO_SALARY = Object.freeze({ name: SCORP.name, type: 's_corp', owner: 'owner', income: 20000, expenses: { Software: 300 } });
const NW_W2 = Object.freeze(w2Doc({ employerName: SCORP.name, person: 'owner', wages: 100000, medicareWages: 100000, box12: [] }));
const EMPLOYER_LINE = Object.freeze({ entity: SCORP.name, category: '401(k) employer contribution', monthly: 1000 });
const corpComp = ({ line = false, facts = [] } = {}) => ({
  entities: [NW_NO_SALARY],
  payroll: [NW_W2],
  ...(line ? { pnlExtra: [EMPLOYER_LINE] } : {}),
  facts: facts.length ? { 'retirement.contributions': facts } : {},
});

test('MG5: D4 an employer contribution in a P&L line and an owner fact counts once', async () => {
  const { db, info } = await planned(corpComp({ line: true, facts: [ownPlan('employer', 10000)] }));
  assert.deepEqual(info.blocked, []);
  near(fig(db, 'room.solo401k.employer').v, 15000, 'employer room (the bug publishes 5,000)');
  near(fig(db, 'room.sep').v, 15000, 'SEP room (the bug publishes 5,000)');
});

test('MG5: D4 a SEP fact and a P&L employer line for the same sponsor count once', async () => {
  const { db } = await planned(corpComp({ line: true, facts: sepFact(10000) }));
  near(fig(db, 'room.sep').v, 15000, 'SEP and employer are one type: the P&L line wins');
  near(fig(db, 'room.solo401k.employer').v, 15000, 'employer room');
});

test('MG5: D4 liveness: the P&L line alone and the fact alone each give 15,000', async () => {
  for (const variant of [corpComp({ line: true }), corpComp({ facts: [ownPlan('employer', 10000)] })]) {
    const { db } = await planned(variant);
    near(fig(db, 'room.sep').v, 15000, `SEP room, ${variant.pnlExtra ? 'P&L line' : 'owner fact'}`);
    near(fig(db, 'room.solo401k.employer').v, 15000, `employer room, ${variant.pnlExtra ? 'P&L line' : 'owner fact'}`);
  }
});

// Prior-year sponsor wages follow the same precedence (K4): a 2025 W-2 box 3 from the sponsor beats
// the owner's retirement.priorYearFicaWages fact. Sources: IRC 414(v)(7)(A) (catch-ups must be Roth
// when prior-year FICA wages from the sponsor exceed 150,000, Notice 2025-67); T.D. 10033 (box 3).
//   Cedar Advisory salary 15,000 a month, projected 180,000; owner age 61 (catch-up 11,250); no
//   retirement.planOffersRoth fact.
//   Box 3 160,000, fact 140,000: box 3 wins, 160,000 > 150,000, affected; Roth feature unconfirmed,
//     so the catch-up is shown only as Roth room (room.solo401k.rothCatchUp, roth_catch_up_unconfirmed)
//     and no pre-tax room.solo401k.catchUp. The bug reads the fact (not affected) and publishes a
//     pre-tax catch-up of min(11,250, 180,000 - 24,500) = 11,250.
//   Box 3 140,000, fact 160,000: box 3 wins, not affected: pre-tax catch-up 11,250 published.

const priorW2 = box3 => w2Doc({ taxYear: 2025, employerName: CEDAR, person: 'owner', wages: box3 - 10000, socialSecurityWages: box3 });
const cedarWages = (box3, fact) => ({
  ...cedarOnly(15000, 40000, { 'household.birthYears': { owner: 1965 }, 'retirement.priorYearFicaWages': { owner: fact } }),
  payroll: [priorW2(box3)],
});
const priorStep = db => fig(db, 'room.solo401k.employee').locator.steps.find(s => /Social Security wages from the plan sponsor/.test(s.label));

test('MG5: D4 a prior-year W-2 box 3 from the sponsor beats the owner wage fact', async () => {
  const over = await planned(cedarWages(160000, 140000));
  assert.equal(figureRow(over.db, 'room.solo401k.catchUp'), null, 'no pre-tax catch-up: box 3 160,000 makes the catch-up Roth only');
  const roth = fig(over.db, 'room.solo401k.rothCatchUp');
  assert.ok((roth.locator.assumptions || []).includes('roth_catch_up_unconfirmed'), `assumptions: ${roth.locator.assumptions}`);
  assert.equal(over.info.retireCatchUp, 'retirement.planOffersRoth');
  assert.equal(priorStep(over.db) && priorStep(over.db).value, 160000, 'the room names the W-2 box 3 amount');

  const under = await planned(cedarWages(140000, 160000));
  near(fig(under.db, 'room.solo401k.catchUp').v, 11250, 'box 3 140,000 keeps the catch-up pre-tax');
  assert.equal(figureRow(under.db, 'room.solo401k.rothCatchUp'), null, 'no Roth-only catch-up');
  assert.equal(priorStep(under.db) && priorStep(under.db).value, 140000, 'the room names the W-2 box 3 amount');
});

test('MG5: D4 liveness: with no prior-year W-2 the owner wage fact is used', async () => {
  const { db } = await planned(cedarOnly(15000, 40000, { 'household.birthYears': { owner: 1965 }, 'retirement.priorYearFicaWages': { owner: 140000 } }));
  near(fig(db, 'room.solo401k.catchUp').v, 11250, 'fact 140,000: pre-tax catch-up');
});

// ================================================================ D2, D3 (MG12, K2, K3): every householdTax path validates contributions
// Sources: IRC 404(a)(8)(C) and 62(a)(6) (the self-employed deduction is capped by earned income at
// the income being modeled); Pub 560 Deduction Worksheet for Self-Employed; IRC 404(a)(3)(A)(i) (an
// S corp's deduction is capped at 25% of the salary being modeled); IRC 1402(b)(1) and Schedule SE
// (W-2 Social Security wages use up the wage base, which changes the deductible half of SE tax); D3
// and R3-7 (an option or point built on invalid inputs is not a current choice, in any season).
//
// Path 1, current year. Wren Studio (projected 120,000, the spouse keeps Bluebird Studio), SEP:
//   step 3 111,522.27, 20% = 22,304.45. 23,000 > 22,304.45: over. 20,000: valid.
// Path 2a, a salary point with a sole proprietor SEP. Northwind S corp salary 60,000 (current, in the
//   50,000 to 110,000 range: points 50,000, 60,000, 65,000, 80,000, 95,000, 110,000); the owner also
//   runs Owl Works, 16,666.67 a month (projected 200,000.04); the SEP belongs to Owl Works.
//   SE earnings 200,000.04 x 0.9235 = 184,700.04; Medicare 5,356.30.
//   At 60,000 wages: Social Security (184,500 - 60,000) x 12.4% = 15,438.00; half 10,397.15;
//     step 3 189,602.89; 20% = 37,920.58 (reviewer 37,920.57 at exactly 200,000).
//   At 50,000 wages: Social Security 134,500 x 12.4% = 16,678.00; half 11,017.15; step 3 188,982.89;
//     20% = 37,796.58 (reviewer 37,796.57 at exactly 200,000).
//   37,850 is valid today and over at the 50,000 point; 37,000 is valid at every point (higher
//   salaries use more of the wage base, so the limit only rises).
// Path 2b, a salary point with an S corp employer contribution. Default household, Northwind salary
//   60,000: 25% = 15,000 today; at the 50,000 point 25% = 12,500. 14,000 is over there; 12,000 valid.
// Path 3, a deferral option. Wren Studio with 22,000 SEP: d100 (10,000 to January) gives profit
//   110,000, step 3 102,228.74, 20% = 20,445.75 (reviewer figure verified) < 22,000; d50 gives
//   115,000, 21,375.10 < 22,000. 20,000 is valid at every option.
// Path 4, next-year comparisons. Wren Studio, 20,000 SEP, plan.nextYearBusinessIncome 50,000 (same
//   contributions assumed next year under parameters_2026_proxy): SE earnings 46,175.00; Social
//   Security 5,725.70; Medicare 1,339.08; half 3,532.39; step 3 46,467.61; 20% = 9,293.52 (reviewer
//   figure verified) < 20,000. The d100 run (60,000) allows 11,152.23, also over. With next-year
//   income 110,000 every run allows at least 20,445.75: valid.

const OWL = Object.freeze({ name: 'Owl Works', type: 'sole_prop', owner: 'owner', income: 16666.67, expenses: {} });
const WREN = Object.freeze({ name: 'Wren Studio', type: 'sole_prop', owner: 'owner', income: 10000, expenses: {} });
const WREN_HOUSEHOLD = Object.freeze({
  entities: [WREN, SOLE_PROP],
  hints: { [`${INST.bank}|${MASKS.business}`]: { name: 'Business checking', kind: 'business', owner: null, entity: WREN.name } },
});
const OWL_HOUSEHOLD = Object.freeze({ entities: [SCORP, OWL, SOLE_PROP] });

// Each case: a game built from a valid aggregate (run 1), then the stated change (run 2) on `clock`.
// `item` is the point or option the over-limit run must refuse.
const PATHS = [
  {
    name: 'current year', game: 'deferral', item: 'd0', base: WREN_HOUSEHOLD,
    valid: { 'retirement.contributions': sepFact(20000) }, over: { 'retirement.contributions': sepFact(23000) }, currentBlocked: true,
  },
  {
    name: 'salary point, sole proprietor SEP', game: 'salary', item: 's50', base: OWL_HOUSEHOLD,
    valid: { 'retirement.contributions': sepFact(37000, OWL.name) }, over: { 'retirement.contributions': sepFact(37850, OWL.name) },
  },
  {
    name: 'salary point, S corp employer over 25%', game: 'salary', item: 's50', base: {},
    valid: { 'retirement.contributions': [ownPlan('employer', 12000)] }, over: { 'retirement.contributions': [ownPlan('employer', 14000)] },
  },
  {
    name: 'deferral option', game: 'deferral', item: 'd100', base: WREN_HOUSEHOLD,
    valid: { 'retirement.contributions': sepFact(20000) }, over: { 'retirement.contributions': sepFact(22000) },
  },
  {
    name: 'deferral option, game built in November and planned in January', game: 'deferral', item: 'd100', base: WREN_HOUSEHOLD,
    first: {}, valid: { 'retirement.contributions': sepFact(20000) }, over: { 'retirement.contributions': sepFact(22000) }, clock: JAN,
  },
  {
    name: 'next-year comparison', game: 'deferral', item: 'd0', base: withFacts(WREN_HOUSEHOLD, { 'retirement.contributions': sepFact(20000) }),
    valid: { 'plan.nextYearBusinessIncome': 110000 }, over: { 'plan.nextYearBusinessIncome': 50000 },
  },
];

const listOf = (g, game) => (game === 'salary' ? (g && g.points) || [] : (g && g.options) || []);
const itemReason = x => ['unavailable', 'blocked', 'invalid'].map(k => x && x[k]).find(nonEmpty) || null;
const pick = (db, clock, game, item) => wargamePick(api(db, clock, { name: game }, { index: item }));

// Run 1 builds the game from `first` (or the valid aggregate); run 2 applies `change` on the case clock.
async function twoRuns(c, change) {
  const db = await S.store({ variant: withFacts(c.base, c.first || c.valid) });
  await plan(db, NOW);
  const built = contentValue(db, 'wargame') || {};
  assert.ok(built[c.game], `${c.name}: precondition: the ${c.game} game is built in November`);
  assert.ok(listOf(built[c.game], c.game).some(x => x.id === c.item), `${c.name}: precondition: ${c.item} is offered`);
  for (const [k, v] of Object.entries(change)) addFact(db, k, v);
  const clock = c.clock || NOW;
  await plan(db, clock);
  return { db, clock, info: computeFor(db, clock).info };
}

// One test over the class; each path is a subtest so every failing path is reported.
test('MG12: D2 D3 every householdTax path blocks an over-limit contribution and the game or point says why', async t => {
  for (const c of PATHS) await t.test(c.name, async () => {
    const { db, clock, info } = await twoRuns(c, c.over);
    if (c.currentBlocked) {
      assert.ok(info.blocked.length > 0, `${c.name}: the current-year run reports blocked`);
      const proj = getScenario(api(db, clock)).fig['tax.fed.proj'];
      assert.ok(!proj || nonEmpty(proj.unavailable), `${c.name}: federal tax is absent or unavailable: ${JSON.stringify(proj)}`);
    }
    const scenario = getScenario(api(db, clock));
    const g = scenario.wargame && scenario.wargame[c.game];
    assert.ok(g, `${c.name}: the ${c.game} game is kept, at least as history`);
    if (g.status === 'unavailable') {
      assert.ok(nonEmpty(contentValue(db, 'wargame')[c.game].unavailable), `${c.name}: the unavailable game names its reason`);
    } else {
      const x = listOf(g, c.game).find(y => y.id === c.item);
      assert.ok(x, `${c.name}: ${c.item} is marked, not silently dropped: ${JSON.stringify(listOf(g, c.game).map(y => y.id))}`);
      assert.ok(itemReason(x), `${c.name}: ${c.item} is offered as a current choice with no reason: ${JSON.stringify(x)}`);
      if (c.game === 'deferral') assert.ok(!(x.tax2026 < 0), `${c.name}: ${c.item} claims a tax cut of ${x.tax2026}`);
    }
    assert.throws(() => pick(db, clock, c.game, c.item), e => e.status >= 400 && e.status < 500,
      `${c.name}: wargamePick refuses ${c.item}`);
  });
});

test('MG12: D2 D3 liveness: a valid aggregate publishes every path', async t => {
  for (const c of PATHS) await t.test(c.name, async () => {
    const { db, clock, info } = await twoRuns(c, c.valid);
    assert.deepEqual(info.blocked, [], `${c.name}: nothing blocks`);
    if (!c.clock) assert.equal((info.wargameInvalid || {})[c.game], undefined, `${c.name}: ${c.game} invalid: ${(info.wargameInvalid || {})[c.game]}`);
    assert.ok(fig(db, 'tax.fed.proj'), `${c.name}: federal tax published`);
    const g = getScenario(api(db, clock)).wargame[c.game];
    assert.ok(g, `${c.name}: the game is served`);
    assert.notEqual(g.status, 'unavailable', `${c.name}: the game is available`);
    for (const x of listOf(g, c.game)) assert.equal(itemReason(x), null, `${c.name}: ${x.id} is not marked`);
    const after = pick(db, clock, c.game, c.item);
    assert.ok(after && after.scenario, `${c.name}: wargamePick accepts ${c.item}`);
  });
});

// The reviewer's January case on its own, so the season gate failure is named directly.
test('MG12: D3 a November game with a 22,000 SEP added and planned in January refuses "Move it all to January"', async () => {
  const db = await S.store({ variant: WREN_HOUSEHOLD });
  await plan(db, NOW);
  const built = contentValue(db, 'wargame').deferral;
  assert.equal(built.options.find(o => o.id === 'd100').label, 'Move it all to January', 'precondition');
  addFact(db, 'retirement.contributions', sepFact(22000));
  await plan(db, JAN);
  const info = computeFor(db, JAN).info;
  const kept = contentValue(db, 'wargame').deferral;
  const d100 = kept.options.find(o => o.id === 'd100');
  assert.ok(nonEmpty(info.wargameInvalid.deferral) || nonEmpty(kept.unavailable) || itemReason(d100),
    `the retained game carries a reason: ${JSON.stringify({ invalid: info.wargameInvalid, unavailable: kept.unavailable, d100 })}`);
  assert.throws(() => pick(db, JAN, 'deferral', 'd100'), e => e.status >= 400 && e.status < 500, 'wargamePick refuses d100');
});

// ================================================================ D5 (MG13, K5): allowlist literal check
// K5: only strict full date forms (month name or abbreviation, day, optional comma and four-digit
// year), "tax year YYYY" and the D5 identifiers are masked; any other digit fails. A bare "in YYYY"
// is no longer allowed, so a sentence boundary or a currency word the old money-word list missed
// cannot let a year through.

const ALLOWED = { fig: { 'sh.fed.remaining': 15000 }, law: {}, pct: {}, names: {} };
const fieldsWith = summary => ({ summary, why: ['The figures behind this come from your data.'], qa: [] });
const D5_REJECTED = [
  'Pay in 2026 U.S. dollars.',
  'Pay USD in 2026.',
  'Send in 2026 euros.',
  'Owe in 2026 approx. dollars.',
];
const D5_ACCEPTED = [
  'On Jan 15, 2027, pay {f:sh.fed.remaining} dollars.',
  'File by Apr 15, 2027 for tax year 2026.',
];
const VALID = {
  summary: '{n:household} has a window to act on this.',
  why: ['The figures behind this come from your data.'],
  qa: [{ q: 'What should I do first?', a: ['Start with the first task on the list.'] }],
};

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

test('MG13: D5 a bare year next to a currency word fails the planner check', () => {
  for (const text of D5_REJECTED) {
    const res = checkProse(fieldsWith(text), ALLOWED);
    assert.equal(res.ok, false, `accepted: "${text}"`);
    assert.equal(res.reason, 'literal', `"${text}"`);
    assert.equal(checkProse({ ...VALID, qa: [{ q: 'How much?', a: [text] }] }, ALLOWED).ok, false, `accepted in a qa answer: "${text}"`);
  }
});

test('MG13: D5 liveness: full dates and tax year pass, even with a money word later in the sentence', () => {
  for (const text of D5_ACCEPTED) {
    const res = checkProse(fieldsWith(text), ALLOWED);
    assert.ok(res.ok, `rejected (${res.reason}): "${text}"`);
  }
});

test('MG13: D5 writeProse rejects each phrasing and falls back to the template', async () => {
  for (const text of D5_REJECTED) {
    const db = await S.store();
    const engine = scripted(() => JSON.stringify({ ...VALID, summary: text }));
    await plan(db, NOW, engine);
    assert.ok(engine.calls.length > 0, 'the engine was asked');
    for (const r of db.prepare('SELECT rec_id, prose_src FROM planner_recs WHERE retired_at IS NULL').all()) {
      assert.equal(r.prose_src, 'template', `"${text}": ${r.rec_id} kept model prose`);
    }
    assert.notEqual(recRow(db, 'fed-q4-estimate').def.summary, text);
  }
});

test('MG13: D5 liveness: writeProse accepts a full-date reply', async () => {
  const db = await S.store();
  const engine = scripted(() => JSON.stringify({ ...VALID, summary: 'File by Apr 15, 2027 for tax year 2026.' }));
  await plan(db, NOW, engine);
  assert.ok(engine.calls.length > 0, 'the engine was asked');
  assert.ok(db.prepare("SELECT count(*) AS n FROM planner_recs WHERE retired_at IS NULL AND prose_src = 'model'").get().n > 0, 'some rec keeps model prose');
});

test('MG13: D5 stored prose with each phrasing is not kept on the next run', async () => {
  const db = await S.store();
  await plan(db);
  const id = 'fed-q4-estimate';
  const template = recRow(db, id).def;
  for (const text of D5_REJECTED) {
    const def = parseJson(db.prepare('SELECT def FROM recs WHERE id = ?').get(id).def, {});
    def.summary = text;
    db.prepare('UPDATE recs SET def = ? WHERE id = ?').run(JSON.stringify(def), id);
    db.prepare("UPDATE planner_recs SET prose_src = 'model' WHERE rec_id = ?").run(id);
    const result = await plan(db);
    assert.equal(recRow(db, id).def.summary, template.summary, `"${text}": the template summary is back`);
    assert.equal(plannerRec(db, id).prose_src, 'template', `"${text}"`);
    assert.ok(result.counts.prose.template >= 1, `"${text}": the rec was rewritten, not kept`);
  }
});
