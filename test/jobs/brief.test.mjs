// AC6: the brief the planner writes for a real store: names, meta, verdict, domains, what changed,
// deadlines, decisions and the war games, plus their provenance in the built scenario, which must
// carry none of the demo scenario's names. Includes the R17 build.mjs check that a stored war-game
// figure wins over the derived one while the demo store is unchanged.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runPlanning } from '../../src/jobs/planner.mjs';
import { buildScenario, loadRecs, loadContent } from '../../src/scenario/build.mjs';
import { needsYou } from '../../src/shared/rules.mjs';
import { solo401kRoom, payrollTax } from '../../src/calc/index.mjs';
import { openStore } from '../../src/server.mjs';
import demo from '../../demo/scenario.mjs';
import {
  scratch, addFact, contentValue, figureRow, recRow, activeRecIds, PACKS_DIR, SCORP, SYNTH,
} from '../helpers/real-store.mjs';

const NOW = '2026-11-05';
const S = scratch();
after(() => S.cleanup());
const plan = (db, now = NOW) => runPlanning(db, null, { now, packDirs: [PACKS_DIR] });
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const near = (actual, expected, what) =>
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= 0.011, `${what}: expected ${expected}, got ${actual}`);

const NEUTRAL = {
  me: 'You', spouse: 'Your spouse', kid: 'Your child', biz: 'Your business',
  spouseBiz: "Your spouse's business", household: 'Your household',
};
const DEMO_NAMES = [...Object.values(demo.names), demo.meta.household].filter(Boolean);
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const demoNameRe = new RegExp(`\\b(?:${DEMO_NAMES.map(escapeRe).join('|')})\\b`);

const M = 10;
const W = 12 * SCORP.expenses['Officer salary'];
const P = r2((M * (SCORP.income - Object.values(SCORP.expenses).reduce((a, b) => a + b, 0)) + M * SCORP.expenses['Officer salary'] + M * SCORP.expenses['Payroll taxes']) * 12 / M);

let base;
before(async () => {
  base = S.store();
  await plan(base);
});

describe('narrative content', () => {
  test('AC6: names are the neutral labels when the household has no names fact', () => {
    const names = contentValue(base, 'names');
    for (const [k, v] of Object.entries(NEUTRAL)) assert.equal(names[k], v, `names.${k}`);
    const row = base.prepare("SELECT src FROM content WHERE key = 'names'").get();
    assert.equal(row.src, 'planner');
  });

  test('AC6: names come from a household.names fact, merged over the neutral labels', async () => {
    const db = S.store();
    addFact(db, 'household.names', { me: 'Robin Testcase', household: 'The Testcase household' });
    await plan(db);
    const names = contentValue(db, 'names');
    assert.equal(names.me, 'Robin Testcase');
    assert.equal(names.household, 'The Testcase household');
    assert.equal(names.spouse, NEUTRAL.spouse, 'unset keys stay neutral');
    assert.equal(contentValue(db, 'meta').household, 'The Testcase household');
  });

  test('AC6: meta names the product and the data-through date, law and pct are populated', () => {
    const meta = contentValue(base, 'meta');
    assert.deepEqual(meta, { product: 'Fathom', household: NEUTRAL.household, dataThrough: 'Oct 31, 2026' });
    assert.equal(contentValue(base, 'law').iraLimit, 7500);
    assert.equal(contentValue(base, 'pct').fedSafeHarborCurrent, 90);
  });

  test('AC6: the verdict sub names the earliest needs-you rec and its window', () => {
    const verdict = contentValue(base, 'verdict');
    assert.ok(verdict.attention.headline.includes('{count}'));
    assert.equal(typeof verdict.clear.headline, 'string');
    const ny = needsYou(loadRecs(base, NOW));
    assert.ok(ny.length > 0);
    const first = ny[0];
    assert.ok(verdict.attention.sub.includes(first.title), `sub names ${first.title}: ${verdict.attention.sub}`);
    assert.ok(verdict.attention.sub.includes(first.window.label), 'sub names the window');
    assert.match(verdict.attention.sub, /^First up: /);
  });

  test('AC6: domains cover tax, retirement, business, cash, family, giving and data with valid statuses', () => {
    const domains = contentValue(base, 'domains');
    const ids = domains.map(d => d.id);
    for (const id of ['tax', 'retirement', 'business', 'cash', 'family', 'giving', 'data']) assert.ok(ids.includes(id), `domain ${id}`);
    for (const d of domains) {
      for (const k of ['id', 'name', 'watching', 'note']) assert.equal(typeof d[k], 'string', `${d.id}.${k}`);
      assert.ok(['covered', 'changed', 'needs', 'waiting'].includes(d.status), `${d.id} status ${d.status}`);
    }
    assert.equal(domains.find(d => d.id === 'tax').status, 'needs', 'the Q4 estimates need the owner');
    assert.notEqual(domains.find(d => d.id === 'data').status, 'waiting', 'nothing is stale in November');
  });
});

describe('what changed', () => {
  test('AC6: after the first run events report the new data and the new recs, dated by the clock', () => {
    const events = base.prepare("SELECT * FROM events WHERE src = 'planner' ORDER BY sort, id").all();
    assert.ok(events.some(e => /^New data: /.test(e.title) && e.kind === 'account'), 'new data event');
    const recTitles = new Set(activeRecIds(base).map(id => recRow(base, id).def.title));
    const newRecs = events.filter(e => /^New on your plan: /.test(e.title));
    assert.ok(newRecs.length >= activeRecIds(base).length, 'one event per new rec');
    for (const e of newRecs) {
      assert.ok(recTitles.has(e.title.replace(/^New on your plan: /, '')), `event names a rec: ${e.title}`);
      assert.ok(['calendar', 'income', 'life', 'milestone'].includes(e.kind));
    }
    assert.ok(events.every(e => e.date === 'Nov 5'));
  });

  test('AC6: a second identical run leaves events unchanged', async () => {
    const db = S.store();
    await plan(db);
    const before = db.prepare('SELECT * FROM events ORDER BY id').all().map(r => ({ ...r }));
    await plan(db);
    assert.deepEqual(db.prepare('SELECT * FROM events ORDER BY id').all().map(r => ({ ...r })), before);
  });

  test('AC6: after a retirement the events list the retired rec and the fact change', async () => {
    const db = S.store();
    await plan(db);
    const title = recRow(db, 'va529').def.title;
    db.prepare("DELETE FROM transactions WHERE category = 'Charitable'").run();
    addFact(db, 'accounts.has529', false);
    await plan(db);
    const events = db.prepare("SELECT * FROM events WHERE src = 'planner'").all();
    const retired = events.find(e => e.title === `Retired: ${title}`);
    assert.ok(retired, 'retired event');
    assert.equal(retired.kind, 'milestone');
    assert.equal(retired.body, 'The condition behind it no longer holds in your data.');
    const lost = events.find(e => e.title === 'giving.charitable changed');
    assert.ok(lost, 'fact change event');
    assert.equal(lost.body, 'No longer seen in your data.');
  });
});

describe('deadlines and decisions', () => {
  test('AC6: deadlines include every rec window and the statutory Jan 31 and Apr 15 rows', () => {
    const rows = base.prepare("SELECT * FROM deadlines WHERE src = 'planner' ORDER BY date").all();
    for (const id of activeRecIds(base)) {
      const rec = recRow(base, id);
      if (!rec.window_close) continue;
      const d = rows.find(x => x.rec_id === id);
      assert.ok(d, `deadline for ${id}`);
      assert.equal(d.date, rec.window_close);
      assert.equal(d.label, rec.window_label);
    }
    const jan31 = rows.find(x => x.date === '2027-01-31');
    assert.ok(jan31, 'statutory Jan 31 row');
    assert.equal(jan31.title, 'W-2 and 1099 forms due');
    assert.equal(jan31.rec_id, null);
    assert.ok(rows.some(x => x.date === '2027-04-15'), 'an Apr 15 row (federal return or the HSA window on that date)');
    assert.ok(rows.some(x => x.date === '2027-03-15' && x.title === 'S corp return due'));
    assert.ok(rows.some(x => x.date === '2027-05-01' && x.title === 'Virginia return due'));
    assert.equal(rows.filter(x => x.date === '2027-01-15').length, 2, 'Jan 15 covered by the two estimate recs, no extra statutory row');
  });

  test('AC6: decisions: the 2026 salary and deferral decisions are open and linked, 2027 salary is upcoming', () => {
    const rows = Object.fromEntries(base.prepare("SELECT * FROM decisions WHERE src = 'planner'").all().map(r => [r.id, r]));
    const s26 = rows['salary-2026'];
    assert.ok(s26, 'salary-2026');
    assert.deepEqual([s26.status, s26.wargame, s26.rec_id], ['open', 'salary', 'scorp-salary']);
    assert.equal(s26.when_label, `Decide by ${recRow(base, 'scorp-salary').window_label}`);
    const d26 = rows['deferral-2026'];
    assert.ok(d26, 'deferral-2026');
    assert.deepEqual([d26.status, d26.wargame, d26.rec_id], ['open', 'deferral', 'invoice-deferral']);
    const s27 = rows['salary-2027'];
    assert.ok(s27, 'salary-2027');
    assert.deepEqual([s27.status, s27.wargame, s27.opens_on, s27.when_label], ['upcoming', 'salary', '2027-01-01', 'Opens in January']);
    assert.equal(s27.title, 'What should you pay yourself in 2027?');
    const scenario = buildScenario(base, { clock: NOW });
    const dec = scenario.decisions.find(d => d.id === 'salary-2026');
    assert.equal(dec.recId, 'scorp-salary');
    assert.equal(scenario.recs.find(r => r.id === dec.recId).scenario, 'salary');
  });
});

describe('war games', () => {
  test('AC6: the salary war game spans the approved range plus the current salary, with one current point and a frontier', () => {
    const salary = loadContent(base).wargame.salary;
    assert.ok(salary, 'content.wargame.salary');
    assert.equal(salary.title, 'What should you pay yourself in 2026?');
    const pts = salary.points;
    assert.equal(pts.filter(p => p.current).length, 1, 'exactly one current point');
    assert.ok(pts.filter(p => p.frontier).length >= 2, 'at least two frontier points');
    assert.deepEqual(pts.map(p => p.id).sort(), ['s110', 's50', 's60', 's65', 's80', 's95'].sort());
    const current = pts.find(p => p.current);
    assert.equal(current.id, `s${W / 1000}`);
    assert.equal(current.y, 0, 'y is measured against the current salary');
    for (const p of pts) {
      for (const k of ['x', 'y']) assert.equal(typeof p[k], 'number', `${p.id}.${k}`);
      assert.equal(typeof p.note, 'string');
      assert.equal(p.label, `Salary {fk:wg.salary.${p.id}.salary}`);
    }
  });

  test('AC6: each salary point is hand-checked: salary, 401k room, payroll and distributions (S3, T3)', () => {
    const pts = loadContent(base).wargame.salary.points;
    for (const p of pts) {
      const s = Number(p.id.slice(1)) * 1000;
      near(figureRow(base, `wg.salary.${p.id}.salary`).v, s, `${p.id}.salary`);
      const room = solo401kRoom({ compensation: s, kind: 'w2', age: SYNTH.ownerAge, allPlanDeferrals: 0, thisPlanDeferrals: 0, thisPlanCatchUp: 0, employerContributions: 0, planConfirmed: true, aggregationConfirmed: true }).value;
      near(p.x, room.total, `${p.id}.x`);
      near(figureRow(base, `wg.salary.${p.id}.x`).v, room.total, `${p.id}.x figure`);
      const pay = payrollTax({ wages: s, filingStatus: 'mfj', spouseMedicareWages: 0 }).value;
      near(figureRow(base, `wg.salary.${p.id}.payroll`).v, r2(pay.total - pay.additionalMedicare), `${p.id}.payroll`);
      near(figureRow(base, `wg.salary.${p.id}.dist`).v, r2(P - s - pay.employerTotal), `${p.id}.dist`);
      const cur = pts.find(q => q.current);
      near(figureRow(base, `wg.salary.${p.id}.y`).v, r2(figureRow(base, `wg.salary.${p.id}.tax`).v - figureRow(base, `wg.salary.${cur.id}.tax`).v), `${p.id}.y`);
    }
  });

  test('AC6: the deferral war game has d0, d50 and d100 with S13 cash for the S corp', () => {
    const deferral = loadContent(base).wargame.deferral;
    assert.ok(deferral, 'content.wargame.deferral');
    assert.equal(deferral.title, 'Invoice now or in January?');
    const byId = Object.fromEntries(deferral.options.map(o => [o.id, o]));
    assert.deepEqual(Object.keys(byId).sort(), ['d0', 'd100', 'd50']);
    const A = r2(M * SCORP.income / M);
    assert.equal(byId.d0.amount, 0);
    near(byId.d50.amount, r2(A / 2), 'd50.amount');
    near(byId.d100.amount, A, 'd100.amount');
    const netYtd = M * (SCORP.income - Object.values(SCORP.expenses).reduce((a, b) => a + b, 0));
    const prePayroll = (netYtd + M * SCORP.expenses['Officer salary'] + M * SCORP.expenses['Payroll taxes']) / M;
    const monthlyPayroll = (W + 12 * SCORP.expenses['Payroll taxes']) / 12;
    const monthsLeft = 2; // balance dated Oct 31: November and December remain
    for (const o of deferral.options) {
      near(o.decCash, r2(SYNTH.businessEnd + monthsLeft * prePayroll - (monthsLeft - 1) * monthlyPayroll - o.amount), `${o.id}.decCash`);
      near(o.need, r2(monthlyPayroll), `${o.id}.need`);
      near(o.net, r2(o.tax2026 + o.tax2027), `${o.id}.net`);
    }
    assert.ok(byId.d100.tax2026 < 0, 'moving income out of 2026 lowers 2026 tax');
    assert.ok(byId.d100.tax2027 > 0, 'and raises 2027 tax');
    near(figureRow(base, 'wg.deferral.d100.gap').v, r2(byId.d100.need - byId.d100.decCash), 'gap figure');
  });

  test('AC6: buildScenario serves the stored war-game figures as model outputs with calculator locators and no demo names', () => {
    const scenario = buildScenario(base, { clock: NOW });
    const wg = Object.entries(scenario.fig).filter(([k]) => /^wg\.(salary|deferral)\./.test(k));
    assert.ok(wg.some(([k]) => k.startsWith('wg.salary.')) && wg.some(([k]) => k.startsWith('wg.deferral.')));
    for (const [k, f] of wg) {
      assert.equal(f.kind, 'm', `${k} kind`);
      assert.equal(f.src, 'wargame-model', `${k} src`);
    }
    assert.equal(scenario.src['wargame-model'].label, 'War-game model: salary, tax and cash calculators');
    for (const row of base.prepare("SELECT key, locator FROM figures WHERE key LIKE 'wg.%'").all()) {
      const loc = JSON.parse(row.locator);
      assert.ok(typeof loc.calc === 'string' && loc.calc, `${row.key} locator calc`);
      assert.ok(Array.isArray(loc.steps) && loc.steps.length > 0, `${row.key} locator steps`);
    }
    const text = JSON.stringify(scenario);
    const hit = text.match(demoNameRe);
    assert.equal(hit, null, `scenario carries a demo name: ${hit && hit[0]}`);
  });

  test('AC6: a stored war-game figure wins over the derived value, and the demo store is unchanged (R17)', async () => {
    const dir = S.dir();
    const demoDb = S.track(openStore({ dataDir: dir, demo: 'auto' }));
    assert.equal(demoDb.prepare("SELECT count(*) AS n FROM figures WHERE key LIKE 'wg.%'").get().n, 0, 'demo stores no wg rows');
    const demoScenario = buildScenario(demoDb);
    for (const p of demo.wargame.salary.points) {
      assert.equal(demoScenario.fig[`wg.salary.${p.id}.x`].v, p.x, `demo ${p.id}.x derived`);
      assert.equal(demoScenario.fig[`wg.salary.${p.id}.y`].v, p.y, `demo ${p.id}.y derived`);
      assert.equal(demoScenario.fig[`wg.salary.${p.id}.x`].src, 'wargame-model');
    }

    const db = S.store();
    await plan(db);
    const p = loadContent(db).wargame.salary.points[0];
    db.prepare('UPDATE figures SET v = ? WHERE key = ?').run(12345.67, `wg.salary.${p.id}.x`);
    const scenario = buildScenario(db, { clock: NOW });
    assert.equal(scenario.fig[`wg.salary.${p.id}.x`].v, 12345.67, 'stored row wins');
    assert.notEqual(p.x, 12345.67);
  });

  test('AC6: in January the deferral model is not rebuilt and the previous one is kept (S11)', async () => {
    const db = S.store();
    await plan(db);
    const before = loadContent(db).wargame.deferral;
    await plan(db, '2027-01-10');
    assert.deepEqual(loadContent(db).wargame.deferral, before);
    const scenario = buildScenario(db, { clock: '2027-01-10' });
    assert.ok(scenario.fig['wg.deferral.d100.decCash'], 'the kept model still has its figures in the scenario');
    // liveness: the salary game for the same tax year is still served
    assert.ok(loadContent(db).wargame.salary);
  });
});
