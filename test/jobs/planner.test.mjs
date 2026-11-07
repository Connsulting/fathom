// Planner over the synthetic real store: derived facts and pack state (AC2), figures hand-checked
// against the calculators (AC3), and the recs the trigger catalog writes, keeps, retires, revives
// and blocks (AC4). Expected amounts are computed here by calling src/calc with the inputs the
// plan names for the synthetic dataset (test/helpers/real-store.mjs), never copied from output.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planRun } from '../helpers/plan.mjs';
import { buildScenario } from '../../src/scenario/build.mjs';
import {
  selfEmploymentTax, qbiDeduction, federalIncomeTax, virginiaIncomeTax, estimatedPaymentSafeHarbor,
  solo401kRoom, sepRoom, hsaLimit,
} from '../../src/calc/index.mjs';
import { recAction, packToggle, threadCreate } from '../../src/api/handlers.mjs';
import { createLiveAnswerer } from '../../src/api/answerer.mjs';
import { createRuntimeEngine } from '../../src/engine/runtime.mjs';
import { reasonText } from '../../src/jobs/triggers/missing-data.mjs';
import {
  scratch, createRealStore, addPayroll, w2Doc, paystubDoc, addFact, removeFact, accountIdByMask, figureRow, plannerFigures,
  factRow, recRow, plannerRec, activeRecIds, recEvents, parseJson, SCORP, SOLE_PROP, SYNTH, MASKS,
  HINTS, INST, householdOf,
} from '../helpers/real-store.mjs';

const NOW = '2026-11-05';
const S = scratch();
after(() => S.cleanup());

const plan = (db, { engine = null, now = NOW } = {}) => planRun(db, { engine, now });
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const near = (actual, expected, what) =>
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= 0.011, `${what}: expected ${expected}, got ${actual}`);
function fig(db, key) {
  const row = figureRow(db, key);
  assert.ok(row, `figure ${key} exists`);
  return row;
}
// Ask goes through main's live answerer on the fake engine, as the server wires it: per household,
// with that household's root.
const answererFor = db => createLiveAnswerer({ engine: createRuntimeEngine({ db, config: { engine: 'fake' } }), root: householdOf(db).root });
const ctxOf = (db, params = {}, body = {}) => ({ db, config: { clock: NOW }, answerer: answererFor(db), params, body });

// ---------------------------------------------------------------- expected values (hand check)

const M = 10; // P&L months in the tax year
const sumExp = e => Object.values(e.expenses).reduce((a, b) => a + b, 0);
const NW_NET_YTD = r2(M * (SCORP.income - sumExp(SCORP)));             // 143,175
const NW_SALARY_YTD = M * SCORP.expenses['Officer salary'];             // 50,000
const NW_PAYROLL_YTD = r2(M * SCORP.expenses['Payroll taxes']);         // 3,825
const BB_NET_YTD = M * (SOLE_PROP.income - sumExp(SOLE_PROP));          // 55,000
const proj = x => r2(x * 12 / M);
const W = proj(NW_SALARY_YTD);   // own-corp wages, projected
const K = proj(NW_NET_YTD);      // K-1 ordinary, projected
const SP = proj(BB_NET_YTD);     // sole prop net, projected
const HSA_PERSONAL = M * SYNTH.hsaMonthly;
const OPTS = { planConfirmed: true, aggregationConfirmed: true };

// The household liability per the plan (base, R2, R7, S2, S8, T1), for the synthetic data.
function household() {
  const se = selfEmploymentTax({ netProfit: SP, filingStatus: 'mfj', w2SocialSecurityWages: 0, w2MedicareWages: 0, spouseMedicareWages: W }).value;
  const agi = r2(W + K + SP - se.deductibleHalf - HSA_PERSONAL);
  const deduction = 32200;
  const pre = Math.max(0, r2(agi - deduction));
  const qNorth = qbiDeduction({ qbi: K, taxableIncome: pre, filingStatus: 'mfj', w2Wages: W, isSstb: true, activeBusiness: true }).value;
  const qBlue = qbiDeduction({ qbi: r2(SP - se.deductibleHalf), taxableIncome: pre, filingStatus: 'mfj', w2Wages: 0, isSstb: true, activeBusiness: true }).value;
  const qbi = r2(Math.min(qNorth + qBlue, 0.2 * pre));
  const taxable = r2(Math.max(0, pre - qbi));
  const fedIncome = federalIncomeTax({ taxableIncome: taxable, filingStatus: 'mfj' }).value;
  const ctc = Math.min(2200, fedIncome); // one child under 17; the expected child is not counted
  const fedTotal = r2(fedIncome - ctc + se.total);
  const vaDeduction529 = Math.min(4000, SYNTH.collegeMarch);
  const va = virginiaIncomeTax({ taxableIncome: Math.max(0, r2(agi - 17500 - vaDeduction529)) }).value;
  const vaFull = virginiaIncomeTax({ taxableIncome: Math.max(0, r2(agi - 17500 - 4000)) }).value;
  const shFed = estimatedPaymentSafeHarbor({
    currentYearTax: fedTotal, priorYearTax: SYNTH.prior.federalTax, priorYearAgi: SYNTH.prior.agi, filingStatus: 'mfj',
    withholding: 0, paymentsMade: 3 * SYNTH.fedPaid, priorReturnFullYear: true, specialRulesAbsent: true,
  }).value;
  const vaRequired = va < 1000 ? 0 : r2(Math.min(0.9 * va, SYNTH.prior.virginiaTax));
  return {
    se, agi, qbi, taxable, fedTotal, va, vaTaxSaved: r2(va - vaFull), shFed, vaRequired,
    vaRemaining: Math.max(0, r2(vaRequired - 3 * SYNTH.statePaid)),
  };
}

const EXPECTED_ACTIVE = [
  'backdoor-roth', 'charitable-bunching', 'fed-q4-estimate', 'hsa-room', 'invoice-deferral', 'new-child',
  'scorp-salary', 'solo401k-setup', 'va-q4-estimate', 'va529', 'year-end-retirement',
];

// [close, days, label, hard] at the fixed clock (T9.4 and S9 applied).
const WINDOWS = {
  'fed-q4-estimate': ['2027-01-15', 71, 'Jan 15', true],
  'va-q4-estimate': ['2027-01-15', 71, 'Jan 15', true],
  'year-end-retirement': ['2026-12-15', 40, 'Last payroll', true],
  'solo401k-setup': ['2026-12-15', 40, 'Before last payroll', true],
  'scorp-salary': ['2026-12-15', 40, 'Last payroll', false],
  'invoice-deferral': ['2026-12-01', 26, 'Dec 1', false],
  'hsa-room': ['2027-04-15', 161, 'Apr 15', true],
  va529: ['2026-12-31', 56, 'Dec 31', true],
  'charitable-bunching': ['2026-12-31', 56, 'Dec 31', false],
  'backdoor-roth': ['2026-12-31', 56, 'Pro-rata snapshot Dec 31', false],
  'new-child': [null, null, null, false],
};

const DOMAIN_TRIGGER = {
  'fed-q4-estimate': ['tax', 'calendar'], 'va-q4-estimate': ['tax', 'calendar'],
  'year-end-retirement': ['retirement', 'calendar'], 'solo401k-setup': ['retirement', 'calendar'],
  'scorp-salary': ['business', 'income'], 'invoice-deferral': ['business', 'calendar'],
  'hsa-room': ['retirement', 'calendar'], va529: ['family', 'calendar'],
  'charitable-bunching': ['giving', 'goal'], 'backdoor-roth': ['retirement', 'goal'], 'new-child': ['family', 'life'],
};

// One shared store, planned once, for read-only assertions.
let base;
let ids;
before(async () => {
  base = await S.store();
  await plan(base);
  ids = {
    checking: accountIdByMask(base, MASKS.checking),
    business: accountIdByMask(base, MASKS.business),
    college: accountIdByMask(base, MASKS.college),
  };
});

// ================================================================ AC2: facts and packs

describe('derived facts and pack state', () => {
  test('AC2: derives the boolean facts from the data with planner provenance', () => {
    for (const key of ['income.sCorp', 'income.selfEmployed', 'accounts.has529', 'benefits.hsa', 'giving.charitable', 'retirement.ira', 'retirement.backdoorRothCandidate']) {
      const f = factRow(base, key);
      assert.ok(f, `fact ${key} derived`);
      assert.equal(f.value, true, key);
      assert.equal(f.src, 'planner', `${key} src`);
      assert.equal(f.confirmed, 0, `${key} unconfirmed`);
      assert.equal(f.parser, 'planner', `${key} parser`);
      assert.equal(f.as_of, NOW, `${key} as_of is the clock`);
      assert.ok(f.locator && typeof f.locator.rule === 'string' && f.locator.rule, `${key} locator names its rule`);
      if (Array.isArray(f.locator.rows)) assert.ok(f.locator.rows.length <= 20, `${key} keeps at most 20 evidence rows`);
    }
    for (const key of ['income.sCorp', 'accounts.has529', 'benefits.hsa', 'giving.charitable', 'retirement.ira']) {
      const f = factRow(base, key);
      assert.ok(f.locator.count >= 1, `${key} counts its evidence`);
      assert.ok(f.locator.rows.every(r => typeof r.table === 'string' && r.id != null), `${key} evidence rows name table and id`);
    }
  });

  test('AC2: income.agiEstimate equals figure agi.est and the giving estimate is the trailing sum', () => {
    const f = factRow(base, 'income.agiEstimate');
    assert.ok(f, 'income.agiEstimate derived');
    assert.equal(f.src, 'planner');
    assert.equal(f.value, fig(base, 'agi.est').v);
    const g = factRow(base, 'giving.annualEstimate');
    assert.ok(g, 'giving.annualEstimate derived');
    near(g.value, M * SYNTH.charityMonthly, 'giving.annualEstimate');
  });

  test('AC2: facts without evidence are not derived (w2, partnership, solo 401k)', () => {
    for (const key of ['income.w2', 'income.partnership', 'retirement.solo401k']) assert.equal(factRow(base, key), null, `${key} not derived`);
  });

  test('AC2: income.w2 is never derived from the household S corp, only from an outside employer', async () => {
    const db = await S.store();
    await addPayroll(db, w2Doc({ employerName: SCORP.name, person: 'owner', wages: 60000, medicareWages: 60000 }));
    await plan(db);
    assert.equal(factRow(db, 'income.w2'), null, 'a W-2 from the own S corp does not make income.w2');
    await addPayroll(db, w2Doc({ employerName: 'Example Employer Inc', person: 'spouse', relation: 'outside', wages: 80000, medicareWages: 80000 }));
    await plan(db);
    const f = factRow(db, 'income.w2');
    assert.ok(f, 'an outside employer W-2 derives income.w2');
    assert.equal(f.value, true);
    assert.equal(f.src, 'planner');
  });

  test('AC2: a confirmed owner fact and an unconfirmed owner fact both survive a run', async () => {
    const db = await S.store();
    addFact(db, 'accounts.has529', false, { src: 'you', confirmed: true });
    addFact(db, 'benefits.hsa', false, { src: 'you', confirmed: false });
    await plan(db);
    const a = factRow(db, 'accounts.has529');
    assert.deepEqual([a.value, a.src, a.confirmed], [false, 'you', 1]);
    const h = factRow(db, 'benefits.hsa');
    assert.deepEqual([h.value, h.src, h.confirmed], [false, 'you', 0]);
    // liveness: the planner still derives keys it owns on the same store
    assert.equal(factRow(db, 'income.sCorp').src, 'planner');
  });

  test('AC2: a planner fact whose evidence disappears is deleted', async () => {
    const db = await S.store();
    await plan(db);
    assert.ok(factRow(db, 'giving.charitable'), 'derived first');
    db.prepare("DELETE FROM transactions WHERE category = 'Charitable'").run();
    await plan(db);
    assert.equal(factRow(db, 'giving.charitable'), null, 'deleted once its evidence is gone');
    assert.ok(factRow(db, 'income.sCorp'), 'other planner facts stay');
  });

  test('AC2: packs_state is refreshed: the six matching packs are active and every loaded pack has a row', () => {
    const rows = base.prepare('SELECT * FROM packs_state ORDER BY sort').all();
    const byId = Object.fromEntries(rows.map(r => [r.id, { ...r, def: parseJson(r.def, {}) }]));
    for (const id of ['s-corp-owner', 'self-employed-partnership', 'virginia-resident', 'advanced-retirement', 'charitable-giving', 'kids-dependents']) {
      assert.ok(byId[id], `pack ${id} has a row`);
      assert.equal(byId[id].def.status, 'active', `${id} base status`);
    }
    assert.ok(byId['w2-benefits'], 'w2-benefits row exists');
    assert.notEqual(byId['w2-benefits'].def.status, 'active');
  });

  test('AC2: the owner pack override is kept across a run', async () => {
    const db = await S.store();
    await plan(db);
    db.prepare("UPDATE packs_state SET active = 0, exploring = 1 WHERE id = 'charitable-giving'").run();
    await plan(db);
    const row = db.prepare("SELECT * FROM packs_state WHERE id = 'charitable-giving'").get();
    assert.equal(row.active, 0);
    assert.equal(row.exploring, 1);
    assert.equal(parseJson(row.def).status, 'active', 'base status still from facts');
  });

  test('AC2: pack defs link the current planner recs (R12)', () => {
    const def = parseJson(base.prepare("SELECT def FROM packs_state WHERE id = 's-corp-owner'").get().def);
    assert.ok(def.recIds.includes('scorp-salary'), 'recIds lists scorp-salary');
    assert.deepEqual(def.recIds, [...def.recIds].sort(), 'recIds sorted');
    for (const r of base.prepare('SELECT def FROM packs_state').all().map(x => parseJson(x.def))) {
      for (const rid of r.recIds) assert.ok(recRow(base, rid), `pack ${r.id} links existing rec ${rid}`);
    }
  });

  test('AC2: toggling a planner-linked pack off then on through the API handler works (R12)', async () => {
    const db = await S.store();
    await plan(db);
    const off = packToggle(ctxOf(db, { id: 's-corp-owner' }));
    assert.equal(off.status, 'available');
    const on = packToggle(ctxOf(db, { id: 's-corp-owner' }));
    assert.equal(on.status, 'active');
    assert.notEqual(recRow(db, 'scorp-salary').status, 'hidden');
  });

  test('AC2: an unclassified P&L entity derives nothing and blocks tax figures, but keeps its actuals (R1)', async () => {
    const db = await S.store({ variant: { entities: [SCORP, { ...SOLE_PROP, doc: false }] } });
    await plan(db);
    assert.equal(factRow(db, 'income.selfEmployed'), null, 'no classification, no selfEmployed fact');
    assert.equal(factRow(db, 'income.sCorp').value, true, 'the classified S corp still counts');
    near(fig(db, `pnl.${SOLE_PROP.slug}.net`).v, BB_NET_YTD, 'actual P&L figure still written');
    assert.equal(fig(db, `pnl.${SOLE_PROP.slug}.net`).kind, 'a');
    assert.equal(figureRow(db, 'agi.est'), null, 'household tax figures not produced');
    assert.ok(activeRecIds(db).includes('missing-data'), 'missing-data asks how it is taxed');
  });
});

// ================================================================ AC3: figures

describe('figures', () => {
  test('AC3: balance and cash figures match the mirrored accounts', () => {
    const chk = fig(base, `bal.${ids.checking}`);
    const biz = fig(base, `bal.${ids.business}`);
    near(chk.v, SYNTH.checkingEnd, 'checking balance');
    near(biz.v, SYNTH.businessEnd, 'business balance');
    assert.equal(chk.kind, 'a');
    assert.equal(chk.src, `acct:${ids.checking}`);
    assert.equal(biz.src, `acct:${ids.business}`);
    near(fig(base, 'cash.total').v, SYNTH.checkingEnd + SYNTH.businessEnd, 'cash.total');
    near(fig(base, 'cash.business').v, SYNTH.businessEnd, 'cash.business');
    near(fig(base, 'cash.personal').v, SYNTH.checkingEnd, 'cash.personal');
    assert.equal(fig(base, 'cash.total').kind, 'a');
  });

  test('MG11: monthly outflow and runway count personal card spending (AC3)', () => {
    // Checking 3,000 + 1,500 a month plus the card's 250 charity outflow, none of them a matched
    // transfer: 4,750 a month; runway round(25,000 / 4,750, one decimal) = 5.3.
    const monthly = SYNTH.mortgage + SYNTH.groceries + SYNTH.charityMonthly;
    const out = fig(base, 'cash.monthlyOut');
    near(out.v, monthly, 'cash.monthlyOut');
    assert.equal(out.kind, 'e');
    const runway = fig(base, 'cash.runwayMonths');
    assert.equal(runway.kind, 'e');
    assert.equal(runway.v, Math.round(SYNTH.checkingEnd / monthly * 10) / 10);
    assert.equal(runway.v, 5.3);
  });

  test('AC3: P&L actuals and projections per entity', () => {
    const n = `pnl.${SCORP.slug}`;
    near(fig(base, `${n}.net`).v, NW_NET_YTD, 'northwind net');
    near(fig(base, `${n}.income`).v, M * SCORP.income, 'northwind income');
    near(fig(base, `${n}.salary`).v, NW_SALARY_YTD, 'northwind salary');
    near(fig(base, `${n}.payrollTax`).v, NW_PAYROLL_YTD, 'northwind payroll tax');
    for (const k of ['net', 'income', 'salary', 'payrollTax']) assert.equal(fig(base, `${n}.${k}`).kind, 'a', k);
    near(fig(base, `${n}.netProj`).v, K, 'netProj');
    near(fig(base, `${n}.salaryProj`).v, W, 'salaryProj');
    assert.equal(fig(base, `${n}.netProj`).kind, 'p');
    assert.equal(fig(base, `${n}.netProj`).src, 'plan-projection');
    near(fig(base, 'scorp.profitProj').v, r2(K + W + proj(NW_PAYROLL_YTD)), 'scorp.profitProj');
    assert.equal(fig(base, 'scorp.profitProj').kind, 'p');
    const inc = fig(base, `inc.ytd.${SOLE_PROP.slug}`);
    near(inc.v, M * SOLE_PROP.income, 'inc.ytd bluebird');
    assert.equal(inc.kind, 'a');
    assert.equal(figureRow(base, `pnl.${SOLE_PROP.slug}.salary`), null, 'salary figures are for the S corp only');
  });

  test('AC3: tax.fed.paid is 18000 and tax.va.paid is 6000, actuals from the payment log', () => {
    const f = fig(base, 'tax.fed.paid');
    const v = fig(base, 'tax.va.paid');
    assert.equal(f.v, 18000);
    assert.equal(v.v, 6000);
    assert.equal(f.kind, 'a');
    assert.equal(v.kind, 'a');
    assert.equal(f.src, 'tax-payments');
  });

  test('AC3: household tax figures match the calculators (agi.est, taxable, qbi, se, fed and VA projections)', () => {
    const h = household();
    const agi = fig(base, 'agi.est');
    near(agi.v, h.agi, 'agi.est');
    assert.equal(agi.kind, 'e');
    assert.equal(agi.src, 'calc:tax');
    near(fig(base, 'tax.fed.qbi').v, h.qbi, 'tax.fed.qbi');
    near(fig(base, 'tax.fed.taxable').v, h.taxable, 'tax.fed.taxable');
    near(fig(base, 'tax.fed.se').v, h.se.total, 'tax.fed.se');
    near(fig(base, 'tax.fed.proj').v, h.fedTotal, 'tax.fed.proj');
    near(fig(base, 'tax.va.proj').v, h.va, 'tax.va.proj');
    for (const k of ['tax.fed.qbi', 'tax.fed.taxable', 'tax.fed.se', 'tax.fed.proj', 'tax.va.proj']) assert.equal(fig(base, k).kind, 'm', k);
  });

  test('AC3: safe-harbor targets and remaining amounts from the prior-year return', () => {
    const h = household();
    near(fig(base, 'sh.fed.required').v, h.shFed.requiredAnnualPayment, 'sh.fed.required');
    near(fig(base, 'sh.fed.remaining').v, h.shFed.remaining, 'sh.fed.remaining');
    near(fig(base, 'sh.va.required').v, h.vaRequired, 'sh.va.required');
    near(fig(base, 'sh.va.remaining').v, h.vaRemaining, 'sh.va.remaining');
    for (const k of ['sh.fed.required', 'sh.fed.remaining', 'sh.va.required', 'sh.va.remaining']) assert.equal(fig(base, k).kind, 'm', `${k} is a model output with a prior year`);
  });

  test('AC3: retirement room figures match the calculators; IRA room is 7500 per person', () => {
    const solo = solo401kRoom({ compensation: W, kind: 'w2', age: 45, allPlanDeferrals: 0, thisPlanDeferrals: 0, thisPlanCatchUp: 0, employerContributions: 0, ...OPTS }).value;
    near(fig(base, 'room.solo401k').v, solo.total, 'room.solo401k');
    near(fig(base, 'room.solo401k.employee').v, solo.employee, 'room.solo401k.employee (regular deferral room only)');
    near(fig(base, 'room.solo401k.employer').v, solo.employer, 'room.solo401k.employer');
    const sep = sepRoom({ kind: 'self-employed', netProfit: SP, filingStatus: 'mfj', employerContributions: 0, ...OPTS }).value;
    near(fig(base, 'room.sep').v, sep, 'room.sep');
    assert.equal(fig(base, 'room.ira.owner').v, 7500);
    assert.equal(fig(base, 'room.ira.spouse').v, 7500);
    assert.equal(fig(base, 'room.ira.household').v, 15000);
    assert.equal(figureRow(base, 'room.ira'), null, 'room.ira is replaced by per-person keys');
    const hsa = hsaLimit({ coverage: 'family', age: 45, eligibilityConfirmed: true, employerContributions: 0, personalContributions: HSA_PERSONAL }).value;
    near(fig(base, 'room.hsa').v, hsa.remaining, 'room.hsa');
    near(fig(base, 'hsa.contrib.ytd').v, HSA_PERSONAL, 'hsa.contrib.ytd');
    assert.equal(fig(base, 'hsa.contrib.ytd').kind, 'a');
    for (const k of ['room.solo401k', 'room.sep', 'room.ira.owner', 'room.ira.household', 'room.hsa']) {
      assert.equal(fig(base, k).kind, 'm', k);
      assert.equal(fig(base, k).src, 'calc:retirement', `${k} src`);
    }
  });

  test('AC3: Virginia529 deduction left is 3000 and its tax saving is two Virginia tax runs apart', () => {
    const left = fig(base, 'va529.deductionLeft');
    assert.equal(left.v, 3000);
    assert.equal(left.kind, 'm');
    assert.equal(figureRow(base, 'va529.room'), null, 'va529.room renamed to va529.deductionLeft');
    near(fig(base, 'va529.contrib.ytd').v, SYNTH.collegeMarch, 'va529.contrib.ytd');
    assert.equal(fig(base, 'va529.contrib.ytd').kind, 'a');
    near(fig(base, 'va529.taxSaved').v, household().vaTaxSaved, 'va529.taxSaved');
    assert.equal(fig(base, 'va529.taxSaved').kind, 'm');
  });

  test('AC3: giving figures and the pre-tax IRA balance by person', () => {
    const trailing = M * SYNTH.charityMonthly;
    near(fig(base, 'giving.trailing').v, trailing, 'giving.trailing');
    assert.equal(fig(base, 'giving.trailing').kind, 'a');
    near(fig(base, 'giving.ytd').v, trailing, 'giving.ytd');
    near(fig(base, 'giving.twoYear').v, 2 * trailing, 'giving.twoYear');
    assert.equal(fig(base, 'giving.twoYear').kind, 'm');
    near(fig(base, 'ira.pretax.owner').v, SYNTH.iraValue, 'ira.pretax.owner');
    assert.equal(fig(base, 'ira.pretax.owner').kind, 'a');
    assert.equal(figureRow(base, 'ira.pretax'), null, 'ira.pretax replaced by per-person keys');
    const spouse = figureRow(base, 'ira.pretax.spouse');
    if (spouse) assert.equal(spouse.v, 0, 'the spouse has no pre-tax IRA balance');
  });

  test('AC3: every planner figure has a sources row, a kind, and a label without amounts', () => {
    const figs = plannerFigures(base);
    assert.ok(figs.length >= 40, `planner wrote its figures (${figs.length})`);
    const sources = new Set(base.prepare('SELECT id FROM sources').all().map(r => r.id));
    for (const f of figs) {
      assert.ok(sources.has(f.src), `figure ${f.key} src ${f.src} is a sources row`);
      assert.ok(['a', 'p', 'e', 'm'].includes(f.kind), `${f.key} kind`);
      assert.ok(typeof f.label === 'string' && f.label.trim(), `${f.key} has a label`);
      if (!f.key.startsWith('wg.')) {
        const stripped = f.label.replace(/401\s*\(\s*k\s*\)|401k|529|W-2|1099/gi, '');
        assert.ok(!/\d/.test(stripped), `label of ${f.key} has no digits: ${f.label}`);
      }
    }
  });

  test('AC3: locators: m figures carry calc and steps, a figures carry rows, every figure records computedOn', () => {
    for (const f of plannerFigures(base)) {
      assert.ok(f.locator && typeof f.locator === 'object', `${f.key} locator is JSON`);
      assert.equal(f.locator.computedOn, NOW, `${f.key} computedOn`);
      if (f.kind === 'm') {
        assert.ok(typeof f.locator.calc === 'string' && f.locator.calc, `${f.key} names its calculator`);
        assert.ok(Array.isArray(f.locator.steps) && f.locator.steps.length > 0, `${f.key} has steps`);
      }
      if (f.kind === 'a') {
        assert.ok(f.locator.rows && typeof f.locator.rows === 'object', `${f.key} names its data rows`);
        assert.equal(typeof f.locator.rows.table, 'string', `${f.key} rows.table`);
        assert.ok(Array.isArray(f.locator.rows.ids) && f.locator.rows.ids.length <= 50, `${f.key} rows.ids`);
        assert.ok(f.locator.rows.count >= f.locator.rows.ids.length, `${f.key} rows.count`);
      }
    }
  });

  test('AC3: planner sources carry plain labels and as-of dates', () => {
    const src = id => base.prepare('SELECT * FROM sources WHERE id = ?').get(id);
    const chk = src(`acct:${ids.checking}`);
    assert.equal(chk.label, HINTS[`${INST.bank}|${MASKS.checking}`].name);
    assert.equal(chk.as_of, 'Oct 31, 2026');
    assert.equal(src('pnl').label, 'Business profit and loss');
    assert.equal(src('pnl').as_of, 'through Oct 2026');
    assert.equal(src('tax-payments').label, 'Estimated tax payment log');
    assert.equal(src('calc:tax').label, 'Tax calculators, 2026 parameters');
    assert.equal(src('wargame-model').label, 'War-game model: salary, tax and cash calculators');
  });

  // Plan R6-1 item 2.7: ingest's paystub carries this period's deferral only (R6-0), never a
  // year-to-date total, so a paystub-only payroll group with a deferral blocks the dependent room
  // with paystub_deferrals_unknown and a visible reason. It is never extrapolated from one period.
  test('AC3: paystub-only deferrals block retirement room with a visible reason (R6-1 item 2.7)', async () => {
    const db = await S.store({
      variant: {
        pnlExtra: [{ entity: SCORP.name, category: 'Retirement contribution', monthly: 500 }],
        payroll: [paystubDoc({ employerName: SCORP.name, person: 'owner', payDate: '2026-10-31', periodStart: '2026-10-01', periodEnd: '2026-10-31', gross: 4000, ytdGross: 40000, retirementDeferral: 1000, hsaDeferral: 0 })],
      },
    });
    await plan(db);
    for (const k of ['room.solo401k', 'room.solo401k.employee', 'room.solo401k.employer']) assert.equal(figureRow(db, k), null, `${k} is not published`);
    assert.ok(activeRecIds(db).includes('missing-data'), 'missing-data lists the reason');
    const reason = reasonText({ info: { payrollBlocks: [{ code: 'paystub_deferrals_unknown', employer: SCORP.name }] }, entities: [] }, 'paystub_deferrals_unknown');
    assert.notEqual(reason, reasonText({ info: {}, entities: [] }, 'not_a_reason_code'), 'paystub_deferrals_unknown has its own reason text');
    assert.ok(JSON.stringify(recRow(db, 'missing-data').def).includes(reason), `missing-data shows: ${reason}`);
  });

  // Liveness: a year-end W-2 from the S corp whose box 12 D carries the year's deferrals supplies
  // the amount. Box 12 D 12,000 (the same 12,000 the old fixture projected: 10,000 over ten months
  // * 12 / 10) is the owner's whole 402(g) total and this plan's deferrals (IRC 402(g)(3); Form W-2
  // instructions, code D). Employer contributions are the P&L line, 500 a month for ten months =
  // 5,000. Compensation is the projected officer salary W. Room = solo401kRoom on those inputs.
  test('AC3: partially funded retirement room subtracts W-2 deferrals and employer contributions (R5, S6)', async () => {
    const deferrals = 12000;
    const db = await S.store({
      variant: {
        pnlExtra: [{ entity: SCORP.name, category: 'Retirement contribution', monthly: 500 }],
        payroll: [w2Doc({ employerName: SCORP.name, person: 'owner', wages: r2(W - deferrals), medicareWages: W, box12: [{ code: 'D', amount: deferrals }] })],
      },
    });
    await plan(db);
    const solo = solo401kRoom({ compensation: W, kind: 'w2', age: 45, allPlanDeferrals: deferrals, thisPlanDeferrals: deferrals, thisPlanCatchUp: 0, employerContributions: 5000, ...OPTS }).value;
    near(fig(db, 'room.solo401k.employee').v, solo.employee, 'employee room after deferrals');
    near(fig(db, 'room.solo401k.employer').v, solo.employer, 'employer room after contributions');
    assert.ok(fig(db, 'room.solo401k.employee').v < 24500, 'partially funded');
    assert.ok(activeRecIds(db).includes('year-end-retirement'), 'room left, so the rec stays');
  });

  test('AC3: spouse SE tax uses only the spouse wages when the owner earns above the wage base (R2)', async () => {
    const db = await S.store({ variant: { payroll: [w2Doc({ employerName: 'Example Employer Inc', person: 'owner', relation: 'outside', wages: 200000, medicareWages: 200000 })] } });
    await plan(db);
    const ownerMedicare = 200000 + W;
    const spouse = selfEmploymentTax({ netProfit: SP, filingStatus: 'mfj', w2SocialSecurityWages: 0, w2MedicareWages: 0, spouseMedicareWages: ownerMedicare }).value;
    const wrong = selfEmploymentTax({ netProfit: SP, filingStatus: 'mfj', w2SocialSecurityWages: ownerMedicare, w2MedicareWages: ownerMedicare }).value;
    assert.notEqual(spouse.total, wrong.total, 'the variant discriminates');
    near(fig(db, 'tax.fed.se').v, spouse.total, 'tax.fed.se is the spouse SE tax on the spouse wages only');
  });

  test('AC3: Additional Medicare across two sole props is charged on combined SE earnings above the threshold (S2)', async () => {
    const owner = { name: 'Juniper Works', type: 'sole_prop', owner: 'owner', income: 12500, expenses: {} };
    const spouse = { name: SOLE_PROP.name, type: 'sole_prop', owner: 'spouse', income: 12500, expenses: {} };
    const db = await S.store({
      variant: {
        entities: [owner, spouse],
        hints: { [`${INST.bank}|${MASKS.business}`]: { name: 'Business checking', kind: 'business', owner: null, entity: owner.name } },
        facts: { 'business.salaryRange': undefined },
      },
    });
    await plan(db);
    const net = r2(12500 * 12);
    const a = selfEmploymentTax({ netProfit: net, filingStatus: 'mfj', w2SocialSecurityWages: 0, w2MedicareWages: 0, spouseMedicareWages: 0 }).value;
    const b = selfEmploymentTax({ netProfit: net, filingStatus: 'mfj', w2SocialSecurityWages: 0, w2MedicareWages: 0, spouseMedicareWages: a.taxableEarnings }).value;
    const combinedAdditional = r2(0.009 * Math.max(0, a.taxableEarnings + b.taxableEarnings - 250000));
    near(r2(a.additionalMedicare + b.additionalMedicare), combinedAdditional, 'calculator oracle');
    near(fig(db, 'tax.fed.se').v, r2(a.total + b.total), 'tax.fed.se sums both people with filing-unit Additional Medicare');
  });

  test('AC3: after the last supported filing date there is no tax year: no tax figures, warning unsupported_tax_year', async () => {
    const db = await S.store();
    const result = await plan(db, { now: '2027-05-01' });
    assert.ok(result.warnings.includes('unsupported_tax_year'));
    for (const key of ['agi.est', 'tax.fed.proj', 'tax.va.proj', 'sh.fed.required', 'room.solo401k']) assert.equal(figureRow(db, key), null, `${key} skipped`);
    // liveness: data figures are still written
    assert.ok(figureRow(db, `bal.${accountIdByMask(db, MASKS.checking)}`));
  });
});

// ================================================================ AC4: recs

function assertRecShape(rec, scenario, packIds) {
  const where = `rec ${rec.id}`;
  for (const k of ['title', 'summary', 'triggerText', 'effort']) assert.equal(typeof rec[k], 'string', `${where}.${k}`);
  assert.ok(rec.title.trim() && rec.summary.trim(), `${where} title and summary`);
  assert.ok(['calendar', 'income', 'life', 'goal', 'advisor'].includes(rec.trigger), `${where}.trigger`);
  assert.ok(['tax', 'retirement', 'business', 'cash', 'family', 'giving', 'data'].includes(rec.domain), `${where}.domain`);
  assert.ok(rec.window && 'label' in rec.window && 'days' in rec.window, `${where}.window`);
  assert.equal(rec.advisor, null, `${where}.advisor`);
  assert.ok(Array.isArray(rec.value) && rec.value.length >= 1, `${where}.value`);
  for (const v of rec.value) {
    assert.ok(['tax', 'timing', 'retire', 'risk', 'cash', 'goal'].includes(v.cls), `${where}.value.cls ${v.cls}`);
    assert.equal(typeof v.text, 'string');
  }
  assert.ok(Array.isArray(rec.why) && rec.why.length >= 1 && rec.why.length <= 4, `${where}.why`);
  for (const p of rec.why) assert.equal(typeof p, 'string');
  assert.ok(Array.isArray(rec.mine) && rec.mine.length <= 5, `${where}.mine`);
  for (const m of rec.mine) {
    assert.equal(typeof m.label, 'string', `${where}.mine.label`);
    assert.ok(scenario.fig[m.fig], `${where}.mine fig ${m.fig} exists`);
  }
  assert.ok(Array.isArray(rec.kb), `${where}.kb`);
  for (const k of rec.kb) {
    for (const f of ['title', 'body', 'cite', 'pack']) assert.equal(typeof k[f], 'string', `${where}.kb.${f}`);
    assert.ok(packIds.has(k.pack), `${where}.kb pack ${k.pack} is loaded`);
    assert.ok(k.body.length <= 420, `${where}.kb body at most 420 chars`);
  }
  assert.ok(Array.isArray(rec.cross) && rec.cross.length <= 2, `${where}.cross`);
  if (rec.question?.primary) {
    assert.ok(rec.question.fields.length > 0);
    assert.deepEqual(rec.tasks, []);
  } else assert.ok(Array.isArray(rec.tasks) && rec.tasks.length >= 3 && rec.tasks.length <= 6, `${where}.tasks 3..6 (${rec.tasks.length})`);
  for (const t of rec.tasks) {
    assert.equal(typeof t.t, 'string');
    assert.equal(typeof t.done, 'boolean');
  }
  assert.ok(Array.isArray(rec.qa) && rec.qa.length <= 4, `${where}.qa`);
  for (const q of rec.qa) {
    assert.equal(typeof q.q, 'string');
    assert.ok(Array.isArray(q.a) && q.a.length >= 1 && q.a.length <= 3, `${where}.qa.a`);
  }
}

// Status-changing event = from_status != to_status; most recent = highest id (T6).
function lastStatusEvent(db, id) {
  return recEvents(db, id).filter(e => e.from_status !== e.to_status).at(-1);
}

describe('recs', () => {
  test('AC4: the synthetic household gets exactly the expected recs; dependent-care-fsa and missing-data do not fire', () => {
    assert.deepEqual(activeRecIds(base), EXPECTED_ACTIVE);
    for (const id of ['dependent-care-fsa', 'missing-data']) assert.equal(recRow(base, id), null, `${id} has no rec`);
    for (const id of EXPECTED_ACTIVE) {
      const r = recRow(base, id);
      assert.equal(r.status, 'proposed', `${id} starts proposed`);
      assert.equal(r.parser, 'planner');
      assert.equal(r.file_id, null);
      assert.deepEqual(parseJson(r.locator), { trigger: id });
      assert.deepEqual(r.tasks_done, r.def.tasks.map(() => false), `${id} tasks start not done`);
      assert.equal(plannerRec(base, id).trigger_id, id);
      assert.ok(['model', 'template'].includes(plannerRec(base, id).prose_src));
    }
  });

  test('AC4: windows are relative to the fixed clock (close date, days, label)', () => {
    const scenario = buildScenario(base, { clock: NOW });
    for (const [id, [close, days, label]] of Object.entries(WINDOWS)) {
      const row = recRow(base, id);
      assert.equal(row.window_close, close, `${id} window_close`);
      assert.equal(row.window_label, label, `${id} window_label`);
      const rec = scenario.recs.find(r => r.id === id);
      assert.equal(rec.window.days, days, `${id} window.days`);
    }
  });

  test('AC4: each rec has the CONTRACT shape with existing figures and loaded packs', () => {
    const scenario = buildScenario(base, { clock: NOW });
    const packIds = new Set(scenario.packs.map(p => p.id));
    for (const id of EXPECTED_ACTIVE) assertRecShape(scenario.recs.find(r => r.id === id), scenario, packIds);
    for (const id of ['fed-q4-estimate', 'va-q4-estimate', 'year-end-retirement', 'hsa-room', 'va529', 'charitable-bunching']) {
      const rec = scenario.recs.find(r => r.id === id);
      assert.ok(rec.mine.length >= 2, `${id} grounds itself in at least two figures`);
    }
  });

  test('AC4: domain, trigger class, trigger text and war-game scenario follow the catalog', () => {
    const scenario = buildScenario(base, { clock: NOW });
    for (const [id, [domain, trigger]] of Object.entries(DOMAIN_TRIGGER)) {
      const rec = scenario.recs.find(r => r.id === id);
      assert.equal(rec.domain, domain, `${id} domain`);
      assert.equal(rec.trigger, trigger, `${id} trigger`);
      const [, , label, hard] = WINDOWS[id];
      const text = id === 'new-child' ? 'Life event' : hard ? `Hard deadline: ${label}` : `Before ${label}`;
      assert.equal(rec.triggerText, text, `${id} triggerText`);
    }
    assert.equal(scenario.recs.find(r => r.id === 'scorp-salary').scenario, 'salary');
    assert.equal(scenario.recs.find(r => r.id === 'invoice-deferral').scenario, 'deferral');
    assert.equal(scenario.recs.find(r => r.id === 'fed-q4-estimate').scenario, undefined);
  });

  test('AC4: recs are sorted by window close with open-ended ones last', () => {
    const rows = base.prepare('SELECT id, window_close FROM recs ORDER BY sort').all();
    const closes = rows.map(r => r.window_close);
    const firstNull = closes.indexOf(null);
    if (firstNull >= 0) assert.ok(closes.slice(firstNull).every(c => c === null), 'nulls last');
    const dated = closes.filter(Boolean);
    assert.deepEqual(dated, [...dated].sort(), 'non-decreasing close dates');
  });

  test('AC4: a new rec gets no rec-keyed conversation or opening summary message', () => {
    for (const id of EXPECTED_ACTIVE) {
      assert.equal(base.prepare('SELECT count(*) AS n FROM conversations WHERE key = ?').get(id).n, 0, `${id} has no conversation`);
      assert.equal(base.prepare('SELECT count(*) AS n FROM messages WHERE conversation_key = ?').get(id).n, 0, `${id} has no message`);
    }
  });

  test('AC4: owner status, task flags and conversation survive a rerun', async () => {
    const db = await S.store();
    await plan(db);
    recAction(ctxOf(db, { id: 'va529' }, { action: 'start' }));
    recAction(ctxOf(db, { id: 'va529' }, { action: 'task', arg: 0 }));
    const { thread } = await threadCreate(ctxOf(db, {}, { recId: 'va529', text: 'Synthetic follow-up question for the planner test.' }));
    assert.equal(thread.recId, 'va529');
    const before = db.prepare('SELECT id, role, text FROM messages WHERE conversation_key = ? ORDER BY id').all(thread.key).map(r => ({ ...r }));
    assert.ok(before.length >= 2);
    const convBefore = { ...db.prepare('SELECT * FROM conversations WHERE key = ?').get(thread.key) };
    await plan(db);
    const row = recRow(db, 'va529');
    assert.equal(row.status, 'doing');
    assert.equal(row.tasks_done[0], true, 'task flag kept');
    const after = db.prepare('SELECT id, role, text FROM messages WHERE conversation_key = ? ORDER BY id').all(thread.key).map(r => ({ ...r }));
    assert.deepEqual(after, before, 'the rec thread is untouched');
    assert.deepEqual({ ...db.prepare('SELECT * FROM conversations WHERE key = ?').get(thread.key) }, convBefore, 'its row too');
    assert.equal(db.prepare("SELECT count(*) AS n FROM conversations WHERE key = 'va529'").get().n, 0, 'no rec-keyed conversation');
  });

  test('AC4: a rec whose condition no longer holds is retired to dismissed with a planner event and kept', async () => {
    const db = await S.store();
    await plan(db);
    addFact(db, 'accounts.has529', false, { src: 'you', confirmed: true });
    const result = await plan(db);
    const row = recRow(db, 'va529');
    assert.ok(row, 'rec row still exists');
    assert.equal(row.status, 'dismissed');
    const pr = plannerRec(db, 'va529');
    assert.ok(pr.retired_at, 'retired_at set');
    assert.equal(pr.retired_reason, 'The condition behind it no longer holds in your data.');
    const ev = recEvents(db, 'va529').at(-1);
    assert.deepEqual([ev.action, ev.actor, ev.from_status, ev.to_status], ['retire', 'planner', 'proposed', 'dismissed']);
    assert.equal(ev.arg, pr.retired_reason);
    assert.equal(result.counts.byTrigger.va529, 'retired');
    assert.ok(!activeRecIds(db).includes('va529'));
  });

  test('AC4: restoring the condition revives a planner-retired rec to proposed', async () => {
    const db = await S.store();
    await plan(db);
    addFact(db, 'accounts.has529', false, { src: 'you', confirmed: true });
    await plan(db);
    removeFact(db, 'accounts.has529');
    await plan(db);
    const row = recRow(db, 'va529');
    assert.equal(row.status, 'proposed');
    const pr = plannerRec(db, 'va529');
    assert.equal(pr.retired_at, null);
    assert.equal(pr.retired_reason, null);
    const ev = recEvents(db, 'va529').at(-1);
    assert.deepEqual([ev.action, ev.actor, ev.from_status, ev.to_status], ['revive', 'planner', 'dismissed', 'proposed']);
  });

  for (const [action, status] of [['dismiss', 'dismissed'], ['complete', 'done']]) {
    test(`AC4: an owner-${status} rec stays ${status} when its trigger disappears and reappears (R13, S10)`, async () => {
      const db = await S.store();
      await plan(db);
      recAction(ctxOf(db, { id: 'va529' }, { action }));
      addFact(db, 'accounts.has529', false, { src: 'you', confirmed: true });
      await plan(db);
      assert.equal(recRow(db, 'va529').status, status, 'retirement leaves the owner status');
      assert.ok(plannerRec(db, 'va529').retired_at);
      removeFact(db, 'accounts.has529');
      await plan(db);
      assert.equal(recRow(db, 'va529').status, status, 'revival leaves the owner status');
      assert.equal(plannerRec(db, 'va529').retired_at, null, 'retired_at cleared');
      assert.equal(lastStatusEvent(db, 'va529').actor, 'ui', 'the owner had the last word');
    });
  }

  test('AC4: in January the Q4 estimate and HSA recs stay, Dec 31 recs retire as closed, backdoor moves to Apr 15 (R10, S9)', async () => {
    const db = await S.store();
    await plan(db);
    await plan(db, { now: '2027-01-10' });
    const active = activeRecIds(db);
    for (const id of ['fed-q4-estimate', 'va-q4-estimate', 'hsa-room', 'backdoor-roth']) assert.ok(active.includes(id), `${id} still active`);
    assert.equal(recRow(db, 'fed-q4-estimate').window_close, '2027-01-15');
    assert.equal(recRow(db, 'fed-q4-estimate').status, 'proposed');
    for (const id of ['va529', 'charitable-bunching']) {
      const pr = plannerRec(db, id);
      assert.ok(pr.retired_at, `${id} retired`);
      assert.equal(pr.retired_reason, 'Its window closed on Dec 31.');
      assert.equal(recRow(db, id).status, 'dismissed');
      const ev = recEvents(db, id).at(-1);
      assert.deepEqual([ev.action, ev.actor], ['retire', 'planner']);
    }
    for (const id of ['year-end-retirement', 'solo401k-setup', 'scorp-salary', 'invoice-deferral']) {
      assert.ok(plannerRec(db, id).retired_at, `${id} retired after its window`);
      assert.match(plannerRec(db, id).retired_reason, /^Its window closed on /);
    }
    const bd = recRow(db, 'backdoor-roth');
    assert.equal(bd.window_close, '2027-04-15');
    assert.equal(bd.window_label, 'IRA contribution deadline');
    assert.equal(bd.status, 'proposed');
  });

  test('AC4: missing-data fires when the data goes stale (clock 2027-01-10, no new data)', async () => {
    const db = await S.store({ clock: '2027-01-10' });
    await plan(db, { now: '2027-01-10' });
    assert.ok(activeRecIds(db).includes('missing-data'));
    assert.equal(recRow(db, 'missing-data').def.domain, 'data');
    // liveness: the same data at the November clock does not fire it
    assert.ok(!activeRecIds(base).includes('missing-data'));
  });

  test('AC4: an empty real store plans cleanly: only missing-data fires and no figures are written', async () => {
    const db = S.track(await createRealStore(S.dir(), { clock: NOW }));
    const result = await plan(db);
    assert.equal(result.status, 'ok');
    assert.deepEqual(activeRecIds(db), ['missing-data']);
    assert.equal(plannerFigures(db).length, 0);
    const scenario = buildScenario(db, { clock: NOW });
    assert.ok(scenario.recs.some(r => r.id === 'missing-data'));
  });

  test('AC4: a missing confirmation turns the HSA rec into confirm form with no room figure (R6)', async () => {
    const db = await S.store({ variant: { facts: { 'benefits.hsaEligible': undefined } } });
    await plan(db);
    assert.ok(activeRecIds(db).includes('hsa-room'), 'still fires');
    assert.equal(figureRow(db, 'room.hsa'), null, 'no room figure without confirmed eligibility');
    const def = recRow(db, 'hsa-room').def;
    assert.match(def.title, /HSA eligible/);
    assert.ok(def.question.fields.some(f => f.key === 'benefits.hsaEligible'));
    for (const m of def.mine) assert.equal(fig(db, m.fig).kind, 'a', `confirm-form mine ${m.fig} is an actual`);
    // liveness: with the confirmation the base store sizes the room
    assert.doesNotMatch(recRow(base, 'hsa-room').def.title, /^Confirm\b/);
  });

  test('AC4: without the Virginia529 account answers the va529 rec is in confirm form (S8)', async () => {
    const db = await S.store({ variant: { facts: { 'accounts.va529': undefined } } });
    db.prepare("UPDATE accounts SET inst = '' WHERE kind = '529'").run(); // no institution: the plan is asked
    await plan(db);
    assert.ok(activeRecIds(db).includes('va529'));
    assert.ok(recRow(db, 'va529').def.question.fields.some(f => f.key === 'accounts.va529'));
    assert.equal(figureRow(db, 'va529.deductionLeft'), null);
  });

  test('AC4: a 529 account whose owner is 70 or older is excluded, leaving no va529 rec (T5)', async () => {
    const db = await S.store();
    const college = accountIdByMask(db, MASKS.college);
    db.prepare("UPDATE accounts SET owner = 'owner' WHERE id = ?").run(college);
    addFact(db, 'household.birthYears', { owner: 1950, spouse: 1983 }); // the account owner is seventy or older
    addFact(db, 'accounts.va529', { [college]: { virginiaPlan: true, carryforward: 0 } });
    await plan(db);
    assert.ok(!activeRecIds(db).includes('va529'));
    const left = figureRow(db, 'va529.deductionLeft');
    if (left) assert.equal(left.v, 0);
  });

  test('AC4: a blocked trigger parks its rec as waiting on data and unblocks when the data arrives (S12)', async () => {
    const db = await S.store();
    await plan(db);
    const before = recRow(db, 'va-q4-estimate');
    const retained = before.def.mine.map(m => m.fig).filter(k => /^(tax\.va\.proj|sh\.va\.)/.test(k));
    assert.ok(retained.length >= 1, 'va-q4-estimate grounds itself in a Virginia model figure');
    const snapshot = Object.fromEntries(retained.map(k => [k, fig(db, k)]));

    addFact(db, 'tax.itemizedEstimate', 40000);
    await plan(db, { now: '2026-11-20' });
    const blocked = recRow(db, 'va-q4-estimate');
    assert.equal(blocked.status, 'waiting');
    assert.equal(blocked.waiting_on, 'data');
    assert.deepEqual(blocked.def, before.def, 'blocked rec def unchanged');
    const ev = recEvents(db, 'va-q4-estimate').at(-1);
    assert.deepEqual([ev.action, ev.actor, ev.from_status, ev.to_status], ['block', 'planner', 'proposed', 'waiting']);
    assert.ok(ev.arg, 'block event names the reason');
    assert.equal(plannerRec(db, 'va-q4-estimate').held_from, 'proposed');
    assert.equal(plannerRec(db, 'va-q4-estimate').retired_at, null, 'blocked is not retired');
    assert.ok(activeRecIds(db).includes('missing-data'), 'missing-data lists the reason');
    for (const k of retained) {
      const kept = fig(db, k);
      assert.equal(kept.v, snapshot[k].v, `${k} retained`);
      assert.equal(kept.locator.computedOn, NOW, `${k} keeps its original computedOn`);
    }

    addFact(db, 'tax.vaItemizedEstimate', 20000);
    await plan(db, { now: '2026-11-20' });
    assert.equal(recRow(db, 'va-q4-estimate').status, 'proposed');
    const ev2 = recEvents(db, 'va-q4-estimate').at(-1);
    assert.deepEqual([ev2.action, ev2.actor, ev2.from_status, ev2.to_status], ['unblock', 'planner', 'waiting', 'proposed']);
  });

  test('AC4: fully funded retirement leaves no room, so year-end-retirement does not fire (R5)', async () => {
    const sepFull = sepRoom({ kind: 'self-employed', netProfit: SP, filingStatus: 'mfj', ...OPTS }).value;
    const db = await S.store({
      variant: {
        pnlExtra: [{ entity: SCORP.name, category: 'Retirement contribution', monthly: 1500 }],
        payroll: [w2Doc({ employerName: SCORP.name, person: 'owner', wages: 35500, medicareWages: 60000, box12: [{ code: 'D', amount: 24500 }] })],
        facts: { 'retirement.contributions': [{ person: 'spouse', plan: 'sep', type: 'employer', roth: false, amount: sepFull }] },
      },
    });
    await plan(db);
    assert.equal(fig(db, 'room.solo401k.employee').v, 0);
    const sep = figureRow(db, 'room.sep');
    if (sep) assert.equal(sep.v, 0);
    assert.ok(!activeRecIds(db).includes('year-end-retirement'));
    assert.equal(recRow(db, 'year-end-retirement'), null);
  });

  test('AC4: a rec id held by a non-planner rec is skipped with warning rec_id_taken', async () => {
    const db = await S.store();
    const def = { id: 'va529', title: 'Owner note', summary: 'Kept by the owner.', tasks: [] };
    db.prepare(`INSERT INTO recs (id, def, status, tasks_done, sort, updated_at) VALUES ('va529', ?, 'doing', '[]', 0, ?)`)
      .run(JSON.stringify(def), new Date().toISOString());
    const result = await plan(db);
    assert.ok(result.warnings.includes('rec_id_taken'));
    assert.equal(plannerRec(db, 'va529'), null);
    const row = recRow(db, 'va529');
    assert.deepEqual([row.status, row.def.title], ['doing', 'Owner note']);
    assert.ok(activeRecIds(db).includes('va-q4-estimate'), 'the other recs still land');
  });

  test('AC4: backdoor Roth asks whose IRA it is when an IRA owner is unknown (S9)', async () => {
    const db = await S.store({ variant: { hints: { [`|${MASKS.ira}`]: { name: 'Rollover IRA', kind: 'retirement', owner: null } } } });
    await plan(db);
    assert.ok(activeRecIds(db).includes('backdoor-roth'));
    assert.ok(recRow(db, 'backdoor-roth').def.tasks.some(t => /whose IRA/i.test(t.t)), 'a task asks whose IRA it is');
    // liveness: with the owner known the base store does not ask
    assert.ok(!recRow(base, 'backdoor-roth').def.tasks.some(t => /whose IRA/i.test(t.t)));
  });
});
