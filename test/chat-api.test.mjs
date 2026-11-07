// AC2 and AC3 over HTTP: the demo server with FATHOM_ENGINE=fake answers Ask chips, free text,
// rec conversations and What if through the live answerer, stores provenance with each answer,
// records spend, and answers with notices (engine off, over cap, off by configuration) instead
// of fabricated text.

import test from 'node:test';
import assert from 'node:assert/strict';
import demo from '../demo/scenario.mjs';
import { SERVER_TIMEOUT, withServer, postJson, getScenario, openStore } from './helpers/server.mjs';

const T = { timeout: SERVER_TIMEOUT };
const FAKE = { FATHOM_ENGINE: 'fake' };
const INVENTED = '$987,654';
const INVENTED_2 = '$876,543';
const UNCHECKED = '<span class="fx-checking fx-unchecked" title="Not checked against your data">';

async function ok(resPromise) {
  const r = await resPromise;
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.text.slice(0, 300)}`);
  assert.ok(r.json && r.json.scenario, 'response carries the scenario');
  return r.json;
}

async function readDb(file, fn) {
  const db = await openStore(file);
  try { return await fn(db); } finally { db.close(); }
}

const spendRows = file => readDb(file, db => db.prepare('SELECT * FROM spend_ledger ORDER BY id').all().map(r => ({ ...r })));
const ask = (s, body) => ok(postJson(s.baseUrl, '/api/ask', body));
// A new Ask thread asked `text` first: { scenario, thread, message }.
const askNew = (s, text) => ok(postJson(s.baseUrl, '/api/threads', { text }));
// The suggested question 'leave' as free text: the fake answer source matches it to its canned answer.
const LEAVE = demo.ask.suggested.find(q => q.id === 'leave').q;
const toolNames = message => message.provenance.tools.map(x => x.name);

test('an Ask chip stores a grounded answer with provenance in the message row and the scenario', T, () => withServer({ env: FAKE }, async s => {
  const r = await askNew(s, LEAVE);
  const m = r.message;
  assert.equal(m.role, 'fathom');
  assert.equal(m.notice, false);
  assert.ok(m.text.includes('{f:yearend_cash}'), m.text);
  assert.ok(m.refs.includes('reserve'));
  assert.equal(m.provenance.engine, 'fake');
  assert.equal(m.provenance.grounding.ok, true);
  assert.ok(toolNames(m).includes('household'));
  assert.ok(m.provenance.figures.includes('yearend_cash'));
  const conv = r.scenario.live.conversations[r.thread.key];
  assert.equal(conv.length, 2);
  assert.equal(conv[0].role, 'me');
  assert.equal(conv[0].provenance.ownerInput.actorId, 'demo');
  assert.deepEqual(conv[1], m);
  const stored = await readDb(s.dbFile, db => db.prepare("SELECT provenance FROM messages WHERE conversation_key = ? AND role = 'fathom'").get(r.thread.key));
  assert.deepEqual(JSON.parse(stored.provenance), m.provenance);
  assert.ok(!stored.provenance.includes('<household.summary>'), 'no prompt text is stored');
}));

test('unmatched free text gets a grounded answer from the household summary with a bound literal', T, () => withServer({ env: FAKE }, async s => {
  const r = await askNew(s, 'How are things looking overall');
  const m = r.message;
  assert.equal(m.notice, false);
  assert.equal(m.provenance.grounding.ok, true);
  assert.ok(toolNames(m).includes('household'));
  assert.ok(m.text.includes('class="fx-src"'), m.text);
  assert.ok(Array.isArray(m.provenance.literals) && m.provenance.literals.length > 0);
  assert.deepEqual(m.refs, []);
}));

// The fake engine echoes the owner's amounts next to the household summary count, which grounds.
test('free text with one invented amount is stored once with the amount unchecked in place, no regeneration', T, () => withServer({ env: FAKE }, async s => {
  const r = await askNew(s, `Could we spend ${INVENTED} on a sailboat`);
  const m = r.message;
  assert.equal(m.notice, false);
  assert.ok(m.text.includes(`${UNCHECKED}${INVENTED}</span>`), m.text);
  assert.ok(!m.text.includes('fx-unverified'), m.text);
  assert.equal(m.provenance.grounding.ok, false);
  assert.equal(m.provenance.grounding.retried, false);
  assert.equal(m.provenance.grounding.revised, undefined);
  assert.deepEqual(m.provenance.grounding.unverified, [INVENTED]);
  assert.equal(m.provenance.work.items.some(x => x.draft || (x.k === 'step' && /^Revised/.test(x.label))), false);
}));

test('free text with two invented amounts is regenerated once and stored with both unchecked and one revision step', T, () => withServer({ env: FAKE }, async s => {
  const r = await askNew(s, `Could we spend ${INVENTED} or ${INVENTED_2} on a sailboat`);
  const m = r.message;
  assert.equal(m.notice, false);
  // The fake engine repeats the same answer, so both amounts are still unchecked after the regeneration.
  for (const amount of [INVENTED, INVENTED_2]) assert.ok(m.text.includes(`${UNCHECKED}${amount}</span>`), m.text);
  assert.equal(m.provenance.grounding.ok, false);
  assert.equal(m.provenance.grounding.retried, true);
  assert.equal(m.provenance.grounding.revised, 2);
  const { items } = m.provenance.work;
  assert.deepEqual(items.filter(x => x.k === 'step' && /^Revised/.test(x.label)), [{ k: 'step', label: 'Revised to remove 2 unchecked figures' }]);
  assert.equal(items.some(x => x.draft), false, 'no draft note');
  const conv = r.scenario.live.conversations[r.thread.key];
  assert.deepEqual(conv.map(x => x.role), ['me', 'fathom'], 'one answer for the turn');
}));

test('a rec thread question answers with the rec as its ref and provenance', T, () => withServer({ env: FAKE }, async s => {
  const r = await ok(postJson(s.baseUrl, '/api/threads', { recId: 'deferral', questionId: 0 }));
  assert.equal(r.thread.recId, 'deferral');
  assert.equal(r.message.notice, false);
  assert.ok(r.message.refs.includes('deferral'));
  assert.ok(toolNames(r.message).includes('recommendations'));
  const conv = r.scenario.live.conversations[r.thread.key];
  assert.equal(conv.length, 2, 'question, answer');
  assert.equal(conv[0].role, 'me');
  assert.ok(!('deferral' in r.scenario.live.conversations), 'no rec-keyed conversation');
}));

test('what-if runs a live conversation once, stores provenance and marks the pack done', T, () => withServer({ env: FAKE }, async s => {
  const { scenario } = await ok(postJson(s.baseUrl, '/api/packs/giving/whatif', {}));
  const conv = scenario.live.conversations['pack:giving'];
  assert.equal(conv.length, 2);
  assert.equal(conv[0].role, 'me');
  assert.ok(conv[0].text.includes(scenario.packs.find(p => p.id === 'giving').whatIf.prompt));
  assert.equal(conv[1].role, 'fathom');
  assert.equal(conv[1].notice, false);
  assert.equal(conv[1].provenance.engine, 'fake');
  assert.equal(conv[1].provenance.grounding.ok, true);
  assert.ok(conv[1].refs.includes('daf'), 'the pack unlocks are the refs');
  assert.equal(scenario.live.packs.giving.whatIfDone, true);
  assert.equal(scenario.live.packs.giving.exploring, true);
  const again = await ok(postJson(s.baseUrl, '/api/packs/giving/whatif', {}));
  assert.equal(again.scenario.live.conversations['pack:giving'].length, 2, 'no duplicate answer');
  const followUp = await ask(s, { key: 'pack:giving', text: 'What would that change for us' });
  assert.equal(followUp.message.notice, false);
  assert.ok(followUp.message.provenance);
  assert.equal(followUp.scenario.live.conversations['pack:giving'].length, 4);
}));

test('engine off stores the notice without spending; back on answers with provenance', T, () => withServer({ env: FAKE }, async s => {
  await ok(postJson(s.baseUrl, '/api/engine', { on: false }));
  const before = (await spendRows(s.dbFile)).length;
  const off = await askNew(s, LEAVE);
  assert.equal(off.message.notice, true);
  assert.ok(off.message.text.includes('Engine is off, so answers are paused.'));
  assert.equal((await spendRows(s.dbFile)).length, before);
  const whatIf = await ok(postJson(s.baseUrl, '/api/packs/giving/whatif', {}));
  assert.equal(whatIf.scenario.live.packs.giving.whatIfDone, false, 'a notice does not mark the what-if done');
  await ok(postJson(s.baseUrl, '/api/engine', { on: true }));
  const on = await ask(s, { key: off.thread.key, text: LEAVE });
  assert.equal(on.message.notice, false);
  assert.ok(on.message.provenance);
}));

test('a zero cap stores the over-cap notice without spending; a restored cap answers', T, () => withServer({ env: FAKE }, async s => {
  await ok(postJson(s.baseUrl, '/api/engine/cap', { usd: 0 }));
  const before = (await spendRows(s.dbFile)).length;
  const capped = await askNew(s, LEAVE);
  assert.equal(capped.message.notice, true);
  assert.ok(capped.message.text.includes('is used up, so answers are paused'), capped.message.text);
  assert.ok(capped.message.text.includes('{f:engine.budget.monthly}'), capped.message.text);
  assert.equal((await spendRows(s.dbFile)).length, before);
  const whatIf = await ok(postJson(s.baseUrl, '/api/packs/giving/whatif', {}));
  assert.equal(whatIf.scenario.live.packs.giving.whatIfDone, false);
  await ok(postJson(s.baseUrl, '/api/engine/cap', { usd: 200 }));
  assert.equal((await ask(s, { key: capped.thread.key, text: LEAVE })).message.notice, false);
}));

test('a server configured with FATHOM_ENGINE=off answers with the configuration notice', T, () => withServer({ env: { FATHOM_ENGINE: 'off' } }, async s => {
  const before = (await spendRows(s.dbFile)).length;
  const r = await askNew(s, LEAVE);
  assert.equal(r.message.notice, true);
  assert.ok(r.message.text.includes('off in this deployment'), r.message.text);
  const whatIf = await ok(postJson(s.baseUrl, '/api/packs/giving/whatif', {}));
  const conv = whatIf.scenario.live.conversations['pack:giving'];
  assert.equal(conv.at(-1).notice, true);
  assert.equal(whatIf.scenario.live.packs.giving.whatIfDone, false);
  assert.equal((await spendRows(s.dbFile)).length, before);
}));

test('each answer records spend rows in the clock month that the scenario ledger lists', T, () => withServer({ env: FAKE }, async s => {
  const first = await getScenario(s.baseUrl);
  const before = await spendRows(s.dbFile);
  await askNew(s, LEAVE);
  const after = await spendRows(s.dbFile);
  const added = after.slice(before.length);
  // The first answer also names the thread, which spends one title call.
  assert.ok(added.filter(row => row.purpose === 'chat').length >= 1);
  assert.equal(added.filter(row => row.purpose === 'title').length, 1);
  for (const row of added) {
    assert.ok(['chat', 'title'].includes(row.purpose), row.purpose);
    assert.equal(row.model, 'fake');
    assert.equal(row.yyyymm, first.meta.clock.slice(0, 7));
    assert.ok(row.cost_usd > 0);
  }
  const sc = await getScenario(s.baseUrl);
  const listed = new Set(sc.engine.ledger.map(r => String(r.id)));
  assert.ok(added.every(row => listed.has(String(row.id))), 'the newest rows are in the scenario ledger');
  assert.ok(sc.engine.budget.used >= first.engine.budget.used);
}));

// B2: chat never writes. A negated command, plain status commands in ask and rec conversations
// and a What if on a pack leave every rec status unchanged; an explicit command comes back as a
// proposal in provenance for the owner to confirm, and nothing is written until they do.
const statuses = scenario => Object.fromEntries(scenario.recs.map(r => [r.id, r.status]));
const toolRows = file => readDb(file, db => db.prepare("SELECT count(*) AS n FROM rec_events WHERE actor = 'tool'").get().n);

test('Ask commands update recommendations with a receipt, while pack conversations remain read-only', T, () => withServer({ env: FAKE }, async s => {
  const { thread } = await ok(postJson(s.baseUrl, '/api/threads', { recId: 'deferral', text: 'Synthetic opening question' }));
  const changed = await ask(s, { key: thread.key, text: 'dismiss this' });
  assert.equal(statuses(changed.scenario).deferral, 'dismissed');
  assert.equal(changed.message.provenance.actions.length, 1);
  const id = changed.message.provenance.actions[0].id;
  await ok(postJson(s.baseUrl, `/api/actions/${id}/undo`, {}));
  const before = statuses(await getScenario(s.baseUrl));
  await ok(postJson(s.baseUrl, '/api/packs/giving/whatif', {}));
  await ask(s, { key: 'pack:giving', text: 'dismiss this' });
  assert.deepEqual(statuses(await getScenario(s.baseUrl)), before);
}));
