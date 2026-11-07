// Stream A tax-rule tests for the merge-gate fix round (MG3, MG4, MG5, MG6, MG9, MG10, MG11, MGN1).
// Each test cites its primary source and carries the hand calculation it checks. Every household,
// business, employer and amount here is synthetic. Store-level tests build fresh synthetic stores
// (test/helpers/real-store.mjs), run the planner once and read the written figures; `info` (blocked
// codes, confirm keys) is read by running computeFigures over the same store the way the planner
// does. Unit tests call householdTax and the worksheet directly where the plan names them.

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planRun } from '../helpers/plan.mjs';
import * as H from '../../src/jobs/planner/household.mjs';
import { computeFigures } from '../../src/jobs/planner/figures.mjs';
import { loadPlanningData, resolveEntities } from '../../src/jobs/planner/data.mjs';
import { deriveFacts, mergeFacts, ownerFactsOf } from '../../src/jobs/planner/facts.mjs';
import {
  scratch, addFact, w2Doc, accountIdByMask, figureRow, plannerFigures, contentValue, parseJson, SCORP, SOLE_PROP, MASKS,
} from '../helpers/real-store.mjs';

const NOW = '2026-11-05';
const S = scratch('fathom-tax-rules-');
after(() => S.cleanup());

const plan = (db, now = NOW) => planRun(db, { now });
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const near = (actual, expected, what) =>
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= 0.011, `${what}: expected ${expected}, got ${actual}`);
const fig = (db, key) => {
  const row = figureRow(db, key);
  assert.ok(row, `figure ${key} exists`);
  return row;
};
const absent = (db, key, why = '') => assert.equal(figureRow(db, key), null, `${key} is not produced${why ? `: ${why}` : ''}`);
const notesOf = row => (row && row.locator && Array.isArray(row.locator.notes) ? row.locator.notes : []);

// The planner's own path to computeFigures, for reading `info` off a store.
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

async function planned(variant = {}) {
  const db = await S.store({ variant });
  const result = await plan(db);
  return { db, result, info: computeFor(db).info };
}

// Readable notes the plan pins (MGN1, R2-5, MG10).
const NOTE = {
  magi: 'Adjusted gross income stands in for modified adjusted gross income.',
  vaExempt: 'Virginia personal exemptions are left out, so Virginia tax may be a little high.',
  nextYear: "Next year uses this year's brackets and limits, because next year's are not published yet.",
  nextFlat: "Next year's business income is assumed to match this year's.",
  planTerms: 'Assumes plan terms and eligibility are confirmed with your advisor.',
  noPriorLoss: 'Assumes no business loss carried over from last year.',
  projection: "Based on this year's projection; the real test uses the tax on the return you file.",
  priorFull: "Assumes last year's return covered a full year.",
  rothElect: "You can elect Roth for any of this; Roth contributions do not lower this year's tax.",
  rothConfirm: 'Catch-up room stays at zero until you confirm your plan offers Roth deferrals.',
  rothNone: 'Your plan has no Roth deferrals, so no catch-up is allowed once the Roth rule applies.',
};

// householdTax parts builders (shape documented at the top of household.mjs).
const wage = (person, amount) => ({ person, src: 'outside', gross: amount, agi: amount });
const corpBiz = (id, qbi, extra = {}) => ({ id, kind: 'scorp', person: 'owner', agi: qbi, qbi, seInput: null, w2Wages: 0, sstb: false, ...extra });
function parts({ f = 'mfj', persons, w2 = [], biz = [], children = 0, ...rest } = {}) {
  return {
    f, state: null, persons: persons || (f === 'mfj' ? ['owner', 'spouse'] : ['owner']), w2, biz,
    hsaPersonal: 0, itemized: 0, vaItemized: null, va529Deduction: 0, children, vaBlocked: null, ...rest,
  };
}

// ================================================================ MG3 child tax credit phase-out

// Source: IRC 24(a) and Rev. Proc. 2025-32 (2026 credit 2,200 per qualifying child); IRC 24(b)(1)
// (reduced by 50 for each 1,000 or fraction of 1,000 of MAGI over the threshold, not below zero);
// IRC 24(h)(3) (threshold 400,000 joint, 200,000 otherwise). MAGI is taken as AGI (no 911, 931 or
// 933 exclusions modeled).
describe('MG3 child tax credit phase-out', () => {
  test('MG3: one child at MFJ 401,000 keeps 2,150 of the credit', () => {
    // AGI 401,000; standard deduction 32,200; taxable 368,800 (no QBI).
    // Tax: 24,800 x 10% = 2,480; 76,000 x 12% = 9,120; 110,600 x 22% = 24,332;
    // 157,400 x 24% = 37,776; total 73,708.
    // Excess 1,000 is one step: 2,200 - 50 = 2,150.
    // Additional Medicare: (401,000 - 250,000) x 0.9% = 1,359.
    // fedTotal = 73,708 - 2,150 + 1,359 = 72,917 (head drops the whole credit: 75,067).
    const hh = H.householdTax(parts({ w2: [wage('owner', 401000)], children: 1 }));
    assert.equal(hh.taxable, 368800);
    assert.equal(hh.fedIncome, 73708);
    assert.equal(hh.ctc, 2150);
    assert.equal(hh.addlMedicare, 1359);
    assert.equal(hh.fedTotal, 72917);
    assert.equal(hh.blocked, null, 'a credit below income tax is not blocked');
    assert.ok(!hh.warnings.includes('ctc_phaseout_unsupported'));
  });

  test('MG3: a one-cent excess counts as a full step', () => {
    // 400,000.01 is 0.01 over: one step (fraction of 1,000), 2,200 - 50 = 2,150.
    // Exactly 400,000 is not over: the full 2,200.
    assert.equal(H.householdTax(parts({ w2: [wage('owner', 400000.01)], children: 1 })).ctc, 2150);
    assert.equal(H.householdTax(parts({ w2: [wage('owner', 400000)], children: 1 })).ctc, 2200);
  });

  test('MG3: two children at MFJ 441,000 keep 2,350', () => {
    // Tentative 2 x 2,200 = 4,400; excess 41,000 is 41 steps, 41 x 50 = 2,050; 4,400 - 2,050 = 2,350.
    const hh = H.householdTax(parts({ w2: [wage('owner', 441000)], children: 2 }));
    assert.equal(hh.ctc, 2350);
    assert.equal(hh.blocked, null);
  });

  test('MG3: a single filer at 210,500 with one child keeps 1,650', () => {
    // Threshold 200,000; excess 10,500 is 11 steps (10 plus a fraction), 11 x 50 = 550; 2,200 - 550 = 1,650.
    // Taxable 210,500 - 16,100 = 194,400; tax 1,240 + 4,560 + 12,166 + 88,700 x 24% (21,288) = 39,254,
    // above the credit, so nothing blocks.
    const hh = H.householdTax(parts({ f: 'single', w2: [wage('owner', 210500)], children: 1 }));
    assert.equal(hh.fedIncome, 39254);
    assert.equal(hh.ctc, 1650);
    assert.equal(hh.blocked, null);
  });

  test('MG3: the credit is zero, not negative, at MFJ 444,000 with one child', () => {
    // Excess 44,000 is 44 steps, 44 x 50 = 2,200; 2,200 - 2,200 = 0. At 460,000 it stays 0.
    assert.equal(H.householdTax(parts({ w2: [wage('owner', 444000)], children: 1 })).ctc, 0);
    assert.equal(H.householdTax(parts({ w2: [wage('owner', 460000)], children: 1 })).ctc, 0);
  });

  test('MG3: a credit above income tax blocks the household tax', () => {
    // MFJ wages 40,000: taxable 40,000 - 32,200 = 7,800; tax 780. Credit 2 x 2,200 = 4,400 > 780.
    // The refundable part (IRC 24(d), Schedule 8812) is not modeled, so the result is blocked.
    const hh = H.householdTax(parts({ w2: [wage('owner', 40000)], children: 2 }));
    assert.equal(hh.blocked, 'ctc_refundable_unsupported');
    // liveness: the same household at 401,000 (credit below tax) is not blocked (first MG3 test).
  });

  test('MG3: a household over the threshold publishes federal tax with the reduced credit', async () => {
    // Store-level: a spouse outside W-2 of 150,000 lifts AGI above 400,000. The credit step equals
    // 2,200 - 50 x ceil((agi.est - 400,000) / 1,000), floored at zero, and no figure carries the
    // retired ctc_phaseout_unsupported assumption.
    const { db, result } = await planned({
      payroll: [w2Doc({ employerName: 'Example Employer Inc', person: 'spouse', relation: 'outside', wages: 150000, medicareWages: 150000, box12: [] })],
    });
    const agi = fig(db, 'agi.est').v;
    assert.ok(agi > 400000, `agi.est ${agi} is over the threshold`);
    const expected = Math.max(0, 2200 - 50 * Math.ceil(Math.round((agi - 400000) * 100) / 100000));
    const proj = fig(db, 'tax.fed.proj');
    const step = proj.locator.steps.filter(s => s.label === 'Child tax credit').at(-1);
    assert.ok(step, 'the federal total names the child tax credit step');
    near(step.value, expected, 'child tax credit after phase-out');
    assert.ok(expected > 0, 'the variant keeps part of the credit');
    assert.ok(!result.warnings.includes('ctc_phaseout_unsupported'));
    for (const f of plannerFigures(db)) {
      assert.ok(!(f.locator.assumptions || []).includes('ctc_phaseout_unsupported'), `${f.key} carries no ctc_phaseout_unsupported`);
    }
  });

  test('MG3: a refundable-credit block does not inflate self-employed retirement room', () => {
    // Source: IRS Publication 560 chapter 5, Deduction Worksheet for Self-Employed steps 1 to 3
    // (compensation is net profit less the deductible half of SE tax); IRC 24(d) not modeled, so
    // the credit blocks household tax (R3-6).
    // SE on 10,000 single: earnings 10,000 x 0.9235 = 9,235.00; Social Security 9,235 x 12.4% =
    // 1,145.14; Medicare 9,235 x 2.9% = 267.82; deductible half (1,145.14 + 267.82) / 2 = 706.48.
    // Compensation 10,000 - 706.48 = 9,293.52. AGI 9,293.52; taxable 0; income tax 0 < credit 2,200.
    // Solo 401(k), age 45: employee min(24,500, 9,293.52) = 9,293.52; employer
    // min(...; (9,293.52 - 9,293.52) / 2) = 0; total 9,293.52. SEP 20% x 9,293.52 = 1,858.70.
    const line = { id: 1, entity: 'Wren Studio', period: '2026-12', category: 'Income', amount: 10000, file_id: null };
    const run = ages => computeFigures(
      { clock: '2026-12-20', year: 2026, taxYear: 2026, accounts: [], pnl: [line], taxPayments: [], documents: [], transactions: [], files: [], freshness: [] },
      { 'household.filingStatus': 'single', 'household.dependentAges': ages },
      {
        clock: '2026-12-20',
        entities: [{ name: 'Wren Studio', slug: 'wren-studio', type: 'sole_prop', owner: 'owner', classified: true, sstb: false, docId: null, fileId: null, lines: [line], months: 12 }],
        owner: { 'retirement.planTermsConfirmed': true, 'retirement.aggregationConfirmed': true, 'household.birthYears': { owner: 1981 } },
      },
    );
    const out = run([3]);
    assert.ok(out.info.blocked.includes('ctc_refundable_unsupported'), `blocked: ${out.info.blocked}`);
    assert.equal(out.figures['agi.est'], undefined, 'no agi.est while blocked');
    const solo = out.figures['room.solo401k'];
    assert.ok(solo, 'room.solo401k is still sized');
    near(solo.v, 9293.52, 'room.solo401k');
    near(solo.locator.inputs.compensation, 9293.52, 'compensation is net of the deductible half (the bug gives 10,000)');
    near(out.figures['room.solo401k.employee'].v, 9293.52, 'room.solo401k.employee');
    near(out.figures['room.solo401k.employer'].v, 0, 'room.solo401k.employer');
    near(out.figures['room.sep'].v, 1858.7, 'room.sep');
    // liveness: with no child the same household publishes its tax figures.
    const clear = run([]);
    assert.deepEqual(clear.info.blocked, []);
    near(clear.figures['agi.est'].v, 9293.52, 'agi.est without the credit');
    near(clear.figures['room.solo401k'].v, 9293.52, 'room.solo401k without the credit');
  });
});

// ================================================================ MG4 QBI netting

// Source: IRC 199A(b)(1), (b)(2), (c)(2), (d)(3), (i); Treas. Reg. 1.199A-1(c)(2)(i),
// 1.199A-1(d)(2) intro and (d)(2)(i) (SSTB exclusion first), (d)(2)(iii)(A) and Example 9 (negative
// QBI apportioned to positive businesses by their QBI before the per-business limits). 2026
// threshold 403,500 MFJ / 201,750 single, phase-in 150,000 / 75,000 (Rev. Proc. 2025-32 sec. 4.26).
describe('MG4 QBI netting', () => {
  const lossCase = (extra = {}) => parts({
    w2: [wage('owner', 200000)],
    biz: [corpBiz('a', 100000), corpBiz('b', -50000)],
    ...extra,
  });

  test('MG4: a 50,000 loss halves a 100,000 profit, so the deduction is 10,000', () => {
    // AGI 200,000 + 100,000 - 50,000 = 250,000; taxable before QBI 217,800 (below 403,500).
    // Net QBI 50,000; 20% = 10,000; cap 20% x 217,800 = 43,560; qbi 10,000.
    // Taxable 207,800; tax 2,480 + 9,120 + 107,000 x 22% (23,540) = 35,140; no Additional
    // Medicare (wages under 250,000); fedTotal 35,140. Head floors the loss: qbi 20,000, tax 32,940.
    const hh = H.householdTax(lossCase());
    assert.equal(hh.agi, 250000);
    assert.equal(hh.pre, 217800);
    assert.equal(hh.qbi, 10000);
    assert.equal(hh.taxable, 207800);
    assert.equal(hh.fedIncome, 35140);
    assert.equal(hh.fedTotal, 35140);
    assert.equal(hh.qbiCarryforward, 0);
  });

  test('MG4: a net QBI loss gives no deduction and reports the carryforward', () => {
    // A 30,000, B -50,000: net -20,000, so the QBI component is 0 and 20,000 carries forward
    // (199A(c)(2)).
    const hh = H.householdTax(parts({ w2: [wage('owner', 200000)], biz: [corpBiz('a', 30000), corpBiz('b', -50000)] }));
    assert.equal(hh.qbi, 0);
    assert.equal(hh.qbiCarryforward, 20000);
    assert.ok(hh.warnings.includes('qbi_loss_carryforward'));
  });

  test('MG4: above the threshold the loss is apportioned before the wage limit', () => {
    // AGI 400,000 + 300,000 + 100,000 - 100,000 = 700,000; taxable before QBI 667,800; fully
    // phased in ((667,800 - 403,500) / 150,000 > 1). B's wages are ignored (loss business).
    // A' = 300,000 - 100,000 x 300/400 = 225,000; C' = 100,000 - 100,000 x 100/400 = 75,000.
    // A: 20% = 45,000; wage limit max(50% x 100,000, 25% x 100,000) = 50,000; deduction 45,000.
    // C: no wages, limit 0, deduction 0. Sum 45,000; cap 133,560; qbi 45,000 (head: 50,000).
    const hh = H.householdTax(parts({
      w2: [wage('owner', 400000)],
      biz: [corpBiz('a', 300000, { w2Wages: 100000 }), corpBiz('c', 100000), corpBiz('b', -100000, { w2Wages: 80000 })],
    }));
    assert.equal(hh.pre, 667800);
    assert.equal(hh.qbi, 45000);
  });

  test('MG4: the 400 minimum applies once to aggregate active QBI', () => {
    // Single; wages 15,000; A 1,500 and B 1,500. AGI 18,000; taxable before QBI 18,000 - 16,100 =
    // 1,900. 20% x 3,000 = 600; cap 20% x 1,900 = 380; aggregate 3,000 >= 1,000, so the deduction
    // is max(380, 400) = 400 (199A(i), once per return); taxable 1,500. Head applies the floor per
    // business then caps the sum: 380.
    const hh = H.householdTax(parts({ f: 'single', w2: [wage('owner', 15000)], biz: [corpBiz('a', 1500), corpBiz('b', 1500)] }));
    assert.equal(hh.pre, 1900);
    assert.equal(hh.qbi, 400);
    assert.equal(hh.taxable, 1500);
  });

  test('MG4: a prior-year QBI loss carryforward reduces this year\'s QBI', () => {
    // First case plus a 20,000 carryforward treated as one more loss business:
    // 100,000 - 50,000 - 20,000 = 30,000; 20% = 6,000.
    const hh = H.householdTax(lossCase({ qbiLossCarryforward: 20000 }));
    assert.equal(hh.qbi, 6000);
    assert.equal(hh.taxable, 211800);
  });

  test('MG4: above the phase-in an SSTB loss is excluded before netting, so 100,000 non-SSTB profit keeps a 20,000 deduction', () => {
    // AGI 600,000 + 100,000 - 50,000 = 650,000; taxable before QBI 617,800; phase
    // min(1, 214,300 / 150,000) = 1, so SSTB B's applicable percentage is 0 and it nets nothing.
    // A: 20% x 100,000 = 20,000; wage limit 50% x 100,000 = 50,000; deduction 20,000. Cap 123,560.
    // Taxable 597,800; tax 2,480 + 9,120 + 24,332 + 46,116 + 34,848 + 85,350 x 35% (29,872.50) =
    // 146,768.50; Additional Medicare (600,000 - 250,000) x 0.9% = 3,150; fedTotal 149,918.50.
    // Netting first would give 10,000.
    const hh = H.householdTax(parts({
      w2: [wage('owner', 600000)],
      biz: [corpBiz('a', 100000, { w2Wages: 100000 }), corpBiz('b', -50000, { sstb: true })],
    }));
    assert.equal(hh.pre, 617800);
    assert.equal(hh.qbi, 20000);
    assert.equal(hh.taxable, 597800);
    assert.equal(hh.fedIncome, 146768.5);
    assert.equal(hh.fedTotal, 149918.5);
  });

  test('MG4: inside the phase-in the SSTB share is reduced before a loss nets against it', () => {
    // AGI 430,700 + 100,000 - 20,000 = 510,700; taxable before QBI 478,500; phase
    // (478,500 - 403,500) / 150,000 = 0.5. SSTB A counts 50% x 100,000 = 50,000; B -20,000; net
    // 30,000. Tentative 6,000; wage limit 0; phased 6,000 - 6,000 x 0.5 = 3,000; cap 95,700;
    // qbi 3,000. Netting first (80,000 x 50% x 20% = 8,000, phased to 4,000) would give 4,000.
    const hh = H.householdTax(parts({
      w2: [wage('owner', 430700)],
      biz: [corpBiz('a', 100000, { sstb: true }), corpBiz('b', -20000)],
    }));
    assert.equal(hh.pre, 478500);
    assert.equal(hh.qbi, 3000);
  });

  test('MG4: the 400 minimum is not granted when all QBI comes from an excluded SSTB', () => {
    // Single; wages 400,000; SSTB A 5,000. AGI 405,000; taxable before QBI 388,900 >
    // 201,750 + 75,000 = 276,750, so A's applicable percentage is 0; qualified total 0; qbi 0.
    // (Guards against the round 1 design, which tested the raw total and gave 400.)
    const hh = H.householdTax(parts({ f: 'single', w2: [wage('owner', 400000)], biz: [corpBiz('a', 5000, { sstb: true })] }));
    assert.equal(hh.pre, 388900);
    assert.equal(hh.qbi, 0);
  });

  test('MG4: an owner prior-year QBI loss carryforward fact lowers tax.fed.qbi and replaces the no-prior-loss note', async () => {
    // Driver decision D2. Default store: QBI Northwind 171,810 and Bluebird 66,000 - 4,662.75 =
    // 61,337.25, both below the threshold; deduction 46,629.45 against a cap of 20% x 257,947.25 =
    // 51,589.45. A 10,000 carryforward nets to 223,147.25, a deduction 2,000 lower (44,629.45),
    // still under the unchanged cap. agi.est is unchanged.
    const base = await planned();
    const carried = await planned({ facts: { 'tax.prior.qbiLossCarryforward': 10000 } });
    near(r2(fig(base.db, 'tax.fed.qbi').v - fig(carried.db, 'tax.fed.qbi').v), 2000, 'tax.fed.qbi drop');
    near(fig(carried.db, 'agi.est').v, fig(base.db, 'agi.est').v, 'agi.est unchanged');
    assert.ok(notesOf(fig(base.db, 'tax.fed.qbi')).includes(NOTE.noPriorLoss), 'without the fact the QBI figure says no carryforward was applied');
    assert.ok(!notesOf(fig(carried.db, 'tax.fed.qbi')).includes(NOTE.noPriorLoss), 'with the fact the note is gone');
  });
});

// ================================================================ MG5 self-employed retirement deduction

// Source: IRC 62(a)(6) and 404 (a self-employed individual deducts plan contributions above the
// line); IRC 404(a)(8); Treas. Reg. 1.199A-3(b)(1)(vi) (the deduction reduces that business's QBI);
// IRC 402(e)(3) (S corp deferrals are excluded from box 1, never deducted again); IRS Publication
// 560 chapter 5, Deduction Worksheet for Self-Employed; IRC 402(g)(1), 414(v)(2)(A), 414(v)(3)(A),
// 415(c)(1); Notice 2025-67 (402(g) 24,500, 415(c) 72,000, 401(a)(17) 360,000, catch-up 8,000).
const JUNIPER = Object.freeze({ name: 'Juniper Works', type: 'sole_prop', owner: 'owner', income: 5000, expenses: {} });
const MIXED = Object.freeze({ entities: [SCORP, SOLE_PROP, JUNIPER] });
const MIXEDDOC = Object.freeze({
  ...MIXED,
  payroll: [w2Doc({ employerName: SCORP.name, person: 'owner', wages: 55000, medicareWages: 60000, box12: [{ code: 'D', amount: 5000 }] })],
});
const withContribs = (variant, list, facts = {}) => ({ ...variant, facts: { ...(variant.facts || {}), ...facts, 'retirement.contributions': list } });
const wagesLine = (db, person) => fig(db, 'agi.est').locator.parts.wages.find(w => w.person === person && w.source === 'own S corp');
const bizLine = (db, id) => fig(db, 'agi.est').locator.parts.businesses.find(b => b.id === id);

describe('MG5 self-employed retirement deduction', () => {
  test('MG5: a 10,000 SEP contribution lowers AGI and QBI for a sole proprietor', () => {
    // MFJ; spouse wages 150,000; owner sole prop 100,000 with a 10,000 SEP in its plan aggregate.
    // Worksheet (Pub 560): step 3 100,000 - 7,064.78 = 92,935.22; 20% = 18,587.04 >= 10,000, valid.
    // SE: 100,000 x 0.9235 = 92,350; Social Security 11,451.40; Medicare 2,678.15; total 14,129.55;
    // deductible half 7,064.78; no Additional Medicare (92,350 + 150,000 < 250,000).
    // AGI = 250,000 - 7,064.78 - 10,000 = 232,935.22; taxable before QBI 200,735.22.
    // QBI = 100,000 - 7,064.78 - 10,000 = 82,935.22; 20% = 16,587.04; cap 40,147.04.
    // Taxable 184,148.18; tax 2,480 + 9,120 + 83,348.18 x 22% (18,336.60) = 29,936.60.
    // fedTotal 29,936.60 + 14,129.55 = 44,066.15. (Ignoring the SEP: AGI 242,935.22, qbi 18,587.04,
    // tax 31,696.60.)
    const hh = H.householdTax(parts({
      w2: [wage('spouse', 150000)],
      biz: [{ id: 'sole', kind: 'sole', person: 'owner', agi: 100000, qbi: 100000, seInput: 100000, w2Wages: 0, sstb: false }],
      retirement: { owner: { byPlan: { sole: { sep: 10000 } }, allRegular: 0, allCatchUp: 0, outsideKnown: true, catchUpLimit: 0 } },
    }));
    assert.equal(hh.seTotal, 14129.55);
    assert.equal(hh.agi, 232935.22);
    assert.equal(hh.pre, 200735.22);
    assert.equal(hh.qbi, 16587.04);
    assert.equal(hh.taxable, 184148.18);
    assert.equal(hh.fedIncome, 29936.6);
    assert.equal(hh.fedTotal, 44066.15);
  });

  test('MG5: a spouse SEP contribution lowers agi.est by its amount and the QBI deduction by a fifth', async () => {
    // Bluebird Studio is the spouse's only business, so the SEP is attributed to it. Worksheet:
    // 0.20 x (66,000 - 4,662.75) = 12,267.45 >= 5,000, valid. AGI falls 5,000; Bluebird QBI falls
    // 5,000, so the deduction falls 1,000 while the 20%-of-taxable cap (also down 1,000) does not bind.
    const base = await planned();
    const sep = await planned(withContribs({}, [{ person: 'spouse', plan: 'sep', type: 'employer', roth: false, amount: 5000 }]));
    const q0 = fig(base.db, 'tax.fed.qbi').v;
    const pre0 = r2(fig(base.db, 'tax.fed.taxable').v + q0);
    assert.ok(q0 < 0.2 * pre0 - 1000, `precondition: the cap does not bind (qbi ${q0}, cap ${0.2 * pre0})`);
    near(r2(fig(base.db, 'agi.est').v - fig(sep.db, 'agi.est').v), 5000, 'agi.est drop');
    near(r2(q0 - fig(sep.db, 'tax.fed.qbi').v), 1000, 'tax.fed.qbi drop');
    assert.deepEqual(sep.info.blocked, [], 'a valid SEP does not block');
  });

  test('MG5: an S corp owner\'s employer contribution is never deducted again', async () => {
    // The owner's only business is the S corp: its employer contribution is a corporate deduction
    // already in the P and L net, so the 1040 takes nothing. A P and L line of 1,000 a month lowers
    // the K-1 by 12,000 projected, once.
    const fact = [{ person: 'owner', plan: 'own-corp-401k', type: 'employer', amount: 10000 }];
    const pnlExtra = [{ entity: SCORP.name, category: 'Retirement contribution', monthly: 1000 }];
    const base = await planned();
    const withFact = await planned(withContribs({}, fact));
    const withLine = await planned({ pnlExtra });
    const withBoth = await planned(withContribs({ pnlExtra }, fact));
    near(fig(withFact.db, 'agi.est').v, fig(base.db, 'agi.est').v, 'the fact alone leaves agi.est unchanged');
    near(r2(fig(base.db, 'agi.est').v - fig(withLine.db, 'agi.est').v), 12000, 'the P and L line lowers agi.est through the K-1');
    near(fig(withBoth.db, 'agi.est').v, fig(withLine.db, 'agi.est').v, 'not a second time');
  });

  test('MG5: a contribution over the plan limit blocks household tax', async () => {
    // Spouse SEP 50,000 > 0.20 x 61,337.25 = 12,267.45 (worksheet item 1).
    const over = await planned(withContribs({}, [{ person: 'spouse', plan: 'sep', type: 'employer', amount: 50000 }]));
    assert.ok(over.info.blocked.includes('retirement_contribution_over_limit'), `blocked: ${over.info.blocked}`);
    absent(over.db, 'agi.est');
    absent(over.db, 'tax.fed.proj');
    // liveness: a 5,000 SEP for the same spouse publishes (previous test).
  });

  test('MG5: an unattributed contribution for a person with two businesses blocks', async () => {
    const wren = { name: 'Wren Studio', type: 'sole_prop', owner: 'spouse', income: 1000, expenses: {} };
    const entities = [SCORP, SOLE_PROP, wren];
    const loose = await planned(withContribs({ entities }, [{ person: 'spouse', plan: 'sep', type: 'employer', amount: 1000 }]));
    assert.ok(loose.info.blocked.includes('retirement_contribution_unattributed'), `blocked: ${loose.info.blocked}`);
    absent(loose.db, 'agi.est');
    // liveness: naming the sponsor publishes.
    const named = await planned(withContribs({ entities }, [{ person: 'spouse', plan: 'sep', type: 'employer', amount: 1000, entity: SOLE_PROP.slug }]));
    assert.deepEqual(named.info.blocked, []);
    assert.ok(figureRow(named.db, 'agi.est'), 'agi.est with the sponsor named');
  });

  test('MG5: a 10,000 deferral attributed to the owner\'s sole prop lowers AGI by exactly 10,000', async () => {
    // MIXED: the owner has Northwind (S corp, salary 60,000) and Juniper (sole prop, 60,000).
    // Juniper worksheet: D 10,000 <= s3 (about 55,761); D + other 0 <= 24,500. Deduction 10,000 on
    // the 1040; the Northwind wage line is untouched.
    const base = await planned(MIXED);
    const def = await planned(withContribs(MIXED, [{ person: 'owner', plan: 'own-corp-401k', type: 'deferral', roth: false, amount: 10000, entity: 'juniper-works' }]));
    near(r2(fig(base.db, 'agi.est').v - fig(def.db, 'agi.est').v), 10000, 'agi.est drop');
    near(wagesLine(def.db, 'owner').agi, wagesLine(base.db, 'owner').agi, 'Northwind wage line unchanged');
    near(bizLine(def.db, 'juniper-works').retire, 10000, 'Juniper retire');
  });

  test('MG5: the same deferral attributed to the S corp lowers AGI by exactly 10,000 through wages', async () => {
    const base = await planned(MIXED);
    const def = await planned(withContribs(MIXED, [{ person: 'owner', plan: 'own-corp-401k', type: 'deferral', roth: false, amount: 10000, entity: SCORP.slug }]));
    near(r2(fig(base.db, 'agi.est').v - fig(def.db, 'agi.est').v), 10000, 'agi.est drop');
    near(r2(wagesLine(base.db, 'owner').agi - wagesLine(def.db, 'owner').agi), 10000, 'Northwind box 1 wages drop');
    near(bizLine(def.db, 'juniper-works').retire || 0, 0, 'Juniper retire');
  });

  test('MG5: an own-plan deferral with no entity for a person with two businesses blocks', async () => {
    const loose = await planned(withContribs(MIXED, [{ person: 'owner', plan: 'own-corp-401k', type: 'deferral', roth: false, amount: 10000 }]));
    assert.ok(loose.info.blocked.includes('retirement_contribution_unattributed'), `blocked: ${loose.info.blocked}`);
    absent(loose.db, 'agi.est');
  });

  test('MG5: an S corp W-2 deferral does not hide a sole prop deferral', async () => {
    // MIXEDDOC: Northwind W-2 box 1 55,000 with a 5,000 deferral; gross stays the projected P and L
    // salary 60,000 and its pretax 5,000 in both stores. The Juniper deferral of 10,000 lowers AGI by
    // exactly 10,000. Sized plan is Northwind: allPlanDeferrals 5,000 + 10,000 = 15,000,
    // thisPlanDeferrals 5,000. Juniper: regular 15,000 <= 24,500, valid.
    const base = await planned(MIXEDDOC);
    const def = await planned(withContribs(MIXEDDOC, [{ person: 'owner', plan: 'own-corp-401k', type: 'deferral', roth: false, amount: 10000, entity: 'juniper-works' }]));
    near(r2(fig(base.db, 'agi.est').v - fig(def.db, 'agi.est').v), 10000, 'agi.est drop');
    for (const db of [base.db, def.db]) {
      const w = wagesLine(db, 'owner');
      near(w.gross, 60000, 'Northwind gross');
      near(w.agi, 55000, 'Northwind box 1 after the 5,000 document deferral');
    }
    const inputs = fig(def.db, 'room.solo401k').locator.inputs;
    near(inputs.allPlanDeferrals, 15000, 'allPlanDeferrals');
    near(inputs.thisPlanDeferrals, 5000, 'thisPlanDeferrals');
  });

  test('MG5: a fact for a corp whose W-2 already carries the deferral is skipped', async () => {
    // The Northwind W-2 carries the deferral type, so a Northwind deferral fact is covered by the
    // document: agi.est unchanged, allPlanDeferrals stays 5,000.
    const base = await planned(MIXEDDOC);
    const def = await planned(withContribs(MIXEDDOC, [{ person: 'owner', plan: 'own-corp-401k', type: 'deferral', roth: false, amount: 3000, entity: SCORP.slug }]));
    near(fig(def.db, 'agi.est').v, fig(base.db, 'agi.est').v, 'agi.est unchanged');
    near(fig(def.db, 'room.solo401k').locator.inputs.allPlanDeferrals, 5000, 'allPlanDeferrals');
  });

  test('MG5: an outside-plan fact without an employer is unknown when outside documents exist', async () => {
    // Owner outside W-2 with a 6,000 deferral plus an outside-plan fact naming no employer: which
    // plan it belongs to is unknown, so the owner is asked once and no solo room is sized. With the
    // employer named the document wins: allPlanDeferrals 6,000 (counted once), employee room
    // 24,500 - 6,000 = 18,500 on the 60,000 Northwind salary.
    const doc = w2Doc({ employerName: 'Example Employer Inc', person: 'owner', relation: 'outside', wages: 90000, medicareWages: 96000, box12: [{ code: 'D', amount: 6000 }] });
    const loose = await planned(withContribs({ payroll: [doc] }, [{ person: 'owner', plan: 'outside-401k', type: 'deferral', amount: 6000 }]));
    assert.ok((loose.info.confirm.retirement || []).includes('retirement.otherPlanDeferrals'), `confirm: ${JSON.stringify(loose.info.confirm)}`);
    for (const k of ['room.solo401k', 'room.solo401k.employee', 'room.solo401k.employer', 'room.solo401k.pretax']) absent(loose.db, k);
    const named = await planned(withContribs({ payroll: [doc] }, [{ person: 'owner', plan: 'outside-401k', type: 'deferral', amount: 6000, employer: 'Example Employer Inc' }]));
    near(fig(named.db, 'room.solo401k').locator.inputs.allPlanDeferrals, 6000, 'allPlanDeferrals');
    near(fig(named.db, 'room.solo401k.employee').v, 18500, 'room.solo401k.employee');
  });

  test('MG5: unknown outside-plan deferrals block the SE deduction and ask for them', async () => {
    // Spouse outside W-2 with no deferral field plus a 5,000 deferral to the spouse's sole prop
    // plan: the 402(g) test needs the outside deferrals, so household tax blocks. Supplying them as
    // zero unblocks, and agi.est is 5,000 lower than the same store without the deferral fact.
    const doc = w2Doc({ employerName: 'Example Employer Inc', person: 'spouse', relation: 'outside', wages: 50000, medicareWages: 50000 });
    const deferral = [{ person: 'spouse', plan: 'own-corp-401k', type: 'deferral', amount: 5000, entity: SOLE_PROP.slug }];
    const unknown = await planned(withContribs({ payroll: [doc] }, deferral));
    assert.ok(unknown.info.blocked.includes('retirement_other_deferrals_missing'), `blocked: ${unknown.info.blocked}`);
    assert.ok((unknown.info.confirm.retirement || []).includes('retirement.otherPlanDeferrals'), 'asks for the outside deferrals');
    absent(unknown.db, 'agi.est');
    const known = { 'retirement.otherPlanDeferrals': { spouse: { deferral: 0, catchUp: 0 } } };
    const without = await planned({ payroll: [doc], facts: known });
    const withDeferral = await planned(withContribs({ payroll: [doc] }, deferral, known));
    assert.deepEqual(withDeferral.info.blocked, []);
    near(r2(fig(without.db, 'agi.est').v - fig(withDeferral.db, 'agi.est').v), 5000, 'agi.est drop once known');
  });

  test('MG5: IRA room compensation is net of the SE retirement deduction', async () => {
    // Single owner, sole prop Wren Studio 800 a month (projected 9,600), no child (keeps the credit
    // block out of the way). SE on 9,600 single: earnings 8,865.60; Social Security 1,099.33;
    // Medicare 257.10; deductible half 678.21. Step 3 = 8,921.79; SEP max 20% = 1,784.36 >= 1,700,
    // valid. IRA compensation = 8,921.79 - 1,700 = 7,221.79 < 7,500 (IRC 219(b)(1), 219(f)(1) with
    // 401(c)(2)): room.ira.owner 7,221.79. Without the SEP: min(7,500, 8,921.79) = 7,500.
    const variant = {
      entities: [{ name: 'Wren Studio', type: 'sole_prop', owner: 'owner', income: 800, expenses: {} }],
      facts: { 'household.filingStatus': 'single', 'household.dependentAges': [] },
    };
    const base = await planned(variant);
    const sep = await planned(withContribs(variant, [{ person: 'owner', plan: 'sep', type: 'employer', amount: 1700 }]));
    assert.equal(fig(base.db, 'room.ira.owner').v, 7500);
    const room = fig(sep.db, 'room.ira.owner');
    near(room.v, 7221.79, 'room.ira.owner');
    near(room.locator.inputs.compensation.owner, 7221.79, 'IRA compensation');
  });

  describe('Publication 560 worksheet', () => {
    // seRetirementWorksheet({netProfit, seDeduction, employer, deferral, catchUp, roth, otherDeferrals,
    // otherCatchUp, catchUpLimit}); step 3 = netProfit - seDeduction. Valid -> {deduction, steps};
    // invalid -> {over: true}. Items 1 to 6 of Revision 3 section R3-2.
    const ws = input => {
      assert.equal(typeof H.seRetirementWorksheet, 'function', 'household.mjs exports seRetirementWorksheet');
      return H.seRetirementWorksheet({ employer: 0, deferral: 0, catchUp: 0, roth: 0, otherDeferrals: 0, otherCatchUp: 0, catchUpLimit: 0, ...input });
    };
    const s3of = s3 => ({ netProfit: s3 + 800, seDeduction: 800 });

    test('MG5: the reviewer\'s mix with outside deferrals and a catch-up is valid and fully deductible', () => {
      // s3 10,000; E 0; D 8,000; K 2,000; OD 16,500; OK 0; age 55 (limit 8,000).
      // 1: 0 <= min(2,000, 90,000). 2: 0 <= 64,000 and 0 <= (10,000 - 8,000) / 2 = 1,000.
      // 3: 8,000 <= 10,000. 4: 2,000 <= 10,000 - 0 - 8,000 = 2,000. 5: 8,000 + 16,500 = 24,500 <=
      // 24,500; 2,000 <= 8,000. Deduction 10,000. Cross-check: step 7 2,000; 10 64,000; 11 2,000;
      // 12 1,000; 13 1,000; 14 9,000; 15 8,000; 16 1,000; 18 1,000; 19 = 21 = 10,000 >= 10,000.
      const r = ws({ ...s3of(10000), deferral: 8000, catchUp: 2000, otherDeferrals: 16500, catchUpLimit: 8000 });
      assert.notEqual(r.over, true);
      assert.equal(r.deduction, 10000);
    });

    test('MG5: 10,000 compensation with a 2,000 employer contribution and no deferral is valid', () => {
      // Step 5 = 20% x 10,000 = 2,000; step 6 = 360,000 x 25% = 90,000; step 7 = 2,000; step 21 =
      // min(2,000, 72,000) = 2,000. Deduction 2,000.
      const r = ws({ ...s3of(10000), employer: 2000 });
      assert.notEqual(r.over, true);
      assert.equal(r.deduction, 2000);
    });

    test('MG5: a 2,000 employer contribution with an 8,000 deferral is over the limit', () => {
      // Item 2: 2,000 > (10,000 - 8,000) / 2 = 1,000.
      assert.equal(ws({ ...s3of(10000), employer: 2000, deferral: 8000 }).over, true);
    });

    test('MG5: a catch-up beyond compensation left after funding is over the limit', () => {
      // First worksheet case with K 2,500: item 4, 2,500 > 10,000 - 0 - 8,000 = 2,000.
      assert.equal(ws({ ...s3of(10000), deferral: 8000, catchUp: 2500, otherDeferrals: 16500, catchUpLimit: 8000 }).over, true);
    });

    test('MG5: regular deferrals over 402(g) across plans are over the limit', () => {
      // s3 50,000; D 20,000 + OD 10,000 = 30,000 > 24,500.
      assert.equal(ws({ ...s3of(50000), deferral: 20000, otherDeferrals: 10000 }).over, true);
      // liveness: 20,000 + 4,500 = 24,500 fits.
      const ok = ws({ ...s3of(50000), deferral: 20000, otherDeferrals: 4500 });
      assert.notEqual(ok.over, true);
      assert.equal(ok.deduction, 20000);
    });

    test('MG5: Roth deferrals count toward the limits but are not deducted', () => {
      // s3 50,000; E 5,000; D 24,500. Item 1: 5,000 <= min(10,000, 90,000). Item 2: 5,000 <= 47,500
      // and 5,000 <= (50,000 - 24,500) / 2 = 12,750. Item 3: 24,500 <= 45,000. Item 5: 24,500 <=
      // 24,500. Worksheet step 21 (deferrals pre-tax) = 10,000 + 24,500 = 34,500 >= 29,500, so the
      // pre-tax mix deducts 29,500; all-Roth D gives step 21 = 34,500 - 24,500 = 10,000 >= 5,000 and
      // deducts only the employer 5,000.
      const pre = ws({ ...s3of(50000), employer: 5000, deferral: 24500 });
      assert.notEqual(pre.over, true);
      assert.equal(pre.deduction, 29500);
      const roth = ws({ ...s3of(50000), employer: 5000, deferral: 24500, roth: 24500 });
      assert.notEqual(roth.over, true);
      assert.equal(roth.deduction, 5000);
    });
  });
});

// ================================================================ MG6 Roth catch-up

// Source: IRC 414(v)(7)(A) (SECURE 2.0 section 603); Notice 2025-67 (2025 FICA wage threshold
// 150,000 for 2026 catch-ups; catch-up 8,000, 11,250 at ages 60 to 63); T.D. 10033 (prior-year
// W-2 box 3 wages from the sponsoring employer; no FICA wages from the sponsor means not subject);
// Treas. Reg. 1.414(v)-2(b)(2) (no Roth program means zero catch-up for an affected participant);
// IRC 402A(a) (Roth dollars are not excluded from income); IRC 415(c)(1); IRC 402(g)(1).
//
// CORP61: Cedar Advisory S corp, income 40,000 and officer salary 15,000 a month for ten months,
// projected salary 150,000 x 12 / 10 = 180,000; owner age 61.
// solo401kRoom(180,000, w2, 61): employee min(24,500, 72,000, 180,000) = 24,500; catch-up
// min(11,250, 180,000 - 24,500) = 11,250; employer min(25% x 180,000 = 45,000, 72,000 - 24,500 =
// 47,500, 180,000 - 24,500 - 11,250) = 45,000; total 80,750.
const CEDAR = 'Cedar Advisory';
const corp61 = (extra = {}) => ({
  ...extra,
  entities: [{ name: CEDAR, type: 's_corp', owner: 'owner', income: 40000, expenses: { 'Officer salary': 15000, 'Payroll taxes': 1147.5 } }, SOLE_PROP],
  facts: { 'household.birthYears': { owner: 1965 }, ...(extra.facts || {}) },
});
const box3 = (employer, ss, wages = 140000) => w2Doc({ taxYear: 2025, employerName: employer, person: 'owner', wages, socialSecurityWages: ss });
const ROOM_KEYS = ['room.solo401k', 'room.solo401k.employee', 'room.solo401k.employer', 'room.solo401k.catchUp', 'room.solo401k.rothCatchUp', 'room.solo401k.pretax'];

describe('MG6 Roth catch-up', () => {
  test('MG6: an affected participant whose plan offers Roth gets Roth-only catch-up room', async () => {
    // Box 3 160,000 > 150,000: the 11,250 catch-up must be Roth. Pre-tax room 24,500 + 45,000 =
    // 69,500; total 69,500 + 11,250 = 80,750.
    const { db } = await planned(corp61({ payroll: [box3(CEDAR, 160000)], facts: { 'retirement.planOffersRoth': true } }));
    assert.equal(fig(db, 'room.solo401k.employee').v, 24500);
    assert.equal(fig(db, 'room.solo401k.employer').v, 45000);
    assert.equal(fig(db, 'room.solo401k.rothCatchUp').v, 11250);
    absent(db, 'room.solo401k.catchUp', 'the catch-up is Roth only');
    assert.equal(fig(db, 'room.solo401k.pretax').v, 69500);
    assert.equal(fig(db, 'room.solo401k').v, 80750);
    for (const k of ['room.solo401k.employee', 'room.solo401k.pretax']) assert.ok(notesOf(fig(db, k)).includes(NOTE.rothElect), `${k} says Roth does not lower tax`);
  });

  test('MG6: an affected participant without a confirmed Roth feature has zero catch-up with a reason', async () => {
    // Sized with catch-up disabled: employee 24,500; catch-up 0; employer min(45,000, 47,500,
    // 180,000 - 24,500) = 45,000. rothCatchUp 0; pre-tax and total 69,500.
    const unconfirmed = await planned(corp61({ payroll: [box3(CEDAR, 160000)] }));
    const roth = fig(unconfirmed.db, 'room.solo401k.rothCatchUp');
    assert.equal(roth.v, 0);
    assert.ok(notesOf(roth).includes(NOTE.rothConfirm), 'the zero names the missing confirmation');
    assert.equal(fig(unconfirmed.db, 'room.solo401k.pretax').v, 69500);
    assert.equal(fig(unconfirmed.db, 'room.solo401k').v, 69500);
    assert.equal(fig(unconfirmed.db, 'room.solo401k.employer').v, 45000);
    absent(unconfirmed.db, 'room.solo401k.catchUp');
    assert.equal(unconfirmed.info.retireCatchUp, 'retirement.planOffersRoth');

    const none = await planned(corp61({ payroll: [box3(CEDAR, 160000)], facts: { 'retirement.planOffersRoth': false } }));
    const rothNone = fig(none.db, 'room.solo401k.rothCatchUp');
    assert.equal(rothNone.v, 0);
    assert.ok(notesOf(rothNone).includes(NOTE.rothNone), 'the zero names the plan without Roth');
    assert.equal(fig(none.db, 'room.solo401k').v, 69500);
    assert.equal(none.info.retireCatchUp, undefined, 'nothing left to ask');
  });

  test('MG6: exactly 150,000 is not affected', async () => {
    // "Exceeded" is strictly greater: 150,000 is not over, so the 11,250 catch-up may be pre-tax.
    const { db, info } = await planned(corp61({ payroll: [box3(CEDAR, 150000)] }));
    assert.equal(fig(db, 'room.solo401k.employee').v, 24500);
    assert.equal(fig(db, 'room.solo401k.catchUp').v, 11250);
    absent(db, 'room.solo401k.rothCatchUp');
    assert.equal(fig(db, 'room.solo401k.pretax').v, 80750);
    assert.equal(fig(db, 'room.solo401k').v, 80750);
    assert.equal(info.retireCatchUp, undefined);
  });

  test('MG6: unknown prior-year wages withhold the catch-up figures', async () => {
    // No 2025 W-2 and no fact: regular employee and employer room still show; total, catch-up,
    // Roth catch-up and pre-tax wait for last year's box 3 wages.
    const { db, info } = await planned(corp61());
    assert.equal(fig(db, 'room.solo401k.employee').v, 24500);
    assert.equal(fig(db, 'room.solo401k.employer').v, 45000);
    for (const k of ['room.solo401k', 'room.solo401k.catchUp', 'room.solo401k.rothCatchUp', 'room.solo401k.pretax']) absent(db, k, 'catch-up treatment unknown');
    assert.equal(info.retireCatchUp, 'retirement.priorYearFicaWages');
  });

  test('MG6: box 1 wages never stand in for box 3', async () => {
    // A 2025 W-2 with box 1 wages 160,000 and no socialSecurityWages field leaves box 3 unknown.
    const doc = w2Doc({ taxYear: 2025, employerName: CEDAR, person: 'owner', wages: 160000 });
    const { db, info } = await planned(corp61({ payroll: [doc] }));
    absent(db, 'room.solo401k.rothCatchUp');
    absent(db, 'room.solo401k.catchUp');
    assert.equal(info.retireCatchUp, 'retirement.priorYearFicaWages');
  });

  test('MG6: an owner fact supplies the wages', async () => {
    // retirement.priorYearFicaWages {owner: 160,000} replaces the document: same as the first MG6 case.
    const { db, info } = await planned(corp61({ facts: { 'retirement.priorYearFicaWages': { owner: 160000 }, 'retirement.planOffersRoth': true } }));
    assert.equal(fig(db, 'room.solo401k.rothCatchUp').v, 11250);
    assert.equal(fig(db, 'room.solo401k.pretax').v, 69500);
    assert.equal(fig(db, 'room.solo401k').v, 80750);
    assert.equal(info.retireCatchUp, undefined);
  });

  test('MG6: a sole proprietor\'s catch-up is never Roth-required', async () => {
    // A sole proprietor has no FICA wages from the sponsor (T.D. 10033), so the catch-up is pre-tax
    // and no wage data is needed. Wren Studio 5,000 a month is the owner's only business.
    const wren = { name: 'Wren Studio', type: 'sole_prop', owner: 'owner', income: 5000, expenses: {} };
    const { db, info } = await planned({ entities: [wren, SOLE_PROP], facts: { 'household.birthYears': { owner: 1965 } } });
    absent(db, 'room.solo401k.rothCatchUp');
    assert.equal(fig(db, 'room.solo401k.catchUp').v, 11250);
    const steps = fig(db, 'room.solo401k').locator.steps;
    assert.ok(steps.some(s => /Roth catch-up rule does not apply/i.test(`${s.label} ${s.formula ?? ''}`)), 'a step names the self-employed exemption');
    assert.equal(info.retireCatchUp, undefined);
  });

  test('MG6: salary curve x is pre-tax room', async () => {
    // Default store, owner 61, Northwind 2025 box 3 160,000. Point s = 50,000: employee 24,500;
    // catch-up min(11,250, 25,500) = 11,250; employer min(12,500, 47,500, 50,000 - 35,750 = 14,250)
    // = 12,500; total 48,250. With Roth confirmed x = 48,250 - 11,250 = 37,000 and the Roth figure
    // 11,250. Without confirmation catch-up is disabled: employer min(12,500, 47,500, 25,500) =
    // 12,500, x 37,000, no Roth figure. Box 3 140,000 (not affected): x 48,250.
    const facts = { 'household.birthYears': { owner: 1965 } };
    const roth = await planned({ payroll: [box3(SCORP.name, 160000, 120000)], facts: { ...facts, 'retirement.planOffersRoth': true } });
    assert.equal(fig(roth.db, 'wg.salary.s50.x').v, 37000);
    assert.equal(fig(roth.db, 'wg.salary.s50.roth').v, 11250);
    assert.equal(contentValue(roth.db, 'wargame').salary.xLabel, 'Pre-tax retirement room');

    const unconfirmed = await planned({ payroll: [box3(SCORP.name, 160000, 120000)], facts });
    assert.equal(fig(unconfirmed.db, 'wg.salary.s50.x').v, 37000);
    absent(unconfirmed.db, 'wg.salary.s50.roth');
    assert.match(contentValue(unconfirmed.db, 'wargame').salary.takeaway, /confirm your plan offers Roth deferrals/i);

    const clear = await planned({ payroll: [box3(SCORP.name, 140000, 120000)], facts });
    assert.equal(fig(clear.db, 'wg.salary.s50.x').v, 48250);
    absent(clear.db, 'wg.salary.s50.roth');
  });

  test('MG6: unknown outside deferrals withhold all solo room and the salary curve', async () => {
    // An owner outside W-2 with no deferral field: allPlanDeferrals is unknown, and at low
    // compensation the employer room depends on it (50,000 salary: 37,000 if zero, 12,500 if
    // 24,500), so nothing sized from it is published. SEP room does not depend on it.
    const doc = w2Doc({ employerName: 'Example Employer Inc', person: 'owner', relation: 'outside', wages: 200000, medicareWages: 200000 });
    const { db, info } = await planned({ payroll: [doc] });
    for (const k of ROOM_KEYS) absent(db, k, 'outside deferrals unknown');
    assert.ok(figureRow(db, 'room.sep'), 'room.sep still produced');
    assert.equal(db.prepare("SELECT count(*) AS n FROM figures WHERE key LIKE 'wg.salary.%'").get().n, 0, 'no salary war-game figures');
    assert.ok((info.confirm.salary || []).includes('retirement.otherPlanDeferrals'), `confirm.salary: ${info.confirm.salary}`);
    assert.ok((info.confirm.retirement || []).includes('retirement.otherPlanDeferrals'), `confirm.retirement: ${info.confirm.retirement}`);
    assert.equal((info.wargameInvalid || {}).salary, 'retirement.otherPlanDeferrals');
  });

  test('MG6: known outside deferrals size the curve', async () => {
    // retirement.otherPlanDeferrals {owner: 24,500}: at s = 50,000, employee 0, employer
    // min(12,500, 50,000, 50,000) = 12,500, x 12,500. Current salary 60,000: employee room 0.
    const { db } = await planned({ facts: { 'retirement.otherPlanDeferrals': { owner: { deferral: 24500, catchUp: 0 } } } });
    assert.equal(fig(db, 'wg.salary.s50.x').v, 12500);
    assert.equal(fig(db, 'room.solo401k.employee').v, 0);
  });

  test('MG6: catch-up-only room after outside deferrals fill the regular limit', async () => {
    // CORP61, outside deferrals 24,500, box 3 140,000: employee 0; catch-up
    // min(11,250 - 0, 180,000) = 11,250; employer min(45,000, 72,000, 180,000 - 11,250) = 45,000.
    // Pre-tax 0 + 45,000 + 11,250 = 56,250 = total.
    const { db } = await planned(corp61({ payroll: [box3(CEDAR, 140000)], facts: { 'retirement.otherPlanDeferrals': { owner: { deferral: 24500, catchUp: 0 } } } }));
    assert.equal(fig(db, 'room.solo401k.employee').v, 0);
    assert.equal(fig(db, 'room.solo401k.catchUp').v, 11250);
    assert.equal(fig(db, 'room.solo401k.employer').v, 45000);
    assert.equal(fig(db, 'room.solo401k.pretax').v, 56250);
    assert.equal(fig(db, 'room.solo401k').v, 56250);
  });

  test('MG6: a 30,000 salary at 61 without a Roth feature keeps employer room', async () => {
    // Cedar salary 2,500 a month, projected 30,000; box 3 160,000 (affected).
    // Unconfirmed Roth, catch-up disabled: employee 24,500; employer min(7,500, 30,000 - 24,500 =
    // 5,500, 30,000 - 24,500 - 0 = 5,500) = 5,500; total 30,000.
    // Roth confirmed: catch-up min(11,250, 5,500) = 5,500 (Roth); employer min(7,500, 5,500, 0) = 0;
    // pre-tax 24,500; total 30,000.
    const small = (facts = {}) => ({
      entities: [{ name: CEDAR, type: 's_corp', owner: 'owner', income: 10000, expenses: { 'Officer salary': 2500, 'Payroll taxes': 191.25 } }, SOLE_PROP],
      payroll: [box3(CEDAR, 160000, 150000)],
      facts: { 'household.birthYears': { owner: 1965 }, ...facts },
    });
    const off = await planned(small());
    assert.equal(fig(off.db, 'room.solo401k.employee').v, 24500);
    assert.equal(fig(off.db, 'room.solo401k.employer').v, 5500);
    assert.equal(fig(off.db, 'room.solo401k.rothCatchUp').v, 0);
    assert.ok(notesOf(fig(off.db, 'room.solo401k.rothCatchUp')).includes(NOTE.rothConfirm));
    absent(off.db, 'room.solo401k.catchUp');
    assert.equal(fig(off.db, 'room.solo401k.pretax').v, 30000);
    assert.equal(fig(off.db, 'room.solo401k').v, 30000);

    const on = await planned(small({ 'retirement.planOffersRoth': true }));
    assert.equal(fig(on.db, 'room.solo401k.employee').v, 24500);
    assert.equal(fig(on.db, 'room.solo401k.rothCatchUp').v, 5500);
    assert.equal(fig(on.db, 'room.solo401k.employer').v, 0);
    assert.equal(fig(on.db, 'room.solo401k.pretax').v, 24500);
    assert.equal(fig(on.db, 'room.solo401k').v, 30000);
  });
});

// ================================================================ MG9 Virginia529

// Source: Va. Code 58.1-322.03(7)(a) (4,000 per account per year, excess carried forward until
// fully deducted) and (7)(b) (a contributor who has attained age 70 is not subject to the limit and
// deducts the full amount contributed less amounts previously deducted). The default store has one
// college account with a 1,000 March contribution; Virginia top rate 5.75% above 17,000.
describe('MG9 Virginia529', () => {
  // The owner of the college account is 70 or older when `older` is set (ages come from birth years).
  const AGES = { 'household.birthYears': { owner: 1950, spouse: 1983 } };
  const va529 = async (entry, { older = false } = {}) => {
    const db = await S.store({ variant: { facts: AGES } });
    if (older) db.prepare("UPDATE accounts SET owner = 'owner' WHERE kind = '529'").run();
    addFact(db, 'accounts.va529', { [accountIdByMask(db, MASKS.college)]: entry });
    await plan(db);
    return { db, info: computeFor(db).info };
  };

  test('MG9: an age-70 owner deducts this year\'s contributions plus carryforward in full', async () => {
    // Uncapped: 1,000 + 5,000 = 6,000. Baseline (capped, carryforward 0): min(4,000, 1,000) = 1,000.
    // Both Virginia taxable incomes are above 17,000, so tax.va.proj falls by 5,000 x 5.75% = 287.50.
    // No capped account, so no deduction-left figure.
    const base = await planned({ facts: AGES });
    const old = await va529({ virginiaPlan: true, carryforward: 5000 }, { older: true });
    assert.equal(fig(base.db, 'va529.deduction').v, 1000);
    const d = fig(old.db, 'va529.deduction');
    assert.equal(d.v, 6000);
    assert.equal(d.kind, 'm');
    near(r2(fig(base.db, 'tax.va.proj').v - fig(old.db, 'tax.va.proj').v), 287.5, 'tax.va.proj drop');
    absent(old.db, 'va529.deductionLeft', 'age-70 accounts have no cap');
    assert.equal(old.info.va529.age70Count, 1);
    assert.equal(old.info.va529.eligible, 0);
    near(old.info.va529.deduction, 6000, 'info.va529.deduction');
    const saved = figureRow(old.db, 'va529.taxSaved');
    if (saved) assert.equal(saved.v, 0, 'nothing capped is left to save');
  });

  test('MG9: a capped account with a carryforward that fills the cap has no room left', async () => {
    // min(4,000, 1,000 + 5,000) = 4,000; left 4,000 - 4,000 = 0; tax saved by full use 0.
    const { db } = await va529({ virginiaPlan: true, carryforward: 5000 });
    assert.equal(fig(db, 'va529.deduction').v, 4000);
    assert.equal(fig(db, 'va529.deductionLeft').v, 0);
    assert.equal(fig(db, 'va529.taxSaved').v, 0);
  });

  test('MG9: a missing carryforward blocks Virginia tax and its targets', async () => {
    // Without the carryforward the subtraction, and so Virginia taxable income, is unknown.
    const { db, info } = await va529({ virginiaPlan: true });
    assert.equal(info.vaBlocked, 'va529_answers_missing');
    assert.ok(info.va529.missing.includes('College 529'), `missing: ${info.va529.missing}`);
    for (const k of ['tax.va.proj', 'sh.va.required', 'sh.va.remaining', 'va529.deduction', 'va529.deductionLeft', 'va529.taxSaved']) absent(db, k);
    assert.equal(db.prepare("SELECT count(*) AS n FROM figures WHERE key LIKE 'wg.salary.%' OR key LIKE 'wg.deferral.%'").get().n, 0, 'no war-game figures');
    assert.ok(figureRow(db, 'tax.fed.proj'), 'federal tax is still produced');
  });

  test('MG9: a college account with no Virginia answers at all blocks Virginia tax', async () => {
    // With no institution on file the plan is asked, not inferred.
    const db = await S.store({ variant: { facts: { 'accounts.va529': undefined } } });
    db.prepare("UPDATE accounts SET inst = '' WHERE kind = '529'").run();
    await plan(db);
    const info = computeFor(db).info;
    assert.equal(info.vaBlocked, 'va529_answers_missing');
    absent(db, 'tax.va.proj');
    assert.ok(figureRow(db, 'tax.fed.proj'));
  });

  test('MG9: a complete non-Virginia plan answer still publishes Virginia tax', async () => {
    // liveness: virginiaPlan false is complete with no other answers; no subtraction applies.
    const { db, info } = await va529({ virginiaPlan: false });
    assert.equal(info.vaBlocked, null);
    assert.ok(figureRow(db, 'tax.va.proj'), 'tax.va.proj produced');
    absent(db, 'va529.deductionLeft');
  });
});

// ================================================================ MG10 safe-harbor targets

// Source: IRC 6654(d)(1)(B) (required annual payment is the lesser of 90% of this year's tax and
// 100% of last year's) and (d)(1)(C) (110% when last year's AGI exceeded 150,000).
describe('MG10 safe-harbor targets', () => {
  test('MG10: prior-year and projection targets are separate figures', async () => {
    // Default store: prior federal tax 30,000, prior AGI 240,000 > 150,000, so priorTarget =
    // 30,000 x 110% = 33,000. Payments 3 x 6,000 = 18,000; withholding 0; priorRemaining 15,000.
    // currentTarget = 90% x tax.fed.proj. sh.fed.required = min(33,000, currentTarget), kind e
    // exactly when the projection is lower.
    const { db, info } = await planned();
    const proj = fig(db, 'tax.fed.proj').v;
    const prior = fig(db, 'sh.fed.priorTarget');
    const priorRem = fig(db, 'sh.fed.priorRemaining');
    const current = fig(db, 'sh.fed.currentTarget');
    assert.equal(prior.v, 33000);
    assert.equal(priorRem.v, 15000);
    near(current.v, r2(0.9 * proj), 'currentTarget');
    assert.deepEqual([prior.kind, priorRem.kind, current.kind], ['m', 'm', 'e']);
    assert.ok(current.v > prior.v, 'precondition: the prior-year target binds for the synthetic household');
    const required = fig(db, 'sh.fed.required');
    assert.equal(required.v, Math.min(prior.v, current.v));
    assert.equal(required.kind, current.v < prior.v ? 'e' : 'm');
    assert.equal(info.shBasis, 'prior');
    assert.ok((current.locator.assumptions || []).includes('projection_target'));
    assert.ok(notesOf(current).includes(NOTE.projection), 'currentTarget explains it is a projection');
    for (const k of ['sh.fed.priorTarget', 'sh.fed.required']) assert.ok(notesOf(fig(db, k)).includes(NOTE.priorFull), `${k} notes the full-year prior return`);
  });

  test('MG10: when the projection is the lower target the required figure is an estimate', async () => {
    // Prior federal tax 200,000 (fact, no return document): priorTarget 220,000 > 90% of the
    // projection, so required = currentTarget, kind e, basis current.
    const { db, info } = await planned({ priorReturn: false, facts: { 'tax.prior.federal': 200000, 'tax.prior.agi': 240000 } });
    const current = fig(db, 'sh.fed.currentTarget');
    assert.equal(fig(db, 'sh.fed.priorTarget').v, 220000);
    const required = fig(db, 'sh.fed.required');
    assert.equal(required.v, current.v);
    assert.equal(required.kind, 'e');
    assert.equal(info.shBasis, 'current');
  });

  test('MG10: without a prior return only the projection target is written', async () => {
    const { db, info } = await planned({ priorReturn: false });
    absent(db, 'sh.fed.priorTarget');
    absent(db, 'sh.fed.priorRemaining');
    const current = fig(db, 'sh.fed.currentTarget');
    assert.equal(current.kind, 'e');
    assert.equal(fig(db, 'sh.fed.required').kind, 'e');
    assert.equal(fig(db, 'sh.fed.required').v, current.v);
    assert.equal(info.shBasis, undefined);
  });
});

// ================================================================ MG11 cash runway

// Product rule (no tax source): spending is every outflow from personal checking, savings, cash and
// personal card accounts; one leg of a transfer between two household accounts (exact cents, within
// five days) is not spending. Clock 2026-11-05: the window is Aug, Sep and Oct 2026.
describe('MG11 cash runway', () => {
  const account = (id, kind, balance, extra = {}) => ({
    id, inst: 'Sample Bank', mask: null, name: `Sample ${kind}`, owner: null, kind, fileId: null, entity: null,
    latest: balance == null ? null : { date: '2026-10-31', amount: balance, source: 'balances', ids: [id.length], fileId: null },
    ...extra,
  });
  let nextId = 1;
  const txn = (account_id, date, amount, category = 'Shopping') => ({ id: nextId++, account_id, date, amount, description: 'Synthetic', category });
  const CARD_ROWS = () => [
    ...['08', '09', '10'].map(m => txn('card', `2026-${m}-10`, -4000)),
    ...['08', '09', '10'].map(m => txn('card', `2026-${m}-25`, 4000, 'Payment')),
  ];
  const CHECKING_PAYMENTS = () => ['08', '09', '10'].map(m => txn('checking', `2026-${m}-24`, -4000, 'Credit Card Payment'));
  const run = ({ accounts, transactions }) => computeFigures(
    { clock: NOW, year: 2026, taxYear: null, accounts, pnl: [], taxPayments: [], documents: [], transactions, files: [], freshness: [] },
    {},
    { clock: NOW, entities: [], owner: {} },
  ).figures;
  const ACCTS = () => [account('checking', 'checking', 24000), account('card', 'card', null), account('savings', 'savings', 0)];

  test('MG11: card spending paid from checking counts once', () => {
    // Card purchases 3 x 4,000 count; each checking payment matches the card's +4,000 one day later
    // and is excluded. 12,000 / 3 = 4,000 a month; runway 24,000 / 4,000 = 6.0.
    const f = run({ accounts: ACCTS(), transactions: [...CARD_ROWS(), ...CHECKING_PAYMENTS()] });
    assert.equal(f['cash.monthlyOut'].v, 4000);
    assert.equal(f['cash.runwayMonths'].v, 6);
    assert.equal(f['cash.monthlyOut'].locator.inputs.matchedTransfers, 3);
  });

  test('MG11: with no card account the checking payment is the spending', () => {
    // Nothing matches the checking payments, so they count whatever their category: 4,000 a month.
    const f = run({ accounts: ACCTS().filter(a => a.id !== 'card'), transactions: CHECKING_PAYMENTS() });
    assert.equal(f['cash.monthlyOut'].v, 4000);
    assert.equal(f['cash.runwayMonths'].v, 6);
    assert.equal(f['cash.monthlyOut'].locator.inputs.matchedTransfers, 0);
  });

  test('MG11: a matched transfer to savings is excluded', () => {
    // Checking -5,000 on Sep 1 and savings +5,000 on Sep 2 match; spending stays 4,000 a month;
    // matched: 3 card payments + 1 transfer = 4.
    const f = run({
      accounts: ACCTS(),
      transactions: [...CARD_ROWS(), ...CHECKING_PAYMENTS(), txn('checking', '2026-09-01', -5000, 'Transfer'), txn('savings', '2026-09-02', 5000, 'Transfer')],
    });
    assert.equal(f['cash.monthlyOut'].v, 4000);
    assert.equal(f['cash.monthlyOut'].locator.inputs.matchedTransfers, 4);
  });

  test('MG11: an unmatched transfer still counts', () => {
    // Checking -1,200 on Sep 15 labelled Transfer with no counterpart: (12,000 + 1,200) / 3 = 4,400;
    // runway round(24,000 / 4,400, one decimal) = round(5.4545) = 5.5.
    const f = run({ accounts: ACCTS(), transactions: [...CARD_ROWS(), ...CHECKING_PAYMENTS(), txn('checking', '2026-09-15', -1200, 'Transfer')] });
    assert.equal(f['cash.monthlyOut'].v, 4400);
    assert.equal(f['cash.runwayMonths'].v, 5.5);
  });

  test('MG11: a business card is not personal spending', () => {
    // A card tied to a business entity is P and L spending: only checking groceries of 1,000 a month
    // count; runway 24,000 / 1,000 = 24.0.
    const accounts = [account('checking', 'checking', 24000), account('bizcard', 'card', null, { entity: 'Example Business' })];
    const transactions = [
      ...['08', '09', '10'].map(m => txn('checking', `2026-${m}-12`, -1000, 'Groceries')),
      ...['08', '09', '10'].map(m => txn('bizcard', `2026-${m}-14`, -4000)),
    ];
    const f = run({ accounts, transactions });
    assert.equal(f['cash.monthlyOut'].v, 1000);
    assert.equal(f['cash.runwayMonths'].v, 24);
  });
});

// ================================================================ MGN1 readable notes

describe('MGN1 readable notes', () => {
  test('MGN1: tax figures carry readable notes', async () => {
    // Codes stay in locator.assumptions; locator.notes carries the sentences, none with a digit.
    const { db } = await planned();
    const agi = fig(db, 'agi.est');
    assert.ok(notesOf(agi).includes(NOTE.magi), 'agi.est names AGI for MAGI');
    assert.ok(notesOf(agi).includes(NOTE.noPriorLoss), 'agi.est names the missing QBI carryforward (D2)');
    assert.ok(notesOf(fig(db, 'tax.va.proj')).includes(NOTE.vaExempt), 'tax.va.proj names the exemptions');
    const t27 = notesOf(fig(db, 'wg.deferral.d50.tax2027'));
    assert.ok(t27.includes(NOTE.nextYear), 'next-year tax names the parameter proxy');
    assert.ok(t27.includes(NOTE.nextFlat), 'next-year tax names the flat income assumption');
    assert.ok(notesOf(fig(db, 'room.solo401k')).includes(NOTE.planTerms), 'room figures name the plan-terms assumption');
    for (const f of plannerFigures(db)) {
      const notes = notesOf(f);
      assert.ok(notes.length <= 5, `${f.key} has at most five notes`);
      for (const n of notes) {
        assert.equal(typeof n, 'string');
        assert.ok(!/\d/.test(n), `note on ${f.key} has no digit: ${n}`);
      }
      for (const code of f.locator.assumptions || []) assert.match(code, /^[a-z0-9_]+$/, `${f.key} assumption is a code: ${code}`);
    }
  });
});
