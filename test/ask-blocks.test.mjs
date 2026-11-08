// Rich Ask answers, B3 and B4: the block shell (web/horizon/screens/ask-blocks.js) and the table and
// compare renderers (ask-block-table.js, ask-block-compare.js) draw stored block snapshots
// (docs/plans/rich-ask-answers.md sections 2 and 5). Synthetic fixtures under test/fixtures/blocks;
// no DOM. Every expected value is read from the fixture, never typed here.
//
// The shell's API:
//   useKit({ esc, money, registerFigures })  the escaper, api.money and api.registerFigures.
//   messageBodyHtml(m)          the inner html of a Fathom message body: m.html's top level
//                               paragraphs with each block after paragraph `after`, then the
//                               block notes; m.html unchanged when the message has neither.
//                               Registers every block figure through registerFigures.
//   blockState(messageId, blockId)  the block's mutable view state { sort, filter, all }.
//   formatByUnit(value, unit, { short })  a value as text for its unit.
//   dropNote(op)                the fixed note for a block that cannot be drawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { esc, money } from '../src/shared/tokens.mjs';
import { useKit, messageBodyHtml, blockState, formatByUnit, dropNote } from '../web/horizon/screens/ask-blocks.js';
import { niceTicks } from '../web/horizon/screens/ask-block-chart.js';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/blocks/${name}.json`, import.meta.url), 'utf8'));

let registered = new Map();
useKit({ esc, money, registerFigures: (map) => { for (const [k, v] of Object.entries(map)) registered.set(k, v); } });

let seq = 0;
function msg(blocks, extra = {}) {
  seq += 1;
  return { id: `m${seq}`, role: 'fathom', html: '<p>First.</p><p>Second.</p><p>Third.</p>', provenance: { blocks, ...extra } };
}

const figKeys = (html) => [...html.matchAll(/<span class="fx-fig[^"]*"[^>]*data-fig="([^"]+)"/g)].map((x) => x[1]);
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

test('stale and unavailable states keep stored values and mark their provenance', () => {
  const block = fx('table'), message = msg([block]);
  blockState(message.id, block.id).status = 'stale';
  const stale = messageBodyHtml(message);
  assert.match(stale, /Stale/); assert.match(stale, /Ask again/);
  assert.match(stale, /Your data changed after this answer/);
  assert.ok(figKeys(stale).every(key => registered.get(key).stale));
  blockState(message.id, block.id).status = 'unavailable';
  const unavailable = messageBodyHtml(message);
  assert.match(unavailable, /This data is no longer available/);
  assert.match(unavailable, /h-blk-unavailable/);
  assert.deepEqual(figKeys(unavailable), figKeys(stale));
});
const strip = (s) => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const between = (html, open, close) => [...html.matchAll(new RegExp(`${open}([\\s\\S]*?)${close}`, 'g'))].map((x) => x[1]);
const headers = (html) => between(html, '<th[^>]*>', '</th>').map(strip);
// The text of column i in each body row, in order.
const column = (html, i) => between(html.split('<tbody')[1] || '', '<tr[^>]*>', '</tr>').map((row) => strip(between(row, '<t[dh][^>]*>', '</t[dh]>')[i] || ''));

// Every figure envelope a snapshot cell carries, in cell order.
function cellFigures(snapshot) {
  const out = [];
  const rows = snapshot.rows || snapshot.options || [];
  for (const r of rows) for (const c of r.cells) {
    if (c.t === 'fig' || (c.t === 'none' && c.fig)) out.push(c.fig);
    else if (c.t === 'row') out.push(c);
  }
  return out;
}

test('a block goes after paragraph `after`; a message without blocks keeps its html', () => {
  const block = fx('table');
  const m = msg([block]);
  const html = messageBodyHtml(m);
  const at = html.indexOf('<figure');
  assert.ok(at > html.indexOf('<p>First.</p>') && at < html.indexOf('<p>Second.</p>'), 'the table sits after the first paragraph');
  const plain = { id: 'm0', role: 'fathom', html: '<p>Only text.</p>', provenance: { tools: [] } };
  assert.equal(messageBodyHtml(plain), plain.html);
  assert.equal(messageBodyHtml({ id: 'm00', role: 'fathom', html: '<p>x</p>', provenance: null }), '<p>x</p>');
});

test('a block whose after is past the last paragraph goes at the end, in order', () => {
  const a = { ...fx('table'), after: 9 };
  const b = { ...fx('compare'), after: 9 };
  const html = messageBodyHtml(msg([a, b]));
  assert.ok(html.indexOf('<p>Third.</p>') < html.indexOf(`data-blk="`), 'blocks follow the text');
  assert.ok(html.indexOf(a.snapshot.title) < html.indexOf(b.snapshot.title), 'call order kept');
});

test('every table value is a .fx-fig span registered under a blk: key with its unit, source and as-of date', () => {
  registered = new Map();
  const block = fx('table');
  const m = msg([block]);
  const html = messageBodyHtml(m);
  const keys = figKeys(html);
  const figs = cellFigures(block.snapshot);
  assert.equal(keys.length, figs.length, 'one figure span per figure cell');
  assert.equal(new Set(keys).size, keys.length, 'keys are unique');
  for (const k of keys) {
    assert.match(k, new RegExp(`^blk:${m.id}:${block.id}:\\d+$`));
    assert.ok(registered.has(k), `${k} is registered`);
  }
  // The registered entry carries the envelope's value, unit, label, source and as-of date.
  const want = new Set(figs.filter((f) => f.unit).map((f) => JSON.stringify([f.value, f.unit, f.label, f.source, f.asOf])));
  const got = new Set([...registered.values()].filter((r) => r.unit).map((r) => JSON.stringify([r.value, r.unit, r.label, r.source, r.asOf])));
  for (const w of want) assert.ok(got.has(w), `registered ${w}`);
  // ...and its provenance, unchanged.
  for (const f of figs.filter((x) => x.unit)) {
    assert.ok([...registered.values()].some((r) => r.label === f.label && JSON.stringify(r.provenance) === JSON.stringify(f.provenance)), `provenance of ${f.label}`);
  }
  // No digit is printed outside a figure span in the table body (labels and text cells hold none).
  const outside = html.split('<tbody')[1].replace(/<span class="fx-fig[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '');
  assert.doesNotMatch(outside, /\d/);
});

test('row numbers register with their row as provenance', () => {
  registered = new Map();
  const block = fx('table-rows');
  const m = msg([block]);
  const html = messageBodyHtml(m);
  const keys = figKeys(html);
  assert.equal(keys.length, block.snapshot.rows.length);
  const rows = block.snapshot.rows.map((r) => r.cells.find((c) => c.t === 'row'));
  for (const r of rows) {
    const hit = [...registered.values()].find((x) => x.value === r.value && x.unit === 'usd');
    assert.ok(hit, `row ${r.row.description} registered`);
    assert.equal(hit.source, r.row.account);
    assert.equal(hit.asOf, r.row.date);
    assert.equal(hit.label, r.row.description);
    assert.deepEqual(hit.provenance, { row: r.row });
  }
});

test('labels come from the snapshot only, and the title is escaped', () => {
  const block = fx('table');
  block.snapshot.title = '<img src=x onerror=alert(1)> & co';
  block.snapshot.columns = block.snapshot.columns.map((c, i) => ({ ...c, label: `Column ${'ABCD'[i]}` }));
  const html = messageBodyHtml(msg([block]));
  assert.ok(!html.includes('<img'), 'no raw markup from the title');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; co'));
  assert.match(html, /<figcaption[^>]*>[^<]*&lt;img/);
  assert.deepEqual(headers(html), block.snapshot.columns.map((c) => c.label));
});

test('compare: each option is a labelled group, every value a figure, unavailable reads Unavailable', () => {
  registered = new Map();
  const block = fx('compare');
  const m = msg([block]);
  const html = messageBodyHtml(m);
  const groups = [...html.matchAll(/<section[^>]*role="group"[^>]*aria-labelledby="([^"]+)"/g)].map((x) => x[1]);
  assert.equal(groups.length, block.snapshot.options.length);
  for (const [i, o] of block.snapshot.options.entries()) {
    const head = new RegExp(`id="${groups[i]}"[^>]*>([^<]*)<`).exec(html);
    assert.equal(head && decode(head[1]), o.label);
  }
  for (const f of block.snapshot.fields) assert.ok(html.includes(`>${esc(f.label)}<`), `field ${f.label}`);
  const figs = cellFigures(block.snapshot);
  assert.equal(figKeys(html).length, figs.length);
  const none = block.snapshot.options.flatMap((o) => o.cells).filter((c) => c.t === 'none').length;
  assert.equal((html.match(/>Unavailable</g) || []).length, none);
  assert.ok([...registered.values()].some((r) => r.value === null && r.gaps.length), 'unavailable figure keeps its gap');
});

test('an op with no renderer draws the dropped note; stored notes render under the answer', () => {
  const { blocks, blockNotes } = fx('notes');
  const html = messageBodyHtml(msg(blocks, { blockNotes }));
  assert.ok(html.includes(esc(dropNote(blocks[0].op))), 'dropped note for the unknown op');
  assert.ok(!html.includes(esc(blocks[0].snapshot.title)), 'no block drawn');
  for (const n of blockNotes) assert.ok(html.includes(esc(n.text)), n.text);
  assert.ok(html.lastIndexOf(esc(blockNotes[0].text)) > html.indexOf('<p>Third.</p>'), 'notes follow the text');
  assert.match(dropNote('table'), /^A table was left out because its data did not check out\.$/);
  assert.match(dropNote('compare'), /^A comparison /);
  assert.match(dropNote('chart'), /^A chart /);
  assert.match(dropNote('timeline'), /^A timeline /);
});

test('sorting by a figure column orders by value, unavailable last, and sets aria-sort', () => {
  const block = fx('table');
  const m = msg([block]);
  const names = block.snapshot.rows.map((r) => r.cells[0].text);
  const spent = block.snapshot.rows.map((r) => r.cells[1].fig.value);
  const order = (dir) => names.map((n, i) => [n, spent[i]])
    .sort((a, b) => (a[1] === null) - (b[1] === null) || (dir === 'asc' ? a[1] - b[1] : b[1] - a[1]))
    .map((x) => x[0]);
  for (const dir of ['desc', 'asc']) {
    Object.assign(blockState(m.id, block.id), { sort: { column: 1, dir } });
    const html = messageBodyHtml(m);
    assert.deepEqual(column(html, 0), order(dir), dir);
    const ths = [...html.matchAll(/<th[^>]*aria-sort="([^"]+)"/g)].map((x) => x[1]);
    assert.deepEqual(ths, ['none', dir === 'asc' ? 'ascending' : 'descending', 'none', 'none']);
  }
});

test('sorting by a text column and by a row-number column', () => {
  const block = fx('table');
  const m = msg([block]);
  Object.assign(blockState(m.id, block.id), { sort: { column: 0, dir: 'asc' } });
  const names = block.snapshot.rows.map((r) => r.cells[0].text);
  assert.deepEqual(column(messageBodyHtml(m), 0), [...names].sort((a, b) => a.localeCompare(b)));

  const rows = fx('table-rows');
  const m2 = msg([rows]);
  const desc = rows.snapshot.rows.map((r) => [r.cells[1].text, r.cells[2].value]).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  Object.assign(blockState(m2.id, rows.id), { sort: { column: 2, dir: 'desc' } });
  assert.deepEqual(column(messageBodyHtml(m2), 1), desc);
});

test('the snapshot sort is the starting order', () => {
  const block = fx('table');
  block.snapshot.sort = { column: 3, dir: 'desc' };
  const m = msg([block]);
  const html = messageBodyHtml(m);
  const want = block.snapshot.rows.map((r) => [r.cells[0].text, r.cells[3].fig.value]).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  assert.deepEqual(column(html, 0), want);
  assert.match(html, /<th[^>]*aria-sort="descending"[^>]*>[\s\S]*?Column|<th[^>]*aria-sort="descending"/);
});

test('sort buttons sit in th scope=col and carry data-blk-ctl', () => {
  const block = fx('table');
  const m = msg([block]);
  const html = messageBodyHtml(m);
  const ths = [...html.matchAll(/<th scope="col"[^>]*>\s*<button type="button"[^>]*data-blk-ctl="([^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual(ths, block.snapshot.columns.map((_, i) => `${m.id}:${block.id}:sort-${i}`));
});

test('the filter appears above tables with more than 8 rows and narrows the rows', () => {
  const block = fx('table');
  assert.ok(block.snapshot.rows.length > 8);
  const m = msg([block]);
  const html = messageBodyHtml(m);
  assert.match(html, /<input type="search"[^>]*data-blk-ctl="[^"]+:filter"/);
  assert.match(html, /<label[^>]*for="([^"]+)"[\s\S]*?<input type="search" id="\1"/);
  const target = block.snapshot.rows[2].cells[0].text;
  Object.assign(blockState(m.id, block.id), { filter: target.slice(0, 4).toUpperCase() });
  const names = block.snapshot.rows.map((r) => r.cells[0].text).filter((n) => n.toLowerCase().includes(target.slice(0, 4).toLowerCase()));
  assert.deepEqual(column(messageBodyHtml(m), 0), names);
  const small = fx('table-rows');
  assert.ok(small.snapshot.rows.length <= 8);
  assert.doesNotMatch(messageBodyHtml(msg([small])), /type="search"/);
});

test('more than 20 rows show 20 with Show all N rows', () => {
  const block = fx('table');
  const base = block.snapshot.rows;
  block.snapshot.rows = Array.from({ length: 25 }, (_, i) => base[i % base.length]);
  const m = msg([block]);
  let html = messageBodyHtml(m);
  assert.equal(column(html, 0).length, 20);
  assert.match(html, /<button type="button"[^>]*data-blk-ctl="[^"]+:all"[^>]*>Show all 25 rows<\/button>/);
  blockState(m.id, block.id).all = true;
  html = messageBodyHtml(m);
  assert.equal(column(html, 0).length, 25);
});

test('the table scrolls inside a labelled, focusable container', () => {
  const block = fx('table');
  const html = messageBodyHtml(msg([block]));
  assert.match(html, new RegExp(`<div class="h-blk-tw" tabindex="0" role="region" aria-label="${esc(block.snapshot.title)}"`));
  assert.match(html, /<figure class="h-blk[^"]*"[^>]*>\s*<figcaption/);
});

test('formatByUnit writes each unit in words people read', () => {
  assert.equal(formatByUnit(0.21, 'ratio'), '21%');
  assert.equal(formatByUnit(0.098, 'ratio'), '9.8%');
  assert.equal(formatByUnit(18, 'count'), '18');
  assert.equal(formatByUnit(19, 'years'), '19 years');
  assert.equal(formatByUnit(1, 'months'), '1 month');
  assert.equal(formatByUnit(12, 'days'), '12 days');
  assert.equal(formatByUnit(59.5, 'age'), '59 and a half');
  assert.equal(formatByUnit('2045-06-01', 'date'), 'Jun 1, 2045');
  assert.equal(formatByUnit('2026-03', 'date'), 'Mar 2026');
  assert.equal(formatByUnit(612.4, 'usd'), money(612.4, { cents: true }));
  assert.equal(formatByUnit(1210000, 'usd'), money(1210000));
  assert.equal(formatByUnit(1210000, 'usd', { short: true }), money(1210000, { k: true }));
  assert.equal(formatByUnit(250, 'usd_per_month'), `${money(250)} a month`);
  assert.equal(formatByUnit(null, 'usd'), 'Unavailable');
});

// ---------- B4: chart and timeline renderers (ask-block-chart.js, ask-block-timeline.js) ----------
// Both export render(snapshot, ctx) and bind(root, snapshot, ctx) and sit in the shell's renderer
// map. Their view state lives in blockState: table (the Table toggle is on), at ({ s, i }: the
// active series and point) and w (the measured plot width in px; 560 until bind measures it).

const CHARTS = ['chart-line', 'chart-bar', 'chart-area', 'chart-scatter'];
const DRAWN = [...CHARTS, 'timeline'];

// Every figure envelope a chart or timeline snapshot draws, in snapshot order.
function drawnFigures(s) {
  if (s.series) return s.series.flatMap((x) => x.points.filter(Boolean));
  if (s.points) return s.points.flatMap((p) => [p.x, p.y]);
  return s.events.map((e) => e.value).filter(Boolean);
}
const svgOf = (html) => (/<svg[\s\S]*?<\/svg>/.exec(html) || [''])[0];
const dataFigs = (html) => [...html.matchAll(/data-fig="([^"]+)"/g)].map((x) => x[1]);
const fmt = (f) => (f.value === null ? 'Unavailable' : formatByUnit(f.value, f.unit));
const attr = (html, re) => decode((re.exec(html) || [])[1] || '');

test('charts and the timeline register every value under a blk: key and draw it', () => {
  for (const name of DRAWN) {
    registered = new Map();
    const block = fx(name);
    const m = msg([block]);
    const html = messageBodyHtml(m);
    const figs = drawnFigures(block.snapshot);
    const keys = [...registered.keys()].filter((k) => k.startsWith(`blk:${m.id}:${block.id}:`));
    assert.equal(keys.length, figs.length, `${name}: one registered figure per drawn value`);
    for (const f of figs) {
      assert.ok([...registered.values()].some((r) => r.value === f.value && r.unit === f.unit && r.label === f.label
        && r.source === f.source && r.asOf === f.asOf && JSON.stringify(r.provenance) === JSON.stringify(f.provenance)), `${name}: ${f.label} ${f.value}`);
    }
    // A scatter mark carries its y figure (data-fig, Enter opens it) and its x figure (data-fig2,
    // in the readout when the point is active).
    const drawn = new Set([...(name === 'timeline' ? html : svgOf(html)).matchAll(/data-fig2?="([^"]+)"/g)].map((x) => x[1]));
    for (const k of keys) assert.ok(drawn.has(k), `${name}: ${k} is drawn`);
  }
});

test('each chart is an img with an aria-label summary built from its data', () => {
  const words = { 'chart-line': 'Line chart', 'chart-bar': 'Stacked bar chart', 'chart-area': 'Area chart' };
  for (const name of ['chart-line', 'chart-bar', 'chart-area']) {
    const block = fx(name);
    const s = block.snapshot;
    const html = messageBodyHtml(msg([block]));
    const label = attr(svgOf(html), /<svg[^>]*role="img"[^>]*aria-label="([^"]*)"/);
    assert.ok(label.startsWith(`${words[name]} of `), `${name}: ${label}`);
    for (const ser of s.series) {
      assert.ok(label.includes(ser.label), `${name}: names ${ser.label}`);
      const vals = ser.points.filter((p) => p && p.value !== null).map((p) => p.value);
      assert.ok(label.includes(formatByUnit(Math.min(...vals), ser.unit)), `${name}: low of ${ser.label}`);
      assert.ok(label.includes(formatByUnit(Math.max(...vals), ser.unit)), `${name}: high of ${ser.label}`);
    }
    assert.ok(label.includes(s.x[0].text) && label.includes(s.x.at(-1).text), `${name}: first and last x`);
  }
  const sc = fx('chart-scatter');
  const sl = attr(svgOf(messageBodyHtml(msg([sc]))), /<svg[^>]*role="img"[^>]*aria-label="([^"]*)"/);
  assert.ok(sl.startsWith(`Scatter chart of ${sc.snapshot.yLabel} against ${sc.snapshot.xLabel}`), sl);
  assert.ok(sl.includes(`${sc.snapshot.points.length} points`), sl);
  assert.ok(sl.includes(`${sc.snapshot.points.filter((p) => p.frontier).length} on the frontier`), sl);
});

test('the timeline is an ordered list with a summary, dates, labels and values', () => {
  registered = new Map();
  const block = fx('timeline');
  const ev = block.snapshot.events;
  const html = messageBodyHtml(msg([block]));
  const label = attr(html, /<ol[^>]*aria-label="([^"]*)"/);
  assert.ok(label.includes(`${ev.length} events`), label);
  assert.ok(label.includes(formatByUnit(ev[0].date, 'date')) && label.includes(formatByUnit(ev.at(-1).date, 'date')), label);
  const items = between(html, '<li[^>]*>', '</li>');
  assert.equal(items.length, ev.length);
  ev.forEach((e, i) => {
    assert.match(items[i], new RegExp(`<time datetime="${e.date}">${esc(formatByUnit(e.date, 'date'))}</time>`));
    assert.ok(strip(items[i]).includes(e.label), e.label);
    if (e.value) assert.ok(strip(items[i]).includes(fmt(e.value)), `${e.label} value`);
    else assert.doesNotMatch(items[i], /fx-fig/);
  });
});

test('a Table toggle swaps in the same values as an accessible table', () => {
  for (const name of DRAWN) {
    registered = new Map();
    const block = fx(name);
    const s = block.snapshot;
    const m = msg([block]);
    let html = messageBodyHtml(m);
    const ctl = `${m.id}:${block.id}:table`;
    assert.match(html, new RegExp(`<button type="button"[^>]*aria-pressed="false"[^>]*data-blk-ctl="${ctl}"[^>]*>Table</button>`), name);
    const chartKeys = new Set([...registered.keys()].filter((k) => k.startsWith(`blk:${m.id}:${block.id}:`)));
    blockState(m.id, block.id).table = true;
    html = messageBodyHtml(m);
    assert.match(html, new RegExp(`aria-pressed="true"[^>]*data-blk-ctl="${ctl}"`), name);
    assert.match(html, /<table class="h-blk-table">/, name);
    assert.equal(svgOf(html), '', `${name}: the chart gives way to the table`);
    assert.deepEqual(new Set(dataFigs(html)), chartKeys, `${name}: the table carries every value`);
    if (s.series) {
      assert.deepEqual(headers(html).slice(1), s.series.map((x) => x.label));
      assert.deepEqual(column(html, 0), s.x.map((x) => x.text));
      s.series.forEach((ser, j) => assert.deepEqual(column(html, j + 1), ser.points.map((p) => (p ? fmt(p) : 'Unavailable')), `${name} ${ser.label}`));
    } else if (s.points) {
      assert.deepEqual(headers(html).slice(1), [s.xLabel, s.yLabel]);
      assert.deepEqual(column(html, 0), s.points.map((p) => p.label));
      assert.deepEqual(column(html, 1), s.points.map((p) => fmt(p.x)));
      assert.deepEqual(column(html, 2), s.points.map((p) => fmt(p.y)));
    } else {
      assert.deepEqual(column(html, 0), s.events.map((e) => formatByUnit(e.date, 'date')));
      assert.deepEqual(column(html, 1), s.events.map((e) => e.label));
      assert.deepEqual(column(html, 2), s.events.map((e) => (e.value ? fmt(e.value) : '')));
    }
  }
});

test('a missing point and an unavailable figure leave a gap in the line', () => {
  const block = fx('chart-line');
  const svg = svgOf(messageBodyHtml(msg([block])));
  block.snapshot.series.forEach((ser, j) => {
    // One run per stretch of points that have a value.
    const has = ser.points.map((p) => !!p && p.value !== null);
    const runs = has.filter((h, i) => h && (i === 0 || !has[i - 1])).length;
    assert.ok(has.includes(false), `${ser.label} has a gap in the fixture`);
    const d = attr(svg, new RegExp(`<path class="h-blk-ln[^"]*" data-s="${j}" d="([^"]*)"`));
    assert.equal((d.match(/M/g) || []).length, runs, `${ser.label} draws as ${runs} runs`);
  });
});

test('a timeline with no figures reads as of the day its block was built', () => {
  const block = fx('timeline');
  assert.doesNotMatch(messageBodyHtml(msg([block])), /As of /, 'a timeline with values has its figures as-of dates');
  block.snapshot.events = block.snapshot.events.map(({ date, label }) => ({ date, label }));
  const m = msg([block]);
  const want = `As of ${formatByUnit(block.builtAt.slice(0, 10), 'date')}`;
  const html = messageBodyHtml(m);
  assert.ok(strip(html).includes(want), 'as of builtAt');
  assert.equal(figKeys(html).length, 0);
  blockState(m.id, block.id).table = true;
  const table = messageBodyHtml(m);
  assert.match(table, /<table class="h-blk-table">/);
  assert.ok(strip(table).includes(want), 'the Table view keeps the as-of line');
});

test('bars stand on a zero baseline; the scatter draws its frontier and marks the current point', () => {
  assert.match(svgOf(messageBodyHtml(msg([fx('chart-bar')]))), /class="h-blk-zero"/);
  const sc = fx('chart-scatter');
  const svg = svgOf(messageBodyHtml(msg([sc])));
  const poly = attr(svg, /<polyline class="h-blk-front" points="([^"]*)"/);
  assert.equal(poly.trim().split(/\s+/).length, sc.snapshot.points.filter((p) => p.frontier).length);
  assert.equal((svg.match(/class="[^"]*h-blk-pt[^"]*\bcur\b/g) || []).length, sc.snapshot.points.filter((p) => p.current).length);
});

test('the plot is one tab stop and the live region reads the active point', () => {
  const block = fx('chart-line');
  const s = block.snapshot;
  const m = msg([block]);
  let html = messageBodyHtml(m);
  assert.match(html, new RegExp(`<div class="h-blk-plot"[^>]*tabindex="0"[^>]*data-blk-ctl="${m.id}:${block.id}:plot"`));
  assert.doesNotMatch(svgOf(html), /tabindex/, 'marks are not tab stops');
  assert.match(html, /<p class="h-blk-read"[^>]*aria-live="polite"/);
  blockState(m.id, block.id).at = { s: 1, i: 2 };
  html = messageBodyHtml(m);
  const read = strip(between(html, '<p class="h-blk-read"[^>]*>', '</p>')[0]);
  assert.ok(read.includes(s.series[1].label) && read.includes(s.x[2].text) && read.includes(fmt(s.series[1].points[2])), read);
  const sc = fx('chart-scatter');
  const m2 = msg([sc]);
  blockState(m2.id, sc.id).at = { s: 0, i: 4 };
  const p = sc.snapshot.points[4];
  const r2 = strip(between(messageBodyHtml(m2), '<p class="h-blk-read"[^>]*>', '</p>')[0]);
  assert.ok(r2.includes(p.label) && r2.includes(fmt(p.x)) && r2.includes(fmt(p.y)), r2);
});

test('the plot is 200px tall up to 480px wide and at most 240px (16:9) above', () => {
  const block = fx('chart-area');
  const m = msg([block]);
  const st = blockState(m.id, block.id);
  for (const [w, h] of [[288, 200], [480, 200], [400, 200], [560, 240], [720, 240]]) {
    st.w = w;
    assert.match(svgOf(messageBodyHtml(m)), new RegExp(`viewBox="0 0 ${w} ${h}"`), `${w}px`);
  }
});

test('series labels and titles are escaped', () => {
  const block = fx('chart-line');
  block.snapshot.series[0].label = '<img src=x onerror=alert(1)>';
  const html = messageBodyHtml(msg([block]));
  assert.ok(!html.includes('<img'));
});

test('niceTicks keeps design.js scale marks', () => {
  assert.deepEqual(niceTicks(0, 95, 4), [0, 25, 50, 75, 100]);
  assert.deepEqual(niceTicks(-120, 480, 4), [-200, 0, 200, 400, 600]);
  assert.deepEqual(niceTicks(0.095, 0.207, 4), [0.05, 0.1, 0.15, 0.2, 0.25]);
});

// UI3 AC2: a transaction row's figure is labeled with the readable name, and its popover keeps the
// bank's raw text as a detail line; a row whose name is its description adds nothing.
test('a transaction row figure keeps the raw bank text beside its readable name', () => {
  const raw = 'ORIG CO NAME:EXAMPLE PAYROLL CO ENTRY DESCR:NET SEC:CCD';
  const row = (description, name) => ({ t: 'row', value: -10, unit: 'usd', row: { account: 'Checking', date: '2032-03-01', description, name } });
  const block = { id: 'bt', op: 'table', after: 1, spec: {}, calls: [], snapshot: { title: 'Rows', columns: [{ label: 'Amount', type: 'row' }],
    rows: [{ cells: [row(raw, 'Example Payroll payroll (net)')] }, { cells: [row('Grocery market', 'Grocery market')] }] } };
  registered = new Map();
  messageBodyHtml(msg([block]));
  const figs = [...registered.values()];
  const named = figs.find((f) => f.label === 'Example Payroll payroll (net)');
  assert.ok(named, 'the readable name labels the figure');
  assert.deepEqual(named.detail, [{ k: 'Bank text', v: raw }], 'the raw bank text stays in the popover');
  const plain = figs.find((f) => f.label === 'Grocery market');
  assert.equal(plain.detail, undefined, 'no detail line when the name is the description');
});

// UI3 AC2: the rows behind a figure ("Show rows") show the readable name with the raw bank text on hover.
test('drill rows show the readable name and keep the raw bank text as its title', async () => {
  const { render } = await import('../web/horizon/screens/ask-block-table.js');
  const raw = 'SQ *SAMPLE COFFEE #0412';
  const snapshot = { title: 'Spending', columns: [{ label: 'Spent', unit: 'usd', type: 'fig' }],
    rows: [{ cells: [{ t: 'fig', drill: { tool: 'spending' }, fig: { value: 12, unit: 'usd', label: 'Coffee', kind: 'm', asOf: '2032-03-01', gaps: [], provenance: {}, source: 'Spending' } }] }] };
  const items = [
    { date: '2032-03-01', account: 'Card', description: raw, name: 'Sample Coffee', fig: null },
    { date: '2032-03-02', account: 'Card', description: 'Grocery market', name: 'Grocery market', fig: null },
  ];
  const ctx = { esc, key: 'm:b', ctl: (x) => x, fig: () => '', rowFigure: () => '',
    state: { sort: null, filter: '', all: false, drill: '0-0', drillData: { sum: null, items } } };
  const html = render(snapshot, ctx);
  assert.ok(html.includes(`<span title="${esc(raw)}">Sample Coffee</span>`), 'the name carries the raw text as its title');
  assert.ok(html.includes(' Grocery market '), 'a name equal to its description is shown once, plainly');
  assert.ok(!html.includes('title="Grocery market"'));
});

// UI3 AC2: a compare block's description cell shows the readable name with the raw text on hover.
test('compare cells show a description\'s readable name and keep the raw bank text as its title', async () => {
  const { render } = await import('../web/horizon/screens/ask-block-compare.js');
  const raw = 'ORIG CO NAME:GUSTO CO ENTRY DESCR:NET SEC:CCD';
  const snapshot = { title: 'Two rows', fields: [{ label: 'Description' }], options: [
    { label: 'First', cells: [{ t: 'text', text: raw, name: 'Gusto payroll (net)' }] },
    { label: 'Second', cells: [{ t: 'text', text: 'Grocery market', name: 'Grocery market' }] }] };
  const html = render(snapshot, { esc, key: 'm:c', ctl: (x) => x, fig: () => '' });
  assert.ok(html.includes(`<span title="${esc(raw)}">Gusto payroll (net)</span>`), 'the name shows with the raw text as its title');
  assert.ok(html.includes('<dd>Grocery market</dd>'), 'a name equal to its text is shown plainly');
});
