/* Horizon account dialog: the same dialog host and chrome as the recommendation dialog, opened from
   an account row (Money, Accounts) or the quick switcher at #/account/<id>. It shows the name
   (rename in place), the institution, kind, owner and mirror state, the balance with its trend, one
   row per data source with its freshness (Sync now for a connected feed, how to refresh a file
   feed), a likely-duplicate question when there is one, and a read-only list of the account's
   transactions with a text filter and a date range, fetched a page at a time. Nothing here edits a
   transaction. Imported text (names, descriptions) is escaped, never resolved as tokens, except
   the demo's own account text, which follows the Accounts screen. */

let H = null;

export function bind(kit) { H = kit; }

const PAGE = 50;
const DELAY = 250;

const fresh = () => ({
  id: null, sc: null, detail: null, detailFailed: false,
  edit: null, q: '', from: '', to: '',
  items: null, next: null, total: null, txnBusy: false, txnFailed: false,
  seq: 0, tseq: 0, timer: 0
});
let S = fresh();

export function reset() { clearTimeout(S.timer); S = fresh(); }

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dateLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${MON[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : '';
}
function timeLabel(iso) {
  const d = new Date(String(iso || ''));
  if (Number.isNaN(d.getTime())) return '';
  const h = d.getHours();
  return `${MON[d.getMonth()]} ${d.getDate()}, ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

const KIND = { checking: 'Checking', cash: 'Savings', card: 'Credit card', taxable: 'Brokerage', retirement: 'Retirement', roth: 'Roth IRA', hsa: 'HSA', 529: '529 plan', business: 'Business', loan: 'Loan' };
const kindLabel = (k) => (k ? KIND[String(k).toLowerCase()] || String(k).charAt(0).toUpperCase() + String(k).slice(1) : '');
const MIRROR = { connected: 'Mirrored', manual: 'Manual', missing: 'Not connected' };

const accountOf = (id) => H.arr(H.api.s?.accounts).find((x) => x.id === id) || null;
// Account text from an uploaded file is plain text; the demo's own account text may carry tokens.
const lbl = (a, s) => (a.imported === false ? H.T(s) : H.esc(s));

/* ---------- loading ---------- */

function ensure(id) {
  const sc = H.api.s;
  if (S.sc !== sc) loadDetail(id, sc);
  if (S.items === null && !S.txnBusy) loadTxns(false);
}

function loadDetail(id, sc) {
  S.sc = sc;
  const seq = ++S.seq;
  Promise.resolve(H.api.accountDetail(id)).then((d) => {
    if (S.id !== id || seq !== S.seq) return;
    const prev = S.detail;
    S.detailFailed = !d;
    if (d) {
      S.detail = d;
      // A sync or import changed the ledger: fetch the first page again.
      if (prev && (prev.txn.count !== d.txn.count || prev.txn.to !== d.txn.to)) { S.items = null; S.next = null; }
    }
    H.draw();
  });
}

const rangeBad = () => !!(S.from && S.to && S.from > S.to);

function loadTxns(append) {
  const id = S.id;
  if (rangeBad()) { S.items = S.items || []; S.total = 0; S.next = null; return; }
  const seq = ++S.tseq;
  S.txnBusy = true;
  const opts = { q: S.q.trim(), from: S.from, to: S.to, limit: PAGE, cursor: append ? S.next : null };
  Promise.resolve(H.api.accountTransactions(id, opts)).then((page) => {
    if (S.id !== id || seq !== S.tseq) return;
    S.txnBusy = false;
    S.txnFailed = !page;
    if (page) {
      S.items = append && S.items ? S.items.concat(page.items) : page.items;
      S.next = page.next;
      S.total = page.total;
    } else if (S.items === null) {
      S.items = [];
    }
    H.draw();
  });
}

function schedule() {
  clearTimeout(S.timer);
  S.timer = setTimeout(() => {
    if (rangeBad()) { H.draw(); return; }
    loadTxns(false);
  }, DELAY);
}

/* ---------- rendering ---------- */

function chip(state) {
  if (state === 'fresh') return '<span class="h-fresh fresh">Fresh</span>';
  if (state === 'stale') return '<span class="h-fresh stale">Stale</span>';
  return '';
}

function frame(kick, body) {
  const { icon } = H;
  return `<div class="h-dlg-back" data-dlg="close"></div><div class="h-dlg h-ad" role="dialog" aria-modal="true" aria-labelledby="h-dlg-t" tabindex="-1"><div class="h-dlg-bar"><div class="h-kicker">${kick}</div><button type="button" class="h-dlg-x" data-dlg="close" aria-label="Close">${icon('x')}</button></div><div class="h-dlg-body">${body}</div></div>`;
}

function titleHtml(a) {
  const { esc, icon } = H;
  if (S.edit) {
    return `<h1 id="h-dlg-t" class="h-dlg-title h-ad-title"><input class="h-acc-edit h-ad-edit" data-dlg-name="${esc(a.id)}" value="${esc(S.edit.value)}" maxlength="120" aria-label="Account name" autocomplete="off"></h1>`;
  }
  return `<div class="h-ad-titlerow"><h1 id="h-dlg-t" class="h-dlg-title h-ad-title">${a.displayName ? esc(a.name) : lbl(a, a.name)}</h1><button type="button" class="h-acc-pen h-ad-pen" data-dlg-rename="${esc(a.id)}" aria-label="Rename account">${icon('pen')}</button></div>`;
}

function factsHtml(a, d) {
  const { esc } = H;
  const info = d?.account || {};
  const parts = [];
  if (info.inst) parts.push(`<span class="h-ad-inst">${lbl(a, info.inst)}</span>`);
  const kind = kindLabel(info.kind || a.kind);
  if (kind) parts.push(`<span class="h-ad-kind">${esc(kind)}</span>`);
  if (info.owner || a.owner) parts.push(`<span class="h-ad-owner">${lbl(a, info.owner || a.owner)}</span>`);
  parts.push(`<span class="h-ad-mirror">${esc(MIRROR[a.mirror] || a.mirror || '')}</span>`);
  const state = a.fresh && a.fresh !== 'unknown' ? a.fresh : d?.fresh;
  const asOf = a.asOf || d?.asOf;
  if (asOf) parts.push(`<span>Last data ${esc(dateLabel(asOf))}</span>`);
  if (state === 'fresh' || state === 'stale') parts.push(chip(state));
  return `<div class="h-meta h-ad-facts">${parts.join('')}</div>`;
}

function trendHtml(a, d) {
  const series = H.api.s?.series || {};
  const key = d && series[d.trendKey] ? d.trendKey : (a.fig && series[a.fig] ? a.fig : null);
  return key ? H.spark([key, series[key]]) : '';
}

function balanceHtml(a, d) {
  const { section, figHtml, esc } = H;
  const asOf = a.asOf || d?.asOf;
  const body = `<div class="h-ad-balance"><div class="h-ad-bal">${a.fig ? figHtml(a.fig) : '<span class="h-mute">No balance</span>'}</div>${asOf ? `<p class="h-mute sm">As of ${esc(dateLabel(asOf))}</p>` : ''}${trendHtml(a, d)}</div>`;
  return section('Balance', body);
}

function feedHtml(f) {
  const { esc, btn } = H;
  const sf = H.sfStatus();
  const bits = [];
  if (f.kind === 'simplefin') {
    bits.push(f.lastSyncAt ? `Last sync ${esc(timeLabel(f.lastSyncAt))}` : 'Not synced yet');
    if (f.balanceDate) bits.push(`Balance dated ${esc(dateLabel(f.balanceDate))}`);
  } else if (f.lastDataDate) {
    bits.push(`Last data ${esc(dateLabel(f.lastDataDate))}`);
  } else {
    bits.push('No dated rows');
  }
  if (f.cadence) bits.push(`Export ${esc(f.cadence)}`);
  const act = f.kind === 'simplefin' && f.status !== undefined
    ? `<div class="h-ad-feed-a">${btn(sf.busy === 'sync' ? 'Syncing' : 'Sync now', `type="button" data-sf="sync"${sf.busy || !S.detail?.syncable ? ' disabled' : ''}`, 'sm')}${sf.notice ? `<span class="h-mute sm" role="status">${esc(sf.notice)}</span>` : ''}</div>`
    : '';
  const how = f.kind === 'file' && f.howTo
    ? `<details class="h-ad-how"><summary>${H.icon('chev')}<span>How to refresh</span></summary><ol>${f.howTo.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></details>`
    : '';
  return `<li data-feed="${esc(f.id)}"><div class="h-src-n"><b>${esc(f.label)}</b><span>${bits.join('<span class="h-dotsep"></span>')}</span>${act}${how}</div>${chip(f.state)}</li>`;
}

function sourcesHtml(d) {
  const { section, plural } = H;
  if (!d) return section('Sources', S.detailFailed ? '<p class="h-mute">Could not load the sources. Close this and open it again.</p>' : '<p class="h-mute">Loading</p>');
  const body = d.feeds.length ? `<ul class="h-srcs h-ad-sources">${d.feeds.map(feedHtml).join('')}</ul>` : '<p class="h-mute">No data from any source yet.</p>';
  return section('Sources', body, d.feeds.length ? plural(d.feeds.length, 'source') : '');
}

function txnRow(t) {
  const { esc, api } = H;
  const f = api.fig(t.fig);
  const money = api.money(t.amount, { cents: true, sign: true });
  return `<li class="h-ad-txn"><time class="h-ad-txn-d" datetime="${esc(t.date)}">${esc(t.date)}</time><div class="h-ad-txn-t"><span>${esc(t.description || 'No description')}</span>${t.category ? `<em>${esc(t.category)}</em>` : ''}</div><b class="h-ad-txn-a"><span class="fx-fig" data-fig="${esc(t.fig)}" data-kind="${esc(f.kind || 'a')}" tabindex="0">${esc(money)}</span></b></li>`;
}

function filterHtml() {
  const { esc, btn } = H;
  const on = S.q || S.from || S.to;
  return `<div class="h-ad-filter">
    <label class="h-ad-f q"><span>Search</span><input type="search" data-ad="q" value="${esc(S.q)}" maxlength="100" placeholder="Description or category" autocomplete="off"></label>
    <label class="h-ad-f"><span>From</span><input type="date" data-ad="from" value="${esc(S.from)}"></label>
    <label class="h-ad-f"><span>To</span><input type="date" data-ad="to" value="${esc(S.to)}"></label>
    ${on ? btn('Clear', 'type="button" data-ad="clear"', 'ghost sm') : ''}
  </div>${rangeBad() ? '<p class="h-ad-err" role="alert">The start date is after the end date.</p>' : ''}`;
}

function txnHtml() {
  const { section, esc, btn, plural } = H;
  let list;
  if (S.items === null) list = '<p class="h-mute">Loading</p>';
  else if (S.txnFailed && !S.items.length) list = `<p class="h-ad-err" role="alert">Could not load transactions.</p>${btn('Try again', 'type="button" data-ad="retry"', 'sm')}`;
  else if (!S.items.length) list = `<p class="h-mute">${S.q || S.from || S.to ? 'No transactions match.' : 'No transactions for this account yet.'}</p>`;
  else {
    const more = S.next ? btn(S.txnBusy ? 'Loading' : 'Load more', `type="button" data-ad="more"${S.txnBusy ? ' disabled' : ''}`, 'ghost') : '';
    list = `<ol class="h-ad-txns">${S.items.map(txnRow).join('')}</ol>${more ? `<div class="h-ad-more">${more}</div>` : ''}${S.txnFailed ? '<p class="h-ad-err" role="alert">Could not load more.</p>' : ''}`;
  }
  const total = S.total == null ? 0 : S.total;
  const shown = S.items ? S.items.length : 0;
  const count = S.items === null ? '' : shown < total ? `Showing ${shown} of ${total}` : plural(total, 'transaction');
  return section('Transactions', `${filterHtml()}<div class="h-ad-count" aria-live="polite">${esc(count)}</div>${list}`, 'Read-only. Newest first.');
}

export function html(id) {
  const { esc } = H;
  if (S.id !== id) { clearTimeout(S.timer); S = { ...fresh(), id }; }
  const a = accountOf(id);
  if (!a) return frame('Account', '<h1 id="h-dlg-t" class="h-dlg-title">Account not found</h1><p class="h-mute">That account is not in your data right now.</p>');
  ensure(id);
  const d = S.detail;
  const repairs = H.ingest.accountRepairsFor ? H.ingest.accountRepairsFor(id) : '';
  return frame('Account', `<div class="h-rec-head h-ad-head">
      ${titleHtml(a)}
      ${factsHtml(a, d)}
    </div>
    ${repairs}
    <div class="h-dcols">
      <div class="h-dmain">${txnHtml()}</div>
      <div class="h-dside">${balanceHtml(a, d)}${sourcesHtml(d)}</div>
    </div>`);
}

/* ---------- events ---------- */

const inDialog = (el) => !!el?.closest?.('.h-dlg-host');

function beginRename(id) {
  const a = accountOf(id);
  if (!a) return;
  S.edit = { value: a.displayName ? a.name : (a.imported === false ? H.api.txt(String(a.name ?? '')) : String(a.name ?? '')) };
  H.draw();
  const el = H.root?.querySelector('.h-dlg-host [data-dlg-name]');
  if (el) { el.focus(); el.select(); }
}

function saveRename(id, raw) {
  S.edit = null;
  H.draw();
  H.api.accountRename(id, String(raw ?? '').trim());
}

export function onClick(e) {
  const t = e.target.closest?.('[data-ad],[data-dlg-rename]');
  if (!t || !inDialog(t)) return false;
  e.preventDefault();
  if (t.dataset.dlgRename != null) { beginRename(t.dataset.dlgRename); return true; }
  const k = t.dataset.ad;
  if (k === 'more') { if (S.next && !S.txnBusy) { loadTxns(true); H.draw(); } return true; }
  if (k === 'clear') { clearTimeout(S.timer); S.q = ''; S.from = ''; S.to = ''; loadTxns(false); H.draw(); return true; }
  if (k === 'retry') { S.txnFailed = false; loadTxns(S.items !== null && S.items.length > 0 && !!S.next); H.draw(); return true; }
  return true;
}

export function onInput(e) {
  const t = e.target;
  if (!inDialog(t)) return false;
  if (t.dataset?.dlgName != null) { if (S.edit) S.edit.value = t.value; return true; }
  const k = t.dataset?.ad;
  if (k === 'q' || k === 'from' || k === 'to') { S[k] = t.value; schedule(); return true; }
  return false;
}

export function onKey(e) {
  const t = e.target;
  if (t.dataset?.dlgName == null) return false;
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); saveRename(t.dataset.dlgName, t.value); return true; }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    S.edit = null;
    H.draw();
    H.root?.querySelector('.h-dlg-host [data-dlg-rename]')?.focus();
    return true;
  }
  return false;
}
