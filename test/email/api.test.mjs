// Email and jobs API (src/api/email-handlers.mjs through the real server): GET /api/email,
// POST /api/email/test and /api/email/brief over the dev transport (outbox file, history row
// with no body), GET /api/jobs, POST /api/jobs/:id/run (known and unknown ids), and the POST
// guards. MT-03: household email goes to the household root's outbox/ (households/<id>/outbox).
// Revision r2 item 4 runs in-process: createHandler with a fake scheduler records
// trigger('plan', 'ingest') and trigger('confirm-guess', 'ingest') for an imported upload and a
// successful retry, and nothing for an upload or retry that imports nothing.

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnServer, request, postJson, openStore, src, tempInstance, SERVER_TIMEOUT, serveAppFixture } from '../helpers/server.mjs';
import { seedDemo } from '../../demo/seed.mjs';
import { fixturePath, textFile, realStore, offEngine } from '../helpers/ingest.mjs';

const T = { timeout: SERVER_TIMEOUT * 2 };
const BODY_KEYS = ['text', 'html', 'body'];

const outbox = (dir) => (existsSync(join(dir, 'outbox')) ? readdirSync(join(dir, 'outbox')).filter((f) => f.endsWith('.json')).sort() : []);

const outboxSubject = (dir, f) => JSON.parse(readFileSync(join(dir, 'outbox', f), 'utf8')).subject;

function assertHistoryRow(row) {
  for (const k of ['kind', 'subject', 'status']) assert.ok(k in row, `history row has ${k}`);
  for (const k of BODY_KEYS) assert.ok(!(k in row), `history row has no ${k}`);
}

describe('email and jobs routes on a demo server', () => {
  let s;
  before(async () => {
    s = await spawnServer({ env: { FATHOM_DEMO: '1', FATHOM_ENGINE: 'fake', FATHOM_CLOCK: '2026-11-05' } });
  }, T);
  after(async () => {
    if (!s) return;
    await s.stop();
    rmSync(s.dataDir, { recursive: true, force: true });
  });

  test('GET /api/email returns status, a preview and history', T, async () => {
    const r = await request(s.baseUrl, { path: '/api/email' });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    const { status, preview, history } = r.json;
    assert.equal(status.transport, 'dev');
    assert.equal(status.state, 'dev');
    assert.equal(status.recipient, 'o***@e***.invalid');
    assert.equal(status.recipients, 1);
    for (const k of ['subject', 'text', 'html']) assert.ok(typeof preview[k] === 'string' && preview[k].length > 0, `preview.${k}`);
    assert.ok(['model', 'template'].includes(preview.summarySrc));
    assert.ok(Array.isArray(history));
    history.forEach(assertHistoryRow);
    assert.ok(!r.text.includes('owner@example.invalid'), 'the recipient is masked');
  });

  test('POST /api/email/test sends through the dev transport and history gains a row with no body', T, async () => {
    const before = outbox(s.root);
    const r = await postJson(s.baseUrl, '/api/email/test', {});
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(r.json.send.kind, 'test');
    assert.equal(r.json.send.status, 'sent');
    assert.equal(r.json.send.transport, 'dev');
    const after = outbox(s.root);
    // The scheduler's startup catch-up may send the brief at the same time, so other new files are allowed.
    const added = after.filter((f) => !before.includes(f)).filter((f) => outboxSubject(s.root, f) === r.json.send.subject);
    assert.equal(added.length, 1, 'exactly one new outbox file carries the test email subject');
    assert.equal(r.json.history[0].id, r.json.send.id, 'newest first');
    r.json.history.forEach(assertHistoryRow);
    const g = await request(s.baseUrl, { path: '/api/email' });
    assert.equal(g.json.history[0].id, r.json.send.id);
  });

  test('POST /api/email/brief sends the brief and records it', T, async () => {
    const before = outbox(s.root);
    const r = await postJson(s.baseUrl, '/api/email/brief', {});
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(r.json.send.kind, 'brief');
    assert.equal(r.json.send.status, 'sent');
    const added = outbox(s.root).filter((f) => !before.includes(f)).filter((f) => outboxSubject(s.root, f) === r.json.send.subject);
    assert.equal(added.length, 1, 'exactly one new outbox file carries the brief subject');
    const msg = JSON.parse(readFileSync(join(s.root, 'outbox', added[0]), 'utf8'));
    assert.ok(msg.html.length > 0 && msg.text.length > 0);
    assert.equal(r.json.history[0].kind, 'brief');
    assertHistoryRow(r.json.history[0]);
  });

  test('GET /api/jobs lists the handled jobs with last and next run', T, async () => {
    const r = await request(s.baseUrl, { path: '/api/jobs' });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    const ids = r.json.jobs.map((j) => j.id);
    for (const id of ['plan', 'brief-email', 'deadline-alerts', 'freshness', 'trash-purge', 'confirm-guess']) assert.ok(ids.includes(id), id);
    for (const j of r.json.jobs) {
      for (const k of ['name', 'cadence', 'does', 'next']) assert.equal(typeof j[k], 'string', `${j.id}.${k}`);
      assert.ok('lastRun' in j, `${j.id}.lastRun`);
      assert.ok(!Number.isNaN(Date.parse(j.nextAt)), `${j.id}.nextAt`);
    }
    assert.ok(Array.isArray(r.json.runs));
    assert.equal(r.json.timezone, 'America/New_York');
  });

  test('POST /api/jobs/:id/run runs a known job and adds a manual job_runs row; an unknown id is 404', T, async () => {
    const count = async () => {
      const d = await openStore(s.dbFile);
      try { return (await d.prepare("SELECT count(*) AS n FROM job_runs WHERE job_id = 'freshness'").get()).n; } finally { await d.close(); }
    };
    const n0 = await count();
    const r = await postJson(s.baseUrl, '/api/jobs/freshness/run', {});
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(r.json.run, 'run');
    assert.ok(Array.isArray(r.json.jobs), 'jobs');
    assert.equal(await count(), n0 + 1);
    const db = await openStore(s.dbFile);
    try {
      const last = await db.prepare("SELECT * FROM job_runs WHERE job_id = 'freshness' ORDER BY id DESC LIMIT 1").get();
      assert.equal(last.trigger, 'manual');
      assert.match(last.period_key, /^manual:/);
    } finally { await db.close(); }
    const fresh = r.json.jobs.find((j) => j.id === 'freshness');
    assert.ok(fresh.lastRun, 'lastRun after a manual run');

    const unknown = await postJson(s.baseUrl, '/api/jobs/no-such-job/run', {});
    assert.equal(unknown.status, 404);
    assert.equal(typeof unknown.json.error, 'string');
  });

  test('guards: 415 without a JSON content type, 403 cross-origin, 405 wrong method; same origin passes', T, async () => {
    for (const path of ['/api/email/test', '/api/email/brief', '/api/jobs/freshness/run']) {
      const noType = await request(s.baseUrl, { method: 'POST', path, body: '{}' });
      assert.equal(noType.status, 415, `${path} without content type`);
      const textType = await request(s.baseUrl, { method: 'POST', path, headers: { 'content-type': 'text/plain' }, body: '{}' });
      assert.equal(textType.status, 415, `${path} text/plain`);
      const cross = await postJson(s.baseUrl, path, {}, { origin: 'http://evil.example.invalid' });
      assert.equal(cross.status, 403, `${path} cross-origin`);
      const get = await request(s.baseUrl, { path });
      assert.equal(get.status, 405, `GET ${path}`);
    }
    for (const path of ['/api/email', '/api/jobs']) {
      const post = await postJson(s.baseUrl, path, {});
      assert.equal(post.status, 405, `POST ${path}`);
    }
    const same = await postJson(s.baseUrl, '/api/email/test', {}, { origin: s.baseUrl });
    assert.equal(same.status, 200, 'same-origin POST is accepted');
  });
});

describe('GET /api/email preview (in-process router, fake engine)', () => {
  test('never calls the engine for the preview and uses the template summary', T, async () => {
    const t = await tempInstance({ mode: 'demo', init: seedDemo });
    let calls = 0;
    const engine = { isOn: () => true, call: () => { calls++; throw new Error('should not be called'); } };
    const config = { dataDir: t.dataDir, clock: '2026-11-05', demo: true, engine: 'fake', port: 0, host: '127.0.0.1', claudeCredentialFile: null, emailTransport: 'dev', publicUrl: null };
    const transport = { name: 'capture', async send() { return { id: 'unused' }; } };
    const server = await serveAppFixture({ db: t.db, platform: t.platform, config, engine, transport });
    try {
      const r = await request(server.baseUrl, { path: '/api/email' });
      assert.equal(r.status, 200, r.text.slice(0, 300));
      assert.equal(calls, 0, 'the engine was not called');
      assert.equal(r.json.preview.summarySrc, 'template');
    } finally {
      await server.close();
      t.close();
      rmSync(t.dataDir, { recursive: true, force: true });
    }
  });
});

// Revision r2 item 4: ingest upload and retry trigger the plan job through ctx.scheduler.
describe('ingest triggers the plan job (in-process router, fake scheduler)', () => {
  const HEADERS = ['posted on', 'memo text', 'value usd'];
  const novelCsv = () => [HEADERS.join(','), '2032-03-02,SYNTH NOVEL A,-1.25', '2032-03-03,SYNTH NOVEL B,-2.25'].join('\n') + '\n';
  const MAPPING = { target: 'transaction', date: 'posted on', amount: 'value usd', description: 'memo text', amountSign: 'as_is', dateOrder: 'ymd' };

  function fakeScheduler() {
    const calls = [];
    return {
      calls,
      trigger(jobId, reason) { calls.push([jobId, reason]); return Promise.resolve(); },
      runNow() { throw new Error('not used'); },
      jobs: () => [],
      runs: () => [],
      start() {},
      stop() {},
    };
  }

  async function upload(app, files) {
    const fd = new FormData();
    for (const f of files) fd.append('files', new Blob([f.bytes], { type: f.mime || 'text/csv' }), f.name);
    const res = await fetch(`${app.baseUrl}/api/files`, { method: 'POST', body: fd, headers: app.headers });
    return { status: res.status, json: await res.json() };
  }

  const AFTER_IMPORT = [['confirm-guess', 'ingest'], ['freshness', 'ingest'], ['plan', 'ingest']];
  const sorted = (calls) => [...calls].sort((a, b) => a[0].localeCompare(b[0]));

  test('imported upload and successful retry trigger plan and confirm-guess once each; nothing imported triggers nothing', T, async () => {
    const st = await realStore();
    const signature = 'synthetic-unapproved-layout';
    const scheduler = fakeScheduler();
    const transport = { name: 'capture', async send() { return { id: 'unused' }; } };
    const server = await serveAppFixture({ authenticated: true, db: st.db, config: st.config, engine: await offEngine(), scheduler, transport });
    try {
      const imported = await upload(server, [{ name: 'aggregator.csv', bytes: readFileSync(fixturePath('aggregator.csv')) }]);
      assert.equal(imported.status, 200);
      assert.equal(imported.json.files[0].status, 'imported');
      assert.deepEqual(sorted(scheduler.calls), AFTER_IMPORT, 'an imported upload triggers plan and confirm-guess');

      const waiting = await upload(server, [textFile('novel-export.csv', novelCsv(), 'text/csv')]);
      assert.equal(waiting.status, 200);
      const file = waiting.json.files[0];
      assert.equal(file.status, 'waiting_for_engine');
      assert.equal(scheduler.calls.length, 3, 'an upload that imports nothing does not trigger');

      const stillWaiting = await server.postJson(`/api/files/${file.fileId}/retry`, {});
      assert.equal(stillWaiting.status, 200);
      assert.equal(stillWaiting.json.file.status, 'waiting_for_engine');
      assert.equal(scheduler.calls.length, 3, 'an unsuccessful retry does not trigger');

      await st.db.prepare("INSERT INTO column_mappings (signature, mapping, src, created_at, uses) VALUES (?, ?, 'test', '2032-03-10T12:00:00.000Z', 0)")
        .run(signature, JSON.stringify(MAPPING));
      const done = await server.postJson(`/api/files/${file.fileId}/retry`, {});
      assert.equal(done.status, 200);
      assert.equal(done.json.file.status, 'waiting_for_engine');
      assert.equal(scheduler.calls.length, 3, 'an unapproved mapping does not import or trigger jobs');
    } finally {
      await server.close();
      st.close();
    }
  });
});
