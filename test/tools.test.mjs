// AC6: the tool registry (frozen interface 8) over a seeded store.
//
// Result shapes pinned here (the plan names the tools and inputs, not every output key):
//   household.summary -> { facts: {key: value}, verdictLevel, needsYouCount, statusCounts: {status: n}, dataThrough, clock }
//   household.facts -> [{ key, value, src, asOf, confirmed }]
//   accounts.list -> [{ id, inst, mask, name, owner, kind, mirror, balance, asOf }]
//   transactions.search -> { rows: [{ id, accountId, date, amount, description, category }], truncated, total }
//   accounts.holdings -> [{ accountId, symbol, name, quantity, price, value, asOf }]
//   business.pnl -> { rows: [{ period, category, amount }], totals: { 'YYYY-MM': n } }
//   recommendations.list, household.deadlines, goals.list, household.figures, knowledge.packs -> arrays
//   recommendations.detail, act_on_recommendation.status, act_on_recommendation.owner -> the rec { id, title, status, wake, tasks,
//     owner, ownerOverride, housekeeping, serves, ... }

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import demo from '../demo/scenario.mjs';
import { seedDemo, KIND_GOALS } from '../demo/seed.mjs';
import { tools, getTool, callTool, ToolError, parity, CAPABILITIES } from '../src/tools/index.mjs';
import { toolsForScopes } from '../src/mcp/keys.mjs';
import { needsRule } from '../src/shared/rules.mjs';
import { createRegistryServer } from '../src/engine/tools.mjs';
import { compileSchema } from '../src/engine/schema.mjs';
import { tempDb } from './helpers/server.mjs';
import { assertRefsResolve } from './helpers/figures.mjs';

const FROZEN = [
  'household', 'household', 'accounts', 'transactions', 'accounts', 'business',
  'recommendations', 'recommendations', 'household', 'goals', 'household', 'knowledge',
  'act_on_recommendation', 'act_on_recommendation', 'knowledge', 'knowledge', 'knowledge',
  'goals', 'recommendations', 'household', 'update_preferences', 'answer',
  'act_on_recommendation', 'update_goal', 'update_goal', 'undo', 'undo',
  'undo', 'undo', 'undo',
].sort();
const TEST_ROWS = 250;

const novemberStatus = r => (r.statusByDemo && r.statusByDemo.november) || r.status;
const isCode = code => err => err instanceof ToolError && err instanceof Error && err.code === code;

let t;
let ctx;
const call = (name, args = {}) => callTool(name, args, ctx);
const count = (sql, ...p) => t.db.prepare(sql).get(...p).n;

before(async () => {
  t = await tempDb();
  seedDemo(t.db);
  const fact = t.db.prepare(`INSERT OR REPLACE INTO facts (key, value, src, as_of, confirmed, file_id, parser, locator, updated_at)
                             VALUES (?, ?, 'you', '2026-11-01', 1, NULL, NULL, NULL, '2026-11-01T09:00:00Z')`);
  fact.run('household.dependents', '1');
  fact.run('income.sCorp', 'true');
  t.db.prepare(`INSERT INTO accounts (id, inst, mask, name, owner, kind, mirror, note, fig_key, file_id, parser, locator)
                VALUES ('acct_test', 'Test Bank', '4321', 'Test checking', 'Household', 'checking', 'manual', '', NULL, NULL, 'test', 'row 0')`).run();
  const tx = t.db.prepare(`INSERT INTO transactions (account_id, date, amount, description, category, external_id, dedupe_key, file_id, parser, locator)
                           VALUES ('acct_test', ?, ?, ?, 'test', ?, ?, NULL, 'test', ?)`);
  for (let i = 0; i < TEST_ROWS; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    tx.run(`2026-07-${day}`, i, `Test payment ${i}`, `x${i}`, `test-${i}`, `row ${i + 1}`);
  }
  ctx = { db: t.db, dataDir: t.dataDir, now: new Date('2026-11-05T15:00:00Z') };
});
after(() => t && t.close());

describe('registry', () => {
  test('entries have the frozen shape and names', () => {
    const names = tools.map(x => x.name);
    assert.equal(new Set(names).size, names.length, 'names are unique');
    assert.deepEqual(names, [...names].sort(), 'the loader sorts tools by name');
    for (const name of FROZEN) assert.ok(names.includes(name), `missing tool ${name}`);
    for (const x of tools) {
      assert.equal(typeof x.name, 'string');
      assert.ok(typeof x.description === 'string' && x.description.length > 0, `${x.name} description`);
      assert.equal(x.inputSchema && x.inputSchema.type, 'object', `${x.name} inputSchema`);
      assert.ok(['read', 'write'].includes(x.kind), `${x.name} scope`);
      assert.equal(typeof x.handler, 'function');
    }
    const writes = tools.filter(x => x.operations.some(o => o.scope === 'write:recs' || o.scopes?.includes('write:recs'))).map(x => x.name);
    assert.deepEqual(writes, ['act_on_recommendation', 'undo']);
  });

  test('MCP scope filtering sorts even an unsorted registry and preserves each scope', () => {
    for (const scopes of [['read'], ['write:recs'], ['read', 'write:facts', 'write:goals'], []]) {
      const expected = tools.filter(tool => tool.operations.some(o => (o.scopes || [o.scope]).some(s => scopes.includes(s)))).map(tool => tool.name).sort();
      assert.deepEqual(toolsForScopes(scopes, [...tools].reverse()).map(tool => tool.name), expected);
    }
  });

  test('the loader collects catalog tools, route declarations and unique capabilities', async () => {
    const directory = new URL('../src/tools/catalog/', import.meta.url);
    const modules = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.mjs')).sort()
      .map(name => import(new URL(name, directory))));
    assert.ok(modules.length > 0);
    const names = [...new Set(modules.flatMap(module => module.operations || []).map(op => op.tool))].sort();
    assert.deepEqual(names, tools.map(tool => tool.name));
    const routes = {};
    for (const module of modules) for (const op of module.operations || []) for (const route of op.routes) {
      routes[route] = [...new Set([...(routes[route] || []), `${op.tool}.${op.name}`])].sort();
    }
    assert.ok(Object.keys(routes).length > 0, 'catalog modules declare route parity');
    assert.deepEqual(parity, routes);
    for (const names of Object.values(parity)) for (const name of names) assert.ok(getTool(name.split('.')[0])?.operations.some(o => o.name === name.split('.')[1]), name);
    assert.deepEqual(CAPABILITIES, [...new Set(modules.flatMap(module => module.capabilities || []))].sort());
  });

  test('getTool finds by name; unknown tools are not_found', async () => {
    assert.equal(getTool('household').name, 'household');
    assert.ok(!getTool('no_such_tool'));
    await assert.rejects(call('no_such_tool', {}), isCode('not_found'));
  });
});

describe('read tools', () => {
  test('household', async () => {
    const r = await call('household', { operation: 'summary' });
    const visible = demo.recs.filter(x => novemberStatus(x) !== 'hidden');
    const ny = visible.filter(x => needsRule(novemberStatus(x), x)).length;
    assert.equal(r.verdictLevel, ny ? 'attention' : 'clear');
    assert.equal(r.needsYouCount, ny);
    const counts = {};
    for (const x of visible) counts[novemberStatus(x)] = (counts[novemberStatus(x)] || 0) + 1;
    assert.deepEqual(r.statusCounts, counts);
    assert.equal(r.dataThrough, demo.meta.dataThrough);
    assert.equal(r.clock, '2026-11-05');
    assert.equal(r.facts['household.dependents'], 1);
    assert.equal(r.facts['income.sCorp'], true);
  });

  test('household.facts with and without keys', async () => {
    const all = await call('household', { operation: 'facts' });
    const dep = all.find(f => f.key === 'household.dependents');
    assert.deepEqual({ value: dep.value, src: dep.src, asOf: dep.asOf, confirmed: !!dep.confirmed },
      { value: 1, src: 'you', asOf: '2026-11-01', confirmed: true });
    const some = await call('household', { operation: 'facts',  keys: ['income.sCorp'] });
    assert.deepEqual(some.map(f => [f.key, f.value]), [['income.sCorp', true]]);
    await assert.rejects(call('household', { operation: 'facts',  keys: 'income.sCorp' }), isCode('bad_input'));
  });

  test('accounts.list returns masks and latest balances only', async () => {
    const rows = await call('accounts', { operation: 'list' });
    for (const a of demo.accounts) {
      const got = rows.find(x => x.id === a.id);
      assert.ok(got, a.id);
      if (a.fig) {
        assert.equal(got.balance, demo.fig[a.fig].v, `${a.id} balance`);
        assert.equal(got.asOf, '2026-08-30');
      }
    }
    for (const a of rows) {
      assert.ok(a.mask === null || a.mask === undefined || /^\d{4}$/.test(a.mask), `${a.id} mask`);
      for (const k of Object.keys(a)) assert.ok(!/number/i.test(k), `${a.id} exposes ${k}`);
    }
  });

  test('accounts.list returns imported account strings verbatim and still resolves demo tokens', async () => {
    t.db.prepare(`INSERT INTO accounts (id, inst, mask, name, owner, kind, mirror, note, fig_key, file_id, parser, locator)
                  VALUES ('acct_imported', 'Inst {n:owner}', '9876', 'Bank {f:nope} <b>x</b>', 'Owner {n:owner}', 'checking', 'aggregator', 'Note {f:nope}', NULL, NULL, 'aggregator', 'row 0')`).run();
    try {
      const rows = await call('accounts', { operation: 'list' });
      const got = rows.find(x => x.id === 'acct_imported');
      assert.ok(got);
      assert.equal(got.name, 'Bank {f:nope} <b>x</b> (9876)');
      assert.equal(got.inst, 'Inst {n:owner}');
      assert.equal(got.owner, 'Owner {n:owner}');
      assert.equal(got.note, 'Note {f:nope}');
      const seeded = t.db.prepare("SELECT id, name FROM accounts WHERE parser = 'demo-seed'").all();
      assert.ok(seeded.length > 0);
      for (const a of demo.accounts) assert.ok(rows.find(x => x.id === a.id), a.id);
    } finally {
      t.db.prepare("DELETE FROM accounts WHERE id = 'acct_imported'").run();
    }
  });

  test('accounts.holdings with an account filter', async () => {
    const all = await call('accounts', { operation: 'holdings' });
    assert.ok(all.length > 0);
    const acct = all[0].accountId;
    const one = await call('accounts', { operation: 'holdings',  id: acct });
    assert.ok(one.length > 0 && one.every(p => p.accountId === acct));
    assert.equal(one.length, count('SELECT count(*) AS n FROM positions WHERE account_id = ?', acct));
    for (const p of one) assert.ok(p.symbol && p.name && typeof p.value === 'number');
  });

  test('business.pnl keeps entity and custom period totals', async () => {
    const entity = t.db.prepare('SELECT entity FROM pnl_lines LIMIT 1').get().entity;
    const r = await call('business', { operation: 'pnl', entity, from: '2026-03', to: '2026-05' });
    assert.equal(r.entities.length, 1);
    for (const group of r.entities[0].groups) {
      const want = t.db.prepare('SELECT sum(amount) AS s FROM pnl_lines WHERE entity = ? AND period = ?').get(entity, group.key).s;
      assert.equal(group.profit.value, Math.round(want * 100) / 100);
    }
    assert.ok((await call('business', {operation:'pnl'})).entities.length >= r.entities.length);
  });

  test('recommendations.list never returns hidden recs and filters by status', async () => {
    const all = await call('recommendations', { operation: 'list' });
    assert.ok(all.length > 0);
    assert.ok(!all.some(r => r.status === 'hidden' || r.id === 'daf'));
    const proposed = await call('recommendations', { operation: 'list',  status: 'proposed' });
    assert.deepEqual(proposed.map(r => r.id).sort(), demo.recs.filter(r => novemberStatus(r) === 'proposed').map(r => r.id).sort());
    const two = await call('recommendations', { operation: 'list',  status: ['done', 'dismissed'] });
    assert.deepEqual(two.map(r => r.id).sort(), demo.recs.filter(r => ['done', 'dismissed'].includes(novemberStatus(r))).map(r => r.id).sort());
    let hidden;
    try { hidden = await call('recommendations', { operation: 'list',  status: 'hidden' }); } catch (e) { assert.ok(isCode('bad_input')(e)); }
    if (hidden) assert.deepEqual(hidden, []);
  });

  test('recommendations.detail returns the rec or not_found', async () => {
    const d = demo.recs.find(r => r.id === 'deferral');
    const r = await call('recommendations', { operation: 'detail',  id: 'deferral' });
    assert.equal(r.id, 'deferral');
    assert.equal(r.title, d.title);
    assert.equal(r.status, 'proposed');
    assert.equal(r.tasks.length, d.tasks.length);
    await assert.rejects(call('recommendations', { operation: 'detail',  id: 'no-such-rec' }), isCode('not_found'));
    await assert.rejects(call('recommendations', { operation: 'detail', }), isCode('bad_input'));
    await assert.rejects(call('recommendations', { operation: 'detail',  id: 5 }), isCode('bad_input'));
  });

  test('household.deadlines with a date range', async () => {
    const all = await call('household', { operation: 'deadlines' });
    assert.equal(all.length, demo.deadlines.length);
    const dec = await call('household', { operation: 'deadlines',  from: '2026-12-01', to: '2026-12-31' });
    const want = demo.deadlines.filter(d => d.date >= '2026-12-01' && d.date <= '2026-12-31');
    const key = d => `${d.date} ${d.title}`;
    assert.deepEqual(dec.map(key).sort(), want.map(key).sort());
    assert.ok(dec.every((d, i) => i === 0 || dec[i - 1].date <= d.date), 'sorted by date');
  });

  test('goals', async () => {
    const goals = await call('goals', { operation: 'list' });
    assert.deepEqual(goals.map(g => g.id), [...demo.goals, ...KIND_GOALS].map(g => g.id));
  });

  test('household.figures includes the source label and asOf', async () => {
    const two = await call('household', { operation: 'figures',  keys: ['biz_cash', 'personal_cash'] });
    assert.equal(two.length, 2);
    for (const f of two) {
      const want = demo.fig[f.key];
      assert.deepEqual(
        { v: f.v, kind: f.kind, label: f.label, source: { ...f.source } },
        { v: want.v, kind: want.kind, label: want.label, source: { id: want.src, label: demo.src[want.src].label, asOf: demo.src[want.src].asOf } });
      const stored = t.db.prepare('SELECT locator FROM figures WHERE key = ?').get(f.key);
      let locator = stored.locator;
      try { locator = JSON.parse(locator); } catch {}
      assert.equal(f.value, f.v);
      assert.equal(f.unit, 'usd');
      assert.equal(f.asOf, f.source.asOf || null);
      assert.deepEqual(f.provenance.stored, { src: want.src, locator });
      assert.deepEqual(f.ref, { tool: 'household', args: { operation: 'figures',  keys: [f.key] }, path: '0' });
    }
    await assertRefsResolve(two, ctx);
    const all = await call('household', { operation: 'figures' });
    for (const k of Object.keys(demo.fig)) assert.ok(all.some(f => f.key === k), `figure ${k}`);
    await assertRefsResolve(all, ctx);
  });

  test('household.figures preserves an unavailable legacy value while its envelope is unavailable', async () => {
    const key = 'test.unavailable.total';
    const locator = { calc: 'test.total', computedOn: '2026-10-31', inputs: { total: 123.456 },
      sources: [{ rows: { table: 'facts', ids: ['test.total'], count: 1 } }],
      steps: [{ label: 'Stored total', formula: 'stored total', value: 123.456 }] };
    t.db.prepare(`INSERT INTO figures (key,v,src,kind,label,locator,unavailable_reason,updated_at)
                  VALUES (?,123.456,'model','e','Stored total',?,'waiting for current inputs','2026-11-01')`)
      .run(key, JSON.stringify(locator));
    try {
      const result = await call('household', { operation: 'figures',  keys: [key] });
      assert.equal(result.length, 1);
      assert.equal(result[0].v, 123.456);
      assert.equal(result[0].value, null);
      assert.equal(result[0].unavailable, 'waiting for current inputs');
      assert.equal(result[0].asOf, locator.computedOn);
      assert.deepEqual(result[0].provenance.stored, { src: 'model', locator });
      await assertRefsResolve(result, ctx);
    } finally {
      t.db.prepare('DELETE FROM figures WHERE key = ?').run(key);
    }
  });

  test('reference assertions reject empty results and compare the complete replayed envelope', async () => {
    await assert.rejects(assertRefsResolve({}, ctx), /at least one figure/);
    const result = await call('household', { operation: 'figures',  keys: ['biz_cash'] });
    await assertRefsResolve(result, ctx);
    const changed = structuredClone(result);
    changed[0].provenance = { ...changed[0].provenance, calc: 'different calculation' };
    await assert.rejects(assertRefsResolve(changed, ctx), /resolves through/);
  });

  test('knowledge', async () => {
    const packs = await call('knowledge', { operation: 'packs' });
    for (const id of demo.packs.map(p => p.id)) assert.ok(packs.some(p => p.id === id), id);
    const by = Object.fromEntries(packs.map(p => [p.id, p]));
    assert.equal(by.scorp.status, 'active');
    assert.equal(by.giving.status, 'suggested');
    assert.equal(by.contractor.status, 'available');
    for (const p of packs) assert.ok(p.name && typeof p.why === 'string', p.id);
  });
});

describe('transactions', () => {
  test('defaults to 50 rows and reports truncated and total', async () => {
    const r = await call('transactions', { operation: 'search',  accountId: 'acct_test' });
    assert.equal(r.rows.length, 50);
    assert.equal(r.total, TEST_ROWS);
    assert.equal(r.truncated, true);
    assert.ok(r.rows.every(x => x.accountId === 'acct_test'));
  });

  test('caps at 200 and rejects a larger limit', async () => {
    const r = await call('transactions', { operation: 'search',  accountId: 'acct_test', limit: 200 });
    assert.equal(r.rows.length, 200);
    assert.equal(r.truncated, true);
    await assert.rejects(call('transactions', { operation: 'search',  limit: 201 }), isCode('bad_input'));
    await assert.rejects(call('transactions', { operation: 'search',  limit: 0 }), isCode('bad_input'));
    const small = await call('transactions', { operation: 'search',  accountId: 'acct_test', minAmount: 0, maxAmount: 9, limit: 200 });
    assert.equal(small.rows.length, 10);
    assert.equal(small.truncated, false);
    assert.equal(small.total, 10);
  });

  test('honors each filter', async () => {
    const amt = await call('transactions', { operation: 'search',  accountId: 'acct_test', minAmount: 100, maxAmount: 149, limit: 200 });
    assert.equal(amt.total, 50);
    assert.ok(amt.rows.every(x => x.amount >= 100 && x.amount <= 149));

    const dates = await call('transactions', { operation: 'search',  accountId: 'acct_test', from: '2026-07-10', to: '2026-07-12', limit: 200 });
    assert.equal(dates.total, count("SELECT count(*) AS n FROM transactions WHERE account_id = 'acct_test' AND date BETWEEN '2026-07-10' AND '2026-07-12'"));
    assert.ok(dates.rows.every(x => x.date >= '2026-07-10' && x.date <= '2026-07-12'));

    const cat = await call('transactions', { operation: 'search',  category: 'test', limit: 200 });
    assert.equal(cat.total, TEST_ROWS);
    assert.ok(cat.rows.every(x => x.category === 'test'));

    const text = await call('transactions', { operation: 'search',  text: 'TEST PAYMENT 12', limit: 200 });
    assert.equal(text.total, count("SELECT count(*) AS n FROM transactions WHERE lower(description) LIKE '%test payment 12%'"));
    assert.ok(text.total > 0);
    assert.ok(text.rows.every(x => x.description.toLowerCase().includes('test payment 12')));

    const seededAcct = t.db.prepare("SELECT account_id FROM transactions WHERE account_id <> 'acct_test' LIMIT 1").get().account_id;
    const acct = await call('transactions', { operation: 'search',  accountId: seededAcct, limit: 200 });
    assert.equal(acct.total, count('SELECT count(*) AS n FROM transactions WHERE account_id = ?', seededAcct));
    assert.ok(acct.rows.every(x => x.accountId === seededAcct));
  });

  test('bad input is refused and valid input is not', async () => {
    await assert.rejects(call('transactions', { operation: 'search',  minAmount: 'ten' }), isCode('bad_input'));
    await assert.rejects(call('transactions', { operation: 'search',  accountId: 3 }), isCode('bad_input'));
    await assert.rejects(call('transactions', { operation: 'search',  limit: 'all' }), isCode('bad_input'));
    const r = await call('transactions', { operation: 'search',  minAmount: 10, limit: 1 });
    assert.equal(r.rows.length, 1);
  });
});

describe('act_on_recommendation', () => {
  test('persists and records a rec_event with actor tool', async () => {
    const r = await call('act_on_recommendation', { operation: 'status',  id: 'dcfsa', status: 'done' });
    assert.equal(r.status, 'done');
    assert.equal(t.db.prepare("SELECT status FROM recs WHERE id = 'dcfsa'").get().status, 'done');
    const ev = t.db.prepare("SELECT action, from_status, to_status, actor FROM rec_events WHERE rec_id = 'dcfsa' ORDER BY id DESC LIMIT 1").get();
    assert.deepEqual({ from: ev.from_status, to: ev.to_status, actor: ev.actor }, { from: 'proposed', to: 'done', actor: 'demo' });
    assert.equal((await call('recommendations', { operation: 'detail',  id: 'dcfsa' })).status, 'done');
  });

  test('snoozed keeps the wake label', async () => {
    await call('act_on_recommendation', { operation: 'status',  id: 'va529', status: 'snoozed', wake: 'Dec 10 check-in' });
    const r = await call('recommendations', { operation: 'detail',  id: 'va529' });
    assert.equal(r.status, 'snoozed');
    assert.equal(r.wake, 'Dec 10 check-in');
  });

  test('rejects invalid statuses, unknown recs and hidden recs', async () => {
    await assert.rejects(call('act_on_recommendation', { operation: 'status',  id: 'vaq4', status: 'bogus' }), isCode('bad_input'));
    await assert.rejects(call('act_on_recommendation', { operation: 'status',  id: 'vaq4', status: 'hidden' }), isCode('bad_input'));
    await assert.rejects(call('act_on_recommendation', { operation: 'status',  id: 'vaq4' }), isCode('bad_input'));
    await assert.rejects(call('act_on_recommendation', { operation: 'status',  id: 'no-such-rec', status: 'done' }), isCode('not_found'));
    await assert.rejects(call('act_on_recommendation', { operation: 'status',  id: 'daf', status: 'proposed' }), isCode('not_found'));
    assert.equal(t.db.prepare("SELECT status FROM recs WHERE id = 'daf'").get().status, 'hidden');
    for (const status of ['doing', 'dismissed', 'proposed']) {
      const r = await call('act_on_recommendation', { operation: 'status',  id: 'vaq4', status });
      assert.equal(r.status, status);
    }
    // The retired 'accepted' status is refused, not mapped.
    await assert.rejects(call('act_on_recommendation', { operation: 'status',  id: 'vaq4', status: 'accepted' }), isCode('bad_input'));
  });

  test('an ISO string or epoch ms ctx.now is honored the same as a Date', async () => {
    const iso = '2027-03-04T10:20:30.000Z';
    const lastTs = () => t.db.prepare("SELECT ts FROM rec_events WHERE rec_id = 'vaq4' ORDER BY id DESC LIMIT 1").get().ts;
    for (const now of [new Date(iso), iso, Date.parse(iso)]) {
      await callTool('act_on_recommendation', { operation: 'status',  id: 'vaq4', status: 'doing' }, { db: t.db, now });
      assert.equal(lastTs(), iso, `rec_event ts for ${typeof now} now`);
    }
    // Without a store clock, "today" comes from ctx.now.
    const stored = t.db.prepare("SELECT value FROM settings WHERE key = 'clock'").get().value;
    t.db.prepare("DELETE FROM settings WHERE key = 'clock'").run();
    try {
      for (const now of [new Date(iso), iso]) {
        assert.equal((await callTool('household', { operation: 'summary', }, { db: t.db, now })).clock, '2027-03-04', `clock for ${typeof now} now`);
      }
    } finally {
      t.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('clock', ?, '2026-11-05T00:00:00Z')").run(stored);
    }
  });
});

describe('ctx.clock (FATHOM_CLOCK)', () => {
  test('ctx.clock overrides the store clock; absent, the store clock still decides', async () => {
    const stored = (await callTool('household', { operation: 'summary', }, { db: t.db, now: new Date() })).clock;
    assert.equal((await callTool('household', { operation: 'summary', }, { db: t.db, now: new Date(), clock: '2027-01-05' })).clock, '2027-01-05');
    assert.equal((await callTool('household', { operation: 'summary', }, { db: t.db, now: new Date(), clock: null })).clock, stored);
  });
});

describe('input schema strictness', () => {
  function walk(schema, path, problems) {
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
      problems.push(`${path}: schema is not an object`);
      return;
    }
    if (Array.isArray(schema.type)) problems.push(`${path}: type is an array (union types are refused)`);
    if (schema.properties !== undefined && schema.type !== 'object') problems.push(`${path}: has properties but type is not 'object'`);
    if (Array.isArray(schema.required)) {
      const props = schema.properties || {};
      for (const name of schema.required) {
        if (!Object.hasOwn(props, name)) problems.push(`${path}: required '${name}' is not in properties`);
      }
    }
    if (schema.properties) {
      for (const [k, v] of Object.entries(schema.properties)) walk(v, `${path}.properties.${k}`, problems);
    }
    if (schema.items !== undefined) walk(schema.items, `${path}.items`, problems);
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(schema[key])) schema[key].forEach((s, i) => walk(s, `${path}.${key}[${i}]`, problems));
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      walk(schema.additionalProperties, `${path}.additionalProperties`, problems);
    }
  }

  test('every tool name is valid and unique, and every inputSchema is strict-compiler compatible', () => {
    const names = tools.map(x => x.name);
    assert.equal(new Set(names).size, names.length, 'names are unique');
    const problems = [];
    for (const x of tools) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(x.name)) problems.push(`${x.name}: invalid tool name`);
      walk(x.inputSchema, x.name, problems);
    }
    assert.deepEqual(problems, []);
  });

  test('recommendations.list accepts a single status string and an array of statuses', async () => {
    const all = await call('recommendations', { operation: 'list', });
    assert.ok(all.length > 0);
    const status = all[0].status;
    const one = await call('recommendations', { operation: 'list',  status });
    const many = await call('recommendations', { operation: 'list',  status: [status] });
    assert.ok(one.length > 0);
    assert.ok(one.every(r => r.status === status));
    assert.deepEqual(many.map(r => r.id), one.map(r => r.id));
  });
});

describe('review advisories', () => {
  test('invalid anyOf inputs for recommendations.list are refused with bad_input', async () => {
    await assert.rejects(call('recommendations', { operation: 'list',  status: 42 }), isCode('bad_input'));
    await assert.rejects(call('recommendations', { operation: 'list',  status: ['doing', 'not-a-status'] }), isCode('bad_input'));
  });

  test('a conflicting ctx.now does not override the store clock; epoch ms is accepted', async () => {
    const seeded = (await call('household', { operation: 'summary' })).clock;
    for (const now of ['2030-01-02T03:04:05.000Z', Date.parse('2030-01-02T03:04:05.000Z'), new Date('2030-01-02T03:04:05.000Z')]) {
      assert.equal((await callTool('household', { operation: 'summary', }, { db: t.db, now })).clock, seeded, `clock for ${typeof now} now`);
    }
  });
});

describe('engine compatibility', () => {
  const engineCtx = () => ({ db: t.db, now: '2026-11-05T15:00:00.000Z' });

  test('every inputSchema compiles under strict Ajv', () => {
    for (const x of tools) assert.doesNotThrow(() => compileSchema(x.inputSchema), `${x.name} compiles`);
  });

  test('createRegistryServer accepts the registry; the job purpose drops the write tools', () => {
    const chat = createRegistryServer(tools, { purpose: 'chat', ctx: engineCtx() });
    for (const x of tools.filter(t => !t.mcpOnly)) assert.ok(chat.names.includes(x.name), `chat offers ${x.name}`);
    assert.ok(chat.names.includes('act_on_recommendation'));
    assert.ok(chat.names.includes('act_on_recommendation'));
    const job = createRegistryServer(tools, { purpose: 'job', ctx: engineCtx() });
    assert.ok(!job.names.includes('act_on_recommendation'));
    assert.ok(!job.names.includes('act_on_recommendation'));
    assert.equal(job.names.length, tools.filter(t => t.kind === 'read').length);
  });

  test('invoke matches callTool, rejects bad input and fetches a real rec', async () => {
    const server = createRegistryServer(tools, { purpose: 'chat', ctx: engineCtx() });
    const ok = await server.invoke('recommendations', { operation: 'list', });
    assert.ok(!ok.isError);
    const expected = await call('recommendations', { operation: 'list', });
    assert.deepEqual(JSON.parse(ok.content[0].text), JSON.parse(JSON.stringify(expected)));
    const bad = await server.invoke('recommendations', { operation: 'list',  status: 42 });
    assert.equal(bad.isError, true);
    const got = await server.invoke('recommendations', { operation: 'detail',  id: expected[0].id });
    assert.ok(!got.isError);
    assert.equal(JSON.parse(got.content[0].text).id, expected[0].id);
  });
});

test('resolved transaction filters and keyset pages preserve every tied real-store row', async t => {
  const { spendingStore } = await import('./helpers/spending.mjs');
  const s = await spendingStore(t); s.account('paged', 'card');
  for (let i=0;i<450;i++) s.tx('paged',i<300?'2026-10-01':'2026-10-02',-12,'Groceries','Example Market');
  const args={operation:'search',accountId:'paged',bucket:'household',class:'essential_other',merchant:'example market',limit:200};
  const seen=[]; let next;
  do {
    const page=await callTool('transactions',{...args,...(next?{cursor:next}:{})},s.ctx);
    assert.equal(page.total,450);
    for(const row of page.rows) { assert.equal(row.category,'Groceries'); assert.equal(row.bucket,'household'); assert.equal(row.class,'essential_other'); assert.equal(row.layer,'import'); assert.equal(row.merchant,'example market'); seen.push(row.id); }
    next=page.next;
  } while(next);
  assert.equal(seen.length,450); assert.equal(new Set(seen).size,450);
  await assert.rejects(callTool('transactions',{operation:'search',cursor:'invalid'},s.ctx),e=>e.code==='bad_input');
});
