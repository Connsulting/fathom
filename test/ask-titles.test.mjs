// AC3: naming Ask threads. The pure helpers in src/api/threads.mjs (validateTitle, fallbackTitle,
// nameThread, createThread are its public API), the title purpose in the engine, the Haiku title
// model and its pricing. Every fixture is synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { validateTitle, checkTitle, fallbackTitle, nameThread, createThread, titleWords } from '../src/api/threads.mjs';
import { getSetting } from '../src/store/db.mjs';
import { createEngine, createMemoryLedger, EngineOffError, BudgetExceededError } from '../src/engine/index.mjs';
import { DEFAULT_MODEL, TITLE_MODEL, usageCostUsd } from '../src/engine/pricing.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { tempDb } from './helpers/server.mjs';
import { threadGet, ask } from '../src/api/handlers.mjs';

const SC = { fig: {}, names: {} };
const CLOCK = '2026-11-05';
const close = (a, b) => Math.abs(a - b) < 1e-9;
// A model-title check whose conversation holds every word of the title, so only the other rules can reject it.
const owned = raw => validateTitle(raw, { fromModel: true, conversationWords: new Set(titleWords(String(raw))) });
const words = text => new Set(titleWords(text));

// ---------------------------------------------------------------- validateTitle

test('AC3 validateTitle trims and collapses spaces', () => {
  assert.equal(validateTitle('  Quarterly   estimate  plan '), 'Quarterly estimate plan');
  assert.equal(validateTitle('Tax plan.'), 'Tax plan.', 'a rename keeps its period');
  assert.equal(validateTitle('x'.repeat(60)), 'x'.repeat(60));
  assert.equal(validateTitle('Plan for 2027 and the 401k'), 'Plan for 2027 and the 401k', 'a rename may carry digits');
  assert.equal(validateTitle('Planning the 2026 estimates'), 'Planning the 2026 estimates', 'a rename may carry a year');
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
  const m = owned;
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
  const m = owned;
  assert.equal(m('alpha bravo charlie delta echo foxtrot golf hotel'), 'alpha bravo charlie delta echo foxtrot golf hotel');
  assert.equal(m('alpha bravo charlie delta echo foxtrot golf hotel india'), null);
});

test('AC8 validateTitle accepts conversation numeric tokens and rejects absent tokens', () => {
  for (const title of ['Planning the 2026 estimates', 'Looking back at 1999', 'Q4 planning', 'The 401k rollover']) {
    assert.equal(owned(title), title);
    assert.equal(validateTitle(title, { fromModel: true, conversationWords: words('Synthetic retirement planning estimates') }), null);
  }
  assert.equal(owned('15 percent savings'), null);
});

test('AC3 validateTitle fromModel rejects money and quantities in any form', () => {
  const m = owned;
  for (const raw of ['Save $2026 on taxes', 'Spend 2026 dollars', 'Save ten thousand dollars', 'A five percent raise',
    'Twenty percent withholding', 'Roughly 2k for the roof', 'Paying $ on the roof', 'Fifty grand bonus',
    'A million reasons to save', 'Paying half a million', 'Saving €2026 abroad', 'Fees at 2026%']) {
    assert.equal(m(raw), null, raw);
  }
  for (const ok of ['Quarterly estimate planning', 'Roth conversion before year end',
    'S corp payroll timing', 'Planning next year estimates']) {
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
    const sc = await buildScenario(t.db, { clock: CLOCK });
    assert.equal(fallbackTitle(sc, 'Synthetic store question'), 'Synthetic store question');
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- nameThread

// Carries every content word of the stub model title 'Quarterly estimate planning'; under 48 characters so the fallback keeps it whole.
const FIRST_Q = 'Quarterly estimate planning question';
const OTHER = ['Synthetic unrelated thread text', 'Synthetic unrelated thread reply'];

async function namingStore(t) {
  const s = await tempDb();
  t.after(async () => { await s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  const db = s.db;
  const msg = db.prepare("INSERT INTO messages (conversation_key, role, text, refs, notice, ts) VALUES (?, ?, ?, '[]', ?, ?)");
  let n = 0;
  const add = async (key, role, text, notice = 0) => await msg.run(key, role, text, notice, `2026-11-05T09:00:${String(n++).padStart(2, '0')}.000Z`);
  const thread = await createThread(db, '2026-11-05T09:00:00.000Z');
  const other = await createThread(db, '2026-11-05T09:00:00.000Z');
  await add(other.key, 'me', OTHER[0]);
  await add(other.key, 'fathom', `<p>${OTHER[1]}</p>`);
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
        if (during) await during();
        if (reply instanceof Error) throw reply;
        return { text: typeof reply === 'string' ? reply : JSON.stringify(reply), costUsd: 0, model: TITLE_MODEL, toolResults: [] };
      },
    },
  };
}

const rowOf = async (db, key) => ({ ...await db.prepare('SELECT title, title_source FROM conversations WHERE key = ?').get(key) });

test('AC3 createThread makes an untitled ask thread', async t => {
  const { db, thread, other } = await namingStore(t);
  assert.match(thread.key, /^ask:[a-f0-9]{12}$/);
  assert.equal(thread.key, `ask:${thread.id}`);
  assert.notEqual(thread.key, other.key);
  assert.equal(thread.title, null);
  assert.equal(thread.turns, 0);
  assert.deepEqual(await rowOf(db, thread.key), { title: null, title_source: null });
});

test('AC3 nameThread does nothing before the first owner message has a reply', async t => {
  const { db, thread, add } = await namingStore(t);
  const { engine, calls } = stubEngine({ title: 'Quarterly estimate planning' });
  assert.equal(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), null, 'no messages');
  await add(thread.key, 'me', FIRST_Q);
  assert.equal(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), null, 'the first question has no reply yet');
  assert.equal(calls.length, 0);
  assert.deepEqual(await rowOf(db, thread.key), { title: null, title_source: null });
  await add(thread.key, 'fathom', '<p>Synthetic estimate answer one</p>');
  const out = await nameThread({ db, engine, key: thread.key, clock: CLOCK });
  assert.ok(out != null, 'one completed turn names the thread');
  assert.equal(calls.length, 1);
  assert.deepEqual(await rowOf(db, thread.key), { title: 'Quarterly estimate planning', title_source: 'auto' });
});

test('AC3 nameThread names a thread after its first completed turn', async t => {
  // Model title after one owner message and one reply.
  {
    const { db, thread, add } = await namingStore(t);
    await add(thread.key, 'me', FIRST_Q);
    await add(thread.key, 'fathom', '<p>Synthetic estimate answer one</p>');
    const { engine, calls } = stubEngine({ title: 'Quarterly estimate planning' });
    const out = await nameThread({ db, engine, key: thread.key, clock: CLOCK });
    assert.deepEqual(out, { title: 'Quarterly estimate planning', titleSource: 'auto', from: 'model' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].purpose, 'title');
    assert.deepEqual(await rowOf(db, thread.key), { title: 'Quarterly estimate planning', title_source: 'auto' });
    await add(thread.key, 'me', 'Synthetic estimate question two');
    await add(thread.key, 'fathom', '<p>Synthetic estimate answer two</p>');
    assert.equal(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), null, 'never renamed after the first naming');
    assert.equal(calls.length, 1);
  }
  // Fallback after one turn whose reply is a notice (the engine is off).
  {
    const { db, thread, add } = await namingStore(t);
    await add(thread.key, 'me', FIRST_Q);
    await add(thread.key, 'fathom', '<p>Synthetic engine off notice</p>', 1);
    const { engine, calls } = stubEngine({ title: 'Quarterly estimate planning' }, { on: false });
    const out = await nameThread({ db, engine, key: thread.key, clock: CLOCK });
    assert.deepEqual(out, { title: FIRST_Q, titleSource: 'auto', from: 'fallback' });
    assert.equal(calls.length, 0);
    assert.deepEqual(await rowOf(db, thread.key), { title: FIRST_Q, title_source: 'auto' });
  }
  // Fallback after one turn when the model title is invalid.
  {
    const { db, thread, add } = await namingStore(t);
    await add(thread.key, 'me', FIRST_Q);
    await add(thread.key, 'fathom', '<p>Synthetic estimate answer one</p>');
    const { engine, calls } = stubEngine({ title: 'Spend 4000 on the estimates' });
    const out = await nameThread({ db, engine, key: thread.key, clock: CLOCK });
    assert.deepEqual(out, { title: FIRST_Q, titleSource: 'auto', from: 'fallback' });
    assert.equal(calls.length, 2);
  }
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
  assert.deepEqual(await rowOf(db, thread.key), { title: 'Quarterly estimate planning', title_source: 'auto' });

  assert.equal(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), null, 'an auto-named thread is not renamed');
  assert.equal(calls.length, 1);
});

test('AC3 nameThread skips notices in the title prompt', async t => {
  const { db, thread, add } = await namingStore(t);
  await add(thread.key, 'me', FIRST_Q);
  await add(thread.key, 'fathom', '<p>Synthetic notice text for the prompt test</p>', 1);
  await add(thread.key, 'me', 'Synthetic estimate question two');
  await add(thread.key, 'fathom', '<p>Synthetic estimate answer two</p>');
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
    assert.equal(calls.length, 2);
    assert.deepEqual(await rowOf(db, thread.key), { title: FIRST_Q, title_source: 'auto' }, JSON.stringify(reply));
  }
});

test('AC3 with the engine off nameThread makes no call and stores the fallback', async t => {
  const { db, thread, add } = await namingStore(t);
  twoTurns(add, thread.key);
  const { engine, calls } = stubEngine({ title: 'Quarterly estimate planning' }, { on: false });
  await nameThread({ db, engine, key: thread.key, clock: CLOCK });
  assert.equal(calls.length, 0);
  assert.deepEqual(await rowOf(db, thread.key), { title: FIRST_Q, title_source: 'auto' });
});

test('AC3 an engine error such as over the cap stores the fallback', async t => {
  for (const error of [new BudgetExceededError(), new EngineOffError(), new Error('synthetic transport failure')]) {
    const { db, thread, add } = await namingStore(t);
    twoTurns(add, thread.key);
    const { engine, calls } = stubEngine(error);
    await nameThread({ db, engine, key: thread.key, clock: CLOCK });
    assert.equal(calls.length, 1);
    assert.deepEqual(await rowOf(db, thread.key), { title: FIRST_Q, title_source: 'auto' }, error.name);
  }
});

test('AC3 a thread already named by hand is never sent for a title', async t => {
  const { db, thread, add } = await namingStore(t);
  twoTurns(add, thread.key);
  await db.prepare("UPDATE conversations SET title = 'Synthetic manual name', title_source = 'manual' WHERE key = ?").run(thread.key);
  const { engine, calls } = stubEngine({ title: 'Quarterly estimate planning' });
  assert.equal(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), null);
  assert.equal(calls.length, 0);
  assert.deepEqual(await rowOf(db, thread.key), { title: 'Synthetic manual name', title_source: 'manual' });
});

test('AC3 a thread whose first message has no usable title text is never sent for a title again', async t => {
  const { db, thread, add } = await namingStore(t);
  await add(thread.key, 'me', '{f:yearend_cash}');
  await add(thread.key, 'fathom', '<p>Synthetic estimate answer one</p>');
  await add(thread.key, 'me', 'Synthetic estimate question two');
  await add(thread.key, 'fathom', '<p>Synthetic estimate answer two</p>');
  const { engine, calls } = stubEngine({ title: '<b>Quarterly</b> estimates' });
  assert.equal(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), null);
  assert.equal(calls.length, 2);
  assert.deepEqual(await rowOf(db, thread.key), { title: null, title_source: 'auto' });
  assert.equal(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), null);
  assert.equal(calls.length, 2, 'no further engine call');
  assert.deepEqual(await rowOf(db, thread.key), { title: null, title_source: 'auto' });
});

test('AC3 a manual rename made while the title call runs survives', async t => {
  const { db, thread, add } = await namingStore(t);
  twoTurns(add, thread.key);
  const { engine, calls } = stubEngine({ title: 'Quarterly estimate planning' }, {
    during: async () => await db.prepare("UPDATE conversations SET title = 'Synthetic manual name', title_source = 'manual' WHERE key = ?").run(thread.key),
  });
  await nameThread({ db, engine, key: thread.key, clock: CLOCK });
  assert.equal(calls.length, 1);
  assert.deepEqual(await rowOf(db, thread.key), { title: 'Synthetic manual name', title_source: 'manual' });
});

test('AC3 a model title with words the owner never typed is accepted when the conversation has a topic word', async t => {
  const said = 'How should we plan our spending';
  const conversationWords = words(`${said} Synthetic spending answer`);
  assert.equal(validateTitle('Retirement portfolio target from spending', { fromModel: true, conversationWords }),
    'Retirement portfolio target from spending');
  const { db, thread, add } = await namingStore(t);
  await add(thread.key, 'me', said);
  await add(thread.key, 'fathom', '<p>Synthetic spending answer</p>');
  const { engine, calls } = stubEngine({ title: 'Retirement portfolio target from spending' });
  const out = await nameThread({ db, engine, key: thread.key, clock: CLOCK });
  assert.deepEqual(out, { title: 'Retirement portfolio target from spending', titleSource: 'auto', from: 'model' });
  assert.equal(calls.length, 1);
  assert.deepEqual(await rowOf(db, thread.key), { title: 'Retirement portfolio target from spending', title_source: 'auto' });
});

test('AC3 conversation words come from reply text as well as owner text', async t => {
  const { db, thread, add } = await namingStore(t);
  await add(thread.key, 'me', 'Synthetic opening question');
  await add(thread.key, 'fathom', '<p>Synthetic mortgage payoff answer</p>');
  const { engine } = stubEngine({ title: 'Mortgage payoff' });
  const out = await nameThread({ db, engine, key: thread.key, clock: CLOCK });
  assert.deepEqual(out, { title: 'Mortgage payoff', titleSource: 'auto', from: 'model' });
});

test('AC3 quarterly in the conversation does not admit quarter in a model title', () => {
  const conversationWords = words('Our quarterly estimates');
  assert.equal(validateTitle('Quarter estimates', { fromModel: true, conversationWords }), null, 'quarter is a money word');
  assert.equal(validateTitle('Quarterly estimates', { fromModel: true, conversationWords }), 'Quarterly estimates');
});

test('AC3 fraction and multiplier words never pass in a model title, even in the conversation', async t => {
  const conversationWords = words('How much income should I save this quarter? What about taxes?');
  assert.equal(validateTitle('Save a quarter of income', { fromModel: true, conversationWords }), null);
  assert.equal(validateTitle('Save the majority of income', { fromModel: true, conversationWords: words('Save the majority of income') }), null);
  assert.equal(validateTitle('Double the savings', { fromModel: true, conversationWords: words('Double the savings') }), null);
  for (const w of ['quarter', 'quarters', 'third', 'thirds', 'fourth', 'fourths', 'fifth', 'fifths', 'sixth', 'seventh', 'eighth', 'ninth',
    'tenth', 'tenths', 'halves', 'double', 'triple', 'quadruple', 'twice', 'thrice', 'fraction', 'majority', 'minority', 'most', 'bulk']) {
    assert.equal(validateTitle(`Save ${w} income`, { fromModel: true, conversationWords: words(`Save ${w} income`) }), null, w);
  }
  const live = words('Our quarterly estimates');
  assert.equal(validateTitle('Quarterly estimates', { fromModel: true, conversationWords: live }), 'Quarterly estimates');
  const { db, thread, add } = await namingStore(t);
  const first = 'How much income should I save this quarter?';
  await add(thread.key, 'me', first);
  await add(thread.key, 'fathom', '<p>Synthetic estimate answer one</p>');
  await add(thread.key, 'me', 'What about taxes?');
  await add(thread.key, 'fathom', '<p>Synthetic estimate answer two</p>');
  const { engine, calls } = stubEngine({ title: 'Save a quarter of income' });
  await nameThread({ db, engine, key: thread.key, clock: CLOCK });
  assert.equal(calls.length, 2);
  assert.deepEqual(await rowOf(db, thread.key), { title: fallbackTitle(SC, first), title_source: 'auto' });
});

test('AC3 titleWords normalizes case, plurals, possessives and hyphens', () => {
  assert.deepEqual(titleWords("Owner's S-corp Taxes, estimates!"), ['owner', 's', 'corp', 'tax', 'estimate']);
});

test('AC3 stopwords in a model title are ignored and one shared content word keeps it on topic', () => {
  const conversationWords = words('estimates');
  assert.equal(validateTitle('The estimates', { fromModel: true, conversationWords }), 'The estimates');
  assert.equal(validateTitle('The estimates for our plan', { fromModel: true, conversationWords }), 'The estimates for our plan',
    'words outside the conversation are fine while one content word is shared');
  assert.equal(validateTitle('The plan for our garden', { fromModel: true, conversationWords }), null, 'no shared content word');
  assert.equal(validateTitle('The estimates', { fromModel: true }), null, 'no conversationWords means nothing is on topic');
});

// ---------------------------------------------------------------- checkTitle reasons

test('AC3 checkTitle returns the clean title or a reason code', () => {
  const cw = words('Synthetic budget spending estimates alpha bravo charlie delta echo foxtrot golf hotel india tax plan');
  const check = raw => checkTitle(raw, { fromModel: true, conversationWords: cw });
  assert.deepEqual(check('"Budget spending."'), { title: 'Budget spending' });
  assert.deepEqual(check('Retirement tax plan'), { title: 'Retirement tax plan' });
  const reasons = [
    ['Planning the 2026 estimates', 'number'],
    ['Save $ on taxes', 'number'],
    ['Paying € on the plan', 'number'],
    ['Fees at % of plan', 'number'],
    ['Half the budget', 'money_word'],
    ['Dollars saved', 'money_word'],
    ['Budget spending a quarter', 'money_word'],
    ['alpha bravo charlie delta echo foxtrot golf hotel india', 'too_many_words'],
    ['x'.repeat(61), 'too_long'],
    ['<b>Budget</b> spending', 'markup'],
    ['Budget {spending}', 'markup'],
    ['Budget `spending`', 'markup'],
    ['Garden hose watering', 'off_topic'],
    ['', 'empty'],
    ['   ', 'empty'],
    [42, 'not_text'],
    [null, 'not_text'],
    [undefined, 'not_text'],
    [{}, 'not_text'],
  ];
  for (const [raw, reason] of reasons) assert.deepEqual(check(raw), { reason }, JSON.stringify(raw));
});

test('AC3 checkTitle without fromModel is the rename path and applies no model rules', () => {
  assert.deepEqual(checkTitle('Plan for 2027 and the 401k'), { title: 'Plan for 2027 and the 401k' });
  assert.deepEqual(checkTitle('Garden hose watering'), { title: 'Garden hose watering' }, 'no topic rule for renames');
  assert.deepEqual(checkTitle('x'.repeat(61)), { reason: 'too_long' });
  assert.deepEqual(checkTitle('<b>Tax</b>'), { reason: 'markup' });
  assert.deepEqual(checkTitle('Tax\nplan'), { reason: 'not_text' });
});

// ---------------------------------------------------------------- rejection record

function seqEngine(replies, { on = true } = {}) {
  const calls = [];
  const state = { on };
  return {
    calls,
    state,
    engine: {
      mode: 'live',
      isOn: () => state.on,
      call: async req => {
        calls.push(req);
        const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
        if (reply instanceof Error) throw reply;
        return { text: typeof reply === 'string' ? reply : JSON.stringify(reply), costUsd: 0, model: TITLE_MODEL, toolResults: [] };
      },
    },
  };
}

const titleCalls = calls => calls.filter(c => c.purpose === 'title').length;
const rejects = async db => await getSetting(db, 'ask.titleRejects', null);

test('AC8: model titles keep conversation identifiers and refuse invented numbers or money', () => {
  const conversationWords = words('Discuss 529 contributions, the 401(k), estimates for 2026, and account 1234.');
  for (const title of ['529 contributions', '401(k) contributions', '2026 estimates', 'Account 1234']) {
    assert.deepEqual(checkTitle(title, { fromModel: true, conversationWords }), { title });
  }
  for (const title of ['$4,000 plan', '529 contributions 7%', '529 dollar contributions', '2027 estimates', 'Account 123', 'Account 91234']) {
    assert.ok(checkTitle(title, { fromModel: true, conversationWords }).reason, title);
  }
});

test('AC9: rejected title retries once with a plain reason before falling back', async t => {
  const { db, thread, add } = await namingStore(t);
  await add(thread.key, 'me', 'Have I made 529 contributions in 2026?');
  await add(thread.key, 'fathom', '<p>The 529 contributions are stored.</p>');
  const { engine, calls } = seqEngine([{ title: '$4,000 plan' }, { title: '529 contributions' }]);
  assert.deepEqual(await nameThread({ db, engine, key: thread.key }), { title: '529 contributions', titleSource: 'auto', from: 'model' });
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages.at(-1).content, /currency|percent|numbers.*conversation/i);
  assert.deepEqual(await rejects(db), { number: 1 });
  const other = await createThread(db, '2026-11-05T09:00:00Z');
  twoTurns(add, other.key);
  const invalid = seqEngine([{ title: '$4,000 plan' }]);
  assert.equal((await nameThread({ db, engine: invalid.engine, key: other.key })).from, 'fallback');
  assert.equal(invalid.calls.length, 2);
});

test('AC10: opening an old fallback thread after many turns repairs its title only once', async t => {
  const { db, thread, add } = await namingStore(t);
  for (let i = 0; i < 4; i++) {
    await add(thread.key, 'me', 'Have I made 529 contributions in 2026?');
    await add(thread.key, 'fathom', '<p>The 529 contributions are stored.</p>');
  }
  await db.prepare("UPDATE conversations SET title = ?, title_source = 'auto' WHERE key = ?").run('Have I made 529 contributions in 2026?', thread.key);
  const { engine, calls } = seqEngine([{ title: '529 contributions' }]);
  const ctx = { db, engine, config: {}, params: { id: thread.id } };
  const opened = await threadGet(ctx);
  assert.equal(opened.thread.title, '529 contributions');
  assert.equal(opened.messages.length, 8);
  await threadGet(ctx);
  assert.equal(calls.length, 1);
});

test('AC10: rejected repair is consumed once and manual names survive opening', async t => {
  const { db, thread, add } = await namingStore(t);
  twoTurns(add, thread.key);
  await db.prepare("UPDATE conversations SET title = ?, title_source = 'auto' WHERE key = ?").run(FIRST_Q, thread.key);
  const { engine, calls } = seqEngine([{ title: '$4,000 plan' }]);
  const ctx = { db, engine, config: {}, params: { id: thread.id } };
  assert.equal((await threadGet(ctx)).thread.title, FIRST_Q);
  assert.equal(calls.length, 2, 'one repair attempt, with one correction retry');
  await threadGet(ctx);
  assert.equal(calls.length, 2, 'opening again cannot repeat the consumed repair');
  await db.prepare("UPDATE conversations SET title = 'Manual 529 plan', title_source = 'manual' WHERE key = ?").run(thread.key);
  assert.equal((await threadGet(ctx)).thread.title, 'Manual 529 plan');
  assert.equal(calls.length, 2);
});

test('AC10: answering an old fallback thread also repairs its title', async t => {
  const { db, thread, add } = await namingStore(t);
  for (let i = 0; i < 3; i++) twoTurns(add, thread.key);
  await db.prepare("UPDATE conversations SET title = ?, title_source = 'auto' WHERE key = ?").run(FIRST_Q, thread.key);
  const { engine, calls } = seqEngine([{ title: 'Quarterly estimate planning' }]);
  await ask({ db, engine, config: {}, body: { key: thread.key, text: 'Continue the estimate plan.' },
    answerer: { answer: async () => ({ paragraphs: ['The estimate plan is available.'], refs: [] }) } });
  assert.equal((await rowOf(db, thread.key)).title, 'Quarterly estimate planning');
  assert.equal(calls.length, 1);
});

test('AC3 a rejected model title records only its reason in ask.titleRejects', async t => {
  const cases = [
    [{ title: 'Zebra 4000 plan' }, 'number', 'Zebra'],
    [{ title: 'Zebra half plan' }, 'money_word', 'Zebra'],
    [{ title: 'zebra giraffe lion tiger bear wolf fox deer moose' }, 'too_many_words', 'giraffe'],
    [{ title: 'Zebra <b>plan</b>' }, 'markup', 'Zebra'],
    [{ title: 'Zebra giraffe watering' }, 'off_topic', 'Zebra'],
    [{ title: '' }, 'empty', null],
    [{ title: 42 }, 'not_text', null],
    [{ title: 'z'.repeat(61) }, 'too_long', 'zzzzzz'],
  ];
  for (const [reply, reason, leak] of cases) {
    const { db, thread, add } = await namingStore(t);
    twoTurns(add, thread.key);
    const { engine } = seqEngine([reply]);
    await nameThread({ db, engine, key: thread.key, clock: CLOCK });
    assert.deepEqual(await rowOf(db, thread.key), { title: FIRST_Q, title_source: 'auto' }, 'falls back');
    assert.deepEqual(await rejects(db), { [reason]: 2 }, reason);
    if (leak) assert.ok(!JSON.stringify(await rejects(db)).includes(leak), `no title text stored for ${reason}`);
  }
});

test('AC3 unparseable title JSON records unparsable and a thrown call records call_failed', async t => {
  for (const reply of ['not json at all', { name: 'Quarterly estimate planning' }, '[1,2]', 'null']) {
    const { db, thread, add } = await namingStore(t);
    twoTurns(add, thread.key);
    await nameThread({ db, engine: seqEngine([reply]).engine, key: thread.key, clock: CLOCK });
    assert.deepEqual(await rejects(db), { unparsable: 2 }, JSON.stringify(reply));
    assert.deepEqual(await rowOf(db, thread.key), { title: FIRST_Q, title_source: 'auto' });
  }
  const { db, thread, add } = await namingStore(t);
  twoTurns(add, thread.key);
  await nameThread({ db, engine: seqEngine([new Error('synthetic transport failure')]).engine, key: thread.key, clock: CLOCK });
  assert.deepEqual(await rejects(db), { call_failed: 1 });
  assert.ok(!JSON.stringify(await rejects(db)).includes('synthetic transport failure'), 'no error text stored');
  assert.deepEqual(await rowOf(db, thread.key), { title: FIRST_Q, title_source: 'auto' });
});

test('AC3 ask.titleRejects counts repeats per reason and an accepted title or a disabled engine records nothing', async t => {
  const { db, thread, add } = await namingStore(t);
  assert.equal(await rejects(db), null, 'nothing recorded yet');
  twoTurns(add, thread.key);
  await nameThread({ db, engine: seqEngine([{ title: 'Spend 4000 on the estimates' }]).engine, key: thread.key, clock: CLOCK });
  assert.deepEqual(await rejects(db), { number: 2 });
  const second = await createThread(db, '2026-11-05T09:00:00.000Z');
  twoTurns(add, second.key);
  await nameThread({ db, engine: seqEngine([{ title: 'Spend 5000 on the estimates' }]).engine, key: second.key, clock: CLOCK });
  assert.deepEqual(await rejects(db), { number: 4 }, 'incremented');
  const third = await createThread(db, '2026-11-05T09:00:00.000Z');
  twoTurns(add, third.key);
  await nameThread({ db, engine: seqEngine([{ title: 'Half the estimates' }]).engine, key: third.key, clock: CLOCK });
  assert.deepEqual(await rejects(db), { number: 4, money_word: 2 });
  const fourth = await createThread(db, '2026-11-05T09:00:00.000Z');
  twoTurns(add, fourth.key);
  await nameThread({ db, engine: seqEngine([{ title: 'Quarterly estimate planning' }]).engine, key: fourth.key, clock: CLOCK });
  const fifth = await createThread(db, '2026-11-05T09:00:00.000Z');
  twoTurns(add, fifth.key);
  await nameThread({ db, engine: seqEngine([{ title: 'Spend 4000' }], { on: false }).engine, key: fifth.key, clock: CLOCK });
  assert.deepEqual(await rejects(db), { number: 4, money_word: 2 }, 'accepted and engine-off threads add nothing');
});

// ---------------------------------------------------------------- one fallback repair after naming

test('AC10 a fallback-titled thread is repaired on its next answered turn and an accepted title replaces it', async t => {
  const { db, thread, add } = await namingStore(t);
  await add(thread.key, 'me', FIRST_Q);
  await add(thread.key, 'fathom', '<p>Synthetic estimate answer one</p>');
  const { engine, calls } = seqEngine([{ title: 'Spend 4000 on the estimates' }, { title: 'Spend 4000 on the estimates' }, { title: 'Quarterly estimate planning' }]);
  assert.deepEqual(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), { title: FIRST_Q, titleSource: 'auto', from: 'fallback' });
  assert.equal(titleCalls(calls), 2);
  await add(thread.key, 'me', 'Synthetic estimate question two');
  await add(thread.key, 'fathom', '<p>Synthetic estimate answer two</p>');
  const out = await nameThread({ db, engine, key: thread.key, clock: CLOCK });
  assert.deepEqual(out, { title: 'Quarterly estimate planning', titleSource: 'auto', from: 'model' });
  assert.equal(titleCalls(calls), 3, 'exactly one retry call');
  assert.deepEqual(await rowOf(db, thread.key), { title: 'Quarterly estimate planning', title_source: 'auto' });
  await add(thread.key, 'me', 'Synthetic estimate question three');
  await add(thread.key, 'fathom', '<p>Synthetic estimate answer three</p>');
  assert.equal(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), null);
  assert.equal(titleCalls(calls), 3, 'no further title call after the third turn');
});

test('AC3 a rejected retry keeps the fallback, records the reason and is not tried again', async t => {
  const { db, thread, add } = await namingStore(t);
  await add(thread.key, 'me', FIRST_Q);
  await add(thread.key, 'fathom', '<p>Synthetic estimate answer one</p>');
  const { engine, calls } = seqEngine([{ title: 'Spend 4000 on the estimates' }, { title: 'Spend 4000 on the estimates' }, { title: 'Half the estimates' }, { title: 'Half the estimates' }, { title: 'Quarterly estimate planning' }]);
  await nameThread({ db, engine, key: thread.key, clock: CLOCK });
  await add(thread.key, 'me', 'Synthetic estimate question two');
  await add(thread.key, 'fathom', '<p>Synthetic estimate answer two</p>');
  assert.equal(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), null);
  assert.equal(titleCalls(calls), 4);
  assert.deepEqual(await rowOf(db, thread.key), { title: FIRST_Q, title_source: 'auto' });
  assert.deepEqual(await rejects(db), { number: 2, money_word: 2 });
  await add(thread.key, 'me', 'Synthetic estimate question three');
  await add(thread.key, 'fathom', '<p>Synthetic estimate answer three</p>');
  assert.equal(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), null);
  assert.equal(titleCalls(calls), 4, 'the retry happens once');
  assert.deepEqual(await rowOf(db, thread.key), { title: FIRST_Q, title_source: 'auto' });
});

test('AC3 a thread whose first title came from the model gets no retry at turn 2', async t => {
  const { db, thread, add } = await namingStore(t);
  await add(thread.key, 'me', FIRST_Q);
  await add(thread.key, 'fathom', '<p>Synthetic estimate answer one</p>');
  const { engine, calls } = seqEngine([{ title: 'Quarterly estimate planning' }, { title: 'Estimate planning question' }]);
  assert.equal((await nameThread({ db, engine, key: thread.key, clock: CLOCK })).from, 'model');
  await add(thread.key, 'me', 'Synthetic estimate question two');
  await add(thread.key, 'fathom', '<p>Synthetic estimate answer two</p>');
  assert.equal(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), null);
  assert.equal(titleCalls(calls), 1);
  assert.deepEqual(await rowOf(db, thread.key), { title: 'Quarterly estimate planning', title_source: 'auto' });
});

test('AC3 a manual rename before turn 2 prevents the retry', async t => {
  const { db, thread, add } = await namingStore(t);
  await add(thread.key, 'me', FIRST_Q);
  await add(thread.key, 'fathom', '<p>Synthetic estimate answer one</p>');
  const { engine, calls } = seqEngine([{ title: 'Spend 4000 on the estimates' }, { title: 'Spend 4000 on the estimates' }, { title: 'Quarterly estimate planning' }]);
  await nameThread({ db, engine, key: thread.key, clock: CLOCK });
  await db.prepare("UPDATE conversations SET title = 'Synthetic manual name', title_source = 'manual' WHERE key = ?").run(thread.key);
  await add(thread.key, 'me', 'Synthetic estimate question two');
  await add(thread.key, 'fathom', '<p>Synthetic estimate answer two</p>');
  assert.equal(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), null);
  assert.equal(titleCalls(calls), 2);
  assert.deepEqual(await rowOf(db, thread.key), { title: 'Synthetic manual name', title_source: 'manual' });
});

test('AC3 a manual rename made while the retry call runs survives', async t => {
  const { db, thread, add } = await namingStore(t);
  await add(thread.key, 'me', FIRST_Q);
  await add(thread.key, 'fathom', '<p>Synthetic estimate answer one</p>');
  const seq = seqEngine([{ title: 'Spend 4000 on the estimates' }, { title: 'Spend 4000 on the estimates' }, { title: 'Quarterly estimate planning' }]);
  await nameThread({ db, engine: seq.engine, key: thread.key, clock: CLOCK });
  await add(thread.key, 'me', 'Synthetic estimate question two');
  await add(thread.key, 'fathom', '<p>Synthetic estimate answer two</p>');
  const racing = { ...seq.engine, call: async req => {
    const res = await seq.engine.call(req);
    await db.prepare("UPDATE conversations SET title = 'Synthetic manual name', title_source = 'manual' WHERE key = ?").run(thread.key);
    return res;
  } };
  await nameThread({ db, engine: racing, key: thread.key, clock: CLOCK });
  assert.deepEqual(await rowOf(db, thread.key), { title: 'Synthetic manual name', title_source: 'manual' });
});

test('AC3 no retry call when the engine is off at turn 2 or the first title was null', async t => {
  {
    const { db, thread, add } = await namingStore(t);
    await add(thread.key, 'me', FIRST_Q);
    await add(thread.key, 'fathom', '<p>Synthetic estimate answer one</p>');
    const { engine, calls, state } = seqEngine([{ title: 'Spend 4000 on the estimates' }, { title: 'Spend 4000 on the estimates' }, { title: 'Quarterly estimate planning' }]);
    await nameThread({ db, engine, key: thread.key, clock: CLOCK });
    state.on = false;
    await add(thread.key, 'me', 'Synthetic estimate question two');
    await add(thread.key, 'fathom', '<p>Synthetic estimate answer two</p>');
    assert.equal(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), null);
    assert.equal(titleCalls(calls), 2);
    assert.deepEqual(await rowOf(db, thread.key), { title: FIRST_Q, title_source: 'auto' });
  }
  {
    const { db, thread, add } = await namingStore(t);
    await add(thread.key, 'me', '{f:yearend_cash}');
    await add(thread.key, 'fathom', '<p>Synthetic estimate answer one</p>');
    const { engine, calls } = seqEngine([{ title: '<b>Quarterly</b> estimates' }, { title: '<b>Quarterly</b> estimates' }, { title: 'Quarterly estimate planning' }]);
    await nameThread({ db, engine, key: thread.key, clock: CLOCK });
    await add(thread.key, 'me', 'Synthetic estimate question two');
    await add(thread.key, 'fathom', '<p>Synthetic estimate answer two</p>');
    assert.equal(await nameThread({ db, engine, key: thread.key, clock: CLOCK }), null);
    assert.equal(titleCalls(calls), 2, 'a NULL title is never retried');
    assert.deepEqual(await rowOf(db, thread.key), { title: null, title_source: 'auto' });
  }
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
  await assert.rejects(await engine.call({ purpose: 'bogus', messages: [{ role: 'user', content: 'x' }], fake: [{ text: '{}' }] }), TypeError);
});

test('AC3 a title call is refused when the engine is off or the cap is spent', async () => {
  const off = createEngine({ mode: 'off' });
  await assert.rejects(await off.call({ purpose: 'title', messages: [{ role: 'user', content: 'x' }] }), EngineOffError);
  const now = () => new Date('2026-11-05T12:00:00.000Z');
  const ledger = createMemoryLedger([{ ts: '2026-11-05T09:00:00.000Z', purpose: 'chat', costUsd: 5 }]);
  const capped = createEngine({ mode: 'fake', ledger, capUsd: 1, now });
  await assert.rejects(await capped.call({ purpose: 'title', messages: [{ role: 'user', content: 'x' }], fake: [{ text: '{"title":"A"}' }] }),
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
