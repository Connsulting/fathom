// H2 AC5: Home shows at most one needs-you line, linking to the screen that owns the service, and
// nothing when all is healthy. The server picks services.attention: a needs_you service at once, a
// retrying one only after more than a day; the client helpers render that one line. Synthetic data.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempDb } from './helpers/server.mjs';
import { JOBS } from '../src/jobs/scheduler.mjs';
import { serviceStatus } from '../src/jobs/service-status.mjs';
import * as view from '../web/horizon/screens/service-status.js';
import { forEachSeries } from '../src/shared/series.mjs';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
view.bind({ esc, api: { s: { live: {} } } });

const NOW = '2026-11-08T15:00:00.000Z';
const HOUR = 3600000;
const ALL_ON = Object.freeze({ jobs: true, email: true, simplefin: true, engine: true });

const svc = (key, go, state, over = {}) => ({
  key, label: `Synthetic ${key}`, state, code: state === 'healthy' ? null : 'synthetic_code',
  cause: state === 'healthy' ? null : 'Something synthetic needs a look.', lastSuccessAt: null, nextAttemptAt: null,
  since: state === 'healthy' ? null : '2026-11-08T10:00:00.000Z', control: state === 'healthy' ? null : { id: 'refresh', label: 'Check again' }, go, ...over,
});

function services({ engine = 'healthy', simplefin = 'healthy', email = 'healthy', plan = 'healthy', attention = null } = {}) {
  const s = {
    jobs: { plan: svc('job:plan', 'engine', plan) },
    email: svc('email', 'email', email),
    engine: svc('engine', 'engine', engine),
    simplefin: svc('simplefin', 'money', simplefin),
  };
  s.attention = attention ? s[attention] ?? s.jobs[attention] : null;
  return s;
}

const lines = (html) => (html.match(/data-service-line/g) || []).length;
const goes = (html) => [...html.matchAll(/data-go="([^"]*)"/g)].map((m) => m[1]);

test('one needs_you engine service gives one line linking to the Engine screen', () => {
  const s = services({ engine: 'needs_you', attention: 'engine' });
  const line = view.attentionLine(s);
  assert.ok(line, 'a line');
  assert.equal(line.go, 'engine');
  assert.equal(line.key, 'engine');
  assert.ok(typeof line.text === 'string' && line.text.length > 0);
  const html = view.homeServiceHtml(s);
  assert.equal(lines(html), 1);
  assert.deepEqual(goes(html), ['engine']);
  assert.ok(html.includes(esc(line.text)), 'the line carries its text');
});

test('a long-retrying SimpleFIN service the server picked links to Money', () => {
  const s = services({ simplefin: 'retrying', attention: 'simplefin' });
  assert.equal(view.attentionLine(s).go, 'money');
  assert.equal(view.attentionLine(s).key, 'simplefin');
  const html = view.homeServiceHtml(s);
  assert.equal(lines(html), 1);
  assert.deepEqual(goes(html), ['money']);
});

test('all healthy (attention null) renders nothing', () => {
  const s = services();
  assert.equal(view.attentionLine(s), null);
  assert.equal(view.homeServiceHtml(s), '');
  // A recent retry the server did not pick shows nothing either.
  const recent = services({ simplefin: 'retrying' });
  assert.equal(view.attentionLine(recent), null);
  assert.equal(view.homeServiceHtml(recent), '');
});

test('missing services (the scenario could not build them) render nothing', () => {
  assert.equal(view.attentionLine(null), null);
  assert.equal(view.attentionLine(undefined), null);
  assert.equal(view.homeServiceHtml(null), '');
  assert.equal(view.homeServiceHtml(undefined), '');
});

test('several services needing attention still give exactly one line', () => {
  const s = services({ engine: 'needs_you', simplefin: 'needs_you', email: 'needs_you', plan: 'needs_you', attention: 'engine' });
  const html = view.homeServiceHtml(s);
  assert.equal(lines(html), 1);
  assert.equal(goes(html).length, 1);
  assert.deepEqual(goes(html), ['engine']);
});

// Server side: serviceStatus picks attention.

const fakeEngine = (over = {}) => ({
  status: () => ({ mode: 'fake', on: true, credentialState: 'loaded', funded: true, capUsd: 200, spentUsd: 0, ...over }), isOn: () => true, async init() {},
});
const fakeScheduler = () => ({ schedule: () => JOBS.map((j) => ({ id: j.id, nextAt: '2026-11-09T10:00:00.000Z', retryMs: 15 * 60000 })) });
const iso = (msAgo) => new Date(Date.parse(NOW) - msAgo).toISOString();

async function withStore(t) {
  const s = await tempDb();
  t.after(async () => { try { await s.db.close(); } catch { /* closed */ } rmSync(s.dataDir, { recursive: true, force: true }); });
  const ins = s.db.prepare("INSERT OR IGNORE INTO jobs (id, name, cadence, does, cost, next_label, last_label, enabled, sort) VALUES (?, ?, ?, ?, NULL, '', '', 1, ?)");
  await forEachSeries(JOBS, async (j, i) => await ins.run(j.id, j.name, j.cadence, j.does, 100 + i));
  return s;
}

async function failed(db, jobId, errorClass, startedAgo, periodKey) {
  await db.prepare(`INSERT INTO job_runs (job_id, started_at, finished_at, status, period_key, trigger, duration_ms, error_class, cost_usd, note)
    VALUES (?, ?, ?, 'error', ?, 'scheduled', 1000, ?, 0, NULL)`).run(jobId, iso(startedAgo), iso(startedAgo - 1000), periodKey, errorClass);
}

const statusAt = async (db, engine = fakeEngine()) => await serviceStatus({ db, outbound: { ...ALL_ON }, engine, scheduler: fakeScheduler(), now: new Date(NOW) });

test('server: a job retrying for 2 hours needs no attention yet', async (t) => {
  const { db } = await withStore(t);
  await failed(db, 'simplefin-sync', 'simplefin_network', 2 * HOUR, '2026-11-08');
  const out = await statusAt(db);
  assert.equal(out.jobs['simplefin-sync'].state, 'retrying');
  assert.equal(out.attention, null);
  view.bind({ esc, api: { s: { live: {} } } });
  assert.equal(view.homeServiceHtml(out), '');
});

test('server: a job retrying for more than 24 hours becomes the attention line', async (t) => {
  const { db } = await withStore(t);
  await failed(db, 'simplefin-sync', 'simplefin_network', 30 * HOUR, '2026-11-07');
  await failed(db, 'simplefin-sync', 'simplefin_network', 2 * HOUR, '2026-11-08');
  const out = await statusAt(db);
  const job = out.jobs['simplefin-sync'];
  assert.equal(job.state, 'retrying');
  assert.ok(Date.parse(job.since) < Date.parse(NOW) - 24 * HOUR, 'the streak started more than a day ago');
  assert.ok(out.attention, 'attention is set');
  assert.equal(out.attention.key, 'job:simplefin-sync');
  const html = view.homeServiceHtml(out);
  assert.equal(lines(html), 1);
  assert.deepEqual(goes(html), ['money']);
});

test('server: a needs_you job is attention immediately', async (t) => {
  const { db } = await withStore(t);
  await failed(db, 'plan', 'TypeError', 60000, '2026-11-08');
  const out = await statusAt(db);
  assert.equal(out.jobs.plan.state, 'needs_you');
  assert.equal(out.attention?.key, 'job:plan');
  assert.deepEqual(goes(view.homeServiceHtml(out)), ['engine']);
});

test('server: with several services needing attention the engine comes first and there is one line', async (t) => {
  const { db } = await withStore(t);
  await failed(db, 'plan', 'TypeError', 60000, '2026-11-08');
  await failed(db, 'simplefin-sync', 'simplefin_revoked', 60000, '2026-11-08');
  const out = await statusAt(db, fakeEngine({ mode: 'live', funded: false }));
  assert.equal(out.engine.state, 'needs_you');
  assert.equal(out.attention?.key, 'engine');
  const html = view.homeServiceHtml(out);
  assert.equal(lines(html), 1);
  assert.deepEqual(goes(html), ['engine']);
});
