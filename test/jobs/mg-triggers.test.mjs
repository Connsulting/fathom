// Merge-gate fix round, stream B: trigger windows and prose (MG6 rec text, MG7, MG8, MG10), the
// planner-side literal check and its cache revalidation (MG13, D5, O1), names and kb excerpts as
// text (MG14, D1), war games and figures that turn unavailable but stay as history (MG12, D3,
// R2-9, R3-3, R3-7), figure notes in the scenario (MGN1) and retire events for owner-closed recs
// (MGN2).
//
// Trigger tests build synthetic ctx objects with the figure keys, info fields and blocked codes
// the plan pins, so they do not depend on the figures stream. Store-level tests run the planner on
// the synthetic real-mode store (test/helpers/real-store.mjs). Every amount and name is invented.
// Every test name starts with its criterion tag so receipts can select it by pattern.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { planRun } from '../helpers/plan.mjs';
import { evaluateCatalog } from '../../src/jobs/triggers/index.mjs';
import * as yearEnd from '../../src/jobs/triggers/year-end-retirement.mjs';
import * as solo401kSetup from '../../src/jobs/triggers/solo401k-setup.mjs';
import * as backdoorRoth from '../../src/jobs/triggers/backdoor-roth.mjs';
import * as fedQ4 from '../../src/jobs/triggers/fed-q4-estimate.mjs';
import { allowedFor, checkProse } from '../../src/jobs/planner/prose.mjs';
import { kbExcerpt } from '../../src/jobs/planner/kb.mjs';
import { NEUTRAL_NAMES } from '../../src/jobs/planner/brief.mjs';
import { lawContent, pctContent } from '../../src/jobs/planner/law.mjs';
import { evaluate as evaluateRule } from '../../src/packs/index.mjs';
import { checkGrounding } from '../../src/engine/index.mjs';
import { buildScenario, tokenScope } from '../../src/scenario/build.mjs';
import { getScenario, recAction, wargamePick } from '../../src/api/handlers.mjs';
import { HttpError } from '../../src/api/http.mjs';
import { callTool } from '../../src/tools/index.mjs';
import { esc, resolveTokens } from '../../src/shared/tokens.mjs';
import {
  scratch, addFact, removeFact, addPayroll, addFile, w2Doc, factRow, pnlWorkbook, accountIdByMask, contentValue, recRow,
  plannerRec, recEvents, activeRecIds, parseJson, MASKS,
} from '../helpers/real-store.mjs';

const NOW = '2026-11-05';
const S = scratch();
after(() => S.cleanup());
const plan = (db, now = NOW, engine = null) => planRun(db, { engine, now });
const api = (db, { clock = NOW, params = {}, body = {} } = {}) => ({ db, config: { clock }, params, body });

const EVIL = '<img src=x onerror=alert(1)>';
const AGI_NOTE = 'Adjusted gross income stands in for modified adjusted gross income.';

// ---------------------------------------------------------------- synthetic trigger contexts

function figOf(spec) {
  return Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, typeof v === 'number' ? { v, kind: 'm', label: 'Synthetic figure', src: 'calc:synthetic' } : v]));
}

function ctxOf({ clock = NOW, year = 2026, facts = {}, fig = {}, info = {}, owner = {} } = {}) {
  return {
    clock, year, facts, owner, fig: figOf(fig), names: { ...NEUTRAL_NAMES }, model: {}, data: {}, packs: [], packStatus: {},
    info: { blocked: [], confirm: {}, calcFailed: [], ...info }, freshness: [], warnings: [], entities: [],
  };
}

// One trigger through the same steps evaluateCatalog takes, plus the hit shape prose.mjs reads.
function runOne(t, ctx) {
  if (!evaluateRule(t.gate, ctx.facts)) return { state: 'none', gated: true };
  const window = t.window(ctx);
  if (window && window.close < ctx.clock) return { state: 'none', closed: true, window };
  const res = t.evaluate(ctx);
  if (!res) return { state: 'none', window };
  if (res.blocked) return { state: 'blocked', reason: res.blocked, window };
  const { grounding = [], ...vars } = res;
  const hit = { grounding: grounding.filter(k => k && ctx.fig[k]), ...vars };
  const built = t.build(ctx, hit);
  const prose = t.template(ctx, hit);
  const full = { trigger: t, rec: { ...built, mine: built.mine || [] }, window, grounding: hit.grounding, packId: null, vars: hit };
  return { state: 'hit', window, hit, built, prose, full };
}

// Every string a person reads on the rec: window label, build text and template prose.
function textsOf(r) {
  const b = r.built;
  const p = r.prose;
  return [
    r.window ? r.window.label : '', b.title, ...(b.value || []).map(v => v.text), ...(b.cross || []), ...(b.tasks || []).map(x => x.t),
    p.summary, ...p.why, ...p.qa.flatMap(q => [q.q, ...q.a]),
  ].filter(s => typeof s === 'string');
}
const taskTexts = r => r.built.tasks.map(x => x.t);
const proseOf = r => [r.prose.summary, ...r.prose.why, ...r.prose.qa.flatMap(q => [q.q, ...q.a])];

// Template prose must pass the same check model prose gets, with the hit's own allowed tokens.
function assertPlannerCheck(r, what) {
  const fields = { summary: r.prose.summary, why: r.prose.why, qa: r.prose.qa };
  const res = checkProse(fields, allowedFor(r.full, r.ctx));
  assert.ok(res.ok, `${what}: template prose fails the planner check (${res.reason}): ${JSON.stringify(fields)}`);
}

// Sole proprietor contexts (MG7, R2-6).
const SOLE = { person: 'owner', kind: 'sole', entity: 'wren-studio' };
const SCORP_SOLO = { person: 'owner', kind: 'scorp', entity: 'cedar-advisory' };
function soleCtx({ clock = NOW, onlyEmployee, plan: hasPlan, fig = { 'room.solo401k.employee': 24500, 'room.solo401k': 24500 } } = {}) {
  const facts = { 'income.selfEmployed': true };
  if (onlyEmployee !== undefined) facts['business.onlyEmployee'] = onlyEmployee;
  if (hasPlan !== undefined) facts['retirement.solo401k'] = hasPlan;
  return ctxOf({ clock, facts, fig, info: { solo: SOLE } });
}
function scorpCtx({ clock = NOW, fig = { 'room.solo401k.employee': 24500, 'room.solo401k.employer': 12500, 'room.solo401k': 37000 }, info = {} } = {}) {
  return ctxOf({ clock, facts: { 'income.sCorp': true }, fig, info: { solo: SCORP_SOLO, ...info } });
}
const withCtx = (r, ctx) => ({ ...r, ctx });

// ================================================================ MG7: sole proprietor first-year deadlines
// Sources: IRC 401(b)(2) as amended by SECURE 2.0 s.317 (first-plan-year deferrals by the
// unextended return due date for a sole owner who is the only employee); Treas. Reg.
// 1.401(k)-1(a)(6)(iii) (an established plan's election is due Dec 31); IRC 6072(a) (Apr 15).

test('MG7: a sole proprietor with no plan who is the only employee keeps setup open to Apr 15', () => {
  const ctx = soleCtx({ clock: '2026-12-20', onlyEmployee: true });
  assert.deepEqual(solo401kSetup.window(ctx), { close: '2027-04-15', label: 'Apr 15', hard: true });
  const res = evaluateCatalog(ctx).find(x => x.trigger.id === 'solo401k-setup');
  assert.equal(res.state, 'hit', 'the window is not closed on Dec 20');
  assert.equal(res.hit.window.close, '2027-04-15');
});

test('MG7: in January the sole proprietor\'s year-end rec still hits', () => {
  const ctx = soleCtx({ clock: '2027-01-10', onlyEmployee: true });
  const r = runOne(yearEnd, ctx);
  assert.equal(r.state, 'hit');
  assert.equal(r.window.close, '2027-04-15');
  assert.ok(r.prose.summary.includes('{f:room.solo401k.employee}'), 'the first-year rec is sized');
  assert.match(r.prose.summary, /Apr 15/);
});

test('MG7: an S corp owner\'s windows stay at the last payroll', () => {
  for (const info of [{ solo: SCORP_SOLO }, { solo: null }]) {
    const ctx = scorpCtx({ info });
    assert.deepEqual(solo401kSetup.window(ctx), { close: '2026-12-15', label: 'Before last payroll', hard: true });
    assert.deepEqual(yearEnd.window(ctx), { close: '2026-12-15', label: 'Last payroll', hard: true });
  }
});

test('MG7: an established sole proprietor plan closes Dec 31', () => {
  const ctx = soleCtx({ plan: true, onlyEmployee: true });
  const w = yearEnd.window(ctx);
  assert.equal(w.close, '2026-12-31');
  assert.equal(w.label, 'Dec 31');
  const r = runOne(yearEnd, ctx);
  assert.equal(r.state, 'hit');
  assert.match(r.prose.summary, /Dec 31/);
  assert.ok(r.prose.summary.includes('{f:room.solo401k.employee}'));
  // After Dec 31 the established plan's rec is closed.
  assert.equal(runOne(yearEnd, soleCtx({ clock: '2027-01-10', plan: true, onlyEmployee: true })).closed, true);
});

test('MG7: without the only-employee answer setup is a confirm form that does not close in December', () => {
  const ctx = soleCtx({ clock: '2026-12-20' });
  const r = runOne(solo401kSetup, ctx);
  assert.equal(r.state, 'hit');
  assert.deepEqual(r.hit.confirm, ['business.onlyEmployee']);
  assert.equal(r.window.close, '2027-04-15');
  assert.deepEqual(taskTexts(r), [], 'eligibility is answered through the question controls');
});

test('MG7: year-end retirement for a sole proprietor with no plan and no eligibility answer is a confirm form', () => {
  const ctx = soleCtx({ clock: '2027-01-10' });
  const r = runOne(yearEnd, ctx);
  assert.equal(r.state, 'hit');
  assert.deepEqual(r.hit.confirm, ['business.onlyEmployee']);
  assert.equal(r.window.close, '2027-04-15');
  assert.doesNotMatch(r.prose.summary, /\{f:/, 'no sized deferral while eligibility is unknown');
  assert.ok(!r.built.mine.some(m => m.fig.startsWith('room.')), 'no room figure in mine');
  for (const s of proseOf(r)) assert.doesNotMatch(s, /\{f:room\./, 'no room figure in prose');
});

test('MG7: both recs agree on the window for each eligibility answer', () => {
  const cases = [[true, '2027-04-15'], [false, '2026-12-31'], [undefined, '2027-04-15']];
  for (const [answer, close] of cases) {
    const ctx = soleCtx({ onlyEmployee: answer });
    assert.equal(solo401kSetup.window(ctx).close, close, `setup, onlyEmployee ${answer}`);
    assert.equal(yearEnd.window(ctx).close, close, `year-end, onlyEmployee ${answer}`);
  }
  // A sole proprietor who is not eligible gets no sized year-end rec after Dec 31.
  assert.notEqual(runOne(yearEnd, soleCtx({ clock: '2027-01-10', onlyEmployee: false })).state, 'hit');
});

test('MG7: sole proprietor prose never mentions payroll', () => {
  const sole = [
    ['setup, eligible', runOne(solo401kSetup, soleCtx({ onlyEmployee: true }))],
    ['setup, not eligible', runOne(solo401kSetup, soleCtx({ onlyEmployee: false }))],
    ['setup, unknown', runOne(solo401kSetup, soleCtx({}))],
    ['year-end, first year', runOne(yearEnd, soleCtx({ onlyEmployee: true }))],
    ['year-end, established plan', runOne(yearEnd, soleCtx({ plan: true, onlyEmployee: true }))],
    ['year-end, not eligible', runOne(yearEnd, soleCtx({ onlyEmployee: false }))],
    ['year-end, unknown', runOne(yearEnd, soleCtx({}))],
  ];
  for (const [what, r] of sole) {
    assert.equal(r.state, 'hit', what);
    for (const s of textsOf(r)) assert.doesNotMatch(s, /payroll/i, `${what}: "${s}"`);
  }
  const setupEligible = sole[0][1];
  assert.match(setupEligible.built.title, /Apr 15/, 'the first-year setup title names the Apr 15 deadline');
  // The S corp branch keeps its payroll wording.
  for (const t of [solo401kSetup, yearEnd]) {
    const r = runOne(t, scorpCtx());
    assert.equal(r.state, 'hit', t.id);
    assert.ok(textsOf(r).some(s => /payroll/i.test(s)), `${t.id} S corp text names the payroll`);
  }
});

test('MG7: solo 401(k) setup cites the contribution deadlines entry', () => {
  assert.ok(solo401kSetup.kb.some(k => k.pack === 'advanced-retirement' && k.entry === 'contribution-deadlines'));
});

// ================================================================ MG6: Roth catch-up in rec prose and grounding
// Sources: IRC 414(v)(2) and 414(v)(7)(A) (catch-up limits; Roth-only catch-up above the prior-year
// FICA wage threshold); Notice 2025-67 (threshold 150,000, catch-up 8,000 and 11,250);
// Treas. Reg. 1.414(v)-2(b)(2) (no Roth program, no catch-up for an affected participant);
// IRC 402A(a) (Roth contributions do not lower current taxable income).

test('MG6: year-end prose never claims a tax cut for Roth dollars', () => {
  const ctx = scorpCtx({ fig: {
    'room.solo401k.employee': 24500, 'room.solo401k.employer': 45000, 'room.solo401k.rothCatchUp': 11250,
    'room.solo401k.pretax': 69500, 'room.solo401k': 80750,
  } });
  const r = runOne(yearEnd, ctx);
  assert.equal(r.state, 'hit');
  const values = r.built.value.map(v => v.text);
  assert.ok(values.includes('Moves income into retirement savings'), `retire value: ${values}`);
  assert.ok(values.includes('Can lower this year tax if you choose pre-tax'), `conditional tax value: ${values}`);
  const rothWhy = r.prose.why.find(w => w.includes('{f:room.solo401k.rothCatchUp}'));
  assert.ok(rothWhy, 'a why line names the Roth catch-up room');
  assert.match(rothWhy, /Roth dollars do not lower this year's tax/);
  for (const s of textsOf(r)) assert.doesNotMatch(s, /lowers this year/i, `"${s}"`);
  assert.ok(r.hit.grounding.includes('room.solo401k.rothCatchUp'));
  assertPlannerCheck(withCtx(r, ctx), 'year-end with Roth catch-up');
});

test('MG6: ordinary catch-up-only room raises the year-end rec', () => {
  const ctx = scorpCtx({ fig: {
    'room.solo401k.employee': 0, 'room.solo401k.catchUp': 11250, 'room.solo401k.employer': 45000,
    'room.solo401k.pretax': 56250, 'room.solo401k': 56250,
  } });
  const r = runOne(yearEnd, ctx);
  assert.equal(r.state, 'hit');
  assert.ok(r.prose.summary.includes('{f:room.solo401k.catchUp}'), r.prose.summary);
  assert.ok(r.hit.grounding.includes('room.solo401k.catchUp'));
  assert.deepEqual(r.hit.parts, { regular: false, catchUp: true, roth: false });
  assertPlannerCheck(withCtx(r, ctx), 'year-end catch-up only');
});

test('MG6: Roth catch-up-only room raises the year-end rec without a tax-cut claim', () => {
  const ctx = scorpCtx({ fig: {
    'room.solo401k.employee': 0, 'room.solo401k.rothCatchUp': 11250, 'room.solo401k.employer': 45000,
    'room.solo401k.pretax': 45000, 'room.solo401k': 56250,
  } });
  const r = runOne(yearEnd, ctx);
  assert.equal(r.state, 'hit');
  assert.ok(r.prose.summary.includes('{f:room.solo401k.rothCatchUp}'), r.prose.summary);
  assert.ok(r.hit.grounding.includes('room.solo401k.rothCatchUp'));
  assert.deepEqual(r.hit.parts, { regular: false, catchUp: false, roth: true });
  for (const s of textsOf(r)) assert.doesNotMatch(s, /lowers this year/i, `"${s}"`);
  assert.ok(r.prose.why.some(w => /Roth catch-up dollars do not lower this year's tax/.test(w)), r.prose.why.join(' | '));
  assertPlannerCheck(withCtx(r, ctx), 'year-end Roth catch-up only');
});

test('MG6: with no pre-tax room the year-end rec shows no tax value line', () => {
  const ctx = scorpCtx({ fig: {
    'room.solo401k.employee': 0, 'room.solo401k.rothCatchUp': 11250, 'room.solo401k.employer': 0,
    'room.solo401k.pretax': 0, 'room.solo401k': 11250,
  } });
  const r = runOne(yearEnd, ctx);
  assert.equal(r.state, 'hit');
  assert.ok(!r.built.value.some(v => v.cls === 'tax'), JSON.stringify(r.built.value));
});

test('MG6: zero regular, zero catch-up does not fire', () => {
  const ctx = scorpCtx({ fig: {
    'room.solo401k.employee': 0, 'room.solo401k.catchUp': 0, 'room.solo401k.rothCatchUp': 0,
    'room.solo401k.employer': 45000, 'room.solo401k.pretax': 45000, 'room.solo401k': 45000,
  } });
  assert.equal(yearEnd.evaluate(ctx), null);
});

test('MG6: a pending Roth answer stays supplemental to the year-end action', () => {
  const ctx = scorpCtx({
    fig: { 'room.solo401k.employee': 24500, 'room.solo401k.employer': 45000, 'room.solo401k.rothCatchUp': 0, 'room.solo401k.pretax': 69500, 'room.solo401k': 69500 },
    info: { retireCatchUp: 'retirement.planOffersRoth' },
  });
  const r = runOne(yearEnd, ctx);
  assert.equal(r.state, 'hit');
  assert.equal(r.hit.catchUpPending, 'retirement.planOffersRoth');
  assert.ok(taskTexts(r).some(t => /Elect the deferral/.test(t)));
});

test('MG6: unknown prior-year wages add the wage task and say why catch-up is left out', () => {
  const ctx = scorpCtx({
    fig: { 'room.solo401k.employee': 24500, 'room.solo401k.employer': 45000 },
    info: { retireCatchUp: 'retirement.priorYearFicaWages' },
  });
  const r = runOne(yearEnd, ctx);
  assert.equal(r.state, 'hit');
  assert.equal(r.hit.catchUpPending, 'retirement.priorYearFicaWages');
  assert.ok(taskTexts(r).some(t => /Elect the deferral/.test(t)));
  assert.ok(r.prose.why.includes('Catch-up room is left out until we know whether it must be Roth.'), r.prose.why.join(' | '));
});

test('MG6: solo 401(k) setup grounds pre-tax wording on the pre-tax figure', () => {
  const ctx = ctxOf({
    facts: { 'income.sCorp': true },
    fig: { 'room.solo401k.employee': 24500, 'room.solo401k.employer': 45000, 'room.solo401k.rothCatchUp': 11250, 'room.solo401k.pretax': 69500, 'room.solo401k': 80750 },
    info: { solo: SCORP_SOLO },
  });
  const r = runOne(solo401kSetup, ctx);
  assert.equal(r.state, 'hit');
  assert.ok(r.hit.grounding.includes('room.solo401k.pretax'), r.hit.grounding.join(', '));
  for (const s of textsOf(r)) {
    if (/pre-tax/i.test(s)) assert.ok(!s.includes('{f:room.solo401k}'), `total room (Roth included) is never called pre-tax: "${s}"`);
  }
});

// ================================================================ MG8: backdoor Roth with no IRA room
// Sources: IRC 219(b)(1), (b)(5) and 219(c) (one contribution limit per person, spousal
// compensation); IRC 408A(c)(2) (Roth and traditional contributions share the limit);
// Notice 2025-67 (IRA limit 7,500, catch-up 1,100).

function backdoorCtx({ owner = 0, spouse = 0, mfj = true, facts = {} } = {}) {
  const fig = { 'agi.est': 300000 };
  if (owner != null) fig['room.ira.owner'] = owner;
  if (mfj && spouse != null) fig['room.ira.spouse'] = spouse;
  fig['room.ira.household'] = (owner || 0) + (mfj ? spouse || 0 : 0);
  return ctxOf({
    facts: { 'retirement.backdoorRothCandidate': true, 'household.filingStatus': mfj ? 'mfj' : 'single', ...facts },
    fig, info: { persons: mfj ? ['owner', 'spouse'] : ['owner'], ira: { noBalance: {} } },
  });
}
const contributionTasks = r => taskTexts(r).filter(t => /nondeductible/i.test(t));

test('MG8: zero IRA room for both spouses gives no contribution advice', () => {
  assert.equal(backdoorRoth.evaluate(backdoorCtx({ owner: 0, spouse: 0 })), null);
});

test('MG8: only the person with room gets the contribution task', () => {
  const ctx = backdoorCtx({ owner: 0, spouse: 7500 });
  const r = runOne(backdoorRoth, ctx);
  assert.equal(r.state, 'hit');
  const tasks = contributionTasks(r);
  assert.equal(tasks.length, 1, tasks.join(' | '));
  assert.match(tasks[0], /spouse/i);
  assert.ok(r.hit.grounding.includes('room.ira.owner') && r.hit.grounding.includes('room.ira.spouse'), r.hit.grounding.join(', '));
  const why = r.prose.why.join(' ');
  assert.ok(why.includes('{f:room.ira.spouse}'), why);
  assert.ok(!why.includes('{f:room.ira.owner}'), 'a zero room is not cited');
  assertPlannerCheck(withCtx(r, ctx), 'backdoor, spouse room only');
});

test('MG8: both people with room get a contribution task each', () => {
  const r = runOne(backdoorRoth, backdoorCtx({ owner: 7500, spouse: 7500 }));
  assert.equal(r.state, 'hit');
  assert.equal(contributionTasks(r).length, 2, contributionTasks(r).join(' | '));
  assert.equal(r.built.title, 'Use a backdoor Roth contribution');
});

test('MG8: existing basis gets a separate conversion task without a contribution', () => {
  const ctx = backdoorCtx({ owner: 0, spouse: 0, facts: { 'retirement.iraBasis': { owner: 6000 } } });
  const r = runOne(backdoorRoth, ctx);
  assert.equal(r.state, 'hit');
  assert.deepEqual(contributionTasks(r), []);
  assert.ok(taskTexts(r).some(t => /convert/i.test(t) && /after-tax IRA basis/i.test(t)), taskTexts(r).join(' | '));
  assert.equal(r.built.title, 'Convert your after-tax IRA basis to Roth');
  assert.match(r.prose.summary, /no IRA contribution room left/i);
  assertPlannerCheck(withCtx(r, ctx), 'backdoor, basis only');
});

test('MG8: a missing room figure blocks', () => {
  const r = runOne(backdoorRoth, backdoorCtx({ owner: 7500, spouse: null }));
  assert.equal(r.state, 'blocked');
  assert.equal(r.reason, 'ira_room_missing');
  // A single filer has no spouse figure to miss.
  assert.equal(runOne(backdoorRoth, backdoorCtx({ owner: 7500, mfj: false })).state, 'hit');
});

// ================================================================ MG10: federal Q4 safe-harbor prose
// Sources: IRC 6654(d)(1)(B), (C) (lesser of 90 percent of this year's tax and 100 or 110 percent of
// last year's); IRC 6654(b)(2), (b)(3) (each installment measured on its own due date; a later
// payment goes to the earliest unpaid installment and does not undo earlier accrual).

function fedCtx(basis) {
  const facts = { 'income.sCorp': true, 'household.state': 'VA' };
  if (basis === 'prior') {
    return ctxOf({ facts, info: { priorYear: true, priorHigh: true, shBasis: 'prior' }, fig: {
      'sh.fed.remaining': 15000, 'sh.fed.required': 33000, 'sh.fed.priorTarget': 33000, 'sh.fed.priorRemaining': 15000,
      'sh.fed.currentTarget': { v: 40000, kind: 'e', label: 'Synthetic figure' }, 'tax.fed.paid': 18000, 'tax.fed.proj': { v: 44444.44, kind: 'e', label: 'Synthetic figure' },
    } });
  }
  if (basis === 'current') {
    return ctxOf({ facts, info: { priorYear: true, priorHigh: true, shBasis: 'current' }, fig: {
      'sh.fed.remaining': { v: 12000, kind: 'e', label: 'Synthetic figure' }, 'sh.fed.required': { v: 30000, kind: 'e', label: 'Synthetic figure' },
      'sh.fed.priorTarget': 33000, 'sh.fed.priorRemaining': 15000, 'sh.fed.currentTarget': { v: 30000, kind: 'e', label: 'Synthetic figure' },
      'tax.fed.paid': 18000, 'tax.fed.proj': { v: 33333.33, kind: 'e', label: 'Synthetic figure' },
    } });
  }
  return ctxOf({ facts, info: { priorYear: false, priorHigh: false }, fig: {
    'sh.fed.remaining': { v: 12000, kind: 'e', label: 'Synthetic figure' }, 'sh.fed.required': { v: 30000, kind: 'e', label: 'Synthetic figure' },
    'sh.fed.currentTarget': { v: 30000, kind: 'e', label: 'Synthetic figure' }, 'tax.fed.paid': 18000, 'tax.fed.proj': { v: 33333.33, kind: 'e', label: 'Synthetic figure' },
  } });
}
const BASES = ['prior', 'current', 'none'];

test('MG10: no prose claims protection from a projection', () => {
  for (const basis of BASES) {
    const r = runOne(fedQ4, fedCtx(basis));
    assert.equal(r.state, 'hit', basis);
    for (const s of textsOf(r)) {
      assert.doesNotMatch(s, /protects you even if/i, `${basis}: "${s}"`);
      if (basis !== 'prior') assert.doesNotMatch(s, /protect|even if/i, `${basis}: "${s}"`);
    }
    assert.ok(!r.built.value.some(v => v.text === 'Keeps you inside the federal safe harbor'), `${basis}: old value line`);
  }
  const current = runOne(fedQ4, fedCtx('current'));
  assert.ok(current.prose.why.some(w => w.includes('{f:sh.fed.priorRemaining}')), 'the current basis points at the fixed prior-year amount');
  assert.ok(runOne(fedQ4, fedCtx('none')).prose.why.some(w => /This is an estimate/.test(w)), 'no prior return: estimate wording');
});

test('MG10: every variant discloses that a January payment does not cure earlier quarters', () => {
  for (const basis of BASES) {
    const ctx = fedCtx(basis);
    const r = runOne(fedQ4, ctx);
    const qa = r.prose.qa.find(q => q.q === 'Does a January payment fix earlier quarters?');
    assert.ok(qa, `${basis}: the January qa is present`);
    const a = qa.a.join(' ');
    assert.match(a, /^No\./);
    assert.match(a, /earliest unpaid installment/);
    assert.match(a, /stays/);
    assertPlannerCheck(withCtx(r, ctx), `fed-q4 ${basis}`);
  }
});

test('MG10: the prior-basis summary names the prior-year remaining figure', () => {
  const r = runOne(fedQ4, fedCtx('prior'));
  assert.ok(r.prose.summary.includes('{f:sh.fed.priorRemaining}'), r.prose.summary);
  assert.equal(r.hit.basis, 'prior');
  for (const k of ['sh.fed.priorTarget', 'sh.fed.priorRemaining', 'sh.fed.currentTarget']) assert.ok(r.hit.grounding.includes(k), `grounding has ${k}`);
  assert.ok(r.built.value.some(v => v.text === "Reaches last year's safe harbor"), JSON.stringify(r.built.value));
  const cur = runOne(fedQ4, fedCtx('current'));
  assert.ok(cur.built.value.some(v => v.text === "Meets this year's projected target"), JSON.stringify(cur.built.value));
});

// ================================================================ MG13: planner-side literal check (R2-7, D5, O1)

const ALLOWED = { fig: { 'sh.fed.remaining': 15000 }, law: {}, pct: {}, names: {} };
const fieldsWith = summary => ({ summary, why: ['The figures behind this come from your data.'], qa: [] });
const TOKEN_ONLY = { 'sh.fed.remaining': 'token' };

const REJECTED = [
  'Pay in 2026 cents.', 'Pay 2026 dollars.', 'Save in 2026 dollars.', 'Set aside in 2026 percent.', 'Owe in 2026, k',
  'Send $2026 by Jan 15.', 'Pay 2,026 now.', 'In 2026 pay 40 of it.',
  'Pay for 2026.', 'About 40 percent of it.', 'This changes in 2026.',
];
const ACCEPTED = [
  'Pay {f:sh.fed.remaining} by Jan 15.', 'Pay {f:sh.fed.remaining} by Jan 15, 2027.',
  'It applies for tax year 2026.', 'The window closes Dec 31st.',
];
const IDENTIFIERS = [
  'Defer more into your solo 401(k).', 'A 403(b) at work counts toward the same limit.', 'A 457(b) has its own limit.',
  'Fund the Virginia 529 plan.', 'Fund your Virginia529 account.',
];

test('MG13: money-context years and stray numbers in model prose are rejected', () => {
  for (const text of REJECTED) {
    const res = checkProse(fieldsWith(text), ALLOWED);
    assert.equal(res.ok, false, `accepted: "${text}"`);
    assert.equal(res.reason, 'literal', `"${text}"`);
  }
  // The same text in a why line or a qa answer is rejected too.
  assert.equal(checkProse({ summary: 'Pay {f:sh.fed.remaining} by Jan 15.', why: ['Pay in 2026 cents.'], qa: [] }, ALLOWED).ok, false);
  assert.equal(checkProse({ summary: 'Pay {f:sh.fed.remaining} by Jan 15.', why: ['Fine.'], qa: [{ q: 'When?', a: ['Pay 2026 dollars.'] }] }, ALLOWED).ok, false);
});

test('MG13: dates and years in date context pass', () => {
  for (const text of ACCEPTED) {
    const res = checkProse(fieldsWith(text), ALLOWED);
    assert.ok(res.ok, `rejected (${res.reason}): "${text}"`);
  }
});

test('MG13: D5 allowlisted identifiers pass both guards', () => {
  for (const text of IDENTIFIERS) {
    const g = checkGrounding(text, { figures: TOKEN_ONLY });
    assert.ok(g.ok, `general guard rejects "${text}": ${JSON.stringify(g.violations)}`);
    const res = checkProse(fieldsWith(text), ALLOWED);
    assert.ok(res.ok, `planner check rejects (${res.reason}): "${text}"`);
  }
});

test('MG13: D5 an identifier does not launder a money year', () => {
  const res = checkProse(fieldsWith('Put it in your 401(k) of 2026 dollars.'), ALLOWED);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'literal');
  assert.equal(checkProse(fieldsWith('Put it in your 401(k) this year.'), ALLOWED).ok, true, 'the identifier alone passes');
});

test('MG13: D5 (O1) a bare 529 fails only the planner-side check', () => {
  assert.ok(checkGrounding('Pay 529 now.', { figures: {} }).ok, 'the general guard keeps passing a bare 529');
  const res = checkProse(fieldsWith('Pay 529 now.'), ALLOWED);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'literal');
  assert.ok(checkProse(fieldsWith('Fund the 529 plan this year.'), ALLOWED).ok, 'the 529 plan phrase passes');
});

const unescape = s => String(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('MG13: every template on the synthetic household passes the planner check', async () => {
  const db = await S.store();
  await plan(db);
  const scenario = buildScenario(db, { clock: NOW });
  const allowed = {
    fig: Object.fromEntries(Object.entries(scenario.fig).map(([k, f]) => [k, f.v])),
    law: lawContent(), pct: pctContent(), names: scenario.names,
  };
  const ids = activeRecIds(db);
  assert.ok(ids.length > 5);
  for (const id of ids) {
    const def = recRow(db, id).def;
    const fields = { summary: unescape(def.summary), why: def.why.map(unescape), qa: def.qa.map(q => ({ q: unescape(q.q), a: q.a.map(unescape) })) };
    const res = checkProse(fields, allowed);
    assert.ok(res.ok, `${id} template fails the planner check (${res.reason}): ${JSON.stringify(fields)}`);
  }
});

for (const [what, tamper] of [
  ['summary', def => { def.summary = 'Pay in 2026 cents by Jan 15.'; }],
  ['qa answer', def => { def.qa = [{ q: 'How much?', a: ['Set aside 2026 dollars.'] }]; }],
]) {
  test(`MG13: previously accepted bad prose in an existing store is replaced on the next run (${what})`, async () => {
    const db = await S.store();
    await plan(db);
    const id = 'fed-q4-estimate';
    const template = recRow(db, id).def;
    const hash = plannerRec(db, id).grounding_hash;
    const def = parseJson(db.prepare('SELECT def FROM recs WHERE id = ?').get(id).def, {});
    tamper(def);
    db.prepare('UPDATE recs SET def = ? WHERE id = ?').run(JSON.stringify(def), id);
    db.prepare("UPDATE planner_recs SET prose_src = 'model' WHERE rec_id = ?").run(id);
    const result = await plan(db);
    const after = recRow(db, id).def;
    assert.equal(plannerRec(db, id).grounding_hash, hash, 'same grounding: only the recheck can replace it');
    assert.equal(after.summary, template.summary, 'the template summary is back');
    assert.deepEqual(after.qa, template.qa, 'the template qa is back');
    assert.equal(plannerRec(db, id).prose_src, 'template');
    assert.ok(result.counts.prose.template >= 1, 'the rec was rewritten, not kept');
    assert.equal(result.counts.prose.kept, result.counts.recs.active - result.counts.prose.template, 'every other rec is kept');
  });
}

test('MG13: unchanged stored prose that passes the check is kept on the next run', async () => {
  const db = await S.store();
  await plan(db);
  const before = recRow(db, 'fed-q4-estimate').def;
  const result = await plan(db);
  assert.deepEqual(recRow(db, 'fed-q4-estimate').def, before);
  assert.equal(result.counts.prose.kept, result.counts.recs.active, 'every rec is kept');
  assert.equal(result.counts.prose.template, 0);
});

// ================================================================ MG14: names and kb excerpts as text (D1)

test('MG14: markup in a name renders as text', async () => {
  const db = await S.store();
  addFact(db, 'household.names', { advisor: EVIL, me: EVIL });
  await plan(db);
  const names = contentValue(db, 'names');
  assert.equal(names.advisor, EVIL, 'stored as given');
  assert.equal(names.me, EVIL);
  const scenario = buildScenario(db, { clock: NOW });
  assert.equal(scenario.names.advisor, EVIL);
  assert.equal(resolveTokens(tokenScope(db), '{n:advisor}', true), esc(EVIL), 'escaped once when it becomes HTML');
  // No stored HTML carries the raw markup: names reach rec text and messages as tokens or escaped.
  for (const r of db.prepare('SELECT text FROM messages').all()) assert.ok(!r.text.includes('<img'), r.text);
  for (const r of db.prepare('SELECT def FROM recs').all()) assert.ok(!r.def.includes('<img'), 'rec def');
  for (const r of db.prepare("SELECT key, value FROM content WHERE key NOT IN ('names', 'meta')").all()) assert.ok(!r.value.includes('<img'), `content ${r.key}`);
});

test('MG14: an ampersand in a name shows once', async () => {
  const db = await S.store();
  addFact(db, 'household.names', { household: 'Lee & Park', advisor: 'Lee & Park Advisory' });
  await plan(db);
  assert.equal(contentValue(db, 'names').household, 'Lee & Park');
  assert.equal(contentValue(db, 'meta').household, 'Lee & Park', 'meta keeps the plain name');
  const scope = tokenScope(db);
  assert.equal(resolveTokens(scope, '{n:household}', true), 'Lee &amp; Park', 'one escape, displays one ampersand');
  assert.equal(resolveTokens(scope, '{n:household}', false), 'Lee & Park');
  for (const table of ['content', 'recs', 'messages']) {
    const col = table === 'recs' ? 'def' : table === 'messages' ? 'text' : 'value';
    for (const r of db.prepare(`SELECT ${col} AS v FROM ${table}`).all()) assert.ok(!String(r.v).includes('&amp;amp;'), `${table}: double escape`);
  }
});

function syntheticPacks(entry) {
  return [{ id: 'synthetic-pack', entries: [{ id: 'synthetic-entry', file: 'synthetic.md', cites: [], ...entry }] }];
}

test('MG14: kb excerpts are escaped with braces neutralized', () => {
  const packs = syntheticPacks({
    title: 'Plan <b>notes</b> {n:me}',
    body: '# Plan notes\n\nTax year: 2026\n\nRead <script>x</script> then {f:tax.fed.proj}.\n\nSecond paragraph.\n',
    cites: [{ label: 'Synthetic <i>cite</i> {l:iraLimit}', url: 'https://example.invalid/' }],
  });
  const k = kbExcerpt(packs, 'synthetic-pack', 'synthetic-entry');
  assert.ok(k.body.includes('&lt;script&gt;'), k.body);
  assert.ok(k.body.includes('&#123;f:tax.fed.proj&#125;'), k.body);
  for (const field of ['title', 'body', 'cite']) {
    assert.ok(!/[<>]/.test(k[field]), `${field} has raw markup: ${k[field]}`);
    assert.ok(!/\{(?:f|fk|l|p|n):/.test(k[field]), `${field} carries a live token: ${k[field]}`);
  }
  assert.equal(resolveTokens({ fig: { 'tax.fed.proj': { v: 1, kind: 'e' } } }, k.body, true), k.body, 'nothing in the excerpt resolves');
  // Liveness: plain pack text is unchanged.
  const plainK = kbExcerpt(syntheticPacks({ title: 'Plain title', body: 'A plain first paragraph.\n' }), 'synthetic-pack', 'synthetic-entry');
  assert.equal(plainK.body, 'A plain first paragraph.');
  assert.equal(plainK.title, 'Plain title');
});

test('MG14: kb excerpts are cut before escaping, so no entity is split', () => {
  const body = 'Tom & Jerry save <more> each month. '.repeat(40);
  const k = kbExcerpt(syntheticPacks({ title: 'T', body: `${body}\n` }), 'synthetic-pack', 'synthetic-entry');
  assert.ok(k.body.length > 0);
  assert.ok(!k.body.replace(/&(?:amp|lt|gt|quot|#\d+);/g, '').includes('&'), `a split or raw entity: ${k.body.slice(-40)}`);
  assert.ok(k.body.includes('Tom &amp; Jerry'));
});

// ================================================================ MG12: invalid inputs keep history, unavailable for current use (D3, R2-8, R2-9, R3-3, R3-7)

const pickRefused = (db, name, clock = NOW) => assert.throws(
  () => wargamePick(api(db, { clock, params: { name }, body: { index: 0 } })),
  err => err instanceof HttpError && err.status === 409,
);
const decisionRow = (db, id) => db.prepare('SELECT * FROM decisions WHERE id = ?').get(id);

test('MG12: a salary war game whose inputs became invalid stays as history and is not selectable', async () => {
  const db = await S.store();
  await plan(db);
  const before = contentValue(db, 'wargame').salary;
  assert.ok(before && before.points.length > 1);
  removeFact(db, 'business.salaryRange');
  await plan(db);
  const row = decisionRow(db, 'salary-2026');
  assert.ok(row, 'the decision row is kept');
  assert.equal(row.status, 'open');
  assert.equal(typeof row.unavailable_reason, 'string');
  assert.ok(row.unavailable_reason.trim().length > 0);
  const stored = contentValue(db, 'wargame').salary;
  assert.deepEqual(stored.points, before.points, 'the curve is kept as history');
  assert.equal(typeof stored.unavailable, 'string');
  const scenario = getScenario(api(db));
  const dec = scenario.decisions.find(d => d.id === 'salary-2026');
  assert.equal(dec.status, 'unavailable');
  assert.equal(dec.unavailable, row.unavailable_reason);
  assert.equal(scenario.wargame.salary.status, 'unavailable');
  pickRefused(db, 'salary');
});

test('MG12: restoring the inputs clears the marker', async () => {
  const db = await S.store();
  await plan(db);
  const range = parseJson(db.prepare("SELECT value FROM facts WHERE key = 'business.salaryRange'").get().value);
  removeFact(db, 'business.salaryRange');
  await plan(db);
  addFact(db, 'business.salaryRange', range);
  await plan(db);
  const row = decisionRow(db, 'salary-2026');
  assert.equal(row.unavailable_reason, null);
  assert.equal(row.status, 'open');
  assert.ok(!('unavailable' in contentValue(db, 'wargame').salary));
  const scenario = getScenario(api(db));
  assert.equal(scenario.decisions.find(d => d.id === 'salary-2026').status, 'open');
  assert.equal(scenario.wargame.salary.status, 'open');
  assert.doesNotThrow(() => wargamePick(api(db, { params: { name: 'salary' }, body: { index: 0 } })), 'a current game can be picked');
});

test('MG12: a decided salary decision stays decided when the game becomes unavailable', async () => {
  const db = await S.store();
  await plan(db);
  db.prepare("UPDATE decisions SET status = 'decided' WHERE id = 'salary-2026'").run();
  removeFact(db, 'business.salaryRange');
  await plan(db);
  assert.equal(decisionRow(db, 'salary-2026').status, 'decided');
  assert.equal(getScenario(api(db)).decisions.find(d => d.id === 'salary-2026').status, 'decided', 'a stored decided row wins over unavailable');
});

// Source: IRC 402(g)(1) (one regular deferral limit per person across plans, so unknown outside
// deferrals leave every dependent room figure unknown).
test('MG12: a built salary game becomes unavailable when outside deferrals become unknown', async () => {
  const db = await S.store();
  await plan(db);
  assert.ok(contentValue(db, 'wargame').salary);
  await addPayroll(db, w2Doc({ employerName: 'Example Employer Inc', person: 'owner', relation: 'outside', wages: 200000, medicareWages: 200000 }));
  await plan(db);
  const g = contentValue(db, 'wargame').salary;
  assert.equal(typeof g.unavailable, 'string');
  assert.match(g.unavailable, /deferral/i, g.unavailable);
  assert.equal(getScenario(api(db)).wargame.salary.status, 'unavailable');
  pickRefused(db, 'salary');
});

const vaAnswersMissing = db => addFact(db, 'accounts.va529', { [accountIdByMask(db, MASKS.college)]: { virginiaPlan: true, ownerAge70Plus: false } });
const vaAnswersComplete = db => addFact(db, 'accounts.va529', { [accountIdByMask(db, MASKS.college)]: { virginiaPlan: true, ownerAge70Plus: false, carryforward: 0 } });
const JAN = '2027-01-10';

// Source: Va. Code 58.1-322.03(7) (the carryforward is needed to know the Virginia deduction).
test('MG12: a deferral game valid in October becomes unavailable in January when its inputs break', async () => {
  const db = await S.store();
  await plan(db, '2026-10-31');
  const october = contentValue(db, 'wargame').deferral;
  assert.ok(october && october.options.length === 3, 'the October run built the deferral game');
  vaAnswersMissing(db);
  await plan(db, JAN);
  const g = contentValue(db, 'wargame').deferral;
  assert.deepEqual(g.options, october.options, 'options kept as history');
  assert.match(g.unavailable || '', /college savings/i, 'the reason names the 529 answers');
  const row = decisionRow(db, 'deferral-2026');
  assert.ok(row, 'decision row kept');
  assert.ok(row.unavailable_reason && row.unavailable_reason.length > 0);
  const scenario = getScenario(api(db, { clock: JAN }));
  assert.equal(scenario.wargame.deferral.status, 'unavailable');
  assert.equal(scenario.decisions.find(d => d.id === 'deferral-2026').status, 'unavailable', 'unavailable wins over a retired rec');
  pickRefused(db, 'deferral', JAN);
});

test('MG12: the same January run without broken inputs keeps the October game as is', async () => {
  const db = await S.store();
  await plan(db, '2026-10-31');
  const october = contentValue(db, 'wargame').deferral;
  await plan(db, JAN);
  assert.deepEqual(contentValue(db, 'wargame').deferral, october, 'seasonal absence changes nothing');
  assert.equal(decisionRow(db, 'deferral-2026').unavailable_reason, null);
});

const quillWorks = async db => {
  const f = pnlWorkbook([{ name: 'Quill Works', income: 1000, expenses: { Supplies: 100 } }]);
  f.name = 'Quill Works P&L 2026.xlsx';
  await addFile(db, f);
};

test('MG12: an unclassified business in January also marks it unavailable', async () => {
  const db = await S.store();
  await plan(db, '2026-10-31');
  assert.ok(contentValue(db, 'wargame').deferral);
  await quillWorks(db);
  await plan(db, JAN);
  const g = contentValue(db, 'wargame').deferral;
  assert.match(g.unavailable || '', /Quill Works/, 'the reason names the unclassified business');
  assert.equal(getScenario(api(db, { clock: JAN })).wargame.deferral.status, 'unavailable');
});

test('MG12: a Virginia target turns unavailable when the 529 answers go missing', async () => {
  const db = await S.store();
  await plan(db);
  const before = buildScenario(db, { clock: NOW }).fig['sh.va.remaining'];
  assert.ok(before && before.v > 0, 'the Virginia target exists on valid data');
  assert.ok(!('unavailable' in before));
  vaAnswersMissing(db);
  await plan(db);
  const scenario = getScenario(api(db));
  const f = scenario.fig['sh.va.remaining'];
  assert.equal(f.v, before.v, 'the retained value is kept for reference');
  assert.match(f.unavailable || '', /college savings/i);
  assert.equal(recRow(db, 'va-q4-estimate').status, 'waiting');
  assert.ok(resolveTokens(scenario, '{f:sh.va.remaining}', false).endsWith(' (not current)'));
  assert.match(resolveTokens(scenario, '{f:sh.va.remaining}', true), /data-unavailable="1"/);
  const tool = await callTool('household', { operation: 'figures',  keys: ['sh.va.remaining'] }, { db });
  assert.equal(tool.length, 1);
  assert.equal(tool[0].unavailable, f.unavailable);
  // Triggers read only this run's figures: no rec the run rewrote cites the retained key.
  for (const r of db.prepare("SELECT id, def, status FROM recs WHERE status <> 'waiting'").all()) {
    assert.ok(!r.def.includes('sh.va.remaining'), `${r.id} cites a retained figure`);
  }
});

test('MG12: federal targets turn unavailable when household tax is blocked', async () => {
  const db = await S.store();
  await plan(db);
  await quillWorks(db);
  await plan(db);
  const f = getScenario(api(db)).fig['sh.fed.remaining'];
  assert.ok(f, 'retained while the fed-q4 rec cites it');
  assert.match(f.unavailable || '', /how Quill Works is taxed/);
});

test('MG12: restoring the data clears the marker', async () => {
  const va = await S.store();
  await plan(va);
  vaAnswersMissing(va);
  await plan(va);
  vaAnswersComplete(va);
  await plan(va);
  assert.ok(!('unavailable' in getScenario(api(va)).fig['sh.va.remaining']));
  assert.ok(!resolveTokens(getScenario(api(va)), '{f:sh.va.remaining}', false).includes('not current'));

  const fed = await S.store();
  await plan(fed);
  await quillWorks(fed);
  await plan(fed);
  addFact(fed, 'business.entities', [...factRow(fed, 'business.entities').value, { name: 'Quill Works', type: 'sole_prop', owner: 'owner' }]);
  await plan(fed);
  const f = getScenario(api(fed)).fig['sh.fed.remaining'];
  assert.ok(f && !('unavailable' in f), JSON.stringify(f));
});

test('MG12: plain token text marks an unavailable figure and leaves a current one alone', () => {
  const scope = { fig: { 'x.old': { v: 1000, kind: 'e', unavailable: 'Synthetic reason.' }, 'x.now': { v: 1000, kind: 'e' } } };
  assert.equal(resolveTokens(scope, '{f:x.old}', false), '$1,000 (not current)');
  assert.match(resolveTokens(scope, '{f:x.old}', true), /data-unavailable="1"/);
  assert.equal(resolveTokens(scope, '{f:x.now}', false), '$1,000');
  assert.doesNotMatch(resolveTokens(scope, '{f:x.now}', true), /data-unavailable/);
});

// ================================================================ MGN1: figure notes in the scenario

test('MGN1: the scenario serves figure notes', async () => {
  const db = await S.store();
  await plan(db);
  const set = (key, locator) => db.prepare('UPDATE figures SET locator = ? WHERE key = ?').run(JSON.stringify(locator), key);
  set('cash.total', { calc: 'synthetic', notes: ['A sentence.'] });
  set('cash.business', { calc: 'synthetic' });
  set('cash.personal', { calc: 'synthetic', notes: ['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.', 'Seven.'] });
  set('cash.monthlyOut', { calc: 'synthetic', notes: [] });
  const fig = buildScenario(db, { clock: NOW }).fig;
  assert.deepEqual(fig['cash.total'].notes, ['A sentence.']);
  assert.ok(!('notes' in fig['cash.business']), 'no notes key without notes');
  assert.deepEqual(fig['cash.personal'].notes, ['One.', 'Two.', 'Three.', 'Four.', 'Five.'], 'at most five');
  if (fig['cash.monthlyOut']) assert.ok(!('notes' in fig['cash.monthlyOut']), 'an empty list adds nothing');
});

// ================================================================ MGN2: retire events for owner-closed recs

const lastStatusEvent = (db, id) => recEvents(db, id).filter(e => e.from_status !== e.to_status).at(-1);

for (const [label, close, status] of [
  ['done', db => recAction(api(db, { params: { id: 'va529' }, body: { action: 'complete' } })), 'done'],
  ['dismissed', db => recAction(api(db, { params: { id: 'va529' }, body: { action: 'dismiss' } })), 'dismissed'],
  ['hidden', db => db.prepare("UPDATE recs SET status = 'hidden' WHERE id = 'va529'").run(), 'hidden'],
]) {
  test(`MGN2: retiring a ${label} rec writes a retire event and keeps ${status}`, async () => {
    const db = await S.store();
    await plan(db);
    close(db);
    addFact(db, 'accounts.has529', false);
    await plan(db);
    const pr = plannerRec(db, 'va529');
    assert.ok(pr.retired_at, 'retired_at set');
    const ev = recEvents(db, 'va529').at(-1);
    assert.deepEqual([ev.action, ev.actor, ev.from_status, ev.to_status], ['retire', 'planner', status, status]);
    assert.equal(ev.arg, pr.retired_reason);
    assert.equal(recRow(db, 'va529').status, status);
  });

  test(`MGN2: a revived ${label} rec stays ${status}`, async () => {
    const db = await S.store();
    await plan(db);
    close(db);
    addFact(db, 'accounts.has529', false);
    await plan(db);
    const retiredAt = recEvents(db, 'va529').length;
    removeFact(db, 'accounts.has529');
    await plan(db);
    assert.equal(recRow(db, 'va529').status, status);
    assert.equal(plannerRec(db, 'va529').retired_at, null);
    const later = recEvents(db, 'va529').slice(retiredAt);
    assert.ok(!later.some(e => e.action === 'revive' && e.from_status !== e.to_status), JSON.stringify(later));
    const last = lastStatusEvent(db, 'va529');
    if (label !== 'hidden') assert.equal(last.actor, 'ui', 'the owner keeps the last word');
  });
}
