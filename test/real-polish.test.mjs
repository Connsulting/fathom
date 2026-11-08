// Real-mode polish: account trend series from stored balances, plain-language "what changed"
// titles, the model per purpose on the Engine screen, and the Decide action (decide, planner
// honors the decided salary, revisit).

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planRun } from './helpers/plan.mjs';
import { scratch, createRealStore, addPayroll, w2Doc, SCORP, figureRow, factRow, contentValue } from './helpers/real-store.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { buildSeries, seriesKey, MAX_POINTS } from '../src/jobs/planner/series.mjs';
import { FROZEN_FACT_KEYS } from '../src/ingest/extract.mjs';
import { FACT_TITLES, KIND_FALLBACK, factEventTitle, kindFallbackTitle } from '../src/shared/event-labels.mjs';
import { MODEL_PURPOSES, modelFor, DEFAULT_MODEL, TITLE_MODEL } from '../src/engine/pricing.mjs';
import { decisionDecide, decisionRevisit } from '../src/api/handlers.mjs';
import { HttpError } from '../src/api/http.mjs';
import { resolveTokens } from '../src/shared/tokens.mjs';
import { payrollTax } from '../src/calc/index.mjs';
import { findSeries } from '../src/shared/series.mjs';

const NOW = '2026-11-05';
const S = scratch('fathom-polish-');
after(async () => await S.cleanup());

// ---------------------------------------------------------------- series from balances

async function account(db, id, { name, kind = 'checking', mask = null, sort = 0 } = {}) {
  await db.prepare('INSERT INTO accounts (id, inst, mask, name, kind, mirror, sort) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'Sample Bank', mask, name ?? id, kind, 'manual', sort);
}
const balance = async (db, id, date, amount) => await db.prepare('INSERT INTO balances (account_id, date, amount) VALUES (?, ?, ?)').run(id, date, amount);
const position = async (db, id, asOf, value) => await db.prepare('INSERT INTO positions (account_id, as_of, symbol, value) VALUES (?, ?, ?, ?)').run(id, asOf, 'FUND', value);

describe('series from balances', () => {
  test('one monthly point per account, the last balance in each month, kind actual', async () => {
    const db = await emptyDb();
    await account(db, 'chk1', { name: 'Everyday checking', mask: '1111' });
    await balance(db, 'chk1', '2026-08-15', 1000);
    await balance(db, 'chk1', '2026-08-31', 1100);
    await balance(db, 'chk1', '2026-09-30', 1250.5);
    await balance(db, 'chk1', '2026-10-31', 1400);
    const series = await buildSeries(db, NOW);
    const s = series['acct-chk1'];
    assert.ok(s, 'account series');
    assert.equal(s.label, 'Everyday checking (1111)');
    assert.equal(s.src, 'balances');
    assert.deepEqual(s.points.map(p => p.v), [1100, 1250.5, 1400]);
    assert.deepEqual(s.points.map(p => p.x), ['Aug 2026', 'Sep 2026', 'Oct 2026']);
    assert.ok(s.points.every(p => p.kind === 'a'));
  });

  test('brokerage months without a balance use the summed position values; balances win when both exist', async () => {
    const db = await emptyDb();
    await account(db, 'brk', { name: 'Brokerage', kind: 'taxable' });
    await position(db, 'brk', '2026-09-30', 4000);
    await position(db, 'brk', '2026-09-30', 1000);
    await position(db, 'brk', '2026-10-31', 6000);
    await position(db, 'brk', '2026-10-31', 1500);
    const s = (await buildSeries(db, NOW))['acct-brk'];
    assert.deepEqual(s.points.map(p => p.v), [5000, 7500]);
    await balance(db, 'brk', '2026-10-31', 7600);
    assert.deepEqual((await buildSeries(db, NOW))['acct-brk'].points.map(p => p.v), [5000, 7600]);
  });

  test('each account keeps its own series with the statement balance and a plain key', async () => {
    const db = await emptyDb();
    await account(db, 'a', { name: 'Savings', kind: 'checking', sort: 1 });
    await account(db, 'b', { name: 'Brokerage', kind: 'taxable', sort: 2 });
    await account(db, 'c', { name: 'Card', kind: 'credit', sort: 3 });
    for (const [d, v] of [['2026-07-31', 100], ['2026-08-31', 110], ['2026-09-30', 120], ['2026-10-31', 130]]) await balance(db, 'a', d, v);
    await balance(db, 'b', '2026-09-30', 1000);
    await balance(db, 'b', '2026-10-31', 1200);
    for (const [d, v] of [['2026-09-30', 50], ['2026-10-31', 60]]) await balance(db, 'c', d, v);
    const series = await buildSeries(db, NOW);
    assert.deepEqual(Object.keys(series), ['acct-a', 'acct-b', 'acct-c'], 'accounts in store order, no combined line (the household trend is src/accounts/trend.mjs)');
    assert.ok(series['acct-c'], 'the card keeps its own trend');
    assert.equal(series['acct-c'].points[1].v, 60, 'its own trend shows the statement balance');
    assert.equal(seriesKey('acct-ab12'), 'acct-ab12');
    assert.equal(seriesKey('Odd Id/1'), 'acct-odd-id-1');
  });

  test('an account with one month of data has no series, at most MAX_POINTS months are kept, braces are stripped', async () => {
    const db = await emptyDb();
    await account(db, 'one', { name: 'Lonely', kind: 'credit' });
    await balance(db, 'one', '2026-10-31', 5);
    await account(db, 'long', { name: 'Odd {f:cash.total} <b>name</b>' });
    for (let m = 1; m <= 12; m++) await balance(db, 'long', `2025-${String(m).padStart(2, '0')}-28`, m);
    for (let m = 1; m <= 10; m++) await balance(db, 'long', `2026-${String(m).padStart(2, '0')}-28`, 100 + m);
    const series = await buildSeries(db, NOW);
    assert.equal(series['acct-one'], undefined);
    assert.equal(series['acct-long'].points.length, MAX_POINTS);
    assert.equal(series['acct-long'].label, 'Odd f:cash.total bname/b');
    assert.deepEqual(await buildSeries(await emptyDb(), NOW), {});
  });

  test('the planner stores the series and the scenario turns each point into a figure with the balances source', async () => {
    const db = await S.store();
    await db.applySchema('DELETE FROM balances; DELETE FROM positions');
    const first = (await db.prepare('SELECT id FROM accounts ORDER BY sort, id').get()).id;
    await balance(db, first, '2026-09-30', 2000);
    await balance(db, first, '2026-10-31', 2500);
    await planRun(db, { now: NOW });
    const stored = await contentValue(db, 'series');
    const key = seriesKey(first);
    assert.deepEqual(stored[key].points.map(p => p.v), [2000, 2500]);
    const sc = await buildScenario(db, { clock: NOW });
    assert.equal(sc.series[key].imported, true);
    const f = sc.fig[`series.${key}.1`];
    assert.equal(f.v, 2500);
    assert.equal(f.src, 'balances');
    assert.equal(f.kind, 'a');
    assert.ok(sc.src.balances.label);
    assert.match(f.label, /Oct 2026/);
  });
});

async function emptyDb() {
  return S.track(await createRealStore(S.dir(), { clock: NOW }));
}

// ---------------------------------------------------------------- plain-language event titles

describe('event labels', () => {
  const kinds = ['income', 'life', 'account', 'calendar', 'milestone'];

  test('every frozen fact key has a title for detected and for no longer seen, with no key and no digit', () => {
    for (const key of FROZEN_FACT_KEYS) {
      assert.ok(Object.hasOwn(FACT_TITLES, key), `label for ${key}`);
      for (const removed of [false, true]) {
        const t = factEventTitle(key, { removed });
        assert.ok(t && t !== key && !t.includes(key) && !/[.{}]/.test(t), `${key}: ${t}`);
        assert.ok(!/\d/.test(t.replace('401(k)', '').replace('529', '')), `no figure in "${t}"`);
      }
    }
    assert.equal(factEventTitle('income.sCorp'), 'S corp income detected');
    assert.equal(factEventTitle('income.sCorp', { removed: true }), 'S corp income no longer seen');
  });

  test('every event kind has a fallback and an unknown key never shows raw', () => {
    for (const k of kinds) assert.ok(KIND_FALLBACK[k], k);
    assert.equal(factEventTitle('made.up.key', { kind: 'income' }), KIND_FALLBACK.income);
    assert.equal(kindFallbackTitle('nonsense'), 'Change detected');
    assert.equal(factEventTitle('made.up.key'), 'Change detected');
  });

  test('the scenario rewrites an old "<key> changed" title already stored', async () => {
    const db = await S.store();
    await db.prepare("INSERT INTO events (date, kind, title, body, sort, src) VALUES ('Nov 5', 'income', 'income.sCorp changed', 'Derived from your data.', 0, 'planner')").run();
    const ev = (await buildScenario(db, { clock: NOW })).events.find(e => e.body === 'Derived from your data.');
    assert.equal(ev.title, 'S corp income detected');
  });

  test('a planner run writes plain titles for fact changes', async () => {
    const db = await S.store();
    await planRun(db, { now: NOW });
    await db.prepare("DELETE FROM facts WHERE key = 'giving.charitable'").run();
    await db.prepare("DELETE FROM transactions WHERE category = 'Charitable'").run();
    const snap = JSON.parse((await db.prepare("SELECT value FROM settings WHERE key = 'planner.snapshot'").get()).value);
    snap.facts['income.sCorp'] = false;
    await db.prepare("UPDATE settings SET value = ? WHERE key = 'planner.snapshot'").run(JSON.stringify(snap));
    await planRun(db, { now: NOW });
    const titles = (await db.prepare("SELECT title FROM events WHERE src = 'planner'").all()).map(r => r.title);
    assert.ok(titles.includes('S corp income detected'), titles.join('|'));
    assert.ok(titles.every(t => !/^[a-z]+\.[A-Za-z0-9.]+ changed$/.test(t)), 'no raw keys');
  });
});

// ---------------------------------------------------------------- engine models

describe('engine models', () => {
  test('modelFor is the one place purposes map to models', () => {
    assert.deepEqual([...MODEL_PURPOSES], ['chat', 'job', 'extract', 'title', 'confirm']);
    assert.equal(modelFor('title'), TITLE_MODEL);
    for (const p of MODEL_PURPOSES.filter(x => x !== 'title')) assert.equal(modelFor(p), DEFAULT_MODEL);
  });

  test('the scenario lists the configured model per purpose, whatever the content rows hold', async () => {
    const db = await S.store();
    const sc = await buildScenario(db, { clock: NOW });
    assert.deepEqual(sc.engine.models, MODEL_PURPOSES.map(purpose => ({ purpose, model: modelFor(purpose) })));
    assert.equal(sc.engine.chat.model, '', 'the demo-only chat row stays empty in real mode');
  });

  test('the Engine screen shows each purpose with a neutral service label', async () => {
    const eng = await import('../web/horizon/screens/engine.js');
    const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const sc = await buildScenario(await S.store(), { clock: NOW });
    eng.bind({
      api: { s: { engine: sc.engine }, engineOn: () => true, canAdmin: () => true }, arr: a => (Array.isArray(a) ? a : []), esc, T: esc, figHtml: () => '$0',
      shell: html => html, section: (t, b) => b, pageHead: () => '',
    });
    const html = eng.render();
    for (const { purpose, model } of sc.engine.models) {
      assert.ok(html.includes(`data-purpose="${purpose}"`), purpose);
      assert.ok(!html.includes(model), model);
    }
    assert.equal((html.match(/>Configured<\/b>/g) || []).length, sc.engine.models.length);
    assert.match(html, /Chat answers/);
  });
});

// ---------------------------------------------------------------- Decide

const ctxFor = (db, id, body = {}) => ({ db, config: { clock: NOW }, params: { id }, body });
const salaryDecision = sc => sc.decisions.find(d => d.id === 'salary-2026');

async function plannedStore() {
  const db = await S.store();
  await planRun(db, { now: NOW });
  return db;
}

describe('decide and revisit', () => {
  test('deciding marks the decision decided with a registry-token line and stores the assumption', async () => {
    const db = await plannedStore();
    const game = (await contentValue(db, 'wargame')).salary;
    const point = game.points.find(p => !p.current) || game.points[0];
    const out = await decisionDecide(ctxFor(db, 'salary-2026', { index: point.id }));
    const d = salaryDecision(out.scenario);
    assert.equal(d.status, 'decided');
    assert.equal(d.revisitable, true);
    assert.match(d.line, new RegExp(`\\{f:wg\\.salary\\.${point.id}\\.tax\\}`));
    const text = resolveTokens(out.scenario, d.line, false);
    assert.ok(!text.includes('[?'), text);
    assert.equal(out.scenario.wargame.salary.status, 'decided');
    assert.equal(out.scenario.wargame.salary.decided, d.line);
    const fact = await factRow(db, 'business.salaryDecided');
    assert.deepEqual(fact.value, { entity: 'northwind-advisory', salary: (await figureRow(db, `wg.salary.${point.id}.salary`)).v });
    assert.equal(fact.src, 'decide:salary');
    assert.equal(fact.locator.decision, 'salary-2026');
    assert.equal(fact.locator.figure, `wg.salary.${point.id}.salary`);
    const ev = await db.prepare("SELECT action, arg FROM rec_events WHERE action = 'decide'").all();
    assert.deepEqual(ev.map(e => e.arg), [point.id]);
    assert.equal(await db.prepare('SELECT value FROM settings WHERE key = ?').get('wargame.picks') !== undefined, true);
  });

  test('the next planner run uses the decided salary as the payroll assumption, and revisit goes back to the data', async () => {
    const db = await plannedStore();
    const slug = 'northwind-advisory';
    const fromData = await figureRow(db, `pnl.${slug}.salaryProj`);
    assert.equal(fromData.src, 'plan-projection');
    const game = (await contentValue(db, 'wargame')).salary;
    const point = await findSeries(game.points, async p => (await figureRow(db, `wg.salary.${p.id}.salary`)).v !== fromData.v);
    const chosen = (await figureRow(db, `wg.salary.${point.id}.salary`)).v;
    await decisionDecide(ctxFor(db, 'salary-2026', { index: point.id }));
    await planRun(db, { now: NOW });
    const decided = await figureRow(db, `pnl.${slug}.salaryProj`);
    assert.equal(decided.v, chosen);
    assert.equal(decided.src, 'owner-decision');
    assert.equal(decided.locator.calc, 'ownerDecision');
    // The decision stays decided across the run, the picked point is now the current salary.
    const afterRun = await buildScenario(db, { clock: NOW });
    assert.equal(salaryDecision(afterRun).status, 'decided');
    assert.equal(afterRun.wargame.salary.points.find(p => p.current)?.id, point.id);
    // Profit before salary still comes from the P&L, not from the decision.
    assert.equal((await figureRow(db, 'scorp.profitProj')).src, 'plan-projection');

    const out = await decisionRevisit(ctxFor(db, 'salary-2026'));
    assert.equal(salaryDecision(out.scenario).status, 'open');
    assert.equal(salaryDecision(out.scenario).line, '');
    assert.equal(await factRow(db, 'business.salaryDecided'), null);
    await planRun(db, { now: NOW });
    const back = await figureRow(db, `pnl.${slug}.salaryProj`);
    assert.equal(back.v, fromData.v);
    assert.equal(back.src, 'plan-projection');
    assert.equal(salaryDecision(await buildScenario(db, { clock: NOW })).status, 'open');
  });

  test('refusals: unknown, already decided, not decided, upcoming, out-of-range pick', async () => {
    const db = await plannedStore();
    const code = fn => { try { fn(); } catch (e) { assert.ok(e instanceof HttpError); return e.status; } return 200; };
    assert.equal(code(async () => await decisionDecide(ctxFor(db, 'nope'))), 404);
    assert.equal(code(async () => await decisionRevisit(ctxFor(db, 'salary-2026'))), 409, 'revisit an open decision');
    assert.equal(code(async () => await decisionDecide(ctxFor(db, 'salary-2026', { index: 99 }))), 400);
    assert.equal(code(async () => await decisionDecide(ctxFor(db, 'salary-2027'))), 409, 'upcoming');
    assert.equal(code(async () => await decisionDecide(ctxFor(db, 'salary-2026'))), 200, 'default pick');
    assert.equal(code(async () => await decisionDecide(ctxFor(db, 'salary-2026'))), 409, 'already decided');
  });
});

describe('a decided salary stays consistent across replans', () => {
  const slug = 'northwind-advisory';
  const SCORP2 = Object.freeze({ ...SCORP, name: 'Harbor Consulting', slug: 'harbor-consulting', owner: 'spouse' });

  test('the decided salary moves wages and distributions together: AGI changes only by the employer payroll tax', async () => {
    const db = await plannedStore();
    const agiBefore = (await figureRow(db, 'agi.est')).v;
    const salaryBefore = (await figureRow(db, `pnl.${slug}.salaryProj`)).v;
    const game = (await contentValue(db, 'wargame')).salary;
    const point = await findSeries(game.points, async p => (await figureRow(db, `wg.salary.${p.id}.salary`)).v > salaryBefore);
    const chosen = (await figureRow(db, `wg.salary.${point.id}.salary`)).v;
    await decisionDecide(ctxFor(db, 'salary-2026', { index: point.id }));
    await planRun(db, { now: NOW });
    const employer = w => payrollTax({ wages: w, filingStatus: 'single' }).value.employerTotal;
    const expected = agiBefore - (employer(chosen) - employer(salaryBefore));
    const agiAfter = (await figureRow(db, 'agi.est')).v;
    assert.ok(Math.abs(agiAfter - expected) <= 1, `agi ${agiAfter} vs ${expected}`);
    assert.ok(Math.abs(agiAfter - (agiBefore + chosen - salaryBefore)) > 1000, 'not wages added on top of unchanged profit');
  });

  test('the decision binds to its business: a second S corp keeps its own salary', async () => {
    const db = await S.store({ variant: { entities: [SCORP, SCORP2] } });
    await planRun(db, { now: NOW });
    const otherBefore = await figureRow(db, `pnl.${SCORP2.slug}.salaryProj`);
    assert.equal(otherBefore.src, 'plan-projection');
    const game = (await contentValue(db, 'wargame')).salary;
    assert.ok(game, 'the salary game is built');
    const entity = game.entity;
    const other = entity === slug ? SCORP2.slug : slug;
    const otherProj = (await figureRow(db, `pnl.${other}.salaryProj`)).v;
    const point = await findSeries(game.points, async p => (await figureRow(db, `wg.salary.${p.id}.salary`)).v !== (await figureRow(db, `pnl.${entity}.salaryProj`)).v);
    await decisionDecide(ctxFor(db, 'salary-2026', { index: point.id }));
    assert.equal((await factRow(db, 'business.salaryDecided')).value.entity, entity);
    await planRun(db, { now: NOW });
    assert.equal((await figureRow(db, `pnl.${entity}.salaryProj`)).src, 'owner-decision');
    const after = await figureRow(db, `pnl.${other}.salaryProj`);
    assert.equal(after.v, otherProj);
    assert.equal(after.src, 'plan-projection');
  });

  test('a W-2 for the year supersedes the decision everywhere, the deferral payroll basis included', async () => {
    const db = await plannedStore();
    const game = (await contentValue(db, 'wargame')).salary;
    const before = (await figureRow(db, `pnl.${slug}.salaryProj`)).v;
    const point = await findSeries(game.points, async p => (await figureRow(db, `wg.salary.${p.id}.salary`)).v !== before);
    await decisionDecide(ctxFor(db, 'salary-2026', { index: point.id }));
    await planRun(db, { now: NOW });
    assert.equal((await figureRow(db, `pnl.${slug}.salaryProj`)).src, 'owner-decision');
    const needDecided = await db.prepare("SELECT v FROM figures WHERE key LIKE 'wg.deferral.%.need' LIMIT 1").get();
    await addPayroll(db, w2Doc({ employerName: SCORP.name, person: 'owner', wages: 61000, medicareWages: 61000 }));
    await planRun(db, { now: NOW });
    const back = await figureRow(db, `pnl.${slug}.salaryProj`);
    assert.equal(back.src, 'plan-projection');
    assert.equal(back.v, before);
    const needAfter = await db.prepare("SELECT v FROM figures WHERE key LIKE 'wg.deferral.%.need' LIMIT 1").get();
    assert.ok(needDecided && needAfter, 'the deferral game is offered in November');
    {
      const payTax = await db.prepare("SELECT v FROM figures WHERE key = ?").get(`pnl.${slug}.payrollTax`);
      assert.equal(needAfter.v, Math.round(((before + Math.round(payTax.v * 12 / 10 * 100) / 100) / 12) * 100) / 100, 'payroll need back on the P&L basis');
      assert.notEqual(needAfter.v, needDecided.v);
    }
  });
});
