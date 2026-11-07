/* Horizon P&L (Money, #/pnl): a business P&L for each entity (or unassigned business account) and
   household spending. A chooser picks the view; each view shows its totals, where the numbers come
   from, what they leave out, a month strip, a category table and, for a clicked category, the rows
   behind it. Every number is a figure the server returned (GET /api/pnl, /api/spending and their
   /rows reads) with its provenance; this file only lays them out. Imported text (entity and
   account labels, categories, descriptions) is escaped, never resolved as tokens. */

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
  month: {},           // view key -> selected YYYY-MM
  housing: true,
  tax: false,
  rows: null,          // the open rows panel
  scrollRows: false
});
let P = plFresh();
// Request tokens come from one counter that never resets, so a response for an earlier request (an
// entity switched away from, a toggle undone, a screen left and reopened) never lands on a newer one.
let PL_GEN = 0;

export function reset() { P = plFresh(); }

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
const plCap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

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

function openRows(spec) {
  const token = ++PL_GEN;
  P.rows = { ...spec, token, data: null, failed: false };
  P.scrollRows = true;
  loadRows();
}

function loadRows() {
  const r = P.rows;
  if (!r) return;
  const token = ++PL_GEN;
  r.token = token;
  r.failed = false;
  const run = r.kind === 'pnl' ? H.api.pnlRows(r.query) : H.api.spendingRows(r.query);
  Promise.resolve(run).then((d) => {
    if (P.rows !== r || r.token !== token) return;
    r.data = d || null;
    r.failed = !d;
    H.draw();
  });
}

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
  return key ? H.figHtml(key, { k: plPhone(), ...opts }) : nil;
}

function tile(k, label, key, sub = '') {
  const v = key ? H.api.fig(key) : null;
  const neg = v && typeof v.v === 'number' && v.v < 0;
  return `<div class="pl-tile${neg ? ' neg' : ''}" data-pl-total="${k}"><span class="pl-tile-k">${label}</span><b class="pl-tile-v">${key ? H.figHtml(key) : '<span class="h-mute">None</span>'}</b>${sub}</div>`;
}

function monthStrip(months, sel, figOf, tagOf) {
  const { esc } = H;
  const btns = months.map((m, i) => {
    const on = m === sel;
    const key = figOf(m);
    const tag = tagOf ? tagOf(m) : null;
    const year = i === 0 || m.endsWith('-01') ? `<em>${m.slice(0, 4)}</em>` : '';
    return `<button type="button" class="pl-m${on ? ' on' : ''}" data-pl-month="${esc(m)}" aria-pressed="${on}"><span class="pl-m-n">${plShort(m)}${year}</span><b>${key ? H.figHtml(key, { k: true, inert: true }) : '<span class="pl-m-none">None</span>'}</b>${tag ? `<small class="pl-m-s ${tag[0]}">${tag[1]}</small>` : ''}</button>`;
  }).join('');
  return `<div class="pl-months" data-pl-months role="group" aria-label="Month">${btns}</div>`;
}

const selMonth = (d) => {
  const m = P.month[P.view];
  return m && d.months.includes(m) ? m : d.to;
};

function rowsPanel() {
  const r = P.rows;
  if (!r || r.view !== P.view) return '';
  const { esc, btn, icon, plural, api } = H;
  let body;
  if (r.failed) body = `<p class="h-ad-err" role="alert">Could not load these rows.</p>${btn('Try again', 'data-pl-rows-retry', 'sm')}`;
  else if (!r.data) body = '<p class="h-mute">Loading</p>';
  else if (!r.data.items.length) body = '<p class="h-mute">No rows behind this amount.</p>';
  else {
    body = `<ol class="h-ad-txns">${r.data.items.map((t) => {
      const f = api.fig(t.fig);
      const amount = api.money(f.missing ? t.amount : f.v, { cents: true, sign: true });
      const date = t.kind === 'workbook' && /^\d{4}-\d{2}$/.test(String(t.date)) ? plMonth(String(t.date)) : String(t.date || '');
      const sub = [t.account, r.kind === 'pnl' && t.kind === 'workbook' ? 'Workbook' : ''].filter(Boolean).map(esc).join(', ');
      return `<li class="h-ad-txn"><time class="h-ad-txn-d" datetime="${esc(t.date)}">${esc(date)}</time><div class="h-ad-txn-t"><span>${esc(t.description || 'No description')}</span>${sub ? `<em>${sub}</em>` : ''}</div><b class="h-ad-txn-a"><span class="fx-fig" data-fig="${esc(t.fig)}" data-kind="${esc(f.kind || 'a')}" tabindex="0">${esc(amount)}</span></b></li>`;
    }).join('')}</ol>${r.data.note ? `<p class="pl-note">${esc(r.data.note)}</p>` : ''}`;
  }
  let count = '';
  if (r.data) {
    const shown = r.data.items.length, total = Number(r.data.total) || 0;
    count = shown < total ? `Showing ${shown} of ${total} rows` : plural(total, 'row');
  }
  const close = btn(`${icon('x')}<span>Close</span>`, 'data-pl-rows-close', 'ghost sm');
  return `<section class="h-sec pl-rows" data-pl-rows tabindex="-1" aria-labelledby="pl-rows-t">
    <div class="h-sec-h"><h2 id="pl-rows-t">${esc(r.category)}</h2><div class="h-sec-aside">${close}</div></div>
    <p class="pl-rows-sub"><span>${esc(r.where)}</span><span class="h-dotsep"></span><span data-pl-rows-count aria-live="polite">${esc(count)}</span></p>
    ${body}</section>`;
}

function notesHtml(notes) {
  const ns = H.arr(notes).filter((n) => typeof n === 'string' && n);
  return ns.length ? `<ul class="pl-notes">${ns.map((n) => `<li>${H.esc(n)}</li>`).join('')}</ul>` : '';
}

function failBox(what) {
  return `<div class="pl-fail"><p class="h-ad-err" role="alert">Could not load ${what}.</p>${H.btn('Try again', 'data-pl-retry', 'sm')}</div>`;
}

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
  const { esc } = H;
  const prior = p.prior;
  const ly = (html) => (prior ? html : '');
  const cols = prior ? 4 : 3;
  const head = `<thead><tr><th scope="col">Category</th><th scope="col" class="num">${plMonth(sel)}</th><th scope="col" class="num">${rangeName}</th>${ly('<th scope="col" class="num pl-ly">Last year</th>')}</tr></thead>`;
  const open = P.rows && P.rows.view === P.view ? P.rows : null;
  const group = (section, label) => {
    const g = p[section] || {};
    const cats = H.arr(g.categories);
    const pc = prior?.categories?.[section] || {};
    const rows = cats.length
      ? cats.map((c) => {
        const on = open && open.section === section && open.category === c.category;
        return `<tr><th scope="row"><button type="button" class="pl-cat${on ? ' on' : ''}" data-pl-cat="${esc(c.category)}" data-pl-section="${section}"${on ? ' aria-expanded="true"' : ''}>${esc(c.category)}</button>${H.addBtn('pnl', `${P.view}|${c.category}`, `P&L > ${c.category}`)}</th><td class="num">${cell(c.months?.[sel])}</td><td class="num">${cell(c.total)}</td>${ly(`<td class="num pl-ly">${cell(pc[c.category])}</td>`)}</tr>`;
      }).join('')
      : `<tr class="pl-empty"><td colspan="${cols}">No ${section} in these months.</td></tr>`;
    const total = `<tr class="pl-t"><th scope="row">Total ${section}</th><td class="num">${cell(g.months?.[sel])}</td><td class="num">${cell(g.total)}</td>${ly(`<td class="num pl-ly">${cell(prior?.[section])}</td>`)}</tr>`;
    return `<tbody><tr class="pl-h"><th scope="rowgroup" colspan="${cols}">${label}</th></tr>${rows}${total}</tbody>`;
  };
  const net = `<tbody class="pl-net"><tr><th scope="row">Net</th><td class="num">${cell(p.net?.months?.[sel])}</td><td class="num">${cell(p.net?.total)}</td>${ly(`<td class="num pl-ly">${cell(prior?.net)}</td>`)}</tr></tbody>`;
  return `<div class="pl-tablewrap"><table class="pl-table" data-pl-table>${head}${group('income', 'Income')}${group('expenses', 'Expenses')}${net}</table></div>`;
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
  const strip = monthStrip(p.months, sel, (m) => p.net?.months?.[m], (m) => TAG[ms.get(m)?.source] || TAG.none);
  const cov = ms.get(sel)?.covered;
  const selNote = cov && Number(cov.rows) > 0
    ? `<p class="pl-line">${plMonth(sel)} uses the workbook. ${H.plural(Number(cov.rows), 'transaction')} in that month ${Number(cov.rows) === 1 ? 'adds' : 'add'} up to ${cov.amount ? H.figHtml(cov.amount) : 'an amount'} and ${Number(cov.rows) === 1 ? 'is' : 'are'} not counted.</p>`
    : '';
  return `<div class="pl-body" data-pl-business${busy(bizReq(key)) ? ' aria-busy="true"' : ''}>
    ${meta}
    <div class="pl-sum">${tiles}${priorLine}${sourcesLine(p)}${bizGaps(p)}</div>
    ${section('Months', `${strip}${selNote}`, 'Net for each month. Pick one to fill the month column.', 'pl-sec')}
    ${section('Categories', bizTable(p, sel, rangeName), 'Pick a category to see its rows.', 'pl-sec')}
    ${rowsPanel()}
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
  const open = P.rows && P.rows.view === P.view ? P.rows : null;
  const head = `<thead><tr><th scope="col">Category</th><th scope="col" class="num">${plMonth(sel)}</th><th scope="col" class="num">${rangeName}</th><th scope="col" class="num pl-avg">Monthly average</th></tr></thead>`;
  const groups = H.arr(s.buckets).map((b) => {
    const rows = H.arr(b.categories).map((c) => {
      const on = open && open.bucket === b.bucket && open.category === c.category;
      return `<tr><th scope="row"><button type="button" class="pl-cat${on ? ' on' : ''}" data-pl-cat="${esc(c.category)}" data-pl-bucket="${esc(b.bucket)}"${on ? ' aria-expanded="true"' : ''}>${esc(c.category)}</button>${c.housing ? '<span class="pl-tag">Housing</span>' : ''}${H.addBtn('spending', c.category, `Spending > ${c.category}`)}</th><td class="num">${cell(c.months?.[sel])}</td><td class="num">${cell(c.total)}</td><td class="num pl-avg">${cell(c.average)}</td></tr>`;
    }).join('');
    return `<tbody><tr class="pl-h"><th scope="rowgroup" colspan="2">${esc(b.label)}</th><td class="num">${cell(b.total)}</td><td class="num pl-avg"></td></tr>${rows}</tbody>`;
  }).join('');
  const total = `<tbody class="pl-net"><tr><th scope="row">Total spending</th><td class="num">${cell(s.monthTotals?.[sel])}</td><td class="num">${cell(s.total)}</td><td class="num pl-avg">${cell(s.monthlyAverage)}</td></tr></tbody>`;
  return `<div class="pl-tablewrap"><table class="pl-table home" data-pl-table>${head}${groups}${total}</table></div>`;
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
  const n = H.arr(s.months).length;
  const rangeName = n === 12 ? '12 months' : H.plural(n, 'month');
  const tiles = `<div class="pl-tiles">${tile('total', rangeName === '12 months' ? 'Last 12 months' : rangeName, s.total)}${tile('average', 'Monthly average', s.monthlyAverage)}${tile('month', plMonth(sel), s.monthTotals?.[sel])}</div>`;
  const meta = `<div class="h-meta pl-meta"><span>${esc(plRange(s.from, s.to))}</span><span>Personal accounts only; business accounts never count</span></div>`;
  const strip = monthStrip(s.months, sel, (m) => s.monthTotals?.[m], (m) => (H.arr(s.gaps?.emptyMonths).includes(m) ? ['no', 'No rows'] : null));
  const loading = busy(homeReq());
  return `<div class="pl-body${loading ? ' pl-busy' : ''}" data-pl-household${loading ? ' aria-busy="true"' : ''}>
    ${toggles()}
    ${meta}
    <div class="pl-sum">${tiles}${homeGaps(s)}</div>
    ${section('Months', strip, 'Spending for each month. Pick one to fill the month column.', 'pl-sec')}
    ${section('Categories', homeTable(s, sel, rangeName), 'Pick a category to see its rows.', 'pl-sec')}
    ${rowsPanel()}
    ${notesHtml(s.notes)}
  </div>`;
}

/* ---------- page ---------- */

export function render() {
  const { shell, pageHead } = H;
  plEnsure();
  let body;
  if (P.entities === null) {
    body = failedNow('ents')
      ? `${chooserFallback()}${failBox('the business P&amp;L')}`
      : '<p class="h-mute pl-load">Loading</p>';
  } else {
    body = `${chooser()}${P.view === PL_HOUSEHOLD ? householdView() : businessView()}`;
  }
  // What is on screen, for the Ask page chip: the entity, the selected month and, for household
  // spending, the toggles that differ from their defaults (housing on, tax off).
  if (H.pageContext && P.view) {
    const hh = P.view === PL_HOUSEHOLD;
    const e = hh ? null : H.arr(P.entities).find((x) => x && x.key === P.view);
    const d = hh ? P.home.get(P.homeShown || homeKey())?.data?.spending : bizEntry(P.view)?.data?.pnl;
    H.pageContext({
      pnl: e ? { id: String(e.key), label: String(e.label ?? '') } : null,
      month: d && Array.isArray(d.months) && d.months.length ? selMonth(d) : undefined,
      filters: hh ? [...(P.housing ? [] : [{ key: 'housing', value: 'off' }]), ...(P.tax ? [{ key: 'tax', value: 'on' }] : [])] : []
    });
  }
  afterDraw();
  return shell(`<section class="pl">${pageHead('Money', 'P&amp;L', 'Profit and loss for each business, and what the household spends. Every amount opens to where it came from.')}${body}</section>`);
}

// Before the entities are known (their read failed), household spending is still reachable.
function chooserFallback() {
  return `<div class="pl-views" data-pl-views role="group" aria-label="Choose a P&amp;L"><button type="button" class="pl-view${P.view === PL_HOUSEHOLD ? ' on' : ''}" data-pl-view="${PL_HOUSEHOLD}" aria-pressed="${P.view === PL_HOUSEHOLD}"><span>Household spending</span><small>Personal accounts</small></button></div>`;
}

// After the page is replaced: keep the month strip where it was scrolled (or show the selected
// month), and bring a newly opened rows panel into view.
function afterDraw() {
  const old = H.root?.querySelector('.pl [data-pl-months]');
  const left = old ? old.scrollLeft : null;
  const scrollRows = P.scrollRows;
  P.scrollRows = false;
  queueMicrotask(() => {
    const root = H.root;
    const strip = root?.querySelector('.pl [data-pl-months]');
    if (strip && strip.scrollWidth > strip.clientWidth) {
      if (left != null) strip.scrollLeft = left;
      const on = strip.querySelector('.pl-m.on');
      if (on) {
        const a = on.offsetLeft - strip.offsetLeft, b = a + on.offsetWidth;
        if (a < strip.scrollLeft || b > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = Math.max(0, b - strip.clientWidth + 8);
      }
    }
    if (scrollRows) {
      const panel = root?.querySelector('.pl [data-pl-rows]');
      if (panel) { panel.focus({ preventScroll: true }); panel.scrollIntoView({ block: 'start' }); }
    }
  });
}

/* ---------- events ---------- */

export function onClick(e) {
  const t = e.target.closest?.('[data-pl-view],[data-pl-month],[data-pl-toggle],[data-pl-cat],[data-pl-rows-close],[data-pl-rows-retry],[data-pl-retry]');
  if (!t || !t.closest('.pl') || !H.root?.contains(t)) return false;
  e.preventDefault();
  const d = t.dataset;
  if (d.plView != null) {
    if (P.view !== d.plView) { P.view = d.plView; P.rows = null; }
  } else if (d.plMonth != null) {
    P.month[P.view] = d.plMonth;
  } else if (d.plToggle != null) {
    if (d.plToggle === 'housing') P.housing = !P.housing;
    else if (d.plToggle === 'tax') P.tax = !P.tax;
    P.rows = null;
  } else if (d.plCat != null) {
    const cat = d.plCat;
    if (d.plSection != null) {
      const p = bizEntry(P.view)?.data?.pnl;
      if (!p) return true;
      openRows({ kind: 'pnl', view: P.view, section: d.plSection, category: cat, where: `${d.plSection === 'income' ? 'Income' : 'Expenses'}, ${plRange(p.from, p.to)}`, query: { entity: p.entity.key, from: p.from, to: p.to, section: d.plSection, category: cat } });
    } else {
      const s = P.home.get(P.homeShown || homeKey())?.data?.spending;
      if (!s) return true;
      const label = H.arr(s.buckets).find((b) => b.bucket === d.plBucket)?.label || plCap(d.plBucket);
      openRows({ kind: 'spend', view: P.view, bucket: d.plBucket, category: cat, where: `${label}, ${plRange(s.from, s.to)}`, query: { from: s.from, to: s.to, include: s.include, exclude: s.exclude, bucket: d.plBucket, category: cat } });
    }
  } else if (d.plRowsClose != null) {
    P.rows = null;
    H.draw();
    H.root?.querySelector('.pl [data-pl-table]')?.scrollIntoView({ block: 'nearest' });
    return true;
  } else if (d.plRowsRetry != null) {
    loadRows();
  } else if (d.plRetry != null) {
    // Read the chooser again too: a P&L that failed may be one that is gone.
    P.failed.clear();
    P.entSc = null;
  }
  H.draw();
  return true;
}
