// Ask executes a confirmed proposal deterministically: a write tool called with propose: true stores
// the operation on the reply (provenance.pendingAction) and writes nothing; a typed explicit yes or
// the Confirm control runs the stored operation through the registry with no model call; stale
// proposals are refused. All household values here are synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createEvalStore, runCases } from '../evals/harness.mjs';
import { loadCases } from '../evals/cases.mjs';
import { tools, getTool } from '../src/tools/index.mjs';
import { createEngine } from '../src/engine/index.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import * as handlers from '../src/api/handlers.mjs';
import { parseJson } from '../src/store/db.mjs';

const { threadCreate, ask } = handlers;
const now = '2026-11-07T12:00:00.000Z';
const note = 'Each parent contributes $4,000 in December, due 2026-12-31.';
const args = { title: 'Parent education contribution', horizon: 'now', target: 4000, targetDate: '2026-12-31', track: null };
const PROPOSAL_TEXT = 'Create a goal for $4,000 by 2026-12-31? Confirm below, or reply yes.';

async function setup(t) {
  const s = await createEvalStore();
  t.after(() => s.close());
  return s;
}

function storedGoal(db, text = note) {
  const def = { id: 'education-note', title: 'Education savings', note: text, horizon: 'now', target: 8000, track: null };
  db.prepare("INSERT INTO goals (id, def, sort, origin, created_at) VALUES (?, ?, 100, 'owner', ?)").run(def.id, JSON.stringify(def), now);
}

// A fake engine whose non-title calls take the next script from `turns` (a text-only answer once
// they run out), counting every chat call.
function scriptedEngine(turns = []) {
  const transport = createEngine({ mode: 'fake' });
  const queue = [...turns];
  const calls = [];
  const engine = { mode: 'fake', isOn: () => true, call(request) {
    if (request.purpose === 'title') return Promise.resolve({ text: 'Synthetic goal', toolResults: [] });
    calls.push(request);
    const fake = queue.shift() ?? [{ text: 'Nothing else to change.' }];
    return transport.call({ ...request, fake });
  } };
  return { engine, calls, push: (...more) => queue.push(...more) };
}

const proposeTurn = (input = args, text = PROPOSAL_TEXT, operation = 'create') => [
  { toolCalls: [{ name: 'goals', args: { operation: 'list' } }, { name: 'update_goal', args: { operation, ...input, propose: true } }] },
  { text },
];

function context(s, engine, extra = {}) {
  return { db: s.db, config: {}, answerer: createLiveAnswerer({ engine, root: s.root, services: { engine, config: { dataDir: s.root } } }), ...extra };
}

const goalCount = db => db.prepare('SELECT count(*) AS n FROM goals').get().n;
const receiptCount = db => db.prepare('SELECT count(*) AS n FROM action_receipts').get().n;
const goalsTitled = (db, title) => db.prepare("SELECT * FROM goals WHERE json_extract(def, '$.title') = ?").all(title);
const storedProvenance = (db, messageId) => parseJson(db.prepare('SELECT provenance FROM messages WHERE id = ?').get(Number(String(messageId).slice(1))).provenance, null);
const lastOwnerText = (db, key) => db.prepare("SELECT text FROM messages WHERE conversation_key = ? AND role = 'me' ORDER BY id DESC LIMIT 1").get(key).text;

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#123;': '{', '&#125;': '}' };
const plain = html => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|#39|#123|#125);/g, m => ENTITIES[m]).replace(/\s+/g, ' ').trim();
const firstParagraph = html => plain(String(html ?? '').split(/<\/(?:p|ul|ol|div)>/i)[0]);

async function decide(ctx, thread, messageId, decision) {
  assert.equal(typeof handlers.proposalDecide, 'function', 'handlers.mjs exports proposalDecide');
  return handlers.proposalDecide({ ...ctx, params: { id: thread.id, messageId }, body: { decision } });
}

// A proposal turn in a new thread, with the stored note as the source of $4,000.
async function proposed(t, { input = args, text, operation, extra } = {}) {
  const s = await setup(t);
  storedGoal(s.db);
  const fake = scriptedEngine([proposeTurn(input, text, operation)]);
  const ctx = context(s, fake.engine, extra);
  const goals = goalCount(s.db);
  const first = await threadCreate({ ...ctx, body: { text: 'Propose the parent contribution goal from its note.' } });
  return { s, db: s.db, fake, ctx, first, goals, key: first.thread.key };
}

/* ---------- AC1: a proposal stores the operation and writes nothing ---------- */

test('AC1 a propose call stores provenance.pendingAction on the reply and writes nothing', async t => {
  const { db, first, goals } = await proposed(t);
  assert.equal(goalCount(db), goals, 'no goal written');
  assert.equal(receiptCount(db), 0, 'no receipt written');
  assert.ok(plain(first.message.text).includes('$4,000'));
  const pending = first.message.provenance.pendingAction;
  assert.ok(pending, 'reply carries pendingAction');
  const { basis, ...rest } = pending;
  assert.deepEqual(rest, { tool: 'update_goal', operation: 'create', args, scopes: ['write:goals'] });
  assert.equal(typeof basis, 'string');
  assert.match(basis, /^[0-9a-f]+$/);
  const call = first.message.provenance.tools.find(r => r.name === 'update_goal');
  assert.ok(call && !call.isError, 'the propose call succeeded');
  assert.equal(call.args.propose, true);
  assert.deepEqual(storedProvenance(db, first.message.id).pendingAction, pending, 'stored with the message');
});

// chat.js imports /shared/* the way the browser serves them (src/shared at /shared/).
let chatModule;
function loadChat() {
  if (!chatModule) {
    registerHooks({ resolve(specifier, context, next) {
      if (specifier.startsWith('/shared/')) return next(new URL(`../src/shared/${specifier.slice('/shared/'.length)}`, import.meta.url).href, context);
      return next(specifier, context);
    } });
    chatModule = import('../web/horizon/screens/chat.js');
  }
  return chatModule;
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

test('AC1 the chat card renders Confirm and Not now while unresolved, escapes arguments, and no buttons once resolved', async () => {
  const chat = await loadChat();
  assert.equal(typeof chat.pendingActionHtml, 'function', 'chat.js exports pendingActionHtml');
  chat.bind({ esc, T: esc, X: esc, arr: v => (Array.isArray(v) ? v : []), root: null,
    api: { s: { goals: [] }, rec: () => null, txt: s => s, threads: () => [], conversation: () => [] } });
  const pendingAction = { tool: 'update_goal', operation: 'create',
    args: { title: 'Synthetic <b>bold</b> fund', horizon: 'now', target: 5000 }, scopes: ['write:goals'], basis: 'ab12cd' };
  const m = { id: 'm12', role: 'fathom', text: '<p>I can create this goal.</p>', refs: [], notice: false, provenance: { pendingAction } };
  const html = chat.pendingActionHtml(m);
  assert.match(html, /class="[^"]*\bh-pending-action\b/);
  assert.match(html, /data-proposal-decide="confirm"/);
  assert.match(html, /data-proposal-decide="decline"/);
  assert.equal((html.match(/data-proposal-message="m12"/g) || []).length, 2, 'both buttons name the proposal message');
  assert.match(html, />\s*Confirm\s*</);
  assert.match(html, />\s*Not now\s*</);
  assert.ok(!html.includes('<b>bold</b>'), 'argument text is escaped');
  assert.ok(html.includes('&lt;b&gt;bold&lt;/b&gt;'), 'argument text is shown escaped');
  for (const [status, label] of [['confirmed', /Confirmed/], ['declined', /Not now/], ['stale', /Out of date/i]]) {
    const done = chat.pendingActionHtml({ ...m, provenance: { pendingAction: { ...pendingAction, resolved: { status, at: now } } } });
    assert.ok(!/<button/.test(done), `${status}: no buttons`);
    assert.ok(!/data-proposal-decide/.test(done), `${status}: no decide controls`);
    assert.match(done, label, `${status}: shows its resolved state`);
  }
  assert.equal(chat.pendingActionHtml({ ...m, provenance: {} }), '', 'no card without pendingAction');
});

/* ---------- AC2: confirm executes the stored operation without the model ---------- */

test('AC2 isExplicitYes accepts short explicit confirmations and rejects hedged replies', async () => {
  const { isExplicitYes } = await import('../src/actions/proposals.mjs');
  for (const yes of ['yes', 'yeah', 'Yep', 'sure', 'ok', 'okay', 'do it', 'go ahead', 'absolutely', 'correct', 'confirmed', 'Yes, please create it.']) {
    assert.equal(isExplicitYes(yes), true, yes);
  }
  for (const no of ['no', 'wait', 'yes but make it $5,000', 'yeah, not yet', 'okay maybe later', 'yesterday', 'surely not', 'yes, change the date',
    'yes ' + 'please '.repeat(30)]) {
    assert.equal(isExplicitYes(no), false, no);
  }
});

test('AC2 a typed "yeah" executes the stored proposal once, with a receipt and no engine call', async t => {
  const { db, fake, ctx, first, goals, key } = await proposed(t);
  const before = fake.calls.length;
  const second = await ask({ ...ctx, body: { key, text: 'yeah' } });
  assert.equal(fake.calls.length, before, 'the engine was not called for the confirming turn');
  assert.equal(goalCount(db), goals + 1, 'exactly one new goal');
  const rows = goalsTitled(db, args.title);
  assert.equal(rows.length, 1);
  const def = JSON.parse(rows[0].def);
  assert.deepEqual(Object.fromEntries(Object.keys(args).map(k => [k, def[k] ?? null])), args);
  assert.equal(rows[0].origin, 'owner');
  assert.equal(receiptCount(db), 1, 'exactly one receipt');
  const receipt = db.prepare('SELECT * FROM action_receipts').get();
  assert.equal(receipt.actor_id, 'demo');
  assert.equal(receipt.entity_id, rows[0].id);
  const p = second.message.provenance;
  assert.equal(p.confirmedProposal, first.message.id);
  assert.equal(p.actions[0].id, receipt.id);
  assert.equal(p.actions[0].actorId, 'demo');
  assert.equal(p.actions[0].undone, false, 'Undo is available');
  assert.ok(p.actionTurn, 'reply carries its action turn');
  assert.ok(!p.literals?.length, 'the confirming reply carries no literals');
  const call = p.tools.find(r => r.name === 'update_goal');
  assert.deepEqual(call.args, { operation: 'create', ...args });
  assert.equal(call.result.goal.target, 4000);
  assert.equal(call.result.receipt.id, receipt.id);
  assert.match(plain(second.message.text), /\b(?:done|saved|created)\b/i);
  assert.equal(lastOwnerText(db, key), 'yeah', 'the typed text is the stored owner message');
  assert.equal(storedProvenance(db, first.message.id).pendingAction.resolved.status, 'confirmed');
});

test('AC2 the Confirm control executes the stored proposal and stores "Confirmed" as the owner text', async t => {
  const { db, fake, ctx, first, goals, key } = await proposed(t);
  const before = fake.calls.length;
  const out = await decide(ctx, first.thread, first.message.id, 'confirm');
  assert.equal(fake.calls.length, before, 'no engine call');
  assert.ok(out.scenario && out.thread && out.message, 'returns { scenario, thread, message }');
  assert.equal(goalCount(db), goals + 1);
  assert.equal(goalsTitled(db, args.title).length, 1);
  assert.equal(receiptCount(db), 1);
  assert.equal(out.message.provenance.confirmedProposal, first.message.id);
  assert.equal(out.message.provenance.actions[0].actorId, 'demo');
  assert.equal(out.message.provenance.actions[0].undone, false);
  assert.equal(lastOwnerText(db, key), 'Confirmed');
  assert.equal(storedProvenance(db, first.message.id).pendingAction.resolved.status, 'confirmed');
  await assert.rejects(decide(ctx, first.thread, first.message.id, 'confirm'), e => e.status === 409, 'a resolved proposal is refused');
  assert.equal(goalsTitled(db, args.title).length, 1, 'a double click writes once');
});

test('AC2 "yeah" twice writes exactly one goal; the second goes to the engine', async t => {
  const { db, fake, ctx, goals, key } = await proposed(t);
  await ask({ ...ctx, body: { key, text: 'yeah' } });
  const before = fake.calls.length;
  fake.push([{ text: 'Your goal is already saved.' }]);
  const third = await ask({ ...ctx, body: { key, text: 'yeah' } });
  assert.equal(fake.calls.length, before + 1, 'the second yeah is answered by the engine');
  assert.equal(goalCount(db), goals + 1, 'still exactly one new goal');
  assert.equal(goalsTitled(db, args.title).length, 1);
  assert.equal(receiptCount(db), 1);
  assert.equal(third.message.provenance.confirmedProposal, undefined);
});

test('AC2 "yes but make it $5,000" does not execute the stored proposal and goes to the engine', async t => {
  const { db, fake, ctx, first, goals, key } = await proposed(t);
  assert.ok(first.message.provenance.pendingAction, 'the proposal is stored');
  const before = fake.calls.length;
  fake.push([{ text: 'Tell me the date for the changed goal.' }]);
  const reply = await ask({ ...ctx, body: { key, text: 'yes but make it $5,000' } });
  assert.equal(fake.calls.length, before + 1, 'the engine answered');
  assert.equal(goalCount(db), goals, 'no goal written');
  assert.equal(receiptCount(db), 0);
  assert.equal(reply.message.provenance.confirmedProposal, undefined);
  assert.notEqual(storedProvenance(db, first.message.id).pendingAction.resolved?.status, 'confirmed');
});

test('AC2 Not now declines without an engine call, and a later "yeah" writes nothing', async t => {
  const { db, fake, ctx, first, goals, key } = await proposed(t);
  const before = fake.calls.length;
  const out = await decide(ctx, first.thread, first.message.id, 'decline');
  assert.equal(fake.calls.length, before, 'no engine call');
  assert.equal(plain(out.message.text), 'Okay, nothing was changed.');
  assert.equal(lastOwnerText(db, key), 'Not now');
  assert.equal(goalCount(db), goals);
  assert.equal(receiptCount(db), 0);
  assert.equal(storedProvenance(db, first.message.id).pendingAction.resolved.status, 'declined');
  await assert.rejects(decide(ctx, first.thread, first.message.id, 'confirm'), e => e.status === 409);
  fake.push([{ text: 'Nothing was changed.' }]);
  await ask({ ...ctx, body: { key, text: 'yeah' } });
  assert.equal(fake.calls.length, before + 1, 'a later yeah goes to the engine');
  assert.equal(goalCount(db), goals, 'nothing written');
  assert.equal(receiptCount(db), 0);
});

test('AC2 the decide endpoint rejects a bad decision, an unknown message and a message without a proposal', async t => {
  const { ctx, first } = await proposed(t);
  await assert.rejects(decide(ctx, first.thread, first.message.id, 'maybe'), e => e.status === 400);
  await assert.rejects(decide(ctx, first.thread, 'm999999', 'confirm'), e => e.status === 404);
  const owner = ctx.db.prepare("SELECT id FROM messages WHERE conversation_key = ? AND role = 'me'").get(first.thread.key).id;
  await assert.rejects(decide(ctx, first.thread, 'm' + owner, 'confirm'), e => e.status === 404);
});

/* ---------- AC3: stale proposals are refused ---------- */

test('AC3 confirming an older proposal message is stale: nothing written, a short note, and one engine call', async t => {
  const { db, fake, ctx, first, goals, key } = await proposed(t);
  fake.push([{ text: 'That question has a synthetic unrelated answer.' }]);
  await ask({ ...ctx, body: { key, text: 'What else should I look at?' } });
  const before = fake.calls.length;
  fake.push([{ text: 'Let me check the goal again before proposing it.' }]);
  const out = await decide(ctx, first.thread, first.message.id, 'confirm');
  assert.equal(fake.calls.length, before + 1, 'the engine was called once for the stale turn');
  assert.equal(goalCount(db), goals, 'nothing written');
  assert.equal(receiptCount(db), 0);
  assert.match(firstParagraph(out.message.text), /out of date/i);
  assert.equal(storedProvenance(db, first.message.id).pendingAction.resolved.status, 'stale');
});

test('AC3 a proposal whose target row changed is stale: the direct change stays and no receipt is written', async t => {
  const edit = { id: 'education-note', target: 4000 };
  const { db, fake, ctx, first, key } = await proposed(t, { input: edit, operation: 'edit',
    text: 'Change the education goal target to $4,000? Confirm below, or reply yes.' });
  const pending = first.message.provenance.pendingAction;
  assert.ok(pending, 'the edit proposal is stored');
  assert.equal(pending.operation, 'edit');
  assert.deepEqual(pending.args, edit);
  db.prepare("UPDATE goals SET def = json_set(def, '$.target', 6000) WHERE id = 'education-note'").run();
  const before = fake.calls.length;
  fake.push([{ text: 'The goal changed since my proposal, so I will check it again.' }]);
  const out = await ask({ ...ctx, body: { key, text: 'yeah' } });
  assert.equal(fake.calls.length, before + 1, 'the engine was called once');
  assert.equal(JSON.parse(db.prepare("SELECT def FROM goals WHERE id = 'education-note'").get().def).target, 6000, 'the direct change stays');
  assert.equal(receiptCount(db), 0, 'no receipt from the proposal');
  assert.match(firstParagraph(out.message.text), /out of date/i);
  assert.equal(out.message.provenance.confirmedProposal, undefined);
  assert.equal(storedProvenance(db, first.message.id).pendingAction.resolved.status, 'stale');
});

/* ---------- AC4: scopes and evidence ---------- */

test('AC4 a propose call outside the allowed scopes fails and stores no pendingAction', async t => {
  const { db, first, goals } = await proposed(t, { extra: { scopes: ['read', 'write:facts'] } });
  const call = first.message.provenance.tools.find(r => r.name === 'update_goal');
  assert.ok(call, 'the update_goal call is recorded');
  assert.equal(call.isError, true, 'the propose call failed');
  assert.doesNotMatch(call.result.error, /not a known argument/, 'refused for its scope, not for an unknown propose argument');
  assert.equal(first.message.provenance.pendingAction, undefined, 'no pendingAction stored');
  assert.equal(goalCount(db), goals);
  assert.equal(receiptCount(db), 0);
});

test('AC4 the evidence guard still runs when a stored proposal executes', async t => {
  const s = await setup(t);
  const { db } = s;
  const invented = { title: 'Synthetic invented goal', horizon: 'now', target: 97361 };
  assert.equal(db.prepare('SELECT count(*) AS n FROM figures WHERE v = 97361').get().n, 0, 'the target is not a stored figure');
  const fake = scriptedEngine([[
    { toolCalls: [{ name: 'update_goal', args: { operation: 'create', ...invented, propose: true } }] },
    { text: 'I can create this goal. Confirm below, or reply yes.' },
  ]]);
  const ctx = context(s, fake.engine);
  const goals = goalCount(db);
  const first = await threadCreate({ ...ctx, body: { text: 'Propose a synthetic invented goal.' } });
  assert.ok(first.message.provenance.pendingAction, 'the proposal is stored');
  assert.equal(goalCount(db), goals);
  const before = fake.calls.length;
  fake.push([{ text: 'I could not save that goal without a stated target.' }]);
  const out = await ask({ ...ctx, body: { key: first.thread.key, text: 'yeah' } });
  assert.equal(fake.calls.length, before + 1, 'the refused execution goes back to the engine');
  assert.equal(goalCount(db), goals, 'no goal written');
  assert.equal(goalsTitled(db, invented.title).length, 0);
  assert.equal(receiptCount(db), 0);
  assert.match(firstParagraph(out.message.text), /target/i, 'the reply gives the tool reason it was not saved');
  assert.equal(storedProvenance(db, first.message.id).pendingAction.resolved.status, 'stale');
});

test('AC4 proposalTools refuses a proposal without onProposal and leaves MCP schemas untouched', async t => {
  const { db } = await setup(t);
  const { proposalTools } = await import('../src/actions/proposals.mjs');
  const wrapped = proposalTools(tools);
  const goal = wrapped.find(x => x.name === 'update_goal');
  assert.ok(goal, 'update_goal is wrapped');
  assert.deepEqual(goal.inputSchema.properties.propose, { type: 'boolean' });
  const read = wrapped.find(x => x.name === 'goals');
  assert.equal(read.inputSchema.properties.propose, undefined, 'read tools gain no propose argument');
  const goals = goalCount(db);
  await assert.rejects(
    goal.handler({ operation: 'create', ...args, propose: true }, { db, now, actorId: 'demo', conversationKey: 'ask:0123456789ab' }),
    e => e.name === 'ToolError');
  assert.equal(goalCount(db), goals, 'nothing written');
  assert.equal(receiptCount(db), 0);
  assert.equal(getTool('update_goal').inputSchema.properties.propose, undefined, 'the MCP schema has no propose');
  assert.equal(tools.find(x => x.name === 'update_goal').inputSchema.properties.propose, undefined);
});

/* ---------- AC5: the eval case passes on the new path ---------- */

test('AC5 goals-confirm-stored-note proposes on turn one and executes the stored proposal on "yeah"', async () => {
  const c = (await loadCases()).find(x => x.id === 'goals-confirm-stored-note');
  assert.ok(c, 'the case is in the catalog');
  const score = await runCases({ cases: [c] });
  const result = score.cases[0];
  assert.equal(result.status, 'pass', JSON.stringify(result));
  const proposal = result.turns[0].tools.find(r => r.name === 'update_goal' && r.args.operation === 'create');
  assert.ok(proposal, 'turn one calls update_goal create');
  assert.equal(proposal.args.propose, true);
  const write = result.turns.at(-1).tools.find(r => r.name === 'update_goal' && r.args.operation === 'create');
  assert.ok(write, 'the last turn records the executed create');
  assert.equal(write.result.goal.target, 4000);
  assert.equal(write.result.goal.targetDate, '2026-12-31');
  assert.ok(write.result.receipt.id);
});

/* ---------- review round 1 regressions ---------- */

test('AC2 "yeah, make it $5,000" goes to the engine and never runs the stored $4,000 operation', async t => {
  const { isPlainConfirmation } = await import('../src/actions/proposals.mjs');
  for (const yes of ['yeah', 'Yes, please create it.', 'sure, go ahead', 'ok thanks']) assert.equal(isPlainConfirmation(yes), true, yes);
  for (const no of ['yeah, make it $5,000', 'yes for March', 'yes and also the date', 'yeah, make it five thousand']) assert.equal(isPlainConfirmation(no), false, no);
  const { db, fake, ctx, first, goals, key } = await proposed(t);
  const before = fake.calls.length;
  fake.push([{ text: 'Tell me the date for the changed goal.' }]);
  const reply = await ask({ ...ctx, body: { key, text: 'yeah, make it $5,000' } });
  assert.equal(fake.calls.length, before + 1, 'the engine answered');
  assert.equal(goalCount(db), goals, 'no goal written');
  assert.equal(receiptCount(db), 0);
  assert.equal(reply.message.provenance.confirmedProposal, undefined);
  assert.equal(storedProvenance(db, first.message.id).pendingAction.resolved, undefined);
});

test('AC4 a proposal never sources its own date: an invented targetDate is refused on confirm', async t => {
  const s = await setup(t);
  const { db } = s;
  storedGoal(db);
  const invented = { title: 'Synthetic dated goal', horizon: 'now', target: 4000, targetDate: '2028-03-17', track: null };
  const fake = scriptedEngine([proposeTurn(invented, 'Create a goal for $4,000 by 2028-03-17? Confirm below, or reply yes.')]);
  const ctx = context(s, fake.engine);
  const goals = goalCount(db);
  const first = await threadCreate({ ...ctx, body: { text: 'Propose a dated goal from the note.' } });
  const call = first.message.provenance.tools.find(r => r.name === 'update_goal');
  assert.ok(call && !call.isError);
  assert.ok(!(first.message.provenance.literals ?? []).some(l => l.text.includes('2028')), 'the proposal does not ground its own date');
  fake.push([{ text: 'I could not save that date.' }]);
  await ask({ ...ctx, body: { key: first.thread.key, text: 'yeah' } });
  assert.equal(goalCount(db), goals, 'no goal written');
  assert.equal(goalsTitled(db, invented.title).length, 0);
  assert.equal(receiptCount(db), 0);
});

test('AC3 a proposal is stale when the goal note it took a value from changes', async t => {
  const { db, fake, ctx, first, key } = await proposed(t, { input: { ...args, title: 'Second synthetic goal' } });
  assert.ok(first.message.provenance.pendingAction);
  db.prepare("UPDATE goals SET def = json_set(def, '$.note', 'Each parent contributes $5,000 in December, due 2026-12-31.') WHERE id = 'education-note'").run();
  const goals = goalCount(db);
  fake.push([{ text: 'The note changed, so I will check it again.' }]);
  const out = await ask({ ...ctx, body: { key, text: 'yeah' } });
  assert.equal(goalCount(db), goals, 'nothing written');
  assert.equal(receiptCount(db), 0);
  assert.match(firstParagraph(out.message.text), /out of date/i);
  assert.equal(storedProvenance(db, first.message.id).pendingAction.resolved.status, 'stale');
});

test('AC1 the card shows no model-supplied amount or date', async () => {
  const chat = await loadChat();
  const pendingAction = { tool: 'update_goal', operation: 'create', args: { title: 'Synthetic fund', horizon: 'now', target: 97361, targetDate: '2028-03-17' },
    scopes: ['write:goals'], basis: 'ab12cd' };
  const html = chat.pendingActionHtml({ id: 'm7', role: 'fathom', text: '<p>x</p>', refs: [], notice: false, provenance: { pendingAction } });
  assert.ok(html.includes('Synthetic fund'));
  assert.ok(!/97361|97,361|2028/.test(html), 'no unsourced figure in the card');
  assert.match(html, /data-proposal-decide="confirm"/);
});

test('an incomplete recommendation answer proposal preserves the confirmation and refusal note', async t => {
  const s = await setup(t);
  const def = { id: 'synthetic-questions', title: 'Synthetic coverage', question: { keys: ['benefits.hsaCoverage', 'business.cashBasis'], primary: true } };
  s.db.prepare("INSERT INTO recs (id, def, status, updated_at) VALUES (?, ?, 'waiting', ?)").run(def.id, JSON.stringify(def), now);
  const fake = scriptedEngine([[
    { toolCalls: [{ name: 'answer', args: { operation: 'rec_questions', recId: def.id, answers: [{ key: 'benefits.hsaCoverage', value: 'family' }], evidence: 'family', propose: true } }] },
    { text: 'Record family coverage?' },
  ], [{ text: 'That change was not saved. Please answer each question on this recommendation.' }]]);
  const ctx = context(s, fake.engine);
  const first = await threadCreate({ ...ctx, body: { text: 'We have family coverage.' } });
  assert.equal(first.message.provenance.pendingAction.operation, 'rec_questions');
  const result = await decide(ctx, first.thread, first.message.id, 'confirm');
  assert.equal(lastOwnerText(s.db, first.thread.key), 'Confirmed');
  assert.match(plain(result.message.text), /That change was not saved/);
  assert.ok(JSON.stringify(fake.calls.at(-1)).includes('answer each question on this recommendation'));
  assert.equal(receiptCount(s.db), 0);
});


test('INF1 the entity proposal card names each business, tax type, person and final-year status', async () => {
  const chat = await loadChat();
  chat.bind({ esc, T: esc, X: esc, arr: v => Array.isArray(v) ? v : [], root: null, api: { s: { goals: [] } } });
  const html = chat.pendingActionHtml({ id: 'm19', role: 'fathom', provenance: { pendingAction: {
    tool: 'answer', operation: 'fact', args: { key: 'business.entities', value: [
      { name: 'Example <Studio>', type: 's_corp', owner: 'owner', status: 'active', accountId: 'synthetic-business' },
      { name: 'Spouse LLC', type: 'llc_single', owner: 'spouse', status: 'active' },
      { name: 'Former partnership', type: 'partnership', owner: 'spouse', status: 'final_year', finalYear: 2026 },
    ] },
  } } });
  assert.match(html, /Example &lt;Studio&gt;/);
  assert.match(html, /S corp/);
  assert.match(html, /single-member LLC.*Schedule C/i);
  assert.match(html, /your spouse/i);
  assert.match(html, /final year.*final K-1/i);
  assert.match(html, /linked business account/i);
  assert.ok(!html.includes('synthetic-business'), 'raw account identifiers stay out of the card');
  assert.match(html, /data-proposal-decide="confirm"/);
});
