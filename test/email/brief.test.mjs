// Monthly brief (src/email/brief.mjs) over a seeded demo store at the demo clock: the model
// (verdict, needs-you recs, 60 day deadlines, stale sources, engine spend, links), figure
// tie-back (every [n] marker maps to a scenario figure with its kind word and source, and no
// money amount appears outside a figure reference), figure qualifiers (Revision r2 item 1),
// summary acceptance (Revision r2 item 2 and r3: lexical rejection, then grounding on figure
// values only; engine failures fall back to the template), and escaping of hostile stored text.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempDb } from '../helpers/server.mjs';
import scenarioDemo from '../../demo/scenario.mjs';
import { seedDemo } from '../../demo/seed.mjs';
import { buildScenario, addDays } from '../../src/scenario/build.mjs';
import { needsYou, verdictLevel } from '../../src/shared/rules.mjs';
import { KIND_WORDS } from '../../src/shared/tokens.mjs';
import { createEngine, EngineOffError, BudgetExceededError, ModelCallError } from '../../src/engine/index.mjs';
import { buildBrief, briefSummary, renderBrief, composeBrief } from '../../src/email/brief.mjs';

const CLOCK = scenarioDemo.meta.clock; // 2026-11-05
const URL_BASE = 'https://fathom.example.invalid';
const MONEY = /-?\$\d[\d,]*(?:\.\d+)?[KMB]?/g;

async function seeded() {
  const t = await tempDb();
  seedDemo(t.db);
  return { ...t, done() { try { t.db.close(); } catch { /* closed */ } rmSync(t.dataDir, { recursive: true, force: true }); } };
}

async function withSeeded(fn) {
  const t = await seeded();
  try { return await fn(t.db); } finally { t.done(); }
}

// An engine object with the runtime engine's call() shape that answers `text` or throws `error`.
function scriptedEngine({ text, error } = {}) {
  const calls = [];
  return {
    mode: 'fake', calls, isOn: () => !error,
    async call(req) { calls.push(req); if (error) throw error; return { text, costUsd: 0.002, model: 'scripted' }; },
  };
}
const offEngine = () => scriptedEngine({ error: new EngineOffError() });

const figByKey = (model, key) => {
  const f = model.figures.find((x) => x.key === key);
  assert.ok(f, `brief figure ${key}`);
  return f;
};

// Splits the text part at the Figures section heading.
function splitFigures(text) {
  const m = /^Figures\b.*$/m.exec(text);
  assert.ok(m, 'the text part has a Figures section');
  return { body: text.slice(0, m.index), figures: text.slice(m.index) };
}

test('the model carries the verdict, needs-you recs with windows, and only 60 day deadlines', () => withSeeded(async (db) => {
  const sc = buildScenario(db, { clock: CLOCK });
  const model = buildBrief(db, { clock: CLOCK, publicUrl: null });
  const needs = needsYou(sc.recs);
  assert.equal(model.verdict.level, verdictLevel(sc.recs));
  assert.equal(model.verdict.level, 'attention');
  assert.deepEqual(model.needs.map((n) => n.id), needs.map((r) => r.id));

  const end = addDays(CLOCK, 60);
  const skip = new Set(sc.recs.filter((r) => ['done', 'dismissed', 'hidden'].includes(r.status)).map((r) => r.id));
  const want = sc.deadlines.filter((d) => d.date >= CLOCK && d.date <= end && !(d.recId && skip.has(d.recId)));
  assert.ok(want.length > 0 && want.length < sc.deadlines.length, 'the demo has deadlines inside and outside 60 days');
  assert.deepEqual(model.deadlines.map((d) => [d.date, d.title]), want.map((d) => [d.date, d.title]));

  const { text } = renderBrief(model, await briefSummary(model, { engine: offEngine() }));
  const headline = sc.verdict.attention.headline.replace('{count}', String(needs.length));
  assert.ok(text.includes(headline), 'verdict headline in the text');
  for (const r of needs) {
    assert.ok(text.includes(r.window.label), `window label of ${r.id}`);
    if (!r.title.includes('{')) assert.ok(text.includes(r.title), `title of ${r.id}`);
  }
  for (const d of want) assert.ok(text.includes(d.title), `deadline ${d.title}`);
  const later = sc.deadlines.find((d) => d.date > end);
  assert.ok(!text.includes(later.title), 'a deadline past 60 days is left out');
}));

test('deadlines for done, dismissed or hidden recs are left out', () => withSeeded(async (db) => {
  const sc = buildScenario(db, { clock: CLOCK });
  const end = addDays(CLOCK, 60);
  const linked = [...new Set(sc.deadlines.filter((d) => d.recId && d.date >= CLOCK && d.date <= end).map((d) => d.recId))];
  assert.ok(linked.length >= 3, 'the demo links at least three recs to near deadlines');
  const statuses = ['done', 'dismissed', 'hidden'];
  linked.forEach((id, i) => db.prepare('UPDATE recs SET status = ? WHERE id = ?').run(statuses[i % 3], id));
  const model = buildBrief(db, { clock: CLOCK, publicUrl: null });
  const want = sc.deadlines.filter((d) => !d.recId && d.date >= CLOCK && d.date <= end);
  assert.deepEqual(model.deadlines.map((d) => d.title), want.map((d) => d.title));
}));

test('stale ingest sources are listed with their age; dataThrough comes from the scenario', () => withSeeded(async (db) => {
  const asOf = addDays(CLOCK, -96);
  db.prepare("INSERT INTO sources (id, label, as_of, kind, last_ingest_at, note) VALUES ('ing:synthetic-bank', 'Synthetic Bank export', ?, 'bank_csv', ?, '')")
    .run(asOf, `${asOf}T12:00:00.000Z`);
  db.prepare("INSERT INTO sources (id, label, as_of, kind, last_ingest_at, note) VALUES ('ing:synthetic-fresh', 'Synthetic Fresh export', ?, 'bank_csv', ?, '')")
    .run(addDays(CLOCK, -3), `${CLOCK}T12:00:00.000Z`);
  const sc = buildScenario(db, { clock: CLOCK });
  const model = buildBrief(db, { clock: CLOCK, publicUrl: null });
  assert.equal(model.freshness.dataThrough, sc.meta.dataThrough);
  assert.deepEqual(model.freshness.stale.map((s) => [s.label, s.ageDays]), [['Synthetic Bank export', 96]]);
  const { text } = renderBrief(model, await briefSummary(model, { engine: offEngine() }));
  assert.ok(text.includes('Synthetic Bank export'));
  assert.ok(!text.includes('Synthetic Fresh export'), 'fresh sources are not listed as stale');
}));

test('engine spend is printed as figures equal to the scenario values', () => withSeeded(async (db) => {
  const sc = buildScenario(db, { clock: CLOCK });
  const model = buildBrief(db, { clock: CLOCK, publicUrl: null });
  for (const key of ['engine.budget.used', 'engine.budget.monthly', 'engine.budget.left']) {
    assert.equal(figByKey(model, key).v, sc.fig[key].v, key);
  }
  const { text } = renderBrief(model, await briefSummary(model, { engine: offEngine() }));
  const used = figByKey(model, 'engine.budget.used');
  assert.ok(splitFigures(text).body.includes(`${used.text} [${used.ref}]`), 'spend printed with its marker');
}));

test('every [n] marker ties back to a scenario figure, and no amount appears outside a figure reference', () => withSeeded(async (db) => {
  const sc = buildScenario(db, { clock: CLOCK });
  const model = buildBrief(db, { clock: CLOCK, publicUrl: null });
  const refs = model.figures.map((f) => f.ref);
  assert.equal(new Set(refs).size, refs.length, 'refs are unique');
  const byRef = new Map(model.figures.map((f) => [String(f.ref), f]));

  for (const f of model.figures) {
    if (Object.hasOwn(sc.fig, f.key)) {
      const s = sc.fig[f.key];
      assert.equal(f.v, s.v, `${f.key} value`);
      assert.equal(f.kind, s.kind, `${f.key} kind`);
      assert.equal(f.kindWord, KIND_WORDS[s.kind], `${f.key} kind word`);
      assert.equal(f.source, sc.src[s.src].label, `${f.key} source label`);
    } else {
      const lawKey = f.key.replace(/^law\./, '');
      assert.equal(f.source, 'Statutory amount', `${f.key} is a statutory amount`);
      assert.equal(f.v, sc.law[lawKey], `${f.key} statutory value`);
    }
  }

  const { text, html } = renderBrief(model, await briefSummary(model, { engine: offEngine() }));
  const { body, figures } = splitFigures(text);
  const markers = [...body.matchAll(/\[(\d+)\]/g)].map((m) => m[1]);
  assert.ok(markers.length > 0, 'the body cites figures');
  for (const n of markers) assert.ok(byRef.has(n), `marker [${n}] is in the Figures list`);
  for (const f of model.figures) {
    const line = figures.split('\n').find((l) => l.startsWith(`[${f.ref}] `));
    assert.ok(line, `Figures line for [${f.ref}]`);
    assert.ok(line.includes(f.text), `[${f.ref}] prints ${f.text}`);
    assert.ok(line.includes(f.kindWord), `[${f.ref}] kind word`);
    assert.ok(line.includes(`Source: ${f.source}`), `[${f.ref}] source`);
    if (f.asOf) assert.ok(line.includes(`as of ${f.asOf}`), `[${f.ref}] as of`);
    assert.ok(html.includes(f.source), `[${f.ref}] source in the html`);
  }
  for (const m of body.matchAll(MONEY)) {
    const after = body.slice(m.index + m[0].length);
    const hit = /^\s?\[(\d+)\]/.exec(after);
    assert.ok(hit, `amount ${m[0]} is followed by a figure marker`);
    assert.equal(byRef.get(hit[1]).text, m[0], `${m[0]} is the text of figure [${hit[1]}]`);
  }
}));

test('a publicUrl with a trailing slash builds links with no double slash', () => withSeeded(async (db) => {
  const model = buildBrief(db, { clock: CLOCK, publicUrl: `${URL_BASE}/` });
  assert.ok(model.links.length > 0);
  const linked = renderBrief(model, await briefSummary(model, { engine: offEngine() }));
  assert.ok(linked.text.includes(`${URL_BASE}/#/brief`));
  assert.ok(linked.html.includes(`href="${URL_BASE}/#/brief"`));
  assert.ok(!/[^:]\/\//.test(linked.text.replace(/https?:\/\//g, '')), 'no double slash in the text');
  for (const l of model.links) assert.ok(!JSON.stringify(l).includes(`${URL_BASE}//`), 'no double slash in a link');
}));

test('links appear only when publicUrl is set', () => withSeeded(async (db) => {
  const off = offEngine();
  const plain = renderBrief(buildBrief(db, { clock: CLOCK, publicUrl: null }), await briefSummary(buildBrief(db, { clock: CLOCK, publicUrl: null }), { engine: off }));
  assert.ok(!/https?:\/\//.test(plain.text), 'no URL in the text');
  assert.ok(!/href=/.test(plain.html), 'no link in the html');
  const model = buildBrief(db, { clock: CLOCK, publicUrl: URL_BASE });
  assert.ok(model.links.length > 0);
  const linked = renderBrief(model, await briefSummary(model, { engine: off }));
  assert.ok(linked.text.includes(`${URL_BASE}/#/brief`));
  assert.ok(linked.html.includes(`href="${URL_BASE}/#/brief"`));
}));

test('r2 item 1: unavailable and noted figures print their qualifiers, escaped', () => withSeeded(async (db) => {
  const model = buildBrief(db, { clock: CLOCK, publicUrl: null });
  const used = figByKey(model, 'engine.budget.used');
  const monthly = figByKey(model, 'engine.budget.monthly');
  used.unavailable = 'Synthetic <b>ledger</b> gap & lag';
  monthly.notes = ['Synthetic <i>assumption</i> text'];
  const { text, html } = renderBrief(model, await briefSummary(model, { engine: offEngine() }));
  assert.ok(text.includes(`${used.text} [${used.ref}] (not current: Synthetic <b>ledger</b> gap & lag)`), 'unavailable qualifier in text');
  const { figures } = splitFigures(text);
  const at = figures.indexOf(`[${monthly.ref}] `);
  assert.ok(at >= 0 && figures.indexOf('Synthetic <i>assumption</i> text') > at, 'note listed under its footnote');
  assert.ok(html.includes('Synthetic &lt;b&gt;ledger&lt;/b&gt; gap &amp; lag'));
  assert.ok(html.includes('Synthetic &lt;i&gt;assumption&lt;/i&gt; text'));
  assert.ok(!html.includes('<b>ledger') && !html.includes('<i>assumption'));
}));

test('r2 item 2 and r3: summaries with literal amounts, number words or unknown tokens fall back to the template', () => withSeeded(async (db) => {
  const model = buildBrief(db, { clock: CLOCK, publicUrl: null });
  figByKey(model, 'engine.budget.left').notes = ['7 eligible days'];
  assert.equal(figByKey(model, 'engine.budget.monthly').v, 200, 'demo cap is a round figure value');
  const rejected = [
    'Spend so far is $7.',
    'Save seven dollars.',
    'The cap is two hundred dollars.',
    'Spend so far is {f:engine.budget.used}, about 20 percent.',
    'Spend so far is {f:engine.budget.used}, under 25%.',
    'Half of {f:engine.budget.monthly} is still free.',
    'Spend so far is {f:no.such.figure}.',
    'Spend so far is {f:engine.budget.used} and 38.4 more.',
  ];
  for (const text of rejected) {
    const engine = scriptedEngine({ text });
    const s = await briefSummary(model, { engine });
    assert.equal(engine.calls.length, 1, `engine asked for: ${text}`);
    assert.equal(s.src, 'template', `rejected: ${text}`);
    const out = renderBrief(model, s);
    assert.ok(!out.text.includes(text.replace(/\{f:[^}]+\}/g, '')), `not printed: ${text}`);
  }
}));

test('r2 item 2: a summary citing a known figure token is accepted and rendered with its ref', () => withSeeded(async (db) => {
  const model = buildBrief(db, { clock: CLOCK, publicUrl: null });
  const used = figByKey(model, 'engine.budget.used');
  const engine = scriptedEngine({ text: 'Spend so far is {f:engine.budget.used}.' });
  const s = await briefSummary(model, { engine });
  assert.equal(s.src, 'model');
  assert.equal(s.costUsd, 0.002);
  assert.equal(engine.calls[0].purpose, 'job');
  const { text, html } = renderBrief(model, s);
  assert.ok(text.includes(`Spend so far is ${used.text} [${used.ref}].`));
  assert.ok(html.includes(used.text) && html.includes(`[${used.ref}]`));
  assert.ok(!text.includes('{f:'), 'no raw token printed');
}));

test('a createEngine fake-mode engine is used when scripted and falls back when it has no script or is off', () => withSeeded(async (db) => {
  const model = buildBrief(db, { clock: CLOCK, publicUrl: null });
  const ok = await briefSummary(model, { engine: createEngine({ mode: 'fake', responses: [{ text: 'Spend so far is {f:engine.budget.left}.' }] }) });
  assert.equal(ok.src, 'model');
  assert.ok(ok.costUsd > 0);
  const empty = await briefSummary(model, { engine: createEngine({ mode: 'fake', responses: [] }) });
  assert.equal(empty.src, 'template');
  const off = await briefSummary(model, { engine: createEngine({ mode: 'off' }) });
  assert.equal(off.src, 'template');
}));

test('engine off, budget exceeded and call errors fall back to the template', () => withSeeded(async (db) => {
  const model = buildBrief(db, { clock: CLOCK, publicUrl: null });
  for (const error of [new EngineOffError(), new BudgetExceededError(), new ModelCallError(), new Error('synthetic failure')]) {
    const s = await briefSummary(model, { engine: scriptedEngine({ error }) });
    assert.equal(s.src, 'template', error.name);
    assert.equal(typeof s.text, 'string');
    assert.ok(s.text.length > 0, `${error.name}: template text`);
  }
  const s = await briefSummary(model, { engine: null });
  assert.equal(s.src, 'template', 'no engine');
}));

test('composeBrief returns the rendered parts, the summary source and the model', () => withSeeded(async (db) => {
  const viaModel = await composeBrief(db, { clock: CLOCK, publicUrl: null, engine: scriptedEngine({ text: 'Spend so far is {f:engine.budget.used}.' }) });
  assert.equal(viaModel.summarySrc, 'model');
  assert.equal(viaModel.costUsd, 0.002);
  for (const k of ['subject', 'text', 'html']) assert.ok(typeof viaModel[k] === 'string' && viaModel[k].length > 0, k);
  assert.ok(!/[\r\n]/.test(viaModel.subject));
  assert.ok(Array.isArray(viaModel.model.figures));
  const viaTemplate = await composeBrief(db, { clock: CLOCK, publicUrl: null, engine: offEngine() });
  assert.equal(viaTemplate.summarySrc, 'template');
}));

test('hostile stored text is escaped in the HTML and plain in the text part; HTML uses inline styles only', () => withSeeded(async (db) => {
  const deadlineTitle = '<img src=x onerror=alert(1)> Synthetic deadline';
  const sourceLabel = '<script>alert(2)</script> Synthetic source';
  const recTitle = '<img src=y onerror=alert(3)> Synthetic rec';
  db.prepare('INSERT INTO deadlines (date, label, title, rec_id, hard) VALUES (?, ?, ?, NULL, 0)').run(addDays(CLOCK, 10), 'Soon', deadlineTitle);
  const asOf = addDays(CLOCK, -120);
  db.prepare("INSERT INTO sources (id, label, as_of, kind, last_ingest_at, note) VALUES ('ing:synthetic-hostile', ?, ?, 'bank_csv', ?, '')")
    .run(sourceLabel, asOf, `${asOf}T12:00:00.000Z`);
  const sc = buildScenario(db, { clock: CLOCK });
  const target = needsYou(sc.recs)[0];
  const row = db.prepare('SELECT def FROM recs WHERE id = ?').get(target.id);
  db.prepare('UPDATE recs SET def = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.def), title: recTitle }), target.id);

  const { text, html } = await composeBrief(db, { clock: CLOCK, publicUrl: null, engine: offEngine() });
  assert.ok(!/<img/i.test(html), 'no raw img');
  assert.ok(!/<script/i.test(html), 'no raw script');
  assert.ok(!/<[^>]*onerror=/i.test(html), 'no tag carries onerror');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; Synthetic deadline'));
  assert.ok(html.includes('&lt;script&gt;alert(2)&lt;/script&gt; Synthetic source'));
  assert.ok(html.includes('&lt;img src=y onerror=alert(3)&gt; Synthetic rec'));
  for (const s of [deadlineTitle, sourceLabel, recTitle]) assert.ok(text.includes(s), `plain in text: ${s}`);
  assert.ok(!/<style[\s>]/i.test(html), 'no style element');
  assert.ok(!/<script[\s>]/i.test(html), 'no script element');
  assert.match(html, /style="/, 'inline style attributes');
}));
