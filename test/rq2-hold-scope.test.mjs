// RQ2: a hold or gap shows only on the rec that reads the missing input. Every trigger declares the
// inputs its action reads (src/shared/rec-inputs.mjs maps each gap and block code to the inputs it
// affects); a rec carries only the gaps on its own inputs, a trigger blocks only on a code it reads,
// and each applicable gap renders as one line naming its fix. Every household, employer and amount
// here is synthetic.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { triggers } from '../src/jobs/triggers/index.mjs';
import { evaluate as evaluateRule } from '../src/packs/index.mjs';
import { TAX_GAP_RULES, taxGap } from '../src/shared/tax-gaps.mjs';
import { inputsOf, reads, gapsFor, blockedFor, figureInputs, INPUTS, TRIGGER_INPUTS } from '../src/shared/rec-inputs.mjs';
import * as recBlocker from '../web/horizon/screens/rec-blocker.js';
import { planRun } from './helpers/plan.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { scratch, paystubDoc, figureRow } from './helpers/real-store.mjs';

const NOW = '2026-11-05';
const S = scratch('fathom-rq2-scope-');
after(() => S.cleanup());

const KNOWN = new Set(['income', 'retirement', 'payments', 'filing', 'va', 'credits', 'hsa', 'ages']);
// Codes a trigger can block on besides the tax gap rules.
const BLOCK_CODES = ['mfs_unsupported', 'entity_unclassified', 'k1_unmatched', 'k1_scorp_unmatched', 'partnership_incomplete',
  'retirement_contribution_unattributed', 'calc_failed', 'va_itemized_missing', 'household.birthYears', 'ira_room_missing',
  'scorp_identity_missing', 'tax_payments', 'pnl'];
const CODES = [...new Set([...Object.keys(TAX_GAP_RULES), ...BLOCK_CODES])];
const DECLARING = triggers.filter(t => t.id !== 'missing-data');
const byId = id => triggers.find(t => t.id === id);
const disjoint = (a, b) => !a.some(x => b.includes(x));
const kit = { esc: s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`), snoozeLabel: () => 'Nov 19', recById: () => null, draw() {}, api: {} };
// A gap for any code: the tax gap rule when one exists, else a plain gap with an Ask fix.
const gapOf = code => (Object.hasOwn(TAX_GAP_RULES, code.split(':')[0]) ? taxGap(code, { employer: 'Cedar Labs' })
  : { code, employer: null, person: null, message: `Synthetic hold ${code}.`, action: { screen: 'ask', key: 'synthetic.key', label: 'Fix it', prompt: 'Synthetic.' }, rough: false, impact: null });
const LINE = /<p class="h-gap-ref" data-gap-ref="([^"]+)">[\s\S]*?<\/p>/g;

recBlocker.bind(kit);

// ---------------------------------------------------------------- AC3: declared inputs, table over every trigger

test('every trigger declares frozen inputs from the known set, from the one shared map', () => {
  for (const t of triggers) {
    assert.ok(Array.isArray(t.inputs), `${t.id} declares inputs`);
    assert.ok(Object.isFrozen(t.inputs), `${t.id} inputs are frozen`);
    assert.equal(t.inputs, TRIGGER_INPUTS[t.id], `${t.id} exports its shared declaration`);
    for (const name of t.inputs) assert.ok(KNOWN.has(name), `${t.id}: ${name} is a known input`);
  }
  assert.deepEqual(Object.keys(TRIGGER_INPUTS).sort(), triggers.map(t => t.id).sort());
  assert.deepEqual([...INPUTS].sort(), [...KNOWN].sort());
  // Missing data lists every gap itself; a new child reads cash and a date, no tax input.
  assert.deepEqual(byId('missing-data').inputs, []);
  assert.deepEqual(byId('new-child').inputs, []);
});

test('every tax gap rule and every blocking code maps to known inputs; suffixed codes map like their base', () => {
  for (const code of CODES) {
    const inputs = inputsOf(code);
    assert.ok(Array.isArray(inputs) && inputs.length > 0, `${code} affects at least one input`);
    for (const name of inputs) assert.ok(KNOWN.has(name), `${code}: ${name} is a known input`);
  }
  assert.deepEqual(inputsOf('entity_unclassified:northwind-advisory'), inputsOf('entity_unclassified'));
  assert.ok(inputsOf('paystub_ytd_missing').includes('income'));
  assert.ok(inputsOf('mfs_unsupported').includes('filing'));
  assert.ok(inputsOf('va_itemized_missing').includes('va'));
  assert.ok(inputsOf('tax_year_unconfirmed').includes('payments'));
  assert.ok(inputsOf('household.birthYears').includes('ages'));
  for (const name of ['retirement', 'hsa']) assert.ok(inputsOf('w2_box12_unreadable').includes(name), `w2_box12_unreadable affects ${name}`);
  for (const name of ['income', 'retirement', 'filing']) assert.ok(inputsOf('calc_failed').includes(name), `a household calc_failed affects ${name}`);
});

test('declarations match what each action reads', () => {
  const has = (id, ...names) => names.forEach(n => assert.ok(byId(id).inputs.includes(n), `${id} reads ${n}`));
  const lacks = (id, ...names) => names.forEach(n => assert.ok(!byId(id).inputs.includes(n), `${id} does not read ${n}`));
  // Household tax figures are one run that reads income, retirement and filing.
  for (const id of ['fed-q4-estimate', 'va-q4-estimate', 'year-end-retirement', 'scorp-salary', 'invoice-deferral', 'backdoor-roth', 'va529']) has(id, 'income', 'retirement', 'filing');
  // Virginia figures start from federal AGI; the war games need Virginia tax too.
  for (const id of ['va-q4-estimate', 'va529', 'scorp-salary', 'invoice-deferral']) has(id, 'va');
  has('fed-q4-estimate', 'payments', 'credits');
  has('va-q4-estimate', 'payments');
  for (const t of DECLARING) {
    if (!['fed-q4-estimate', 'va-q4-estimate'].includes(t.id)) lacks(t.id, 'payments');
    if (t.id !== 'fed-q4-estimate') lacks(t.id, 'credits');
  }
  lacks('hsa-room', 'income');
  // Bunching compares recorded gifts with the filing-status standard deduction; it reads no income.
  assert.deepEqual(byId('charitable-bunching').inputs, ['filing']);
  // IRA and solo 401(k) catch-up room follow birth years.
  has('backdoor-roth', 'ages');
  has('solo401k-setup', 'income', 'retirement', 'ages');
});

test('figure inputs: each household figure reads only what it is computed from; an unknown key reads everything', () => {
  const fig = key => figureInputs(key);
  assert.deepEqual([...fig('room.hsa')].sort(), ['ages', 'hsa']);
  for (const key of ['room.solo401k', 'room.solo401k.employee', 'room.sep']) assert.deepEqual([...fig(key)].sort(), ['ages', 'income', 'retirement'], key);
  assert.ok(fig('room.ira.owner').includes('filing'));
  assert.deepEqual([...fig('inc.ytd.w2')], ['income']);
  assert.deepEqual([...fig('va529.deductionLeft')].sort(), ['ages', 'va']);
  assert.ok(fig('va529.taxSaved').includes('va') && fig('va529.taxSaved').includes('income'));
  for (const key of ['tax.fed.proj', 'sh.fed.required', 'agi.est', 'tax.va.proj', 'wg.salary.s50.x']) assert.ok(fig(key).includes('income'), key);
  assert.ok(fig('tax.fed.proj').includes('credits') && !fig('tax.fed.proj').includes('payments') && !fig('tax.fed.proj').includes('va'));
  assert.ok(fig('sh.fed.required').includes('payments') && fig('sh.va.required').includes('payments'));
  assert.ok(fig('tax.va.proj').includes('va') && !fig('tax.va.proj').includes('credits'));
  assert.equal(fig('some.future.key'), INPUTS);
});

test('for every trigger and code: gaps and blocks apply exactly when the code affects a declared input', () => {
  for (const t of DECLARING) {
    for (const code of CODES) {
      const gap = gapOf(code);
      const read = !disjoint(inputsOf(code), t.inputs);
      assert.equal(reads(t, code), read, `${t.id} reads ${code}: ${read}`);
      const gaps = gapsFor(t, [gap]);
      assert.equal(gaps.length, read ? 1 : 0, `${t.id} carries ${code}: ${read}`);
      assert.equal(blockedFor({ info: { blocked: [code] } }, t), read ? code : null, `${t.id} blocks on ${code}: ${read}`);
      const html = recBlocker.html({ id: t.id, status: 'proposed', gaps }, 'plan');
      if (!read) assert.equal(html, '', `${t.id} renders nothing for ${code}`);
      else assert.deepEqual([...html.matchAll(LINE)].map(m => m[1]), [code], `${t.id} renders ${code} as one line`);
    }
    // Several held codes: the first one this trigger reads, else none.
    const unread = CODES.filter(c => !reads(t, c));
    const read = CODES.filter(c => reads(t, c));
    if (unread.length && read.length) assert.equal(blockedFor({ info: { blocked: [unread[0], read[0]] } }, t), read[0]);
    assert.equal(blockedFor({ info: { blocked: [] } }, t), null);
  }
});

test('Decision 3: each applicable gap renders as one line with its fix; a waiting blocker shows only while waiting', () => {
  const gaps = [taxGap('paystub_ytd_missing', { employer: 'Cedar Labs' }), taxGap('w2_box12_unreadable', { employer: 'Juniper Studio' })];
  const html = recBlocker.html({ id: 'fed-q4-estimate', status: 'proposed', gaps }, 'dialog');
  assert.equal(html.match(/Optional estimate improvements/g)?.length, 1);
  const lines = [...html.matchAll(LINE)];
  assert.deepEqual(lines.map(m => m[1]), ['paystub_ytd_missing', 'w2_box12_unreadable']);
  assert.match(lines[0][0], /Cedar Labs/);
  assert.match(lines[0][0], /data-tax-gap-fix/);
  assert.match(lines[0][0], /Enter year-to-date pay/);
  assert.match(lines[1][0], /Upload a clearer tax form/);
  const blocker = { code: 'mfs_unsupported', text: 'Synthetic hold text.', task: 'Synthetic task', link: 'ask' };
  assert.equal(recBlocker.html({ id: 'fed-q4-estimate', status: 'proposed', blocker }, 'plan'), '');
  assert.equal(recBlocker.html({ id: 'fed-q4-estimate', status: 'done', blocker }, 'plan'), '');
  assert.match(recBlocker.html({ id: 'fed-q4-estimate', status: 'waiting', blocker }, 'plan'), /Waiting on/);
  assert.doesNotMatch(recBlocker.html({ id: 'fed-q4-estimate', status: 'proposed', gaps, blocker }, 'plan'), /Waiting on/);
});

// ---------------------------------------------------------------- AC3: a trigger never blocks on a code it does not read

const NEUTRAL_NAMES = { owner: 'You', spouse: 'Your spouse' };
const fig = v => ({ v, kind: 'm', label: 'Synthetic figure', src: 'calc:synthetic' });
// Facts that open every trigger that checks the household hold; the figures leave nothing to size.
function heldCtx(blocked) {
  return {
    clock: NOW, year: 2026,
    facts: { 'income.sCorp': true, 'household.state': 'VA', 'accounts.has529': true, 'retirement.solo401k': true, 'retirement.backdoorRothCandidate': true },
    owner: {}, fig: { 'room.ira.owner': fig(0) }, names: { ...NEUTRAL_NAMES }, model: {}, data: { accounts: [] }, packs: [], packStatus: {},
    info: { blocked, confirm: {}, calcFailed: [], gaps: [], persons: ['owner'], ira: {}, va529: { accounts: 1, missing: [], answersMissing: [], ageMissing: [], age70: [], eligible: 1 } },
    freshness: [], warnings: [], entities: [],
  };
}
// The steps evaluateCatalog takes up to its blocked state.
function stateOf(t, ctx) {
  if (!evaluateRule(t.gate, ctx.facts)) return { state: 'none' };
  if (t.needsYear && !ctx.year) return { state: 'none' };
  const window = t.window(ctx);
  if (window && window.close < ctx.clock) return { state: 'none' };
  const out = t.evaluate(ctx);
  if (out?.blocked) return { state: 'blocked', reason: out.blocked };
  return { state: out ? 'hit' : 'none' };
}

test('with info.blocked holding a code outside a trigger inputs, that trigger is never blocked; inside, it blocks on it', () => {
  const holdReaders = ['fed-q4-estimate', 'va-q4-estimate', 'year-end-retirement', 'scorp-salary', 'invoice-deferral', 'backdoor-roth', 'va529'];
  for (const t of DECLARING) {
    for (const code of CODES) {
      const res = stateOf(t, heldCtx([code]));
      if (!reads(t, code)) assert.notEqual(res.state, 'blocked', `${t.id} is not held by ${code} (${res.reason})`);
      else if (holdReaders.includes(t.id)) assert.deepEqual(res, { state: 'blocked', reason: code }, `${t.id} is held by ${code}`);
    }
  }
});

// ---------------------------------------------------------------- AC2: the real planner, one gap shared by several recs

test('AC2: recs that read a gapped input show it once with its fix; a rec that does not shows nothing about it', async () => {
  const cedar = paystubDoc({ employerName: 'Cedar Labs', person: 'spouse', relation: 'outside', payDate: '2026-10-31', net: 1600, state: 'VA', confidence: 0.5 });
  const db = await S.store({ variant: { payroll: [cedar] } });
  await planRun(db, { now: NOW });
  const scenario = buildScenario(db, { clock: NOW });
  const code = 'paystub_ytd_missing';
  const affected = inputsOf(code);
  const present = scenario.recs.filter(r => byId(r.id) && r.id !== 'missing-data' && !['hidden', 'dismissed'].includes(r.status));
  const ids = present.map(r => `${r.id}:${r.status}`).join(', ');
  const readers = present.filter(r => !r.question?.primary && !disjoint(byId(r.id).inputs, affected));
  const others = present.filter(r => r.question?.primary || disjoint(byId(r.id).inputs, affected));
  assert.ok(readers.length >= 2, `at least two recs read the gapped input (${ids})`);
  assert.ok(others.some(r => r.id === 'hsa-room'), `hsa-room, which does not read income, is on the plan (${ids})`);
  for (const r of readers) {
    assert.ok(r.gaps?.some(g => g.code.startsWith(code)), `${r.id} carries the gap`);
    for (const g of r.gaps) assert.ok(reads(byId(r.id), g.code), `${r.id} carries only gaps it reads (${g.code})`);
    for (const surface of ['plan', 'dialog']) {
      const html = recBlocker.html(r, surface);
      assert.match(html, /Optional estimate improvements/);
      const lines = [...html.matchAll(LINE)];
      assert.equal(lines.length, r.gaps.length, `${r.id}: one line per gap`);
      const mine = lines.filter(m => m[1].startsWith(code));
      assert.equal(mine.length, 1, `${r.id}: the shared gap is one line`);
      assert.match(mine[0][0], /Cedar Labs/);
      assert.match(mine[0][0], /Enter year-to-date pay/);
      assert.match(mine[0][0], /data-tax-gap-fix/);
    }
  }
  for (const r of others) {
    assert.ok(!r.gaps?.some(g => g.code.startsWith(code)), `${r.id} does not carry the gap`);
    const html = recBlocker.html(r, 'plan');
    assert.doesNotMatch(html, /Cedar Labs|year-to-date pay/, `${r.id} shows nothing about the gap`);
    assert.doesNotMatch(html, /Waiting on/, `${r.id} shows no hold`);
  }
  assert.match(JSON.stringify(scenario.recs.find(r => r.id === 'missing-data')), /income\.payrollYtd/, 'missing-data still lists every gap');

  // R1-3: charitable bunching reads gifts and the filing status, so the wage gap is not on it.
  const bunching = present.find(r => r.id === 'charitable-bunching');
  assert.ok(bunching, `charitable-bunching is on the plan (${ids})`);
  assert.equal(bunching.gaps, undefined);
  assert.equal(recBlocker.html(bunching, 'plan'), '');
  assert.equal(recBlocker.html(bunching, 'dialog'), '');

  // R1-2: figures too. HSA room is computed from HSA inputs only: complete, no gap, no partial
  // label. Federal tax reads wages and carries the gap.
  const hsa = figureRow(db, 'room.hsa');
  assert.ok(hsa, 'room.hsa is produced');
  assert.equal(hsa.locator.completeness, 'complete');
  assert.deepEqual(hsa.locator.gaps, []);
  assert.equal(hsa.locator.partial, false);
  assert.equal(hsa.locator.rough, false);
  assert.doesNotMatch(hsa.label, /partial/i);
  assert.ok(!(hsa.locator.notes || []).some(n => /Cedar Labs/.test(n)));
  const fed = figureRow(db, 'tax.fed.proj');
  assert.ok(fed.locator.gaps.some(g => g.code.startsWith(code)));
  assert.equal(fed.locator.partial, true);
  assert.match(fed.label, /partial/i);
  assert.match(fed.locator.completeness, /^estimate with/);
  assert.equal(scenario.fig['room.hsa'].partial ?? false, false, 'the scenario figure is not partial');
});
