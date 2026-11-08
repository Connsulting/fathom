// H4 AC2: a scripted Ask answer over a truncated result discloses the truncation.
// a. transactions.search with a small explicit limit on the demo store is truncated and not
//    continued: provenance.leftOut says "Showed the first N of M matching transactions." with the
//    result's own counts, and the Ask renderer shows that line with no control.
// b. A default-limit transactions.search continues on its own up to CONTINUE_CAP rows; leftOut
//    discloses only when the merged result is still truncated.
// c. A non-paginated truncated result (the engine wrapper marks spending.total truncated; spending
//    is a read tool whose total operation takes no required arguments) discloses the generic line.
// Plus direct checks of continueRead and leftOutOf. Every fixture is synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { seedDemo } from '../demo/seed.mjs';
import { loadConfig } from '../src/config.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { createLivePacks } from '../src/packs/live.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { callTool } from '../src/tools/index.mjs';
import { tempDb } from './helpers/server.mjs';
import { CONTINUE_CAP, leftOutOf, continueRead } from '../src/api/left-out.mjs';
import { useKit, messageBodyHtml } from '../web/horizon/screens/ask-blocks.js';

const esc = s => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
useKit({ esc, money: n => String(n), registerFigures: () => {} });

const THREAD = 'ask:0123456789ab';
const ANSWER = 'Here is what I found.';
const num = n => n.toLocaleString('en-US');
const searchLine = (shown, total) => `Showed the first ${num(shown)} of ${num(total)} matching transactions.`;

async function demo(t) {
  const s = await tempDb();
  t.after(async () => { s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  seedDemo(s.db);
  const config = loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'fake', FATHOM_FAKE_STREAM_MS: '0' });
  const engine = createRuntimeEngine({ db: s.db, config });
  const packs = createLivePacks(s.db, { dataDir: s.dataDir });
  packs.refresh();
  return { s, engine, packs, root: s.dataDir };
}

// One scripted Ask: the first call runs `call` then answers; a corrective call only answers.
// `mark(name, result, args)` may rewrite a tool's result on its way to the model.
async function ask(t, call, mark) {
  const { s, engine, packs, root } = await demo(t);
  const results = [];
  let n = 0;
  const wrapped = { ...engine, mode: engine.mode, isOn: () => engine.isOn(), call: async req => {
    const tools = mark ? req.tools.map(tool => tool.kind !== 'read' ? tool : { ...tool,
      async handler(args, ctx) { return mark(tool.name, await tool.handler(args, ctx), args); } }) : req.tools;
    const fake = n++ === 0 ? [{ toolCalls: [call] }, { text: ANSWER }] : [{ text: ANSWER }];
    const res = await engine.call({ ...req, tools, fake });
    results.push(...(res.toolResults || []));
    return res;
  } };
  const reply = await createLiveAnswerer({ engine: wrapped, packs, root, services: { engine: wrapped, config: { dataDir: root } } })
    .answer({ db: s.db, key: THREAD, text: 'Show me my recent transactions.' });
  return { reply, results, s };
}

const truncation = reply => (reply.provenance.leftOut ?? []).filter(e => e.code === 'truncated');

function assertRendered(reply, text) {
  const html = messageBodyHtml({ id: 'm1', html: '<p>x</p>', provenance: reply.provenance });
  const note = /<div[^>]*\bdata-left-out\b[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[0];
  assert.ok(note, 'the "What this leaves out" note renders');
  assert.match(note, /What this leaves out/);
  const line = new RegExp(`<p data-left-out-code="truncated">([^<]*)</p>`).exec(note);
  assert.ok(line, `the truncation line renders: ${note}`);
  assert.equal(line[1].trim(), esc(text), 'the line is the plain truncation text');
  assert.doesNotMatch(note, /data-tax-gap-fix|data-goal-fix/, 'a truncation has no control');
}

test('H4-AC2a a search with a small explicit limit is truncated, not continued, and the answer says how much it showed', async t => {
  const { reply, results } = await ask(t, { name: 'transactions', args: { operation: 'search', limit: 5 } });
  const read = results.find(r => r.name === 'transactions' && !r.isError);
  assert.ok(read, 'transactions.search ran');
  assert.equal(read.result.rows.length, 5, 'an explicit limit is not continued');
  assert.equal(read.result.truncated, true);
  assert.ok(read.result.total > 5, `the demo store has more matches than the limit: ${read.result.total}`);
  const lines = truncation(reply);
  assert.equal(lines.length, 1, `one truncation entry: ${JSON.stringify(reply.provenance.leftOut)}`);
  assert.deepEqual(lines[0], { code: 'truncated', text: searchLine(read.result.rows.length, read.result.total), fix: null });
  assertRendered(reply, lines[0].text);
});

test('H4-AC2b a default-limit search continues on its own, and discloses only what is still left out', async t => {
  const { reply, results, s } = await ask(t, { name: 'transactions', args: { operation: 'search' } });
  const read = results.find(r => r.name === 'transactions' && !r.isError);
  assert.ok(read, 'transactions.search ran');
  const ctx = { db: s.db, dataDir: s.dataDir, now: new Date().toISOString() };
  const direct = await callTool('transactions', { operation: 'search', limit: CONTINUE_CAP }, ctx);
  const total = direct.total;
  assert.ok(total > 50, `the demo store has more matches than one default page: ${total}`);
  assert.equal(read.result.total, total, 'the merged result keeps the total');
  assert.equal(read.result.rows.length, Math.min(total, CONTINUE_CAP), 'the search continued past the first page');
  assert.ok(read.result.rows.length > 50);
  assert.deepEqual(read.result.rows.map(r => r.id), direct.rows.map(r => r.id), 'the pages join in order with no repeats');
  assert.equal(read.result.truncated, total > CONTINUE_CAP);
  const lines = truncation(reply);
  if (total > CONTINUE_CAP) {
    assert.deepEqual(lines, [{ code: 'truncated', text: searchLine(CONTINUE_CAP, total), fix: null }]);
    assertRendered(reply, lines[0].text);
  } else {
    assert.deepEqual(lines, [], 'every match was read, so nothing is disclosed');
  }
});

test('H4-AC2c a non-paginated truncated result discloses the generic line', async t => {
  const call = { name: 'spending', args: { operation: 'total' } };
  const { reply, results } = await ask(t, call, (name, result, args) =>
    name === 'spending' && args.operation === 'total' ? { ...result, truncated: true } : result);
  const read = results.find(r => r.name === 'spending' && !r.isError);
  assert.ok(read && read.result.truncated === true, 'spending.total ran and was marked truncated');
  assert.ok(read.result.total && read.result.total.value !== undefined, 'the rest of the result is kept');
  const lines = truncation(reply);
  assert.deepEqual(lines, [{ code: 'truncated', text: 'Part of the spending result was cut to fit, so the answer covers only part of it.', fix: null }]);
  assertRendered(reply, lines[0].text);
});

test('H4-AC2 continueRead only continues an open-ended transactions search', async () => {
  assert.equal(CONTINUE_CAP, 200);
  const page = (ids, truncated, next) => ({ rows: ids.map(id => ({ id })), total: 450, truncated, next });
  const never = () => { throw new Error('should not continue'); };
  const first = page([1, 2], true, 'c1');
  for (const args of [{ operation: 'search', limit: 2 }, { operation: 'search', cursor: 'c0' }, { operation: 'search', ids: ['1', '2'] }]) {
    assert.deepEqual(await continueRead('transactions', args, first, never), first, `unchanged for ${JSON.stringify(args)}`);
  }
  assert.deepEqual(await continueRead('spending', { operation: 'search' }, first, never), first, 'another tool is unchanged');
  const done = page([1, 2], false, null);
  assert.deepEqual(await continueRead('transactions', { operation: 'search' }, done, never), done, 'an untruncated result is unchanged');

  // Pages of 50: continues until the cap, and the merged result stays truncated with the last cursor.
  const calls = [];
  let at = 50;
  const next = async a => {
    calls.push(a);
    const ids = Array.from({ length: 50 }, (_, i) => at + i + 1);
    at += 50;
    return page(ids, true, `c${at}`);
  };
  const merged = await continueRead('transactions', { operation: 'search', text: 'market' }, page(Array.from({ length: 50 }, (_, i) => i + 1), true, 'c50'), next);
  assert.equal(merged.rows.length, CONTINUE_CAP);
  assert.deepEqual(merged.rows.map(r => r.id), Array.from({ length: CONTINUE_CAP }, (_, i) => i + 1));
  assert.equal(merged.total, 450);
  assert.equal(merged.truncated, true);
  assert.deepEqual(calls.map(a => a.cursor), ['c50', 'c100', 'c150']);
  assert.ok(calls.every(a => a.operation === 'search' && a.text === 'market'), 'the other arguments are kept');

  // A last page that finishes the matches ends untruncated.
  const short = await continueRead('transactions', { operation: 'search' }, page([1, 2], true, 'c2'),
    async () => ({ rows: [{ id: 3 }], total: 3, truncated: false, next: null }));
  assert.deepEqual(short.rows.map(r => r.id), [1, 2, 3]);
  assert.equal(short.truncated, false);
});

test('H4-AC2 leftOutOf names each truncated result, skips errors and collapses repeats', () => {
  const kn = { name: 'knowledge', args: { operation: 'search', query: 'synthetic' }, result: { results: [{}, {}], total: 1234, truncated: true } };
  assert.deepEqual(leftOutOf([kn]), [{ code: 'truncated', text: 'Showed the first 2 of 1,234 matching entries.', fix: null }]);
  const calc = { name: 'calculate', args: { operation: 'sum' }, result: { value: 1, truncated: true } };
  assert.deepEqual(leftOutOf([calc]).map(e => e.text), ['Part of the calculation result was cut to fit, so the answer covers only part of it.']);
  const tx = { name: 'transactions', args: { operation: 'search' }, result: { rows: [{ id: 1 }], total: 4321, truncated: true } };
  assert.deepEqual(leftOutOf([tx]).map(e => e.text), ['Showed the first 1 of 4,321 matching transactions.']);
  assert.deepEqual(leftOutOf([{ ...tx, isError: true }]), [], 'an error result is skipped');
  assert.deepEqual(leftOutOf([{ ...tx, result: { ...tx.result, truncated: false } }]), [], 'an untruncated result says nothing');
  assert.equal(leftOutOf([tx, structuredClone(tx)]).length, 1, 'the same line once');
  const many = Array.from({ length: 12 }, (_, i) => ({ ...tx, result: { rows: [{ id: i }], total: 100 + i, truncated: true } }));
  assert.equal(leftOutOf(many).length, 8, 'at most eight entries');
});
