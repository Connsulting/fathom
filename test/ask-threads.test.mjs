// Ask threads (item 13): ChatGPT-style conversations. Schema and routes with the session gate (AC9),
// the 010 migration of the old single 'ask' conversation and per-rec isolation (AC6), reopening
// and continuing a thread with only its own history (AC5), archive, trash, restore, delete and the
// 30 day trash-purge job (AC4), and naming over HTTP (AC3). Every fixture is synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { join } from 'node:path';
import { openDb, migrate, listMigrations, setSetting, DB_FILE } from '../src/store/db.mjs';
import { seedDemo } from '../demo/seed.mjs';
import { loadConfig } from '../src/config.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { createLivePacks } from '../src/packs/live.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { createThread, purgeTrash } from '../src/api/threads.mjs';
import { defaultHandlers } from '../src/jobs/scheduler.mjs';
import {
  SERVER_TIMEOUT, withAuthenticatedServer, withServer, spawnServer, openStore, tempDb, tempDir, migrateLegacyStore,
} from './helpers/server.mjs';

const T = { timeout: SERVER_TIMEOUT };
const T2 = { timeout: SERVER_TIMEOUT * 2 };
const FAKE = { FATHOM_ENGINE: 'fake' };
const REAL = { FATHOM_DEMO: '0', FATHOM_ENGINE: 'off' };
const THREAD_KEY = /^ask:[a-f0-9]{12}$/;
const THREAD_FIELDS = ['archivedAt', 'createdAt', 'id', 'key', 'lastAt', 'recDetachedAt', 'recId', 'title', 'titleSource', 'trashedAt', 'turns'];
const DAY = 24 * 60 * 60 * 1000;

async function ok(resPromise) {
  const r = await resPromise;
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.text.slice(0, 300)}`);
  assert.ok(r.json, 'JSON body');
  return r.json;
}

async function fails(resPromise, status) {
  const r = await resPromise;
  assert.equal(r.status, status, `expected ${status}, got ${r.status}: ${r.text.slice(0, 300)}`);
  return r;
}

async function readDb(file, fn) {
  const db = await openStore(file);
  try { return await fn(db); } finally { db.close(); }
}

const listThreads = s => ok(s.request({ path: '/api/threads' }));
const openThread = (s, id) => ok(s.request({ path: `/api/threads/${id}` }));
const newThread = (s, body = {}) => ok(s.postJson('/api/threads', body));
const threadAct = (s, id, action, body = {}) => s.postJson(`/api/threads/${id}/${action}`, body);
const ask = (s, key, text) => ok(s.postJson('/api/ask', { key, text }));
const idsOf = list => list.map(t => t.id);
const allIds = lists => [...lists.active, ...lists.archived, ...lists.trash].map(t => t.id);
const toolNamesOf = req => (req.tools || []).map(x => x.name);
const titleSpend = file => readDb(file, db => db.prepare("SELECT count(*) AS n FROM spend_ledger WHERE purpose = 'title'").get().n);

// A store file at schema 007 (the last migration before threads), built the way db.mjs migrate
// applies migrations; `init(db)` adds rows before it is closed.
function storeAt007(file, init) {
  const db = openDb(file);
  try {
    db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const record = db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, '2026-10-01T00:00:00.000Z')");
    for (const m of listMigrations().filter(x => x.id <= 7)) {
      db.exec('BEGIN');
      db.exec(readFileSync(m.file, 'utf8'));
      record.run(m.id, m.name);
      db.exec('COMMIT');
    }
    assert.ok(!db.prepare('PRAGMA table_info(conversations)').all().some(c => c.name === 'title'), 'the fixture is pre-threads');
    init(db);
  } finally {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  }
}

const OLD_ASK = [
  { role: 'me', text: 'Synthetic question before threads', ts: '2026-10-02T09:00:00.000Z' },
  { role: 'fathom', text: '<p>Synthetic answer before threads</p>', ts: '2026-10-02T09:00:05.000Z' },
  { role: 'me', text: 'Synthetic follow up before threads', ts: '2026-10-03T10:00:00.000Z' },
];
const OLD_ASK_CREATED = '2026-10-02T08:59:00.000Z';
const REC_CREATED = '2026-10-01T08:00:00.000Z';
const REC_MSG = { role: 'fathom', text: '<p>Synthetic rec opening</p>', ts: '2026-10-01T08:00:01.000Z' };

function addConversation(db, key, createdAt, messages = []) {
  db.prepare('INSERT INTO conversations (key, created_at) VALUES (?, ?)').run(key, createdAt);
  const msg = db.prepare("INSERT INTO messages (conversation_key, role, text, refs, notice, ts) VALUES (?, ?, ?, '[]', 0, ?)");
  for (const m of messages) msg.run(key, m.role, m.text, m.ts);
}

const messagesOf = (db, key) => db.prepare('SELECT role, text, ts FROM messages WHERE conversation_key = ? ORDER BY id')
  .all(key).map(r => ({ ...r }));

// ---------------------------------------------------------------- AC9: schema, routes, gate

test('AC9 a freshly migrated store has the thread columns on conversations', async () => {
  const t = await tempDb();
  try {
    const cols = t.db.prepare('PRAGMA table_info(conversations)').all().map(c => c.name);
    for (const c of ['title', 'title_source', 'archived_at', 'trashed_at', 'last_at']) assert.ok(cols.includes(c), `conversations.${c}`);
  } finally {
    t.close();
  }
});

test('AC9 POST /api/threads creates an empty thread; list, open and the scenario carry it', T, () => withServer({ env: FAKE }, async s => {
  const empty = await listThreads(s);
  assert.deepEqual(Object.keys(empty).sort(), ['active', 'archived', 'trash']);
  assert.deepEqual(empty, { active: [], archived: [], trash: [] }, 'a fresh demo store has no threads');

  const made = await newThread(s, {});
  assert.ok(made.scenario, 'the response carries the scenario');
  assert.ok(made.message == null, 'no message without a question');
  const th = made.thread;
  assert.deepEqual(Object.keys(th).sort(), THREAD_FIELDS);
  assert.match(th.key, THREAD_KEY);
  assert.equal(th.key, `ask:${th.id}`);
  assert.match(th.id, /^[a-f0-9]{12}$/);
  assert.equal(th.title, null);
  assert.equal(th.titleSource, null);
  assert.equal(th.turns, 0);
  assert.equal(th.archivedAt, null);
  assert.equal(th.trashedAt, null);
  assert.equal(th.recId, null, 'a plain Ask thread has no rec context');
  assert.equal(th.recDetachedAt, null);
  assert.ok(th.createdAt && th.lastAt);

  const lists = await listThreads(s);
  assert.deepEqual(idsOf(lists.active), [th.id]);
  assert.deepEqual(lists.archived, []);
  assert.deepEqual(lists.trash, []);

  const opened = await openThread(s, th.id);
  assert.deepEqual(Object.keys(opened).sort(), ['messages', 'thread']);
  assert.equal(opened.thread.key, th.key);
  assert.deepEqual(opened.messages, []);

  const sc = await s.getScenario();
  assert.ok(Array.isArray(sc.live.threads));
  assert.deepEqual(sc.live.threads.map(x => x.key), [th.key]);
  assert.ok(!('ask' in sc.live.conversations), 'no bare ask conversation');

  const second = (await newThread(s, {})).thread;
  assert.notEqual(second.id, th.id, 'each thread gets its own id');
}));

test('AC9 the scenario lists Ask starters in the pinned order with yearend always last', T, () => withServer({ env: FAKE }, async s => {
  const starters = (await s.getScenario()).live.askStarters;
  const order = ['attention', 'taxes', 'scorp', 'yearend'];
  assert.ok(Array.isArray(starters) && starters.length >= 1 && starters.length <= 4, JSON.stringify(starters));
  for (const st of starters) {
    assert.deepEqual(Object.keys(st).sort(), ['id', 'q']);
    assert.ok(order.includes(st.id), st.id);
    assert.ok(!/\{/.test(st.q), 'starters carry no tokens');
  }
  const ids = starters.map(x => x.id);
  assert.deepEqual(ids, order.filter(id => ids.includes(id)), 'pinned order');
  assert.equal(ids.at(-1), 'yearend');
  assert.equal(starters.at(-1).q, 'What should we do before the year ends?');
  assert.ok(ids.includes('attention'), 'the demo has visible proposed recs');

  const r = await newThread(s, { questionId: 'yearend' });
  assert.equal(r.thread.turns, 1);
  assert.equal(r.message.role, 'fathom');
  const opened = await openThread(s, r.thread.id);
  assert.equal(opened.messages[0].role, 'me');
  assert.ok(opened.messages[0].text.includes('What should we do before the year ends?'), opened.messages[0].text);
  const unknown = await s.postJson('/api/threads', { questionId: 'no-such-starter' });
  assert.ok([400, 404].includes(unknown.status), `unknown starter -> ${unknown.status}`);
}));

test('AC9 unknown ids and ids with bad characters are 404 on every thread route', T, () => withServer({ env: FAKE }, async s => {
  const bad = ['0123456789ab', 'ZZZ', '..%2Fx', 'ask%3A0123456789ab', '0123456789AB', '0123456789abc'];
  for (const id of bad) {
    await fails(s.request({ path: `/api/threads/${id}` }), 404);
    for (const action of ['rename', 'archive', 'trash', 'restore', 'delete']) {
      const body = action === 'rename' ? { title: 'Synthetic name' } : {};
      await fails(threadAct(s, id, action, body), 404);
    }
  }
}));

test('AC9 rename, archive, trash, restore and delete answer as the API table says', T, () => withServer({ env: FAKE }, async s => {
  const { thread } = await newThread(s, {});
  const renamed = await ok(threadAct(s, thread.id, 'rename', { title: 'Synthetic name' }));
  assert.ok(renamed.scenario);
  assert.equal(renamed.thread.title, 'Synthetic name');
  assert.equal(renamed.thread.titleSource, 'manual');

  const archived = await ok(threadAct(s, thread.id, 'archive'));
  assert.ok(archived.scenario);
  assert.equal(typeof archived.thread.archivedAt, 'string');
  assert.equal(archived.thread.trashedAt, null);

  const restored = await ok(threadAct(s, thread.id, 'restore'));
  assert.equal(restored.thread.archivedAt, null, 'restore clears archived_at when not trashed');

  await fails(threadAct(s, thread.id, 'delete'), 409);
  const trashed = await ok(threadAct(s, thread.id, 'trash'));
  assert.equal(typeof trashed.thread.trashedAt, 'string');
  const opened = await openThread(s, thread.id);
  assert.equal(opened.thread.id, thread.id, 'a trashed thread still opens');

  const gone = await ok(threadAct(s, thread.id, 'delete'));
  assert.ok(gone.scenario);
  assert.ok(!gone.scenario.live.threads.some(x => x.id === thread.id));
  await fails(s.request({ path: `/api/threads/${thread.id}` }), 404);
}));

test('AC9 on a real store the thread routes need an enrolled session', T, () => withAuthenticatedServer({ env: REAL }, async s => {
  const anon = { cookie: undefined, origin: s.baseUrl };
  const list = await s.request({ path: '/api/threads', headers: anon });
  assert.equal(list.status, 401, list.text);
  const create = await s.postJson('/api/threads', {}, anon);
  assert.equal(create.status, 401, create.text);
  const r = await readDb(s.dbFile, db => db.prepare("SELECT count(*) AS n FROM conversations WHERE key LIKE 'ask:%'").get().n);
  assert.equal(r, 0, 'the refused POST created nothing');

  const made = await newThread(s, {});
  assert.match(made.thread.key, THREAD_KEY);
  const lists = await listThreads(s);
  assert.deepEqual(idsOf(lists.active), [made.thread.id]);
  const open = await s.request({ path: `/api/threads/${made.thread.id}`, headers: anon });
  assert.equal(open.status, 401);
}));

test('AC9 POST /api/ask requires a key and the bare ask key is gone', T, () => withServer({ env: FAKE }, async s => {
  await fails(s.postJson('/api/ask', { text: 'hello' }), 400);
  // Neither an Ask thread key nor a pack key.
  await fails(s.postJson('/api/ask', { key: 'ask', text: 'hello' }), 400);
  await fails(s.postJson('/api/ask', { key: 'ask:0123456789ab', text: 'hello' }), 404);
  const n = await readDb(s.dbFile, db => db.prepare('SELECT count(*) AS n FROM conversations WHERE key = ? OR key LIKE ?').get('ask', 'ask:%').n);
  assert.equal(n, 0, 'refused asks create no conversation');
}));

// ---------------------------------------------------------------- AC6: migration and isolation

test('AC6 migrating a 007 store moves the ask conversation into one thread with the same messages', async () => {
  const dir = await tempDir('fathom-threads-');
  try {
    const file = join(dir, DB_FILE);
    storeAt007(file, db => {
      addConversation(db, 'ask', OLD_ASK_CREATED, OLD_ASK);
      addConversation(db, 'deferral', REC_CREATED, [REC_MSG]);
      addConversation(db, 'pack:giving', '2026-10-01T07:00:00.000Z');
    });
    const db = openDb(file);
    try {
      const recBefore = messagesOf(db, 'deferral');
      migrate(db);
      const convs = db.prepare('SELECT * FROM conversations ORDER BY key').all().map(r => ({ ...r }));
      assert.ok(!convs.some(c => c.key === 'ask'), 'the ask row is gone');
      assert.equal(db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_key = 'ask'").get().n, 0);
      // 016 also moves the summary-only rec conversation into an archived, detached thread.
      const threads = convs.filter(c => THREAD_KEY.test(c.key) && c.rec_id == null);
      assert.equal(threads.length, 1, JSON.stringify(convs.map(c => c.key)));
      const th = threads[0];
      assert.deepEqual(messagesOf(db, th.key), OLD_ASK, 'same messages, same order, text and ts');
      assert.equal(th.created_at, OLD_ASK_CREATED);
      assert.equal(th.last_at, '2026-10-03T10:00:00.000Z', 'last_at is the newest message ts');
      assert.equal(th.title, null);
      assert.equal(th.title_source, null);
      assert.equal(th.archived_at, null);
      assert.equal(th.trashed_at, null);

      assert.ok(!convs.some(c => c.key === 'deferral'), 'no rec-keyed conversation remains after 016');
      const rec = convs.find(c => c.rec_id === 'deferral');
      assert.match(rec.key, THREAD_KEY);
      assert.equal(rec.created_at, REC_CREATED, 'the rec thread keeps the rec conversation created_at');
      assert.deepEqual(messagesOf(db, rec.key), recBefore, 'its opening summary message moved unchanged');
      assert.equal(rec.last_at, REC_MSG.ts, 'other conversations get last_at from their newest message');
      assert.equal(typeof rec.archived_at, 'string', 'a summary-only rec conversation becomes archived');
      assert.equal(typeof rec.rec_detached_at, 'string', 'and detached');
      assert.equal(rec.title, 'Opening summary');
      assert.equal(rec.title_source, 'auto');
      const pack = convs.find(c => c.key === 'pack:giving');
      assert.equal(pack.last_at, '2026-10-01T07:00:00.000Z', 'or from created_at when empty');
      assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n, OLD_ASK.length + 1, 'no message is lost or added');
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AC6 an empty ask conversation migrates to no thread, and a store without one migrates cleanly', async () => {
  const dir = await tempDir('fathom-threads-');
  try {
    for (const [name, init] of [
      ['empty', db => { addConversation(db, 'ask', OLD_ASK_CREATED); addConversation(db, 'deferral', REC_CREATED, [REC_MSG]); }],
      ['none', db => { addConversation(db, 'deferral', REC_CREATED, [REC_MSG]); }],
    ]) {
      const file = join(dir, `${name}.sqlite`);
      storeAt007(file, init);
      const db = openDb(file);
      try {
        migrate(db);
        const rows = db.prepare('SELECT key, rec_id, archived_at, rec_detached_at FROM conversations ORDER BY key').all().map(r => ({ ...r }));
        assert.equal(rows.length, 1, `${name}: only the rec conversation remains, as a thread (016): ${JSON.stringify(rows)}`);
        assert.match(rows[0].key, THREAD_KEY);
        assert.equal(rows[0].rec_id, 'deferral', `${name}: the thread names its rec`);
        assert.equal(typeof rows[0].archived_at, 'string', `${name}: summary only, so archived`);
        assert.equal(typeof rows[0].rec_detached_at, 'string', `${name}: and detached`);
        assert.deepEqual(messagesOf(db, rows[0].key), [REC_MSG], `${name}: rec messages kept`);
        assert.deepEqual(migrate(db).applied, [], `${name}: a second migrate is a no-op`);
      } finally {
        db.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('AC6 pack conversations never appear as threads; a rec question is a thread carrying its rec', T, () => withServer({ env: FAKE }, async s => {
  await ok(s.postJson('/api/packs/giving/whatif', {}));
  const follow = await ok(s.postJson('/api/ask', { key: 'pack:giving', text: 'What would that change for us' }));
  assert.ok(follow.scenario.live.conversations['pack:giving'].length >= 4, 'the pack conversation has the follow up');
  const sc = await s.getScenario();
  assert.deepEqual(sc.live.threads, [], 'no threads from pack conversations');
  assert.deepEqual(allIds(await listThreads(s)), []);

  const recAsk = await newThread(s, { recId: 'deferral', questionId: 0 });
  assert.match(recAsk.thread.key, THREAD_KEY);
  assert.equal(recAsk.thread.recId, 'deferral');
  assert.equal(recAsk.thread.recDetachedAt, null);
  assert.ok(!('deferral' in recAsk.scenario.live.conversations), 'no rec-keyed conversation');
  const { thread } = await newThread(s, { text: 'Synthetic thread question' });
  assert.equal(thread.recId, null);
  const after = await s.getScenario();
  assert.deepEqual(new Set(after.live.threads.map(x => x.key)), new Set([recAsk.thread.key, thread.key]));
  assert.ok(after.live.threads.every(x => THREAD_KEY.test(x.key)));
  assert.equal(after.live.threads.find(x => x.key === recAsk.thread.key).recId, 'deferral');
  assert.deepEqual(new Set(allIds(await listThreads(s))), new Set([recAsk.thread.id, thread.id]));
}));

test('AC6 the migrated thread is first in the active list of a restarted 007 store', T2, async () => {
  const dataDir = await tempDir('fathom-threads-');
  storeAt007(join(dataDir, DB_FILE), db => {
    setSetting(db, 'mode', 'real');
    addConversation(db, 'ask', OLD_ASK_CREATED, OLD_ASK);
  });
  // Since MT-01 a real store reaches the new release through the offline platform migration.
  await migrateLegacyStore(dataDir);
  await withAuthenticatedServer({ dataDir, env: REAL }, async s => {
    const lists = await listThreads(s);
    assert.equal(lists.active.length, 1);
    const th = lists.active[0];
    assert.match(th.key, THREAD_KEY);
    assert.equal(th.turns, 2, 'two owner messages');
    assert.equal(th.title, null);
    assert.equal(th.lastAt, '2026-10-03T10:00:00.000Z');
    const opened = await openThread(s, th.id);
    assert.deepEqual(opened.messages.map(m => m.role), ['me', 'fathom', 'me']);
    assert.ok(opened.messages[1].text.includes('Synthetic answer before threads'));

    const fresh = (await newThread(s, {})).thread;
    const again = await listThreads(s);
    assert.deepEqual(idsOf(again.active), [fresh.id, th.id], 'newest lastAt first');
  });
});

// ---------------------------------------------------------------- AC5: reopen and continue

test('AC5 a thread reopens with every turn in order and continues on the same key', T, () => withServer({ env: FAKE }, async s => {
  const first = await newThread(s, { text: 'Synthetic first question' });
  assert.match(first.thread.key, THREAD_KEY);
  assert.equal(first.thread.turns, 1);
  assert.equal(first.message.role, 'fathom');
  assert.equal(first.message.notice, false);
  const other = await newThread(s, { text: 'Synthetic other thread question' });
  const next = await ask(s, first.thread.key, 'Synthetic follow up');
  assert.equal(next.message.role, 'fathom');

  const opened = await openThread(s, first.thread.id);
  assert.equal(opened.thread.turns, 2);
  assert.deepEqual(opened.messages.map(m => m.role), ['me', 'fathom', 'me', 'fathom']);
  assert.ok(opened.messages[0].text.includes('Synthetic first question'));
  assert.deepEqual(opened.messages[1], first.message);
  assert.ok(opened.messages[2].text.includes('Synthetic follow up'));
  assert.deepEqual(opened.messages[3], next.message);
  assert.ok(!JSON.stringify(opened.messages).includes('Synthetic other thread question'));
  assert.deepEqual(next.scenario.live.conversations[first.thread.key], opened.messages);
  assert.equal((await openThread(s, other.thread.id)).messages.length, 2, 'the other thread is untouched');
}));

test('AC5 the answer request carries this thread history and nothing from another thread', async t => {
  const s = await tempDb();
  t.after(async () => { s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  seedDemo(s.db);
  const runtime = createRuntimeEngine({ db: s.db, config: loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'fake' }) });
  const packs = createLivePacks(s.db, { dataDir: s.dataDir });
  packs.refresh();
  const requests = [];
  const engine = new Proxy(runtime, {
    get(target, key) {
      if (key === 'call') return async req => { requests.push(req); return target.call(req); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const a = createThread(s.db, '2026-11-05T09:00:00.000Z');
  const b = createThread(s.db, '2026-11-05T09:05:00.000Z');
  assert.match(a.key, THREAD_KEY);
  assert.notEqual(a.key, b.key);
  const msg = s.db.prepare("INSERT INTO messages (conversation_key, role, text, refs, notice, ts) VALUES (?, ?, ?, '[]', 0, ?)");
  msg.run(a.key, 'me', 'Synthetic first question', '2026-11-05T09:00:01.000Z');
  msg.run(a.key, 'fathom', '<p>Synthetic first answer</p>', '2026-11-05T09:00:02.000Z');
  msg.run(b.key, 'me', 'Synthetic other thread question', '2026-11-05T09:05:01.000Z');
  msg.run(b.key, 'fathom', '<p>Synthetic other thread answer</p>', '2026-11-05T09:05:02.000Z');

  const reply = await createLiveAnswerer({ engine, packs }).answer({ db: s.db, key: a.key, text: 'Synthetic follow up' });
  assert.ok(!reply.notice, JSON.stringify(reply.paragraphs));
  assert.ok(requests.length >= 1);
  const req = requests[0];
  const content = m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
  assert.deepEqual(req.messages.map(m => m.role), ['user', 'assistant', 'user']);
  assert.ok(content(req.messages[0]).includes('Synthetic first question'));
  assert.ok(content(req.messages[1]).includes('Synthetic first answer'));
  assert.equal(content(req.messages[2]), 'Synthetic follow up');
  for (const r of requests) {
    const sent = JSON.stringify({ system: r.system, systemDynamic: r.systemDynamic, messages: r.messages });
    assert.ok(!sent.includes('Synthetic other thread'), 'nothing from the other thread reaches the model');
  }
  assert.ok(!toolNamesOf(req).includes('set_recommendation_status'), 'a direct answerer call without trusted identity is read-only');
});

test('AC5 asking in an archived thread unarchives it; asking in a trashed thread is 409', T, () => withServer({ env: FAKE }, async s => {
  const { thread } = await newThread(s, { text: 'Synthetic archived question' });
  await ok(threadAct(s, thread.id, 'archive'));
  assert.deepEqual(idsOf((await listThreads(s)).archived), [thread.id]);
  const r = await ask(s, thread.key, 'Synthetic question after archiving');
  assert.equal(r.message.role, 'fathom');
  const lists = await listThreads(s);
  assert.deepEqual(idsOf(lists.active), [thread.id], 'back in the active list');
  assert.deepEqual(lists.archived, []);
  assert.equal(lists.active[0].archivedAt, null);

  await ok(threadAct(s, thread.id, 'trash'));
  const before = (await openThread(s, thread.id)).messages.length;
  await fails(s.postJson('/api/ask', { key: thread.key, text: 'Synthetic question in trash' }), 409);
  assert.equal((await openThread(s, thread.id)).messages.length, before, 'nothing stored');
}));

// ---------------------------------------------------------------- AC4: archive and trash lifecycle

test('AC4 archive moves a thread to archived and restore brings it back to active', T, () => withServer({ env: FAKE }, async s => {
  const a = (await newThread(s, {})).thread;
  const b = (await newThread(s, {})).thread;
  await ok(threadAct(s, a.id, 'archive'));
  let lists = await listThreads(s);
  assert.deepEqual(idsOf(lists.active), [b.id]);
  assert.deepEqual(idsOf(lists.archived), [a.id]);
  assert.deepEqual(lists.trash, []);
  await ok(threadAct(s, a.id, 'restore'));
  lists = await listThreads(s);
  assert.deepEqual(new Set(idsOf(lists.active)), new Set([a.id, b.id]));
  assert.deepEqual(lists.archived, []);
}));

test('AC4 trash, restore to where it was, delete forever, and the 409 guards', T, () => withServer({ env: FAKE }, async s => {
  const active = (await newThread(s, { text: 'Synthetic active question' })).thread;
  const arch = (await newThread(s, { text: 'Synthetic archived question' })).thread;
  await ok(threadAct(s, arch.id, 'archive'));

  await ok(threadAct(s, active.id, 'trash'));
  const fromArchived = await ok(threadAct(s, arch.id, 'trash'));
  assert.equal(typeof fromArchived.thread.archivedAt, 'string', 'trash keeps archived_at');
  let lists = await listThreads(s);
  assert.deepEqual(lists.active, []);
  assert.deepEqual(lists.archived, [], 'a trashed thread is only in trash');
  assert.deepEqual(new Set(idsOf(lists.trash)), new Set([active.id, arch.id]));

  await fails(threadAct(s, arch.id, 'archive'), 409);

  await ok(threadAct(s, active.id, 'restore'));
  await ok(threadAct(s, arch.id, 'restore'));
  lists = await listThreads(s);
  assert.deepEqual(idsOf(lists.active), [active.id], 'a thread trashed from active returns to active');
  assert.deepEqual(idsOf(lists.archived), [arch.id], 'a thread trashed from archived returns to archived');
  assert.deepEqual(lists.trash, []);

  await fails(threadAct(s, active.id, 'delete'), 409);
  await fails(threadAct(s, arch.id, 'delete'), 409);

  await ok(threadAct(s, active.id, 'trash'));
  await ok(threadAct(s, active.id, 'delete'));
  await readDb(s.dbFile, db => {
    assert.equal(db.prepare('SELECT count(*) AS n FROM conversations WHERE key = ?').get(active.key).n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE conversation_key = ?').get(active.key).n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE conversation_key = ?').get(arch.key).n, 2, 'other threads keep their messages');
  });
  await fails(s.request({ path: `/api/threads/${active.id}` }), 404);
  assert.deepEqual(allIds(await listThreads(s)), [arch.id]);
}));

// The scheduler's startup tick runs every due job once, trash-purge included; waits until that
// job's latest run has finished so a test's store edits cannot race it. Returns that run.
async function settledRun(s, jobId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = (await ok(s.request({ path: '/api/jobs' }))).jobs.find(j => j.id === jobId);
    assert.ok(job, `GET /api/jobs lists ${jobId}`);
    if (job.lastRun && job.lastRun.status !== 'running' && job.lastRun.finishedAt) return job.lastRun;
    assert.ok(Date.now() < deadline, `${jobId} has no finished run after ${timeoutMs} ms`);
    await pause(100);
  }
}

const countWhere = (db, table, col, key) => db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${col} = ?`).get(key).n;

test('AC4 reads and restarts purge nothing; the trash-purge job deletes 30 day trash and keeps 29 days', T2, async () => {
  const dataDir = await tempDir('fathom-trash-purge-');
  try {
    const first = await spawnServer({ dataDir, env: FAKE });
    let a;
    let b;
    let keep;
    try {
      await settledRun(first, 'trash-purge');
      const clock = (await first.getScenario()).meta.clock;
      assert.match(clock, /^\d{4}-\d{2}-\d{2}$/);
      // The job's now is the clock date at the current time of day. Stamps computed from it here
      // are a moment older when the job runs: 30 days is purged, 29 days is kept.
      const now = Date.parse(`${clock}T${new Date().toISOString().slice(11)}`);
      a = (await newThread(first, { text: 'Synthetic old trash question' })).thread;
      b = (await newThread(first, { text: 'Synthetic recent trash question' })).thread;
      keep = (await newThread(first, {})).thread;
      await ok(threadAct(first, a.id, 'trash'));
      await ok(threadAct(first, b.id, 'trash'));
      await readDb(first.dbFile, db => {
        const set = db.prepare('UPDATE conversations SET trashed_at = ? WHERE key = ?');
        set.run(new Date(now - 30 * DAY).toISOString(), a.key);
        set.run(new Date(now - 29 * DAY).toISOString(), b.key);
      });

      // No lazy purge on the thread list, an open thread or the scenario.
      const lists = await listThreads(first);
      assert.deepEqual(idsOf(lists.trash).sort(), [a.id, b.id].sort(), 'both trashed threads are still listed');
      assert.deepEqual(idsOf(lists.active), [keep.id]);
      assert.equal((await openThread(first, a.id)).thread.id, a.id, 'the 30 day thread still opens');
      assert.ok((await first.getScenario()).live.threads.some(x => x.id === a.id), 'the scenario still carries it');
      await readDb(first.dbFile, db => {
        assert.equal(countWhere(db, 'conversations', 'key', a.key), 1);
        assert.equal(countWhere(db, 'messages', 'conversation_key', a.key), 2);
      });
    } finally {
      await first.stop();
    }

    // No purge at startup: the restarted server leaves both in Trash. Its scheduler's startup tick
    // finds today's trash-purge period already run, so only a lazy purge could delete them.
    const second = await spawnServer({ dataDir, env: FAKE });
    try {
      await settledRun(second, 'trash-purge');
      await readDb(second.dbFile, db => {
        assert.equal(countWhere(db, 'conversations', 'key', a.key), 1, 'startup kept the 30 day thread');
        assert.equal(countWhere(db, 'messages', 'conversation_key', a.key), 2, 'startup kept its messages');
      });
      assert.deepEqual(idsOf((await listThreads(second)).trash).sort(), [a.id, b.id].sort());

      // The job, run now over HTTP, purges the 30 day thread and its messages only.
      const r = await ok(second.postJson('/api/jobs/trash-purge/run', {}));
      assert.ok(r.run, 'the response carries the run');
      assert.equal(r.run.jobId, 'trash-purge');
      assert.equal(r.run.status, 'ok');
      assert.equal(r.run.trigger, 'manual');
      assert.equal(r.run.costUsd, 0);
      assert.deepEqual(r.run.note, { purged: 1 });
      const listed = r.jobs.find(j => j.id === 'trash-purge');
      assert.ok(listed, 'the response lists the trash-purge job');
      assert.equal(listed.lastRun.id, r.run.id);
      assert.deepEqual((await settledRun(second, 'trash-purge')).note, { purged: 1 }, 'GET /api/jobs reports the purge count');

      await readDb(second.dbFile, db => {
        assert.equal(countWhere(db, 'conversations', 'key', a.key), 0, 'the 30 day thread is gone');
        assert.equal(countWhere(db, 'messages', 'conversation_key', a.key), 0, 'its messages are gone');
        assert.equal(countWhere(db, 'conversations', 'key', b.key), 1, 'the 29 day thread remains');
        assert.equal(countWhere(db, 'messages', 'conversation_key', b.key), 2, 'with its messages');
        assert.equal(countWhere(db, 'conversations', 'key', keep.key), 1);
      });
      const lists = await listThreads(second);
      assert.deepEqual(idsOf(lists.trash), [b.id]);
      assert.deepEqual(idsOf(lists.active), [keep.id]);
      await fails(second.request({ path: `/api/threads/${a.id}` }), 404);
    } finally {
      await second.stop();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('AC4 the default trash-purge handler purges at the clock date and the run time of day', async () => {
  const t = await tempDb();
  try {
    const db = t.db;
    const exact = createThread(db, '2026-09-01T09:00:00.000Z');
    const under = createThread(db, '2026-09-01T09:00:00.000Z');
    const active = createThread(db, '2026-09-01T09:00:00.000Z');
    const set = db.prepare('UPDATE conversations SET trashed_at = ? WHERE key = ?');
    // The purge time is 2026-11-05T12:00:00.000Z: the clock date at ctx.now's time of day.
    set.run('2026-10-06T12:00:00.000Z', exact.key);
    set.run('2026-10-06T12:00:00.001Z', under.key);
    const msg = db.prepare("INSERT INTO messages (conversation_key, role, text, refs, notice, ts) VALUES (?, 'me', 'Synthetic purge text', '[]', 0, '2026-09-01T09:00:00.000Z')");
    for (const th of [exact, under, active]) msg.run(th.key);

    const handler = defaultHandlers()['trash-purge'];
    assert.equal(typeof handler, 'function');
    // Built the way the scheduler builds it; ctx.now is a real instant on another date.
    const ctx = {
      db, config: { dataDir: t.dataDir, clock: '2026-11-05', demo: false, engine: 'off', emailTransport: 'dev', publicUrl: null },
      engine: null, transport: null, now: '2027-03-01T12:00:00.000Z', clock: '2027-03-01', periodKey: '2026-11-05', trigger: 'scheduled', jobRunId: 1,
    };
    assert.deepEqual(await handler(ctx), { costUsd: 0, note: { purged: 1 } });
    const keys = db.prepare("SELECT key FROM conversations WHERE substr(key, 1, 4) = 'ask:'").all().map(r => r.key).sort();
    assert.deepEqual(keys, [under.key, active.key].sort());
    assert.equal(countWhere(db, 'messages', 'conversation_key', exact.key), 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n, 2);
    assert.deepEqual(await handler(ctx), { costUsd: 0, note: { purged: 0 } }, 'a second run finds nothing');
  } finally {
    t.close();
  }
});

test('AC4 the trash purge never runs ahead of the trash clock in a far east timezone', async () => {
  const t = await tempDb();
  try {
    const db = t.db;
    setSetting(db, 'timezone', 'Asia/Tokyo');
    const kept = createThread(db, '2026-09-01T09:00:00.000Z');
    const gone = createThread(db, '2026-09-01T09:00:00.000Z');
    const set = db.prepare('UPDATE conversations SET trashed_at = ? WHERE key = ?');
    set.run('2026-10-07T12:00:00.000Z', kept.key);
    set.run('2026-10-06T17:59:59.000Z', gone.key);
    const handler = defaultHandlers()['trash-purge'];
    // Built the way the scheduler builds it in Tokyo: the local date is already the next day.
    const ctx = {
      db, config: {}, engine: null, transport: null,
      now: '2026-11-05T18:00:00.000Z', clock: '2026-11-06', periodKey: '2026-11-06', trigger: 'scheduled', jobRunId: 1,
    };
    assert.deepEqual(await handler(ctx), { costUsd: 0, note: { purged: 1 } });
    const keys = db.prepare("SELECT key FROM conversations WHERE substr(key, 1, 4) = 'ask:'").all().map(r => r.key);
    assert.ok(keys.includes(kept.key), 'trashed 29 days 6 hours ago is kept');
    assert.ok(!keys.includes(gone.key), 'trashed 30 days ago is purged');
  } finally {
    t.close();
  }
});

test('AC4 purgeTrash deletes threads trashed 30 or more days ago and their messages only', async () => {
  const t = await tempDb();
  try {
    const db = t.db;
    const now = '2026-11-05T12:00:00.000Z';
    const mk = () => createThread(db, '2026-09-01T09:00:00.000Z');
    const old = mk();
    const exact = mk();
    const recent = mk();
    const archived = mk();
    const active = mk();
    const set = (col, val, key) => db.prepare(`UPDATE conversations SET ${col} = ? WHERE key = ?`).run(val, key);
    set('trashed_at', '2026-10-05T12:00:00.000Z', old.key);
    set('trashed_at', '2026-10-06T12:00:00.000Z', exact.key);
    set('trashed_at', '2026-10-07T12:00:00.000Z', recent.key);
    set('archived_at', '2026-08-01T12:00:00.000Z', archived.key);
    const msg = db.prepare("INSERT INTO messages (conversation_key, role, text, refs, notice, ts) VALUES (?, 'me', 'Synthetic purge text', '[]', 0, '2026-09-01T09:00:00.000Z')");
    for (const th of [old, exact, recent, archived, active]) msg.run(th.key);
    db.prepare('INSERT INTO conversations (key, created_at) VALUES (?, ?)').run('deferral', '2026-01-01T00:00:00.000Z');

    assert.equal(purgeTrash(db, now), 2);
    const keys = db.prepare('SELECT key FROM conversations').all().map(r => r.key).sort();
    assert.deepEqual(keys, [recent.key, archived.key, active.key, 'deferral'].sort());
    for (const th of [old, exact]) {
      assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE conversation_key = ?').get(th.key).n, 0);
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n, 3);
    assert.equal(purgeTrash(db, now), 0, 'a second purge finds nothing');
  } finally {
    t.close();
  }
});

// ---------------------------------------------------------------- AC3: naming over HTTP

const QUARTERLY = 'How should we think about the quarterly estimates';
const QUARTERLY_FALLBACK = 'How should we think about the quarterly';

test('AC3 the fake engine names a thread once after the first turn', T, () => withServer({ env: FAKE }, async s => {
  const first = await newThread(s, { text: QUARTERLY });
  assert.equal(first.thread.title, QUARTERLY_FALLBACK, 'the response of the first answer already carries the title');
  assert.equal(first.thread.titleSource, 'auto');
  assert.equal(await titleSpend(s.dbFile), 1);

  await ask(s, first.thread.key, 'Synthetic second question');
  const named = (await openThread(s, first.thread.id)).thread;
  assert.equal(named.title, QUARTERLY_FALLBACK, 'the fake title is the fallback of the first question');
  assert.equal(named.titleSource, 'auto');
  assert.equal(await titleSpend(s.dbFile), 1, 'the title call is recorded with purpose title');
  const sc = await s.getScenario();
  assert.equal(sc.live.threads.find(x => x.id === first.thread.id).title, QUARTERLY_FALLBACK);

  await ask(s, first.thread.key, 'Synthetic third question');
  assert.equal(await titleSpend(s.dbFile), 1, 'named once');
  assert.equal((await openThread(s, first.thread.id)).thread.title, QUARTERLY_FALLBACK);
}));

test('AC3 with the engine off the first turn names the thread with the fallback and spends nothing', T, () => withServer({ env: FAKE }, async s => {
  await ok(s.postJson('/api/engine', { on: false }));
  const first = await newThread(s, { text: QUARTERLY });
  assert.equal(first.message.notice, true);
  assert.equal(first.thread.title, QUARTERLY_FALLBACK, 'a notice reply completes the turn');
  await ask(s, first.thread.key, 'Synthetic second question');
  const named = (await openThread(s, first.thread.id)).thread;
  assert.equal(named.title, QUARTERLY_FALLBACK);
  assert.equal(named.titleSource, 'auto');
  assert.equal(await titleSpend(s.dbFile), 0);
}));

test('AC3 a manual rename wins over automatic naming', T, () => withServer({ env: FAKE }, async s => {
  // Renamed before any turn, so the first completed turn finds the title source already set.
  const first = await newThread(s, {});
  const renamed = await ok(threadAct(s, first.thread.id, 'rename', { title: '  Synthetic manual name  ' }));
  assert.equal(renamed.thread.title, 'Synthetic manual name');
  assert.equal(renamed.thread.titleSource, 'manual');
  await ask(s, first.thread.key, QUARTERLY);
  await ask(s, first.thread.key, 'Synthetic second question');
  await ask(s, first.thread.key, 'Synthetic third question');
  const th = (await openThread(s, first.thread.id)).thread;
  assert.equal(th.title, 'Synthetic manual name');
  assert.equal(th.titleSource, 'manual');
  assert.equal(th.turns, 3);
  assert.equal(await titleSpend(s.dbFile), 0, 'a manually named thread is never sent for a title');
}));

test('AC3 rename validates the title', T, () => withServer({ env: FAKE }, async s => {
  const { thread } = await newThread(s, {});
  for (const title of ['', '   ', 'x'.repeat(61), 'Synthetic\nname', '<b>x</b>', 'Synthetic {f:x}', 'Synthetic `name`', 'Synthetic\u0007name']) {
    await fails(threadAct(s, thread.id, 'rename', { title }), 400);
  }
  await fails(threadAct(s, thread.id, 'rename', {}), 400);
  await fails(threadAct(s, thread.id, 'rename', { title: 42 }), 400);
  assert.equal((await openThread(s, thread.id)).thread.title, null, 'nothing was written');
  const max = 'y'.repeat(60);
  assert.equal((await ok(threadAct(s, thread.id, 'rename', { title: max }))).thread.title, max);
  const digits = 'Plan for 2027 and the 401k';
  assert.equal((await ok(threadAct(s, thread.id, 'rename', { title: digits }))).thread.title, digits, 'owner renames may carry digits');
}));
