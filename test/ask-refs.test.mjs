// Ask everywhere, the server side of references: parseRefs validates the wire list (kind and id
// only), resolveRefs keeps what the store knows and gives each kept ref a tool hint, the answerer
// puts the references in the conversation context and provenance, the hinted tools reach the
// referenced rows (transactions.search ids), reference ids and hints never ground a number, and the
// three ask entry points refuse a malformed context with 400 (JSON and streaming).
//
// The answerer runs over the production runtime engine in fake mode with scripted responses on a
// temp demo store, as in test/answerer.test.mjs; tools execute for real.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { seedDemo } from '../demo/seed.mjs';
import { loadConfig } from '../src/config.mjs';
import { buildScenario, clockNow } from '../src/scenario/build.mjs';
import { callTool } from '../src/tools/index.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { createLivePacks } from '../src/packs/live.mjs';
import { PRODUCT_RULES, createLiveAnswerer } from '../src/api/answerer.mjs';
import { HttpError } from '../src/api/http.mjs';
import { REF_KINDS, MAX_REFS, parseRefs, resolveRefs } from '../src/api/context-refs.mjs';
import { SERVER_TIMEOUT, withServer, postJson, openStore, tempDb } from './helpers/server.mjs';

const KINDS = ['account', 'transaction', 'rec', 'step', 'goal', 'figure', 'pnl', 'spending', 'confirm', 'money', 'pack', 'page'];
const THREAD = 'ask:0123456789ab';
const T = { timeout: SERVER_TIMEOUT };
const FAKE = { FATHOM_ENGINE: 'fake', FATHOM_FAKE_STREAM_MS: '0' };
const asAmount = n => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const byKey = list => [...list].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));

async function demoStore(t, env = {}) {
  const s = await tempDb();
  t.after(async () => { s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  seedDemo(s.db);
  const config = loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'fake', ...env });
  const runtime = createRuntimeEngine({ db: s.db, config });
  const packs = createLivePacks(s.db, { dataDir: s.dataDir });
  packs.refresh();
  return { ...s, config, runtime, packs };
}

// The runtime with call() intercepted: records each request and, while scripts remain, sends the
// next one as request.fake. `responses` holds each completed call's engine result.
function scripted(runtime, scripts = []) {
  const queue = [...scripts];
  const requests = [];
  const responses = [];
  const engine = new Proxy(runtime, {
    get(target, key) {
      if (key === 'call') {
        return async request => {
          requests.push(request);
          const next = queue.shift();
          const response = await target.call(next ? { ...request, fake: next } : request);
          responses.push(response);
          return response;
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { engine, requests, responses };
}

const always = (runtime, text) => scripted(runtime, Array.from({ length: 8 }, () => [{ text }]));

// The conversation context block of a request's systemDynamic, parsed.
function contextOf(systemDynamic) {
  const m = /<conversation_context>\n([\s\S]*?)\n<\/conversation_context>/.exec(systemDynamic || '');
  assert.ok(m, `systemDynamic has a conversation context: ${String(systemDynamic).slice(0, 400)}`);
  return JSON.parse(m[1]);
}

// A visible rec whose id carries digits nothing else in the store states.
function insertDigitRec(db, recId) {
  const base = db.prepare("SELECT * FROM recs WHERE id = 'deferral'").get();
  const def = { ...JSON.parse(base.def), id: recId, title: 'Synthetic invoicing review',
    value: [{ cls: 'cash', text: 'About $2,750 of synthetic cash arrives early' }] };
  db.prepare(`INSERT INTO recs (id, def, status, waiting_on, wake, tasks_done, window_close, window_label, pack_id, sort, updated_at, file_id, parser, locator)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(recId, JSON.stringify(def), base.status, base.waiting_on, base.wake, base.tasks_done, base.window_close, base.window_label,
      base.pack_id, 999, base.updated_at, base.file_id, base.parser, base.locator);
}

// Transactions outside the newest 200 (the most transactions.search returns without ids), oldest first.
async function oldTransactions(db, now) {
  const newest = await callTool('transactions', { operation: 'search',  limit: 200 }, { db, now });
  const shown = new Set(newest.rows.map(r => String(r.id)));
  return db.prepare('SELECT id, account_id, date, amount FROM transactions ORDER BY date ASC, id ASC').all()
    .filter(r => !shown.has(String(r.id))).map(r => ({ ...r }));
}

/* ---------- parseRefs ---------- */

const throws400 = (fn, what) => assert.throws(fn, e => e instanceof HttpError && e.status === 400, what);

test('REF_KINDS mirrors the client kinds and MAX_REFS is 8', () => {
  assert.deepEqual([...REF_KINDS], KINDS);
  assert.equal(MAX_REFS, 8);
});

test('parseRefs: absent is an empty list and a valid list comes back as kind and id pairs', () => {
  assert.deepEqual(parseRefs(undefined), []);
  assert.deepEqual(parseRefs(null), []);
  assert.deepEqual(parseRefs([]), []);
  const valid = KINDS.slice(0, 8).map(kind => ({ kind, id: `${kind}_1` }));
  assert.deepEqual(parseRefs(valid), valid);
  assert.deepEqual(parseRefs(KINDS.slice(8).map(kind => ({ kind, id: 'x' }))), KINDS.slice(8).map(kind => ({ kind, id: 'x' })));
});

test('parseRefs refuses a non-array; a list of the same ref passes', () => {
  for (const bad of [{ kind: 'account', id: 'a_biz' }, 'account:a_biz', 5, true]) throws400(() => parseRefs(bad), JSON.stringify(bad));
  assert.deepEqual(parseRefs([{ kind: 'account', id: 'a_biz' }]), [{ kind: 'account', id: 'a_biz' }]);
});

test('parseRefs refuses a non-object entry; the object form passes', () => {
  for (const bad of [[null], ['account:a_biz'], [5], [['account', 'a_biz']]]) throws400(() => parseRefs(bad), JSON.stringify(bad));
  assert.deepEqual(parseRefs([{ kind: 'rec', id: 'deferral' }]), [{ kind: 'rec', id: 'deferral' }]);
});

test('parseRefs refuses an unknown kind; a known kind with the same id passes', () => {
  for (const kind of ['bogus', '', 'Account', undefined, 3]) throws400(() => parseRefs([{ kind, id: 'a_biz' }]), String(kind));
  assert.deepEqual(parseRefs([{ kind: 'account', id: 'a_biz' }]), [{ kind: 'account', id: 'a_biz' }]);
});

test('parseRefs refuses an empty, non-string or over-200-char id; a 200-char id passes', () => {
  for (const id of ['', 5, null, undefined, {}, 'x'.repeat(201)]) throws400(() => parseRefs([{ kind: 'figure', id }]), JSON.stringify(id));
  const edge = 'x'.repeat(200);
  assert.deepEqual(parseRefs([{ kind: 'figure', id: edge }]), [{ kind: 'figure', id: edge }]);
});

test('parseRefs refuses more than 8 entries; exactly 8 pass', () => {
  const nine = Array.from({ length: 9 }, (_, i) => ({ kind: 'transaction', id: String(i + 1) }));
  throws400(() => parseRefs(nine), 'nine refs');
  assert.deepEqual(parseRefs(nine.slice(0, 8)), nine.slice(0, 8));
});

/* ---------- transactions.search ids ---------- */

test('transactions.search with ids returns an old transaction that is not among the newest 200', async t => {
  const s = await demoStore(t);
  const now = clockNow(s.db);
  const old = await oldTransactions(s.db, now);
  assert.ok(old.length > 0, 'the demo store has more than 200 transactions');
  const pick = old[0];
  const r = await callTool('transactions', { operation: 'search',  ids: [String(pick.id)] }, { db: s.db, now });
  const row = r.rows.find(x => String(x.id) === String(pick.id));
  assert.ok(row, `the old row comes back by id: ${JSON.stringify(r).slice(0, 300)}`);
  assert.equal(row.amount, pick.amount);
  assert.equal(row.date, pick.date);
  // Several ids at once, with a limit that would otherwise cut them off.
  const ids = old.slice(0, 3).map(x => String(x.id));
  const many = await callTool('transactions', { operation: 'search',  ids, limit: 1 }, { db: s.db, now });
  for (const id of ids) assert.ok(many.rows.some(x => String(x.id) === id), `row ${id} returned despite limit 1`);
});

/* ---------- resolveRefs on the seeded demo store ---------- */

test('resolveRefs keeps what the store knows, with a tool hint for each, and drops unknown ids of each kind', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  const txn = s.db.prepare('SELECT id FROM transactions ORDER BY id LIMIT 1').get();
  const txnId = String(txn.id);
  const goalId = scenario.goals[0].id;
  assert.ok(scenario.fig.true_reserve, 'stored figure present');
  assert.ok(scenario.fig['trend.total'], 'trend figure present');
  assert.ok(scenario.fig['pace.rollup.total'], 'pace figure present');
  assert.ok(scenario.recs.some(r => r.id === 'daf' && r.status === 'hidden'), 'daf is the hidden demo rec');
  const pending = s.db.prepare("SELECT id, kind FROM confirm_items WHERE status = 'pending' ORDER BY id LIMIT 1").get();

  const known = [
    { kind: 'account', id: 'a_biz' },
    { kind: 'rec', id: 'deferral' },
    { kind: 'goal', id: goalId },
    { kind: 'figure', id: 'true_reserve' },
    { kind: 'figure', id: 'trend.total' },
    { kind: 'figure', id: 'pace.rollup.total' },
    { kind: 'transaction', id: txnId },
    { kind: 'step', id: 'offcycle:0' },
  ];
  const unknown = [
    { kind: 'account', id: 'a_no_such' },
    { kind: 'rec', id: 'no_such_rec' },
    { kind: 'rec', id: 'daf' },
    { kind: 'goal', id: 'no_such_goal' },
    { kind: 'figure', id: 'no_such_figure' },
    { kind: 'transaction', id: '987654321' },
    { kind: 'figure', id: 'txn.987654321' },
    { kind: 'step', id: 'no_such_rec:0' },
    { kind: 'confirm', id: '987654321' },
  ];
  const out = await resolveRefs(s.db, scenario, [...known, ...unknown]);
  assert.ok(Array.isArray(out));
  for (const ref of out) {
    assert.deepEqual(Object.keys(ref).sort(), ['id', 'kind', 'use'], JSON.stringify(ref));
    assert.equal(typeof ref.use, 'string');
    assert.ok(ref.use.trim().length > 0, `${ref.kind}:${ref.id} has a hint`);
  }
  assert.deepEqual(byKey(out.map(({ kind, id }) => ({ kind, id }))), byKey(known));
  const hint = (kind, id) => out.find(r => r.kind === kind && r.id === id).use;
  assert.match(hint('transaction', txnId), /transactions.search/);
  assert.ok(hint('transaction', txnId).includes(txnId), 'the transaction hint names its id');
  assert.match(hint('account', 'a_biz'), /transactions.search|accounts.list/);
  assert.match(hint('rec', 'deferral'), /recommendations.detail/);
  assert.match(hint('goal', goalId), /goals.list|goals.pace/);
  for (const key of ['true_reserve', 'trend.total', 'pace.rollup.total']) {
    assert.match(hint('figure', key), /household.figures/);
    assert.ok(hint('figure', key).includes(`{f:${key}}`), `the ${key} hint names its token`);
  }

  if (pending) {
    const single = await resolveRefs(s.db, scenario, [{ kind: 'confirm', id: String(pending.id) }]);
    assert.equal(single.length, 1, 'a pending Confirm card resolves');
    assert.ok(single[0].use.trim(), 'with its question as the hint');
    const group = await resolveRefs(s.db, scenario, [{ kind: 'confirm', id: `group:${pending.kind}` }]);
    assert.equal(group.length, 1, 'a Confirm group resolves');
    assert.deepEqual(await resolveRefs(s.db, scenario, [{ kind: 'confirm', id: 'group:no_such_kind' }]), []);
  }
});

test('resolveRefs maps a txn.<id> figure key to a transaction ref', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  const txn = s.db.prepare('SELECT id FROM transactions ORDER BY id DESC LIMIT 1').get();
  const out = await resolveRefs(s.db, scenario, [{ kind: 'figure', id: `txn.${txn.id}` }]);
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.equal(out[0].kind, 'transaction');
  assert.equal(String(out[0].id), String(txn.id));
  assert.match(out[0].use, /transactions.search/);
});

test('resolveRefs of an empty list is empty', async t => {
  const s = await demoStore(t);
  assert.deepEqual(await resolveRefs(s.db, buildScenario(s.db), []), []);
});

/* ---------- the answerer ---------- */

test('PRODUCT_RULES carries the references rule', () => {
  assert.match(PRODUCT_RULES, /references/);
  assert.match(PRODUCT_RULES, /tools/);
});

test('answer({ refs }) puts resolved references with kind, id and use in the conversation context and provenance', async t => {
  const s = await demoStore(t);
  const refs = [
    { kind: 'account', id: 'a_biz' },
    { kind: 'rec', id: 'deferral' },
    { kind: 'figure', id: 'true_reserve' },
    { kind: 'account', id: 'a_no_such' },
  ];
  const kept = refs.slice(0, 3);
  const { engine, requests } = always(s.runtime, 'Keep a reserve.');
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'Synthetic question about these', refs });
  assert.ok(reply && !reply.notice, JSON.stringify(reply).slice(0, 300));
  assert.ok(requests.length >= 1);
  assert.ok(requests[0].system.includes(PRODUCT_RULES), 'the static system carries the product rules');
  const context = contextOf(requests[0].systemDynamic);
  assert.ok(Array.isArray(context.references), JSON.stringify(context).slice(0, 300));
  for (const r of context.references) {
    assert.ok(typeof r.use === 'string' && r.use.trim(), `${r.kind}:${r.id} has a use hint`);
  }
  assert.deepEqual(byKey(context.references.map(({ kind, id }) => ({ kind, id }))), byKey(kept));
  assert.deepEqual(byKey(reply.provenance.references), byKey(kept));
  for (const r of reply.provenance.references) assert.deepEqual(Object.keys(r).sort(), ['id', 'kind']);
});

test('answer without refs has no references in the context or provenance', async t => {
  const s = await demoStore(t);
  const { engine, requests } = always(s.runtime, 'Keep a reserve.');
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'Synthetic plain question' });
  assert.ok(!reply.notice);
  assert.ok(!String(requests[0].systemDynamic).includes('"references"'));
  assert.ok(!('references' in reply.provenance), JSON.stringify(reply.provenance).slice(0, 300));
  const none = await createLiveAnswerer({ engine: always(s.runtime, 'Keep a reserve.').engine, packs: s.packs })
    .answer({ db: s.db, key: THREAD, text: 'Synthetic plain question', refs: [{ kind: 'account', id: 'a_no_such' }] });
  assert.ok(!('references' in none.provenance), 'nothing resolved, nothing recorded');
});

test('the scripted model calls the hinted tools for an account and a transaction reference and the cited amount is grounded', async t => {
  const s = await demoStore(t);
  const now = clockNow(s.db);
  const old = await oldTransactions(s.db, now);
  assert.ok(old.length > 0, 'the demo store has more than 200 transactions');

  // An old transaction whose amount nothing but the tool grounds: a baseline with the same
  // references and no tool call marks it unverified. Grounding is sign-strict, so the pick is a
  // credit: its stated amount equals the amount the tool returns.
  let pick = null;
  for (const cand of old.filter(c => c.amount > 0)) {
    const refs = [{ kind: 'account', id: cand.account_id }, { kind: 'transaction', id: String(cand.id) }];
    const said = `That transaction was ${asAmount(Math.abs(cand.amount))}.`;
    const base = await createLiveAnswerer({ engine: always(s.runtime, said).engine, packs: s.packs })
      .answer({ db: s.db, key: THREAD, text: 'Synthetic baseline', refs });
    if (base.provenance.grounding.unverified.includes(asAmount(Math.abs(cand.amount)))) { pick = cand; break; }
  }
  assert.ok(pick, 'some old transaction amount is grounded by nothing but a tool result');
  const amount = asAmount(Math.abs(pick.amount));
  const refs = [{ kind: 'account', id: pick.account_id }, { kind: 'transaction', id: String(pick.id) }];
  const said = `That transaction was ${amount}.`;
  const { engine, requests, responses } = scripted(s.runtime, [
    [{ toolCalls: [
      { name: 'transactions', args: { operation: 'search',  ids: [String(pick.id)] } },
      { name: 'transactions', args: { operation: 'search',  accountId: pick.account_id, limit: 5 } },
    ] }, { text: said }],
    [{ text: said }],
  ]);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'What was that charge?', refs });
  assert.ok(!reply.notice, JSON.stringify(reply).slice(0, 300));
  const context = contextOf(requests[0].systemDynamic);
  const txnRef = context.references.find(r => r.kind === 'transaction');
  assert.ok(txnRef && String(txnRef.id) === String(pick.id), JSON.stringify(context.references));
  assert.match(txnRef.use, /transactions.search/);
  const accRef = context.references.find(r => r.kind === 'account');
  assert.ok(accRef && accRef.id === pick.account_id);
  assert.match(accRef.use, /transactions.search|accounts.list/);

  const byIds = responses[0].toolResults.find(r => r.name === 'transactions' && r.args && Array.isArray(r.args.ids));
  assert.ok(byIds && !byIds.isError, JSON.stringify(responses[0].toolResults).slice(0, 400));
  assert.ok(byIds.result.rows.some(r => String(r.id) === String(pick.id) && r.amount === pick.amount), 'the real tool returned the old row');
  const { unverified } = reply.provenance.grounding;
  assert.ok(!unverified.includes(amount), `the tool result grounds ${amount}: ${JSON.stringify(reply.provenance.grounding)}`);
  const literal = reply.provenance.literals.find(l => l.text === amount);
  // The source names the transaction the tool returned (main labels tool literals in plain words).
  assert.match(literal && literal.source, /your transactions/, JSON.stringify(reply.provenance.literals));
  assert.ok(literal.source.includes(pick.date), JSON.stringify(reply.provenance.literals));
  assert.deepEqual(byKey(reply.provenance.references), byKey(refs));
});

test('a number that appears only in a reference id or its hint is marked unverified', async t => {
  const s = await demoStore(t);
  const recId = 'rec8263';
  insertDigitRec(s.db, recId);
  const scenario = buildScenario(s.db);
  assert.ok(scenario.recs.some(r => r.id === recId), 'the synthetic rec is visible');
  const refs = [{ kind: 'rec', id: recId }];
  const resolved = await resolveRefs(s.db, scenario, refs);
  assert.equal(resolved.length, 1, 'the reference resolves');
  assert.ok(resolved[0].use.includes('8263') || resolved[0].id.includes('8263'));

  const said = 'This one is worth $8,263, or 8263 in round terms.';
  const { engine, requests } = always(s.runtime, said);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'Synthetic referenced question', refs });
  assert.ok(!reply.notice);
  assert.ok(requests[0].systemDynamic.includes(recId), 'the model sees the reference id');
  const { unverified } = reply.provenance.grounding;
  assert.ok(unverified.includes('$8,263'), `the reference id must not ground $8,263: ${JSON.stringify(reply.provenance.grounding)}`);
  assert.ok(unverified.includes('8263'), `the reference id must not ground 8263: ${JSON.stringify(reply.provenance.grounding)}`);
  assert.deepEqual(reply.provenance.references, [{ kind: 'rec', id: recId }]);
});

/* ---------- HTTP: malformed context is a 400 on every ask path, JSON and streaming ---------- */

const BAD = [{ kind: 'bogus', id: 'a_biz' }];
const NOT_LIST = 'account:a_biz';
const GOOD = [{ kind: 'account', id: 'a_biz' }];

function events(text) {
  return text.split('\n\n').filter(b => b.trim() && !b.startsWith(':')).map(block => {
    const name = /^event: (.+)$/m.exec(block)[1];
    const data = JSON.parse(/^data: (.+)$/m.exec(block)[1]);
    return { name, data };
  });
}

const stream = (s, path, body) => postJson(s.baseUrl, path, body, { accept: 'text/event-stream' });

function expect400(r, what) {
  assert.equal(r.status, 400, `${what}: ${r.status} ${r.text.slice(0, 200)}`);
  assert.match(r.headers['content-type'], /^application\/json/, `${what}: no stream starts`);
}

function expectRefs(message, what) {
  assert.ok(message && message.provenance, `${what}: message with provenance`);
  assert.deepEqual(message.provenance.references, GOOD, `${what}: ${JSON.stringify(message.provenance).slice(0, 300)}`);
}

function finalOf(r, what) {
  assert.equal(r.status, 200, `${what}: ${r.status} ${r.text.slice(0, 200)}`);
  assert.match(r.headers['content-type'], /^text\/event-stream/);
  const evs = events(r.text);
  assert.equal(evs.at(-1).name, 'final', `${what}: ${r.text.slice(-300)}`);
  return evs.at(-1).data;
}

test('POST /api/threads (new thread): malformed context is 400; a valid context answers and stores the references', T, () => withServer({ env: FAKE }, async s => {
  expect400(await postJson(s.baseUrl, '/api/threads', { text: 'Synthetic question', context: BAD }), 'json bad kind');
  expect400(await postJson(s.baseUrl, '/api/threads', { text: 'Synthetic question', context: NOT_LIST }), 'json not a list');
  const ok = await postJson(s.baseUrl, '/api/threads', { text: 'Synthetic question', context: GOOD });
  assert.equal(ok.status, 200, ok.text.slice(0, 300));
  expectRefs(ok.json.message, 'json');
  const db = await openStore(s.dbFile);
  try {
    const row = db.prepare("SELECT provenance FROM messages WHERE conversation_key = ? AND role = 'fathom'").get(ok.json.thread.key);
    assert.deepEqual(JSON.parse(row.provenance).references, GOOD, 'stored with the reply');
  } finally { db.close(); }

  expect400(await stream(s, '/api/threads', { text: 'Synthetic question', context: BAD }), 'stream bad kind');
  expectRefs(finalOf(await stream(s, '/api/threads', { text: 'Synthetic question', context: GOOD }), 'stream').message, 'stream');
}));

test('POST /api/ask (existing thread): malformed context is 400; a valid context answers', T, () => withServer({ env: FAKE }, async s => {
  const first = await postJson(s.baseUrl, '/api/threads', { text: 'Synthetic opener' });
  assert.equal(first.status, 200);
  const key = first.json.thread.key;
  expect400(await postJson(s.baseUrl, '/api/ask', { key, text: 'Synthetic follow-up', context: BAD }), 'json bad kind');
  expect400(await postJson(s.baseUrl, '/api/ask', { key, text: 'Synthetic follow-up', context: NOT_LIST }), 'json not a list');
  expect400(await postJson(s.baseUrl, '/api/ask', { key, text: 'Synthetic follow-up', context: Array.from({ length: 9 }, (_, i) => ({ kind: 'transaction', id: String(i + 1) })) }), 'json nine');
  const ok = await postJson(s.baseUrl, '/api/ask', { key, text: 'Synthetic follow-up', context: GOOD });
  assert.equal(ok.status, 200, ok.text.slice(0, 300));
  expectRefs(ok.json.message, 'json');

  expect400(await stream(s, '/api/ask', { key, text: 'Synthetic follow-up', context: BAD }), 'stream bad kind');
  expectRefs(finalOf(await stream(s, '/api/ask', { key, text: 'Synthetic follow-up', context: GOOD }), 'stream').message, 'stream');
}));

test('POST /api/threads with recId (rec thread): malformed context is 400; a valid context answers', T, () => withServer({ env: FAKE }, async s => {
  expect400(await postJson(s.baseUrl, '/api/threads', { recId: 'dcfsa', text: 'Synthetic rec question', context: BAD }), 'json bad kind');
  expect400(await postJson(s.baseUrl, '/api/threads', { recId: 'dcfsa', text: 'Synthetic rec question', context: [{ kind: 'account', id: '' }] }), 'json empty id');
  const ok = await postJson(s.baseUrl, '/api/threads', { recId: 'dcfsa', text: 'Synthetic rec question', context: GOOD });
  assert.equal(ok.status, 200, ok.text.slice(0, 300));
  assert.equal(ok.json.thread.recId, 'dcfsa');
  expectRefs(ok.json.message, 'json');

  expect400(await stream(s, '/api/threads', { recId: 'dcfsa', text: 'Synthetic rec question', context: BAD }), 'stream bad kind');
  expectRefs(finalOf(await stream(s, '/api/threads', { recId: 'dcfsa', text: 'Synthetic rec question', context: GOOD }), 'stream').message, 'stream');
}));

test('resolveRefs keeps a P&L entity and a real category row as /api/pnl keys them, and drops an invented category or unknown entity', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db, { packs: s.packs });
  const { pnlEntities, businessPnl } = await import('../src/pnl/business.mjs');
  const ent = pnlEntities({ db: s.db, clock: scenario.meta.clock }).find(e => e.kind === 'entity');
  assert.ok(ent, 'the demo store has a business entity');
  const real = businessPnl({ db: s.db, entity: ent.key, clock: scenario.meta.clock }).expenses.categories[0].category;
  const out = resolveRefs(s.db, scenario, [
    { kind: 'pnl', id: ent.key }, { kind: 'pnl', id: `${ent.key}|${real}` }, { kind: 'pnl', id: `${ent.key}|Synthetic invented category` },
    { kind: 'pnl', id: 'entity:nosuchbusiness' }, { kind: 'page', id: 'pnl' },
  ]);
  assert.deepEqual(out.map(r => `${r.kind}:${r.id}`), [`pnl:${ent.key}`, `pnl:${ent.key}|${real}`, 'page:pnl']);
  for (const r of out.filter(x => x.kind === 'pnl')) assert.match(r.use, /business.pnl/);
  assert.ok(out[1].use.includes(real), 'the hint names the real category');
  assert.ok(!JSON.stringify(out).includes('Synthetic invented category'), 'an invented category never reaches the prompt');
});
