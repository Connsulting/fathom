// ST2: Ask never shows a draft that is later replaced. The answerer's stream carries progress
// labels (and interim work notes) only: no { type: 'text' } deltas and no { type: 'reset' }, so a
// first draft the corrective round replaces never reaches the page. The delivered answer arrives
// once, in the reply (the HTTP `final` event). Progress still streams before the answer resolves.
// Every fixture is synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { seedDemo } from '../demo/seed.mjs';
import { loadConfig } from '../src/config.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { createLivePacks } from '../src/packs/live.mjs';
import { createLiveAnswerer, progressLabel, PROGRESS_START, PROGRESS_GROUNDING } from '../src/api/answerer.mjs';
import { SERVER_TIMEOUT, withServer, postJson, tempDb } from './helpers/server.mjs';

const T = { timeout: SERVER_TIMEOUT };
const FAKE = { FATHOM_ENGINE: 'fake', FATHOM_FAKE_STREAM_MS: '0' };
const THREAD = 'ask:0123456789ab';
const DRAFT = 'You owe $987,654 this year and $876,543 next year.';
const SUMMARY = { name: 'household', args: { operation: 'summary' } };
const ACCOUNTS = { name: 'accounts', args: { operation: 'list' } };
const REVISED_2 = 'Revised to remove 2 unchecked figures';
// Two invented amounts in the owner's question: the fake engine echoes both, so the first answer
// is regenerated once.
const INVENTED = 'Is 4,321 or 5,432 the right amount for this?';

async function demoAnswerer(t) {
  const s = await tempDb();
  t.after(async () => { s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  await seedDemo(s.db);
  const config = loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'fake', FATHOM_FAKE_STREAM_MS: '0' });
  const engine = await createRuntimeEngine({ db: s.db, config });
  // The temp store's directory stands in as the household root.
  const packs = createLivePacks(s.db, { dataDir: s.dataDir });
  packs.refresh();
  return { s, engine, packs, root: s.dataDir };
}

// The runtime engine with a fake script per call: call 1 gets first, every later call gets later.
function twoScripts(engine, first, later) {
  let n = 0;
  return { ...engine, mode: engine.mode, isOn: () => engine.isOn(),
    call: req => engine.call({ ...req, fake: n++ === 0 ? first : later }) };
}

// Asks once with a stream listener. atResolve is how many events had arrived when the answer
// resolved; seen keeps collecting so a late event would show.
async function ask(t, first, later, text = 'How much?') {
  const { s, engine, packs, root } = await demoAnswerer(t);
  const wrapped = twoScripts(engine, first, later);
  const seen = [];
  let atResolve = -1;
  const reply = await createLiveAnswerer({ engine: wrapped, packs, root, services: { engine: wrapped, config: { dataDir: root } } })
    .answer({ db: s.db, key: THREAD, text, onEvent: e => seen.push(e) })
    .then(r => { atResolve = seen.length; return r; });
  await new Promise(r => setTimeout(r, 0));
  return { reply, seen, atResolve };
}

const labels = seen => seen.filter(e => e.type === 'progress').map(e => e.label);

function expectNoAnswerText(seen) {
  assert.deepEqual(seen.filter(e => e.type === 'text'), [], 'no text event reaches the listener');
  assert.deepEqual(seen.filter(e => e.type === 'reset'), [], 'no reset event reaches the listener');
  for (const e of seen) assert.ok(e.type === 'progress' || e.type === 'interim', `only progress and interim events: ${JSON.stringify(e)}`);
}

// SSE body to [{ name, data }].
function events(text) {
  return text.split('\n\n').filter(b => b.trim() && !b.startsWith(':')).map(block => ({
    name: /^event: (.+)$/m.exec(block)[1],
    data: JSON.parse(/^data: (.+)$/m.exec(block)[1]),
  }));
}

test('ST2-AC1 a first draft the corrective round replaces never streams: only progress, with the revision step, then the corrected reply', async t => {
  const { reply, seen, atResolve } = await ask(t,
    [{ text: DRAFT }],
    [{ toolCalls: [SUMMARY] }, { text: 'Nothing to add.' }]);
  assert.equal(reply.provenance.grounding.retried, true);
  expectNoAnswerText(seen);
  for (const e of seen) {
    const json = JSON.stringify(e);
    for (const bit of ['987,654', '987654', '876,543', '876543', 'You owe']) assert.ok(!json.includes(bit), `the draft never streams: ${json}`);
  }
  const got = labels(seen);
  assert.equal(got[0], PROGRESS_START, 'the start step comes first');
  const revisedAt = got.indexOf(REVISED_2);
  assert.ok(revisedAt > 0, `the revision step streams: ${JSON.stringify(got)}`);
  assert.ok(got.indexOf(PROGRESS_GROUNDING) < revisedAt, 'the first number check comes before the revision step');
  assert.equal(got.at(-1), PROGRESS_GROUNDING, 'the second number check comes last');
  assert.equal(atResolve, seen.length, 'nothing streams after the answer resolves');
  assert.deepEqual(reply.paragraphs, ['Nothing to add.']);
  assert.doesNotMatch(reply.paragraphs.join('\n'), /987|876|You owe/);
});

test('ST2-AC1 an engine restream (text, reset, text) reaches the listener as nothing', async t => {
  const { s, engine, packs, root } = await demoAnswerer(t);
  const restream = { ...engine, mode: engine.mode, isOn: () => engine.isOn(), call: async req => {
    const { onEvent, ...rest } = req;
    onEvent?.({ type: 'text', text: 'Refused draft.' });
    onEvent?.({ type: 'reset' });
    onEvent?.({ type: 'text', text: 'Keep a reserve.' });
    return engine.call({ ...rest, fake: [{ text: 'Keep a reserve.' }] });
  } };
  const seen = [];
  const reply = await createLiveAnswerer({ engine: restream, packs, root, services: { engine: restream, config: { dataDir: root } } })
    .answer({ db: s.db, key: THREAD, text: 'What should I keep?', onEvent: e => seen.push(e) });
  expectNoAnswerText(seen);
  assert.ok(!JSON.stringify(seen).includes('Refused draft'), JSON.stringify(seen));
  assert.deepEqual(reply.paragraphs, ['Keep a reserve.']);
});

test('ST2-AC1 over HTTP a regenerated answer streams start, progress and one final event, and no draft', T, async () => withServer({ env: FAKE }, async s => {
  const r = await postJson(s.baseUrl, '/api/threads', { text: INVENTED }, { accept: 'text/event-stream' });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/event-stream/);
  const evs = events(r.text);
  const names = evs.map(e => e.name);
  assert.equal(names[0], 'start');
  assert.equal(names.at(-1), 'final');
  assert.equal(names.filter(n => n === 'final').length, 1);
  assert.deepEqual(names.filter(n => n !== 'start' && n !== 'final' && n !== 'progress' && n !== 'interim'), [], `only start, progress, interim and final: ${names.join(' ')}`);
  assert.equal(names.includes('text'), false, 'no text event');
  assert.equal(names.includes('reset'), false, 'no reset event');
  const steps = evs.filter(e => e.name === 'progress').map(e => e.data.label);
  assert.equal(steps[0], PROGRESS_START);
  assert.ok(steps.includes(REVISED_2), JSON.stringify(steps));
  // The amounts reach the page only inside the final answer.
  for (const e of evs.slice(0, -1)) assert.doesNotMatch(JSON.stringify(e.data), /4,?321|5,?432/, JSON.stringify(e));
  const final = evs.at(-1).data;
  assert.equal(final.message.role, 'fathom');
  assert.equal(final.message.provenance.grounding.retried, true);
  assert.equal(final.message.provenance.work.items.some(x => x.draft), false);
}));

test('ST2-AC2 a clean first draft streams progress only, all of it before the answer resolves, and the reply carries the answer', async t => {
  const { reply, seen, atResolve } = await ask(t,
    [{ toolCalls: [ACCOUNTS] }, { text: 'Here is where things stand.' }],
    [{ text: 'A second call should not happen.' }],
    'Where do things stand?');
  assert.equal(reply.provenance.grounding.retried, false);
  expectNoAnswerText(seen);
  assert.ok(seen.length > 0, 'progress arrives');
  assert.deepEqual(labels(seen), [PROGRESS_START, progressLabel('accounts'), PROGRESS_GROUNDING]);
  assert.ok(atResolve >= 3, `the three progress steps arrived before the answer resolved: ${atResolve}`);
  assert.equal(atResolve, seen.length, 'nothing streams after the answer resolves');
  assert.ok(!JSON.stringify(seen).includes('Here is where things stand'), 'the answer text is not streamed');
  assert.deepEqual(reply.paragraphs, ['Here is where things stand.']);
});

test('ST2-AC2 over HTTP a clean answer streams progress before the final event and no text', T, async () => withServer({ env: FAKE }, async s => {
  const r = await postJson(s.baseUrl, '/api/threads', { text: 'Give me a quick read on where the household stands right now' }, { accept: 'text/event-stream' });
  assert.equal(r.status, 200);
  const evs = events(r.text);
  const names = evs.map(e => e.name);
  assert.equal(names[0], 'start');
  assert.equal(names[1], 'progress');
  assert.equal(evs[1].data.label, PROGRESS_START);
  assert.equal(names.at(-1), 'final');
  assert.equal(names.includes('text'), false, `no text event: ${names.join(' ')}`);
  assert.equal(names.includes('reset'), false);
  assert.equal(evs.at(-1).data.message.provenance.grounding.retried, false);
  assert.match(evs.at(-1).data.message.text, /class="fx-src"/);
}));
