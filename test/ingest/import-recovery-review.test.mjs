// H1 review fix 1: a proposal the background resume pass staged (actor BACKGROUND_ACTOR, 'fathom')
// is restaged under the owner who reviews it, never refused. The owner's review answers 409
// proposal_stale, the client's existing recovery (POST /api/files/:id/retry) restages it under the
// owner without a second model call, and approving the restaged version imports the rows. A proposal
// another real owner staged is still refused (forbidden); the owner's own proposal is still approved
// directly. Every value is synthetic.
//
// End to end: an in-process server over a real store, its household scheduler (the real
// createScheduler, no job handlers) running the resume pass on a tick, and the fake-mode runtime
// engine. The only faked component is the engine's interpretation response: the engine's call is
// wrapped to hand the one scripted interpretation to the first call and nothing to any later one,
// and to count calls.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setup, approve } from '../helpers/model-cutover.mjs';
import { recipe } from '../helpers/model-import.mjs';
import { serveAppFixture } from '../helpers/server.mjs';
import { loadConfig } from '../../src/config.mjs';
import { createScheduler } from '../../src/jobs/scheduler.mjs';
import * as P from '../../src/ingest/pipeline.mjs';
import * as FS from '../../src/ingest/file-status.mjs';
import { indexSource } from '../../src/ingest/model-source.mjs';
import { applyLayout } from '../../src/ingest/model-layout.mjs';
import { reviewImport } from '../../src/ingest/model-review.mjs';
import { fileSpend } from '../../src/ingest/model-parse.mjs';
import { openVault, storeFile } from '../../src/ingest/vault.mjs';

const T = { timeout: 60000 };
const DEADLINE_MS = 10000;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BACKGROUND = 'fathom';

// A novel CSV no deterministic parser claims, so it goes through the model-import path.
const MODEL_CSV = (tag) => `Account,Date,Amount USD,Description\naccount-synthetic,2032-03-02,-12.25,Synthetic ${tag} purchase\naccount-synthetic,2032-03-03,2.25,Synthetic ${tag} refund\nTotal,,-10.00,Control total\n`;
const modelFile = (csv) => ({ name: 'synthetic.csv', bytes: Buffer.from(csv) });

// The fake-mode engine response that interprets a model CSV with the recipe layout.
async function fakeFor(csv) {
  const bytes = Buffer.from(csv);
  const fileId = 'f-' + sha256(bytes).slice(0, 24);
  const source = await indexSource({ fileId, bytes, name: 'synthetic.csv', format: 'csv' });
  const layout = recipe();
  const p = applyLayout(source, layout);
  return [{ text: JSON.stringify({ rows: p.rows, coverage: p.coverage, completeness: p.completeness, controls: p.controls, layout }), costUsd: 0.001, tokens: { input_tokens: 20, output_tokens: 40 } }];
}

// The stored bytes and 'pending' row an interrupted ingestFile leaves.
async function leavePending(household, db, file) {
  const bytes = new Uint8Array(file.bytes);
  const hash = sha256(bytes);
  const fileId = 'f-' + hash.slice(0, 24);
  const vault = await openVault(household);
  const storedPath = await storeFile({ vault, id: fileId, bytes, purpose: 'upload' });
  db.prepare(`INSERT INTO files (id, name, mime, size, sha256, uploaded_at, stored_path, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`)
    .run(fileId, file.name, 'text/csv', bytes.length, hash, new Date().toISOString(), storedPath);
  return fileId;
}

// The engine hands `script` to its first call only; every later call gets an empty script list, so
// the fake engine refuses it ('no scripted response'). `calls` counts every call.
function scriptOnce(engine, script) {
  const real = engine.call;
  const calls = [];
  let next = script;
  engine.call = (req) => {
    calls.push(req.purpose);
    const fake = req.fake ?? next;
    next = [];
    return real({ ...req, fake });
  };
  return { calls, restore() { engine.call = real; } };
}

const fileRow = (db, id) => { const r = db.prepare('SELECT status, note FROM files WHERE id = ?').get(id); return r ? { ...r } : r; };
const proposalsOf = (db, fileId) => db.prepare('SELECT id, version, status, actor_id FROM import_proposals WHERE file_id = ? ORDER BY version').all(fileId).map((r) => ({ ...r }));
const txCount = (db, fileId) => db.prepare('SELECT count(*) n FROM transactions WHERE file_id = ?').get(fileId).n;

async function until(fn, ms = DEADLINE_MS) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(50);
  }
}

test('the background actor is exported as fathom', () => {
  assert.equal(FS.BACKGROUND_ACTOR, BACKGROUND);
});

test('a proposal the scheduler resume pass staged is restaged under the reviewing owner over HTTP, without a second model call, then imports', T, async () => {
  const x = await setup();
  const config = loadConfig({ FATHOM_DATA: x.dataDir, FATHOM_ENGINE: 'fake' });
  const app = await serveAppFixture({
    db: x.db, platform: x.platform, config, secrets: x.secrets, engine: x.household.engine, authenticated: true,
    scheduler: (household) => createScheduler({ db: x.db, config, household, handlers: {} }),
  });
  const scheduler = app.household.scheduler;
  const csv = MODEL_CSV('background staged');
  const engine = scriptOnce(x.household.engine, await fakeFor(csv));
  try {
    const owner = app.session.user.id;
    assert.ok(owner && owner !== BACKGROUND, 'the signed-in owner is not the background actor');
    const id = await leavePending(app.household, x.db, modelFile(csv));

    // The resume pass (actor 'fathom') interprets the interrupted file once and stages its proposal.
    await scheduler.tick();
    const staged = await until(() => (fileRow(x.db, id)?.status !== 'pending' ? fileRow(x.db, id) : null));
    assert.ok(staged, 'the resume pass finished within the deadline');
    assert.equal(staged.status, 'needs_confirmation');
    await scheduler.idle?.();
    const [first] = proposalsOf(x.db, id);
    assert.deepEqual({ version: first.version, status: first.status, actor: first.actor_id }, { version: 1, status: 'needs_confirmation', actor: BACKGROUND });
    assert.equal(engine.calls.length, 1, 'one model call interpreted the file');
    assert.equal(fileSpend(x.db, id).calls, 1);

    // The owner's review of the background proposal answers 409 proposal_stale, not forbidden.
    const review = await app.postJson(`/api/import-proposals/${first.id}/review`, { version: 1, decision: 'approve', evidence: 'looks right' });
    assert.equal(review.status, 409, review.text.slice(0, 300));
    assert.equal(review.json.code, 'proposal_stale');
    assert.equal(fileRow(x.db, id).status, 'needs_confirmation', 'nothing imported by the refused review');
    assert.equal(txCount(x.db, id), 0);

    // The client's recovery: Retry restages it under the owner with no model call.
    const retry = await app.postJson(`/api/files/${id}/retry`, {});
    assert.equal(retry.status, 200, retry.text.slice(0, 300));
    assert.equal(retry.json.file.fileId, id);
    assert.equal(retry.json.file.status, 'needs_confirmation');
    assert.equal(retry.json.file.proposalId, first.id);
    assert.equal(retry.json.file.version, 2);
    const versions = proposalsOf(x.db, id);
    assert.deepEqual(versions.map((p) => [p.version, p.status, p.actor_id]), [[1, 'superseded', BACKGROUND], [2, 'needs_confirmation', owner]]);
    assert.equal(engine.calls.length, 1, 'the restage made no second model call');
    assert.equal(fileSpend(x.db, id).calls, 1);

    // Approving the restaged version imports the rows.
    const approved = await app.postJson(`/api/import-proposals/${first.id}/review`, { version: 2, decision: 'approve', evidence: 'looks right' });
    assert.equal(approved.status, 200, approved.text.slice(0, 300));
    assert.equal(approved.json.status, 'imported');
    assert.equal(approved.json.receipt.actorId, owner);
    assert.equal(fileRow(x.db, id).status, 'imported');
    assert.equal(txCount(x.db, id), 2);
    assert.equal(engine.calls.length, 1);
  } finally {
    engine.restore();
    await scheduler.stop();
    await app.close();
    x.close();
  }
});

// Each case runs on a fresh store: an approved layout would let a later file with the same headers
// import through the saved mapping instead of the model.
test('liveness: a proposal the reviewing owner staged is approved directly', T, async () => {
  const x = await setup();
  try {
    const csv = MODEL_CSV('own staged');
    const own = await P.ingestFile(x.db, modelFile(csv), { ...x.opts, fake: await fakeFor(csv) });
    assert.equal(own.status, 'needs_confirmation');
    assert.equal(proposalsOf(x.db, own.fileId)[0].actor_id, x.ctx.actorId);
    assert.equal((await approve(x, own)).status, 'imported');
    assert.equal(txCount(x.db, own.fileId), 2);
  } finally { x.close(); }
});

test('liveness: a proposal another real owner staged is still refused as forbidden and left as it was', T, async () => {
  const x = await setup();
  try {
    const csv = MODEL_CSV('other owner staged');
    const other = await P.ingestFile(x.db, modelFile(csv), { ...x.opts, actorId: 'actor-other-synthetic', fake: await fakeFor(csv) });
    assert.equal(other.status, 'needs_confirmation');
    await assert.rejects(reviewImport(x.ctx, { proposalId: other.proposalId, version: other.version, decision: 'approve', evidence: 'yes' }), (e) => e.code === 'forbidden');
    assert.deepEqual(proposalsOf(x.db, other.fileId).map((p) => [p.version, p.status, p.actor_id]), [[1, 'needs_confirmation', 'actor-other-synthetic']]);
    assert.equal(fileRow(x.db, other.fileId).status, 'needs_confirmation');
    assert.equal(txCount(x.db, other.fileId), 0);
  } finally { x.close(); }
});

test('reviewImport answers proposal_stale for a background proposal; a retry restages it under the owner with no model call; approval imports', T, async () => {
  const x = await setup();
  try {
    const csv = MODEL_CSV('background tool');
    const id = await leavePending(x.household, x.db, modelFile(csv));
    const resumed = await P.resumeImports(x.db, { ...x.opts, actorId: BACKGROUND, fake: await fakeFor(csv) });
    assert.deepEqual(resumed.resumed, [{ fileId: id, status: 'needs_confirmation' }]);
    const [bg] = proposalsOf(x.db, id);
    assert.equal(bg.actor_id, BACKGROUND);
    await assert.rejects(reviewImport(x.ctx, { proposalId: bg.id, version: bg.version, decision: 'approve', evidence: 'yes' }), (e) => e.code === 'proposal_stale');
    assert.equal(fileSpend(x.db, id).calls, 1);
    // No fake script is offered here, so a model call could not succeed.
    const restaged = await P.retryFile(x.db, id, x.opts);
    assert.equal(restaged.status, 'needs_confirmation');
    assert.equal(restaged.proposalId, bg.id);
    assert.equal(restaged.version, bg.version + 1);
    assert.equal(fileSpend(x.db, id).calls, 1, 'the restage made no model call');
    assert.equal(proposalsOf(x.db, id).at(-1).actor_id, x.ctx.actorId);
    assert.equal((await approve(x, restaged)).status, 'imported');
    assert.equal(txCount(x.db, id), 2);
  } finally { x.close(); }
});
