/* Horizon account dialog: the same dialog host and chrome as the recommendation dialog, opened from
   an account row (Money, Accounts) or the quick switcher at #/account/<id>. It shows the name
   (rename in place), the institution, kind, owner and mirror state, the balance with its trend, one
   row per data source with its freshness (Sync now for a connected feed, how to refresh a file
   feed), a likely-duplicate question when there is one, and a read-only list of the account's
   transactions with a text filter and a date range, fetched a page at a time. Nothing here edits a
   transaction. Imported text (names, descriptions) is escaped, never resolved as tokens, except
   the demo's own account text, which follows the Accounts screen.

   The account itself can be edited from the head: Owner and Kind are selects in the meta line (a
   change saves at once, through the confirm queue on the server), Add last 4 stores a missing
   4-digit mask, and Merge with... picks another account, states which record stays and what moves,
   and merges on confirm. After a change a status line says what changed, with Undo where the
   server can undo it (last 4 has no undo). */

let H = null;

export function bind(kit) { H = kit; }

const PAGE = 50;
const DELAY = 250;

const fresh = () => ({
  id: null, sc: null, detail: null, detailFailed: false,
  edit: null, q: '', from: '', to: '',
  items: null, next: null, total: null, txnBusy: false, txnFailed: false,
  seq: 0, tseq: 0, timer: 0,
  // Edits: a value being saved per select, the open last-4 form, the open merge picker, the
  // status line with Undo, and an inline error for a refused Owner or Kind change.
  want: {}, mask: null, merge: null, undo: null, fieldErr: ''
});
let S = fresh();
// Request tokens come from one counter that never resets, so a response from an earlier visit to
// an account can never match a later request's token (switching A to B to A included).
let GEN = 0;
// The status line to show on the survivor's dialog after a merge removed the open account.
let CARRY = null;

export function reset() { clearTimeout(S.timer); S = fresh(); CARRY = null; }

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
// The Confirm screen's answers for the same questions, so a choice reads the same in both places.
const OWNER_OPTS = [{ id: 'owner', label: 'You' }, { id: 'spouse', label: 'Your spouse' }, { id: 'joint', label: 'Joint' }, { id: 'business', label: 'Business' }];
const KIND_OPTS = [
  { id: 'checking', label: 'Checking' }, { id: 'cash', label: 'Savings or cash' }, { id: 'card', label: 'Credit card' },
  { id: 'taxable', label: 'Taxable brokerage' }, { id: 'retirement', label: 'Retirement' }, { id: 'roth', label: 'Roth' },
  { id: 'hsa', label: 'HSA' }, { id: '529', label: '529 plan' }, { id: 'business', label: 'Business' }, { id: 'loan', label: 'Loan' }
];
const FIELD = {
  owner: { opts: OWNER_OPTS, key: 'ownerKey', name: 'Owner', unset: 'Set owner' },
  kind: { opts: KIND_OPTS, key: 'kindKey', name: 'Kind', unset: 'Set kind' }
};

// The meta line as plain text parts, in order: institution, kind, owner, mirror state, last data
// and the freshness chip. The mirror state is said once: a kind or owner that only repeats the
// mirror word (an account whose kind is "manual" on a manual account) is left out. tok marks text
// the demo may write as tokens. Pure, so it runs without a page.
export function metaParts(info, a, d) {
  const i = info || {};
  const acct = a || {};
  const m = acct.mirror || i.mirror;
  const mirror = m ? MIRROR[m] || String(m) : '';
  const repeats = (t) => !!mirror && String(t).trim().toLowerCase() === mirror.toLowerCase();
  const parts = [];
  const inst = i.inst || acct.inst;
  if (inst) parts.push({ cls: 'h-ad-inst', text: String(inst), tok: true });
  const kind = kindLabel(i.kind || acct.kind);
  if (kind && !repeats(kind)) parts.push({ cls: 'h-ad-kind', text: kind });
  const owner = i.owner || acct.owner;
  if (owner && !repeats(owner)) parts.push({ cls: 'h-ad-owner', text: String(owner), tok: true });
  if (mirror) parts.push({ cls: 'h-ad-mirror', text: mirror });
  const asOf = acct.asOf || d?.asOf;
  if (asOf) parts.push({ cls: 'h-ad-asof', text: `Last data ${dateLabel(asOf)}` });
  const state = acct.fresh && acct.fresh !== 'unknown' ? acct.fresh : d?.fresh;
  if (state === 'fresh') parts.push({ cls: 'h-fresh fresh', text: 'Fresh' });
  if (state === 'stale') parts.push({ cls: 'h-fresh stale', text: 'Stale' });
  return parts;
}

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
  const seq = ++GEN;
  S.seq = seq;
  Promise.resolve(H.api.accountDetail(id)).then((d) => {
    if (S.id !== id || seq !== S.seq) return;
    const prev = S.detail;
    S.detailFailed = !d;
    if (d) {
      S.detail = d;
      // A sync or import changed the ledger: fetch the first page again.
      // An append still in flight belongs to the old list: drop it so it cannot land on the new one.
      if (prev && (prev.txn.count !== d.txn.count || prev.txn.to !== d.txn.to)) { S.items = null; S.next = null; S.tseq = ++GEN; S.txnBusy = false; }
    }
    H.draw();
  });
}

const rangeBad = () => !!(S.from && S.to && S.from > S.to);

function loadTxns(append) {
  const id = S.id;
  if (rangeBad()) { S.items = S.items || []; S.total = 0; S.next = null; return; }
  const seq = ++GEN;
  S.tseq = seq;
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
  return `<div class="h-ad-titlerow"><h1 id="h-dlg-t" class="h-dlg-title h-ad-title">${a.displayName ? esc(a.name) : lbl(a, a.name)}</h1><button type="button" class="h-acc-pen h-ad-pen" data-dlg-rename="${esc(a.id)}" aria-label="Rename account">${icon('pen')}</button>${H.addBtn('account', a.id, a.displayName ? a.name : (a.imported === false ? H.api.txt(String(a.name ?? '')) : String(a.name ?? '')))}</div>`;
}

// Text for a plain-text context (an option, the status line): the demo's tokens resolved to words.
const plain = (a, s) => (a?.imported === false ? H.api.txt(String(s ?? '')) : String(s ?? ''));

// Owner or Kind as a select that saves on change. A current value with no option key (free text
// from an import, or nothing) shows as an empty first option, so nothing is chosen for the person.
function fieldSelect(a, d, field, part) {
  const { esc } = H;
  const f = FIELD[field];
  const opts = field === 'owner' && Array.isArray(d.ownerOptions) && d.ownerOptions.length ? d.ownerOptions : f.opts;
  const cur = S.want[field] ?? d.account?.[f.key] ?? null;
  const known = opts.some((o) => o.id === cur);
  const blank = known ? '' : `<option value="" selected>${esc(part ? (part.tok ? plain(a, part.text) : part.text) : f.unset)}</option>`;
  const list = opts.map((o) => `<option value="${esc(o.id)}"${o.id === cur ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  return `<span class="h-ad-${field} h-ad-field"><select class="h-ad-sel" data-ad-${field}="" aria-label="${f.name}">${blank}${list}</select></span>`;
}

function factsHtml(a, d) {
  const { esc } = H;
  const parts = metaParts(d?.account, a, d);
  const at = (cls) => parts.find((p) => p.cls === cls) || null;
  const span = (p) => `<span class="${esc(p.cls)}">${p.tok ? lbl(a, p.text) : esc(p.text)}</span>`;
  const out = [];
  const inst = at('h-ad-inst');
  if (inst) out.push(span(inst));
  // Selects once the detail names the option keys; plain text until then.
  for (const field of ['kind', 'owner']) {
    const p = at(`h-ad-${field}`);
    if (d?.account) out.push(fieldSelect(a, d, field, p));
    else if (p) out.push(span(p));
  }
  for (const p of parts) if (!/^h-ad-(inst|kind|owner)$/.test(p.cls)) out.push(span(p));
  const err = S.fieldErr ? `<p class="h-ad-err" role="alert">${esc(S.fieldErr)}</p>` : '';
  return `<div class="h-meta h-ad-facts">${out.join('')}</div>${err}`;
}

/* ---------- edits: last 4, merge, the status line ---------- */


function maskHtml() {
  const { esc, btn } = H;
  const m = S.mask;
  const err = m.err ? `<p class="h-ad-err" role="alert">${esc(m.err)}</p>` : '';
  return `<div class="h-ad-panel h-ad-maskf">
    <label class="h-ad-f"><span>Last 4 digits of the account number</span><input type="text" data-ad-mask="" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" value="${esc(m.value)}"${m.err ? ' aria-invalid="true"' : ''}></label>
    <div class="h-acts">${btn(m.busy ? 'Saving' : 'Save', `data-ad="mask-save"${m.busy ? ' disabled' : ''}`, 'pri')}${btn('Cancel', 'data-ad="mask-cancel"', 'ghost')}</div>
    ${err}
  </div>`;
}

function candidateHtml(c) {
  const { esc } = H;
  const bits = [c.inst ? esc(plain(c, c.inst)) : '', c.kind ? esc(kindLabel(c.kind)) : '', c.lastDataDate ? `Last data ${esc(dateLabel(c.lastDataDate))}` : 'No dated rows'].filter(Boolean);
  const why = c.refused ? `<span class="h-ad-pick-why">${esc(c.refused)}</span>` : '';
  return `<li><button type="button" class="h-ad-pick" data-merge-with="${esc(c.id)}"${c.refused ? ' disabled' : ''}><b>${esc(plain(c, c.label))}</b><span>${bits.join('<span class="h-dotsep"></span>')}</span>${why}</button></li>`;
}

function confirmHtml(a, c) {
  const { esc, btn, plural } = H;
  const p = c.plan || {};
  const mv = p.moves || {};
  const keep = esc(plain(c, p.keepLabel));
  const own = esc(plain(c, p.ownLabel));
  const ownMirror = p.ownId === c.id ? c.mirror : a.mirror;
  const moves = [plural(Number(mv.transactions) || 0, 'transaction')];
  if (mv.balances) moves.push(plural(Number(mv.balances), 'balance'));
  if (mv.positions) moves.push(plural(Number(mv.positions), 'position'));
  if (mv.sources) moves.push(plural(Number(mv.sources), 'data source'));
  const list = moves.length > 1 ? `${moves.slice(0, -1).join(', ')} and ${moves[moves.length - 1]}` : moves[0];
  const feed = ownMirror === 'connected' ? ' It takes over the connected feed and becomes the connected account.' : '';
  const m = S.merge;
  return `<div class="h-ad-panel h-ad-merge-confirm" role="group" aria-label="Confirm merge">
    <p><b>${keep}</b> stays and keeps its history.${feed}</p>
    <p>${esc(list)} move over from <b>${own}</b>, and <b>${own}</b> is removed.</p>
    <p class="h-mute sm">Undo puts both accounts back as they were.</p>
    <div class="h-acts">${btn(m.busy ? 'Merging' : 'Merge', `data-ad="merge-confirm"${m.busy ? ' disabled' : ''}`, 'pri')}${btn('Cancel', 'data-ad="merge-cancel"', 'ghost')}</div>
    ${m.err ? `<p class="h-ad-err" role="alert">${esc(m.err)}</p>` : ''}
  </div>`;
}

function mergeHtml(a) {
  const m = S.merge;
  if (m.pick) return confirmHtml(a, m.pick);
  let body;
  if (m.items === null) body = m.failed ? '<p class="h-ad-err" role="alert">Could not load the other accounts.</p>' : '<p class="h-mute sm">Loading</p>';
  else if (!m.items.length) body = '<p class="h-mute sm">There is no other account to merge with.</p>';
  else body = `<ul class="h-ad-picks">${m.items.map(candidateHtml).join('')}</ul>`;
  return `<div class="h-ad-panel h-ad-merge"><p class="h-mute sm">Which account is the same as this one?</p>${body}</div>`;
}

function undoHtml() {
  const { esc, btn } = H;
  const u = S.undo;
  if (!u) return '';
  const can = u.kind === 'owner' || u.kind === 'kind' || u.kind === 'merge';
  const b = can ? btn(u.busy ? 'Undoing' : 'Undo', `data-ad="undo"${u.busy ? ' disabled' : ''}`, 'ghost') : '';
  return `<div class="h-ad-undo" role="status"><span>${esc(u.text)}</span>${b}${u.err ? `<span class="h-ad-err">${esc(u.err)}</span>` : ''}</div>`;
}

function editHtml(a, d) {
  const { btn } = H;
  if (!d?.account) return undoHtml();
  const acts = [];
  if (d.account.maskEditable && !S.mask) acts.push(btn('Add last 4', 'data-ad="mask-open"', 'ghost'));
  acts.push(btn('Merge with…', `data-ad="merge-open" aria-expanded="${S.merge ? 'true' : 'false'}"`, 'ghost'));
  return `<div class="h-acts h-ad-acts">${acts.join('')}</div>${S.mask ? maskHtml() : ''}${S.merge ? mergeHtml(a) : ''}${undoHtml()}`;
}

function trendHtml(a, d) {
  const series = H.api.s?.series || {};
  const key = d && series[d.trendKey] ? d.trendKey : (a.fig && series[a.fig] ? a.fig : null);
  return key ? H.spark([key, series[key]]) : '';
}

function balanceHtml(a, d) {
  const { section, figHtml, esc } = H;
  // The balance's own date: newer transactions do not make an older balance current.
  const asOf = d?.balance?.asOf || '';
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
  return `<li class="h-ad-txn"><time class="h-ad-txn-d" datetime="${esc(t.date)}">${esc(t.date)}</time><div class="h-ad-txn-t"><span>${esc(t.description || 'No description')}</span>${t.category ? `<em>${esc(t.category)}</em>` : ''}</div><b class="h-ad-txn-a"><span class="fx-fig" data-fig="${esc(t.fig)}" data-kind="${esc(f.kind || 'a')}" tabindex="0">${esc(money)}</span></b>${H.addBtn('transaction', t.id, `${t.date} ${t.description || 'No description'}`)}</li>`;
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
  if (S.id !== id) {
    clearTimeout(S.timer);
    const undo = CARRY && CARRY.to === id ? CARRY.undo : null;
    CARRY = null;
    S = { ...fresh(), id, undo };
  }
  const a = accountOf(id);
  if (!a) return frame('Account', '<h1 id="h-dlg-t" class="h-dlg-title">Account not found</h1><p class="h-mute">That account is not in your data right now.</p>');
  ensure(id);
  const d = S.detail;
  const repairs = H.ingest.accountRepairsFor ? H.ingest.accountRepairsFor(id) : '';
  return frame('Account', `<div class="h-rec-head h-ad-head">
      ${titleHtml(a)}
      ${factsHtml(a, d)}
      ${editHtml(a, d)}
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
  // A custom name starts from the name as typed, without the "ending 1234" the label adds.
  S.edit = { value: a.displayName ? String(a.displayName) : (a.imported === false ? H.api.txt(String(a.name ?? '')) : String(a.name ?? '')) };
  H.draw();
  const el = H.root?.querySelector('.h-dlg-host [data-dlg-name]');
  if (el) { el.focus(); el.select(); }
}

function saveRename(id, raw) {
  S.edit = null;
  H.draw();
  H.api.accountRename(id, String(raw ?? '').trim());
}

const focusIn = (sel) => H.root?.querySelector(`.h-dlg-host ${sel}`)?.focus();

// Patch the loaded detail with what a save is known to have changed, so the dialog does not show
// the old value while the fresh detail loads.
function patchDetail(fields) {
  if (S.detail?.account) S.detail = { ...S.detail, account: { ...S.detail.account, ...fields } };
}

function optionLabel(field, key) {
  const d = S.detail || {};
  const opts = field === 'owner' && Array.isArray(d.ownerOptions) && d.ownerOptions.length ? d.ownerOptions : FIELD[field].opts;
  return opts.find((o) => o.id === key)?.label || key;
}

function commitField(field, value) {
  const id = S.id;
  const f = FIELD[field];
  const prev = S.detail?.account?.[f.key] ?? null;
  if (!value || value === prev || S.want[field] != null) return;
  S.want[field] = value;
  S.fieldErr = '';
  H.draw();
  const call = field === 'owner' ? H.api.accountOwner : H.api.accountKind;
  Promise.resolve(call(id, { [field]: value })).then((r) => {
    if (S.id !== id) return;
    delete S.want[field];
    if (!r || r.error) {
      S.fieldErr = `Could not change the ${f.name.toLowerCase()}. ${r?.error || ''}`.trim();
    } else {
      patchDetail({ [f.key]: value });
      S.undo = { kind: field, before: r.data.before, prev, text: `${f.name} changed to ${optionLabel(field, value)}.` };
    }
    H.draw();
  });
}

function undoChange() {
  const u = S.undo;
  const id = S.id;
  if (!u || u.busy) return;
  u.busy = true;
  u.err = '';
  H.draw();
  if (u.kind === 'merge') {
    Promise.resolve(H.api.reopenAnswer(u.itemId)).then((r) => {
      if (S.id !== id || S.undo !== u) return;
      u.busy = false;
      if (r && r.item !== undefined && !r.final) S.undo = { kind: 'done', text: 'Merge undone. Both accounts are back.' };
      else u.err = r?.final || 'Could not undo the merge.';
      H.draw();
    });
    return;
  }
  const f = FIELD[u.kind];
  const call = u.kind === 'owner' ? H.api.accountOwner : H.api.accountKind;
  Promise.resolve(call(id, { undo: u.before })).then((r) => {
    if (S.id !== id || S.undo !== u) return;
    u.busy = false;
    if (!r || r.error) u.err = r?.error || 'Could not undo that.';
    else {
      patchDetail({ [f.key]: u.prev });
      S.undo = { kind: 'done', text: `${f.name} change undone.` };
    }
    H.draw();
  });
}

function openMask() {
  S.merge = null;
  S.mask = { value: '', err: '', busy: false };
  H.draw();
  focusIn('[data-ad-mask]');
}

function closeMask() {
  S.mask = null;
  H.draw();
  focusIn('[data-ad="mask-open"]');
}

function saveMask() {
  const m = S.mask;
  const id = S.id;
  if (!m || m.busy) return;
  const v = String(m.value || '').trim();
  if (!/^\d{4}$/.test(v)) {
    m.err = 'Enter exactly four digits, 0 to 9.';
    H.draw();
    focusIn('[data-ad-mask]');
    return;
  }
  m.busy = true;
  m.err = '';
  H.draw();
  Promise.resolve(H.api.accountMask(id, v)).then((r) => {
    if (S.id !== id || S.mask !== m) return;
    if (!r || r.error) {
      m.busy = false;
      m.err = r?.error || 'Could not save the last 4.';
      H.draw();
      focusIn('[data-ad-mask]');
      return;
    }
    S.mask = null;
    patchDetail({ mask: v, maskEditable: false });
    S.undo = { kind: 'mask', text: `Last 4 saved. The account now shows ending ${v}.` };
    H.draw();
    focusIn('[data-ad="merge-open"]');
  });
}

function openMerge() {
  const id = S.id;
  if (S.merge) { S.merge = null; H.draw(); return; }
  const seq = ++GEN;
  const m = { seq, items: null, failed: false, pick: null, busy: false, err: '' };
  if (!S.mask?.busy) S.mask = null;
  S.merge = m;
  H.draw();
  Promise.resolve(H.api.accountMergeCandidates(id)).then((r) => {
    if (S.id !== id || S.merge !== m) return;
    m.items = r && Array.isArray(r.items) ? r.items : null;
    m.failed = !m.items;
    H.draw();
  });
}

function pickMerge(withId) {
  const m = S.merge;
  const c = m?.items?.find((x) => x.id === withId);
  if (!c || c.refused) return;
  m.pick = c;
  m.err = '';
  H.draw();
  focusIn('[data-ad="merge-confirm"]');
}

function cancelMerge() {
  S.merge = null;
  H.draw();
  focusIn('[data-ad="merge-open"]');
}

function confirmMerge() {
  const m = S.merge;
  const id = S.id;
  const c = m?.pick;
  if (!c || m.busy) return;
  m.busy = true;
  m.err = '';
  H.draw();
  Promise.resolve(H.api.accountMerge(id, c.id)).then((r) => {
    // The reply's scenario no longer has the merged-away account, so applying it can already have
    // reset this screen (S.id is null then). Only a different open account means the user moved on.
    const live = S.id === id && S.merge === m;
    if (!live && S.id !== null) return;
    if (!r || r.error) {
      if (!live) return;
      m.busy = false;
      m.err = r?.error || 'Could not merge these accounts.';
      H.draw();
      return;
    }
    const p = c.plan || {};
    const undo = { kind: 'merge', itemId: r.data.itemId, text: `Merged ${plain(c, p.ownLabel)} into ${plain(c, p.keepLabel)}.` };
    const sid = r.data.survivorId;
    // The open account was the one merged away: show the survivor, with the same status line.
    if (sid != null && String(sid) !== id && !accountOf(id)) {
      S.merge = null;
      CARRY = { to: String(sid), undo };
      H.api.go('account', { id: String(sid) }, { replace: true });
      return;
    }
    if (!live) return;
    S.merge = null;
    S.undo = undo;
    H.draw();
    focusIn('[data-ad="undo"]');
  });
}

const CLICKS = {
  'mask-open': openMask, 'mask-cancel': closeMask, 'mask-save': saveMask,
  'merge-open': openMerge, 'merge-cancel': cancelMerge, 'merge-confirm': confirmMerge,
  undo: undoChange
};

export function onClick(e) {
  const t = e.target.closest?.('[data-ad],[data-dlg-rename],[data-merge-with]');
  if (!t || !inDialog(t)) return false;
  e.preventDefault();
  if (t.dataset.dlgRename != null) { beginRename(t.dataset.dlgRename); return true; }
  if (t.dataset.mergeWith != null) { pickMerge(t.dataset.mergeWith); return true; }
  const k = t.dataset.ad;
  if (CLICKS[k]) { CLICKS[k](); return true; }
  if (k === 'more') { if (S.next && !S.txnBusy) { loadTxns(true); H.draw(); } return true; }
  if (k === 'clear') { clearTimeout(S.timer); S.q = ''; S.from = ''; S.to = ''; loadTxns(false); H.draw(); return true; }
  if (k === 'retry') { S.txnFailed = false; loadTxns(S.items !== null && S.items.length > 0 && !!S.next); H.draw(); return true; }
  return true;
}

export function onInput(e) {
  const t = e.target;
  if (!inDialog(t)) return false;
  if (t.dataset?.dlgName != null) { if (S.edit) S.edit.value = t.value; return true; }
  if (t.dataset?.adMask != null) { if (S.mask) S.mask.value = t.value; return true; }
  // The selects save on change.
  if (t.dataset?.adOwner != null || t.dataset?.adKind != null) return true;
  const k = t.dataset?.ad;
  if (k === 'q' || k === 'from' || k === 'to') { S[k] = t.value; schedule(); return true; }
  return false;
}

export function onChange(e) {
  const t = e.target;
  if (!inDialog(t)) return false;
  if (t.dataset?.adOwner != null) { commitField('owner', t.value); return true; }
  if (t.dataset?.adKind != null) { commitField('kind', t.value); return true; }
  return false;
}

export function onKey(e) {
  const t = e.target;
  if (t.dataset?.adMask != null && inDialog(t)) {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); if (S.mask) S.mask.value = t.value; saveMask(); return true; }
    // Escape closes the form, not the dialog.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMask(); return true; }
    return false;
  }
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
