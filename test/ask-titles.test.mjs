// AC3: naming Ask threads. The pure helpers in src/api/threads.mjs (validateTitle, fallbackTitle,
// nameThread, createThread are its public API), the title purpose in the engine, the Haiku title
// model and its pricing. Every fixture is synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { validateTitle, fallbackTitle, nameThread, createThread } from '../src/api/threads.mjs';
import { createEngine, createMemoryLedger, EngineOffError, BudgetExceededError } from '../src/engine/index.mjs';
import { DEFAULT_MODEL, TITLE_MODEL, usageCostUsd } from '../src/engine/pricing.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { tempDb } from './helpers/server.mjs';

const SC = { fig: {}, names: {} };
const CLOCK = '2026-11-05';
const close = (a, b) => Math.abs(a - b) < 1e-9;

// ---------------------------------------------------------------- validateTitle

test('AC3 validateTitle trims and collapses spaces', () => {
  assert.equal(validateTitle('  Quarterly   estimate  plan '), 'Quarterly estimate plan');
  assert.equal(validateTitle('Tax plan.'), 'Tax plan.', 'a rename keeps its period');
  assert.equal(validateTitle('x'.repeat(60)), 'x'.repeat(60));
  assert.equal(validateTitle('Plan for 2027 and the 401k'), 'Plan for 2027 and the 401k', 'a rename may carry digits');
  assert.equal(validateTitle('one two three four five six seven eight nine ten'), 'one two three four five six seven eight nine ten',
    'the word limit is for model output only');
});

test('AC3 validateTitle rejects empty, control characters, markup characters and over 60 characters', () => {
  for (const raw of ['', '   ', 'Tax\nplan', 'Tax\r\nplan', 'Tax\u0007plan', 'Tax\u0000plan', '<b>Tax</b>', 'Tax > plan',
    'Tax < plan', '{f:x} plan', 'Tax }', '`Tax` plan', 'x'.repeat(61), ` ${'x'.repeat(61)} `]) {
    assert.equal(validateTitle(raw), null, JSON.stringify(raw));
    assert.equal(validateTitle(raw, { fromModel: true }), null, `fromModel ${JSON.stringify(raw)}`);
  }
  for (const raw of [null, undefined, 42, {}, []]) assert.equal(validateTitle(raw), null, String(raw));
});

test('AC3 validateTitle fromModel strips one pair of quotes and one trailing period', () => {
  const m = raw => validateTitle(raw, { fromModel: true });
  assert.equal(m('"Quarterly estimates"'), 'Quarterly estimates');
  assert.equal(m('\u201cQuarterly estimates\u201d'), 'Quarterly estimates');
  assert.equal(m("'Quarterly estimates'"), 'Quarterly estimates');
  assert.equal(m('Quarterly estimates.'), 'Quarterly estimates');
  assert.equal(m('"Quarterly estimates."'), 'Quarterly estimates');
  assert.equal(m('Quarterly estimates..'), 'Quarterly estimates.', 'only one period');
  assert.equal(m('""Quarterly estimates""'), '"Quarterly estimates"', 'only one pair of quotes');
  assert.equal(m('  Quarterly   estimates  '), 'Quarterly estimates');
});

test('AC3 validateTitle fromModel allows at most 8 words', () => {
  const m = raw => validateTitle(raw, { fromModel: true });
  assert.equal(m('one two three four five six seven eight'), 'one two three four five six seven eight');
  assert.equal(m('one two three four five six seven eight nine'), null);
});

test('AC3 validateTitle fromModel rejects digits except a standalone 19xx or 20xx year', () => {
  const m = raw => validateTitle(raw, { fromModel: true });
  assert.equal(m('Planning the 2026 estimates'), 'Planning the 2026 estimates');
  assert.equal(m('Looking back at 1999'), 'Looking back at 1999');
  assert.equal(m('Spend 4000 on a car'), null);
  assert.equal(m('15 percent savings'), null);
  assert.equal(m('The 401k rollover'), null);
  assert.equal(m('Plans for 2126'), null);
  assert.equal(m('Estimates for 20261'), null);
  assert.equal(m('The 2026a plan'), null);
  assert.equal(m('Q4 estimates'), null);
});

test('AC3 validateTitle fromModel rejects money and quantities in any form', () => {
  const m = raw => validateTitle(raw, { fromModel: true });
  for (const raw of ['Save $2026 on taxes', 'Spend 2026 dollars', 'Save ten thousand dollars', 'A five percent raise',
    'Twenty percent withholding', 'Roughly 2k for the roof', 'Paying $ on the roof', 'Fifty grand bonus',
    'A million reasons to save', 'Paying half a million', 'Saving €2026 abroad', 'Fees at 2026%']) {
    assert.equal(m(raw), null, raw);
  }
  for (const ok of ['Planning the 2026 estimates', 'Quarterly estimate planning', 'Roth conversion before year end',
    'S corp payroll timing']) {
    assert.equal(m(ok), ok, ok);
  }
});

// ---------------------------------------------------------------- fallbackTitle

test('AC3 fallbackTitle decodes entities, strips tags and collapses whitespace', () => {
  assert.equal(fallbackTitle(SC, 'Can we afford a &lt;new&gt; car'), 'Can we afford a new car');
  assert.equal(fallbackTitle(SC, 'Is it &quot;safe&quot; &amp; sound'), 'Is it "safe" & sound');
  assert.equal(fallbackTitle(SC, '<p>Synthetic <b>bold</b> question</p>'), 'Synthetic bold question');
  assert.equal(fallbackTitle(SC, '  Synthetic \n\n  spaced\tquestion  '), 'Synthetic spaced question');
});

test('AC3 fallbackTitle never returns markup characters', () => {
  assert.equal(fallbackTitle(SC, '&lt;img src=x onerror=1&gt;'), 'img src=x onerror=1');
  const out = fallbackTitle(SC, 'Use &#96;code&#96; and &#123;braces&#125; and `literal`');
  assert.ok(typeof out === 'string' && out.length > 0, String(out));
  assert.ok(!/[<>{}`]/.test(out), out);
  assert.equal(fallbackTitle(SC, '&lt;&gt;'), null);
});

test('AC3 fallbackTitle removes figure tokens entirely so no amount appears', () => {
  const sc = { fig: { yearend_cash: { v: 123456, kind: 'a' }, fixed_fee: { v: 98000, kind: 'a' } }, names: {} };
  const out = fallbackTitle(sc, 'Can we spend {f:yearend_cash} on {fk:fixed_fee} things');
  assert.equal(out, 'Can we spend on things');
  assert.ok(!/\$|\d/.test(out), out);
  assert.doesNotThrow(() => fallbackTitle(SC, 'Ask {n:spouse} about {l:limit} and {p:rate}'));
  const other = fallbackTitle(SC, 'Ask {n:spouse} about it');
  assert.ok(other === null || typeof other === 'string');
});

test('AC3 fallbackTitle cuts to at most 48 characters at a word boundary, hard cutting one long word', () => {
  assert.equal(fallbackTitle(SC, 'How should we think about the quarterly estimates'), 'How should we think about the quarterly');
  const six = 'abcdefg abcdefg abcdefg abcdefg abcdefg abcdefg';
  assert.equal(six.length, 47);
  assert.equal(fallbackTitle(SC, `${six} hi`), six);
  const exact = `${six}h`;
  assert.equal(exact.length, 48);
  assert.equal(fallbackTitle(SC, exact), exact, 'exactly 48 characters is kept whole');
  const long = 'z'.repeat(60);
  assert.equal(fallbackTitle(SC, long), 'z'.repeat(48));
  assert.equal(fallbackTitle(SC, `${long} tail`), 'z'.repeat(48));
  for (const text of ['How should we think about the quarterly estimates', `${six} hi`, long]) {
    const out = fallbackTitle(SC, text);
    assert.ok(out.length <= 48, out);
    assert.ok(!out.endsWith(' ') && !out.endsWith('\u2026') && !out.endsWith('...'), `no trailing space or ellipsis: ${out}`);
  }
});

test('AC3 fallbackTitle is null for empty input', () => {
  for (const text of ['', '   ', '<p> </p>', '{f:yearend_cash}', null, undefined]) {
    assert.equal(fallbackTitle(SC, text), null, JSON.stringify(text));
  }
});

test('AC3 fallbackTitle works with a scenario built from a store', async () => {
  const t = await tempDb();
  try {
    const sc = buildScenario(t.db, { clock: CLOCK });
    assert.equal(fallbackTitle(sc, 'Synthetic store question'), 'Synthetic store question');
  } finally {
    t.close();
  }
});

// ---------------------------------------------------------------- nameThread

const FIRST_Q = 'Synthetic estimate question one';
const OTHER = ['Synthetic unrelated thread text', 'Synthetic unrelated thread reply'];

async function namingStore(t) {
  const s = await tempDb();
  t.after(async () => { s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  const db = s.db;
  const msg = db.prepare("INSERT INTO messages (conversation_key, role, text, refs, notice, ts) VALUES (?, ?, ?, '[]', ?, ?)");
  let n = 0;
  const add = (key, role, text, notice = 0) => msg.run(key, role, text, notice, `2026-11-05T09:00:${String(n++).padStart(2, '0')}.000Z`);
  const thread = createThread(db, '2026-11-05T09:00:00.000Z');
  const other = createThread(db, '2026-11-05T09:00:00.000Z');
  add(other.key, 'me', OTHER[0]);
  add(other.key, 'fathom', `<p>${OTHER[1]}</p>`);
  return { db, thread, other, add };
}

// Two full turns in `key`.
function twoTurns(add, key) {
  add(key, 'me', FIRST_Q);
  add(key, 'fathom', '<p>Synthetic estimate answer one</p>');
  add(key, 'me', 'Synthetic estimate question two');
  add(key, 'fathom', '<p>Synthetic estimate answer two</p>');
}

function stubEngine(reply, { on = true, during } = {}) {
  const calls = [];
  return {
    calls,
    engine: {
      mode: 'live',
      isOn: () => on,
      call: async req => {
        calls.push(req);
        if (during) during();
        if (reply instanceof Error) throw reply;
        return { text: typeof reply === 'string' ? reply : JSON.stringify(reply), costUsd: 0, model: TITLE_MODEL, toolResults: [] };
      },
    },
  };
}

const rowOf = (db, key) => ({ ...db.prepare('SELECT title, title_source FROM conversations WHERE key = ?').get(key) });

test('AC3 createThread makes an untitled ask thread', async t => {
  const { db, thread, other } = await namingStore(t);
  assert.match(thread.key, /^ask:[a-f0-9]{12}$/);
  assert.equal(thread.key, `ask:${thread.id}`);
  assert.notEqual(thread.key, other.key);
  assert.equal(thread.title, null);
  assert.equal(thread.turns, 0);
  assert.deepEqual(rowOf(db, thread.key), { title: null, title_source: null });
});

test('AC3 nameThread does nothing before two owner messages each have a reply', async t => {
  const { db, thread, add } = await namingStore(t);
  const { engine, calls } = stubEngine({ title: 'Quarterly estimate planning' });
  assert.equal(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), null, 'no messages');
  add(thread.key, 'me', FIRST_Q);
  add(thread.key, 'fathom', '<p>Synthetic estimate answer one</p>');
  assert.equal(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), null, 'one turn');
  add(thread.key, 'me', 'Synthetic estimate question two');
  assert.equal(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), null, 'second question has no reply yet');
  assert.equal(calls.length, 0);
  assert.deepEqual(rowOf(db, thread.key), { title: null, title_source: null });
});

test('AC3 nameThread sends one title call with only this thread and stores the model title', async t => {
  const { db, thread, add } = await namingStore(t);
  twoTurns(add, thread.key);
  const { engine, calls } = stubEngine({ title: 'Quarterly estimate planning' });
  const out = await nameThread({ db, engine, key: thread.key, clock: CLOCK });
  assert.ok(out != null, 'a named thread returns a result');
  assert.equal(calls.length, 1);
  const req = calls[0];
  assert.equal(req.purpose, 'title');
  const sent = JSON.stringify({ system: req.system, systemDynamic: req.systemDynamic, messages: req.messages });
  for (const text of [FIRST_Q, 'Synthetic estimate answer one', 'Synthetic estimate question two', 'Synthetic estimate answer two']) {
    assert.ok(sent.includes(text), `the prompt carries ${text}`);
  }
  for (const text of OTHER) assert.ok(!sent.includes(text), `nothing from another thread: ${text}`);
  assert.ok(!sent.includes('<p>'), 'messages are sent as plain text');
  assert.deepEqual(rowOf(db, thread.key), { title: 'Quarterly estimate planning', title_source: 'auto' });

  assert.equal(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), null, 'an auto-named thread is not renamed');
  assert.equal(calls.length, 1);
});

test('AC3 nameThread skips notices in the title prompt', async t => {
  const { db, thread, add } = await namingStore(t);
  add(thread.key, 'me', FIRST_Q);
  add(thread.key, 'fathom', '<p>Synthetic notice text for the prompt test</p>', 1);
  add(thread.key, 'me', 'Synthetic estimate question two');
  add(thread.key, 'fathom', '<p>Synthetic estimate answer two</p>');
  const { engine, calls } = stubEngine({ title: 'Quarterly estimate planning' });
  await nameThread({ db, engine, key: thread.key, clock: CLOCK });
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(calls[0].messages).includes('Synthetic notice text'), 'non-notice messages only');
});

test('AC3 an invalid model title falls back to the first owner message', async t => {
  const replies = [
    { title: '<b>Quarterly</b> estimates' },
    { title: 'Spend 4000 on the estimates' },
    { title: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty' },
    { title: 'Line one\nline two' },
    { title: '' },
    { name: 'Quarterly estimate planning' },
    'not json at all',
  ];
  for (const reply of replies) {
    const { db, thread, add } = await namingStore(t);
    twoTurns(add, thread.key);
    const { engine, calls } = stubEngine(reply);
    await nameThread({ db, engine, key: thread.key, clock: CLOCK });
    assert.equal(calls.length, 1);
    assert.deepEqual(rowOf(db, thread.key), { title: FIRST_Q, title_source: 'auto' }, JSON.stringify(reply));
  }
});

test('AC3 with the engine off nameThread makes no call and stores the fallback', async t => {
  const { db, thread, add } = await namingStore(t);
  twoTurns(add, thread.key);
  const { engine, calls } = stubEngine({ title: 'Quarterly estimate planning' }, { on: false });
  await nameThread({ db, engine, key: thread.key, clock: CLOCK });
  assert.equal(calls.length, 0);
  assert.deepEqual(rowOf(db, thread.key), { title: FIRST_Q, title_source: 'auto' });
});

test('AC3 an engine error such as over the cap stores the fallback', async t => {
  for (const error of [new BudgetExceededError(), new EngineOffError(), new Error('synthetic transport failure')]) {
    const { db, thread, add } = await namingStore(t);
    twoTurns(add, thread.key);
    const { engine, calls } = stubEngine(error);
    await nameThread({ db, engine, key: thread.key, clock: CLOCK });
    assert.equal(calls.length, 1);
    assert.deepEqual(rowOf(db, thread.key), { title: FIRST_Q, title_source: 'auto' }, error.name);
  }
});

test('AC3 a thread already named by hand is never sent for a title', async t => {
  const { db, thread, add } = await namingStore(t);
  twoTurns(add, thread.key);
  db.prepare("UPDATE conversations SET title = 'Synthetic manual name', title_source = 'manual' WHERE key = ?").run(thread.key);
  const { engine, calls } = stubEngine({ title: 'Quarterly estimate planning' });
  assert.equal(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), null);
  assert.equal(calls.length, 0);
  assert.deepEqual(rowOf(db, thread.key), { title: 'Synthetic manual name', title_source: 'manual' });
});

test('AC3 a thread whose first message has no usable title text is never sent for a title again', async t => {
  const { db, thread, add } = await namingStore(t);
  add(thread.key, 'me', '{f:yearend_cash}');
  add(thread.key, 'fathom', '<p>Synthetic estimate answer one</p>');
  add(thread.key, 'me', 'Synthetic estimate question two');
  add(thread.key, 'fathom', '<p>Synthetic estimate answer two</p>');
  const { engine, calls } = stubEngine({ title: '<b>Quarterly</b> estimates' });
  assert.equal(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), null);
  assert.equal(calls.length, 1);
  assert.deepEqual(rowOf(db, thread.key), { title: null, title_source: 'auto' });
  assert.equal(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), null);
  assert.equal(calls.length, 1, 'no further engine call');
  assert.deepEqual(rowOf(db, thread.key), { title: null, title_source: 'auto' });
});

test('AC3 a manual rename made while the title call runs survives', async t => {
  const { db, thread, add } = await namingStore(t);
  twoTurns(add, thread.key);
  const { engine, calls } = stubEngine({ title: 'Quarterly estimate planning' }, {
    during: () => db.prepare("UPDATE conversations SET title = 'Synthetic manual name', title_source = 'manual' WHERE key = ?").run(thread.key),
  });
  await nameThread({ db, engine, key: thread.key, clock: CLOCK });
  assert.equal(calls.length, 1);
  assert.deepEqual(rowOf(db, thread.key), { title: 'Synthetic manual name', title_source: 'manual' });
});

// ---------------------------------------------------------------- engine and pricing

// Haiku 5.5 rates verified on the pricing page at platform.claude.com/docs/en/about-claude/pricing
// on 2026-11-05: per million tokens, prompts up to 100,000 tokens: input 0.10, output 0.50, cache
// read 0.01, 5 minute cache write 0.125, 1 hour cache write 0.20; above 100,000: 0.50, 2.50, 0.05,
// 0.625, 1.00. The prompt size is input plus cache read plus cache write tokens.
test('AC3 TITLE_MODEL is Haiku 5.5 and its pricing has both prompt size rows', () => {
  assert.equal(TITLE_MODEL, 'claude-haiku-5-5');
  assert.equal(DEFAULT_MODEL, 'claude-opus-5-5');
  const cost = usage => usageCostUsd(TITLE_MODEL, usage);
  // Up to 100,000 prompt tokens.
  assert.ok(close(cost({ input_tokens: 100000, output_tokens: 1000000 }), 0.51), 'input 0.10 and output 0.50 per MTok');
  assert.ok(close(cost({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 100000 }), 0.001), 'cache read 0.01 per MTok');
  assert.ok(close(cost({ input_tokens: 10000, output_tokens: 10000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 20000,
    cache_creation: { ephemeral_5m_input_tokens: 10000, ephemeral_1h_input_tokens: 10000 } }), 0.00935), 'all five base rates');
  // Over 100,000 prompt tokens.
  assert.ok(close(cost({ input_tokens: 100001, output_tokens: 1000000 }), 0.0500005 + 2.5), 'one token over the line uses the over-100K row');
  assert.ok(close(cost({ input_tokens: 1000000, output_tokens: 1000000, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 2000000,
    cache_creation: { ephemeral_5m_input_tokens: 1000000, ephemeral_1h_input_tokens: 1000000 } }), 4.675), 'all five over-100K rates');
  assert.ok(close(cost({ input_tokens: 50000, output_tokens: 1000, cache_read_input_tokens: 60000 }), 0.0305),
    'input plus cache tokens over 100,000 use the over-100K row');
});

test('AC3 the fake engine accepts the title purpose and records it in the ledger', async () => {
  const ledger = createMemoryLedger();
  const engine = createEngine({ mode: 'fake', ledger });
  const res = await engine.call({ purpose: 'title', messages: [{ role: 'user', content: 'x' }], fake: [{ text: '{"title":"A"}', costUsd: 0.0001 }] });
  assert.equal(res.text, '{"title":"A"}');
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].purpose, 'title');
  assert.equal(ledger.entries[0].costUsd, 0.0001);
  await assert.rejects(engine.call({ purpose: 'bogus', messages: [{ role: 'user', content: 'x' }], fake: [{ text: '{}' }] }), TypeError);
});

test('AC3 a title call is refused when the engine is off or the cap is spent', async () => {
  const off = createEngine({ mode: 'off' });
  await assert.rejects(off.call({ purpose: 'title', messages: [{ role: 'user', content: 'x' }] }), EngineOffError);
  const now = () => new Date('2026-11-05T12:00:00.000Z');
  const ledger = createMemoryLedger([{ ts: '2026-11-05T09:00:00.000Z', purpose: 'chat', costUsd: 5 }]);
  const capped = createEngine({ mode: 'fake', ledger, capUsd: 1, now });
  await assert.rejects(capped.call({ purpose: 'title', messages: [{ role: 'user', content: 'x' }], fake: [{ text: '{"title":"A"}' }] }),
    BudgetExceededError);
  assert.equal(ledger.entries.length, 1, 'nothing was spent');
});

function stubFetch(responses) {
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const next = responses.shift();
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'synthetic' } });
  };
  return { bodies, restore: () => { globalThis.fetch = original; } };
}

const message = (model, text) => ({ id: 'msg_synthetic', type: 'message', role: 'assistant', model, stop_reason: 'end_turn',
  stop_sequence: null, content: [{ type: 'text', text }], usage: { input_tokens: 20, output_tokens: 5 } });

test('AC3 a live title call sends the Haiku model while extraction keeps the default model', async () => {
  const stub = stubFetch([message(TITLE_MODEL, '{"title":"Quarterly estimate planning"}'), message(DEFAULT_MODEL, '{"rows":[{"c":1}]}')]);
  const ledger = createMemoryLedger();
  const engine = createEngine({ mode: 'live', credential: 'synthetic-key', ledger });
  try {
    const res = await engine.call({ purpose: 'title', system: 'Name the conversation.', maxTokens: 64,
      messages: [{ role: 'user', content: 'Synthetic conversation text' }],
      schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } });
    assert.equal(JSON.parse(res.text).title, 'Quarterly estimate planning');
    assert.equal(stub.bodies[0].model, 'claude-haiku-5-5');
    assert.equal(ledger.entries[0].purpose, 'title');
    assert.equal(ledger.entries[0].model, TITLE_MODEL);
    assert.ok(close(ledger.entries[0].costUsd, usageCostUsd(TITLE_MODEL, { input_tokens: 20, output_tokens: 5 })), 'priced as Haiku');

    const schema = { type: 'object', properties: { c: { type: 'number' } }, required: ['c'], additionalProperties: false };
    assert.deepEqual(await engine.extract({ document: { type: 'text', text: 'Synthetic one.' }, schema, maxTokens: 64 }), [{ c: 1 }]);
    assert.equal(stub.bodies[1].model, 'claude-opus-5-5');
  } finally {
    stub.restore();
  }
});
