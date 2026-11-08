// MT-05 AC2: the model boundary sees only the requesting household's context, and one household's
// poisoned accounting (a held round) never poisons another household's runtime that still has
// unreserved credit. Admission rechecks, before every round, the household lifecycle and
// generation (household_unavailable) and, for a user-initiated call, the requesting member's
// authorization (authorization_revoked), so a captured context cannot authorize a round after
// revocation.
//
// Live rounds run against test/helpers/model-emulator.mjs through the programmatic testTransport
// engine option; households, sessions and preferences are built through the real server, operator
// route, auth store and HTTP routes. Every value is synthetic.
//
// Assumptions (the contract is silent):
// 1. The chat prompt carries the household's stored preferences (src/api/answerer.mjs adds them to
//    the dynamic system text), so a preference canary reaches the request body of that
//    household's chat rounds.
// 2. An Ask whose chat round is refused or fails still answers 200 with a notice reply.
// 3. A suspended household may refuse with a plain EngineOffError (the outbound guard reports the
//    engine disabled before admission) or with code household_unavailable; a bumped generation
//    passes the guard and refuses at admission with household_unavailable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { src, sessionClient } from './helpers/server.mjs';
import { startModelEmulator } from './helpers/model-emulator.mjs';
import { liveTwoHouseholds, enrollSession } from './helpers/tenancy-runtime.mjs';

const T = { timeout: 180_000 };
const QUESTION = Object.freeze([{ role: 'user', content: 'Synthetic isolation question' }]);
const CALL = Object.freeze({ purpose: 'chat', messages: QUESTION, maxTokens: 64 });
const CANARY = Object.freeze({ A: 'canary-alpha-quokka', B: 'canary-bravo-heron' });
const PROBE = handler => ({
  name: 'synthetic_probe', description: 'Synthetic probe tool.', kind: 'read', operations: [{ name: 'read', scope: 'read' }],
  inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler,
});

const refused = (name, code) => err => {
  assert.equal(err?.name, name, err?.stack);
  if (code !== undefined) assert.equal(err.code, code, `${name} code`);
  return true;
};

const roundsOf = (platform, id) => platform.prepare("SELECT * FROM model_rounds WHERE household_id = ? AND kind = 'round' ORDER BY reserved_at, rowid").all(id).map(r => ({ ...r }));
const month = () => new Date().toISOString().slice(0, 7);
// The name of an offered tool (the household summary tool when offered).
const toolNamed = (body, name) => (body.tools ?? []).map(t => t.name).find(n => n === name || n.endsWith(`__${name}`)) ?? body.tools?.[0]?.name;
const chatRequests = (emulator, from = 0) => emulator.requests.slice(from).filter(r => r.model === 'claude-opus-5-5');

async function withLive(options, fn) {
  const emulator = await startModelEmulator();
  let two;
  try {
    two = await liveTwoHouseholds({ emulator, ...options });
    return await fn({ two, emulator, A: two.A.id, B: two.B.id });
  } finally {
    await emulator.close();
    await two?.close();
  }
}

async function ask(client, text) {
  const r = await client.postJson('/api/threads', { text });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  return r.json.message;
}

test('each household\'s model requests carry only its own stored context', T, () => withLive({}, async ({ two, emulator }) => {
  for (const [key, client] of [['A', two.A.client], ['B', two.B.client]]) {
    const saved = await client.postJson('/api/preferences', { text: `Prefer the ${CANARY[key]} wording` });
    assert.equal(saved.status, 200, saved.text.slice(0, 300));
  }
  const slices = {};
  for (const [key, client, other] of [['A', two.A.client, 'B'], ['B', two.B.client, 'A']]) {
    const from = emulator.requests.length;
    const message = await ask(client, `Synthetic ${key === 'A' ? 'alpha' : 'bravo'} isolation question`);
    assert.ok(!message.notice, `${key} answered`);
    slices[key] = emulator.requests.slice(from);
    const chats = chatRequests(emulator, from);
    assert.ok(chats.length >= 1, `${key} made a chat round`);
    for (const r of chats) assert.ok(JSON.stringify(r.body).includes(CANARY[key]), `${key}'s chat round carries its own preference`);
    for (const r of slices[key]) assert.ok(!JSON.stringify(r.body).includes(CANARY[other]), `${key}'s rounds never carry ${other}'s context`);
  }
  // Each household's rounds are recorded under that household only.
  assert.equal(roundsOf(two.platform, two.A.id).length, slices.A.length);
  assert.equal(roundsOf(two.platform, two.B.id).length, slices.B.length);

  // The engine boundary itself: a direct call of one household never sees the other's data.
  const from = emulator.requests.length;
  await two.ctx(two.B.id).engine.call({ purpose: 'confirm', messages: [{ role: 'user', content: `Synthetic ${CANARY.B} confirm` }], maxTokens: 32 });
  const body = JSON.stringify(emulator.requests[from].body);
  assert.ok(body.includes(CANARY.B) && !body.includes(CANARY.A));
}));

test('a held household refuses while the other keeps answering and settling on unreserved credit', T, () => withLive({}, async ({ two, emulator, A, B }) => {
  const budget = await src('src/platform/model-budget.mjs');
  emulator.script([{ destroy: true }]);
  const failed = await ask(two.A.client, 'Synthetic alpha question that fails');
  assert.equal(failed.notice, true, 'the failed round answers with a notice');
  assert.equal(emulator.requests.length, 1, 'no further round after the transport failure');
  const [held] = roundsOf(two.platform, A);
  assert.equal(held.state, 'held');
  assert.equal(held.hold_code, 'cost_unknown');

  const again = await ask(two.A.client, 'Synthetic alpha question while held');
  assert.equal(again.notice, true, 'the held household refuses');
  assert.equal(emulator.requests.length, 1, 'nothing dispatched for the held household');
  const side = await two.side(A);
  await assert.rejects(side.engine.call(CALL), refused('ModelAccountingError', 'accounting_hold'));

  // B is unaffected: it answers over HTTP and through its engine, and its rounds settle.
  const answered = await ask(two.B.client, 'Synthetic bravo question');
  assert.ok(!answered.notice, 'B still answers');
  await two.ctx(B).engine.call(CALL);
  const rowsB = roundsOf(two.platform, B);
  assert.ok(rowsB.length >= 2);
  for (const row of rowsB) assert.equal(row.state, 'settled');
  assert.equal(roundsOf(two.platform, A).length, 1, 'A gained no rounds');
  const instance = await budget.committedUsd(two.platform, { month: month() });
  assert.ok(instance >= held.reserved_usd, 'the held reservation still counts against the instance');
}));

test('a principal revoked between rounds refuses the next round with authorization_revoked', T, () => withLive({}, async ({ two, emulator, A }) => {
  const { runWithPrincipal, withoutPrincipal } = await src('src/platform/model-budget.mjs');
  const engine = two.ctx(A).engine;
  let authorized = true;
  emulator.script([{ toolUse: { input: {} } }]);
  await assert.rejects(runWithPrincipal({ check: () => authorized }, () => engine.call({ purpose: 'chat', messages: QUESTION, maxTokens: 64,
    tools: [PROBE(() => { authorized = false; return { ok: true }; })] })), refused('EngineOffError', 'authorization_revoked'));
  assert.equal(emulator.requests.length, 1, 'the round after revocation dispatched nothing');
  const rows = roundsOf(two.platform, A);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'settled');

  await assert.rejects(runWithPrincipal({ check: () => false }, () => engine.call(CALL)), refused('EngineOffError', 'authorization_revoked'));
  assert.equal(emulator.requests.length, 1, 'a revoked principal never reaches the model');

  // A system-initiated call (a job) carries no principal.
  await runWithPrincipal({ check: () => false }, () => withoutPrincipal(() => engine.call(CALL)));
  assert.equal(emulator.requests.length, 2);

  // Liveness: a principal that stays authorized runs both rounds.
  emulator.script([{ toolUse: { input: {} } }, { text: 'Synthetic answer after the probe.' }]);
  const res = await runWithPrincipal({ check: () => true }, () => engine.call({ purpose: 'chat', messages: QUESTION, maxTokens: 64,
    tools: [PROBE(() => ({ ok: true }))] }));
  assert.equal(res.text, 'Synthetic answer after the probe.');
  assert.equal(emulator.requests.length, 4);
}));

test('over HTTP, a session deleted or a membership removed mid-Ask stops the next round; an intact one completes', T, () => withLive({}, async ({ two, emulator, A }) => {
  const { createAuthStore } = await src('src/auth/store.mjs');
  const store = createAuthStore(two.platform);
  const toolRound = body => ({ toolUse: { name: toolNamed(body, 'household'), input: { operation: 'summary' } } });

  // Liveness: an intact session runs the tool round and the answer round.
  emulator.script([toolRound, { text: 'Synthetic answer after the summary.' }]);
  const done = await ask(two.A.client, 'Synthetic alpha question with a tool');
  assert.ok(!done.notice, 'answered');
  assert.equal(chatRequests(emulator).length, 2, 'both chat rounds dispatched');

  // The admin's session is deleted while the first round is at the model.
  let from = emulator.requests.length;
  let rowsBefore = roundsOf(two.platform, A).length;
  emulator.script([body => { store.revokeSession(two.A.admin.token); return toolRound(body); }]);
  let r = await two.A.client.postJson('/api/threads', { text: 'Synthetic alpha question, session revoked' });
  assert.ok(r.status !== 200 || r.json?.message?.notice === true, `no answer after revocation: ${r.status}`);
  assert.equal(emulator.requests.length, from + 1, 'no round after the session was deleted');
  assert.equal(roundsOf(two.platform, A).length, rowsBefore + 1);

  // A member is removed from the household while the first round is at the model.
  const member = await enrollSession(two.platform, A, 'alpha-member@example.test', 'member');
  const client = sessionClient(two.baseUrl, member);
  from = emulator.requests.length;
  rowsBefore = roundsOf(two.platform, A).length;
  emulator.script([body => { store.removeMember(A, member.user.id); return toolRound(body); }]);
  r = await client.postJson('/api/threads', { text: 'Synthetic alpha question, member removed' });
  assert.ok(r.status !== 200 || r.json?.message?.notice === true, `no answer after removal: ${r.status}`);
  assert.equal(emulator.requests.length, from + 1, 'no round after the membership was removed');
  assert.equal(roundsOf(two.platform, A).length, rowsBefore + 1);
}));

test('a bumped generation or a suspended household refuses before dispatch; restored, it answers', T, () => withLive({}, async ({ two, emulator, A }) => {
  const ctx = two.ctx(A);
  const bump = d => two.platform.prepare('UPDATE households SET generation = generation + ? WHERE id = ?').run(d, A);
  bump(1);
  try {
    await assert.rejects(ctx.engine.call(CALL), refused('EngineOffError', 'household_unavailable'));
  } finally {
    bump(-1);
  }
  assert.equal(emulator.requests.length, 0);
  await ctx.engine.call(CALL);
  assert.equal(emulator.requests.length, 1, 'the current generation is admitted');

  two.platform.prepare("UPDATE households SET status = 'suspended' WHERE id = ?").run(A);
  try {
    await assert.rejects(ctx.engine.call(CALL), err => {
      assert.equal(err?.name, 'EngineOffError', err?.stack);
      assert.ok(err.code === undefined || err.code === 'household_unavailable', String(err.code));
      return true;
    });
  } finally {
    two.platform.prepare("UPDATE households SET status = 'active' WHERE id = ?").run(A);
  }
  assert.equal(emulator.requests.length, 1, 'nothing dispatched while suspended');
  await ctx.engine.call(CALL);
  assert.equal(emulator.requests.length, 2, 'the restored household is admitted');
}));
