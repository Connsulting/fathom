import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../demo/seed.mjs';
import { tempDb, serveAppFixture, request } from './helpers/server.mjs';
import { callTool } from '../src/tools/index.mjs';
import { buildSnapshot } from '../src/blocks/snapshot.mjs';
import { drillQuery } from '../src/blocks/drill.mjs';
import { tableOf } from '../web/horizon/screens/ask-block-chart.js';

const clock = '2026-11-05';
const spending = { tool: 'spending', args: { operation: 'total', measure: 'spending', scope: 'household', groupBy: 'category', from: '2026-01', to: '2026-10' }, path: 'groups' };
const queryString = query => new URLSearchParams(Object.entries(query).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v]));

test('both drill mappings fetch sums equal to every displayed demo category figure', async t => {
  const s = await tempDb(); seedDemo(s.db); t.after(() => s.close());
  const server = await serveAppFixture({ db: s.db, config: { clock } });
  t.after(() => server.close());
  const ctx = { db: s.db, clock };
  const spend = await callTool(spending.tool, spending.args, ctx);
  const businessArgs = { operation: 'pnl', groupBy: 'category', from: '2026-01', to: '2026-10' };
  const business = await callTool('business', businessArgs, ctx);
  const cases = [{ ref: spending, result: spend, fields: ['figure'] }, ...business.entities.map((entity, i) => ({
    ref: { tool: 'business', args: businessArgs, path: `entities.${i}.groups` }, result: business, fields: ['revenue', 'expenses'],
  }))];
  assert.ok(spend.groups.length); assert.ok(business.entities.length);
  for (const { ref, result, fields } of cases) {
    const snapshot = buildSnapshot('table', { source: ref, columns: ['key', ...fields] }, [{ name: ref.tool, args: ref.args, result }]);
    const chart = buildSnapshot('chart', { kind: 'bar', source: ref, x: 'key', series: fields.map(path => ({ path })) }, [{ name: ref.tool, args: ref.args, result }]);
    assert.deepEqual(tableOf(chart).rows.map(row => row.cells.slice(1).map(cell => cell.drill)), snapshot.rows.map(row => row.cells.slice(1).map(cell => cell.drill)));
    if (ref.tool === 'business') {
      const scatter = buildSnapshot('chart', { kind: 'scatter', source: ref, x: 'revenue', series: [{ path: 'expenses' }] }, [{ name: ref.tool, args: ref.args, result }]);
      assert.deepEqual(tableOf(scatter).rows.map(row => row.cells.slice(1).map(cell => cell.drill)), snapshot.rows.map(row => row.cells.slice(1).map(cell => cell.drill)));
    }
    for (const row of snapshot.rows) for (const cell of row.cells.slice(1)) {
      assert.ok(cell.drill, `${ref.tool} category figure has a drill`);
      const res = await request(server.baseUrl, { path: `/api/${cell.drill.route === 'pnl' ? 'pnl' : 'spending'}/rows?${queryString(cell.drill.query)}` });
      assert.equal(res.status, 200);
      assert.equal(Math.round(res.json.figures[res.json.sum].v * 100), Math.round(cell.fig.value * 100));
    }
  }
});

test('drillQuery refuses selections the row routes cannot express', () => {
  const item = { key: 'Groceries', figure: { window: { from: '2026-01', to: '2026-10' } } };
  assert.equal(drillQuery(spending, item, 'figure').route, 'spending');
  for (const change of [{ definition: 'saved' }, { groupBy: 'merchant' }, { groupBy: 'month' }, { groupBy: 'none' },
    { annualize: true }, { scope: 'business' }, { measure: 'outflow' }, { include: { merchants: ['Shop'] } }, { exclude: { accounts: ['a'] } }]) {
    assert.equal(drillQuery({ ...spending, args: { ...spending.args, ...change } }, item, 'figure'), null, JSON.stringify(change));
  }
  assert.equal(drillQuery(spending, item, 'total'), null);
  assert.equal(drillQuery({ tool: 'business', args: { operation: 'pnl', groupBy: 'category', entity: 'corp' } }, item, 'profit'), null);
  assert.equal(drillQuery({ ...spending, args: { ...spending.args, include: { categories: ['Other'] } } }, item, 'figure'), null);
  assert.deepEqual(drillQuery({ ...spending, args: { ...spending.args, include: { categories: [item.key] }, exclude: { categories: ['Other'] } } }, item, 'figure'), drillQuery(spending, item, 'figure'));
});
