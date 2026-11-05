// AC2 and AC3 over HTTP: the demo server with FATHOM_ENGINE=fake answers Ask chips, free text,
// rec conversations and What if through the live answerer, stores provenance with each answer,
// records spend, and answers with notices (engine off, over cap, off by configuration) instead
// of fabricated text.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SERVER_TIMEOUT, withServer, postJson, getScenario, openStore } from './helpers/server.mjs';

const T = { timeout: SERVER_TIMEOUT };
const FAKE = { FATHOM_ENGINE: 'fake' };
const INVENTED = '$987,654';

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
const toolNames = message => message.provenance.tools.map(x => x.name);

test('an Ask chip stores a grounded answer with provenance in the message row and the scenario', T, () => withServer({ env: FAKE }, async s => {
  const r = await ask(s, { key: 'ask', questionId: 'leave' });
  const m = r.message;
  assert.equal(m.role, 'fathom');
  assert.equal(m.notice, false);
  assert.ok(m.text.includes('{f:yearend_cash}'), m.text);
  assert.ok(m.refs.includes('reserve'));
  assert.equal(m.provenance.engine, 'fake');
  assert.equal(m.provenance.grounding.ok, true);
  assert.ok(toolNames(m).includes('household_summary'));
  assert.ok(m.provenance.figures.includes('yearend_cash'));
  const conv = r.scenario.live.conversations.ask;
  assert.equal(conv.length, 2);
  assert.equal(conv[0].role, 'me');
  assert.equal(conv[0].provenance, null, 'the owner message carries no provenance');
  assert.deepEqual(conv[1], m);
  const stored = await readDb(s.dbFile, db => db.prepare("SELECT provenance FROM messages WHERE conversation_key = 'ask' AND role = 'fathom'").get());
  assert.deepEqual(JSON.parse(stored.provenance), m.provenance);
  assert.ok(!stored.provenance.includes('<household_summary>'), 'no prompt text is stored');
}));

test('unmatched free text gets a grounded answer from the household summary with a bound literal', T, () => withServer({ env: FAKE }, async s => {
  const r = await ask(s, { key: 'ask', text: 'How are things looking overall' });
  const m = r.message;
  assert.equal(m.notice, false);
  assert.equal(m.provenance.grounding.ok, true);
  assert.ok(toolNames(m).includes('household_summary'));
  assert.ok(m.text.includes('class="fx-src"'), m.text);
  assert.ok(Array.isArray(m.provenance.literals) && m.provenance.literals.length > 0);
  assert.deepEqual(m.refs, []);
}));

test('free text with an invented amount is retried and stored with the amount marked unverified', T, () => withServer({ env: FAKE }, async s => {
  const r = await ask(s, { key: 'ask', text: `Could we spend ${INVENTED} on a sailboat` });
  const m = r.message;
  assert.equal(m.notice, false);
  assert.ok(m.text.includes(`<span class="fx-unverified" title="Not found in your data or tool results">${INVENTED}</span>`), m.text);
  assert.equal(m.provenance.grounding.ok, false);
  assert.equal(m.provenance.grounding.retried, true);
  assert.ok(m.provenance.grounding.unverified.includes(INVENTED));
}));

test('a rec conversation question answers with the rec as its ref and provenance', T, () => withServer({ env: FAKE }, async s => {
  const r = await ask(s, { key: 'deferral', questionId: 0 });
  assert.equal(r.message.notice, false);
  assert.ok(r.message.refs.includes('deferral'));
  assert.ok(toolNames(r.message).includes('get_recommendation'));
  const conv = r.scenario.live.conversations.deferral;
  assert.equal(conv.length, 3, 'opening summary, question, answer');
  assert.equal(conv[1].role, 'me');
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
  const off = await ask(s, { key: 'ask', questionId: 'leave' });
  assert.equal(off.message.notice, true);
  assert.ok(off.message.text.includes('Engine is off, so answers are paused.'));
  assert.equal((await spendRows(s.dbFile)).length, before);
  const whatIf = await ok(postJson(s.baseUrl, '/api/packs/giving/whatif', {}));
  assert.equal(whatIf.scenario.live.packs.giving.whatIfDone, false, 'a notice does not mark the what-if done');
  await ok(postJson(s.baseUrl, '/api/engine', { on: true }));
  const on = await ask(s, { key: 'ask', questionId: 'leave' });
  assert.equal(on.message.notice, false);
  assert.ok(on.message.provenance);
}));

test('a zero cap stores the over-cap notice without spending; a restored cap answers', T, () => withServer({ env: FAKE }, async s => {
  await ok(postJson(s.baseUrl, '/api/engine/cap', { usd: 0 }));
  const before = (await spendRows(s.dbFile)).length;
  const capped = await ask(s, { key: 'ask', questionId: 'leave' });
  assert.equal(capped.message.notice, true);
  assert.ok(capped.message.text.includes('is used up, so answers are paused'), capped.message.text);
  assert.ok(capped.message.text.includes('{f:engine.budget.monthly}'), capped.message.text);
  assert.equal((await spendRows(s.dbFile)).length, before);
  const whatIf = await ok(postJson(s.baseUrl, '/api/packs/giving/whatif', {}));
  assert.equal(whatIf.scenario.live.packs.giving.whatIfDone, false);
  await ok(postJson(s.baseUrl, '/api/engine/cap', { usd: 200 }));
  assert.equal((await ask(s, { key: 'ask', questionId: 'leave' })).message.notice, false);
}));

test('a server configured with FATHOM_ENGINE=off answers with the configuration notice', T, () => withServer({ env: { FATHOM_ENGINE: 'off' } }, async s => {
  const before = (await spendRows(s.dbFile)).length;
  const r = await ask(s, { key: 'ask', questionId: 'leave' });
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
  await ask(s, { key: 'ask', questionId: 'leave' });
  const after = await spendRows(s.dbFile);
  const added = after.slice(before.length);
  assert.ok(added.length >= 1);
  for (const row of added) {
    assert.equal(row.purpose, 'chat');
    assert.equal(row.model, 'fake');
    assert.equal(row.yyyymm, first.meta.clock.slice(0, 7));
    assert.ok(row.cost_usd > 0);
  }
  const sc = await getScenario(s.baseUrl);
  const listed = new Set(sc.engine.ledger.map(r => String(r.id)));
  assert.ok(added.every(row => listed.has(String(row.id))), 'the newest rows are in the scenario ledger');
  assert.ok(sc.engine.budget.used >= first.engine.budget.used);
}));
