// P&L page model (web/horizon/screens/pnl-model.js): the pure, DOM-free logic behind the P&L table's
// sort and filter, its hash state, the rows dialog spec and the rows dialog sort.
// Tags: pnl2-ac1 hash state, sort and filter; pnl2-ac2 rows spec and rows sort; pnl2-ac3 month scope.
//
// Assumed exports and signatures (the implementer matches these exactly):
//
//   parseState(str) -> { v, m, s, d, q, t, z }
//     str is the hash state after '#/pnl/', a URLSearchParams string ('' / null / undefined allowed).
//     v: view key string or null. m: 'YYYY-MM' or null. s: 'cat' | 'tot' | 'ly' | 'avg' |
//     'm:YYYY-MM' or null. d: 'asc' | 'desc', or null when s is null; when s is set and d is
//     missing or invalid, d is the key's default ('asc' for cat, 'desc' for every numeric key).
//     q: string ('' when absent). t: 'all' | 'income' | 'expenses' ('all' when absent or invalid).
//     z: boolean (true only for z=1). Unknown keys and invalid values are ignored (defaults).
//   stateString(state) -> string
//     URLSearchParams string, keys in the order v m s d q t z. Omits v and m when null, s and d when
//     s is null, q when '', t when 'all', z when false. d is written whenever s is. Missing keys of a
//     partial state count as defaults, so stateString({}) is ''.
//   sortGroup(cats, { s, d }, valueOf) -> new array (the input is not mutated)
//     cats: [{ category, ... }]. valueOf(cat, key) -> number | null for a numeric key (never called
//     for 'cat'). s null: input order. d null: the key's default. cat sorts by localeCompare of the
//     name. Numeric keys sort by value, null as 0, ties by name ascending (in both directions).
//   filterGroup(cats, { q, t, z, m }, valueOf, section) -> new array in input order
//     section: 'income' | 'expenses' (business) or a household bucket name. q: case-insensitive
//     substring of the category name. t: 'income' keeps only section income, 'expenses' only section
//     expenses, 'all' keeps both; t is ignored for any other section. z: drops categories whose value
//     in scope, valueOf(cat, m ? 'm:' + m : 'tot'), is null or 0.
//   encodeSpec(spec) -> string; decodeSpec(str) -> spec | null
//     pnl spec:   { k: 'pnl', v, f, t, sec, cat, m }
//     spend spec: { k: 'spend', v, f, t, b, cat, m, inc: [], exc: [] }
//     The string is a URLSearchParams string, keys in the order k v f t sec|b cat m inc exc; m is
//     omitted when null, inc and exc (comma separated) when empty. decodeSpec returns the normal form
//     above (m null when absent; spend inc and exc arrays, [] when absent) or null when k is not
//     pnl|spend, cat is missing or empty, f, t or m is not a month, or a pnl sec is not
//     income|expenses.
//   sortRows(items, key, dir) -> new array. key 'date' (item.date as text, 'YYYY-MM-DD' or
//     'YYYY-MM') or 'amount' (item.value); dir 'asc' | 'desc'; ties keep input order.
//   scopeMonth(open, selected, cellMonth) -> 'YYYY-MM' | null
//     open 'cat': the selected month or null (the range). open 'cell': the cell's month.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseState, stateString, sortGroup, filterGroup, encodeSpec, decodeSpec, sortRows, scopeMonth,
} from '../web/horizon/screens/pnl-model.js';

const DEFAULTS = { v: null, m: null, s: null, d: null, q: '', t: 'all', z: false };
const names = (list) => list.map((c) => c.category);

/* ---------------------------------------------------------------- hash state */

test('pnl2-ac1 parseState of an empty or missing state is every default', () => {
  for (const s of ['', null, undefined]) assert.deepEqual(parseState(s), DEFAULTS, String(s));
  assert.equal(stateString(DEFAULTS), '');
  assert.equal(stateString({}), '', 'a partial state counts missing keys as defaults');
});

test('pnl2-ac1 the contract example parses to its parts and stringifies back to the same text', () => {
  const ex = 'v=entity%3AExample&m=2032-03&s=m%3A2032-03&d=desc&t=expenses&z=1';
  const st = parseState(ex);
  assert.deepEqual(st, { v: 'entity:Example', m: '2032-03', s: 'm:2032-03', d: 'desc', q: '', t: 'expenses', z: true });
  assert.equal(stateString(st), ex);
});

test('pnl2-ac1 stateString writes keys in the order v m s d q t z and omits defaults', () => {
  const full = { z: true, t: 'income', q: 'soft', d: 'asc', s: 'tot', m: '2032-01', v: 'household' };
  const str = stateString(full);
  assert.deepEqual([...new URLSearchParams(str).keys()], ['v', 'm', 's', 'd', 'q', 't', 'z']);
  assert.equal(str, 'v=household&m=2032-01&s=tot&d=asc&q=soft&t=income&z=1');
  assert.equal(stateString({ ...DEFAULTS, s: 'cat', d: 'asc' }), 's=cat&d=asc', 'd is written whenever s is');
  assert.equal(stateString({ ...DEFAULTS, t: 'expenses' }), 't=expenses');
  assert.equal(stateString({ ...DEFAULTS, z: true }), 'z=1');
  assert.equal(stateString({ ...DEFAULTS, m: '2032-07' }), 'm=2032-07');
  assert.equal(stateString({ ...DEFAULTS, d: 'desc' }), '', 'd without s is not written');
});

test('pnl2-ac1 round trip keeps every valid state', () => {
  const states = [
    { ...DEFAULTS, v: 'entity:examplestudio', s: 'cat', d: 'desc' },
    { ...DEFAULTS, v: 'account:biz', m: '2032-12', s: 'm:2032-12', d: 'asc', z: true },
    { ...DEFAULTS, v: 'household', s: 'avg', d: 'desc', q: 'gro' },
    { ...DEFAULTS, s: 'ly', d: 'asc', t: 'income' },
    { ...DEFAULTS, s: 'tot', d: 'desc', t: 'expenses', z: true },
  ];
  for (const st of states) assert.deepEqual(parseState(stateString(st)), st, JSON.stringify(st));
});

test('pnl2-ac1 a filter text with & = % / + and spaces survives the round trip and keeps the state one route segment', () => {
  const q = 'Rent & Office = 100% / misc + more';
  const st = { ...DEFAULTS, q, s: 'cat', d: 'asc' };
  const str = stateString(st);
  assert.equal(new URLSearchParams(str).get('q'), q, 'the string is a URLSearchParams string');
  assert.ok(!str.includes('/'), `no literal slash in ${str}`);
  assert.ok(!str.includes(' '), `no literal space in ${str}`);
  assert.deepEqual(parseState(str), st);
  const v = 'entity:Fees & "Charges" / Co';
  assert.equal(parseState(stateString({ ...DEFAULTS, v })).v, v);
});

test('pnl2-ac1 the sort direction defaults by key: cat ascending, numeric keys descending', () => {
  assert.deepEqual(parseState('s=cat'), { ...DEFAULTS, s: 'cat', d: 'asc' });
  for (const s of ['tot', 'ly', 'avg', 'm:2032-04']) {
    assert.deepEqual(parseState(new URLSearchParams({ s }).toString()), { ...DEFAULTS, s, d: 'desc' }, s);
  }
  assert.deepEqual(parseState('d=asc'), DEFAULTS, 'd alone is ignored');
});

test('pnl2-ac1 invalid values and unknown keys fall back to the defaults', () => {
  const cases = [
    ['m=2032-13', {}],
    ['m=2032-1', {}],
    ['m=soon', {}],
    ['s=sideways', {}],
    ['s=m%3A2032-13', {}],
    ['s=m%3A', {}],
    ['s=m%3A2032-03-01', {}],
    ['s=TOT', {}],
    ['s=tot&d=up', { s: 'tot', d: 'desc' }],
    ['s=cat&d=DESC', { s: 'cat', d: 'asc' }],
    ['t=revenue', {}],
    ['t=', {}],
    ['z=0', {}],
    ['z=yes', {}],
    ['z=2', {}],
    ['v=', {}],
    ['x=1&y=2', {}],
    ['q=', {}],
    ['m=2032-13&s=avg&t=expenses', { s: 'avg', d: 'desc', t: 'expenses' }],
  ];
  for (const [str, want] of cases) assert.deepEqual(parseState(str), { ...DEFAULTS, ...want }, str);
  assert.deepEqual(parseState('t=income&z=1'), { ...DEFAULTS, t: 'income', z: true });
});

/* ---------------------------------------------------------------- group sort */

// A group as /api/pnl shows it (server order: biggest first, Uncategorized last), with plain values
// standing in for the figure lookup.
const GROUP = [
  { category: 'Software', tot: 300, m: { '2032-01': 100, '2032-02': null, '2032-03': 200 }, ly: 50 },
  { category: 'Rent & Office', tot: 1200, m: { '2032-01': 400, '2032-02': 400, '2032-03': 400 }, ly: null },
  { category: 'contractors', tot: 300, m: { '2032-01': 0, '2032-02': 300, '2032-03': null }, ly: 900 },
  { category: 'Bank fees', tot: -20, m: { '2032-01': null, '2032-02': -20, '2032-03': null }, ly: 0 },
  { category: 'Uncategorized', tot: 0, m: { '2032-01': null, '2032-02': null, '2032-03': null }, ly: null },
];
const valueOf = (c, key) => {
  assert.notEqual(key, 'cat', 'valueOf is never asked for the name');
  if (key === 'tot') return c.tot;
  if (key === 'ly') return c.ly;
  if (key.startsWith('m:')) return c.m[key.slice(2)] ?? null;
  return null;
};
const byName = (a, b) => a.localeCompare(b);

test('pnl2-ac1 sortGroup with no sort key keeps the server order and never mutates the input', () => {
  const before = names(GROUP);
  assert.deepEqual(names(sortGroup(GROUP, { s: null, d: null }, valueOf)), before);
  const out = sortGroup(GROUP, { s: 'tot', d: 'desc' }, valueOf);
  assert.notEqual(out, GROUP, 'a new array');
  assert.deepEqual(names(GROUP), before, 'the input order is unchanged');
});

test('pnl2-ac1 sortGroup by category name uses localeCompare, ascending and descending', () => {
  const asc = names(GROUP).sort(byName);
  assert.deepEqual(names(sortGroup(GROUP, { s: 'cat', d: 'asc' }, valueOf)), asc);
  assert.deepEqual(names(sortGroup(GROUP, { s: 'cat', d: 'desc' }, valueOf)), [...asc].reverse());
  assert.deepEqual(names(sortGroup(GROUP, { s: 'cat', d: null }, valueOf)), asc, 'cat defaults to ascending');
});

test('pnl2-ac1 sortGroup by a month column: nulls as 0, ties by name ascending in both directions', () => {
  // 2032-01: Rent 400, Software 100, contractors 0, Bank fees null (0), Uncategorized null (0).
  const zeros = ['Bank fees', 'contractors', 'Uncategorized'].sort(byName);
  assert.deepEqual(names(sortGroup(GROUP, { s: 'm:2032-01', d: 'desc' }, valueOf)), ['Rent & Office', 'Software', ...zeros]);
  assert.deepEqual(names(sortGroup(GROUP, { s: 'm:2032-01', d: 'asc' }, valueOf)), [...zeros, 'Software', 'Rent & Office']);
  assert.deepEqual(names(sortGroup(GROUP, { s: 'm:2032-01', d: null }, valueOf)), ['Rent & Office', 'Software', ...zeros], 'numeric keys default to descending');
  // 2032-02: Rent 400, contractors 300, Software null (0), Uncategorized null (0), Bank fees -20.
  assert.deepEqual(names(sortGroup(GROUP, { s: 'm:2032-02', d: 'desc' }, valueOf)), ['Rent & Office', 'contractors', 'Software', 'Uncategorized', 'Bank fees']);
  assert.deepEqual(names(sortGroup(GROUP, { s: 'm:2032-02', d: 'asc' }, valueOf)), ['Bank fees', 'Software', 'Uncategorized', 'contractors', 'Rent & Office']);
});

test('pnl2-ac1 sortGroup by the total and by last year: ties by name ascending, Uncategorized not pinned last', () => {
  // tot: Rent 1200, Software 300 and contractors 300 tie, Uncategorized 0, Bank fees -20.
  const tie = ['contractors', 'Software'].sort(byName);
  assert.deepEqual(names(sortGroup(GROUP, { s: 'tot', d: 'desc' }, valueOf)), ['Rent & Office', ...tie, 'Uncategorized', 'Bank fees']);
  assert.deepEqual(names(sortGroup(GROUP, { s: 'tot', d: 'asc' }, valueOf)), ['Bank fees', 'Uncategorized', ...tie, 'Rent & Office']);
  // ly: contractors 900, Software 50, then Bank fees 0, Rent null, Uncategorized null by name.
  const lyZeros = ['Bank fees', 'Rent & Office', 'Uncategorized'].sort(byName);
  assert.deepEqual(names(sortGroup(GROUP, { s: 'ly', d: 'desc' }, valueOf)), ['contractors', 'Software', ...lyZeros]);
});

/* ---------------------------------------------------------------- group filter */

const F = { q: '', t: 'all', z: false, m: null };

test('pnl2-ac1 filterGroup with no filter keeps every category in order', () => {
  assert.deepEqual(names(filterGroup(GROUP, F, valueOf, 'expenses')), names(GROUP));
  assert.deepEqual(names(filterGroup(GROUP, F, valueOf, 'household')), names(GROUP));
});

test('pnl2-ac1 filterGroup text is a case-insensitive substring of the category name', () => {
  assert.deepEqual(names(filterGroup(GROUP, { ...F, q: 'OF' }, valueOf, 'expenses')), ['Software', 'Rent & Office']);
  assert.deepEqual(names(filterGroup(GROUP, { ...F, q: 'contr' }, valueOf, 'expenses')), ['contractors']);
  assert.deepEqual(names(filterGroup(GROUP, { ...F, q: ' & ' }, valueOf, 'expenses')), ['Rent & Office'], 'punctuation and spaces match literally');
  assert.deepEqual(filterGroup(GROUP, { ...F, q: 'no such text' }, valueOf, 'expenses'), []);
});

test('pnl2-ac1 filterGroup type keeps one business section and ignores the type for a household bucket', () => {
  assert.deepEqual(filterGroup(GROUP, { ...F, t: 'income' }, valueOf, 'expenses'), []);
  assert.deepEqual(names(filterGroup(GROUP, { ...F, t: 'expenses' }, valueOf, 'expenses')), names(GROUP));
  assert.deepEqual(filterGroup(GROUP, { ...F, t: 'expenses' }, valueOf, 'income'), []);
  assert.deepEqual(names(filterGroup(GROUP, { ...F, t: 'income' }, valueOf, 'income')), names(GROUP));
  assert.deepEqual(names(filterGroup(GROUP, { ...F, t: 'all' }, valueOf, 'income')), names(GROUP));
  assert.deepEqual(names(filterGroup(GROUP, { ...F, t: 'income' }, valueOf, 'household')), names(GROUP));
  assert.deepEqual(names(filterGroup(GROUP, { ...F, t: 'expenses' }, valueOf, 'tax')), names(GROUP));
});

test('pnl2-ac1 filterGroup hide-zero uses the range total, or the selected month when there is one', () => {
  assert.deepEqual(names(filterGroup(GROUP, { ...F, z: true }, valueOf, 'expenses')), ['Software', 'Rent & Office', 'contractors', 'Bank fees'], 'Uncategorized totals 0; a negative total stays');
  assert.deepEqual(names(filterGroup(GROUP, { ...F, z: true, m: '2032-01' }, valueOf, 'expenses')), ['Software', 'Rent & Office'], 'a 0 cell and a missing cell are both empty');
  assert.deepEqual(names(filterGroup(GROUP, { ...F, z: true, m: '2032-02' }, valueOf, 'expenses')), ['Rent & Office', 'contractors', 'Bank fees']);
  assert.deepEqual(names(filterGroup(GROUP, { ...F, z: false, m: '2032-01' }, valueOf, 'expenses')), names(GROUP), 'a month alone filters nothing');
});

test('pnl2-ac1 filterGroup combines text, type and hide-zero and never mutates the input', () => {
  const before = names(GROUP);
  assert.deepEqual(names(filterGroup(GROUP, { q: 'o', t: 'expenses', z: true, m: '2032-03' }, valueOf, 'expenses')), ['Software', 'Rent & Office']);
  assert.deepEqual(filterGroup(GROUP, { q: 'o', t: 'income', z: true, m: '2032-03' }, valueOf, 'expenses'), []);
  assert.deepEqual(names(GROUP), before);
});

/* ---------------------------------------------------------------- rows spec */

test('pnl2-ac2 encodeSpec and decodeSpec round trip a pnl spec, with and without a month', () => {
  const spec = { k: 'pnl', v: 'entity:examplestudio', f: '2032-01', t: '2032-06', sec: 'expenses', cat: 'Rent & Office', m: '2032-03' };
  const str = encodeSpec(spec);
  assert.deepEqual([...new URLSearchParams(str).keys()], ['k', 'v', 'f', 't', 'sec', 'cat', 'm']);
  assert.equal(new URLSearchParams(str).get('cat'), 'Rent & Office');
  assert.deepEqual(decodeSpec(str), spec);
  const range = { ...spec, m: null };
  const rs = encodeSpec(range);
  assert.deepEqual([...new URLSearchParams(rs).keys()], ['k', 'v', 'f', 't', 'sec', 'cat'], 'no m for the range');
  assert.deepEqual(decodeSpec(rs), range);
});

test('pnl2-ac2 encodeSpec and decodeSpec round trip a spend spec with its toggles', () => {
  const spec = { k: 'spend', v: 'household', f: '2031-11', t: '2032-10', b: 'tax', cat: 'Taxes', m: '2032-04', inc: ['tax'], exc: ['housing'] };
  const str = encodeSpec(spec);
  assert.deepEqual([...new URLSearchParams(str).keys()], ['k', 'v', 'f', 't', 'b', 'cat', 'm', 'inc', 'exc']);
  assert.deepEqual(decodeSpec(str), spec);
  const plain = { ...spec, b: 'household', cat: 'Dining & Drinks', m: null, inc: [], exc: [] };
  const ps = encodeSpec(plain);
  assert.deepEqual([...new URLSearchParams(ps).keys()], ['k', 'v', 'f', 't', 'b', 'cat'], 'empty toggles and no month are omitted');
  assert.deepEqual(decodeSpec(ps), plain);
  const both = { ...plain, inc: ['tax'], exc: ['housing'] };
  assert.equal(new URLSearchParams(encodeSpec({ ...both, inc: ['tax', 'other'] })).get('inc'), 'tax,other', 'comma separated');
});

test('pnl2-ac2 a category with & = % / + " and spaces survives the spec round trip and stays one route segment', () => {
  const cat = 'Fees & "Charges" = 5% / misc + more';
  const spec = { k: 'pnl', v: 'entity:sampleworks', f: '2032-01', t: '2032-03', sec: 'expenses', cat, m: null };
  const str = encodeSpec(spec);
  assert.ok(!str.includes('/'), `no literal slash in ${str}`);
  assert.ok(!str.includes(' '), `no literal space in ${str}`);
  assert.equal(decodeSpec(str).cat, cat);
});

test('pnl2-ac2 decodeSpec rejects a malformed spec', () => {
  const ok = { k: 'pnl', v: 'entity:examplestudio', f: '2032-01', t: '2032-06', sec: 'income', cat: 'Consulting revenue' };
  const str = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null)).toString();
  assert.ok(decodeSpec(str(ok)), 'the base case decodes');
  for (const [why, o] of [
    ['bad kind', { ...ok, k: 'ledger' }],
    ['no kind', { ...ok, k: null }],
    ['no category', { ...ok, cat: null }],
    ['empty category', { ...ok, cat: '' }],
    ['bad month', { ...ok, m: '2032-13' }],
    ['bad from', { ...ok, f: '2032-1' }],
    ['bad to', { ...ok, t: 'soon' }],
    ['bad section', { ...ok, sec: 'sideways' }],
  ]) assert.equal(decodeSpec(str(o)), null, why);
  for (const s of ['', null, undefined]) assert.equal(decodeSpec(s), null, String(s));
});

/* ---------------------------------------------------------------- rows sort */

const ITEMS = [
  { id: 4, date: '2032-03-20', value: 50 },
  { id: 3, date: '2032-03-09', value: 700 },
  { id: 2, date: '2032-03-09', value: -40 },
  { id: 1, date: '2032-03-01', value: 50 },
];
const ids = (list) => list.map((i) => i.id);

test('pnl2-ac2 sortRows by date and by amount, ascending and descending, ties keep their order', () => {
  assert.deepEqual(ids(sortRows(ITEMS, 'date', 'desc')), [4, 3, 2, 1]);
  assert.deepEqual(ids(sortRows(ITEMS, 'date', 'asc')), [1, 3, 2, 4], 'the 2032-03-09 tie keeps 3 before 2');
  assert.deepEqual(ids(sortRows(ITEMS, 'amount', 'desc')), [3, 4, 1, 2], 'by the counted value; the 50 tie keeps 4 before 1');
  assert.deepEqual(ids(sortRows(ITEMS, 'amount', 'asc')), [2, 4, 1, 3]);
  const before = ids(ITEMS);
  assert.notEqual(sortRows(ITEMS, 'date', 'asc'), ITEMS, 'a new array');
  assert.deepEqual(ids(ITEMS), before, 'the input is not mutated');
});

test('pnl2-ac2 sortRows orders workbook month dates as text', () => {
  const lines = [{ id: 1, date: '2032-01', value: 10 }, { id: 2, date: '2032-03', value: 5 }, { id: 3, date: '2032-02', value: 20 }];
  assert.deepEqual(ids(sortRows(lines, 'date', 'desc')), [2, 3, 1]);
  assert.deepEqual(ids(sortRows(lines, 'date', 'asc')), [1, 3, 2]);
  assert.deepEqual(ids(sortRows(lines, 'amount', 'desc')), [3, 1, 2]);
});

/* ---------------------------------------------------------------- month scope */

test('pnl2-ac3 scopeMonth: a category name uses the selected month or the range; a month cell uses its own month', () => {
  assert.equal(scopeMonth('cat', null, null), null, 'no month selected: the range');
  assert.equal(scopeMonth('cat', '2032-03', null), '2032-03', 'the selected month bounds the rows');
  assert.equal(scopeMonth('cell', null, '2032-05'), '2032-05');
  assert.equal(scopeMonth('cell', '2032-03', '2032-05'), '2032-05', 'the clicked cell wins over the selected month');
});
