/* Horizon P&L (Money, #/pnl): a business P&L for each entity (or unassigned business account) and
   household spending. A chooser picks the view; each view shows its totals, where the numbers come
   from, what they leave out, a month strip and a month by category table that sorts from its
   headers and filters by text, type and empty rows. The view, the selected month, the sort and the
   filter live in the hash (#/pnl/<state>, see pnl-model.js). A category name or a month cell opens
   the rows behind it in a dialog (#/pnlrows/<spec>): the selected month (or the cell's month)
   bounds the rows, else the whole range. Every number is a figure the server returned (GET
   /api/pnl, /api/spending and their /rows reads) with its provenance; this file only lays them
   out. Imported text (entity and account labels, categories, descriptions) is escaped, never
   resolved as tokens. */

import { parseState, stateString, defaultDir, sortGroup, filterGroup, encodeSpec, decodeSpec, sortRows, scopeMonth } from './pnl-model.js';

let H = null;

export function bind(kit) { H = kit; }

const PL_HOUSEHOLD = 'household';
const PL_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const plFresh = () => ({
  view: null,          // entity key or 'household'; null until the first P&L read lands
  entities: null,      // the chooser's entities, from the newest P&L read
  entSc: null,         // the scenario the entities were read under
  biz: new Map(),      // entity key -> { data, sc }
  home: new Map(),     // household options key -> { data, sc }
  homeShown: null,     // the household options key last drawn, kept on screen while a toggle loads
  wait: new Map(),     // request key -> { token, sc } in flight
  failed: new Map(),   // request key -> the scenario its last read failed under
  housing: true,
  tax: false,
  // The hash state: selected month (null for All months), sort key and direction, text filter,
  // type (all, income, expenses) and hide-zero. hash is the state string last read or written.
  m: null, s: null, d: null, q: '', t: 'all', z: false,
  hash: null
});
let P = plFresh();
// Request tokens come from one counter that never resets, so a response for an earlier request (an
// entity switched away from, a toggle undone, a screen left and reopened) never lands on a newer one.
let PL_GEN = 0;

// The rows dialog: its spec string, load state and its own row sort.
const dlgFresh = (id) => ({ id, spec: decodeSpec(id), data: null, failed: false, token: 0, sort: 'date', dir: 'desc' });
let D = null;

export function reset() { P = plFresh(); D = null; }

/* ---------- labels ---------- */

const plMonth = (m) => `${PL_MON[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const plShort = (m) => PL_MON[Number(m.slice(5, 7)) - 1];
function plRange(from, to) {
  if (!from || !to) return '';
  if (from === to) return plMonth(from);
  if (from.slice(0, 4) === to.slice(0, 4)) return `${plShort(from)} to ${plMonth(to)}`;
  return `${plMonth(from)} to ${plMonth(to)}`;
}
// A list of months as runs: Jan, Mar to May 2026.
function plMonthList(ms) {
  const runs = plRuns(ms.map((m) => ({ month: m, v: 1 })), 'v');
  return runs.map((r) => plRange(r.from, r.to)).join(', ');
}
// Consecutive months with the same value of `field` as { from, to, value }. A gap in the months
// starts a new run.
function plRuns(items, field) {
  const out = [];
  const next = (m) => { const y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7)); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
  for (const it of items) {
    const cur = out[out.length - 1];
    if (cur && cur.value === it[field] && next(cur.to) === it.month) cur.to = it.month;
    else out.push({ from: it.month, to: it.month, value: it[field] });
  }
  return out;
}
const plPct = (share) => `${Math.round(Number(share || 0) * 1000) / 10}%`;
const plPhone = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 720px)').matches;
// Phone width, read once per page render rather than once per figure.
let PL_PHONE = false;
const plCap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const plDay = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  if (m) return `${PL_MON[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
  return /^\d{4}-\d{2}$/.test(String(d || '')) ? plMonth(String(d)) : String(d || '');
};

/* ---------- hash state ---------- */

const defaultView = () => H.arr(P.entities)[0]?.key || PL_HOUSEHOLD;

// Take the state from the page route when it is not the one this file last read or wrote (a
// reload, Back, a link).
function syncFromRoute() {
  const r = H.pageRoute();
  if (!r || r.name !== 'pnl') return;
  const str = String(r.params?.state || '');
  if (str === P.hash) return;
  P.hash = str;
  const st = parseState(str);
  P.view = st.v || (P.entities ? defaultView() : P.view);
  Object.assign(P, { m: st.m, s: st.s, d: st.d, q: st.q, t: st.t, z: st.z });
}

// Write the state into the URL without a history entry, a notify or a jump to the top.
function writeHash() {
  const v = P.view && P.view !== defaultView() ? P.view : null;
  const str = stateString({ v, m: P.m, s: P.s, d: P.d, q: P.q, t: P.t, z: P.z });
  P.hash = str;
  if (H.api.route?.name !== 'pnl') return;
  H.api.go('pnl', str ? { state: str } : {}, { replace: true, silent: true });
}

const filtering = () => !!P.q || P.t !== 'all' || P.z;

/* ---------- loading ---------- */

const homeKey = () => `h:${P.housing ? 1 : 0}:${P.tax ? 1 : 0}`;
const homeOpts = () => ({ include: P.tax ? ['tax'] : [], exclude: P.housing ? [] : ['housing'] });

// Request keys: one per read, so the in-flight and failed maps can tell them apart.
const bizReq = (key) => `pnl:${key}`;
const homeReq = () => `home:${homeKey()}`;

// Read into map[key] (request `req`) unless a copy for the current scenario is there, in flight,
// or failed under this scenario (Try again clears that).
function plFetch(map, key, req, run, onData) {
  const sc = H.api.s;
  const have = map && map.get(key);
  if (have && have.sc === sc) return;
  const w = P.wait.get(req);
  if (w && w.sc === sc) return;
  if (P.failed.has(req) && P.failed.get(req) === sc) return;
  const token = ++PL_GEN;
  const state = P;
  state.wait.set(req, { token, sc });
  Promise.resolve(run()).then((d) => {
    const cur = state.wait.get(req);
    if (state !== P || !cur || cur.token !== token) return;
    state.wait.delete(req);
    if (d) { state.failed.delete(req); if (map) map.set(key, { data: d, sc }); onData?.(d, sc); } else state.failed.set(req, sc);
    H.draw();
  });
}

function takeEntities(d, sc) {
  P.entities = H.arr(d.entities);
  P.entSc = sc;
  if (d.pnl?.entity?.key) P.biz.set(d.pnl.entity.key, { data: d, sc });
  const keys = P.entities.map((e) => e.key);
  if (P.view == null || (P.view !== PL_HOUSEHOLD && !keys.includes(P.view))) P.view = keys[0] || PL_HOUSEHOLD;
}

function plEnsure() {
  const sc = H.api.s;
  // The chooser: the first read lists the entities; the household view keeps them current.
  if (P.entities === null || P.entSc === null || (P.view === PL_HOUSEHOLD && P.entSc !== sc)) {
    plFetch(null, null, 'ents', () => H.api.pnl({}), takeEntities);
  }
  if (P.view && P.view !== PL_HOUSEHOLD) {
    const key = P.view;
    plFetch(P.biz, key, bizReq(key), () => H.api.pnl({ entity: key }), takeEntities);
  } else if (P.view === PL_HOUSEHOLD) {
    const opts = homeOpts();
    plFetch(P.home, homeKey(), homeReq(), () => H.api.spending(opts));
  }
}

const bizEntry = (key) => P.biz.get(key) || null;
const busy = (key) => P.wait.has(key);
const failedNow = (key) => P.failed.has(key);

/* ---------- shared pieces ---------- */

function chooser() {
  const { esc } = H;
  const ents = H.arr(P.entities);
  const one = (key, label, sub) => `<button type="button" class="pl-view${P.view === key ? ' on' : ''}" data-pl-view="${esc(key)}" aria-pressed="${P.view === key}"><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</button>`;
  const btns = ents.map((e) => one(e.key, esc(e.label), e.kind === 'account' ? 'Business account' : 'Business'));
  btns.push(one(PL_HOUSEHOLD, 'Household spending', 'Personal accounts'));
  return `<div class="pl-views" data-pl-views role="group" aria-label="Choose a P&amp;L">${btns.join('')}</div>`;
}

const nil = '<span class="pl-nil" aria-label="None">&middot;</span>';

function cell(key, opts = {}) {
  return key ? H.figHtml(key, { k: PL_PHONE, ...opts }) : nil;
}

// A figure's value for sorting and hide-zero; null when there is none.
function figV(key) {
  const f = key ? H.api.fig(key) : null;
  return f && !f.missing && typeof f.v === 'number' ? f.v : null;
}

function tile(k, label, key, sub = '') {
  const v = key ? H.api.fig(key) : null;
  const neg = v && typeof v.v === 'number' && v.v < 0;
  return `<div class="pl-tile${neg ? ' neg' : ''}" data-pl-total="${k}"><span class="pl-tile-k">${label}</span><b class="pl-tile-v">${key ? H.figHtml(key) : '<span class="h-mute">None</span>'}</b>${sub}</div>`;
}

// All months first (the range figure), then one button per month.
function monthStrip(months, sel, allKey, figOf, tagOf) {
  const { esc } = H;
  const fig = (key) => (key ? H.figHtml(key, { k: true, inert: true }) : '<span class="pl-m-none">None</span>');
  const all = `<button type="button" class="pl-m pl-m-all${sel ? '' : ' on'}" data-pl-month="" aria-pressed="${!sel}"><span class="pl-m-n">All months</span><b>${fig(allKey)}</b></button>`;
  const btns = months.map((m, i) => {
    const on = m === sel;
    const tag = tagOf ? tagOf(m) : null;
    const year = i === 0 || m.endsWith('-01') ? `<em>${m.slice(0, 4)}</em>` : '';
    return `<button type="button" class="pl-m${on ? ' on' : ''}" data-pl-month="${esc(m)}" aria-pressed="${on}"><span class="pl-m-n">${plShort(m)}${year}</span><b>${fig(figOf(m))}</b>${tag ? `<small class="pl-m-s ${tag[0]}">${tag[1]}</small>` : ''}</button>`;
  }).join('');
  return `<div class="pl-months" data-pl-months role="group" aria-label="Month">${all}${btns}</div>`;
}

const selMonth = (d) => (P.m && H.arr(d.months).includes(P.m) ? P.m : null);

// The sort in effect: a key the table has (a month in range, Last year only with a prior year,
// Monthly average only on household spending), else none.
function sortNow(months, extra) {
  const s = P.s;
  const ok = s === 'cat' || s === 'tot' || s === extra || (s && s.startsWith('m:') && months.includes(s.slice(2)));
  return ok ? { s, d: P.d || defaultDir(s) } : { s: null, d: null };
}

function notesHtml(notes) {
  const ns = H.arr(notes).filter((n) => typeof n === 'string' && n);
  return ns.length ? `<ul class="pl-notes">${ns.map((n) => `<li>${H.esc(n)}</li>`).join('')}</ul>` : '';
}

function failBox(what) {
  return `<div class="pl-fail"><p class="h-ad-err" role="alert">Could not load ${what}.</p>${H.btn('Try again', 'data-pl-retry', 'sm')}</div>`;
}

/* ---------- table ---------- */

// The header row: Category, one column per month, the range total, then Last year or Monthly
// average. Each header is a sort button; the sorted one carries its direction.
function headRow(months, sel, sort, rangeName, last) {
  const { esc } = H;
  const th = (key, label, cls, aria) => {
    const on = sort.s === key;
    const dir = on ? (sort.d === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th scope="col" class="${cls}" data-pl-col="${esc(key)}" aria-sort="${dir}"><button type="button" class="pl-sort${on ? ` on ${sort.d}` : ''}" data-pl-sort="${esc(key)}"${aria ? ` aria-label="${aria}"` : ''}>${label}<i class="pl-sort-i" aria-hidden="true"></i></button></th>`;
  };
  const ms = months.map((m, i) => th(`m:${m}`, `${plShort(m)}${i === 0 || m.endsWith('-01') ? `<small>${m.slice(0, 4)}</small>` : ''}`, `num pl-mc${m === sel ? ' sel' : ''}`, plMonth(m))).join('');
  return `<thead><tr>${th('cat', 'Category', 'pl-catc')}${ms}${th('tot', rangeName, 'num pl-totc')}${last ? th(last[0], last[1], `num ${last[2]}`) : ''}</tr></thead>`;
}

// Month cells of one row: cellOf(m) gives the cell html.
const monthCells = (months, sel, cellOf) => months.map((m) => `<td class="num pl-mc${m === sel ? ' sel' : ''}" data-pl-m="${m}">${cellOf(m)}</td>`).join('');

// A category row: its name opens the rows for the selected month (or the range), a month cell for
// that month; the total and the last column stay plain figures. A cell's spec ends in o=cell
// (decodeSpec ignores it), so with a month selected the name and that month's cell stay two
// openers that focus can return to.
function catRow({ c, attrs, specOf, months, sel, compact, tail, addKind, addId, addLabel, tag = '' }) {
  const { esc } = H;
  const one = scopeMonth('cat', sel, null);
  const name = `<button type="button" class="pl-cat" data-go="pnlrows" data-pl-open="cat" data-id="${esc(specOf(one))}">${esc(c.category)}</button>`;
  const cellOf = (m) => {
    const key = c.months?.[m];
    if (!key) return nil;
    return `<button type="button" class="pl-cell" data-go="pnlrows" data-pl-open="cell" data-id="${esc(`${specOf(scopeMonth('cell', sel, m))}&o=cell`)}">${H.figHtml(key, { k: compact, inert: true })}</button>`;
  };
  const add = H.addBtn(addKind, sel ? `${addId}|${sel}` : addId, sel ? `${addLabel}, ${plMonth(sel)}` : addLabel);
  return `<tr data-pl-row data-pl-cat-row="${esc(c.category)}" ${attrs}><th scope="row" class="pl-catc">${name}${tag}${add}</th>${monthCells(months, sel, cellOf)}<td class="num pl-totc" data-pl-tot>${cell(c.total)}</td>${tail}</tr>`;
}

// The filter row: text, type (business only) and hide-zero.
function filterRow(business) {
  const { esc } = H;
  const type = (t, label) => `<button type="button" class="pl-ft${P.t === t ? ' on' : ''}" data-pl-type="${t}" aria-pressed="${P.t === t}">${label}</button>`;
  const types = business ? `<div class="pl-fts" data-pl-types role="group" aria-label="Show">${type('all', 'All')}${type('income', 'Income')}${type('expenses', 'Expenses')}</div>` : '';
  const zero = `<button type="button" class="pl-tog pl-zero${P.z ? ' on' : ''}" data-pl-zero aria-pressed="${P.z}"><i aria-hidden="true"></i>Hide empty rows</button>`;
  const note = filtering() ? '<p class="pl-filtered" data-pl-filtered>Filtered. The group totals still count every category.</p>' : '';
  return `<div class="pl-filters" data-pl-filters><input type="search" class="pl-q" data-pl-filter aria-label="Filter categories" placeholder="Filter categories" value="${esc(P.q)}" autocomplete="off" spellcheck="false">${types}${zero}</div>${note}`;
}

const compactCells = (months) => PL_PHONE || months.length > 6;

/* ---------- business ---------- */

function sourcesLine(p) {
  const { plural } = H;
  const ms = H.arr(p.monthSources);
  const verb = { workbook: ['uses', 'use', 'the imported workbook'], transactions: ['uses', 'use', 'categorized business transactions'], none: ['has', 'have', 'no data'] };
  const runs = plRuns(ms, 'source');
  const parts = runs.map((r) => {
    const v = verb[r.value] || verb.none;
    return `${plRange(r.from, r.to)} ${r.from === r.to ? v[0] : v[1]} ${v[2]}`;
  });
  const covered = ms.reduce((n, m) => n + (Number(m.covered?.rows) || 0), 0);
  let text = parts.length ? `${parts.join('. ')}.` : 'No months in this range.';
  if (covered) text += ` ${plural(covered, 'transaction')} in workbook months ${covered === 1 ? 'is' : 'are'} not counted, so nothing is added twice.`;
  return `<div class="pl-src" data-pl-sources>${H.icon('doc')}<p>${text}</p></div>`;
}

function leftOutItems(leftOut) {
  const { esc, plural, figHtml } = H;
  const xs = H.arr(leftOut).filter((l) => Number(l.rows) > 0);
  if (!xs.length) return '';
  return `<li><span class="pl-g-k">Left out</span><span class="pl-g-v">${xs.map((l) => `<span class="pl-g-i">${esc(l.label)} ${l.amount ? figHtml(l.amount) : ''} <span class="pl-g-n">${plural(l.rows, 'row')}</span></span>`).join('')}</span></li>`;
}

function bizGaps(p) {
  const { plural, figHtml } = H;
  const items = [];
  const u = p.uncategorized || {};
  if (Number(u.rows) > 0) items.push(`<li><span class="pl-g-k">Uncategorized</span><span class="pl-g-v"><span class="pl-g-i">${u.amount ? `${figHtml(u.amount)}, ` : ''}${plPct(u.share)} of expenses <span class="pl-g-n">${plural(u.rows, 'row')}</span></span></span></li>`);
  items.push(leftOutItems(p.leftOut));
  const none = H.arr(p.monthSources).filter((m) => m.source === 'none').map((m) => m.month);
  if (none.length) items.push(`<li><span class="pl-g-k">No data</span><span class="pl-g-v">${plMonthList(none)}</span></li>`);
  const list = items.filter(Boolean);
  if (!list.length) list.push('<li><span class="pl-g-v">Every row in these months is counted and has a category.</span></li>');
  return `<ul class="pl-gaps" data-pl-gaps aria-label="What these totals leave out">${list.join('')}</ul>`;
}

function bizTable(p, sel, rangeName) {
  const prior = p.prior;
  const months = H.arr(p.months);
  const sort = sortNow(months, prior ? 'ly' : null);
  const compact = compactCells(months);
  const ly = (html) => (prior ? html : '');
  const blank = (cls = '') => `${months.map((m) => `<td class="num pl-mc${m === sel ? ' sel' : ''}"></td>`).join('')}<td class="num pl-totc ${cls}"></td>${ly('<td class="num pl-ly"></td>')}`;
  const group = (section, label) => {
    if (P.t !== 'all' && P.t !== section) return '';
    const g = p[section] || {};
    const cats = H.arr(g.categories);
    const pc = prior?.categories?.[section] || {};
    const valueOf = (c, key) => (key === 'tot' ? figV(c.total) : key === 'ly' ? figV(pc[c.category]) : key.startsWith('m:') ? figV(c.months?.[key.slice(2)]) : null);
    const shown = sortGroup(filterGroup(cats, { q: P.q, t: P.t, z: P.z, m: sel }, valueOf, section), sort, valueOf);
    const rows = !cats.length
      ? `<tr class="pl-empty"><td class="pl-catc">No ${section} in these months.</td>${blank()}</tr>`
      : !shown.length
        ? `<tr class="pl-empty"><td class="pl-catc">No categories match.</td>${blank()}</tr>`
        : shown.map((c) => catRow({
          c, attrs: `data-pl-section="${section}"`, months, sel, compact,
          specOf: (m) => encodeSpec({ k: 'pnl', v: p.entity.key, f: p.from, t: p.to, sec: section, cat: c.category, m }),
          tail: ly(`<td class="num pl-ly">${cell(pc[c.category])}</td>`),
          addKind: 'pnl', addId: `${P.view}|${c.category}`, addLabel: `P&L > ${c.category}`
        })).join('');
    const total = `<tr class="pl-t"><th scope="row" class="pl-catc">Total ${section}</th>${monthCells(months, sel, (m) => cell(g.months?.[m], { k: compact }))}<td class="num pl-totc">${cell(g.total)}</td>${ly(`<td class="num pl-ly">${cell(prior?.[section])}</td>`)}</tr>`;
    return `<tbody><tr class="pl-h"><th scope="rowgroup" class="pl-catc">${label}</th>${blank()}</tr>${rows}${total}</tbody>`;
  };
  const head = headRow(months, sel, sort, rangeName, prior ? ['ly', 'Last year', 'pl-ly'] : null);
  const net = `<tbody class="pl-net"><tr><th scope="row" class="pl-catc">Net</th>${monthCells(months, sel, (m) => cell(p.net?.months?.[m], { k: compact }))}<td class="num pl-totc">${cell(p.net?.total)}</td>${ly(`<td class="num pl-ly">${cell(prior?.net)}</td>`)}</tr></tbody>`;
  return `${filterRow(true)}<div class="pl-tablewrap"><table class="pl-table" data-pl-table>${head}${group('income', 'Income')}${group('expenses', 'Expenses')}${net}</table></div>`;
}

function businessView() {
  const { section, esc } = H;
  const key = P.view;
  const ent = bizEntry(key);
  if (!ent) {
    if (failedNow(bizReq(key))) return `<div data-pl-business>${failBox('this P&amp;L')}</div>`;
    return '<div data-pl-business><p class="h-mute pl-load">Loading</p></div>';
  }
  const d = ent.data;
  const p = d.pnl;
  if (!p) return '<div data-pl-business><p class="h-mute">No business data.</p></div>';
  const sel = selMonth(p);
  const ytd = p.from === `${p.to.slice(0, 4)}-01`;
  const rangeName = ytd ? 'Year to date' : 'Range';
  const prior = p.prior;
  const pri = (k) => (prior ? `<span class="pl-tile-p" data-pl-prior>Last year ${prior[k] ? H.figHtml(prior[k]) : 'none'}</span>` : '');
  const tiles = `<div class="pl-tiles">${tile('income', 'Income', p.income?.total, pri('income'))}${tile('expenses', 'Expenses', p.expenses?.total, pri('expenses'))}${tile('net', 'Net', p.net?.total, pri('net'))}</div>`;
  const priorLine = prior
    ? `<p class="pl-line">Last year means ${esc(plRange(prior.from, prior.to))}.</p>`
    : '<p class="pl-line">No data for the same months last year.</p>';
  const accounts = H.arr(p.entity?.accounts).map((a) => esc(a.label)).join(', ');
  const meta = `<div class="h-meta pl-meta"><span>${esc(plRange(p.from, p.to))}${ytd ? ', year to date' : ''}</span>${accounts ? `<span>${p.entity.kind === 'account' ? 'Account' : 'Accounts'}: ${accounts}</span>` : ''}</div>`;
  const ms = new Map(H.arr(p.monthSources).map((m) => [m.month, m]));
  const TAG = { workbook: ['wb', 'Workbook'], transactions: ['tx', 'Transactions'], none: ['no', 'No data'] };
  const strip = monthStrip(p.months, sel, p.net?.total, (m) => p.net?.months?.[m], (m) => TAG[ms.get(m)?.source] || TAG.none);
  const cov = sel ? ms.get(sel)?.covered : null;
  const selNote = cov && Number(cov.rows) > 0
    ? `<p class="pl-line">${plMonth(sel)} uses the workbook. ${H.plural(Number(cov.rows), 'transaction')} in that month ${Number(cov.rows) === 1 ? 'adds' : 'add'} up to ${cov.amount ? H.figHtml(cov.amount) : 'an amount'} and ${Number(cov.rows) === 1 ? 'is' : 'are'} not counted.</p>`
    : '';
  return `<div class="pl-body" data-pl-business${busy(bizReq(key)) ? ' aria-busy="true"' : ''}>
    ${meta}
    <div class="pl-sum">${tiles}${priorLine}${sourcesLine(p)}${bizGaps(p)}</div>
    ${section('Months', `${strip}${selNote}`, 'Net for each month. Pick one to list its rows and scope Ask to it.', 'pl-sec')}
    ${section('Categories', bizTable(p, sel, rangeName), 'Pick a category or a month cell to see its rows.', 'pl-sec')}
  </div>`;
}

/* ---------- household ---------- */

function homeGaps(s) {
  const { esc, plural, figHtml } = H;
  const g = s.gaps || {};
  const items = [];
  const accs = H.arr(g.accounts);
  if (accs.length) {
    items.push(`<li><span class="pl-g-k">Feeds</span><span class="pl-g-v">${accs.map((a) => `<span class="pl-g-i">${esc(a.label)} ${a.state === 'stopped' && a.lastMonth ? `stopped after ${plMonth(a.lastMonth)}` : 'has no transactions'}</span>`).join('')}</span></li>`);
  }
  if (H.arr(g.emptyMonths).length) items.push(`<li><span class="pl-g-k">No rows</span><span class="pl-g-v">${plMonthList(g.emptyMonths)}</span></li>`);
  const share = (x, label) => (x && Number(x.rows) > 0
    ? `<li><span class="pl-g-k">${label}</span><span class="pl-g-v"><span class="pl-g-i">${x.amount ? `${figHtml(x.amount)}, ` : ''}${plPct(x.share)} of spending <span class="pl-g-n">${plural(Number(x.rows), 'row')}</span></span></span></li>`
    : '');
  items.push(share(g.uncategorized, 'Uncategorized'));
  items.push(share(g.guessed, 'Guessed'));
  items.push(leftOutItems(s.leftOut));
  const list = items.filter(Boolean);
  if (!list.length) list.push('<li><span class="pl-g-v">Every spending account is current and every row has a category.</span></li>');
  return `<ul class="pl-gaps" data-pl-gaps aria-label="What these totals leave out">${list.join('')}</ul>`;
}

function homeTable(s, sel, rangeName) {
  const { esc } = H;
  const months = H.arr(s.months);
  const sort = sortNow(months, 'avg');
  const compact = compactCells(months);
  const blank = months.map((m) => `<td class="num pl-mc${m === sel ? ' sel' : ''}"></td>`).join('');
  const valueOf = (c, key) => (key === 'tot' ? figV(c.total) : key === 'avg' ? figV(c.average) : key.startsWith('m:') ? figV(c.months?.[key.slice(2)]) : null);
  const groups = H.arr(s.buckets).map((b) => {
    const cats = H.arr(b.categories);
    const shown = sortGroup(filterGroup(cats, { q: P.q, t: 'all', z: P.z, m: sel }, valueOf, b.bucket), sort, valueOf);
    const rows = cats.length && !shown.length
      ? `<tr class="pl-empty"><td class="pl-catc">No categories match.</td>${blank}<td class="num pl-totc"></td><td class="num pl-avg"></td></tr>`
      : shown.map((c) => catRow({
        c, attrs: `data-pl-bucket="${esc(b.bucket)}"`, months, sel, compact,
        specOf: (m) => encodeSpec({ k: 'spend', v: PL_HOUSEHOLD, f: s.from, t: s.to, b: b.bucket, cat: c.category, m, inc: H.arr(s.include), exc: H.arr(s.exclude) }),
        tail: `<td class="num pl-avg">${cell(c.average)}</td>`,
        tag: c.housing ? '<span class="pl-tag">Housing</span>' : '',
        addKind: 'spending', addId: c.category, addLabel: `Spending > ${c.category}`
      })).join('');
    return `<tbody><tr class="pl-h"><th scope="rowgroup" class="pl-catc">${esc(b.label)}</th>${blank}<td class="num pl-totc">${cell(b.total)}</td><td class="num pl-avg"></td></tr>${rows}</tbody>`;
  }).join('');
  const head = headRow(months, sel, sort, rangeName, ['avg', 'Monthly average', 'pl-avg']);
  const total = `<tbody class="pl-net"><tr><th scope="row" class="pl-catc">Total spending</th>${monthCells(months, sel, (m) => cell(s.monthTotals?.[m], { k: compact }))}<td class="num pl-totc">${cell(s.total)}</td><td class="num pl-avg">${cell(s.monthlyAverage)}</td></tr></tbody>`;
  return `${filterRow(false)}<div class="pl-tablewrap"><table class="pl-table home" data-pl-table>${head}${groups}${total}</table></div>`;
}

function toggles() {
  const one = (k, label, on) => `<button type="button" class="pl-tog${on ? ' on' : ''}" data-pl-toggle="${k}" aria-pressed="${on}"><i aria-hidden="true"></i>${label}</button>`;
  const elective = !P.housing && !P.tax;
  return `<div class="pl-togrow"><div class="pl-togs" role="group" aria-label="Include in spending">${one('housing', 'Housing', P.housing)}${one('tax', 'Taxes', P.tax)}</div>
    <p class="pl-line">${elective ? 'Showing elective spending: housing and taxes are left out.' : 'Turn housing off and leave taxes off to see elective spending.'}</p></div>`;
}

function householdView() {
  const { section, esc, goA } = H;
  const key = homeKey();
  const ent = P.home.get(key) || (busy(homeReq()) && P.homeShown ? P.home.get(P.homeShown) : null);
  if (!ent) {
    if (failedNow(homeReq())) return `<div data-pl-household>${toggles()}${failBox('household spending')}</div>`;
    return `<div data-pl-household>${toggles()}<p class="h-mute pl-load">Loading</p></div>`;
  }
  if (P.home.get(key)) P.homeShown = key;
  const s = ent.data.spending;
  const hasRows = H.arr(s.buckets).some((b) => H.arr(b.categories).length);
  if (!hasRows && !s.total) {
    return `<div class="pl-body" data-pl-household>${toggles()}<div class="pl-emptybox"><p>No household transactions in ${esc(plRange(s.from, s.to))}.</p><p class="h-mute sm">Spending comes from personal checking and card accounts. ${goA('add', 'Add files')} or connect an account to fill it in.</p></div>${homeGaps(s)}</div>`;
  }
  const sel = selMonth(s);
  const shownMonth = sel || s.to;
  const n = H.arr(s.months).length;
  const rangeName = n === 12 ? '12 months' : H.plural(n, 'month');
  const tiles = `<div class="pl-tiles">${tile('total', rangeName === '12 months' ? 'Last 12 months' : rangeName, s.total)}${tile('average', 'Monthly average', s.monthlyAverage)}${tile('month', plMonth(shownMonth), s.monthTotals?.[shownMonth])}</div>`;
  const meta = `<div class="h-meta pl-meta"><span>${esc(plRange(s.from, s.to))}</span><span>Personal accounts only; business accounts never count</span></div>`;
  const strip = monthStrip(s.months, sel, s.total, (m) => s.monthTotals?.[m], (m) => (H.arr(s.gaps?.emptyMonths).includes(m) ? ['no', 'No rows'] : null));
  const loading = busy(homeReq());
  return `<div class="pl-body${loading ? ' pl-busy' : ''}" data-pl-household${loading ? ' aria-busy="true"' : ''}>
    ${toggles()}
    ${meta}
    <div class="pl-sum">${tiles}${homeGaps(s)}</div>
    ${section('Months', strip, 'Spending for each month. Pick one to list its rows and scope Ask to it.', 'pl-sec')}
    ${section('Categories', homeTable(s, sel, rangeName), 'Pick a category or a month cell to see its rows.', 'pl-sec')}
    ${notesHtml(s.notes)}
  </div>`;
}

/* ---------- rows dialog ---------- */

function dlgFrame(kick, body) {
  return `<div class="h-dlg-back" data-dlg="close"></div><div class="h-dlg pl-dlgw" role="dialog" aria-modal="true" aria-labelledby="h-dlg-t" tabindex="-1"><div class="h-dlg-bar"><div class="h-kicker">${kick}</div><button type="button" class="h-dlg-x" data-dlg="close" aria-label="Close">${H.icon('x')}</button></div><div class="h-dlg-body">${body}</div></div>`;
}

function dlgLoad() {
  const st = D;
  if (!st || !st.spec) return;
  const token = ++PL_GEN;
  st.token = token;
  st.failed = false;
  const x = st.spec;
  const run = x.k === 'pnl'
    ? H.api.pnlRows({ entity: x.v, from: x.f, to: x.t, section: x.sec, category: x.cat, month: x.m })
    : H.api.spendingRows({ from: x.f, to: x.t, include: x.inc, exclude: x.exc, bucket: x.b, category: x.cat, month: x.m });
  Promise.resolve(run).then((d) => {
    if (D !== st || st.token !== token) return;
    st.data = d || null;
    st.failed = !d;
    H.draw();
  });
}

function dlgTable(st) {
  const { esc, api, plural } = H;
  const d = st.data;
  const head = (key, label, cls) => {
    const on = st.sort === key;
    return `<th scope="col" class="${cls}" data-pl-dlg-col="${key}" aria-sort="${on ? (st.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" class="pl-sort${on ? ` on ${st.dir}` : ''}" data-pl-dlg-sort="${key}">${label}<i class="pl-sort-i" aria-hidden="true"></i></button></th>`;
  };
  const items = sortRows(H.arr(d.items), st.sort, st.dir);
  // Amounts with cents, the row's counted value (the cell's sign).
  const amt = (key, fallback) => {
    const f = api.fig(key);
    const v = f && !f.missing ? f.v : fallback;
    return `<span class="fx-fig" data-fig="${esc(key)}" data-kind="${esc(f?.kind || 'a')}" tabindex="0">${esc(api.money(v, { cents: true }))}</span>`;
  };
  const rows = items.map((t) => {
    const acct = [t.account, st.spec.k === 'pnl' && t.kind === 'workbook' ? 'Workbook' : ''].filter(Boolean).map(esc).join(', ');
    return `<tr data-pl-dlg-row><td class="pl-d-date"><time datetime="${esc(t.date)}">${esc(plDay(t.date))}</time></td><td class="pl-d-desc">${esc(t.description || 'No description')}</td><td class="pl-d-acct">${acct}</td><td class="num pl-d-amt">${amt(t.fig, t.value)}</td></tr>`;
  }).join('');
  const shown = H.arr(d.items).length, total = Number(d.total) || 0;
  const count = shown < total ? `Showing ${shown} of ${total} rows; the total counts all ${total}` : plural(total, 'row');
  const empty = shown ? '' : '<tr class="pl-d-none"><td colspan="4">No rows behind this amount.</td></tr>';
  return `<table class="pl-dtable" data-pl-dlg-rows><thead><tr>${head('date', 'Date', 'pl-d-date')}<th scope="col" class="pl-d-desc">Description</th><th scope="col" class="pl-d-acct">Account</th>${head('amount', 'Amount', 'num pl-d-amt')}</tr></thead><tbody>${rows}${empty}</tbody>
    <tfoot><tr class="pl-d-tot"><th scope="row" colspan="3">Total <span class="pl-d-count" data-pl-dlg-count>${esc(count)}</span></th><td class="num pl-d-amt" data-pl-dlg-total>${d.sum ? amt(d.sum, 0) : nil}</td></tr></tfoot></table>${d.note ? `<p class="pl-note">${esc(d.note)}</p>` : ''}`;
}

// The rows dialog for #/pnlrows/<spec>: the design's dialog host calls this on every draw.
export function dialogHtml(id) {
  const { esc } = H;
  if (!D || D.id !== id) {
    D = dlgFresh(id);
    if (D.spec) dlgLoad();
  }
  const st = D;
  const x = st.spec;
  if (!x) return dlgFrame('P&amp;L', '<h1 id="h-dlg-t" class="h-dlg-title">Rows not found</h1><p class="h-mute">That link does not name a P&amp;L cell.</p>');
  const pnl = x.k === 'pnl';
  const scope = x.m ? plMonth(x.m) : plRange(x.f, x.t);
  const where = pnl ? (x.sec === 'income' ? 'Income' : 'Expenses') : (x.b === 'tax' ? 'Taxes' : x.b === 'household' ? 'Household spending' : plCap(x.b));
  const ent = pnl ? H.arr(P.entities).find((e) => e.key === x.v)?.label : 'Personal accounts';
  const add = pnl
    ? H.addBtn('pnl', `${x.v}|${x.cat}${x.m ? `|${x.m}` : ''}`, `P&L > ${x.cat}${x.m ? `, ${plMonth(x.m)}` : ''}`)
    : H.addBtn('spending', `${x.cat}${x.m ? `|${x.m}` : ''}`, `Spending > ${x.cat}${x.m ? `, ${plMonth(x.m)}` : ''}`);
  const meta = `<p class="h-meta pl-dlg-meta"><span>${esc(where)}</span><span data-pl-dlg-scope>${esc(scope)}</span>${ent ? `<span>${esc(ent)}</span>` : ''}</p>`;
  let body;
  if (st.failed) body = `<div class="pl-fail"><p class="h-ad-err" role="alert">Could not load these rows.</p>${H.btn('Try again', 'data-pl-dlg-retry', 'sm')}</div>`;
  else if (!st.data) body = '<p class="h-mute pl-load">Loading</p>';
  else body = dlgTable(st);
  const loading = !st.data && !st.failed;
  return dlgFrame(pnl ? 'P&amp;L' : 'Spending', `<div class="pl-dlg" data-pl-dlg${loading ? ' aria-busy="true"' : ''}>
    <div class="h-ad-titlerow pl-dlg-h"><h1 id="h-dlg-t" class="h-dlg-title">${esc(x.cat)}</h1>${add}</div>
    ${meta}${body}</div>`);
}

// The dialog host closed: forget its rows, so reopening loads them afresh.
export function dialogClosed() { D = null; }

/* ---------- page ---------- */

export function render() {
  const { shell, pageHead } = H;
  PL_PHONE = plPhone();
  syncFromRoute();
  plEnsure();
  let body;
  if (P.entities === null) {
    body = failedNow('ents')
      ? `${chooserFallback()}${failBox('the business P&amp;L')}`
      : '<p class="h-mute pl-load">Loading</p>';
  } else {
    body = `${chooser()}${P.view === PL_HOUSEHOLD ? householdView() : businessView()}`;
  }
  afterDraw();
  return shell(`<section class="pl">${pageHead('Money', 'P&amp;L', 'Profit and loss for each business, and what the household spends. Every amount opens to where it came from.')}${body}</section>`);
}

// Before the entities are known (their read failed), household spending is still reachable.
function chooserFallback() {
  return `<div class="pl-views" data-pl-views role="group" aria-label="Choose a P&amp;L"><button type="button" class="pl-view${P.view === PL_HOUSEHOLD ? ' on' : ''}" data-pl-view="${PL_HOUSEHOLD}" aria-pressed="${P.view === PL_HOUSEHOLD}"><span>Household spending</span><small>Personal accounts</small></button></div>`;
}

// The focused control as a selector that finds it again in the new markup.
function focusKey(el) {
  const d = el?.dataset;
  if (!d) return null;
  const q = (k, v) => `[${k}="${CSS.escape(v)}"]`;
  if (d.plFilter != null) return '[data-pl-filter]';
  if (d.plZero != null) return '[data-pl-zero]';
  if (d.plSort != null) return q('data-pl-sort', d.plSort);
  if (d.plType != null) return q('data-pl-type', d.plType);
  if (d.plMonth != null) return q('data-pl-month', d.plMonth);
  if (d.plView != null) return q('data-pl-view', d.plView);
  if (d.plToggle != null) return q('data-pl-toggle', d.plToggle);
  return null;
}

// After the page is replaced: keep the month strip and the table where they were scrolled (or show
// the selected month), and keep focus, caret included, on the control that had it.
function afterDraw() {
  const page = H.root?.querySelector('.h-root');
  const old = page?.querySelector('.pl [data-pl-months]');
  const left = old ? old.scrollLeft : null;
  const wrap = page?.querySelector('.pl .pl-tablewrap');
  const wrapLeft = wrap ? wrap.scrollLeft : null;
  const active = document.activeElement;
  const fsel = active && page?.querySelector('.pl')?.contains(active) ? focusKey(active) : null;
  const caret = fsel && active.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null;
  queueMicrotask(() => {
    const root = H.root;
    const strip = root?.querySelector('.h-root .pl [data-pl-months]');
    if (strip && strip.scrollWidth > strip.clientWidth) {
      if (left != null) strip.scrollLeft = left;
      const on = strip.querySelector('.pl-m.on');
      if (on) {
        const a = on.offsetLeft - strip.offsetLeft, b = a + on.offsetWidth;
        if (a < strip.scrollLeft || b > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = Math.max(0, b - strip.clientWidth + 8);
      }
    }
    const tw = root?.querySelector('.h-root .pl .pl-tablewrap');
    if (tw && wrapLeft != null) tw.scrollLeft = wrapLeft;
    if (fsel) {
      const now = document.activeElement;
      if (!now || now === document.body || !now.isConnected) {
        const el = root?.querySelector(`.h-root .pl ${fsel}`);
        if (el) {
          el.focus({ preventScroll: true });
          if (caret && el.setSelectionRange) { try { el.setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ } }
        }
      }
    }
  });
}

/* ---------- events ---------- */

// The selected month's column, scrolled into the table's view when it is off screen.
function showSelColumn() {
  queueMicrotask(() => {
    const wrap = H.root?.querySelector('.h-root .pl .pl-tablewrap');
    const th = wrap?.querySelector('th.pl-mc.sel');
    if (!wrap || !th || wrap.scrollWidth <= wrap.clientWidth) return;
    const cat = wrap.querySelector('thead th.pl-catc');
    const lead = cat ? cat.offsetWidth : 0;
    const a = th.offsetLeft - lead, b = th.offsetLeft + th.offsetWidth;
    if (a < wrap.scrollLeft || b > wrap.scrollLeft + wrap.clientWidth) wrap.scrollLeft = Math.max(0, b - wrap.clientWidth + 8);
  });
}

function dlgClick(t) {
  const d = t.dataset;
  if (!D) return;
  if (d.plDlgSort != null) {
    const key = d.plDlgSort === 'amount' ? 'amount' : 'date';
    if (D.sort === key) D.dir = D.dir === 'asc' ? 'desc' : 'asc';
    else { D.sort = key; D.dir = 'desc'; }
    H.draw();
    H.root?.querySelector(`.h-dlg-host [data-pl-dlg-sort="${key}"]`)?.focus();
    return;
  }
  if (d.plDlgRetry != null) {
    D.failed = false;
    dlgLoad();
    H.draw();
  }
}

export function onClick(e) {
  const dt = e.target.closest?.('[data-pl-dlg-sort],[data-pl-dlg-retry]');
  if (dt && dt.closest('[data-pl-dlg]') && H.root?.contains(dt)) {
    e.preventDefault();
    dlgClick(dt);
    return true;
  }
  const t = e.target.closest?.('[data-pl-view],[data-pl-month],[data-pl-toggle],[data-pl-sort],[data-pl-type],[data-pl-zero],[data-pl-retry]');
  if (!t || !t.closest('.pl') || !H.root?.contains(t)) return false;
  e.preventDefault();
  const d = t.dataset;
  if (d.plView != null) {
    if (P.view !== d.plView) {
      const wasHome = P.view === PL_HOUSEHOLD;
      P.view = d.plView;
      P.m = null;
      // Last year and Monthly average belong to one kind of view.
      if (wasHome !== (P.view === PL_HOUSEHOLD) && (P.s === 'ly' || P.s === 'avg')) { P.s = null; P.d = null; }
      writeHash();
    }
  } else if (d.plMonth != null) {
    P.m = d.plMonth || null;
    writeHash();
    if (P.m) showSelColumn();
  } else if (d.plSort != null) {
    const key = d.plSort;
    if (P.s === key) P.d = (P.d || defaultDir(key)) === 'asc' ? 'desc' : 'asc';
    else { P.s = key; P.d = defaultDir(key); }
    writeHash();
  } else if (d.plType != null) {
    P.t = d.plType === 'income' || d.plType === 'expenses' ? d.plType : 'all';
    writeHash();
  } else if (d.plZero != null) {
    P.z = !P.z;
    writeHash();
  } else if (d.plToggle != null) {
    if (d.plToggle === 'housing') P.housing = !P.housing;
    else if (d.plToggle === 'tax') P.tax = !P.tax;
  } else if (d.plRetry != null) {
    // Read the chooser again too: a P&L that failed may be one that is gone.
    P.failed.clear();
    P.entSc = null;
  }
  H.draw();
  return true;
}

// The text filter: every keystroke filters and updates the hash; afterDraw keeps the caret.
export function onInput(e) {
  const t = e.target;
  if (!t?.matches?.('[data-pl-filter]') || !t.closest('.pl') || !H.root?.contains(t)) return false;
  P.q = t.value;
  writeHash();
  H.draw();
  return true;
}
