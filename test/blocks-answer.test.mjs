import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tempDb } from './helpers/server.mjs';
import { seedDemo } from '../demo/seed.mjs';
import { loadConfig } from '../src/config.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { createLiveAnswerer, groundAnswer } from '../src/api/answerer.mjs';
import { streamHtml } from '../src/shared/answer-text.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { getTool } from '../src/tools/index.mjs';

const read = { name: 'transactions', args: { operation: 'search', limit: 3 } };
const source = { tool: read.name, args: read.args, path: 'rows' };
const table = { operation: 'table', source, columns: ['date', 'amount'] };
async function answer(t, scripts) {
  const s = await tempDb(); seedDemo(s.db);
  t.after(async () => { s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  const runtime = createRuntimeEngine({ db: s.db, config: loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'fake' }) });
  const results = [];
  const engine = { mode: 'fake', isOn: () => true, async call(request) {
    const result = await runtime.call({ ...request, fake: scripts.shift() }); results.push(result); return result;
  } };
  const reply = await createLiveAnswerer({ engine, root: s.dataDir, services: { engine, config: { dataDir: s.dataDir } } }).answer({ db: s.db, key: 'ask:0123456789ab', text: 'Show recent spending.' });
  return { reply, results, scenario: buildScenario(s.db) };
}

test('real reads build and place a table, remove markers and retain dropped notes', async t => {
  const { reply, results } = await answer(t, [[
    { toolCalls: [read] },
    { toolCalls: [{ name: 'show', args: table }, { name: 'show', args: { ...table, source: { ...source, args: { ...read.args, limit: 2 } } } }] },
    { text: 'Recent spending follows.\n\n{b:b1}\n\nThe source rows are available.\n\n{b:unknown}' },
  ]]);
  assert.equal(reply.notice, undefined);
  assert.equal(reply.provenance.blocks.length, 1);
  const block = reply.provenance.blocks[0];
  assert.equal(block.id, 'b1'); assert.equal(block.after, 1); assert.equal(block.op, 'table');
  const rows = results[0].toolResults.find(r => r.name === 'transactions').result.rows;
  assert.deepEqual(block.snapshot.rows.map(r => r.cells[1].value), rows.map(r => r.amount));
  assert.deepEqual(block.calls, [{ tool: read.name, args: read.args }]);
  assert.equal(reply.provenance.blockNotes[0].reason, 'not_in_answer');
  assert.doesNotMatch(reply.paragraphs.join(''), /\{b:/);
  assert.equal(reply.provenance.grounding.ok, true);
});

for (const [name, args] of [
  ['missing argument', { operation: 'table', source }],
  ['extra property', { ...table, injected: true }],
  ['number word title', { ...table, title: 'Double spending' }],
]) test(`invalid show ${name} becomes a note`, async t => {
  const { reply } = await answer(t, [[{ toolCalls: [read, { name: 'show', args }] }, { text: 'The rows are available.\n\n{b:b1}' }]]);
  assert.deepEqual(reply.provenance.blocks, []);
  assert.equal(reply.provenance.blockNotes.length, 1);
  assert.equal(reply.provenance.blockNotes[0].reason, 'bad_input');
  assert.doesNotMatch(reply.paragraphs.join(''), /\{b:/);
});

test('regeneration can show a table from a read in the first engine attempt', async t => {
  const { reply, results } = await answer(t, [
    [{ toolCalls: [read] }, { text: 'Invented $987,654 and $876,543.' }],
    [{ toolCalls: [{ name: 'show', args: table }] }, { text: 'Recent spending.\n\n{b:b1}' }],
  ]);
  assert.equal(results.length, 2); assert.equal(reply.provenance.grounding.retried, true);
  assert.equal(reply.provenance.blocks.length, 1); assert.equal(reply.provenance.blocks[0].after, 1);
});

test('inline, missing and repeated markers place each block once', async t => {
  const { reply } = await answer(t, [[{ toolCalls: [read, { name: 'show', args: table }, { name: 'show', args: table }] },
    { text: 'Recent {b:b1} spending.\n\n{b:b1}\n\nMore context.' }]]);
  assert.deepEqual(reply.provenance.blocks.map(b => b.after), [1, 2]);
  assert.doesNotMatch(reply.paragraphs.join(''), /\{b:/);
});

test('four blocks per answer, including engine tool rounds', async t => {
  const { reply } = await answer(t, [[{ toolCalls: [read] }, ...Array.from({ length: 5 }, () => ({ toolCalls: [{ name: 'show', args: table }] })), { text: 'Recent spending.' }]]);
  assert.equal(reply.provenance.blocks.length, 4);
  assert.equal(reply.provenance.blockNotes[0].reason, 'too_many');
});

test('block markers do not count as figures and stream as placeholders', () => {
  assert.equal(groundAnswer('Recent spending.\n\n{b:b1}', { scenario: { figures: {} } }).ok, true);
  const html = streamHtml('Recent spending.\n\n{b:b1}');
  assert.match(html, /Chart being prepared/); assert.doesNotMatch(html, /\{b:|Checking this number/);
  assert.ok(getTool('show').operations.every(o => !o.referenceable));
});
