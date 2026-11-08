// C3 quoting: every figure envelope carries the text the answer must write (`quote`), money leaving
// the household is quoted unsigned with direction 'out', stored figures quote their {f:key} token, and
// groundAnswer (unchanged) grounds every quote form.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../demo/seed.mjs';
import { callTool } from '../src/tools/index.mjs';
import { envelope, quoteFor, fromStored } from '../src/calc/figure.mjs';
import { groundAnswer } from '../src/api/answerer.mjs';
import { tempDb } from './helpers/server.mjs';
import { envelopeEntries } from './helpers/figures.mjs';

const ref = { tool: 'calculate', args: { operation: 'add' }, path: 'figure' };
const fig = (value, unit, extra = {}) => envelope(value, { unit, label: 'Synthetic figure', asOf: '2032-06-01', ref, ...extra });

let t;
let ctx;
before(async () => {
  t = await tempDb();
  await seedDemo(t.db);
  ctx = { db: t.db, dataDir: t.dataDir, now: new Date('2026-11-05T15:00:00Z') };
});
after(() => t && t.close());

const FORMS = [
  // [value, unit, quote, direction]
  [12345.67, 'usd', '$12,345.67'],
  [18300, 'usd', '$18,300'],
  [0.5, 'usd', '$0.50'],
  [1234567.891, 'usd', '$1,234,567.89'],
  [-2400, 'usd', '$2,400', 'out'],
  [-0.07, 'usd', '$0.07', 'out'],
  [1330, 'usd_per_month', '$1,330 a month'],
  [-100.5, 'usd_per_month', '$100.50 a month', 'out'],
  [15900, 'usd_per_year', '$15,900 a year'],
  [0.04, 'ratio', '4%'],
  [0.035, 'ratio', '3.5%'],
  [1 / 3, 'ratio', '33.3333%'],
  [1.4, 'ratio', '140%'],
  [-0.2, 'ratio', '-20%'],
  [18, 'months', '18 months'],
  [1, 'months', '1 month'],
  [2.5, 'years', '2.5 years'],
  [1, 'years', '1 year'],
  [147.59, 'days', '147.59 days'],
  [-147.59, 'days', '-147.59 days'],
  [59.5, 'age', '59 and a half'],
  [59, 'age', '59'],
  ['2031-06-15', 'date', '2031-06-15'],
  [5, 'count', '5'],
];

test('quoteFor writes each unit in digits, money unsigned to cents, ratios as percents', () => {
  for (const [value, unit, quote] of FORMS) assert.equal(quoteFor(value, unit), quote, `${unit} ${value}`);
  assert.equal(quoteFor(null, 'usd'), null);
  assert.throws(() => quoteFor(1, 'percent'));
});

test('envelopes carry quote, and direction out only for money leaving the household', () => {
  for (const [value, unit, quote, direction] of FORMS) {
    const e = fig(value, unit);
    assert.equal(e.quote, quote, `${unit} ${value}`);
    assert.equal(e.direction, direction, `${unit} ${value} direction`);
    if (!direction) assert.ok(!Object.hasOwn(e, 'direction'), `${unit} ${value} has no direction key`);
  }
  for (const [value, unit] of [[-0.2, 'ratio'], [-147.59, 'days'], [-3, 'count']]) assert.equal(fig(value, unit).direction, undefined);
  // The quote is built from the rounded value.
  assert.equal(fig(1.005, 'usd').quote, '$1.01');
  assert.equal(fig(12.2, 'months', { projection: true }).quote, '13 months');
  assert.equal(fig(59.26, 'age').quote, '59 and a half');
  const missing = fig(null, 'usd', { unavailable: 'missing_fact', gaps: [{ code: 'missing_fact', message: 'No value' }] });
  assert.equal(missing.quote, null);
  assert.equal(missing.direction, undefined);
});

test('a stored figure keeps its {f:key} token as token, and its quote is that token', () => {
  const row = { key: 'synthetic_total', v: 123.456, src: 'statement', kind: 'a', label: 'Statement total', locator: 'fig.total', src_as_of: '2032-05-31' };
  const stored = fromStored(row, { ref: { tool: 'household', args: { operation: 'figures', keys: [row.key] }, path: '0' } });
  assert.equal(stored.token, '{f:synthetic_total}');
  assert.equal(stored.quote, '{f:synthetic_total}');
  assert.equal(stored.value, 123.46);
});

test('household.figures quotes every stored figure by token over the demo store', async () => {
  const figures = await callTool('household', { operation: 'figures' }, ctx);
  assert.ok(figures.length > 10);
  for (const f of figures) {
    assert.equal(f.token, `{f:${f.key}}`, f.key);
    assert.equal(f.quote, f.token, f.key);
  }
});

test('goals.pace envelopes quote their own value over the demo store', async () => {
  const pace = await callTool('goals', { operation: 'pace' }, ctx);
  const entries = envelopeEntries(pace);
  assert.ok(entries.length > 10);
  let outs = 0;
  for (const { path, figure } of entries) {
    assert.equal(figure.quote, quoteFor(figure.value, figure.unit), path);
    const out = ['usd', 'usd_per_month', 'usd_per_year'].includes(figure.unit) && figure.value < 0;
    assert.equal(figure.direction, out ? 'out' : undefined, path);
    if (out) outs++;
  }
  assert.ok(outs > 0, 'the demo pace holds at least one negative money figure');
});

// A reply that writes each figure exactly as its quote grounds through groundAnswer, which this
// ticket does not change: the quote string or the value is the evidence.
test('groundAnswer grounds each quote form written verbatim', () => {
  for (const [value, unit, , direction] of FORMS) {
    const e = fig(value, unit);
    const verb = direction === 'out' ? 'You spent' : 'The figure is';
    const reply = `${verb} ${e.quote}.`;
    const grounded = groundAnswer(reply, { scenario: { fig: {} }, toolResults: [{ name: 'calculate', args: { operation: 'add', label: 'Synthetic figure' }, result: { figure: e } }] });
    assert.deepEqual(grounded.violations, [], `${reply} grounds`);
    assert.equal(grounded.ok, true, reply);
  }
});

test('groundAnswer grounds a stored figure quoted as its token from household.figures', async () => {
  const figures = await callTool('household', { operation: 'figures', keys: ['biz_cash', 'personal_cash'] }, ctx);
  assert.equal(figures.length, 2);
  const scenario = { fig: Object.fromEntries(figures.map(f => [f.key, { v: f.v }])) };
  const reply = `Business cash is ${figures[0].quote} and personal cash is ${figures[1].quote}.`;
  const grounded = groundAnswer(reply, { scenario, toolResults: [{ name: 'household', args: { operation: 'figures', keys: ['biz_cash', 'personal_cash'] }, result: figures }] });
  assert.equal(grounded.ok, true, JSON.stringify(grounded.violations));
  assert.deepEqual([...grounded.figureKeys].sort(), ['biz_cash', 'personal_cash']);
});
