// AV2 acceptance criteria through createLiveAnswerer: scripted engine answers that read a drawable
// result and never call show get one deterministic automatic block, appended after the text and
// marked origin 'auto'; model-drawn blocks are marked origin 'model' and suppress automatic ones.
// Expected values come from the tool results the engine recorded in the same answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { tempDb } from './helpers/server.mjs';
import { seedDemo } from '../demo/seed.mjs';
import { loadConfig } from '../src/config.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { buildScenario } from '../src/scenario/build.mjs';

const MONTH = { name: 'spending', args: { operation: 'total', groupBy: 'month', window: 'ytd' } };
const SINGLE = { name: 'spending', args: { operation: 'total', window: 'ytd' } };
const PROJECTION = { name: 'spending', args: { operation: 'projection' } };
const CATEGORY = { name: 'spending', args: { operation: 'total', groupBy: 'category', window: 'ytd' } };
const OBLIGATIONS = { name: 'spending', args: { operation: 'obligations' } };
const DEADLINES = { name: 'household', args: { operation: 'deadlines' } };
const DEFERRAL = { name: 'recommendations', args: { operation: 'wargame', name: 'deferral' } };
const ROWS = { name: 'transactions', args: { operation: 'search', limit: 3 } };

// Synthetic stored war-game figures (the planner's figure keys), so the options carry values.
const WARGAME_FIELDS = { salary: ['salary', 'payroll', 'dist', 'tax', 'x', 'y'], deferral: ['amount', 'net', 'decCash', 'need', 'gap', 'tax2026', 'tax2027'] };
function plantWargames(db) {
  const { wargame } = buildScenario(db);
  const put = db.prepare(`INSERT OR REPLACE INTO figures (key, v, kind, label, parser, updated_at) VALUES (?, ?, 'm', ?, 'planner', '2026-11-05')`);
  for (const name of ['salary', 'deferral']) (name === 'salary' ? wargame.salary.points : wargame.deferral.options).forEach((item, i) =>
    WARGAME_FIELDS[name].forEach((field, j) => put.run(`wg.${name}.${item.id}.${field}`, 1000 * (i + 1) + 10 * j, field)));
  put.run('wg.deferral.base.income', 5000, 'income');
}

async function answer(t, scripts, { prepare } = {}) {
  const s = await tempDb(); seedDemo(s.db);
  t.after(async () => { s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  prepare?.(s.db);
  const runtime = createRuntimeEngine({ db: s.db, config: loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'fake' }) });
  const results = [];
  const engine = { mode: 'fake', isOn: () => true, async call(request) {
    const result = await runtime.call({ ...request, fake: scripts.shift() }); results.push(result); return result;
  } };
  const reply = await createLiveAnswerer({ engine, root: s.dataDir, services: { engine, config: { dataDir: s.dataDir } } }).answer({ db: s.db, key: 'ask:0123456789ab', text: 'Show recent spending.' });
  return { reply, results };
}
const recorded = (results, call) => results.flatMap(r => r.toolResults)
  .find(r => r.name === call.name && !r.isError && isDeepStrictEqual(r.args, call.args)).result;
const read = call => ({ name: call.name, args: call.args });
const asCall = call => ({ tool: call.name, args: call.args });
function clean(reply) {
  assert.equal(reply.notice, undefined);
  assert.equal(reply.provenance.grounding.ok, true);
  assert.doesNotMatch(reply.paragraphs.join(''), /\{b:/);
  assert.deepEqual(reply.provenance.blockNotes, []);
}
// One automatic block, appended after every paragraph.
function autoBlock(reply, call) {
  clean(reply);
  assert.equal(reply.provenance.blocks.length, 1);
  const [block] = reply.provenance.blocks;
  assert.equal(block.origin, 'auto');
  assert.equal(block.id, 'b1');
  assert.equal(block.after, reply.paragraphs.length);
  assert.deepEqual(block.calls, [asCall(call)]);
  return block;
}

test('AC1 a month read with no show call gets one automatic bar chart of the tool figures', async t => {
  const { reply, results } = await answer(t, [[{ toolCalls: [read(MONTH)] }, { text: 'Monthly spending this year follows.' }]]);
  assert.ok(reply.paragraphs.length >= 1);
  const block = autoBlock(reply, MONTH);
  assert.equal(block.op, 'chart');
  assert.equal(block.snapshot.kind, 'bar');
  const groups = [...recorded(results, MONTH).groups].sort((a, b) => a.key.localeCompare(b.key));
  assert.ok(groups.length >= 2);
  assert.deepEqual(block.snapshot.series[0].points.map(p => p.value), groups.map(g => g.figure.value));
  assert.equal(block.snapshot.x.length, groups.length);
});

test('AC2 a spending projection read gets a line chart of years', async t => {
  const { reply, results } = await answer(t, [[{ toolCalls: [read(PROJECTION)] }, { text: 'Projected spending follows.' }]]);
  const block = autoBlock(reply, PROJECTION);
  assert.equal(block.op, 'chart');
  assert.equal(block.snapshot.kind, 'line');
  const years = recorded(results, PROJECTION).years;
  assert.deepEqual(block.snapshot.x.map(x => x.text), years.map(y => String(y.year)));
  assert.deepEqual(block.snapshot.series[0].points.map(p => p.value), years.map(y => y.spending.value));
});

test('AC2 a category read gets a table sorted largest first with drill links', async t => {
  const { reply, results } = await answer(t, [[{ toolCalls: [read(CATEGORY)] }, { text: 'Spending by category follows.' }]]);
  const block = autoBlock(reply, CATEGORY);
  assert.equal(block.op, 'table');
  assert.equal(block.snapshot.sort.dir, 'desc');
  const groups = recorded(results, CATEGORY).groups;
  const cells = block.snapshot.rows.map(r => r.cells[block.snapshot.sort.column]);
  assert.deepEqual(cells.map(c => c.fig.value), groups.map(g => g.figure.value));
  cells.forEach((c, i) => { assert.equal(c.drill.route, 'spending'); assert.equal(c.drill.query.category, groups[i].key); });
});

test('AC2 an obligations read gets a timeline', async t => {
  const { reply, results } = await answer(t, [[{ toolCalls: [read(OBLIGATIONS)] }, { text: 'Your obligations follow.' }]]);
  const block = autoBlock(reply, OBLIGATIONS);
  assert.equal(block.op, 'timeline');
  assert.equal(block.snapshot.events.length, recorded(results, OBLIGATIONS).obligations.length);
});

test('AC2 an open deferral war game read gets a compare block with its action', async t => {
  const { reply, results } = await answer(t, [[{ toolCalls: [read(DEFERRAL)] }, { text: 'The invoice options follow.' }]], { prepare: plantWargames });
  const block = autoBlock(reply, DEFERRAL);
  assert.equal(block.op, 'compare');
  assert.equal(block.snapshot.action.kind, 'wargame');
  assert.equal(block.snapshot.action.name, 'deferral');
  assert.equal(block.snapshot.options.length, recorded(results, DEFERRAL).deferral.options.length);
});

test('AC3 a single figure read gets no block', async t => {
  const { reply } = await answer(t, [[{ toolCalls: [read(SINGLE)] }, { text: 'Spending this year follows.' }]]);
  clean(reply);
  assert.deepEqual(reply.provenance.blocks, []);
});

test('AC3 a refusal after a month read gets no block', async t => {
  const { reply } = await answer(t, [[{ toolCalls: [read(MONTH)] }, { text: "I can't move money between your accounts. Fathom is advisory only." }]]);
  clean(reply);
  assert.deepEqual(reply.provenance.blocks, []);
});

test('AC3 a gap-only read (the unplanned demo war game) gets no block', async t => {
  const { reply, results } = await answer(t, [[{ toolCalls: [read(DEFERRAL)] }, { text: 'The invoice options are not built yet.' }]]);
  const options = recorded(results, DEFERRAL).deferral.options;
  assert.ok(options.every(o => Object.values(o.figures).every(f => f.value === null)));
  clean(reply);
  assert.deepEqual(reply.provenance.blocks, []);
});

test('AC3 a model-drawn table suppresses automatic blocks and is marked origin model', async t => {
  const table = { operation: 'table', source: { tool: MONTH.name, args: MONTH.args, path: 'groups' }, columns: ['key', 'figure'] };
  const { reply } = await answer(t, [[
    { toolCalls: [read(MONTH), read(PROJECTION)] },
    { toolCalls: [{ name: 'show', args: table }] },
    { text: 'Monthly spending follows.\n\n{b:b1}' },
  ]]);
  clean(reply);
  assert.equal(reply.provenance.blocks.length, 1);
  const [block] = reply.provenance.blocks;
  assert.equal(block.origin, 'model');
  assert.equal(block.op, 'table');
  assert.equal(block.id, 'b1');
  assert.equal(block.after, 1);
});

test('AC3 four drawable reads get exactly two automatic blocks', async t => {
  const { reply } = await answer(t, [[
    { toolCalls: [read(MONTH), read(PROJECTION), read(CATEGORY), read(DEADLINES)] },
    { text: 'Your spending and deadlines follow.' },
  ]]);
  clean(reply);
  const blocks = reply.provenance.blocks;
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map(b => b.origin), ['auto', 'auto']);
  assert.deepEqual(blocks.map(b => b.id), ['b1', 'b2']);
  assert.deepEqual(blocks.map(b => b.op), ['chart', 'chart']);
  assert.deepEqual(blocks.map(b => b.calls), [[asCall(MONTH)], [asCall(PROJECTION)]]);
  assert.ok(blocks.every(b => b.after === reply.paragraphs.length));
});

test('existing show blocks keep working and are marked origin model', async t => {
  const table = { operation: 'table', source: { tool: ROWS.name, args: ROWS.args, path: 'rows' }, columns: ['date', 'amount'] };
  const { reply } = await answer(t, [[{ toolCalls: [read(ROWS)] }, { toolCalls: [{ name: 'show', args: table }] },
    { text: 'Recent spending follows.\n\n{b:b1}\n\nThe source rows are available.' }]]);
  clean(reply);
  assert.equal(reply.provenance.blocks.length, 1);
  assert.equal(reply.provenance.blocks[0].origin, 'model');
  assert.equal(reply.provenance.blocks[0].after, 1);
});
