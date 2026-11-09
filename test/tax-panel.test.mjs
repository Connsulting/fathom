// TX2: the Tax this year screen. The planner's paid-so-far and left-to-pay figures on a synthetic
// real store (src/jobs/planner/figures.mjs), the panel model's keys and gaps with fix targets that
// exist (web/horizon/screens/tax-model.js), the tax-estimate Ask starter, and the pace board's tax
// meter fallback. Every amount is synthetic; assertions compare stored figures with each other.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch, addPayroll, w2Doc, figureRow } from './helpers/real-store.mjs';
import { planRun } from './helpers/plan.mjs';
import { taxGap, estimateGap, ESTIMATE_GAP_RULES, TAX_GAP_RULES, ASSUMPTION_FIXES } from '../src/shared/tax-gaps.mjs';
import { ASSUMPTION_TEXT } from '../src/jobs/planner/assumptions.mjs';
import { HOWTO } from '../src/ingest/howto.mjs';
import { answerShape } from '../src/jobs/triggers/common.mjs';
import { loadAskStarters, loadFigures, ASK_STARTERS } from '../src/scenario/build.mjs';
import { taxPanelModel, taxMeterFallback, TAX_RESERVE_FIX, NO_PROJECTION_FIX } from '../web/horizon/screens/tax-model.js';
import { paceMeters } from '../web/horizon/screens/home-model.js';

const s = scratch('fathom-tax-panel-');
after(() => s.cleanup());

const CLOCK = '2026-11-05';
const fig = (v, extra = {}) => ({ v, src: 'calc:tax', kind: 'e', label: 'Synthetic figure', ...extra });

// A fix target exists: an upload kind has how-to steps, a keyed Ask has an answer shape (or is an
// explicit prompt-only Ask), a confirm id is a positive integer.
function assertFixTarget(fix, what) {
  assert.ok(fix && typeof fix.label === 'string' && fix.label.trim(), `${what}: fix has a label`);
  assert.doesNotMatch(fix.label, /\d/, `${what}: label has no digits`);
  if (fix.screen === 'upload') return assert.ok(Object.hasOwn(HOWTO, fix.kind), `${what}: upload kind ${fix.kind} exists`);
  if (fix.screen === 'confirm') return assert.ok(Number.isSafeInteger(fix.id) && fix.id > 0, `${what}: confirm id`);
  assert.equal(fix.screen, 'ask', `${what}: fix opens Ask, an upload or a confirm`);
  assert.ok(typeof fix.prompt === 'string' && fix.prompt.trim(), `${what}: Ask is prefilled`);
  if (fix.key !== undefined) assert.doesNotThrow(() => answerShape(fix.key), `${what}: answer shape ${fix.key} exists`);
}

test('TX2-1 planner: paid so far and left to pay combine the stored inputs and carry provenance', async () => {
  const db = await s.store({ variant: { priorReturn: false } });
  await addPayroll(db, w2Doc({ employerName: 'Maple Works', person: 'spouse', relation: 'outside', wages: 40000, medicareWages: 40000, federalWithheld: 4000, box12: [] }));
  const run = await planRun(db, { now: CLOCK });
  assert.ok(run.warnings.includes('prior_year_missing'), 'the planner warns prior_year_missing with no prior return');
  for (const j of ['fed', 'va']) {
    const proj = figureRow(db, `tax.${j}.proj`);
    assert.ok(proj && !proj.unavailable_reason, `${j} projection exists`);
    const parts = [figureRow(db, `tax.${j}.paid`), figureRow(db, `tax.${j}.withheld`)].filter(Boolean);
    const paid = figureRow(db, `tax.${j}.paidToDate`);
    const left = figureRow(db, `tax.${j}.remaining`);
    assert.ok(paid && left, `${j} paid so far and left to pay exist`);
    const partSum = Math.round(parts.reduce((acc, f) => acc + f.v * 100, 0)) / 100;
    assert.equal(paid.v, partSum, `${j} paid so far is the stored payments plus withholding`);
    assert.equal(left.v, Math.round((proj.v - paid.v) * 100) / 100, `${j} left to pay is projection less paid so far`);
    for (const f of [paid, left]) {
      assert.equal(f.src, 'calc:tax');
      assert.ok(Array.isArray(f.locator.steps) && f.locator.steps.length, `${f.key} has steps`);
      assert.doesNotMatch(f.label, /\d/, `${f.key} label has no digits`);
      assert.ok(!f.unavailable_reason, `${f.key} is not withheld`);
    }
    assert.equal(paid.locator.calc, 'taxPaidToDate');
    assert.equal(left.locator.calc, 'taxRemaining');
    assert.equal(paid.locator.taxYear, 2026, `${j} paid so far carries the planned tax year`);
    assert.equal(loadFigures(db)[`tax.${j}.remaining`].taxYear, 2026, `${j} left to pay exposes the planned tax year`);
    assert.equal(paid.kind, 'a');
    assert.equal(left.kind, 'e');
    assert.ok(paid.locator.steps[0].formula.includes(j === 'fed' ? 'estimated payments and withholding' : 'on file'), `${j} step says which inputs were on file`);
  }
  assert.ok(figureRow(db, 'tax.fed.withheld'), 'the synthetic W-2 withholding is on file');
  // The scenario exposes a tax figure's assumptions in plain words with their fix.
  const withheldAssumes = loadFigures(db)['tax.fed.withheld'].assumes;
  assert.deepEqual(withheldAssumes.find(a => a.code === 'addl_medicare_withholding_not_read'),
    { code: 'addl_medicare_withholding_not_read', text: ASSUMPTION_TEXT.addl_medicare_withholding_not_read, fix: ASSUMPTION_FIXES.addl_medicare_withholding_not_read });
  const left = figureRow(db, 'tax.fed.remaining');
  const prior = left.locator.gaps.find(g => g.code === 'prior_year_missing');
  assert.ok(prior, 'federal left to pay carries the missing prior return');
  assert.deepEqual(prior.action, ESTIMATE_GAP_RULES.prior_year_missing.fix);
  assert.ok(!figureRow(db, 'tax.va.remaining').locator.gaps.some(g => g.code === 'prior_year_missing'), 'state left to pay does not');
  assert.ok(!figureRow(db, 'tax.fed.proj').locator.gaps.some(g => g.code === 'prior_year_missing'), 'the projection keeps its own gaps');
  assert.ok(!figureRow(db, 'tax.fed.paidToDate').locator.gaps.some(g => g.code === 'prior_year_missing'), 'paid so far carries only payment gaps');
});

const GAPS = [
  ['paystub_ytd_missing', () => taxGap('paystub_ytd_missing', { employer: 'Cedar Labs' })],
  ['household_employer_unmatched', () => taxGap('household_employer_unmatched', { employer: 'Juniper Studio' })],
  ['withholding_recipient_unknown', () => ({ ...taxGap('withholding_recipient_unknown', { employer: 'federal payments' }), figureKeys: ['tax.fed.withheld'] })],
  ['prior_year_missing', () => estimateGap('prior_year_missing')],
  ['sstb_assumed', () => estimateGap('sstb_assumed')],
  ['filing_status_assumed', () => estimateGap('filing_status_assumed')],
];

for (const [code, make] of GAPS) test(`TX2-2 panel model lists ${code} with plain text and a fix that exists`, () => {
  const gap = make();
  const S = { 'tax.fed.proj': fig(30000, { kind: 'm' }), 'tax.fed.paidToDate': fig(10000, { kind: 'a' }), 'tax.fed.remaining': fig(20000, { gaps: [gap], taxYear: 2025 }) };
  const m = taxPanelModel(S);
  assert.equal(m.year, 2025, 'the planned tax year, not the calendar year');
  assert.equal(m.available, true);
  const listed = m.gaps.find(g => g.code === code);
  assert.ok(listed, `${code} is listed`);
  assert.deepEqual(listed.rows, ['fed']);
  assert.ok(listed.text.trim() && !listed.text.includes(code), 'plain text, no code');
  assert.doesNotMatch(listed.text, /\d/, 'no digits');
  assertFixTarget(listed.fix, code);
});

test('TX2-3 panel model keeps only stored keys, dedupes gaps and never computes a number', () => {
  const ytd = taxGap('paystub_ytd_missing', { employer: 'Cedar Labs' });
  const S = {
    'tax.fed.proj': fig(30000, { kind: 'm', gaps: [ytd] }), 'tax.fed.withheld': fig(4000, { kind: 'a' }), 'tax.fed.paidToDate': fig(4000, { kind: 'a' }),
    'tax.fed.remaining': fig(26000, { gaps: [ytd, estimateGap('prior_year_missing')] }),
    'tax.va.proj': fig(9000, { kind: 'm', gaps: [ytd] }), 'tax.va.remaining': fig(-1000, { gaps: [estimateGap('filing_status_assumed')] }),
  };
  const m = taxPanelModel(S);
  assert.deepEqual(m.rows.map(r => r.id), ['fed', 'state']);
  assert.deepEqual(m.rows[0].keys, { proj: 'tax.fed.proj', paid: 'tax.fed.paidToDate', withheld: 'tax.fed.withheld', remaining: 'tax.fed.remaining' });
  assert.deepEqual(m.rows[1].keys, { proj: 'tax.va.proj', remaining: 'tax.va.remaining' });
  assert.equal(m.rows[1].overpaid, true, 'a negative stored left-to-pay reads as overpaid');
  assert.equal(m.rows[0].overpaid, false);
  assert.deepEqual(m.gaps.map(g => g.code), ['paystub_ytd_missing', 'prior_year_missing', 'filing_status_assumed'], 'deduped by code, rough first');
  assert.deepEqual(m.gaps[0].rows, ['fed', 'state']);
  // The model returns keys, never values: no number in it but the year.
  const numbers = JSON.stringify(m).match(/-?\d+(\.\d+)?/g) || [];
  assert.deepEqual(numbers, [], 'the model holds no figure value');
  assert.equal(m.year, null, 'no planned tax year, no year shown');
  const none = taxPanelModel({ 'tax.fed.paid': fig(100, { kind: 'a' }) });
  assert.equal(none.available, false, 'no projection, nothing available');
  assert.equal(taxPanelModel({}).rows.length, 0);
  assertFixTarget(NO_PROJECTION_FIX, 'no projection');
  assert.deepEqual(NO_PROJECTION_FIX, { ...TAX_GAP_RULES.no_income_inputs.fix }, 'the no-projection fix is the no-income rule');
});

test('TX2-4 the estimate assumption rules stay out of TAX_GAP_RULES', () => {
  assert.ok(!Object.hasOwn(TAX_GAP_RULES, 'prior_year_missing'));
  assert.ok(!Object.hasOwn(TAX_GAP_RULES, 'sstb_assumed'));
  for (const code of Object.keys(ESTIMATE_GAP_RULES)) {
    const g = estimateGap(code);
    assert.deepEqual(Object.keys(g).sort(), Object.keys(taxGap('no_income_inputs')).sort(), `${code} has the taxGap shape`);
    assertFixTarget(g.action, code);
  }
  assert.throws(() => estimateGap('nope'), TypeError);
});

test('TX2-5 the tax-estimate starter is held only with a stored federal projection', async () => {
  const db = await s.store();
  const ids = () => loadAskStarters(db, []).map(x => x.id);
  db.prepare("DELETE FROM figures WHERE key = 'tax.fed.proj'").run();
  assert.ok(!ids().includes('tax-estimate'), 'absent with no projection');
  db.prepare("INSERT INTO figures (key, v, kind, label, parser, updated_at) VALUES ('tax.fed.proj', 30000, 'm', 'Projected federal tax for the year', 'planner', ?)").run(CLOCK);
  const list = loadAskStarters(db, []);
  const st = list.find(x => x.id === 'tax-estimate');
  assert.ok(st, 'present with a projection');
  assert.equal(st.q, "What's my tax estimate?");
  assert.ok(list.findIndex(x => x.id === 'tax-estimate') < list.findIndex(x => x.id === 'yearend'), 'yearend stays last');
  // Ask shows the first four starters that hold, so the tax estimate is always among them.
  assert.ok(ASK_STARTERS.findIndex(x => x.id === 'tax-estimate') < 4, 'within the four Ask shows even when every starter holds');
});

test('TX2-6 the tax meter with no reserve shows paid against projected, not a bare reason', () => {
  const meters = { retirement: { meter: null, reason: 'missing_meter_inputs' }, tax: { meter: null, reason: 'missing_meter_inputs' }, income: { meter: null, reason: 'missing_meter_inputs' } };
  assert.deepEqual(paceMeters(meters), [], 'no figures, no meters');
  const S = { 'tax.fed.proj': fig(30000), 'tax.fed.paidToDate': fig(10000), 'tax.va.proj': fig(9000) };
  assert.deepEqual(paceMeters(meters, S), ['tax'], 'a stored projection shows the tax meter only');
  const fb = taxMeterFallback(S);
  assert.deepEqual(fb.parts, [
    { id: 'fed', title: 'Federal', proj: 'tax.fed.proj', paid: 'tax.fed.paidToDate' },
    { id: 'state', title: 'State', proj: 'tax.va.proj', paid: null },
  ]);
  assert.equal(fb.fix, TAX_RESERVE_FIX);
  assertFixTarget(fb.fix, 'tax reserve');
  assert.equal(taxMeterFallback({ 'tax.va.proj': fig(9000) }), null, 'no federal projection, no fallback');
});

// TX2-7: each assumption behind a shown figure is listed once in plain words, after the gaps, with its
// existing fix where one exists; an assumption with no fix is words only, never dropped.
const ASSUMES = [...Object.keys(ASSUMPTION_FIXES), 'agi_as_magi_proxy', 'va_exemptions_omitted', 'section125_unknown', 'qbi_no_prior_loss'];
for (const code of ASSUMES) test(`TX2-7 panel model lists the ${code} assumption with its fix when one exists`, () => {
  const a = { code, text: ASSUMPTION_TEXT[code], fix: ASSUMPTION_FIXES[code] ? { ...ASSUMPTION_FIXES[code] } : null };
  const S = { 'tax.fed.proj': fig(30000, { kind: 'm', assumes: [a] }), 'tax.fed.remaining': fig(20000, { assumes: [a] }), 'tax.va.proj': fig(5000, { kind: 'm', assumes: [a] }) };
  const m = taxPanelModel(S);
  assert.equal(m.gaps.length, 0);
  assert.deepEqual(m.assumes.map(x => x.code), [code], 'listed once');
  assert.deepEqual(m.assumes[0].rows, ['fed', 'state']);
  assert.ok(m.assumes[0].text.trim() && !m.assumes[0].text.includes(code));
  assert.doesNotMatch(m.assumes[0].text, /\$|\d{3,}|\d[.,]\d/, 'states no amount (a form name such as W-2 is fine)');
  if (ASSUMPTION_FIXES[code]) assertFixTarget(m.assumes[0].fix, code);
  else assert.equal(m.assumes[0].fix, null);
  const asGap = taxPanelModel({ ...S, 'tax.fed.remaining': fig(20000, { assumes: [a], gaps: [{ ...taxGap('no_income_inputs'), code }] }) });
  assert.equal(asGap.assumes.length, 0, 'an assumption already listed as a gap is not repeated');
});

// A fix is offered only where it supplies the assumed input: these two have no import field or answer
// shape that reaches the planner, so they are words only.
test('TX2-8 assumptions whose input no fix can supply carry no fix control', () => {
  for (const code of ['section125_unknown', 'qbi_no_prior_loss']) assert.ok(!Object.hasOwn(ASSUMPTION_FIXES, code), code);
  assert.deepEqual(Object.keys(ASSUMPTION_FIXES).sort(), ['addl_medicare_withholding_not_read', 'paid_rows_as_estimates']);
});
