// AB1: an Ask block built from stored figures (the invoice-deferral war game, household figures)
// must never show a stored figure's prose token ({f:<key>}) in place of its value. The server keeps
// token quotes out of block snapshots, and the client formats a figure by its unit and ignores any
// token quote an older stored snapshot still carries. Values are synthetic stored war-game figures
// planted in a temp store; every expected value is read from the recorded tool result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { tempDb } from './helpers/server.mjs';
import { seedDemo } from '../demo/seed.mjs';
import { loadConfig } from '../src/config.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { callTool } from '../src/tools/index.mjs';
import { makeBlock } from '../src/tools/catalog/show.mjs';
import { esc, money } from '../src/shared/tokens.mjs';
import { useKit, messageBodyHtml, blockState, formatByUnit } from '../web/horizon/screens/ask-blocks.js';

const QUESTION = 'Should I move some December invoices into January? Compare the options.';
const DEFERRAL = { name: 'recommendations', args: { operation: 'wargame', name: 'deferral' } };
const SALARY = { name: 'recommendations', args: { operation: 'wargame', name: 'salary' } };
const TOKEN = /\{f:/;

let registered = new Map();
useKit({ esc, money, registerFigures: (map) => { for (const [k, v] of Object.entries(map)) registered.set(k, v); } });

// Synthetic stored war-game figures (the planner's figure keys), so the options carry values.
const WARGAME_FIELDS = { salary: ['salary', 'payroll', 'dist', 'tax', 'x', 'y'], deferral: ['amount', 'net', 'decCash', 'need', 'gap', 'tax2026', 'tax2027'] };
function plantWargames(db) {
  const { wargame } = buildScenario(db);
  const put = db.prepare(`INSERT OR REPLACE INTO figures (key, v, kind, label, parser, updated_at) VALUES (?, ?, 'm', ?, 'planner', '2026-11-05')`);
  for (const name of ['salary', 'deferral']) (name === 'salary' ? wargame.salary.points : wargame.deferral.options).forEach((item, i) =>
    WARGAME_FIELDS[name].forEach((field, j) => put.run(`wg.${name}.${item.id}.${field}`, 1000 * (i + 1) + 10 * j, field)));
  put.run('wg.deferral.base.income', 5000, 'income');
}

async function store(t) {
  const s = await tempDb(); seedDemo(s.db); plantWargames(s.db);
  t.after(async () => { s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  return s;
}

// The question through createLiveAnswerer with the fake engine; its own script (src/api/fake-answers.mjs)
// runs: the deferral war game read, then show compare with six fields.
async function ask(t, text) {
  const s = await store(t);
  const runtime = createRuntimeEngine({ db: s.db, config: loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'fake' }) });
  const results = [];
  const engine = { mode: 'fake', isOn: () => true, async call(request) { const result = await runtime.call(request); results.push(result); return result; } };
  const reply = await createLiveAnswerer({ engine, root: s.dataDir, services: { engine, config: { dataDir: s.dataDir } } })
    .answer({ db: s.db, key: 'ask:0123456789ab', text });
  return { reply, results };
}
const recorded = (results, call) => results.flatMap(r => r.toolResults)
  .find(r => r.name === call.name && !r.isError && isDeepStrictEqual(r.args, call.args)).result;

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
// Every figure span in order: [blk key, shown text].
const spans = (html) => [...html.matchAll(/<span class="fx-fig[^"]*"[^>]*data-fig="([^"]+)"[^>]*>([^<]*)<\/span>/g)].map((x) => [decode(x[1]), decode(x[2])]);
const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/blocks/${name}.json`, import.meta.url), 'utf8'));
let seq = 0;
const msg = (blocks) => ({ id: `tk${++seq}`, role: 'fathom', html: '<p>x</p>', provenance: { blocks } });
const at = (value, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), value);

test('AC1 the deferral comparison stores no token and renders every figure formatted', async t => {
  const { reply, results } = await ask(t, QUESTION);
  const [block] = reply.provenance.blocks;
  assert.ok(block, 'the answer stores a block');
  assert.equal(block.op, 'compare');
  const read = recorded(results, DEFERRAL);
  const count = read.deferral.options.length;
  assert.ok(count >= 2, 'the war game has options');
  assert.equal(block.snapshot.options.length, count);
  assert.equal(block.snapshot.fields.length, 6);
  assert.doesNotMatch(JSON.stringify(block.snapshot), TOKEN, 'the stored snapshot carries no {f: token');

  const fields = block.spec.fields;
  assert.equal(fields.length, 6);
  registered = new Map();
  const m = { id: 'tk-ac1', role: 'fathom', html: '<p>x</p>', provenance: reply.provenance };
  const html = messageBodyHtml(m);
  assert.doesNotMatch(html, TOKEN, 'the rendered comparison prints no {f: token');
  const cells = spans(html);
  assert.equal(cells.length, count * 6, 'every option cell is a figure span');
  block.snapshot.options.forEach((o, i) => fields.forEach((field, j) => {
    const [key, text] = cells[i * 6 + j];
    assert.match(key, new RegExp(`^blk:${m.id}:${block.id}:\\d+$`));
    const entry = registered.get(key);
    assert.ok(entry, `${key} is registered`);
    const stored = at(read.deferral.options[i].figures, field.replace(/^figures\./, ''));
    assert.equal(typeof stored.value, 'number', `${o.label} ${field} has a stored value`);
    assert.equal(entry.value, stored.value, `${o.label} ${field} value`);
    assert.ok(entry.unit, 'a unit'); assert.ok(entry.label, 'a label');
    assert.ok(entry.provenance && Object.keys(entry.provenance).length, 'provenance');
    assert.equal(text, formatByUnit(entry.value, entry.unit), `${o.label} ${field} text`);
  }));
});

// The compare fixture with every figure quote set to a stored token, as an old stored reply's
// snapshot carries; one figure is unavailable.
function tokenized() {
  const block = structuredClone(fx('compare'));
  block.snapshot.options.forEach((o, i) => o.cells.forEach((c, j) => { if (c.fig) c.fig.quote = `{f:wg.deferral.opt${i}.field${j}}`; }));
  return block;
}

test('AC1 an old stored reply whose snapshot carries token quotes renders formatted figures', () => {
  const block = tokenized();
  const html = messageBodyHtml(msg([block]));
  assert.doesNotMatch(html, TOKEN);
  const figs = block.snapshot.options.flatMap(o => o.cells).filter(c => c.fig).map(c => c.fig);
  const shown = spans(html).map(([, text]) => text);
  assert.equal(shown.length, figs.length);
  figs.forEach((f, i) => assert.equal(shown[i], formatByUnit(f.value, f.unit), f.label));

  const missing = tokenized();
  const cell = missing.snapshot.options[0].cells.find(c => c.t === 'fig');
  Object.assign(cell.fig, { value: null, gaps: [{ code: 'missing_fact', message: 'The stored figure is unavailable.' }] });
  const out = messageBodyHtml(msg([missing]));
  assert.doesNotMatch(out, TOKEN);
  assert.ok(spans(out).some(([, text]) => text === 'Unavailable'), 'a null figure reads Unavailable');
});

// Every quote key and every figure-like holder (an object with value and unit) gets a token quote.
function poison(value, n = { i: 0 }) {
  if (Array.isArray(value)) { value.forEach(v => poison(v, n)); return value; }
  if (!value || typeof value !== 'object') return value;
  if (Object.hasOwn(value, 'quote') || (Object.hasOwn(value, 'value') && Object.hasOwn(value, 'unit'))) value.quote = `{f:poison.${n.i++}}`;
  for (const v of Object.values(value)) poison(v, n);
  return value;
}
const decisionCompare = () => {
  const block = structuredClone(fx('compare'));
  block.id = 'd1';
  block.snapshot.action = { kind: 'wargame', name: 'deferral', decisionId: 'decision-synthetic' };
  return block;
};
const GUARDED = [
  ...['chart-area', 'chart-bar', 'chart-line', 'chart-scatter', 'compare', 'table', 'table-rows', 'timeline'].map(name => [name, () => structuredClone(fx(name))]),
  ['decision compare', decisionCompare],
];

for (const [name, make] of GUARDED) test(`guard: the ${name} block never prints {f: text, in every view`, () => {
  const block = make();
  poison(block.snapshot);
  assert.match(JSON.stringify(block.snapshot), TOKEN, 'the snapshot is poisoned');
  const m = msg([block]);
  const views = block.op === 'chart' || block.op === 'timeline' ? [false, true] : [false];
  for (const table of views) {
    blockState(m.id, block.id).table = table;
    const html = messageBodyHtml(m);
    assert.ok(html.includes(`h-blk-${block.op}`), `${name} is drawn`);
    assert.doesNotMatch(html, TOKEN, `${name}${table ? ' table view' : ''}`);
  }
});

// Server guard: blocks built through makeBlock from reads that carry stored figures keep no token.
// Timeline is not covered here: no read with stored figures (fromStored) has a date path a timeline
// can draw (household deadlines carry no figures), so the client guard above covers timeline.
test('guard: makeBlock snapshots from stored-figure reads carry no {f: token', async t => {
  const s = await store(t);
  const read = async call => ({ name: call.name, args: call.args, isError: false, result: await callTool(call.name, call.args, { db: s.db, clock: '2026-11-05' }) });
  const results = [await read(DEFERRAL), await read(SALARY)];
  assert.match(JSON.stringify(results), TOKEN, 'the reads carry stored figure tokens');
  const deferral = { tool: DEFERRAL.name, args: DEFERRAL.args, path: 'deferral.options' };
  const salary = { tool: SALARY.name, args: SALARY.args, path: 'salary.points' };
  const specs = [
    ['compare', { source: deferral, fields: ['figures.amount', 'figures.taxThisYear', 'figures.taxNextYear', 'figures.net', 'figures.decemberCash', 'figures.payrollNeed'] }],
    ['compare', { options: [{ source: { ...deferral, path: 'deferral.options.0' } }, { source: { ...deferral, path: 'deferral.options.1' } }], fields: ['figures.amount', 'figures.net'] }],
    ['table', { source: deferral, columns: ['figures.amount', 'figures.net', 'figures.gap'] }],
    ['chart', { kind: 'scatter', source: salary, x: 'figures.room', series: [{ path: 'figures.taxChange' }] }],
  ];
  for (const [op, spec] of specs) {
    const made = makeBlock(op, spec, results, { id: 'b1', now: Date.parse('2026-11-05T12:00:00Z'), origin: 'model' });
    assert.equal(made.ok, true, `${op} builds: ${made.reason || ''}`);
    assert.doesNotMatch(JSON.stringify(made.block.snapshot), TOKEN, `${op} ${JSON.stringify(spec.fields || spec.columns || spec.x)}`);
  }
});
