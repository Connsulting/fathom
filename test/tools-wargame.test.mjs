import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../demo/seed.mjs';
import { tempDb } from './helpers/server.mjs';
import { assertRefsResolve, envelopeEntries } from './helpers/figures.mjs';
import { callTool, getTool } from '../src/tools/index.mjs';
import { plainDeep } from '../src/tools/catalog/figures.mjs';
import { buildScenario, tokenScope } from '../src/scenario/build.mjs';
import { setSetting } from '../src/store/db.mjs';
import { loadPlanningData, resolveEntities } from '../src/jobs/planner/data.mjs';
import { createOut } from '../src/jobs/planner/figures.mjs';
import { buildWargames } from '../src/jobs/planner/wargame.mjs';
import { notBuiltReason } from '../src/jobs/planner/unlocks.mjs';
import { householdTax } from '../src/jobs/planner/household.mjs';
import { payrollTax, TAX_2026 } from '../src/calc/index.mjs';

import { SCORP } from './helpers/real-store.mjs';

const CLOCK = '2026-11-05';
const call = (ctx, name) => callTool('recommendations', { operation: 'wargame', name }, ctx);

async function store(t, { planned = true } = {}) {
  const s = await tempDb();
  t.after(() => s.close());
  await seedDemo(s.db);
  const ctx = { db: s.db, dataDir: s.dataDir, clock: CLOCK };
  if (!planned) return ctx;
  const data = await loadPlanningData(s.db, CLOCK);
  const entity = resolveEntities(data, {})[0];
  entity.sums = { income: SCORP.income * entity.months,
    net: (SCORP.income - Object.values(SCORP.expenses).reduce((a, b) => a + b, 0)) * entity.months,
    salary: SCORP.expenses['Officer salary'] * entity.months,
    payrollTax: SCORP.expenses['Payroll taxes'] * entity.months };
  entity.classified = true;
  entity.proj = value => value * 12 / entity.months;
  const gross = entity.proj(entity.sums.salary);
  const P = entity.proj(entity.sums.net + entity.sums.salary + entity.sums.payrollTax);
  const corp = { entity, P, gross, comp: gross, person: 'owner' };
  const parts = { f: 'mfj', persons: ['owner'], state: 'VA',
    w2: [{ src: `corp:${entity.slug}`, person: 'owner', gross, comp: gross, agi: gross }],
    biz: [{ id: entity.slug, person: 'owner', kind: 'scorp',
      agi: P - gross - payrollTax({ wages: gross, filingStatus: 'mfj' }).value.employerTotal,
      qbi: P - gross - payrollTax({ wages: gross, filingStatus: 'mfj' }).value.employerTotal,
      w2Wages: gross }], children: 0 };
  const out = createOut(CLOCK);
  const model = buildWargames(data, out, { clock: CLOCK, f: parts.f, parts, corp,
    entities: [entity], accounts: data.accounts, owner: {
      'business.salaryRange': { min: gross * 0.6, max: gross * 1.4 },
      'business.cashBasis': true, 'retirement.planOffersRoth': true,
    }, contrib: { owner: { outsideKnown: true, all401k: 0, byPlan: {} } },
    ageOf: () => 55, ageKey: () => 'household.age', retireMissing: [],
    priorWages: TAX_2026.retirement.rothCatchUpPriorWages + 1, householdTax });
  assert.ok(model.salary?.points.length > 1, JSON.stringify(out.info));
  assert.ok(model.deferral?.options.length > 1, JSON.stringify(out.info));
  // writeFigures is private to planner.mjs; persist its pure writer's rows with the same columns.
  const put = s.db.prepare(`INSERT INTO figures (key, v, kind, label, src, locator, parser, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'planner', ?)`);
  for (const f of Object.values(out.figures)) {
    await put.run(f.key, f.v, f.kind, f.label, f.src, JSON.stringify(f.locator), CLOCK);
  }
  await s.db.prepare("UPDATE content SET value = ? WHERE key = 'wargame'").run(JSON.stringify(model));
  return ctx;
}

const salaryFields = { salary: 'salary', payroll: 'payroll', distributions: 'dist', tax: 'tax', room: 'x', rothRoom: 'roth', taxChange: 'y' };
const deferralFields = { amount: 'amount', taxThisYear: 'tax2026', taxNextYear: 'tax2027', net: 'net', decemberCash: 'decCash', payrollNeed: 'need', gap: 'gap' };

for (const name of ['salary', 'deferral']) test(`${name} returns the planner's stored figures, scenario state and resolvable refs`, async t => {
  const ctx = await store(t);
  const scenario = await buildScenario(ctx.db, { clock: CLOCK });
  const list = name === 'salary' ? scenario.wargame.salary.points : scenario.wargame.deferral.options;
  await setSetting(ctx.db, 'wargame.picks', { [name]: list.length - 1 });
  const result = await call(ctx, name);
  assert.equal(result.name, name);
  assert.equal(result.title, scenario.wargame[name].title);
  assert.equal(result.question, scenario.wargame[name].question);
  assert.equal(result.status, scenario.wargame[name].status);
  const decision = scenario.decisions.find(d => d.wargame === name);
  assert.deepEqual(result.decision, decision ? { id: decision.id, status: decision.status,
    ...(decision.line ? { decidedLine: plainDeep(await tokenScope(ctx.db), decision.line) } : {}) } : null);
  assert.equal(result.picked, list.at(-1).id);
  assert.equal(result.asOf, CLOCK);
  const items = name === 'salary' ? result.salary.points : result.deferral.options;
  assert.equal(items.length, list.length);
  for (const [index, item] of items.entries()) {
    assert.equal(item.id, list[index].id);
    for (const [field, suffix] of Object.entries(name === 'salary' ? salaryFields : deferralFields)) {
      const row = await ctx.db.prepare('SELECT * FROM figures WHERE key = ?').get(`wg.${name}.${item.id}.${suffix}`);
      assert.ok(row, `${name}.${field} exists`);
      const f = item.figures[field];
      assert.equal(f.value, row.v);
      assert.equal(f.label, row.label);
      assert.equal(f.kind, 'm');
      assert.equal(f.asOf, CLOCK);
      assert.deepEqual(f.provenance.stored.locator, JSON.parse(row.locator));
    }
  }
  if (name === 'deferral') assert.equal(result.deferral.monthlyInvoices.value,
    (await ctx.db.prepare("SELECT v FROM figures WHERE key = 'wg.deferral.base.income'").get()).v);
  assert.ok(getTool('recommendations').operations.find(o => o.name === 'wargame').referenceable);
  await assertRefsResolve(result, ctx);
});

test('missing stored fields are unavailable even when content has a numeric value', async t => {
  const ctx = await store(t);
  const game = (await buildScenario(ctx.db, { clock: CLOCK })).wargame.salary;
  await ctx.db.prepare('DELETE FROM figures WHERE key = ?').run(`wg.salary.${game.points[0].id}.x`);
  const result = await call(ctx, 'salary');
  assert.equal(result.salary.points[0].figures.room.value, null);
  assert.match(result.salary.points[0].figures.room.gaps[0].message, /stored figure/i);
  assert.ok(result.salary.points[1].figures.room.value > 0);
  await assertRefsResolve(result, ctx);
});

test('unplanned demo returns unavailable envelopes without manufacturing stored figures', async t => {
  const ctx = await store(t, { planned: false });
  for (const name of ['salary', 'deferral']) {
    const result = await call(ctx, name);
    assert.ok(envelopeEntries(result).length > 0);
    assert.ok(envelopeEntries(result).every(({ figure }) => figure.value === null && figure.unavailable));
    await assertRefsResolve(result, ctx);
  }
  assert.equal((await ctx.db.prepare("SELECT count(*) AS n FROM figures WHERE key LIKE 'wg.%'").get()).n, 0);
});

test('no S corp returns not_built with the planner reason and no points', async t => {
  const s = await tempDb();
  t.after(() => s.close());
  const ctx = { db: s.db, dataDir: s.dataDir, clock: CLOCK };
  const result = await call(ctx, 'salary');
  assert.equal(result.status, 'not_built');
  assert.deepEqual(result.notBuilt, notBuiltReason('salary', 'inputs_changed'));
  assert.equal(result.picked, null);
  assert.equal(result.decision, null);
  assert.equal(result.salary, undefined);
});

test('stored not-built reason is preserved', async t => {
  const ctx = await store(t, { planned: false });
  const notBuilt = notBuiltReason('salary', 'business.salaryRange');
  await ctx.db.prepare("UPDATE content SET value = ? WHERE key = 'wargame'").run(JSON.stringify({ notBuilt: { salary: notBuilt } }));
  assert.deepEqual((await call(ctx, 'salary')).notBuilt, notBuilt);
});

test('unavailable games keep reference points; decided and upcoming statuses follow scenario', async t => {
  const ctx = await store(t);
  const raw = JSON.parse((await ctx.db.prepare("SELECT value FROM content WHERE key = 'wargame'").get()).value);
  raw.deferral.unavailable = 'Inputs changed';
  await ctx.db.prepare("UPDATE content SET value = ? WHERE key = 'wargame'").run(JSON.stringify(raw));
  await ctx.db.prepare("UPDATE decisions SET unavailable_reason = 'Inputs changed' WHERE wargame = 'deferral'").run();
  const result = await call(ctx, 'deferral');
  assert.equal(result.status, 'unavailable');
  assert.ok(result.deferral.options.length > 1);
  assert.equal(result.action, undefined);
  await ctx.db.prepare("UPDATE decisions SET status = 'decided', decided_line = 'Saved choice' WHERE wargame = 'deferral'").run();
  assert.equal((await call(ctx, 'deferral')).status, 'decided');
  assert.equal((await call(ctx, 'deferral')).decision.decidedLine, 'Saved choice');
  delete raw.deferral.unavailable;
  await ctx.db.prepare("UPDATE content SET value = ? WHERE key = 'wargame'").run(JSON.stringify(raw));
  await ctx.db.prepare("UPDATE decisions SET status = 'upcoming', decided_line = NULL, unavailable_reason = NULL, opens_on = '2027-01-01' WHERE wargame = 'deferral'").run();
  assert.equal((await call(ctx, 'deferral')).status, 'upcoming');
});

test('wargame requires an allowed name and refuses extra arguments', async t => {
  const ctx = await store(t, { planned: false });
  for (const args of [{ operation: 'wargame' }, { operation: 'wargame', name: 'other' },
    { operation: 'wargame', name: 'salary', amount: 1 }]) {
    await assert.rejects(callTool('recommendations', args, ctx), { code: 'bad_input' });
  }
  assert.ok((await call(ctx, 'salary')).salary.points.length > 0);
});

test('deferral tax years stay in order when a stored field is missing', async t => {
  const ctx = await store(t);
  const option = (await buildScenario(ctx.db, { clock: CLOCK })).wargame.deferral.options[0];
  await ctx.db.prepare('DELETE FROM figures WHERE key = ?').run(`wg.deferral.${option.id}.tax2026`);
  const result = await call(ctx, 'deferral');
  assert.equal(result.deferral.options[0].figures.taxThisYear.value, null);
  assert.equal(result.deferral.options[0].figures.taxNextYear.value,
    (await ctx.db.prepare('SELECT v FROM figures WHERE key = ?').get(`wg.deferral.${option.id}.tax2027`)).v);
  await assertRefsResolve(result, ctx);
});

test('stored unavailable figures keep the planner gap and date', async t => {
  const ctx = await store(t);
  const id = (await buildScenario(ctx.db, { clock: CLOCK })).wargame.salary.points[0].id;
  await ctx.db.prepare('UPDATE figures SET unavailable_reason = ? WHERE key = ?')
    .run('Inputs changed since planning', `wg.salary.${id}.tax`);
  const f = (await call(ctx, 'salary')).salary.points[0].figures.tax;
  assert.equal(f.value, null);
  assert.equal(f.asOf, CLOCK);
  assert.match(f.gaps[0].message, /Inputs changed since planning/);
});
