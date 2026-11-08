// H1 AC2: the interrupted-resume and failed-retry paths end to end through the HTTP API, on an
// in-process server over a real store with the fake engine. An interrupted upload is resumed by the
// household scheduler's next tick and on a fresh server start; a failed file imports on Retry and on
// an identical re-upload (never "duplicate"); a transient failure is retried once by a tick and, when
// that retry fails transiently again, is left for the owner. Every value is synthetic.
//
// A parser cannot be injected through HTTP, so failed states are reached with a store fault at the
// storage boundary: a TEMP trigger on the household's own connection makes every transaction insert
// raise, with SQLite's lock message ('database is locked') for the transient case or another message
// for a plain failure. Nothing in src/ is replaced; the upload, the retry route and the scheduler run
// their real paths.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tempInstance, serveAppFixture } from '../helpers/server.mjs';
import { fakeEngine, aggregatorCsv } from '../helpers/ingest.mjs';
import { loadConfig } from '../../src/config.mjs';
import { createScheduler } from '../../src/jobs/scheduler.mjs';
import { openVault, storeFile } from '../../src/ingest/vault.mjs';

const T = { timeout: 60000 };
const DEADLINE_MS = 10000;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const csv = (tag, amount) => aggregatorCsv([
  { date: '2032-03-02', amount, description: `Synthetic ${tag} purchase`, number: '5550008181' },
  { date: '2032-03-03', amount: '2.50', description: `Synthetic ${tag} refund`, number: '5550008181' },
]);

// The served household on an in-process server. Its scheduler is the real createScheduler with the
// household getter the runtime passes and no job handlers, so a tick runs the lease, the
// interrupted-run recovery and the import resume pass only.
async function serve(instance) {
  const config = loadConfig({ FATHOM_DATA: instance.dataDir, FATHOM_ENGINE: 'off' });
  const app = await serveAppFixture({
    db: instance.db, platform: instance.platform, config, secrets: instance.secrets, engine: await fakeEngine(), authenticated: true,
    scheduler: (household) => createScheduler({ db: instance.db, config, household, handlers: {} }),
  });
  return {
    app,
    scheduler: app.household.scheduler,
    async close() { await app.household.scheduler.stop(); await app.close(); },
  };
}

async function withInstance(fn) {
  const instance = await tempInstance();
  try { return await fn(instance); } finally { instance.close(); rmSync(instance.dataDir, { recursive: true, force: true }); }
}

async function uploadOver(app, name, text) {
  const form = new FormData();
  form.append('files', new Blob([text], { type: 'text/csv' }), name);
  const res = await fetch(app.baseUrl + '/api/files', { method: 'POST', headers: app.headers, body: form });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* not JSON */ }
  return { status: res.status, text: raw, json };
}

// What an interrupted upload leaves: the encrypted bytes in the vault and the 'pending' files row
// ingestFile writes before routing.
async function leavePending(app, name, text) {
  const bytes = new TextEncoder().encode(text);
  const hash = sha256(bytes);
  const fileId = 'f-' + hash.slice(0, 24);
  const vault = await openVault(app.household);
  const storedPath = await storeFile({ vault, id: fileId, bytes, purpose: 'upload' });
  await app.household.db.prepare(`INSERT INTO files (id, name, mime, size, sha256, uploaded_at, stored_path, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`)
    .run(fileId, name, 'text/csv', bytes.length, hash, new Date().toISOString(), storedPath);
  return fileId;
}

const faultStore = async (db, message) => await db.applySchema(`CREATE TEMP TRIGGER IF NOT EXISTS h1_store_fault BEFORE INSERT ON main.transactions BEGIN SELECT RAISE(ABORT, '${message}'); END;`);
const healStore = async (db) => await db.applySchema('DROP TRIGGER IF EXISTS temp.h1_store_fault');

const waitingIn = (sc, id) => sc.live.ingest.waiting.find((f) => f.id === id);
const fileIn = (sc, id) => sc.live.ingest.files.find((f) => f.id === id);
const rowOf = async (db, id) => { const r = await db.prepare('SELECT status, note FROM files WHERE id = ?').get(id); return r ? { ...r } : r; };

// Poll until fn returns a truthy value or the deadline passes; returns the last value.
async function until(fn, ms = DEADLINE_MS) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(50);
  }
}

test('an interrupted upload is resumed by the next scheduler tick', T, async () => withInstance(async (instance) => {
  const s = await serve(instance);
  try {
    const id = await leavePending(s.app, 'interrupted-tick-synthetic.csv', csv('interrupted tick', '21.25'));
    const before = await s.app.getScenario();
    assert.equal(waitingIn(before, id)?.status, 'pending', 'a reload lists the interrupted file');
    assert.equal(before.live.services.imports.state, 'retrying');
    assert.equal(before.live.services.imports.files, 1);

    await s.scheduler.tick();
    const after = await until(async () => { const sc = await s.app.getScenario(); return waitingIn(sc, id) ? null : sc; });
    assert.ok(after, 'the resume pass finished within the deadline');
    assert.equal(fileIn(after, id)?.status, 'imported');
    assert.equal(after.live.services.imports.state, 'healthy');
    assert.equal(after.live.services.imports.files, 0);
    assert.equal((await instance.db.prepare('SELECT count(*) n FROM transactions WHERE file_id = ?').get(id)).n, 2);
  } finally { await s.close(); }
}));

test('an interrupted upload is resumed when the server starts', T, async () => withInstance(async (instance) => {
  const first = await serve(instance);
  let id;
  try {
    id = await leavePending(first.app, 'interrupted-load-synthetic.csv', csv('interrupted load', '22.25'));
  } finally { await first.close(); }

  const second = await serve(instance);
  try {
    assert.equal(waitingIn(await second.app.getScenario(), id)?.status, 'pending', 'still pending before the start');
    // What the server does at load: start each household's scheduler, whose first tick runs at once.
    await second.app.runtimes.startAll();
    const after = await until(async () => { const sc = await second.app.getScenario(); return waitingIn(sc, id) ? null : sc; });
    assert.ok(after, 'resumed on load within the deadline');
    assert.equal(fileIn(after, id)?.status, 'imported');
    assert.equal(after.live.services.imports.state, 'healthy');
  } finally { await second.close(); }
}));

test('a failed file imports on Retry and on an identical re-upload, never as a duplicate; a tick leaves it alone', T, async () => withInstance(async (instance) => {
  const s = await serve(instance);
  const db = instance.db;
  try {
    const textA = csv('failed retry', '31.00');
    const textB = csv('failed reupload', '32.00');
    await faultStore(db, 'synthetic store failure');
    const a = await uploadOver(s.app, 'failed-retry-synthetic.csv', textA);
    const b = await uploadOver(s.app, 'failed-reupload-synthetic.csv', textB);
    await healStore(db);
    for (const r of [a, b]) {
      assert.equal(r.status, 200, r.text.slice(0, 300));
      assert.equal(r.json.files[0].status, 'failed');
    }
    const idA = a.json.files[0].fileId;
    const idB = b.json.files[0].fileId;
    for (const id of [idA, idB]) {
      const row = await rowOf(db, id);
      assert.equal(row.status, 'failed');
      assert.equal(row.note, 'ERR_SQLITE_ERROR', 'a non-transient class, never the message');
      assert.ok(!String(row.note).includes('synthetic store failure'));
    }
    let sc = await s.app.getScenario();
    assert.equal(waitingIn(sc, idA)?.status, 'failed', 'a reload lists the failed file');
    assert.equal(waitingIn(sc, idA)?.reasonCode, 'ERR_SQLITE_ERROR');
    assert.equal(sc.live.services.imports.state, 'needs_you');
    assert.equal(sc.live.services.imports.files, 2);

    // A tick does not retry a non-transient failure.
    await s.scheduler.tick();
    await s.scheduler.idle();
    await sleep(200);
    assert.equal((await rowOf(db, idA)).status, 'failed');
    assert.equal((await rowOf(db, idB)).status, 'failed');

    // Retry over HTTP.
    const retry = await s.app.postJson(`/api/files/${idA}/retry`, {});
    assert.equal(retry.status, 200, retry.text.slice(0, 300));
    assert.equal(retry.json.file.fileId, idA);
    assert.equal(retry.json.file.status, 'imported');
    assert.equal(waitingIn(retry.json.scenario, idA), undefined);

    // The identical bytes added again.
    const again = await uploadOver(s.app, 'failed-reupload-synthetic.csv', textB);
    assert.equal(again.status, 200, again.text.slice(0, 300));
    const f = again.json.files[0];
    assert.equal(f.fileId, idB);
    assert.notEqual(f.status, 'duplicate');
    assert.equal(f.status, 'imported');
    assert.equal(waitingIn(again.json.scenario, idB), undefined);
    assert.equal(fileIn(again.json.scenario, idB)?.status, 'imported');

    // Liveness of the duplicate branch: an imported file's identical bytes are still a duplicate.
    const dup = await uploadOver(s.app, 'failed-reupload-synthetic.csv', textB);
    assert.equal(dup.json.files[0].status, 'duplicate');
    assert.equal(dup.json.files[0].duplicateOf, idB);

    sc = await s.app.getScenario();
    assert.equal(sc.live.services.imports.state, 'healthy');
    assert.equal(sc.live.services.imports.files, 0);
  } finally { await healStore(db); await s.close(); }
}));

test('a transient failure is retried once by a tick and imports', T, async () => withInstance(async (instance) => {
  const s = await serve(instance);
  const db = instance.db;
  try {
    await faultStore(db, 'database is locked');
    const up = await uploadOver(s.app, 'transient-once-synthetic.csv', csv('transient once', '41.00'));
    await healStore(db);
    assert.equal(up.status, 200, up.text.slice(0, 300));
    const f = up.json.files[0];
    assert.equal(f.status, 'failed');
    assert.equal(f.reasonCode, 'retry:store_locked');
    assert.deepEqual(await rowOf(db, f.fileId), { status: 'failed', note: 'retry:store_locked' });
    const before = await s.app.getScenario();
    assert.equal(waitingIn(before, f.fileId)?.reasonCode, 'retry:store_locked');
    assert.equal(before.live.services.imports.state, 'retrying');

    await s.scheduler.tick();
    const after = await until(async () => { const sc = await s.app.getScenario(); return waitingIn(sc, f.fileId) ? null : sc; });
    assert.ok(after, 'retried within the deadline');
    assert.equal(fileIn(after, f.fileId)?.status, 'imported');
    assert.equal(after.live.services.imports.state, 'healthy');
  } finally { await healStore(db); await s.close(); }
}));

test('a transient failure that fails again on its automatic retry is left failed and not retried again', T, async () => withInstance(async (instance) => {
  const s = await serve(instance);
  const db = instance.db;
  try {
    await faultStore(db, 'database is locked');
    const up = await uploadOver(s.app, 'transient-twice-synthetic.csv', csv('transient twice', '42.00'));
    const id = up.json.files[0].fileId;
    assert.deepEqual(await rowOf(db, id), { status: 'failed', note: 'retry:store_locked' });

    // The fault is still there on the one automatic retry.
    await s.scheduler.tick();
    const left = await until(async () => { const sc = await s.app.getScenario(); return waitingIn(sc, id)?.reasonCode === 'store_locked' ? sc : null; });
    assert.ok(left, 'the automatic retry ran within the deadline');
    assert.equal(waitingIn(left, id).status, 'failed');
    assert.equal(left.live.services.imports.state, 'needs_you');
    await healStore(db);

    // No further automatic retry, even with the store healthy again.
    await s.scheduler.tick();
    await s.scheduler.idle();
    await sleep(200);
    assert.deepEqual(await rowOf(db, id), { status: 'failed', note: 'store_locked' });

    // The owner's Retry still imports it.
    const retry = await s.app.postJson(`/api/files/${id}/retry`, {});
    assert.equal(retry.status, 200, retry.text.slice(0, 300));
    assert.equal(retry.json.file.status, 'imported');
  } finally { await healStore(db); await s.close(); }
}));
