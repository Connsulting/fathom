// Rich Ask answers, B3: the block shell (web/horizon/screens/ask-blocks.js) and the table and
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
