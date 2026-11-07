// Monthly brief (src/email/brief.mjs) over a seeded demo store at the demo clock: the model
// (verdict, needs-you recs with urgency and deep links, 90 day deadlines, tiles, stale sources,
// engine spend), tile omission when data is missing, the deadline strip layout, deep link
// shapes with and without a publicUrl, figure tie-back (no amount outside the registry),
// summary acceptance (lexical rejection, then grounding on figure values only; engine failures
// keep the verdict sub-line), the plain-text alternative, escaping of hostile stored text, and
// the dark email-safe HTML structure on the demo store.

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
import { buildBrief, briefSummary, renderBrief, composeBrief, stripLayout, appLink, urgencyOf } from '../../src/email/brief.mjs';
import { C } from '../../src/email/palette.mjs';

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

const textOf = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ');
const hrefs = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
const off = async (model) => briefSummary(model, { engine: offEngine() });

test('the model carries the verdict, needs-you recs with windows, and only 90 day deadlines', () => withSeeded(async (db) => {
  const sc = buildScenario(db, { clock: CLOCK });
  const model = buildBrief(db, { clock: CLOCK, publicUrl: null });
  const needs = needsYou(sc.recs);
  assert.equal(model.verdict.level, verdictLevel(sc.recs));
  assert.equal(model.verdict.level, 'attention');
  assert.deepEqual(model.needs.map((n) => n.id), needs.map((r) => r.id));

  const end = addDays(CLOCK, 90);
  const skip = new Set(sc.recs.filter((r) => ['done', 'dismissed', 'hidden'].includes(r.status)).map((r) => r.id));
  const want = sc.deadlines.filter((d) => d.date >= CLOCK && d.date <= end && !(d.recId && skip.has(d.recId)));
  assert.ok(want.length > 0 && want.length < sc.deadlines.length, 'the demo has deadlines inside and outside 90 days');
  assert.deepEqual(model.deadlines.map((d) => [d.date, d.title]), want.map((d) => [d.date, d.title]));

  const { text, html } = renderBrief(model, await off(model));
  const headline = sc.verdict.attention.headline.replace('{count}', String(needs.length));
  assert.ok(text.includes(headline) && html.includes(headline), 'verdict headline');
  for (const r of needs) {
    assert.ok(text.includes(r.window.label), `window label of ${r.id}`);
    assert.ok(html.includes(r.window.label), `window chip of ${r.id}`);
  }
  for (const d of want) assert.ok(text.includes(d.title), `deadline ${d.title}`);
  const later = sc.deadlines.find((d) => d.date > end);
  assert.ok(!text.includes(later.title), 'a deadline past 90 days is left out');
}));

test('deadlines for done, dismissed or hidden recs are left out', () => withSeeded(async (db) => {
  const sc = buildScenario(db, { clock: CLOCK });
  const end = addDays(CLOCK, 90);
  const linked = [...new Set(sc.deadlines.filter((d) => d.recId && d.date >= CLOCK && d.date <= end).map((d) => d.recId))];
  assert.ok(linked.length >= 3, 'the demo links at least three recs to near deadlines');
  const statuses = ['done', 'dismissed', 'hidden'];
  linked.forEach((id, i) => db.prepare('UPDATE recs SET status = ? WHERE id = ?').run(statuses[i % 3], id));
  const model = buildBrief(db, { clock: CLOCK, publicUrl: null });
  const want = sc.deadlines.filter((d) => !d.recId && d.date >= CLOCK && d.date <= end);
  assert.deepEqual(model.deadlines.map((d) => d.title), want.map((d) => d.title));
}));

test('stale ingest sources are counted in the footer line; dataThrough comes from the scenario', () => withSeeded(async (db) => {
  const asOf = addDays(CLOCK, -96);
  db.prepare("INSERT INTO sources (id, label, as_of, kind, last_ingest_at, note) VALUES ('ing:synthetic-bank', 'Synthetic Bank export', ?, 'bank_csv', ?, '')")
    .run(asOf, `${asOf}T12:00:00.000Z`);
  db.prepare("INSERT INTO sources (id, label, as_of, kind, last_ingest_at, note) VALUES ('ing:synthetic-fresh', 'Synthetic Fresh export', ?, 'bank_csv', ?, '')")
    .run(addDays(CLOCK, -3), `${CLOCK}T12:00:00.000Z`);
  const sc = buildScenario(db, { clock: CLOCK });
  const model = buildBrief(db, { clock: CLOCK, publicUrl: null });
  assert.equal(model.freshness.dataThrough, sc.meta.dataThrough);
  assert.deepEqual(model.freshness.stale.map((s) => [s.label, s.ageDays]), [['Synthetic Bank export', 96]]);
  const { text, html } = renderBrief(model, await off(model));
  const line = `1 of ${model.freshness.total} sources are stale.`;
  assert.ok(text.includes(line) && html.includes(line), 'stale source count');
  assert.ok(!text.includes('Synthetic Bank export'), 'the skim does not list source names');
}));

test('engine spend in the footer equals the scenario values', () => withSeeded(async (db) => {
  const sc = buildScenario(db, { clock: CLOCK });
  const model = buildBrief(db, { clock: CLOCK, publicUrl: null });
  for (const key of ['engine.budget.used', 'engine.budget.monthly', 'engine.budget.left']) {
    assert.equal(figByKey(model, key).v, sc.fig[key].v, key);
  }
  const used = figByKey(model, 'engine.budget.used');
  const cap = figByKey(model, 'engine.budget.monthly');
  const { text } = renderBrief(model, await off(model));
  assert.ok(text.includes(`Engine spend ${used.text} of ${cap.text}.`));
}));

test('no amount appears that is not a registry figure; the tax percent is computed from registry figures', () => withSeeded(async (db) => {
  const sc = buildScenario(db, { clock: CLOCK });
  const model = buildBrief(db, { clock: CLOCK, publicUrl: URL_BASE });
  for (const f of model.figures) {
    if (Object.hasOwn(sc.fig, f.key)) {
      const s = sc.fig[f.key];
      assert.equal(f.v, s.v, `${f.key} value`);
      assert.equal(f.kindWord, KIND_WORDS[s.kind], `${f.key} kind word`);
      assert.equal(f.source, sc.src[s.src].label, `${f.key} source label`);
    } else {
      assert.equal(f.source, 'Statutory amount', `${f.key} is a statutory amount`);
      assert.equal(f.v, sc.law[f.key.replace(/^law\./, '')], `${f.key} statutory value`);
    }
  }
  const { text, html } = renderBrief(model, await off(model));
  const allowed = new Set(model.figures.map((f) => f.text));
  const seen = [...(text.match(MONEY) || []), ...(textOf(html).match(MONEY) || [])];
  assert.ok(seen.length > 0, 'the brief prints at least one figure');
  for (const m of seen) assert.ok(allowed.has(m), `amount ${m} is a registry figure`);
  const t = model.tiles.tax;
  assert.ok(t, 'the demo has a tax tile');
  const [a, b, e] = t.keys.map((k) => figByKey(model, k).v);
  assert.equal(t.pct, Math.round(((a + b) / e) * 100));
  assert.ok(text.includes(`${t.pct}%`) && html.includes(`${t.pct}%`));
  const pcts = [...text.matchAll(/\d+%/g)].map((m) => m[0]);
  assert.deepEqual(pcts, [`${t.pct}%`], 'the only percent printed is the tax tile');
}));

test('tiles with missing data are dropped, never a placeholder', () => withSeeded(async (db) => {
  const full = buildBrief(db, { clock: CLOCK, publicUrl: URL_BASE });
  assert.ok(full.tiles.tax && full.tiles.next && full.tiles.confirm);
  const fullHtml = renderBrief(full, await off(full)).html;
  assert.ok(/Tax paid/.test(fullHtml) && /Next deadline/.test(fullHtml) && /To confirm/.test(fullHtml));

  const noTax = buildBrief(db, { clock: CLOCK });
  noTax.tiles.tax = null;
  const a = renderBrief(noTax, await off(noTax));
  assert.ok(!/Tax paid/.test(a.html) && !/Tax paid/.test(a.text));
  assert.ok(/Next deadline/.test(a.html) && /To confirm/.test(a.html));

  const none = buildBrief(db, { clock: CLOCK });
  none.tiles = { tax: null, next: null, confirm: null };
  const b = renderBrief(none, await off(none));
  for (const w of ['Tax paid', 'Next deadline', 'To confirm']) assert.ok(!b.html.includes(w) && !b.text.includes(w), `${w} dropped`);
  assert.ok(!/NaN|undefined|null/.test(textOf(b.html)), 'no placeholder text');
  assert.ok(/Needs you/.test(b.html), 'the rest of the email still renders');

  // Data driven omission: no pending confirm cards, no deadlines in range, one tax figure absent.
  db.prepare('DELETE FROM deadlines').run();
  const sparse = buildBrief(db, { clock: CLOCK });
  assert.equal(sparse.tiles.next, null);
  assert.deepEqual(sparse.deadlines, []);
  assert.ok(!renderBrief(sparse, await off(sparse)).html.includes('Next 90 days'), 'no strip without deadlines');
}));

test('urgency: due within 60 days, later, informational', () => {
  assert.equal(urgencyOf(0), 'soon');
  assert.equal(urgencyOf(60), 'soon');
  assert.equal(urgencyOf(61), 'later');
  assert.equal(urgencyOf(null), 'info');
});

test('deadline strip places dots proportionally and collapses colliding labels', () => {
  const d = (days, title, hard = false) => ({ date: addDays(CLOCK, days), days, title, hard });
  const a = stripLayout([d(9, 'Early'), d(45, 'Middle'), d(90, 'End')]);
  assert.deepEqual(a.dots.map((x) => Math.round(x.pos)), [10, 50, 100]);
  assert.equal(a.labels.length, 3, 'well spaced labels all show');
  assert.deepEqual(a.labels.map((l) => l.text), ['Early', 'Middle', 'End']);
  assert.equal(a.labels[2].align, 'right', 'a label near the right edge ends at its dot');

  const b = stripLayout([d(30, 'One'), d(30, 'Two'), d(33, 'Three'), d(80, 'Far')]);
  assert.equal(b.dots.length, 3, 'same day shares one dot');
  assert.equal(b.labels.length, 2, 'labels that would collide fold together');
  assert.equal(b.labels[0].text, '3 deadlines');
  assert.equal(b.labels[1].text, 'Far');
  for (let i = 1; i < b.dots.length; i += 1) assert.ok(b.dots[i].pos - b.dots[i - 1].pos >= 5, 'dots keep a gap');
  assert.ok(b.dots.every((x) => x.pos <= 100));
  assert.deepEqual(stripLayout([]), { dots: [], labels: [] });
});

test('deep links use the app routes with a publicUrl, and none without', () => withSeeded(async (db) => {
  assert.equal(appLink(URL_BASE, 'rec', 'a b'), `${URL_BASE}/#/rec/a%20b`);
  assert.equal(appLink(URL_BASE, 'confirm'), `${URL_BASE}/#/confirm`);
  assert.equal(appLink(null, 'add'), null);

  const plain = buildBrief(db, { clock: CLOCK, publicUrl: null });
  const p = renderBrief(plain, await off(plain));
  assert.ok(!/https?:\/\//.test(p.text), 'no URL in the text');
  assert.ok(!/href=/.test(p.html), 'no link in the html');
  assert.ok(!/Open &rarr;|Open Fathom/.test(p.html), 'no dead buttons');

  const model = buildBrief(db, { clock: `${CLOCK}`, publicUrl: `${URL_BASE}///` });
  const { text, html } = renderBrief(model, await off(model));
  const links = hrefs(html);
  assert.ok(links.includes(`${URL_BASE}/#/brief`), 'Open Fathom');
  assert.ok(links.includes(`${URL_BASE}/#/confirm`), 'start confirm');
  for (const n of model.needs) assert.ok(links.includes(`${URL_BASE}/#/rec/${n.id}`), `rec link ${n.id}`);
  assert.ok(text.includes(`${URL_BASE}/#/rec/${model.needs[0].id}`));
  assert.ok(!/[^:]\/\//.test(text.replace(/https?:\/\//g, '')) && links.every((l) => !/[^:]\/\//.test(l.replace(/^https?:\/\//, ''))), 'no double slash');
}));

test('a rec waiting on data links to Add files', () => withSeeded(async (db) => {
  const model = buildBrief(db, { clock: CLOCK, publicUrl: URL_BASE });
  model.needs.push({ id: 'x', title: 'Two more statements would sharpen the plan', titleParts: [{ t: 'Two more statements would sharpen the plan' }], windowLabel: '', days: null, urgency: 'info', cta: 'Add files', url: `${URL_BASE}/#/add` });
  const { html, text } = renderBrief(model, await off(model));
  assert.ok(hrefs(html).includes(`${URL_BASE}/#/add`));
  assert.ok(html.includes('Add files') && text.includes('Add files: '));
  db.prepare("UPDATE recs SET status = 'proposed' WHERE id = 'spsep'").run();
  const m2 = buildBrief(db, { clock: CLOCK, publicUrl: URL_BASE });
  const row = m2.needs.find((n) => n.id === 'spsep');
  assert.equal(row.cta, 'Add files');
  assert.equal(row.url, `${URL_BASE}/#/add`);
}));

test('the needs list is capped and says how many more', () => withSeeded(async (db) => {
  const model = buildBrief(db, { clock: CLOCK, publicUrl: URL_BASE });
  const proto = model.needs[0];
  while (model.needs.length < 9) model.needs.push({ ...proto, id: `x${model.needs.length}`, titleParts: [{ t: `Extra item ${model.needs.length}` }], url: `${URL_BASE}/#/rec/x${model.needs.length}` });
  const { html, text } = renderBrief(model, await off(model));
  assert.ok(html.includes('3 more in Fathom') && text.includes('3 more in Fathom.'));
  assert.ok(!html.includes('Extra item 8'));
}));

test('the sub-line is the verdict sub unless the model summary passed acceptSummary; one sentence only', () => withSeeded(async (db) => {
  const sc = buildScenario(db, { clock: CLOCK });
  const model = buildBrief(db, { clock: CLOCK, publicUrl: null });
  const sub = sc.verdict.attention.sub;
  const base = renderBrief(model, await off(model));
  assert.ok(base.html.includes(sub) && base.text.includes(sub), 'verdict sub when the engine is off');

  const rejected = await briefSummary(model, { engine: scriptedEngine({ text: 'Spend is 7 so far.' }) });
  assert.equal(rejected.src, 'template');
  assert.ok(renderBrief(model, rejected).text.includes(sub), 'rejected summary keeps the sub-line');

  const accepted = await briefSummary(model, { engine: scriptedEngine({ text: 'Spend so far is {f:engine.budget.used}. Then a second sentence we drop.' }) });
  assert.equal(accepted.src, 'model');
  const used = figByKey(model, 'engine.budget.used');
  const out = renderBrief(model, accepted);
  assert.ok(out.text.includes(`Spend so far is ${used.text}.`) && !out.text.includes('second sentence'));
  assert.ok(!out.text.includes(sub) && !out.html.includes(sub), 'the summary replaces the sub-line');
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

test('a summary citing a known figure token is accepted and rendered', () => withSeeded(async (db) => {
  const model = buildBrief(db, { clock: CLOCK, publicUrl: null });
  const used = figByKey(model, 'engine.budget.used');
  const engine = scriptedEngine({ text: 'Spend so far is {f:engine.budget.used}.' });
  const s = await briefSummary(model, { engine });
  assert.equal(s.src, 'model');
  assert.equal(s.costUsd, 0.002);
  assert.equal(engine.calls[0].purpose, 'job');
  const { text, html } = renderBrief(model, s);
  assert.ok(text.includes(`Spend so far is ${used.text}.`));
  assert.ok(html.includes(used.text));
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

test('hostile stored text is escaped in the HTML and plain in the text part', () => withSeeded(async (db) => {
  const deadlineTitle = '<img src=x onerror=alert(1)> Synthetic deadline';
  const recTitle = '<img src=y onerror=alert(3)> Synthetic rec';
  db.prepare('INSERT INTO deadlines (date, label, title, rec_id, hard) VALUES (?, ?, ?, NULL, 0)').run(addDays(CLOCK, 10), 'Soon', deadlineTitle);
  const sc = buildScenario(db, { clock: CLOCK });
  const target = needsYou(sc.recs)[0];
  const row = db.prepare('SELECT def FROM recs WHERE id = ?').get(target.id);
  db.prepare('UPDATE recs SET def = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.def), title: recTitle }), target.id);

  const { text, html } = await composeBrief(db, { clock: CLOCK, publicUrl: URL_BASE, engine: offEngine() });
  assert.ok(!/<img/i.test(html), 'no raw img');
  assert.ok(!/<[^>]*onerror=/i.test(html), 'no tag carries onerror');
  assert.ok(html.includes('&lt;img src=y onerror=alert(3)&gt; Synthetic rec'));
  assert.ok(text.includes(recTitle), 'plain in text');
  assert.ok(text.includes(deadlineTitle), 'deadline title is plain in the text');
  assert.ok(!html.includes(deadlineTitle), 'deadline title is never raw in the html');
}));

test('the HTML is dark, email safe and structured like the mock on the demo store', () => withSeeded(async (db) => {
  const model = buildBrief(db, { clock: CLOCK, publicUrl: URL_BASE });
  const { html, subject } = renderBrief(model, await off(model));
  assert.equal(subject, `Fathom brief for November 2026: ${model.needs.length} things need you`);

  // Email-safe: no script, SVG, image, external font or stylesheet; one inline head style only.
  assert.ok(!/<script|<svg|<img|<link|@import|@font-face|url\(/i.test(html));
  assert.equal((html.match(/<style/g) || []).length, 1, 'a single head style for color-scheme and the mobile gutter');
  assert.ok(html.includes('<meta name="color-scheme" content="dark">'));
  assert.ok(html.includes('<meta name="supported-color-schemes" content="dark">'));
  assert.ok(html.includes(':root{color-scheme:dark;'));
  assert.ok(html.includes('max-width:600px'));
  assert.ok(html.includes('name="viewport"'));

  // Every table and cell is set dark both as a bgcolor attribute and inline.
  const surfaces = [...html.matchAll(/<(table|td)\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(surfaces.length > 30);
  for (const tag of surfaces) {
    const attr = /bgcolor="(#[0-9a-f]{6})"/.exec(tag);
    const inline = /style="[^"]*background-color:(#[0-9a-f]{6})/.exec(tag);
    assert.ok(attr && inline && attr[1] === inline[1], `bgcolor and inline background agree: ${tag.slice(0, 80)}`);
    assert.ok(Object.values(C).includes(attr[1]), `background is a palette color: ${attr[1]}`);
  }
  // Body copy never uses near-black text.
  for (const m of html.matchAll(/[^-]color:(#[0-9a-f]{6})/g)) {
    if (m[1] === C.ink) continue; // dark ink only on the accent button
    assert.ok(!['#000000', '#0a0c0d', '#101315', '#15191b'].includes(m[1]), `text color ${m[1]} is light`);
  }
  assert.ok(html.includes(`background-color:${C.accent};color:${C.ink}`), 'accent button carries dark ink on accent');

  // Structure: header, hero with three tiles, needs rows, strip, button, one footer line.
  const order = ['FATHOM</b>', 'November 2026 brief', 'Tax paid', 'Next deadline', 'To confirm', 'Needs you', 'Next 90 days', 'Open Fathom', 'Figures come from your data'];
  let at = -1;
  for (const s of order) { const i = html.indexOf(s); assert.ok(i > at, `${s} in order`); at = i; }
  assert.equal((html.match(/Open &rarr;/g) || []).length, model.needs.length);
  assert.ok(/height:6px/.test(html), 'progress bar');
  assert.ok(!/Figures<|footnote|\[\d+\]/i.test(html), 'no figures footnote list');
  assert.ok(!/<h[1-6]|<p[ >]|<ol|<ul|<li/.test(html), 'tables and divs only');
}));

test('the plain-text alternative is a short skim with the links', () => withSeeded(async (db) => {
  const model = buildBrief(db, { clock: CLOCK, publicUrl: URL_BASE });
  const { text } = renderBrief(model, await off(model));
  assert.ok(text.startsWith('FATHOM · November 2026 brief\n'));
  for (const w of ['Tax paid:', 'Next deadline:', 'To confirm:', 'Needs you', 'Next 90 days', `Open Fathom: ${URL_BASE}/#/brief`, 'Advisory only']) assert.ok(text.includes(w), w);
  assert.ok(text.split('\n').length < 40, 'short');
  assert.ok(!/<[a-z]/i.test(text) && !/&[a-z]+;/.test(text), 'no markup');
  assert.ok(!/\u2014|\u2013/.test(text), 'no dashes');
}));
