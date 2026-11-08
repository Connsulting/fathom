// Rec conversations become Ask threads. AC4: migration 016 moves every rec-keyed conversation into
// an 'ask:<12 hex>' thread carrying a rec context reference (rec_id), archives and detaches the
// summary-only ones, deletes empty ones and leaves pack and Ask conversations alone. recForKey
// resolves a rec thread to its rec. The API asks from a rec through POST /api/threads with recId,
// refuses rec ids on POST /api/ask, and detaches a rec's threads with start-over. AC3: a thread is
// named after its first completed turn, rec threads included. The fake engine grounds rec threads
// in their rec and scripts no goal proposal there. Every fixture is synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { openDb, listMigrations, migrate, schemaVersion, DB_FILE } from '../src/store/db.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { seedDemo } from '../demo/seed.mjs';
import demo from '../demo/scenario.mjs';
import { loadConfig } from '../src/config.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { createLivePacks } from '../src/packs/live.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { threadCreate, ask } from '../src/api/handlers.mjs';
import { HttpError } from '../src/api/http.mjs';
import { listThreads, getThread } from '../src/api/threads.mjs';
import { recForKey, findQuestion } from '../src/api/questions.mjs';
import { fakeAnswerScript } from '../src/api/fake-answers.mjs';
import { wrapBlocks } from '../src/shared/answer-text.mjs';
import { SERVER_TIMEOUT, withServer, request, postJson, openStore, tempDb, tempDir } from './helpers/server.mjs';
import { mapSeries } from '../src/shared/series.mjs';

const T = { timeout: SERVER_TIMEOUT };
const FAKE = { FATHOM_ENGINE: 'fake', FATHOM_FAKE_STREAM_MS: '0' };
const THREAD_KEY = /^ask:[a-f0-9]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const AT = '2026-10-01T00:00:00.000Z';
const GOAL_CONFIRM = 'You can undo the change below.';

// ---------------------------------------------------------------- AC4: migration 016

// The rec threads migration; the store under test holds every migration before it.
const REC_MIGRATION = 16;
const BEFORE = Math.max(...listMigrations().map(m => m.id).filter(id => id < REC_MIGRATION));

// A store just before the rec threads migration, built by applying every earlier migration the way db.mjs migrate does (own
// transaction each, recorded in schema_migrations).
async function storeBeforeRecThreads(file) {
  const db = await openDb(file);
  await db.applySchema(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const record = db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)');
  for (const m of listMigrations().filter(x => x.id < REC_MIGRATION)) {
    db.exec('BEGIN');
    await db.applySchema(readFileSync(m.file, 'utf8'));
    await record.run(m.id, m.name, AT);
    db.exec('COMMIT');
  }
  return db;
}

const PROV = JSON.stringify({ engine: 'fake', model: 'fake', tools: [{ name: 'household', args: { operation: 'summary', } }, { name: 'recommendations', args: { operation: 'detail',  id: 'syn-alpha' } }],
  figures: [], packs: [], literals: [], grounding: { ok: true, retried: false, unverified: [] }, costUsd: 0.01 });

const ALPHA_LAST = '2026-10-04T00:00:00.000Z';
const GONE_MAX_TS = '2026-10-06T09:00:05.000Z';
const KEPT = ['pack:syn-pack', 'ask:0a1b2c3d4e5f', 'ask:111111111111', 'ask:222222222222'];

async function seedBeforeRecThreads(db) {
  await db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('mode', JSON.stringify('real'), AT);
  const rec = db.prepare("INSERT INTO recs (id, def, status, tasks_done, sort, updated_at) VALUES (?, ?, 'proposed', '[]', ?, ?)");
  await rec.run('syn-alpha', JSON.stringify({ id: 'syn-alpha', title: 'Synthetic alpha rec', summary: 'Synthetic alpha summary', domain: 'data' }), 0, AT);
  await rec.run('syn-beta', JSON.stringify({ id: 'syn-beta', title: 'Synthetic beta rec', summary: 'Synthetic beta summary as planned today', domain: 'data' }), 1, AT);
  await rec.run('syn-hollow', JSON.stringify({ id: 'syn-hollow', title: 'Synthetic hollow rec', summary: 'Synthetic hollow summary', domain: 'data' }), 2, AT);

  const conv = db.prepare('INSERT INTO conversations (key, created_at, title, title_source, archived_at, trashed_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const msg = db.prepare('INSERT INTO messages (conversation_key, role, text, refs, notice, ts, provenance) VALUES (?, ?, ?, ?, ?, ?, ?)');

  // A rec with an owner conversation: opening summary, two owner turns (one reply with provenance
  // and refs, one notice reply).
  await conv.run('syn-alpha', '2026-10-01T08:00:00.000Z', null, null, null, null, ALPHA_LAST);
  await msg.run('syn-alpha', 'fathom', '<p>Synthetic alpha opening summary</p>', '[]', 0, '2026-10-01T08:00:01.000Z', null);
  await msg.run('syn-alpha', 'me', 'Synthetic alpha question one', '[]', 0, '2026-10-02T09:00:00.000Z', null);
  await msg.run('syn-alpha', 'fathom', '<p>Synthetic alpha answer one with <span class="fx-src">a source</span></p>', '["syn-alpha","syn-beta"]', 0, '2026-10-02T09:00:04.000Z', PROV);
  await msg.run('syn-alpha', 'me', 'Synthetic alpha question two', '[]', 0, '2026-10-03T10:00:00.000Z', null);
  await msg.run('syn-alpha', 'fathom', '<p>Synthetic engine off notice</p>', '[]', 1, '2026-10-03T10:00:01.000Z', null);

  // A rec with only the opening summary, which differs from that rec's current def summary.
  await conv.run('syn-beta', '2026-10-01T08:00:00.000Z', null, null, null, null, '2026-10-01T08:00:02.000Z');
  await msg.run('syn-beta', 'fathom', '<p>Synthetic beta summary from an older plan</p>', '[]', 0, '2026-10-01T08:00:02.000Z', null);

  // A rec-keyed conversation whose rec is not in recs, with owner turns and no last_at.
  await conv.run('syn-gone', '2026-10-05T08:00:00.000Z', null, null, null, null, null);
  await msg.run('syn-gone', 'fathom', '<p>Synthetic gone opening summary</p>', '[]', 0, '2026-10-05T08:00:01.000Z', null);
  await msg.run('syn-gone', 'me', 'Synthetic gone question', '[]', 0, '2026-10-06T09:00:00.000Z', null);
  await msg.run('syn-gone', 'fathom', '<p>Synthetic gone answer</p>', '["syn-gone"]', 0, GONE_MAX_TS, null);

  // An empty rec-keyed conversation row.
  await conv.run('syn-hollow', '2026-10-01T08:00:00.000Z', null, null, null, null, '2026-10-01T08:00:00.000Z');

  // A pack conversation, an Ask thread with a manual title, an archived and a trashed thread.
  await conv.run('pack:syn-pack', '2026-10-07T08:00:00.000Z', null, null, null, null, '2026-10-07T08:00:05.000Z');
  await msg.run('pack:syn-pack', 'me', 'Synthetic what if prompt', '[]', 0, '2026-10-07T08:00:00.000Z', null);
  await msg.run('pack:syn-pack', 'fathom', '<p>Synthetic what if answer</p>', '["syn-alpha"]', 0, '2026-10-07T08:00:05.000Z', PROV);
  await conv.run('ask:0a1b2c3d4e5f', '2026-10-08T08:00:00.000Z', 'Synthetic manual title', 'manual', null, null, '2026-10-08T08:00:05.000Z');
  await msg.run('ask:0a1b2c3d4e5f', 'me', 'Synthetic thread question', '[]', 0, '2026-10-08T08:00:00.000Z', null);
  await msg.run('ask:0a1b2c3d4e5f', 'fathom', '<p>Synthetic thread answer</p>', '[]', 0, '2026-10-08T08:00:05.000Z', PROV);
  await conv.run('ask:111111111111', '2026-09-01T08:00:00.000Z', 'Synthetic archived title', 'auto', '2026-09-02T08:00:00.000Z', null, '2026-09-01T08:00:05.000Z');
  await msg.run('ask:111111111111', 'me', 'Synthetic archived question', '[]', 0, '2026-09-01T08:00:00.000Z', null);
  await conv.run('ask:222222222222', '2026-09-03T08:00:00.000Z', null, 'auto', null, '2026-09-04T08:00:00.000Z', '2026-09-03T08:00:05.000Z');
  await msg.run('ask:222222222222', 'me', 'Synthetic trashed question', '[]', 0, '2026-09-03T08:00:00.000Z', null);
}

const OLD_CONV_COLS = 'key, created_at, title, title_source, archived_at, trashed_at, last_at';
const convRow = async (db, key) => { const r = await db.prepare('SELECT * FROM conversations WHERE key = ?').get(key); return r ? { ...r } : null; };
const messageRows = async db => (await db.prepare('SELECT * FROM messages ORDER BY id').all()).map(r => ({ ...r }));
const withoutKey = ({ conversation_key: _k, ...rest }) => rest;

async function migratedStore(t) {
  const dir = await tempDir('fathom-rec-threads-');
  const db = await storeBeforeRecThreads(join(dir, DB_FILE));
  t.after(async () => { try { await db.close(); } catch { /* closed */ } await rm(dir, { recursive: true, force: true }); });
  assert.equal(await schemaVersion(db), BEFORE);
  await seedBeforeRecThreads(db);
  const before = {
    messages: await messageRows(db),
    kept: Object.fromEntries(await mapSeries(KEPT, async k => [k, { ...await db.prepare(`SELECT ${OLD_CONV_COLS} FROM conversations WHERE key = ?`).get(k) }])),
    created: Object.fromEntries((await db.prepare('SELECT key, created_at FROM conversations').all()).map(r => [r.key, r.created_at])),
  };
  const pending = listMigrations().map(m => m.id).filter(id => id > BEFORE);
  assert.equal(pending[0], REC_MIGRATION, 'migration 016 is next');
  assert.deepEqual(await migrate(db), { applied: pending });
  return { db, before };
}

// The thread a rec-keyed conversation moved to, found by rec_id.
async function movedTo(db, recId) {
  const rows = (await db.prepare('SELECT * FROM conversations WHERE rec_id = ?').all(recId)).map(r => ({ ...r }));
  assert.equal(rows.length, 1, `exactly one thread for ${recId}: ${JSON.stringify(rows)}`);
  return rows[0];
}

test('AC4 migration 016 adds rec_id and rec_detached_at and leaves no rec-keyed conversation', async t => {
  const { db } = await migratedStore(t);
  const cols = (await db.prepare('PRAGMA table_info(conversations)').all()).map(c => c.name);
  assert.ok(cols.includes('rec_id'), 'conversations.rec_id');
  assert.ok(cols.includes('rec_detached_at'), 'conversations.rec_detached_at');
  const keys = (await db.prepare('SELECT key FROM conversations ORDER BY key').all()).map(r => r.key);
  assert.deepEqual(keys.filter(k => !k.startsWith('ask:') && !k.startsWith('pack:')), [], `no rec-keyed conversation: ${keys}`);
  for (const k of ['syn-alpha', 'syn-beta', 'syn-gone', 'syn-hollow']) {
    assert.equal((await db.prepare('SELECT count(*) AS n FROM messages WHERE conversation_key = ?').get(k)).n, 0, `no message left under ${k}`);
  }
  assert.ok(keys.every(k => k.startsWith('pack:') || THREAD_KEY.test(k)), JSON.stringify(keys));
});

test('AC4 a rec conversation with owner turns becomes an active thread with every message moved unchanged', async t => {
  const { db, before } = await migratedStore(t);
  const alpha = await movedTo(db, 'syn-alpha');
  assert.match(alpha.key, THREAD_KEY);
  assert.equal(alpha.created_at, before.created['syn-alpha'], 'same created_at');
  assert.equal(alpha.last_at, ALPHA_LAST, 'the old last_at is kept');
  assert.equal(alpha.title, null);
  assert.equal(alpha.title_source, null);
  assert.equal(alpha.archived_at, null);
  assert.equal(alpha.trashed_at, null);
  assert.equal(alpha.rec_detached_at, null);
  const oldMsgs = before.messages.filter(m => m.conversation_key === 'syn-alpha').map(withoutKey);
  const newMsgs = (await db.prepare('SELECT * FROM messages WHERE conversation_key = ? ORDER BY id').all(alpha.key)).map(r => withoutKey({ ...r }));
  assert.equal(newMsgs.length, 5, 'opening summary and both turns');
  assert.deepEqual(newMsgs, oldMsgs, 'text, refs, notice, ts, provenance, role and id unchanged, in order');
  assert.equal(newMsgs[2].provenance, PROV);
  assert.equal(newMsgs[4].notice, 1);

  const gone = await movedTo(db, 'syn-gone');
  assert.match(gone.key, THREAD_KEY);
  assert.equal(gone.created_at, before.created['syn-gone']);
  assert.equal(gone.last_at, GONE_MAX_TS, 'a NULL last_at becomes the newest message ts');
  assert.equal(gone.archived_at, null, 'a thread whose rec is gone stays active');
  assert.equal(gone.rec_detached_at, null);
  assert.equal(gone.title, null);
  assert.equal(gone.title_source, null);
  assert.notEqual(gone.key, alpha.key);
});

test('AC4 a summary-only rec conversation becomes an archived, detached thread titled Opening summary', async t => {
  const { db, before } = await migratedStore(t);
  const beta = await movedTo(db, 'syn-beta');
  assert.match(beta.key, THREAD_KEY);
  assert.equal(beta.created_at, before.created['syn-beta']);
  assert.match(String(beta.archived_at), ISO, 'archived');
  assert.match(String(beta.rec_detached_at), ISO, 'detached');
  assert.equal(beta.trashed_at, null);
  assert.equal(beta.title, 'Opening summary');
  assert.equal(beta.title_source, 'auto');
  const oldMsgs = before.messages.filter(m => m.conversation_key === 'syn-beta').map(withoutKey);
  const newMsgs = (await db.prepare('SELECT * FROM messages WHERE conversation_key = ? ORDER BY id').all(beta.key)).map(r => withoutKey({ ...r }));
  assert.deepEqual(newMsgs, oldMsgs, 'the opening summary copy is kept byte for byte, not replaced by the current def summary');
});

test('AC4 an empty rec-keyed row is deleted; pack and Ask conversations are untouched', async t => {
  const { db, before } = await migratedStore(t);
  assert.equal(await convRow(db, 'syn-hollow'), null);
  assert.equal((await db.prepare("SELECT count(*) AS n FROM conversations WHERE rec_id = 'syn-hollow'").get()).n, 0, 'no thread for an empty conversation');
  for (const key of KEPT) {
    const row = await convRow(db, key);
    assert.ok(row, `${key} kept`);
    const { rec_id: recId, rec_detached_at: detached, ...old } = row;
    assert.deepEqual(old, before.kept[key], `${key} unchanged`);
    assert.equal(recId, null, `${key} has no rec`);
    assert.equal(detached, null);
  }
});

test('AC4 every message row is byte-identical apart from its conversation key, and the count is unchanged', async t => {
  const { db, before } = await migratedStore(t);
  const after = await messageRows(db);
  assert.equal(after.length, before.messages.length, 'total message count unchanged');
  const byId = new Map(after.map(r => [r.id, r]));
  const moved = new Map();
  for (const old of before.messages) {
    const now = byId.get(old.id);
    assert.ok(now, `message ${old.id} kept`);
    assert.deepEqual(withoutKey(now), withoutKey(old), `message ${old.id} unchanged`);
    if (KEPT.includes(old.conversation_key)) assert.equal(now.conversation_key, old.conversation_key);
    else {
      const to = moved.get(old.conversation_key) || now.conversation_key;
      moved.set(old.conversation_key, to);
      assert.equal(now.conversation_key, to, `every message of ${old.conversation_key} moved to one thread`);
      assert.match(now.conversation_key, THREAD_KEY);
    }
  }
  assert.equal(new Set(moved.values()).size, 3, 'each rec conversation got its own thread');
});

test('AC4 listThreads, getThread and buildScenario carry recId on the migrated store; a second migrate applies nothing', async t => {
  const { db } = await migratedStore(t);
  const alpha = await movedTo(db, 'syn-alpha');
  const beta = await movedTo(db, 'syn-beta');
  const gone = await movedTo(db, 'syn-gone');

  const lists = await listThreads(db);
  const find = (list, key) => list.find(x => x.key === key);
  assert.equal(find(lists.active, alpha.key).recId, 'syn-alpha');
  assert.equal(find(lists.active, alpha.key).recDetachedAt, null);
  assert.equal(find(lists.active, gone.key).recId, 'syn-gone');
  assert.equal(find(lists.active, 'ask:0a1b2c3d4e5f').recId, null);
  assert.equal(find(lists.active, 'ask:0a1b2c3d4e5f').title, 'Synthetic manual title');
  const b = find(lists.archived, beta.key);
  assert.ok(b, 'the summary-only thread is under archived');
  assert.equal(b.recId, 'syn-beta');
  assert.match(String(b.recDetachedAt), ISO);
  assert.equal(b.title, 'Opening summary');
  assert.ok(find(lists.archived, 'ask:111111111111'));
  assert.ok(find(lists.trash, 'ask:222222222222'));
  assert.equal(find(lists.active, alpha.key).turns, 2);
  assert.equal((await getThread(db, alpha.key.slice(4))).recId, 'syn-alpha');

  const scenario = await buildScenario(db, { clock: '2026-11-05' });
  const live = scenario.live.threads.find(x => x.key === alpha.key);
  assert.equal(live.recId, 'syn-alpha');
  assert.equal(live.recDetachedAt, null);
  assert.equal(scenario.live.threads.find(x => x.key === beta.key).recId, 'syn-beta');
  assert.equal(scenario.live.conversations[alpha.key].length, 5);
  assert.ok(!('syn-alpha' in scenario.live.conversations));
  assert.equal(recForKey(scenario, alpha.key).id, 'syn-alpha', 'the moved thread resolves to its rec');
  assert.equal(recForKey(scenario, gone.key), null, 'a thread whose rec is gone has no rec context');

  assert.deepEqual(await migrate(db), { applied: [] }, 'a second migrate applies nothing');
});

// ---------------------------------------------------------------- recForKey

test('recForKey resolves a rec id and a rec thread to the rec, and anything else to null', () => {
  const scenario = {
    recs: [{ id: 'syn-a', title: 'Synthetic A' }, { id: 'syn-b', title: 'Synthetic B', status: 'hidden' }],
    live: { threads: [
      { key: 'ask:aaaaaaaaaaaa', id: 'aaaaaaaaaaaa', recId: 'syn-a', recDetachedAt: null },
      { key: 'ask:bbbbbbbbbbbb', id: 'bbbbbbbbbbbb', recId: null, recDetachedAt: null },
      { key: 'ask:cccccccccccc', id: 'cccccccccccc', recId: 'syn-retired', recDetachedAt: null },
      { key: 'ask:dddddddddddd', id: 'dddddddddddd', recId: 'syn-a', recDetachedAt: '2026-11-01T00:00:00.000Z' },
    ] },
  };
  assert.equal(recForKey(scenario, 'syn-a').id, 'syn-a', 'a rec id');
  assert.equal(recForKey(scenario, 'ask:aaaaaaaaaaaa').id, 'syn-a', 'a thread asked from the rec');
  assert.equal(recForKey(scenario, 'ask:dddddddddddd').id, 'syn-a', 'a detached thread keeps its rec context');
  assert.equal(recForKey(scenario, 'ask:bbbbbbbbbbbb'), null, 'a thread with no rec');
  assert.equal(recForKey(scenario, 'ask:cccccccccccc'), null, 'a thread whose rec no longer exists');
  assert.equal(recForKey(scenario, 'ask:eeeeeeeeeeee'), null, 'an unknown thread');
  assert.equal(recForKey(scenario, 'pack:syn-a'), null, 'a pack conversation');
  assert.equal(recForKey(scenario, 'syn-missing'), null);
});

// ---------------------------------------------------------------- API (in process, fake engine)

async function demoCtx(t) {
  const s = await tempDb();
  t.after(async () => { await s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  await seedDemo(s.db);
  const config = loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'fake', FATHOM_FAKE_STREAM_MS: '0' });
  const engine = await createRuntimeEngine({ db: s.db, config });
  // The temp store's directory stands in as the household root.
  const packs = createLivePacks(s.db, { dataDir: s.dataDir });
  await packs.refresh();
  const answerer = createLiveAnswerer({ engine, packs, root: s.dataDir, services: { engine, config: { dataDir: s.dataDir } } });
  const ctx = (body = {}, extra = {}) => ({ db: s.db, config, engine, packs, answerer, params: {}, body, ...extra });
  return { ...s, config, engine, packs, answerer, ctx };
}

const httpError = status => e => e instanceof HttpError && e.status === status;
const toolNames = m => (m.provenance && m.provenance.tools || []).map(x => x.name);
const recTool = m => (m.provenance && m.provenance.tools || []).find(x => x.name === 'recommendations');
const recRows = async db => (await db.prepare('SELECT count(*) AS n FROM conversations WHERE rec_id IS NOT NULL').get()).n;
const allConvs = async db => (await db.prepare('SELECT count(*) AS n FROM conversations').get()).n;

test('POST /api/threads with recId and text asks in a new thread grounded in that rec', async t => {
  const s = await demoCtx(t);
  const r = await threadCreate(s.ctx({ recId: 'deferral', text: 'How does this affect our December cash' }));
  assert.match(r.thread.key, THREAD_KEY);
  assert.equal(r.thread.recId, 'deferral');
  assert.equal(r.thread.recDetachedAt, null);
  assert.equal(r.thread.turns, 1);
  assert.equal(r.message.role, 'fathom');
  assert.equal(r.message.notice, false);
  assert.deepEqual(recTool(r.message).args, { operation: 'detail', id: 'deferral' }, 'recommendations.detail reads the rec, not the thread key');
  assert.ok(r.message.refs.includes('deferral'), 'the reply refs the rec');
  assert.equal(r.scenario.live.threads.find(x => x.key === r.thread.key).recId, 'deferral');
  assert.equal((await getThread(s.db, r.thread.id)).recId, 'deferral');
  assert.equal((await listThreads(s.db)).active.find(x => x.id === r.thread.id).recId, 'deferral');
  assert.deepEqual(r.scenario.live.conversations[r.thread.key].map(m => m.role), ['me', 'fathom']);
  assert.equal(recForKey(r.scenario, r.thread.key).id, 'deferral');
});

test('POST /api/threads with recId and questionId answers that rec.qa question exactly as a rec conversation did', async t => {
  const s = await demoCtx(t);
  const qa = demo.recs.find(x => x.id === 'deferral').qa;
  for (const questionId of [0, 1, '1']) {
    const i = Number(questionId);
    // The reference: the answerer asked in the rec's own context (a bare rec id still resolves).
    const direct = await s.answerer.answer({ db: s.db, key: 'deferral', questionId: i, clock: s.config.clock });
    const r = await threadCreate(s.ctx({ recId: 'deferral', questionId }));
    assert.equal(r.thread.recId, 'deferral');
    const conv = r.scenario.live.conversations[r.thread.key];
    assert.ok(conv[0].text.includes(qa[i].q), `the owner message is rec.qa[${i}]`);
    assert.equal(r.message.text, wrapBlocks(direct.paragraphs), `rec.qa[${i}] canned answer`);
    const words = qa[i].a[0].replace(/<[^>]*>/g, ' ').split(/[^A-Za-z ]+/).map(x => x.trim()).sort((a, b) => b.length - a.length)[0];
    assert.ok(r.message.text.includes(words), `${words} in ${r.message.text}`);
    assert.deepEqual(r.message.refs, direct.refs);
    assert.ok(r.message.refs.includes('deferral'));
    assert.deepEqual(toolNames(r.message), direct.provenance.tools.map(x => x.name));
    assert.deepEqual(recTool(r.message).args, { operation: 'detail', id: 'deferral' });
  }
  // By rec.qa id or exact question too, the way findQuestion resolves it.
  assert.equal(findQuestion(await buildScenario(s.db), 'deferral', qa[0].q).q, qa[0].q);
});

test('POST /api/threads with recId refuses unknown and hidden recs, an empty body and an unknown question; a valid one succeeds', async t => {
  const s = await demoCtx(t);
  const hidden = await s.db.prepare("SELECT id FROM recs WHERE status = 'hidden' LIMIT 1").get();
  assert.ok(hidden, 'the demo has a hidden rec');
  const n = await allConvs(s.db);
  await assert.rejects(threadCreate(s.ctx({ recId: 'no-such-rec', text: 'Synthetic question' })), httpError(404));
  await assert.rejects(threadCreate(s.ctx({ recId: hidden.id, text: 'Synthetic question' })), httpError(404));
  await assert.rejects(threadCreate(s.ctx({ recId: 'deferral' })), httpError(400));
  await assert.rejects(threadCreate(s.ctx({ recId: 'deferral', text: null, questionId: null })), httpError(400));
  await assert.rejects(threadCreate(s.ctx({ recId: 'deferral', questionId: 99 })), httpError(404));
  await assert.rejects(threadCreate(s.ctx({ recId: 'deferral', questionId: 'no-such-question' })), httpError(404));
  assert.equal(await allConvs(s.db), n, 'no refusal stores a conversation');
  assert.equal(await recRows(s.db), 0);

  // Liveness: the same rec with a question succeeds.
  const okText = await threadCreate(s.ctx({ recId: 'deferral', text: 'Synthetic question' }));
  assert.equal(okText.thread.recId, 'deferral');
  const okQ = await threadCreate(s.ctx({ recId: 'deferral', questionId: 0 }));
  assert.equal(okQ.thread.recId, 'deferral');
  assert.equal(await recRows(s.db), 2);
});

test('a failed answer to POST /api/threads with recId leaves no thread row behind', async t => {
  const s = await demoCtx(t);
  const n = await allConvs(s.db);
  const throwing = { answer: async () => { throw new Error('synthetic engine failure'); } };
  await assert.rejects(threadCreate(s.ctx({ recId: 'deferral', text: 'Synthetic question' }, { answerer: throwing })));
  assert.equal(await allConvs(s.db), n, 'nothing left after a throw');
  const empty = { answer: async () => null };
  await assert.rejects(threadCreate(s.ctx({ recId: 'deferral', text: 'Synthetic question' }, { answerer: empty })));
  assert.equal(await allConvs(s.db), n, 'nothing left after a null answer');
  assert.equal(await recRows(s.db), 0);
  assert.equal((await s.db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_key LIKE 'ask:%'").get()).n, 0);
  // Liveness: with the real answerer the same request stores one thread.
  await threadCreate(s.ctx({ recId: 'deferral', text: 'Synthetic question' }));
  assert.equal(await recRows(s.db), 1);
});

test('POST /api/ask refuses a bare rec id key and continues a rec thread with rec context', async t => {
  const s = await demoCtx(t);
  const n = await allConvs(s.db);
  await assert.rejects(ask(s.ctx({ key: 'deferral', text: 'Synthetic question' })), httpError(400));
  await assert.rejects(ask(s.ctx({ key: 'deferral', questionId: 0 })), httpError(400));
  await assert.rejects(ask(s.ctx({ key: 'no-such-rec', text: 'Synthetic question' })), httpError(400));
  assert.equal(await allConvs(s.db), n, 'refused asks store nothing');

  const first = await threadCreate(s.ctx({ recId: 'deferral', text: 'Synthetic first question' }));
  const next = await ask(s.ctx({ key: first.thread.key, text: 'Synthetic follow up question' }));
  assert.equal(next.message.role, 'fathom');
  assert.deepEqual(recTool(next.message).args, { operation: 'detail', id: 'deferral' }, 'the follow up is grounded in the rec');
  assert.ok(next.message.refs.includes('deferral'));
  const qa = demo.recs.find(x => x.id === 'deferral').qa;
  const chip = await ask(s.ctx({ key: first.thread.key, questionId: 1 }));
  const conv = chip.scenario.live.conversations[first.thread.key];
  assert.equal(conv.length, 6);
  assert.ok(conv[4].text.includes(qa[1].q), 'a rec.qa chip asked in the rec thread');
  const direct = await s.answerer.answer({ db: s.db, key: 'deferral', questionId: 1, clock: s.config.clock });
  assert.equal(chip.message.text, wrapBlocks(direct.paragraphs));
  assert.equal((await getThread(s.db, first.thread.id)).turns, 3);
});

test('AC3 a rec thread created through POST /api/threads has a title after its first answer', async t => {
  const s = await demoCtx(t);
  const r = await threadCreate(s.ctx({ recId: 'deferral', text: 'Should we hold the December invoices' }));
  assert.equal(typeof r.thread.title, 'string');
  assert.ok(r.thread.title.length > 0);
  assert.equal(r.thread.titleSource, 'auto');
  assert.equal((await getThread(s.db, r.thread.id)).title, r.thread.title);
  const byChip = await threadCreate(s.ctx({ recId: 'deferral', questionId: 0 }));
  assert.equal(typeof byChip.thread.title, 'string', 'a chip question names the thread too');
  assert.equal(byChip.thread.titleSource, 'auto');
});

test('AC3 POST /api/threads with text returns a thread whose title is set after the first answer', async t => {
  const s = await demoCtx(t);
  const r = await threadCreate(s.ctx({ text: 'How should we think about the quarterly estimates' }));
  assert.equal(r.thread.title, 'How should we think about the quarterly');
  assert.equal(r.thread.titleSource, 'auto');
  assert.equal(r.scenario.live.threads.find(x => x.key === r.thread.key).title, r.thread.title);
});

test('the fake engine scripts no goal proposal in a rec thread and still does in a plain Ask thread', async t => {
  const s = await demoCtx(t);
  const GOAL = 'add a goal: a synthetic boat fund';
  const recThread = await threadCreate(s.ctx({ recId: 'deferral', text: 'Synthetic first question' }));
  const inRec = await ask(s.ctx({ key: recThread.thread.key, text: GOAL }));
  assert.ok(toolNames(inRec.message).includes('update_goal'), JSON.stringify(toolNames(inRec.message)));
  assert.ok(inRec.message.text.includes(GOAL_CONFIRM), inRec.message.text);
  assert.equal(inRec.message.provenance.goalProposal ?? null, null);
  assert.deepEqual(recTool(inRec.message).args, { operation: 'detail', id: 'deferral' });

  const plain = await threadCreate(s.ctx({ text: GOAL }));
  assert.equal(plain.thread.recId, null);
  assert.ok(toolNames(plain.message).includes('update_goal'));
  assert.ok(plain.message.text.includes(GOAL_CONFIRM), plain.message.text);
});

test('fakeAnswerScript reads the resolved rec in a rec thread and offers no goal there', async t => {
  const s = await demoCtx(t);
  const now = '2026-11-05T09:00:00.000Z';
  await s.db.prepare('INSERT INTO conversations (key, created_at, last_at, rec_id) VALUES (?, ?, ?, ?)').run('ask:aaaaaaaaaaaa', now, now, 'deferral');
  await s.db.prepare('INSERT INTO conversations (key, created_at, last_at) VALUES (?, ?, ?)').run('ask:bbbbbbbbbbbb', now, now);
  const scenario = await buildScenario(s.db);
  const calls = (key, text, propose = true) => fakeAnswerScript({ scenario, key, text, propose })[0].toolCalls;
  const text = (key, t2) => fakeAnswerScript({ scenario, key, text: t2, propose: true })[1].text;

  const inRec = calls('ask:aaaaaaaaaaaa', 'How does this work');
  assert.deepEqual(inRec.find(c => c.name === 'recommendations'), { name: 'recommendations', args: { operation: 'detail',  id: 'deferral' } });
  assert.ok(!calls('ask:bbbbbbbbbbbb', 'How does this work').some(c => c.name === 'recommendations'), 'a plain thread reads no rec');
  assert.deepEqual(calls('deferral', 'How does this work').find(c => c.name === 'recommendations').args, { operation: 'detail', id: 'deferral' });

  assert.ok(calls('ask:aaaaaaaaaaaa', 'add a goal: a synthetic boat fund').some(c => c.name === 'update_goal'));
  assert.ok(text('ask:aaaaaaaaaaaa', 'add a goal: a synthetic boat fund').includes(GOAL_CONFIRM));
  assert.ok(calls('ask:bbbbbbbbbbbb', 'add a goal: a synthetic boat fund').some(c => c.name === 'update_goal'));
  assert.ok(text('ask:bbbbbbbbbbbb', 'add a goal: a synthetic boat fund').includes(GOAL_CONFIRM));
  // An explicit command in a rec thread still names its own rec.
  assert.deepEqual(calls('ask:aaaaaaaaaaaa', 'dismiss this').find(c => c.name === 'act_on_recommendation').args, { operation: 'status', id: 'deferral', status: 'dismissed' });
});

// ---------------------------------------------------------------- API over HTTP

function events(text) {
  return text.split('\n\n').filter(b => b.trim() && !b.startsWith(':')).map(block => {
    const name = /^event: (.+)$/m.exec(block)[1];
    const data = JSON.parse(/^data: (.+)$/m.exec(block)[1]);
    return { name, data };
  });
}

async function ok(resPromise) {
  const r = await resPromise;
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.text.slice(0, 300)}`);
  return r.json;
}

async function fails(resPromise, status) {
  const r = await resPromise;
  assert.equal(r.status, status, `expected ${status}, got ${r.status}: ${r.text.slice(0, 300)}`);
  return r;
}

const threadsOf = s => ok(request(s.baseUrl, { path: '/api/threads' }));
const startOver = (s, id) => postJson(s.baseUrl, `/api/recs/${id}/start-over`, {});

test('POST /api/threads with recId streams start with the thread key, then progress, then final', T, async () => withServer({ env: FAKE }, async s => {
  const r = await postJson(s.baseUrl, '/api/threads', { recId: 'deferral', text: 'Give me a quick read on this one' }, { accept: 'text/event-stream' });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/event-stream/);
  const evs = events(r.text);
  const names = evs.map(e => e.name);
  assert.equal(names[0], 'start');
  assert.match(evs[0].data.key, THREAD_KEY);
  assert.equal(names[1], 'progress');
  // Only progress streams; the answer arrives once, in the final event.
  assert.equal(names.includes('text'), false, `no answer text streams: ${names}`);
  assert.equal(names.at(-1), 'final');
  const final = evs.at(-1).data;
  assert.equal(final.thread.key, evs[0].data.key);
  assert.equal(final.thread.recId, 'deferral');
  assert.equal(final.message.role, 'fathom');
  assert.deepEqual(recTool(final.message).args, { operation: 'detail', id: 'deferral' });
  assert.ok(final.message.refs.includes('deferral'));
  const db = await openStore(s.dbFile);
  try {
    const row = await db.prepare('SELECT rec_id FROM conversations WHERE key = ?').get(final.thread.key);
    assert.equal(row.rec_id, 'deferral');
    assert.deepEqual((await db.prepare('SELECT role FROM messages WHERE conversation_key = ? ORDER BY id').all(final.thread.key)).map(x => x.role), ['me', 'fathom']);
  } finally { await db.close(); }
}));

test('POST /api/threads and /api/ask refusals over HTTP, each next to a request that succeeds', T, async () => withServer({ env: FAKE }, async s => {
  await fails(postJson(s.baseUrl, '/api/threads', { recId: 'no-such-rec', text: 'Synthetic question' }), 404);
  await fails(postJson(s.baseUrl, '/api/threads', { recId: 'daf', text: 'Synthetic question' }), 404);
  await fails(postJson(s.baseUrl, '/api/threads', { recId: 'deferral' }), 400);
  await fails(postJson(s.baseUrl, '/api/threads', { recId: 'deferral', questionId: 99 }), 404);
  await fails(postJson(s.baseUrl, '/api/ask', { key: 'deferral', text: 'Synthetic question' }), 400);
  await fails(postJson(s.baseUrl, '/api/ask', { key: 'deferral', questionId: 0 }), 400);
  const empty = await threadsOf(s);
  assert.deepEqual([...empty.active, ...empty.archived, ...empty.trash], [], 'no refusal made a thread');

  const made = await ok(postJson(s.baseUrl, '/api/threads', { recId: 'deferral', text: 'Synthetic question' }));
  assert.equal(made.thread.recId, 'deferral');
  const more = await ok(postJson(s.baseUrl, '/api/ask', { key: made.thread.key, text: 'Synthetic follow up' }));
  assert.deepEqual(recTool(more.message).args, { operation: 'detail', id: 'deferral' });
  assert.equal(more.scenario.live.conversations[made.thread.key].length, 4);
}));

test('POST /api/recs/:id/start-over detaches every attached thread of that rec and keeps them in Ask', T, async () => withServer({ env: FAKE }, async s => {
  const a = (await ok(postJson(s.baseUrl, '/api/threads', { recId: 'deferral', text: 'Synthetic question one' }))).thread;
  const b = (await ok(postJson(s.baseUrl, '/api/threads', { recId: 'deferral', questionId: 0 }))).thread;
  const other = (await ok(postJson(s.baseUrl, '/api/threads', { recId: 'dcfsa', text: 'Synthetic other rec question' }))).thread;
  const plain = (await ok(postJson(s.baseUrl, '/api/threads', { text: 'Synthetic plain question' }))).thread;

  await fails(startOver(s, 'no-such-rec'), 404);
  await fails(startOver(s, 'daf'), 404);
  const unchanged = await threadsOf(s);
  assert.ok(unchanged.active.every(x => x.recDetachedAt === null), 'refused start-over detaches nothing');

  const res = await ok(startOver(s, 'deferral'));
  assert.ok(res.scenario && res.scenario.live, 'returns the scenario');
  const live = id => res.scenario.live.threads.find(x => x.id === id);
  assert.match(String(live(a.id).recDetachedAt), ISO);
  assert.match(String(live(b.id).recDetachedAt), ISO);
  assert.equal(live(other.id).recDetachedAt, null, 'another rec keeps its thread attached');
  assert.equal(live(plain.id).recDetachedAt, null);

  const lists = await threadsOf(s);
  for (const th of [a, b]) {
    const listed = lists.active.find(x => x.id === th.id);
    assert.ok(listed, `${th.id} stays active`);
    assert.equal(listed.archivedAt, null);
    assert.equal(listed.trashedAt, null);
    assert.equal(listed.recId, 'deferral', 'the context reference is kept');
    assert.equal(listed.title, th.title, 'the title is kept');
    const opened = await ok(request(s.baseUrl, { path: `/api/threads/${th.id}` }));
    assert.equal(opened.messages.length, 2, 'every message kept');
    assert.match(String(opened.thread.recDetachedAt), ISO);
  }
  assert.ok(!lists.archived.length && !lists.trash.length);
  const firstDetach = lists.active.find(x => x.id === a.id).recDetachedAt;

  // A new thread for the rec is attached; a second start-over detaches only it.
  const c = (await ok(postJson(s.baseUrl, '/api/threads', { recId: 'deferral', text: 'Synthetic question after start over' }))).thread;
  assert.equal(c.recDetachedAt, null);
  await ok(startOver(s, 'deferral'));
  const again = await threadsOf(s);
  assert.match(String(again.active.find(x => x.id === c.id).recDetachedAt), ISO);
  assert.equal(again.active.find(x => x.id === a.id).recDetachedAt, firstDetach, 'an already detached thread is not touched');
  assert.equal(again.active.length, 5);
}));
