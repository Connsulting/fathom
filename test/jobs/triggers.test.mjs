// The trigger catalog as a static contract (AC4) and the statutory constants it cites (AC3):
// every module exports the frozen interface, gates are valid rules that tolerate absent facts,
// calculators and knowledge-base entries exist, and every LAW amount is stated verbatim in the
// pack entry it cites.

import test from 'node:test';
import assert from 'node:assert/strict';
import { triggers } from '../../src/jobs/triggers/index.mjs';
import { LAW, lawContent, pctContent } from '../../src/jobs/planner/law.mjs';
import * as calc from '../../src/calc/index.mjs';
import { evaluate, loadPacks, getEntry } from '../../src/packs/index.mjs';
import { PACKS_DIR } from '../helpers/real-store.mjs';

const CATALOG = [
  'fed-q4-estimate', 'va-q4-estimate', 'year-end-retirement', 'solo401k-setup', 'scorp-salary', 'invoice-deferral',
  'hsa-room', 'va529', 'charitable-bunching', 'backdoor-roth', 'dependent-care-fsa', 'new-child', 'missing-data',
];
const DOMAIN_TRIGGER = {
  'fed-q4-estimate': ['tax', 'calendar'], 'va-q4-estimate': ['tax', 'calendar'],
  'year-end-retirement': ['retirement', 'calendar'], 'solo401k-setup': ['retirement', 'calendar'],
  'scorp-salary': ['business', 'income'], 'invoice-deferral': ['business', 'calendar'],
  'hsa-room': ['retirement', 'calendar'], va529: ['family', 'calendar'],
  'charitable-bunching': ['giving', 'goal'], 'backdoor-roth': ['retirement', 'goal'],
  'dependent-care-fsa': ['family', 'calendar'], 'new-child': ['family', 'life'], 'missing-data': ['data', 'calendar'],
};
const packs = loadPacks([PACKS_DIR]);
const packIds = new Set(packs.map(p => p.id));
const byId = Object.fromEntries(triggers.map(t => [t.id, t]));
const money = v => `$${Number(v).toLocaleString('en-US')}`;

test('AC4: triggers is an ordered array covering the thirteen catalog ids, unique', () => {
  assert.ok(Array.isArray(triggers));
  const ids = triggers.map(t => t.id);
  assert.equal(new Set(ids).size, ids.length, 'ids unique');
  assert.deepEqual([...ids].sort(), [...CATALOG].sort());
  assert.ok(!ids.includes('stale-data'), 'stale-data was renamed to missing-data');
});

test('AC4: every trigger module exports the frozen interface', () => {
  for (const t of triggers) {
    for (const k of ['id', 'domain', 'trigger']) assert.equal(typeof t[k], 'string', `${t.id}.${k}`);
    for (const k of ['packs', 'calcs', 'kb']) assert.ok(Array.isArray(t[k]), `${t.id}.${k} is an array`);
    assert.ok(t.gate && typeof t.gate === 'object', `${t.id}.gate`);
    for (const k of ['window', 'evaluate', 'build', 'template']) assert.equal(typeof t[k], 'function', `${t.id}.${k}`);
  }
});

test('AC4: domain and trigger class match the catalog table', () => {
  for (const [id, [domain, trigger]] of Object.entries(DOMAIN_TRIGGER)) {
    assert.equal(byId[id].domain, domain, `${id} domain`);
    assert.equal(byId[id].trigger, trigger, `${id} trigger`);
  }
});

test('AC4: every gate is a valid rule that evaluates against the empty fact set without throwing (R11)', () => {
  for (const t of triggers) {
    let out;
    assert.doesNotThrow(() => { out = evaluate(t.gate, {}); }, `${t.id} gate`);
    assert.equal(typeof out, 'boolean');
  }
  assert.equal(evaluate(byId['missing-data'].gate, {}), true, 'missing-data has no gate');
  assert.equal(evaluate(byId['fed-q4-estimate'].gate, {}), false, 'business gate is false with no facts');
});

test('AC4: gates follow the catalog for the facts that open them', () => {
  const t = (id, facts) => evaluate(byId[id].gate, facts);
  assert.equal(t('fed-q4-estimate', { 'income.sCorp': true }), true);
  assert.equal(t('fed-q4-estimate', { 'income.partnership': true }), true);
  assert.equal(t('va-q4-estimate', { 'income.sCorp': true }), false, 'Virginia needs the state');
  assert.equal(t('va-q4-estimate', { 'income.sCorp': true, 'household.state': 'VA' }), true);
  assert.equal(t('solo401k-setup', { 'income.sCorp': true }), true, 'absent plan counts as no plan');
  assert.equal(t('solo401k-setup', { 'income.sCorp': true, 'retirement.solo401k': false }), true);
  assert.equal(t('solo401k-setup', { 'income.sCorp': true, 'retirement.solo401k': true }), false);
  assert.equal(t('va529', { 'accounts.has529': true, 'household.state': 'VA' }), true);
  assert.equal(t('va529', { 'accounts.has529': true, 'household.state': 'MD' }), false);
  assert.equal(t('dependent-care-fsa', { 'household.dependents': 1, 'income.w2': true }), true);
  assert.equal(t('dependent-care-fsa', { 'household.dependents': 1 }), false);
  assert.equal(t('dependent-care-fsa', { 'household.expectingChild': true, 'income.w2': true }), true);
  assert.equal(t('new-child', { 'household.expectingChild': true }), true);
  assert.equal(t('backdoor-roth', { 'retirement.backdoorRothCandidate': true }), true);
  assert.equal(t('hsa-room', { 'benefits.hsa': true }), true);
  assert.equal(t('charitable-bunching', { 'giving.charitable': true }), true);
  assert.equal(t('scorp-salary', { 'income.selfEmployed': true }), false);
});

test('AC4: calcs name functions exported by src/calc', () => {
  for (const t of triggers) {
    for (const name of t.calcs) assert.equal(typeof calc[name], 'function', `${t.id} cites calculator ${name}`);
  }
  for (const name of ['payrollTax', 'solo401kRoom', 'federalIncomeTax', 'qbiDeduction', 'selfEmploymentTax', 'virginiaIncomeTax']) {
    assert.ok(byId['scorp-salary'].calcs.includes(name), `scorp-salary cites ${name} (T9.7)`);
  }
  assert.ok(byId['fed-q4-estimate'].calcs.includes('estimatedPaymentSafeHarbor'));
  assert.ok(byId['hsa-room'].calcs.includes('hsaLimit'));
});

test('AC4: packs and kb entries exist in the loaded packs', () => {
  for (const t of triggers) {
    for (const p of t.packs) assert.ok(packIds.has(p), `${t.id} pack ${p} is loaded`);
    for (const k of t.kb) {
      assert.ok(k && typeof k.pack === 'string' && typeof k.entry === 'string', `${t.id} kb item shape`);
      assert.ok(getEntry(packs, k.pack, k.entry), `${t.id} kb ${k.pack}/${k.entry} exists`);
    }
  }
  assert.ok(byId['year-end-retirement'].kb.length + byId['hsa-room'].kb.length > 0, 'retirement triggers cite the knowledge base');
});

test('AC3: every LAW constant is cited: pack amounts appear verbatim in their entry, calc amounts match TAX_2026', () => {
  const keys = Object.keys(LAW);
  assert.ok(keys.length >= 20, 'law table populated');
  for (const [key, c] of Object.entries(LAW)) {
    assert.equal(typeof c.v, 'number', `${key}.v`);
    assert.equal(typeof c.label, 'string', `${key}.label`);
    if (c.pack) {
      const entry = getEntry(packs, c.pack, c.entry);
      assert.ok(entry, `${key} cites ${c.pack}/${c.entry}`);
      assert.ok(entry.body.includes(money(c.v)), `${key}: ${money(c.v)} stated in ${c.pack}/${c.entry}`);
    } else {
      assert.equal(typeof c.calc, 'string', `${key} cites a pack entry or a calculator parameter`);
      const v = c.calc.split('.').reduce((o, part) => (o == null ? o : o[part]), calc.TAX_2026);
      assert.equal(v, c.v, `${key} equals TAX_2026.${c.calc}`);
    }
  }
});

test('AC3: LAW pins the statutory values the plan names (T9.6)', () => {
  const pinned = {
    stdDeductionMfj: 32200, stdDeductionSingle: 16100, stdDeductionHoh: 24150, vaStdDeductionMfj: 17500,
    vaStdDeductionSingle: 8750, va529Cap: 4000, iraLimit: 7500, iraCatchUp: 1100, rothPhaseOutStartMfj: 242000,
    rothPhaseOutEndMfj: 252000, rothPhaseOutStartSingle: 153000, rothPhaseOutEndSingle: 168000, rothPhaseOutEndMfs: 10000,
    vaEstimateThreshold: 1000, deferral: 24500, hsaSelf: 4400, hsaFamily: 8750, dcfsaCap: 7500,
    ctcPerChild: 2200, ctcThresholdMfj: 400000, ctcThresholdOther: 200000,
  };
  for (const [k, v] of Object.entries(pinned)) assert.equal(LAW[k] && LAW[k].v, v, k);
  assert.deepEqual([LAW.iraCatchUp.pack, LAW.iraCatchUp.entry], ['advanced-retirement', 'backdoor-roth']);
  assert.deepEqual([LAW.ctcPerChild.pack, LAW.ctcPerChild.entry], ['kids-dependents', 'child-tax-credit']);
});

test('AC3: lawContent maps keys to values and pctContent is the pinned percent set', () => {
  const law = lawContent();
  for (const [k, c] of Object.entries(LAW)) assert.equal(law[k], c.v, k);
  assert.deepEqual(pctContent(), {
    fedSafeHarborCurrent: 90, fedSafeHarborPrior: 100, fedSafeHarborPriorHigh: 110,
    vaSafeHarborCurrent: 90, vaSafeHarborPrior: 100, vaTopRate: 5.75,
  });
});
