// Engine screen "Run plan now" control and the SimpleFIN network message that points at the next
// scheduled sync. Pure view helpers: no DOM, no server.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../web/horizon/screens/engine.js';
import { problemText } from '../web/horizon/screens/simplefin.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

test('the control offers Run plan now, enabled when no plan is running', () => {
  engine.bind({ esc });
  engine.reset();
  const html = engine.planControl();
  assert.match(html, /<button[^>]*data-fx-plan-run[^>]*>Run plan now<\/button>/);
  assert.doesNotMatch(html, /disabled/);
});

test('while a plan runs the button is disabled and says so', () => {
  engine.bind({ esc });
  engine.setPlanState({ phase: 'running' });
  const html = engine.planControl();
  assert.match(html, /<button[^>]*data-fx-plan-run[^>]*disabled/);
  assert.match(html, /Running the plan/);
  engine.reset();
});

test('a finished run reads as done and a failed run says what failed in plain words', () => {
  assert.deepEqual(engine.planOutcome({ run: { status: 'ok' } }, ''), { phase: 'done', text: 'Plan finished. Recommendations and figures are up to date.' });
  const failed = engine.planOutcome({ run: { status: 'error', errorClass: 'planner_error' } }, '');
  assert.equal(failed.phase, 'failed');
  assert.match(failed.text, /^The plan run failed\./);
  const refused = engine.planOutcome(null, 'that job is already running');
  assert.equal(refused.phase, 'failed');
  assert.match(refused.text, /already running/);
  const unknown = engine.planOutcome(null, 'Something odd');
  assert.equal(unknown.phase, 'failed');
  assert.match(unknown.text, /The plan did not run\. Something odd/);
});

test('a demo household says planning runs on real households', () => {
  const out = engine.planOutcome(null, 'planning runs on real stores only');
  assert.equal(out.phase, 'skipped');
  assert.match(out.text, /Planning runs on real households/);
});

test('the rendered status carries the phase and the text', () => {
  engine.bind({ esc });
  engine.setPlanState({ phase: 'skipped', text: 'Planning runs on real households. This demo household skips it.' });
  const html = engine.planControl();
  assert.match(html, /data-plan-phase="skipped"/);
  assert.match(html, /Planning runs on real households/);
  assert.doesNotMatch(html, /<button[^>]*data-fx-plan-run[^>]*disabled/);
  engine.reset();
});

const JOBS = [{ id: 'plan', next: 'Mon, Nov 9, 2:00 AM' }, { id: 'simplefin-sync', next: 'Mon, Nov 9, 5:00 AM' }];

test('a network failure says the bridge did not answer in time and names the next scheduled sync', () => {
  const text = problemText('network', JOBS);
  assert.match(text, /SimpleFIN bridge did not answer in time/);
  assert.match(text, /next scheduled sync/);
  assert.match(text, /Mon, Nov 9, 5:00 AM/);
  assert.doesNotMatch(text, /Run plan now|button/i);
});

test('without a known next sync the network message still reads whole', () => {
  const text = problemText('network', []);
  assert.match(text, /SimpleFIN bridge did not answer in time/);
  assert.match(text, /next scheduled sync\.$/);
});

test('other problems keep their wording', () => {
  assert.match(problemText('revoked', JOBS), /refused access/);
  assert.match(problemText('mystery', JOBS), /last sync failed/);
});

// H2 AC4: a scheduled plan (or one started from another tab) disables Run plan now through the
// shared service status, and a paused sync never promises a retry date.

const withPlan = (plan) => ({ s: { live: { services: { jobs: { plan } } } } });

test('while a scheduled plan runs the button is disabled and says a plan is running', () => {
  engine.bind({ esc, api: withPlan({ key: 'job:plan', running: true, state: 'healthy' }) });
  engine.reset();
  const html = engine.planControl();
  assert.match(html, /<button[^>]*data-fx-plan-run[^>]*disabled/);
  assert.match(html, /A plan is running/);
  engine.reset();
});

test('when no plan runs on the server the button is enabled', () => {
  engine.bind({ esc, api: withPlan({ key: 'job:plan', running: false, state: 'healthy' }) });
  engine.reset();
  const html = engine.planControl();
  assert.match(html, /<button[^>]*data-fx-plan-run[^>]*>Run plan now<\/button>/);
  assert.doesNotMatch(html, /disabled/);
  assert.doesNotMatch(html, /A plan is running/);
});

const svc = (state, code = null) => ({ state, code });

test('a network failure while jobs are paused says sync is paused and promises no date', () => {
  const services = {
    jobs: { plan: svc('paused', 'paused'), 'simplefin-sync': svc('paused', 'paused') },
    simplefin: svc('retrying', 'network'),
  };
  const text = problemText('network', JOBS, services);
  assert.match(text, /Sync is paused/);
  assert.doesNotMatch(text, /Mon, Nov 9, 5:00 AM/);
  assert.doesNotMatch(text, /next scheduled sync/);
});

test('a network failure while SimpleFIN is paused says sync is paused and promises no date', () => {
  const services = { jobs: { 'simplefin-sync': svc('healthy') }, simplefin: svc('paused', 'paused') };
  const text = problemText('network', JOBS, services);
  assert.match(text, /Sync is paused/);
  assert.doesNotMatch(text, /Mon, Nov 9, 5:00 AM/);
});

test('a network failure with jobs and SimpleFIN running keeps the dated retry', () => {
  const services = { jobs: { 'simplefin-sync': svc('healthy') }, simplefin: svc('retrying', 'network') };
  const text = problemText('network', JOBS, services);
  assert.match(text, /SimpleFIN bridge did not answer in time/);
  assert.match(text, /Mon, Nov 9, 5:00 AM/);
  assert.doesNotMatch(text, /Sync is paused/);
});
