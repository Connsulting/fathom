// H3 AC3: an advisor wait names the answer needed, and recording the advisor's answer through Ask
// (scripted engine, the answer.fact path) clears the wait on the next plan, with a receipt whose
// Undo brings the wait back.

import test from 'node:test';
import assert from 'node:assert/strict';
import { scratch, householdOf, SCORP } from './helpers/real-store.mjs';
import { planRun } from './helpers/plan.mjs';
import { getFacts } from '../src/store/facts.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { callTool } from '../src/tools/index.mjs';
import { createEngine } from '../src/engine/index.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { threadCreate } from '../src/api/handlers.mjs';
import * as rec from '../web/horizon/screens/rec-blocker.js';

const NOW = '2026-11-05';
const esc = s => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const waitingOnAdvisor = db => buildScenario(db).recs.filter(r => r.status === 'waiting' && r.waitingOn === 'advisor');

test('AC3: recording the advisor answer through Ask clears the wait on the next plan, and Undo restores it', async t => {
  const s = scratch('fathom-h3-advisor-');
  t.after(() => s.cleanup());
  const db = await s.store({ variant: { entities: [SCORP], facts: {
    'retirement.planTermsConfirmed': undefined, 'retirement.aggregationConfirmed': true,
  } } });
  await planRun(db, { now: NOW });
  const waiting = waitingOnAdvisor(db).filter(r => r.advisorQuestions?.includes('retirement.planTermsConfirmed'));
  assert.ok(waiting.length, `a rec waits on the advisor's plan terms answer: ${JSON.stringify(buildScenario(db).recs.map(r => [r.id, r.status, r.waitingOn]))}`);
  const r = waiting[0];
  const w = r.advisorWaits?.find(x => x.key === 'retirement.planTermsConfirmed');
  assert.ok(w, 'the wait names the answer needed');
  assert.equal(w.fix.screen, 'ask');
  assert.equal(w.fix.key, 'retirement.planTermsConfirmed');
  rec.bind({ esc });
  const html = rec.html(r, 'plan');
  assert.match(html, /Waiting on your advisor/);
  assert.ok(html.includes(esc(w.text)), 'the rendered wait names the answer');
  assert.match(html, /data-tax-gap-fix=/, 'one control records it');
  assert.match(buildScenario(db).wargame.salary.takeaway, /plan terms.*pending/i, 'precondition: the salary game assumes the pending answer');

  const text = 'Yes, my advisor confirmed my retirement plan terms and eligibility.';
  const transport = createEngine({ mode: 'fake' });
  const engine = { mode: 'live', isOn: () => true, call: request => request.purpose === 'title'
    ? Promise.resolve({ text: 'Advisor answer', toolResults: [] })
    : transport.call({ ...request, fake: [{ toolCalls: [{ name: 'answer', args: {
      operation: 'fact', key: 'retirement.planTermsConfirmed', value: true, evidence: text,
    } }] }, { text: 'Saved your advisor answer.' }] }) };
  const root = householdOf(db).root;
  const answerer = createLiveAnswerer({ engine, root, services: { ...householdOf(db).services, engine, config: { dataDir: root } } });
  const out = await threadCreate({ db, config: {}, identity: { id: 'synthetic-owner' }, scheduler: { runNow: () => planRun(db, { now: NOW }) }, answerer, body: { text } });
  assert.equal(getFacts(db)['retirement.planTermsConfirmed'], true, 'Ask recorded the answer');
  const receipts = buildScenario(db).live.conversations[out.thread.key].flatMap(m => m.provenance?.actions || []);
  assert.equal(receipts.length, 1, 'one receipt for the answer');
  await planRun(db, { now: NOW });
  assert.ok(!waitingOnAdvisor(db).some(x => x.id === r.id), 'the wait cleared on the next plan');
  assert.doesNotMatch(buildScenario(db).wargame.salary.takeaway, /plan terms.*pending/i, 'the salary game no longer assumes it');

  await callTool('undo', { operation: 'undo', id: receipts[0].id }, { db, clock: NOW, now: `${NOW}T12:00:00Z`, actorId: 'synthetic-owner', channel: 'mcp', scopes: ['write:facts'] });
  await planRun(db, { now: NOW });
  assert.equal(getFacts(db)['retirement.planTermsConfirmed'], undefined, 'Undo removed the answer');
  assert.ok(waitingOnAdvisor(db).some(x => x.id === r.id), 'Undo brings the wait back');
});
