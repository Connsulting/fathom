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

const NOW = '2026-11-05';
const S = scratch('fathom-polish-');
after(() => S.cleanup());

// ---------------------------------------------------------------- series from balances

function account(db, id, { name, kind = 'checking', mask = null, sort = 0 } = {}) {
  db.prepare('INSERT INTO accounts (id, inst, mask, name, kind, mirror, sort) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'Sample Bank', mask, name ?? id, kind, 'manual', sort);
}
const balance = (db, id, date, amount) => db.prepare('INSERT INTO balances (account_id, date, amount) VALUES (?, ?, ?)').run(id, date, amount);
const position = (db, id, asOf, value) => db.prepare('INSERT INTO positions (account_id, as_of, symbol, value) VALUES (?, ?, ?, ?)').run(id, asOf, 'FUND', value);

describe('series from balances', () => {
  test('one monthly point per account, the last balance in each month, kind actual', async () => {
    const db = await emptyDb();
    account(db, 'chk1', { name: 'Everyday checking', mask: '1111' });
    balance(db, 'chk1', '2026-08-15', 1000);
    balance(db, 'chk1', '2026-08-31', 1100);
    balance(db, 'chk1', '2026-09-30', 1250.5);
    balance(db, 'chk1', '2026-10-31', 1400);
    const series = buildSeries(db, NOW);
    const s = series['acct-chk1'];
    assert.ok(s, 'account series');
    assert.equal(s.label, 'Everyday checking ending 1111');
    assert.equal(s.src, 'balances');
    assert.deepEqual(s.points.map(p => p.v), [1100, 1250.5, 1400]);
    assert.deepEqual(s.points.map(p => p.x), ['Aug 2026', 'Sep 2026', 'Oct 2026']);
    assert.ok(s.points.every(p => p.kind === 'a'));
  });

  test('brokerage months without a balance use the summed position values; balances win when both exist', async () => {
    const db = await emptyDb();
    account(db, 'brk', { name: 'Brokerage', kind: 'taxable' });
    position(db, 'brk', '2026-09-30', 4000);
    position(db, 'brk', '2026-09-30', 1000);
    position(db, 'brk', '2026-10-31', 6000);
    position(db, 'brk', '2026-10-31', 1500);
    const s = buildSeries(db, NOW)['acct-brk'];
    assert.deepEqual(s.points.map(p => p.v), [5000, 7500]);
    balance(db, 'brk', '2026-10-31', 7600);
    assert.deepEqual(buildSeries(db, NOW)['acct-brk'].points.map(p => p.v), [5000, 7600]);
  });

  test('net worth sums assets, subtracts debts, carries a balance forward and starts once every account has begun', async () => {
    const db = await emptyDb();
    account(db, 'a', { name: 'Savings', kind: 'checking', sort: 1 });
    account(db, 'b', { name: 'Brokerage', kind: 'taxable', sort: 2 });
    account(db, 'c', { name: 'Card', kind: 'credit', sort: 3 });
    for (const [d, v] of [['2026-07-31', 100], ['2026-08-31', 110], ['2026-09-30', 120], ['2026-10-31', 130]]) balance(db, 'a', d, v);
    balance(db, 'b', '2026-09-30', 1000);
    balance(db, 'b', '2026-10-31', 1200);
    for (const [d, v] of [['2026-09-30', 50], ['2026-10-31', 60]]) balance(db, 'c', d, v);
    const series = buildSeries(db, NOW);
    assert.equal(Object.keys(series)[0], 'net', 'net worth first');
    // Brokerage begins in September; the card balance is owed, so it is subtracted.
    assert.deepEqual(series.net.points.map(p => [p.x, p.v]), [['Sep 2026', 1070], ['Oct 2026', 1270]]);
    assert.ok(series['acct-c'], 'the card keeps its own trend');
    assert.equal(series['acct-c'].points[1].v, 60, 'its own trend shows the statement balance');
    assert.equal(seriesKey('acct-ab12'), 'acct-ab12');
    assert.equal(seriesKey('Odd Id/1'), 'acct-odd-id-1');
  });

  test('an account with one month of data has no series, at most MAX_POINTS months are kept, braces are stripped', async () => {
    const db = await emptyDb();
    account(db, 'one', { name: 'Lonely', kind: 'credit' });
    balance(db, 'one', '2026-10-31', 5);
    account(db, 'long', { name: 'Odd {f:cash.total} <b>name</b>' });
    for (let m = 1; m <= 12; m++) balance(db, 'long', `2025-${String(m).padStart(2, '0')}-28`, m);
    for (let m = 1; m <= 10; m++) balance(db, 'long', `2026-${String(m).padStart(2, '0')}-28`, 100 + m);
    const series = buildSeries(db, NOW);
    assert.equal(series['acct-one'], undefined);
    assert.equal(series['acct-long'].points.length, MAX_POINTS);
    assert.equal(series['acct-long'].label, 'Odd f:cash.total bname/b');
    assert.equal(series.net.points.length, MAX_POINTS, 'the combined series keeps the same window');
    assert.deepEqual(buildSeries(await emptyDb(), NOW), {});
  });

  test('the planner stores the series and the scenario turns each point into a figure with the balances source', async () => {
    const db = await S.store();
    db.exec('DELETE FROM balances; DELETE FROM positions');
    const first = db.prepare('SELECT id FROM accounts ORDER BY sort, id').get().id;
    balance(db, first, '2026-09-30', 2000);
    balance(db, first, '2026-10-31', 2500);
    await planRun(db, { now: NOW });
    const stored = contentValue(db, 'series');
    const key = seriesKey(first);
    assert.deepEqual(stored[key].points.map(p => p.v), [2000, 2500]);
    const sc = buildScenario(db, { clock: NOW });
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
    db.prepare("INSERT INTO events (date, kind, title, body, sort, src) VALUES ('Nov 5', 'income', 'income.sCorp changed', 'Derived from your data.', 0, 'planner')").run();
    const ev = buildScenario(db, { clock: NOW }).events.find(e => e.body === 'Derived from your data.');
    assert.equal(ev.title, 'S corp income detected');
  });

  test('a planner run writes plain titles for fact changes', async () => {
    const db = await S.store();
    await planRun(db, { now: NOW });
    db.prepare("DELETE FROM facts WHERE key = 'giving.charitable'").run();
    db.prepare("DELETE FROM transactions WHERE category = 'Charitable'").run();
    const snap = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'planner.snapshot'").get().value);
    snap.facts['income.sCorp'] = false;
    db.prepare("UPDATE settings SET value = ? WHERE key = 'planner.snapshot'").run(JSON.stringify(snap));
    await planRun(db, { now: NOW });
    const titles = db.prepare("SELECT title FROM events WHERE src = 'planner'").all().map(r => r.title);
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
    const sc = buildScenario(db, { clock: NOW });
    assert.deepEqual(sc.engine.models, MODEL_PURPOSES.map(purpose => ({ purpose, model: modelFor(purpose) })));
    assert.equal(sc.engine.chat.model, '', 'the demo-only chat row stays empty in real mode');
  });

  test('the Engine screen shows each purpose and its model', async () => {
    const eng = await import('../web/horizon/screens/engine.js');
    const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const sc = buildScenario(await S.store(), { clock: NOW });
    eng.bind({
      api: { s: { engine: sc.engine }, engineOn: () => true }, arr: a => (Array.isArray(a) ? a : []), esc, T: esc, figHtml: () => '$0',
      shell: html => html, section: (t, b) => b, pageHead: () => '',
    });
    const html = eng.render();
    for (const { purpose, model } of sc.engine.models) assert.ok(html.includes(`data-purpose="${purpose}"`) && html.includes(model), purpose);
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
    const game = contentValue(db, 'wargame').salary;
    const point = game.points.find(p => !p.current) || game.points[0];
    const out = decisionDecide(ctxFor(db, 'salary-2026', { index: point.id }));
    const d = salaryDecision(out.scenario);
    assert.equal(d.status, 'decided');
    assert.equal(d.revisitable, true);
    assert.match(d.line, new RegExp(`\\{f:wg\\.salary\\.${point.id}\\.tax\\}`));
    const text = resolveTokens(out.scenario, d.line, false);
    assert.ok(!text.includes('[?'), text);
    assert.equal(out.scenario.wargame.salary.status, 'decided');
    assert.equal(out.scenario.wargame.salary.decided, d.line);
    const fact = factRow(db, 'business.salaryDecided');
    assert.deepEqual(fact.value, { entity: 'northwind-advisory', salary: figureRow(db, `wg.salary.${point.id}.salary`).v });
    assert.equal(fact.src, 'decide:salary');
    assert.equal(fact.locator.decision, 'salary-2026');
    assert.equal(fact.locator.figure, `wg.salary.${point.id}.salary`);
    const ev = db.prepare("SELECT action, arg FROM rec_events WHERE action = 'decide'").all();
    assert.deepEqual(ev.map(e => e.arg), [point.id]);
    assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('wargame.picks') !== undefined, true);
  });

  test('the next planner run uses the decided salary as the payroll assumption, and revisit goes back to the data', async () => {
    const db = await plannedStore();
    const slug = 'northwind-advisory';
    const fromData = figureRow(db, `pnl.${slug}.salaryProj`);
    assert.equal(fromData.src, 'plan-projection');
    const game = contentValue(db, 'wargame').salary;
    const point = game.points.find(p => figureRow(db, `wg.salary.${p.id}.salary`).v !== fromData.v);
    const chosen = figureRow(db, `wg.salary.${point.id}.salary`).v;
    decisionDecide(ctxFor(db, 'salary-2026', { index: point.id }));
    await planRun(db, { now: NOW });
    const decided = figureRow(db, `pnl.${slug}.salaryProj`);
    assert.equal(decided.v, chosen);
    assert.equal(decided.src, 'owner-decision');
    assert.equal(decided.locator.calc, 'ownerDecision');
    // The decision stays decided across the run, the picked point is now the current salary.
    const afterRun = buildScenario(db, { clock: NOW });
    assert.equal(salaryDecision(afterRun).status, 'decided');
    assert.equal(afterRun.wargame.salary.points.find(p => p.current)?.id, point.id);
    // Profit before salary still comes from the P&L, not from the decision.
    assert.equal(figureRow(db, 'scorp.profitProj').src, 'plan-projection');

    const out = decisionRevisit(ctxFor(db, 'salary-2026'));
    assert.equal(salaryDecision(out.scenario).status, 'open');
    assert.equal(salaryDecision(out.scenario).line, '');
    assert.equal(factRow(db, 'business.salaryDecided'), null);
    await planRun(db, { now: NOW });
    const back = figureRow(db, `pnl.${slug}.salaryProj`);
    assert.equal(back.v, fromData.v);
    assert.equal(back.src, 'plan-projection');
    assert.equal(salaryDecision(buildScenario(db, { clock: NOW })).status, 'open');
  });

  test('refusals: unknown, already decided, not decided, upcoming, out-of-range pick', async () => {
    const db = await plannedStore();
    const code = fn => { try { fn(); } catch (e) { assert.ok(e instanceof HttpError); return e.status; } return 200; };
    assert.equal(code(() => decisionDecide(ctxFor(db, 'nope'))), 404);
    assert.equal(code(() => decisionRevisit(ctxFor(db, 'salary-2026'))), 409, 'revisit an open decision');
    assert.equal(code(() => decisionDecide(ctxFor(db, 'salary-2026', { index: 99 }))), 400);
    assert.equal(code(() => decisionDecide(ctxFor(db, 'salary-2027'))), 409, 'upcoming');
    assert.equal(code(() => decisionDecide(ctxFor(db, 'salary-2026'))), 200, 'default pick');
    assert.equal(code(() => decisionDecide(ctxFor(db, 'salary-2026'))), 409, 'already decided');
  });
});

describe('a decided salary stays consistent across replans', () => {
  const slug = 'northwind-advisory';
  const SCORP2 = Object.freeze({ ...SCORP, name: 'Harbor Consulting', slug: 'harbor-consulting', owner: 'spouse' });

  test('the decided salary moves wages and distributions together: AGI changes only by the employer payroll tax', async () => {
    const db = await plannedStore();
    const agiBefore = figureRow(db, 'agi.est').v;
    const salaryBefore = figureRow(db, `pnl.${slug}.salaryProj`).v;
    const game = contentValue(db, 'wargame').salary;
    const point = game.points.find(p => figureRow(db, `wg.salary.${p.id}.salary`).v > salaryBefore);
    const chosen = figureRow(db, `wg.salary.${point.id}.salary`).v;
    decisionDecide(ctxFor(db, 'salary-2026', { index: point.id }));
    await planRun(db, { now: NOW });
    const employer = w => payrollTax({ wages: w, filingStatus: 'single' }).value.employerTotal;
    const expected = agiBefore - (employer(chosen) - employer(salaryBefore));
    const agiAfter = figureRow(db, 'agi.est').v;
    assert.ok(Math.abs(agiAfter - expected) <= 1, `agi ${agiAfter} vs ${expected}`);
    assert.ok(Math.abs(agiAfter - (agiBefore + chosen - salaryBefore)) > 1000, 'not wages added on top of unchanged profit');
  });

  test('the decision binds to its business: a second S corp keeps its own salary', async () => {
    const db = await S.store({ variant: { entities: [SCORP, SCORP2] } });
    await planRun(db, { now: NOW });
    const otherBefore = figureRow(db, `pnl.${SCORP2.slug}.salaryProj`);
    assert.equal(otherBefore.src, 'plan-projection');
    const game = contentValue(db, 'wargame').salary;
    assert.ok(game, 'the salary game is built');
    const entity = game.entity;
    const other = entity === slug ? SCORP2.slug : slug;
    const otherProj = figureRow(db, `pnl.${other}.salaryProj`).v;
    const point = game.points.find(p => figureRow(db, `wg.salary.${p.id}.salary`).v !== figureRow(db, `pnl.${entity}.salaryProj`).v);
    decisionDecide(ctxFor(db, 'salary-2026', { index: point.id }));
    assert.equal(factRow(db, 'business.salaryDecided').value.entity, entity);
    await planRun(db, { now: NOW });
    assert.equal(figureRow(db, `pnl.${entity}.salaryProj`).src, 'owner-decision');
    const after = figureRow(db, `pnl.${other}.salaryProj`);
    assert.equal(after.v, otherProj);
    assert.equal(after.src, 'plan-projection');
  });

  test('a W-2 for the year supersedes the decision everywhere, the deferral payroll basis included', async () => {
    const db = await plannedStore();
    const game = contentValue(db, 'wargame').salary;
    const before = figureRow(db, `pnl.${slug}.salaryProj`).v;
    const point = game.points.find(p => figureRow(db, `wg.salary.${p.id}.salary`).v !== before);
    decisionDecide(ctxFor(db, 'salary-2026', { index: point.id }));
    await planRun(db, { now: NOW });
    assert.equal(figureRow(db, `pnl.${slug}.salaryProj`).src, 'owner-decision');
    const needDecided = db.prepare("SELECT v FROM figures WHERE key LIKE 'wg.deferral.%.need' LIMIT 1").get();
    await addPayroll(db, w2Doc({ employerName: SCORP.name, person: 'owner', wages: 61000, medicareWages: 61000 }));
    await planRun(db, { now: NOW });
    const back = figureRow(db, `pnl.${slug}.salaryProj`);
    assert.equal(back.src, 'plan-projection');
    assert.equal(back.v, before);
    const needAfter = db.prepare("SELECT v FROM figures WHERE key LIKE 'wg.deferral.%.need' LIMIT 1").get();
    assert.ok(needDecided && needAfter, 'the deferral game is offered in November');
    {
      const payTax = db.prepare("SELECT v FROM figures WHERE key = ?").get(`pnl.${slug}.payrollTax`);
      assert.equal(needAfter.v, Math.round(((before + Math.round(payTax.v * 12 / 10 * 100) / 100) / 12) * 100) / 100, 'payroll need back on the P&L basis');
      assert.notEqual(needAfter.v, needDecided.v);
    }
  });
});
