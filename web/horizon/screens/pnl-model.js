/* Horizon P&L page model: the pure logic behind the P&L table's sort and filter, the hash state
   that keeps them (#/pnl/<state>), the rows dialog spec (#/pnlrows/<spec>), the dialog's row sort
   and which month a click lists. No DOM and no imports, so node:test reads it directly. Both
   strings are URLSearchParams strings, so neither ever holds a literal '/' or space. */

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const isMonth = (m) => typeof m === 'string' && MONTH.test(m);
const SORT_KEYS = new Set(['cat', 'tot', 'ly', 'avg']);
const TYPES = new Set(['all', 'income', 'expenses']);
const DIRS = new Set(['asc', 'desc']);

const isSortKey = (s) => typeof s === 'string' && (SORT_KEYS.has(s) || (s.startsWith('m:') && isMonth(s.slice(2))));
// The first click on a column: the name ascending, every number descending.
export const defaultDir = (s) => (s === 'cat' ? 'asc' : 'desc');

/* ---------- hash state ---------- */

// { v, m, s, d, q, t, z } from the state after '#/pnl/'. Unknown keys and invalid values read as
// the defaults.
export function parseState(str) {
  const p = new URLSearchParams(typeof str === 'string' ? str : '');
  const v = p.get('v');
  const m = p.get('m');
  const s = p.get('s');
  const d = p.get('d');
  const t = p.get('t');
  const sort = isSortKey(s) ? s : null;
  return {
    v: v ? v : null,
    m: isMonth(m) ? m : null,
    s: sort,
    d: sort ? (DIRS.has(d) ? d : defaultDir(sort)) : null,
    q: p.get('q') || '',
    t: TYPES.has(t) ? t : 'all',
    z: p.get('z') === '1'
  };
}

// The state as a URLSearchParams string, keys in the order v m s d q t z, defaults left out.
export function stateString(state) {
  const st = state || {};
  const p = new URLSearchParams();
  if (st.v) p.set('v', st.v);
  if (isMonth(st.m)) p.set('m', st.m);
  if (isSortKey(st.s)) {
    p.set('s', st.s);
    p.set('d', DIRS.has(st.d) ? st.d : defaultDir(st.s));
  }
  if (st.q) p.set('q', st.q);
  if (TYPES.has(st.t) && st.t !== 'all') p.set('t', st.t);
  if (st.z) p.set('z', '1');
  return p.toString();
}

/* ---------- table sort and filter ---------- */

const byName = (a, b) => String(a.category).localeCompare(String(b.category));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// One group's categories in sort order. valueOf(cat, key) gives a numeric key's value (null as 0);
// ties go by name ascending whichever the direction.
export function sortGroup(cats, { s, d } = {}, valueOf) {
  const list = [...(Array.isArray(cats) ? cats : [])];
  if (!isSortKey(s)) return list;
  const dir = DIRS.has(d) ? d : defaultDir(s);
  if (s === 'cat') {
    list.sort(byName);
    return dir === 'desc' ? list.reverse() : list;
  }
  const sign = dir === 'desc' ? -1 : 1;
  const vals = new Map(list.map((c) => [c, num(valueOf(c, s))]));
  return list.sort((a, b) => sign * (vals.get(a) - vals.get(b)) || byName(a, b));
}

// One group's categories that pass the filter, in input order. The type applies only to a
// business section; hide-zero reads the selected month's cell, else the range total.
export function filterGroup(cats, { q = '', t = 'all', z = false, m = null } = {}, valueOf, section) {
  const list = Array.isArray(cats) ? cats : [];
  if ((section === 'income' || section === 'expenses') && (t === 'income' || t === 'expenses') && t !== section) return [];
  const needle = String(q || '').toLowerCase();
  const key = m ? `m:${m}` : 'tot';
  return list.filter((c) => {
    if (needle && !String(c.category).toLowerCase().includes(needle)) return false;
    if (z) {
      const v = valueOf(c, key);
      if (v == null || v === 0) return false;
    }
    return true;
  });
}

/* ---------- rows dialog ---------- */

// The dialog route's spec as a URLSearchParams string: k v f t sec|b cat m inc exc.
export function encodeSpec(spec) {
  const x = spec || {};
  const p = new URLSearchParams();
  p.set('k', x.k);
  if (x.v != null) p.set('v', x.v);
  p.set('f', x.f);
  p.set('t', x.t);
  if (x.k === 'spend') p.set('b', x.b); else p.set('sec', x.sec);
  p.set('cat', x.cat);
  if (x.m) p.set('m', x.m);
  if (x.k === 'spend') {
    if (Array.isArray(x.inc) && x.inc.length) p.set('inc', x.inc.join(','));
    if (Array.isArray(x.exc) && x.exc.length) p.set('exc', x.exc.join(','));
  }
  return p.toString();
}

const list = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

// The spec back, or null when it cannot name a cell.
export function decodeSpec(str) {
  if (typeof str !== 'string' || !str) return null;
  const p = new URLSearchParams(str);
  const k = p.get('k');
  const cat = p.get('cat');
  const f = p.get('f');
  const t = p.get('t');
  const m = p.get('m');
  if ((k !== 'pnl' && k !== 'spend') || !cat || !isMonth(f) || !isMonth(t) || (m != null && !isMonth(m))) return null;
  const v = p.get('v') || null;
  if (k === 'pnl') {
    const sec = p.get('sec');
    if (sec !== 'income' && sec !== 'expenses') return null;
    return { k, v, f, t, sec, cat, m: m || null };
  }
  const b = p.get('b');
  if (!b) return null;
  return { k, v, f, t, b, cat, m: m || null, inc: list(p.get('inc')), exc: list(p.get('exc')) };
}

// The dialog's rows by date (as text: a day or a workbook month) or by counted value. Stable.
export function sortRows(items, key, dir) {
  const sign = dir === 'asc' ? 1 : -1;
  const pick = key === 'amount' ? (i) => num(i.value) : (i) => String(i.date ?? '');
  return [...(Array.isArray(items) ? items : [])]
    .map((it, n) => ({ it, n, k: pick(it) }))
    .sort((a, b) => (a.k < b.k ? -sign : a.k > b.k ? sign : 0) || a.n - b.n)
    .map((x) => x.it);
}

// The month a click lists: a month cell its own month; a category name the selected month, or
// null for the whole range.
export function scopeMonth(open, selected, cellMonth) {
  if (open === 'cell') return isMonth(cellMonth) ? cellMonth : null;
  return isMonth(selected) ? selected : null;
}
