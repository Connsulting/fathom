// H3: the actual unlock sits beside each unavailable comparison.
// AC1: every war-game not-built and invalid code (the war-game table, the entity variants and every
// tax code a household run can block on) resolves to one plain sentence and a rendered control
// whose target exists: an accepted answer shape with a prompt, or an existing upload kind. Every
// literal code the planner emits is in the table. Advisor waits name the answer and open Ask.
// AC2: an option over a contribution limit is dropped on its own, marked with its reason and fix,
// and the rest of the comparison still shows.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { notBuiltReason, WARGAME_UNLOCKS } from '../src/jobs/planner/unlocks.mjs';
import { MISSING_TASK_CODES } from '../src/jobs/triggers/missing-data.mjs';
import { HOWTO } from '../src/ingest/howto.mjs';
import { answerShape } from '../src/jobs/triggers/common.mjs';
import { ADVISOR_KEYS } from '../src/facts/derive.mjs';
import { advisorWait } from '../src/shared/advisor-waits.mjs';
import * as unlocks from '../web/horizon/screens/unlocks.js';
import { planRun } from './helpers/plan.mjs';
import { scratch, addFact, contentValue, SOLE_PROP, INST, MASKS } from './helpers/real-store.mjs';
import { getScenario, wargamePick } from '../src/api/handlers.mjs';

const esc = s => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const unesc = s => s.replaceAll('&quot;', '"').replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
const kit = { esc, T: s => esc(s) };

function controls(html) {
  const found = [...html.matchAll(/<button[^>]*data-tax-gap-fix="([^"]*)"[^>]*>([^<]*)<\/button>/g)];
  return found.map(m => ({ fix: JSON.parse(unesc(m[1])), label: unesc(m[2]) }));
}

function assertTarget(fix, what) {
  assert.ok(fix && typeof fix.label === 'string' && fix.label, `${what}: control has a label`);
  if (fix.screen === 'upload') assert.ok(Object.hasOwn(HOWTO, fix.kind), `${what}: upload kind ${fix.kind} exists`);
  else {
    assert.equal(fix.screen, 'ask', `${what}: control opens Ask or an upload`);
    assert.ok(answerShape(fix.key), `${what}: answer shape ${fix.key} exists`);
    assert.ok(typeof fix.prompt === 'string' && fix.prompt.trim(), `${what}: Ask is prefilled`);
  }
}

function assertUnlock(name, code, entities) {
  const r = notBuiltReason(name, code, entities);
  const what = `${name}/${code}`;
  assert.equal(r.code, code, what);
  assert.ok(typeof r.text === 'string' && r.text.endsWith('.'), `${what}: one plain sentence`);
  assert.doesNotMatch(r.text, /\d/, `${what}: no figures in the reason`);
  if (code !== 'inputs_changed') assert.doesNotMatch(r.text, /inputs changed|could not be computed|household answer it does not have/i, `${what}: names the missing input`);
  assertTarget(r.fix, what);
  assert.equal(r.unlock, r.fix.screen === 'upload' ? 'files' : 'answers', `${what}: unlock follows the fix`);
  const html = unlocks.notBuiltHtml(name, r, kit);
  assert.match(html, new RegExp(`data-not-built="${name}"`), `${what}: rendered card`);
  const [control, ...rest] = controls(html);
  assert.ok(control && !rest.length, `${what}: exactly one control beside the reason`);
  assert.deepEqual(control.fix, r.fix, `${what}: rendered control carries the fix`);
  assert.equal(control.label, r.fix.label, `${what}: control names the fix`);
  return r;
}

test('AC1: every war-game not-built and invalid code resolves to a rendered control whose target exists', () => {
  const entities = [{ slug: 'example-studio', displayName: 'Example Studio', name: 'Example Studio' }, { slug: 'unnamed', displayName: 'Business checking', needsName: true }];
  let n = 0;
  for (const name of ['salary', 'deferral']) {
    for (const code of Object.keys(WARGAME_UNLOCKS[name])) { assertUnlock(name, code, entities); n += 1; }
    // Tax codes a household run blocks on pass through TAX1's fix model.
    for (const code of MISSING_TASK_CODES) { assertUnlock(name, code, entities); n += 1; }
  }
  const classify = assertUnlock('salary', 'entity_unclassified:example-studio', entities);
  assert.match(classify.text, /Example Studio/);
  assert.equal(classify.fix.key, 'business.entities');
  assert.equal(assertUnlock('salary', 'entity_unclassified:unnamed', entities).fix.key, 'accounts.businessEntity');
  assert.equal(assertUnlock('salary', 'scorp_identity_missing', entities).fix.key, 'business.entities');
  // The audit's wrong unlock: last year's Social Security wages are an answer, not a file.
  const prior = assertUnlock('salary', 'retirement.priorYearFicaWages', entities);
  assert.equal(prior.fix.screen, 'ask');
  assert.equal(prior.fix.key, 'retirement.priorYearFicaWages');
  assert.ok(n > 40, `table covers the codes (${n})`);
});

test('AC1: every literal war-game code the planner emits is in the table', () => {
  const wargame = readFileSync(new URL('../src/jobs/planner/wargame.mjs', import.meta.url), 'utf8');
  const figures = readFileSync(new URL('../src/jobs/planner/figures.mjs', import.meta.url), 'utf8');
  const literal = [...wargame.matchAll(/invalid\('([^']+)'\)|invalid: '([^']+)'|excludedCode = '([^']+)'/g)].map(m => m[1] || m[2] || m[3]);
  const assigned = [...figures.matchAll(/wargameInvalid\.(?:salary|deferral) = [^;]*/g)].flatMap(m => [...m[0].matchAll(/'([a-z_.]+)'/g)].map(x => x[1]));
  const codes = new Set([...literal, ...assigned]);
  assert.ok(codes.size >= 8, `found the emitted codes: ${[...codes]}`);
  const known = new Set([...Object.keys(WARGAME_UNLOCKS.salary), ...Object.keys(WARGAME_UNLOCKS.deferral), ...MISSING_TASK_CODES]);
  for (const code of codes) assert.ok(known.has(code), `${code} has an unlock`);
  assert.ok(!codes.has('inputs_changed'), 'the planner names a specific cause instead of inputs_changed');
});

test('AC1: each advisor wait names the answer needed and opens Ask to record it', () => {
  const waits = [...ADVISOR_KEYS].map(advisorWait);
  for (const w of waits) {
    assert.ok(w.text && !/\d/.test(w.text), `${w.key}: plain sentence`);
    assertTarget(w.fix, w.key);
    assert.equal(w.fix.key, w.key, `${w.key}: records the answer for this wait`);
  }
  const html = unlocks.advisorWaitsHtml(waits, kit);
  assert.match(html, /Waiting on your advisor/);
  const rendered = controls(html);
  assert.equal(rendered.length, waits.length);
  assert.deepEqual(rendered.map(c => c.fix.key), waits.map(w => w.key));
  assert.throws(() => advisorWait('household.filingStatus'), /advisor/);
});

// ---------------------------------------------------------------- AC2

const S = scratch('fathom-h3-');
after(() => S.cleanup());
const NOW = '2026-11-05';
const api = (db, params = {}, body = {}) => ({ db, config: { clock: NOW }, params, body });
const ownPlan = (type, amount) => ({ person: 'owner', plan: 'own-corp-401k', type, amount });
const sepFact = (amount, entity) => [{ person: 'owner', plan: 'sep', type: 'employer', amount, ...(entity ? { entity } : {}) }];
const WREN = Object.freeze({ name: 'Wren Studio', type: 'sole_prop', owner: 'owner', income: 10000, expenses: {} });
const WREN_HOUSEHOLD = Object.freeze({
  entities: [WREN, SOLE_PROP],
  hints: { [`${INST.bank}|${MASKS.business}`]: { name: 'Business checking', kind: 'business', owner: null, entity: WREN.name } },
});

function assertExcluded(game, id, what) {
  const x = (game.excluded || []).find(e => e.id === id);
  assert.ok(x, `${what}: ${id} is marked: ${JSON.stringify(game.excluded)}`);
  assert.match(x.invalid, /limit/i, `${what}: ${id} names its reason`);
  assert.doesNotMatch(x.invalid, /\d/);
  assertTarget(x.fix, `${what} ${id}`);
  assert.equal(x.fix.key, 'retirement.contributions');
  const html = unlocks.excludedHtml(game.excluded, kit);
  assert.ok(html.includes(esc(x.invalid)), `${what}: reason rendered`);
  assert.ok(controls(html).some(c => c.fix.key === 'retirement.contributions'), `${what}: fix rendered beside it`);
}

test('AC2: a salary point over its contribution limit is dropped alone and the comparison still shows', async () => {
  const db = await S.store({ variant: { facts: { 'retirement.contributions': [ownPlan('employer', 12000)] } } });
  await planRun(db, { now: NOW });
  const before = contentValue(db, 'wargame').salary.points;
  assert.ok(before.some(p => p.id === 's50'), 'precondition: s50 is offered when valid');
  // Review F1: a pick after s50 must follow its point when s50 is left out.
  const picked = before[before.findIndex(p => p.id === 's50') + 1].id;
  wargamePick(api(db, { name: 'salary' }, { index: picked }));
  // Review F4: a message still quoting a figure of the left-out point.
  db.prepare("INSERT INTO conversations (key, created_at) VALUES ('h3-review', ?)").run(NOW);
  db.prepare("INSERT INTO messages (conversation_key, role, text, ts) VALUES ('h3-review', 'fathom', 'Tax {f:wg.salary.s50.tax}.', ?)").run(NOW);
  addFact(db, 'retirement.contributions', [ownPlan('employer', 14000)]);
  await planRun(db, { now: NOW });
  const stored = contentValue(db, 'wargame').salary;
  assert.equal(stored.unavailable, undefined, 'the game stays a current choice');
  assert.ok(!stored.points.some(p => p.id === 's50'), 's50 is no longer a point');
  assert.ok(stored.points.length >= 2, 'the rest of the comparison still shows');
  assert.ok(stored.points.some(p => p.current), 'the current salary stays');
  assertExcluded(stored, 's50', 'salary');
  const scenario = getScenario(api(db));
  assert.notEqual(scenario.wargame.salary.status, 'unavailable');
  assert.ok(scenario.fig['wg.salary.s50.salary'], 'the dropped point keeps its salary figure for its label');
  assert.equal(scenario.wargame.salary.points[scenario.live.picks.salary].id, picked, 'the stored pick follows its point');
  const quoted = scenario.fig['wg.salary.s50.tax'];
  assert.match(quoted.unavailable, /limit/i, 'a quoted figure of the left-out point says why');
  assert.equal(quoted.unavailableFix?.key, 'retirement.contributions', 'and carries its fix');
  assert.throws(() => wargamePick(api(db, { name: 'salary' }, { index: 's50' })), e => e.status >= 400 && e.status < 500);
});

test('AC2: a deferral option over its contribution limit is dropped alone and the comparison still shows', async () => {
  const db = await S.store({ variant: { ...WREN_HOUSEHOLD, facts: { 'retirement.contributions': sepFact(20000) } } });
  await planRun(db, { now: NOW });
  assert.deepEqual(contentValue(db, 'wargame').deferral.options.map(o => o.id), ['d0', 'd50', 'd100'], 'precondition');
  addFact(db, 'retirement.contributions', sepFact(21000));
  await planRun(db, { now: NOW });
  const stored = contentValue(db, 'wargame').deferral;
  assert.equal(stored.unavailable, undefined, 'the game stays a current choice');
  assert.deepEqual(stored.options.map(o => o.id), ['d0', 'd50']);
  assertExcluded(stored, 'd100', 'deferral');
  assert.equal(stored.excluded.find(e => e.id === 'd100').label, 'Move it all to January');
  assert.throws(() => wargamePick(api(db, { name: 'deferral' }, { index: 'd100' })), e => e.status >= 400 && e.status < 500);
  assert.ok(wargamePick(api(db, { name: 'deferral' }, { index: 'd50' })).scenario, 'a remaining option can still be picked');
});

// The main tax run treats a refundable child tax credit it cannot model as a precision gap; a war
// game did not, and offered an upload that could not unlock it.
test('AC1: a child tax credit limited to income tax is an assumption, not a dead-end hold', async () => {
  const db = await S.store({ variant: { entities: [SOLE_PROP] } });
  await planRun(db, { now: NOW });
  const wg = contentValue(db, 'wargame');
  assert.equal(wg.notBuilt?.deferral, undefined, `deferral is built: ${JSON.stringify(wg.notBuilt)}`);
  assert.ok(wg.deferral.options.length >= 2);
  const scenario = getScenario(api(db));
  assert.ok(scenario.fig[`wg.deferral.${wg.deferral.options[0].id}.tax2026`].notes.some(n => /child tax credit/i.test(n)), 'the comparison says what it leaves out');
});

// Review F2: a middle of the range over its limit is not a reference; the allowed point nearest it is.
test('AC2: an over-limit middle of the range measures against the nearest allowed salary', async () => {
  const db = await S.store({ variant: { facts: { 'business.salaryRange': { min: 70000, max: 130000 }, 'retirement.contributions': [ownPlan('employer', 27000)] } } });
  await planRun(db, { now: NOW });
  const wg = contentValue(db, 'wargame');
  assert.ok(wg.salary, `the salary game is built: ${JSON.stringify(wg.notBuilt)} ${wg.salary?.unavailable}`);
  assert.equal(wg.salary.unavailable, undefined);
  assert.deepEqual(wg.salary.points.map(p => p.id), ['s115', 's130']);
  assert.ok(wg.salary.excluded.some(e => e.id === 's100'));
  assert.equal(wg.salary.points.find(p => p.id === 's115').y, 0, 'the nearest allowed salary is the reference');
  assert.match(wg.salary.yLabel, /nearest the middle/);
  assert.match(wg.salary.question, /nearest the middle/);
});

// Review F3: an advisor wait shows beside optional estimate improvements, not under them.
test('AC1: advisor waits stay visible on a rec that also has estimate gaps', async () => {
  const blocker = await import('../web/horizon/screens/rec-blocker.js');
  blocker.bind(kit);
  const r = { id: 'r', status: 'waiting', waitingOn: 'advisor', advisorWaits: [advisorWait('retirement.planTermsConfirmed')],
    gaps: [{ message: 'A gap.', action: { screen: 'upload', kind: 'taxforms', label: 'Upload a clearer tax form' } }] };
  const html = blocker.html(r, 'plan');
  assert.match(html, /Waiting on your advisor/);
  assert.match(html, /Optional estimate improvements/);
  assert.deepEqual(controls(html).map(c => c.fix.key || c.fix.kind), ['retirement.planTermsConfirmed', 'taxforms']);
});
