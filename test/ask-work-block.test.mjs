// The work block for Ask answers (plan feat-ask-work-block). Interim text a model writes before or
// between tool calls is not part of the answer: the engine returns the final round's text and the
// interim texts apart, streams an `interim` event before that round's tools, and the answerer
// stores the steps and notes as provenance.work = { ms, items }. The scripted fake question
// "Show your work" exercises the whole path. A regeneration (two or more unchecked figures, more
// than half of them) streams one "Revised to remove N unchecked figures" progress step, then a plain
// { type: 'reset' }, and stores that one step; the replaced first attempt is never kept as a draft
// note. Every fixture is synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { seedDemo } from '../demo/seed.mjs';
import { loadConfig } from '../src/config.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { createLivePacks } from '../src/packs/live.mjs';
import { createEngine, fakeChunks } from '../src/engine/index.mjs';
import * as engineModule from '../src/engine/index.mjs';
import { createLiveAnswerer, groundAnswer, progressLabel, PROGRESS_START, PROGRESS_GROUNDING } from '../src/api/answerer.mjs';
import { fakeAnswerScript } from '../src/api/fake-answers.mjs';
import { SERVER_TIMEOUT, withServer, request, postJson, tempDb } from './helpers/server.mjs';

const T = { timeout: SERVER_TIMEOUT };
const FAKE = { FATHOM_ENGINE: 'fake', FATHOM_FAKE_STREAM_MS: '0' };
const THREAD = 'ask:0123456789ab';
const SHOW = 'Show your work: where does the household stand?';
const NOTE_1 = 'Let me start with your household summary.';
const NOTE_2 = 'Now the details this rests on.';

const step = label => ({ k: 'step', label });
const REVISED_2 = 'Revised to remove 2 unchecked figures';
const note = text => ({ k: 'note', text });

/* ---------- A. engine: final round text, interim texts and the interim event ---------- */

const chat = { purpose: 'chat', system: 'Use stored figures.', messages: [{ role: 'user', content: 'What is the balance?' }], maxTokens: 128 };
const schema = { type: 'object', properties: { account: { type: 'string', enum: ['demo'] } }, required: ['account'], additionalProperties: false };
const balance = { name: 'balance', description: 'Read a synthetic balance.', kind: 'read', operations: [{ name: 'read', scope: 'read' }], inputSchema: schema, handler: async () => ({ value: 125 }) };
const alpha = { ...balance, name: 'alpha', description: 'Read a synthetic alpha value.', handler: async () => ({ value: 2 }) };
const call = name => ({ name, args: { account: 'demo' } });

const THREE_ROUNDS = [
  { text: 'Let me look.', toolCalls: [call('balance')] },
  { text: NOTE_2, toolCalls: [call('balance'), call('alpha')] },
  { text: 'Your balance is $125.' },
];

test('a chat call returns the final round text, and the tool rounds texts as interim, in order', async () => {
  const engine = createEngine({ mode: 'fake' });
  const res = await engine.call({ ...chat, tools: [balance, alpha], fake: THREE_ROUNDS });
  assert.equal(res.text, 'Your balance is $125.');
  assert.deepEqual(res.interim, ['Let me look.', NOTE_2]);
  assert.equal(res.grounding.ok, true);
  const single = await engine.call({ ...chat, fake: [{ text: 'Hello.' }] });
  assert.equal(single.text, 'Hello.');
  assert.deepEqual(single.interim, []);
  // Interim text is trimmed and an empty tool round adds nothing.
  const spaced = await engine.call({ ...chat, tools: [balance], fake: [
    { text: '  Checking.  ', toolCalls: [call('balance')] }, { toolCalls: [call('balance')] }, { text: 'Done.' },
  ] });
  assert.deepEqual(spaced.interim, ['Checking.']);
  assert.equal(spaced.text, 'Done.');
});

test('a final round with no text falls back to the earlier rounds joined, with no interim', async () => {
  const engine = createEngine({ mode: 'fake' });
  const res = await engine.call({ ...chat, tools: [balance], fake: [
    { text: 'Plan A', toolCalls: [call('balance')] }, { text: 'Keep a reserve.', toolCalls: [call('balance')] }, {},
  ] });
  assert.equal(res.text, 'Plan A\n\nKeep a reserve.');
  assert.deepEqual(res.interim, []);
  const word = await engine.call({ ...chat, tools: [balance], fake: [
    { text: 'Set aside $1,2', toolCalls: [call('balance')] }, { text: '00 into savings.', toolCalls: [call('balance')] }, {},
  ] });
  assert.equal(word.text, 'Set aside $1,200 into savings.');
});

test('non-chat purposes keep the legacy text joined across rounds', async () => {
  const engine = createEngine({ mode: 'fake' });
  const res = await engine.call({ ...chat, purpose: 'job', tools: [balance, alpha], fake: THREE_ROUNDS });
  assert.equal(res.text, `Let me look.\n\n${NOTE_2}\n\nYour balance is $125.`);
});

test('a tool round streams its text, then interim with the round text, then its tools; the next round has no separator', async () => {
  const engine = createEngine({ mode: 'fake' });
  const seen = [];
  const res = await engine.call({ ...chat, tools: [balance, alpha], fake: THREE_ROUNDS, onEvent: e => seen.push(e) });
  const texts = s => fakeChunks(s).map(text => ({ type: 'text', text }));
  assert.deepEqual(seen, [
    ...texts('Let me look.'), { type: 'interim', text: 'Let me look.' }, { type: 'tool', name: 'balance' },
    ...texts(NOTE_2), { type: 'interim', text: NOTE_2 }, { type: 'tool', name: 'balance' }, { type: 'tool', name: 'alpha' },
    ...texts('Your balance is $125.'),
  ]);
  const lastInterim = seen.map(e => e.type).lastIndexOf('interim');
  assert.equal(seen.slice(lastInterim + 1).filter(e => e.type === 'text').map(e => e.text).join(''), res.text);
  // A tool round without text sends no interim event.
  const quiet = [];
  await engine.call({ ...chat, tools: [balance], fake: [{ toolCalls: [call('balance')] }, { text: 'Done.' }], onEvent: e => quiet.push(e) });
  assert.deepEqual(quiet, [{ type: 'tool', name: 'balance' }, { type: 'text', text: 'Done.' }]);
});

test('a throwing listener never fails a multi-round call', async () => {
  const engine = createEngine({ mode: 'fake' });
  const res = await engine.call({ ...chat, tools: [balance, alpha], fake: THREE_ROUNDS, onEvent: () => { throw new Error('boom'); } });
  assert.equal(res.text, 'Your balance is $125.');
  assert.deepEqual(res.interim, ['Let me look.', NOTE_2]);
});

test('after an interim round the assembler starts over: no separator, and a replace restreams the final round only', () => {
  const a = engineModule.createAnswerAssembler();
  a.beginRound();
  assert.equal(a.streamPiece('Let me look.'), 'Let me look.');
  a.endRound('Let me look.', { interim: true });
  a.beginRound();
  assert.equal(a.streamPiece('Refused'), 'Refused', 'no separator after an interim round');
  assert.equal(a.replaceRound('Keep a reserve.'), 'Keep a reserve.', 'the restream is the answer so far, without interim text');
  a.endRound('Keep a reserve.');
  assert.equal(a.text, 'Keep a reserve.');
  // Within the final answer rounds the separator logic is unchanged.
  const b = engineModule.createAnswerAssembler();
  b.beginRound();
  b.endRound('Plan A');
  b.beginRound();
  assert.equal(b.streamPiece('Keep'), '\n\nKeep');
});

/* ---------- B. answerer: final text only, provenance.work ---------- */

async function demoStore(t) {
  const s = await tempDb();
  t.after(async () => { s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  seedDemo(s.db);
  const config = loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'fake', FATHOM_FAKE_STREAM_MS: '0' });
  const runtime = createRuntimeEngine({ db: s.db, config });
  const packs = createLivePacks(s.db, { dataDir: s.dataDir });
  packs.refresh();
  return { ...s, config, runtime, packs };
}

// The runtime with call() intercepted: each call sends the next script as request.fake.
function scripted(runtime, scripts = []) {
  const queue = [...scripts];
  const requests = [];
  const engine = new Proxy(runtime, {
    get(target, key) {
      if (key === 'call') {
        return async req => {
          requests.push(req);
          const next = queue.shift();
          return target.call(next ? { ...req, fake: next } : req);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { engine, requests };
}

async function askScripted(s, scripts, { onEvent, text = 'What should I keep?' } = {}) {
  const run = scripted(s.runtime, scripts);
  const reply = await createLiveAnswerer({ engine: run.engine, packs: s.packs }).answer({
    db: s.db, key: THREAD, text, ...(onEvent ? { onEvent } : {}),
  });
  return { reply, requests: run.requests };
}

const INTERIM_SCRIPT = () => [[
  { text: 'Let me start with your accounts. You have $987,654 somewhere.', toolCalls: [{ name: 'accounts', args: { operation: 'list', } }] },
  { text: 'Now your goals.', toolCalls: [{ name: 'goals', args: { operation: 'list', } }, { name: 'goals', args: { operation: 'list', } }] },
  { text: 'Keep a reserve.' },
]];

test('the stored answer and its grounding use only the final text; an unsourced number in interim text causes no retry', async t => {
  const s = await demoStore(t);
  const { reply, requests } = await askScripted(s, INTERIM_SCRIPT());
  assert.deepEqual(reply.paragraphs, ['Keep a reserve.']);
  assert.deepEqual(reply.provenance.grounding, { ok: true, retried: false, unverified: [] });
  assert.equal(requests.length, 1, 'no corrective retry');
  assert.doesNotMatch(reply.paragraphs.join('\n'), /accounts|goals|987/);
});

test('provenance.work lists the start step, each round note before its tool steps, and the grounding step', async t => {
  const s = await demoStore(t);
  const { reply } = await askScripted(s, INTERIM_SCRIPT());
  const { work } = reply.provenance;
  assert.ok(work && typeof work === 'object', 'work is stored');
  assert.ok(Number.isInteger(work.ms) && work.ms >= 0, `ms is a non-negative whole number: ${work.ms}`);
  assert.deepEqual(work.items, [
    step(PROGRESS_START),
    note('Let me start with your accounts. You have $987,654 somewhere.'),
    step(progressLabel('accounts')),
    note('Now your goals.'),
    step(progressLabel('goals')),
    step(PROGRESS_GROUNDING),
  ]);
  // Consecutive identical steps collapse: household.summary right after the start step is one step.
  const plain = await askScripted(s, [[{ toolCalls: [{ name: 'household', args: { operation: 'summary', } }] }, { text: 'Keep a reserve.' }]]);
  assert.deepEqual(plain.reply.provenance.work.items, [step(PROGRESS_START), step(PROGRESS_GROUNDING)]);
});

test('provenance.work is the same with and without a stream listener', async t => {
  const s = await demoStore(t);
  const seen = [];
  const streamed = await askScripted(s, INTERIM_SCRIPT(), { onEvent: e => seen.push(e) });
  const quiet = await askScripted(s, INTERIM_SCRIPT());
  assert.deepEqual(streamed.reply.provenance.work.items, quiet.reply.provenance.work.items);
  // The answerer forwards interim events with the round text.
  assert.deepEqual(seen.filter(e => e.type === 'interim').map(e => e.text),
    ['Let me start with your accounts. You have $987,654 somewhere.', 'Now your goals.']);
  const lastInterim = seen.map(e => e.type).lastIndexOf('interim');
  assert.equal(seen.slice(lastInterim + 1).filter(e => e.type === 'text').map(e => e.text).join(''), 'Keep a reserve.');
  assert.equal(seen.some(e => e.type === 'reset'), false);
});

test('a regeneration stores one revision step and no draft note, and streams the step before a plain reset', async t => {
  const s = await demoStore(t);
  const seen = [];
  const first = 'You owe $987,654 this year and $876,543 next year.';
  const { reply, requests } = await askScripted(s, [
    [{ text: 'Let me look.', toolCalls: [{ name: 'accounts', args: { operation: 'list', } }] }, { text: first }],
    [{ text: 'Nothing to add.' }],
  ], { onEvent: e => seen.push(e) });
  assert.equal(reply.provenance.grounding.retried, true);
  assert.equal(reply.provenance.grounding.revised, 2);
  assert.deepEqual(reply.paragraphs, ['Nothing to add.']);
  assert.deepEqual(reply.provenance.work.items, [
    step(PROGRESS_START),
    note('Let me look.'),
    step(progressLabel('accounts')),
    step(PROGRESS_GROUNDING),
    step(REVISED_2),
    step(PROGRESS_GROUNDING),
  ]);
  assert.equal(reply.provenance.work.items.some(x => x.draft), false, 'no draft note');
  // The corrective turn feeds back the final text only.
  const assistant = requests[1].messages.filter(m => m.role === 'assistant').at(-1);
  assert.equal(assistant.content, first);
  const resets = seen.filter(e => e.type === 'reset');
  assert.deepEqual(resets, [{ type: 'reset' }], 'one plain reset, no draft flag');
  const lastReset = seen.indexOf(resets[0]);
  const revisedAt = seen.findIndex(e => e.type === 'progress' && e.label === REVISED_2);
  assert.ok(revisedAt >= 0 && revisedAt < lastReset, 'the revision step streams before the reset');
  assert.equal(seen.slice(lastReset + 1).filter(e => e.type === 'text').map(e => e.text).join(''), 'Nothing to add.');
  // The live items equal the stored ones: the replaced text never became a note.
  assert.deepEqual(liveItems(seen), reply.provenance.work.items);
});

test('a single unchecked amount streams no reset and stores no revision step', async t => {
  const s = await demoStore(t);
  const seen = [];
  const { reply, requests } = await askScripted(s, [
    [{ text: 'Let me look.', toolCalls: [{ name: 'accounts', args: { operation: 'list', } }] }, { text: 'You owe $987,654 this year.' }],
    [{ text: 'must not run' }],
  ], { onEvent: e => seen.push(e) });
  assert.equal(requests.length, 1);
  assert.equal(reply.provenance.grounding.retried, false);
  assert.equal(seen.some(e => e.type === 'reset'), false);
  assert.deepEqual(reply.provenance.work.items, [
    step(PROGRESS_START),
    note('Let me look.'),
    step(progressLabel('accounts')),
    step(PROGRESS_GROUNDING),
  ]);
});

test('an engine restream reset carries no draft flag', async t => {
  const s = await demoStore(t);
  const engine = new Proxy(s.runtime, {
    get(target, key) {
      if (key === 'call') {
        return async req => {
          const { onEvent, ...rest } = req;
          onEvent?.({ type: 'text', text: 'Refused draft.' });
          onEvent?.({ type: 'reset' });
          onEvent?.({ type: 'text', text: 'Keep a reserve.' });
          return target.call({ ...rest, fake: [{ text: 'Keep a reserve.' }] });
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const seen = [];
  await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'What should I keep?', onEvent: e => seen.push(e) });
  assert.deepEqual(seen.filter(e => e.type === 'reset'), [{ type: 'reset' }]);
});

test('stored work is never capped: a 5000 character note and 60 tool steps stay whole, identical to the live items', async t => {
  const s = await demoStore(t);
  const long = 'Let me look at this part of the plan. '.repeat(140).trim().slice(0, 5000);
  assert.equal(long.length, 5000);
  assert.equal(long, long.trim());
  // Alternating labels never repeat in a row, so none of the 60 steps collapse.
  const many = Array.from({ length: 60 }, (_, i) => ({ name: i % 2 ? 'goals' : 'accounts', args: {} }));
  const seen = [];
  const { reply } = await askScripted(s, [[{ text: long, toolCalls: many }, { text: 'Keep a reserve.' }]], { onEvent: e => seen.push(e) });
  const { items } = reply.provenance.work;
  assert.deepEqual(items, [
    step(PROGRESS_START),
    note(long),
    ...many.map(c => step(progressLabel(c.name))),
    step(PROGRESS_GROUNDING),
  ]);
  assert.equal(items.find(x => x.k === 'note').text, long, 'the note is kept byte for byte');
  assert.equal(items.filter(x => x.k === 'step').length, 62);
  assert.deepEqual(liveItems(seen), items, 'the live items and the stored items are identical');
});

test('a notice reply has no work', async t => {
  const s = await demoStore(t);
  const off = new Proxy(s.runtime, { get(target, key) {
    if (key === 'isOn') return () => false;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const offReply = await createLiveAnswerer({ engine: off, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'What should I keep?' });
  assert.equal(offReply.notice, true);
  assert.equal(offReply.provenance?.work, undefined);
  const failed = await askScripted(s, [[{ is_error: true, text: '' }]]);
  assert.equal(failed.reply.notice, true);
  assert.equal(failed.reply.provenance?.work, undefined);
});

/* ---------- C. the scripted "show your work" fake question ---------- */

test('fakeAnswerScript scripts three rounds for "show your work", reading goals or the rec, and leaves other questions alone', async t => {
  const s = await tempDb();
  t.after(async () => { s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  seedDemo(s.db);
  const now = '2026-11-05T09:00:00.000Z';
  s.db.prepare('INSERT INTO conversations (key, created_at, last_at, rec_id) VALUES (?, ?, ?, ?)').run('ask:aaaaaaaaaaaa', now, now, 'deferral');
  s.db.prepare('INSERT INTO conversations (key, created_at, last_at) VALUES (?, ?, ?)').run('ask:bbbbbbbbbbbb', now, now);
  const scenario = buildScenario(s.db);
  const summary = { needsYouCount: 3 };
  const script = (key, text) => fakeAnswerScript({ scenario, key, text, summary, propose: true });

  const ask = script('ask:bbbbbbbbbbbb', SHOW);
  assert.equal(ask.length, 3);
  assert.deepEqual(ask[0], { text: NOTE_1, toolCalls: [{ name: 'household', args: { operation: 'summary', } }] });
  assert.equal(ask[1].text, NOTE_2);
  assert.deepEqual(ask[1].toolCalls.map(c => c.name), ['goals']);
  assert.ok(!ask[2].toolCalls || ask[2].toolCalls.length === 0);
  assert.equal(ask[2].text, 'From your household summary, 3 items need you right now.');

  const rec = script('ask:aaaaaaaaaaaa', SHOW);
  assert.equal(rec.length, 3);
  assert.deepEqual(rec[0], { text: NOTE_1, toolCalls: [{ name: 'household', args: { operation: 'summary', } }] });
  assert.equal(rec[1].text, NOTE_2);
  assert.deepEqual(rec[1].toolCalls, [{ name: 'recommendations', args: { operation: 'detail',  id: 'deferral' } }]);
  assert.equal(typeof rec[2].text, 'string');
  assert.ok(rec[2].text.length > 0);

  // Case-insensitive, word bounded.
  assert.equal(script('ask:bbbbbbbbbbbb', 'please SHOW YOUR WORK on this').length, 3);
  assert.equal(script('ask:bbbbbbbbbbbb', 'showyour work').length, 2);
  // Every other question keeps its two rounds: one tool round with no text, then the answer.
  for (const text of ['How does this work', 'Where does the household stand?']) {
    const other = script('ask:bbbbbbbbbbbb', text);
    assert.equal(other.length, 2, text);
    assert.equal(other[0].text, undefined, text);
    assert.equal(other[0].toolCalls[0].name, 'household');
  }
});

/* ---------- D. grounding: an ordered list stays a list for the structural count ---------- */

test('a spelled count matching the ordered list that follows grounds; a mismatch flags the count', () => {
  const opts = { scenario: { fig: {} }, toolResults: [], data: [] };
  for (const gap of ['\n', '\n\n']) {
    const three = groundAnswer(`There are three things to watch:${gap}1. Pay the estimate.\n2. Keep a reserve.\n3. File on time.`, opts);
    assert.equal(three.ok, true, JSON.stringify(three.violations));
    const two = groundAnswer(`There are three things to watch:${gap}1. Pay the estimate.\n2. Keep a reserve.`, opts);
    assert.equal(two.ok, false);
    assert.ok(two.violations.some(v => /three/i.test(v.text)), JSON.stringify(two.violations));
  }
});

/* ---------- E. over HTTP: the stream and the stored work ---------- */

function events(text) {
  return text.split('\n\n').filter(b => b.trim() && !b.startsWith(':')).map(block => ({
    name: /^event: (.+)$/m.exec(block)[1],
    data: JSON.parse(/^data: (.+)$/m.exec(block)[1]),
  }));
}

// Event names with consecutive repeats collapsed (text chunks, several progress labels).
const shape = evs => evs.map(e => e.name).filter((n, i, all) => i === 0 || n !== all[i - 1]).join(' ');
const SHAPE = /^start progress text interim (?:progress )?text interim progress text progress final$/;

async function showYourWork(s, body, recStep) {
  const r = await postJson(s.baseUrl, '/api/threads', body, { accept: 'text/event-stream' });
  assert.equal(r.status, 200);
  const evs = events(r.text);
  assert.match(shape(evs), SHAPE);
  assert.deepEqual(evs.filter(e => e.name === 'interim').map(e => e.data), [{ text: NOTE_1 }, { text: NOTE_2 }]);
  const labels = evs.filter(e => e.name === 'progress').map(e => e.data.label);
  assert.equal(labels[0], PROGRESS_START);
  assert.ok(labels.includes(recStep), JSON.stringify(labels));
  assert.equal(labels.at(-1), PROGRESS_GROUNDING);
  const final = evs.at(-1).data;
  const lastInterim = evs.map(e => e.name).lastIndexOf('interim');
  const answer = evs.slice(lastInterim + 1).filter(e => e.name === 'text').map(e => e.data.text).join('');
  assert.match(answer, /From your household summary/);
  assert.doesNotMatch(answer, /Let me start|Now the details/);
  assert.doesNotMatch(final.message.text, /Let me start|Now the details/);

  const thread = await request(s.baseUrl, { path: `/api/threads/${final.thread.key.slice(4)}` });
  assert.equal(thread.status, 200);
  const stored = thread.json.messages.find(m => m.role === 'fathom');
  assert.doesNotMatch(stored.text, /Let me start|Now the details/);
  const { work } = stored.provenance;
  assert.ok(Number.isInteger(work.ms) && work.ms >= 0);
  assert.deepEqual(work.items.filter(x => x.k === 'note'), [note(NOTE_1), note(NOTE_2)]);
  const steps = work.items.filter(x => x.k === 'step').map(x => x.label);
  assert.equal(steps[0], PROGRESS_START);
  assert.ok(steps.includes(recStep), JSON.stringify(steps));
  assert.equal(steps.at(-1), PROGRESS_GROUNDING);
  // A round's note comes before that round's tool steps.
  const at = work.items.findIndex(x => x.k === 'step' && x.label === recStep);
  assert.ok(work.items.findIndex(x => x.k === 'note' && x.text === NOTE_2) < at);
  return { evs, stored };
}

test('POST /api/threads streams interim events for "show your work" and stores the work with the message', T, () => withServer({ env: FAKE }, async s => {
  await showYourWork(s, { text: SHOW }, progressLabel('goals'));
}));

test('a thread asked from a rec streams and stores the same work, reading the recommendation', T, () => withServer({ env: FAKE }, async s => {
  const { stored } = await showYourWork(s, { recId: 'deferral', text: SHOW }, progressLabel('recommendations'));
  assert.ok(!stored.provenance.work.items.some(x => x.k === 'step' && x.label === progressLabel('goals')));
}));

/* ---------- F. order inside one tool round: text, tool, text, tool ---------- */

// One round whose content interleaves text and tool_use blocks, as the SDK emits them.
const interleaved = (first, second) => ({
  content: [
    { type: 'text', text: 'First note.' },
    { type: 'tool_use', id: 'synthetic-1', name: first, input: {} },
    { type: 'text', text: 'Second note.' },
    { type: 'tool_use', id: 'synthetic-2', name: second, input: {} },
  ],
  toolCalls: [{ name: first, args: {} }, { name: second, args: {} }],
});

test('the engine keeps a round\'s text and tools in content order, in its parts and its events', async () => {
  const open = { type: 'object', properties: {}, additionalProperties: false };
  const tools = [{ ...balance, inputSchema: open }, { ...alpha, inputSchema: open }];
  const engine = createEngine({ mode: 'fake' });
  const seen = [];
  const res = await engine.call({ ...chat, tools, fake: [interleaved('balance', 'alpha'), { text: 'Your balance is $125.' }],
    onEvent: e => seen.push(e) });
  assert.equal(res.text, 'Your balance is $125.');
  assert.ok(Array.isArray(res.toolRounds), 'the result carries toolRounds');
  assert.deepEqual(res.toolRounds[0].parts, [{ text: 'First note.' }, { tool: 'balance' }, { text: 'Second note.' }, { tool: 'alpha' }]);
  const order = seen.filter(e => e.type !== 'text').map(e => (e.type === 'tool' ? `tool:${e.name}` : `interim:${e.text}`));
  assert.deepEqual(order, ['interim:First note.', 'tool:balance', 'interim:Second note.', 'tool:alpha']);
  const lastInterim = seen.map(e => e.type).lastIndexOf('interim');
  assert.equal(seen.slice(lastInterim + 1).filter(e => e.type === 'text').map(e => e.text).join(''), res.text);
  // A round with text and toolCalls but no tool_use content keeps the text-then-tools parts.
  const plain = await engine.call({ ...chat, tools: [balance], fake: [{ text: 'Let me look.', toolCalls: [call('balance')] }, { text: 'Done.' }] });
  assert.deepEqual(plain.toolRounds[0].parts, [{ text: 'Let me look.' }, { tool: 'balance' }]);
});

// The items the client builds from the stream: progress pushes a step (a repeat in a row of steps
// is dropped), interim pushes a note.
function liveItems(seen) {
  const items = [];
  let last = null;
  for (const e of seen) {
    if (e.type === 'progress' && e.label !== last) { last = e.label; items.push(step(e.label)); }
    else if (e.type === 'interim' && e.text.trim()) items.push(note(e.text.trim()));
  }
  return items;
}

test('stored work keeps notes and steps in content order inside one round, identical to the live items', async t => {
  const s = await demoStore(t);
  const seen = [];
  const { reply } = await askScripted(s, [[interleaved('accounts', 'goals'), { text: 'Keep a reserve.' }]],
    { onEvent: e => seen.push(e) });
  const expected = [
    step(PROGRESS_START),
    note('First note.'),
    step(progressLabel('accounts')),
    note('Second note.'),
    step(progressLabel('goals')),
    step(PROGRESS_GROUNDING),
  ];
  const order = seen.filter(e => e.type === 'interim' || e.type === 'progress').map(e => (e.type === 'interim' ? e.text : e.label));
  assert.deepEqual(order, [PROGRESS_START, 'First note.', progressLabel('accounts'), 'Second note.', progressLabel('goals'), PROGRESS_GROUNDING]);
  assert.deepEqual(reply.provenance.work.items, expected);
  assert.deepEqual(liveItems(seen), reply.provenance.work.items);
  assert.deepEqual(reply.paragraphs, ['Keep a reserve.']);
});
