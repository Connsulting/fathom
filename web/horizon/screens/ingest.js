/* Horizon ingest screens: Add files, per-file results, the Confirm deck (item and group cards with
   their context), Decided for you, the pending banner, account freshness and the Sources list.
   Text from the server (file names, questions, option labels, guess evidence, account names,
   holders, descriptions, source labels) is plain text and always goes through esc(), never token
   resolution. */

import { createSwipe } from './swipe.js';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const STATUS = {
  imported: 'Imported',
  duplicate: 'Already imported',
  needs_mapping: 'Needs a mapping',
  needs_extraction: 'Needs the engine to read it',
  unsupported: 'Not a supported file',
  too_large: 'Too large to read',
  failed: 'Could not import'
};

const ROWS = [
  ['transaction', 'transaction'],
  ['balance', 'balance'],
  ['position', 'position'],
  ['pnl_line', 'profit and loss line'],
  ['tax_payment', 'tax payment'],
  ['document', 'document'],
  ['fact', 'fact']
];

const KIND = {
  account_owner: 'Account owner',
  account_kind: 'Account type',
  entity_alias: 'Business name',
  tax_year: 'Tax year',
  fact_check: 'Check a value',
  near_duplicate: 'Possible duplicate',
  account_match: 'Same account?',
  employer_relation: 'Employer',
  employer_recipient: 'Who is paid',
  document_recipient: 'Whose document',
  withholding_conflict: 'Withholding'
};

// Confirm deck keys. One plain table; the handler in ingestScreens reads it.
export const DECK_KEYS = [
  ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((key) => ({ key, label: `Answer with option ${key}`, action: 'pick' })),
  { key: 'Enter', label: "Take Fathom's guess", action: 'guess' },
  { key: 'j', label: 'Next card', action: 'next' },
  { key: 'ArrowRight', label: 'Next card', action: 'next' },
  { key: 'k', label: 'Previous card', action: 'prev' },
  { key: 'ArrowLeft', label: 'Previous card', action: 'prev' },
  { key: 'z', label: 'Undo the last answer', action: 'undo' },
  { key: 'u', label: 'Undo the last answer', action: 'undo' },
  { key: 'Escape', label: 'Back to Home', action: 'leave' }
];

// The deck keys as keyboard registry rows (web/horizon/keys.js), one row per action in DECK_KEYS
// order, keys in normalizeKey form. run(actionName, event) does the work.
const DECK_LABEL = {
  pick: 'Answer with that option', guess: "Take Fathom's guess", next: 'Next card',
  prev: 'Previous card', undo: 'Undo the last answer', leave: 'Back to Home'
};
const active = () => (typeof document === 'undefined' ? null : document.activeElement);
const typing = (el) => !!el && (el.isContentEditable === true || /^(INPUT|TEXTAREA|SELECT)$/.test(String(el.tagName || '').toUpperCase()));
const DECK_WHEN = {
  // Enter on a focused button or link is its native activation.
  guess: { when: () => !active()?.closest?.('button,a[href]'), sheetWhen: () => true },
  // Escape closes an open More menu (the global row) and never leaves from a text field.
  leave: {
    when: () => !typing(active()) && !(typeof document !== 'undefined' && document.querySelector('.h-more-btn[aria-expanded="true"]')),
    sheetWhen: () => true
  }
};
export function deckBindings(run) {
  const rows = new Map();
  for (const { key, action } of DECK_KEYS) {
    if (!rows.has(action)) rows.set(action, { keys: [], label: DECK_LABEL[action], group: 'Confirm', ...DECK_WHEN[action], action: (e) => run(action, e) });
    rows.get(action).keys.push(key.length === 1 ? key : key.toLowerCase());
  }
  return [...rows.values()];
}

// Year banner copy: about five seconds per check, at least a minute.
export const quickCheckMinutes = (n) => Math.max(1, Math.ceil((n * 5) / 60));
export const quickChecksText = (n) => `${n} quick check${n === 1 ? '' : 's'}`;
export function minutesText(n) {
  const k = quickCheckMinutes(n);
  return `About ${k} minute${k === 1 ? '' : 's'}`;
}

const arr = (a) => (Array.isArray(a) ? a : []);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

// 'Nov 3, 2026' from an ISO date or timestamp; '' when there is none.
export function dateText(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m || +m[2] < 1 || +m[2] > 12) return '';
  return `${MON[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}

// '2 transactions, 1 duplicate skipped' from a file result's counts; 'No new rows' when nothing landed.
export function countsText(counts) {
  const c = counts && typeof counts === 'object' ? counts : {};
  const rows = c.rows && typeof c.rows === 'object' ? c.rows : {};
  const parts = ROWS.filter(([k]) => num(rows[k]) > 0).map(([k, w]) => plural(num(rows[k]), w));
  if (!parts.length) parts.push('No new rows');
  if (num(c.duplicates) > 0) parts.push(`${plural(num(c.duplicates), 'duplicate')} skipped`);
  if (num(c.revised) > 0) parts.push(`${num(c.revised)} revised`);
  if (num(c.superseded) > 0) parts.push(`${num(c.superseded)} superseded`);
  if (num(c.warnings) > 0) parts.push(plural(num(c.warnings), 'warning'));
  if (num(c.queued) > 0) parts.push(`${plural(num(c.queued), 'question')} to confirm`);
  return parts.join(', ');
}

const freshDeck = () => ({ units: [], members: {}, data: {}, answers: {}, sel: {}, hist: [], final: {}, cur: null, busy: null, busyIds: [], busyOpt: null, demo: null, notice: '' });

// Labels for stored account owner and type values (the confirm options' ids).
const OWNER_LABEL = { owner: 'You', spouse: 'Your spouse', joint: 'Joint', business: 'Business' };
const KIND_LABEL = {
  checking: 'Checking', cash: 'Savings or cash', card: 'Credit card', taxable: 'Taxable brokerage', retirement: 'Retirement',
  roth: 'Roth', hsa: 'HSA', 529: '529 plan', business: 'Business', loan: 'Loan'
};
// The question a group card asks of every row.
const GROUP_Q = {
  account_owner: 'Whose account is each of these?',
  account_kind: 'What type of account is each of these?'
};
// Why an answer Fathom recorded can no longer be undone, by finalReason code.
const FINAL_TEXT = {
  no_undo: 'This answer was recorded before answers could be changed, so it is final.',
  imported_since: 'A file was imported after this answer, so it is final.',
  changed_since: 'A later change builds on this answer, so it is final.',
  used_since: 'A later import used this answer, so it is final.',
  stale: 'A later import replaced this question, so it is final.'
};

// '$1,234.56' (cents only when the value has them, like the Engine screen), '-$12' for negatives;
// '' for a missing or non-numeric value.
export function cash(v) {
  if (v == null || v === '' || typeof v === 'boolean') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  const a = Math.abs(n);
  const [w, f] = (Number.isInteger(a) ? a.toFixed(0) : a.toFixed(2)).split('.');
  return `${n < 0 && a >= 0.005 ? '-' : ''}$${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}`;
}

// A stored value as plain text: lists joined, objects as JSON, booleans as Yes or No.
function valueText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(valueText).filter(Boolean).join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// Decided evidence is {text, basis, ancestors} or plain text.
const evidenceText = (e) => (typeof e === 'string' ? e : String((e && e.text) ?? ''));

const cadenceText = (c) => (c && typeof c === 'object' ? String(c.label || '') : String(c || ''));

export function ingestScreens(h) {
  const { api, shell, section, pageHead, btn, icon, esc, draw } = h;
  // Module state survives scenario re-renders (the design redraws the whole page on every change).
  const st = { busy: 0, results: null, retrying: {}, open: {}, rowOpen: {}, undoing: {}, decidedFinal: {}, deck: freshDeck() };
  const ing = () => api.ingest();

  function chip(state) {
    if (state === 'fresh') return '<span class="h-fresh fresh">Fresh</span>';
    if (state === 'stale') return '<span class="h-fresh stale">Stale</span>';
    return '';
  }

  function pendingBanner() {
    const n = num(ing().pending);
    if (n <= 0) return '';
    return `<div class="h-ing-banner">${icon('clock')}<span class="h-ing-banner-t"><b>${quickChecksText(n)}</b><span>${minutesText(n)}, so imported files land in the right place.</span></span><a class="h-btn pri h-ing-start" href="#/confirm" data-go="confirm">Start</a></div>`;
  }

  function fileRow(f) {
    const s = String(f.status || '');
    const summary = s === 'imported' || s === 'duplicate' ? countsText(f.counts) : '';
    return `<li class="${esc(s)}">${icon('doc')}<div class="h-ing-f"><div class="h-ing-f-h"><span class="h-ing-f-n">${esc(f.name)}</span><em>${esc(STATUS[s] || s)}</em></div>${summary ? `<p>${esc(summary)}</p>` : ''}</div></li>`;
  }

  function addFiles(context) {
    const onboarding = context === 'onboarding';
    const busy = st.busy > 0;
    const label = busy ? `Adding ${plural(st.busy, 'file')}` : `${icon('plus')}Add files`;
    let list = '';
    if (st.results) list = `<ul class="h-ing-files" aria-live="polite">${st.results.map(fileRow).join('')}</ul>`;
    else if (onboarding) {
      const files = arr(api.s?.onboarding?.files);
      if (files.length) list = `<ul class="h-files">${files.map((f) => `<li>${icon('doc')}<span>${esc(f.name)}</span><em>${esc(STATUS[f.status] || f.status)}</em></li>`).join('')}</ul>`;
    }
    const control = `<div class="h-ing-ctl">${btn(label, `data-upload-open="1"${busy ? ' disabled aria-busy="true"' : ''}`, onboarding ? 'ghost' : '')}
      <input type="file" multiple data-upload="1" hidden tabindex="-1"></div>`;
    if (onboarding) return `<div class="h-ing-add ob">${list}${control}</div>`;
    const lede = '<p class="h-mute sm">Exports from banks, cards, brokerages and payroll, profit and loss workbooks, statements and tax forms. Rows already imported are skipped.</p>';
    const wl = waitingList();
    return section('Add files', `<div class="h-ing-add">${lede}${control}${list}</div>`) + (wl ? section('Waiting files', wl) : '');
  }

  function accountMeta(a) {
    const g = (a && ing().accounts[a.id]) || {};
    const asOf = (a && a.asOf) || g.asOf || '';
    const fresh = (a && a.fresh) || g.fresh || 'unknown';
    const d = dateText(asOf);
    if (!d && fresh === 'unknown') return '';
    return `<div class="h-acc-f">${d ? `<span>Last data ${esc(d)}</span>` : ''}${chip(fresh)}</div>`;
  }

  function sourcesSection() {
    const g = ing();
    const srcs = g.sources.length
      ? `<ul class="h-srcs">${g.sources.map((s) => {
        const d = dateText(s.asOf);
        const cad = cadenceText(s.cadence);
        const meta = [d ? `Last data ${esc(d)}` : 'No dated rows', cad ? `Export ${esc(cad)}` : ''].filter(Boolean).join('<span class="h-dotsep"></span>');
        return `<li><div class="h-src-n"><b>${esc(s.label)}</b><span>${meta}</span></div>${chip(s.state)}</li>`;
      }).join('')}</ul>`
      : '<p class="h-mute">No files added yet.</p>';
    const fmts = g.formats.length
      ? section('How to export', `<div class="h-howto">${g.formats.map((f) => {
        const id = String(f.id ?? f.title ?? '');
        return `<details data-howto="${esc(id)}"${st.open[id] ? ' open' : ''}><summary>${icon('chev')}<span>${esc(f.title)}</span></summary>
          <ol>${arr(f.steps).map((x) => `<li>${esc(x)}</li>`).join('')}</ol>${f.cadence ? `<p class="h-mute sm">How often: ${esc(cadenceText(f.cadence))}</p>` : ''}</details>`;
      }).join('')}</div>`)
      : '';
    return section('Sources', srcs, g.sources.length ? plural(g.sources.length, 'source') : '') + fmts;
  }

  // Files that need a mapping or the engine; '' when none. Shared by Confirm and Accounts.
  function waitingList() {
    const waiting = ing().waiting;
    if (!waiting.length) return '';
    return `<ul class="h-ing-files">${waiting.map((f) => `<li class="${esc(f.status)}">${icon('doc')}<div class="h-ing-f"><div class="h-ing-f-h"><span class="h-ing-f-n">${esc(f.name)}</span><em>${esc(STATUS[f.status] || f.status)}</em></div></div>${btn(st.retrying[f.id] ? 'Retrying' : 'Retry', `data-retry="${esc(f.id)}"${st.retrying[f.id] ? ' disabled' : ''}`, 'ghost')}</li>`).join('')}</ul>`;
  }

  /* ---------- Confirm deck ----------
     The deck walks units in server order (impact rank, then id). A unit is one item, keyed by its
     id, or a group card keyed 'g:<group>' when two or more pending items share a group. Session
     state lives in st.deck: units in session order, the item ids of each group card, item data
     cached so answered cards can be revisited, answers {id: optionId}, local row selections
     {id: optionId}, the undo history (each entry an array of item ids, so a group apply undoes as
     one) and final notices {id: message}. cur is the current unit key, or null for the All caught
     up end state. busy is the unit key in flight and busyIds the item ids it carries. */

  const STALE_LINE = 'This one changed while you were answering; refreshed.';
  const pendingNow = () => ing().items.filter((i) => !i.status || i.status === 'pending');
  const pendingIds = () => new Set(pendingNow().map((i) => String(i.id)));
  const isGroup = (key) => String(key).startsWith('g:');
  const itemsOf = (dk, key) => (isGroup(key) ? (dk.members[key] || []) : [key]);
  const inFlight = (dk, id) => dk.busyIds.includes(id);
  const unanswered = (dk, id) => dk.answers[id] == null && dk.busy !== id;
  const unitOpen = (dk, key) => (isGroup(key) ? dk.busy !== key && itemsOf(dk, key).some((id) => dk.answers[id] == null) : unanswered(dk, key));
  const unitDone = (dk, key) => itemsOf(dk, key).every((id) => dk.answers[id] != null);
  const unitOf = (dk, id) => Object.keys(dk.members).find((g) => dk.members[g].includes(id)) ?? id;
  const known = (dk, id) => dk.units.includes(id) || Object.values(dk.members).some((m) => m.includes(id));

  function syncDeck(entering) {
    let dk = st.deck;
    const pend = pendingNow();
    const pset = new Set(pend.map((i) => String(i.id)));
    if (dk.demo !== api.demo() || (entering && !pend.some((i) => known(dk, String(i.id))))) {
      dk = st.deck = freshDeck();
      dk.demo = api.demo();
    }
    pend.forEach((i) => { dk.data[String(i.id)] = i; });
    // Pending again after an answer from this session (reopened elsewhere): forget that answer.
    for (const id of pset) if (known(dk, id) && dk.answers[id] != null && !inFlight(dk, id)) dropAnswer(dk, id);
    // New items in server order. A group gets one card when two or more of its items are open:
    // the new ones plus a lone open card of that group already in the session.
    const fresh = pend.filter((i) => !known(dk, String(i.id)));
    const added = [];
    for (const i of fresh) {
      const id = String(i.id);
      const g = i.group ? `g:${i.group}` : null;
      if (g && dk.units.includes(g)) {
        dk.members[g].push(id);
        added.push(g);
        continue;
      }
      if (g) {
        const loners = dk.units.filter((k) => !isGroup(k) && dk.data[k]?.group === i.group && pset.has(k) && unanswered(dk, k));
        const peers = fresh.filter((x) => x.group === i.group);
        if (loners.length + peers.length >= 2) {
          const at = loners.length ? dk.units.indexOf(loners[0]) : dk.units.length;
          dk.units = dk.units.filter((k) => !loners.includes(k));
          dk.units.splice(Math.min(at, dk.units.length), 0, g);
          dk.members[g] = [...loners, id];
          if (loners.includes(dk.cur)) dk.cur = g;
          added.push(g);
          continue;
        }
      }
      dk.units.push(id);
      added.push(id);
    }
    // Drop items that left the queue without an answer from this session (answered elsewhere or
    // by Fathom), and group cards with no rows left.
    const keep = (id) => pset.has(id) || dk.answers[id] != null || inFlight(dk, id);
    const old = dk.units.slice();
    for (const g of Object.keys(dk.members)) dk.members[g] = dk.members[g].filter(keep);
    dk.units = dk.units.filter((k) => (isGroup(k) ? dk.members[k].length > 0 : keep(k)));
    for (const g of Object.keys(dk.members)) if (!dk.units.includes(g)) delete dk.members[g];
    // A group card needs two or more items in the session; a lone one becomes an ordinary item card.
    for (const g of Object.keys(dk.members)) {
      if (dk.members[g].length !== 1 || dk.busy === g) continue;
      const only = dk.members[g][0];
      dk.units[dk.units.indexOf(g)] = only;
      if (dk.cur === g) dk.cur = only;
      old[old.indexOf(g)] = only;
      delete dk.members[g];
    }
    if (dk.cur != null && !dk.units.includes(dk.cur)) {
      const after = old.slice(old.indexOf(dk.cur) + 1).find((k) => dk.units.includes(k));
      dk.cur = after ?? null;
      if (dk.cur != null && !unitOpen(dk, dk.cur)) dk.cur = nextOpen(dk, dk.cur);
    }
    if (dk.cur == null && added.length) dk.cur = added[0];
    return dk;
  }

  // The undo history without the given item ids, dropping entries left empty.
  const histWithout = (dk, ids) => dk.hist.map((e) => e.filter((x) => !ids.includes(x))).filter((e) => e.length);

  function dropAnswer(dk, id) {
    delete dk.answers[id];
    delete dk.final[id];
    dk.hist = histWithout(dk, [id]);
  }

  // The next open unit after `key` in session order, wrapping; null when every unit is answered.
  function nextOpen(dk, key) {
    const at = dk.units.indexOf(key);
    const order = [...dk.units.slice(at + 1), ...dk.units.slice(0, Math.max(0, at))];
    return order.find((x) => unitOpen(dk, x)) ?? null;
  }

  const undoTarget = (dk) => [...dk.hist].reverse().find((e) => e.some((id) => !dk.final[id])) ?? null;

  function guessOf(it) {
    const g = it && it.guess;
    if (!g || g.option == null) return null;
    const o = arr(it.options).find((x) => String(x.id) === String(g.option));
    return o ? { option: String(o.id), label: o.label, evidence: String(g.evidence ?? g.reason ?? '') } : null;
  }

  // A group row's current selection: the owner's pick on the row, else the best guess.
  function selection(dk, id) {
    if (dk.sel[id] != null) return dk.sel[id];
    return guessOf(dk.data[id])?.option ?? null;
  }

  /* ---------- card context: account view, compare table, values list ---------- */

  const none = '<span class="h-cf-none">Not given</span>';
  const guessTag = '<span class="h-cf-best">Best guess</span>';
  const guessLine = (g) => `Best guess: <b>${esc(g.label)}</b>.${g.evidence ? ` <span class="h-cf-why">${esc(g.evidence)}</span>` : ''}`;

  function rangeText(from, to) {
    const a = dateText(from) || (from ? String(from) : '');
    const b = dateText(to) || (to ? String(to) : '');
    if (a && b) return a === b ? a : `${a} to ${b}`;
    return a || b;
  }

  function rowsText(r) {
    const c = r && typeof r === 'object' ? r : {};
    const parts = [['transactions', 'transaction'], ['balances', 'balance'], ['positions', 'position']]
      .filter(([k]) => num(c[k]) > 0).map(([k, w]) => plural(num(c[k]), w));
    return parts.length ? parts.join(', ') : 'No rows yet';
  }

  // '$1,234.56 on Oct 31, 2026, from file.csv' with the amount in <b>; '' when there is none.
  // fileName names every contributing file.
  function balanceHtml(b, split) {
    if (!b || typeof b !== 'object' || cash(b.amount) === '') return '';
    const when = [dateText(b.date), b.fileName ? `from ${esc(b.fileName)}` : ''].filter(Boolean);
    const basis = b.basis === 'holdings' ? ' (sum of holdings)' : '';
    if (split) return `<b>${esc(cash(b.amount))}</b>${basis}${when.length ? `<span>${when.join(', ')}</span>` : ''}`;
    return `<b>${esc(cash(b.amount))}</b>${basis}${when.length ? ` on ${when.join(', ')}` : ''}`;
  }

  const filesHtml = (files) => (arr(files).length
    ? arr(files).map((f) => `<span class="h-cf-file">${esc(f && typeof f === 'object' ? f.name : f)}</span>`).join('')
    : none);

  // A View field as cell HTML; '' when it has no value.
  function viewCell(v, f) {
    switch (f) {
      case 'institution': return v.institution ? esc(v.institution) : '';
      case 'name': return v.name ? esc(v.name) : '';
      case 'mask': return v.mask ? esc(v.mask) : '';
      case 'holder': return v.holder ? esc(v.holder) : '';
      case 'owner': return v.owner ? esc(OWNER_LABEL[v.owner] || v.owner) : '';
      case 'kind': return v.kind ? esc(KIND_LABEL[v.kind] || v.kind) : '';
      case 'balance': return balanceHtml(v.balance);
      case 'range': return esc(rangeText(v.from, v.to));
      case 'rows': return esc(rowsText(v.rows));
      case 'files': return arr(v.files).length ? filesHtml(v.files) : '';
      default: return '';
    }
  }

  const ACCT_FIELDS = [
    ['name', 'Account'], ['institution', 'Institution'], ['mask', 'Ends in'], ['holder', 'Holder in the source'],
    ['owner', 'Owner'], ['kind', 'Type'], ['balance', 'Latest balance'], ['range', 'Dates'], ['rows', 'Rows'], ['files', 'Files']
  ];
  // differs names View fields; the range cell covers from and to.
  const differsSet = (d) => {
    const s = new Set(arr(d && d.differs).map(String));
    if (s.has('from') || s.has('to')) s.add('range');
    return s;
  };
  const mark = (s, f) => (s.has(f) ? ' data-differs="1"' : '');

  function acctPanel(v, d) {
    if (!v) return '';
    const diff = differsSet(d);
    const cells = ACCT_FIELDS.map(([f, label]) => {
      const html = viewCell(v, f);
      // Owner and type show only once they are known; every other field always shows.
      if (!html && (f === 'owner' || f === 'kind')) return '';
      const val = html || (f === 'holder' ? 'Not in the source' : f === 'balance' ? 'No balance yet' : 'Not given');
      return `<div data-field="${f}"${mark(diff, f)}><dt>${label}</dt>
<dd>${html ? val : `<span class="h-cf-none">${val}</span>`}</dd></div>`;
    }).join('');
    const recent = recentList(v.recent, 'Recent transactions');
    return `<div class="h-cf-acct"><dl>${cells}</dl>${recent}</div>`;
  }

  // Newest rows as a list, each with its file; fileName overrides a row's own (SimpleFIN rows).
  function recentList(rows, label, fileName) {
    if (!arr(rows).length) return '';
    return `<p class="h-cf-sub">${esc(label)}</p><ul class="h-cf-recent">${arr(rows).map((r) => `<li><span class="d">${esc(dateText(r.date) || r.date || '')}</span><span class="t">${esc(r.description || '')}</span><span class="a">${esc(cash(r.amount))}</span><span class="f">${esc(fileName || r.fileName || '')}</span></li>`).join('')}</ul>`;
  }

  const SAME_COLS = [
    ['institution', 'Institution'], ['mask', 'Ends in'], ['holder', 'Holder'], ['owner', 'Owner'], ['kind', 'Type'],
    ['balance', 'Latest balance'], ['range', 'Dates'], ['files', 'Files']
  ];

  // The account and its same-named accounts side by side, one row each; differing cells marked.
  function sameTable(v, d) {
    const others = arr(d && d.sameName);
    if (!v || !others.length) return '';
    const diff = differsSet(d);
    const all = [v, ...others];
    const cols = SAME_COLS.filter(([f]) => diff.has(f) || all.some((x) => viewCell(x, f)));
    const head = `<tr><th scope="col">Account</th>${cols.map(([, l]) => `<th scope="col">${l}</th>`).join('')}</tr>`;
    const rows = all.map((x, i) => `<tr data-account="${esc(x.id)}"${i ? '' : ' class="me"'}><th scope="row">${i ? 'Other' : 'This one'}</th>${cols.map(([f]) => {
      const html = viewCell(x, f);
      return `<td data-field="${f}"${mark(diff, f)}>${html || none}</td>`;
    }).join('')}</tr>`).join('');
    const n = others.length;
    return `<p class="h-cf-sub">${plural(n, 'other account')} named ${esc(v.name || 'the same')}.${diff.size ? ' Marked cells differ.' : ''}</p>
      <div class="h-cf-scroll"><table class="h-cf-same"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
  }

  const COMPARE_LABEL = {
    date: 'Date', amount: 'Amount', description: 'Description', account: 'Account', file: 'File', payer: 'Payer',
    jurisdiction: 'Jurisdiction', taxYear: 'Tax year', recipient: 'Recipient', institution: 'Institution', name: 'Name',
    mask: 'Ends in', balance: 'Balance', balanceDate: 'Balance date', from: 'First date', to: 'Last date', count: 'Transactions'
  };

  function compareCell(f, v) {
    if (v == null || v === '') return none;
    if (f === 'amount' || f === 'balance') return esc(cash(v) || String(v));
    if (f === 'date' || f === 'balanceDate' || f === 'from' || f === 'to') return esc(dateText(v) || String(v));
    return esc(valueText(v));
  }

  function compareTable(d, it) {
    const entries = arr(d.entries);
    if (!entries.length) return '';
    const diff = new Set(arr(d.differs).map(String));
    const heads = entries.map((_, i) => (it.kind === 'account_match' ? (i === 0 ? 'Imported' : 'SimpleFIN') : `Entry ${i + 1}`));
    const head = `<tr><th scope="col"><span class="h-cf-sr">Field</span></th>${heads.map((h) => `<th scope="col">${h}</th>`).join('')}</tr>`;
    const rows = arr(d.fields).map((f) => `<tr data-field="${esc(f)}"${diff.has(String(f)) ? ' data-differs="1"' : ''}><th scope="row">${esc(COMPARE_LABEL[f] || f)}</th>${entries.map((e) => `<td>${compareCell(f, e && e[f])}</td>`).join('')}</tr>`).join('');
    return `<div class="h-cf-scroll"><table class="h-cf-compare"><thead>${head}</thead><tbody>${rows}</tbody></table></div>${diff.size ? '<p class="h-cf-sub">Marked rows differ.</p>' : ''}`;
  }

  // account_match: the imported candidate's own panel and same-named accounts (no differs marks:
  // the card's differs belong to the compare table), then the SimpleFIN snapshot's newest rows.
  function matchContext(d, it) {
    if (it.kind !== 'account_match') return '';
    const v = d.account && typeof d.account === 'object' ? d.account : null;
    const same = { sameName: d.sameName };
    const panel = v ? `<p class="h-cf-sub">Imported account</p>${acctPanel(v, same)}${sameTable(v, same)}` : '';
    const snap = d.snapshot && typeof d.snapshot === 'object' ? d.snapshot : {};
    return panel + recentList(snap.recent, 'Recent transactions in SimpleFIN', 'SimpleFIN');
  }

  function valuesList(d) {
    const rows = arr(d.values).map((v) => `<div><dt>${esc(v.label)}</dt>
<dd>${v.value == null || v.value === '' ? none : esc(valueText(v.value))}</dd></div>`);
    if (d.file && d.file.name) rows.push(`<div data-field="file"><dt>File</dt>
<dd>${esc(d.file.name)}</dd></div>`);
    return rows.length ? `<dl class="h-cf-values">${rows.join('')}</dl>` : '';
  }

  function detailHtml(it) {
    const d = it && it.detail;
    if (!d || typeof d !== 'object') return '';
    let body = '';
    if (d.type === 'account') body = acctPanel(d.account, d) + sameTable(d.account, d);
    else if (d.type === 'compare') body = compareTable(d, it) + matchContext(d, it);
    else if (d.type === 'values') body = valuesList(d);
    return body ? `<div class="h-cf-detail">${body}</div>` : '';
  }

  /* ---------- cards ---------- */

  function cardHtml(dk, id, fileName) {
    const it = dk.data[id];
    const fin = dk.final[id];
    const busy = dk.busy === id;
    const chosen = busy && dk.busyOpt != null ? dk.busyOpt : dk.answers[id];
    const g = guessOf(it);
    const opts = arr(it.options).map((o, n) => {
      const on = chosen != null && String(chosen) === String(o.id);
      const isG = !!g && g.option === String(o.id);
      const attrs = `data-answer="${esc(id)}" data-option="${esc(o.id)}" aria-pressed="${on}"${isG ? ' data-guess="1"' : ''}${busy || fin ? ' disabled' : ''}`;
      return btn(`<span class="h-deck-n">${n + 1}</span> · ${esc(o.label)}${isG ? guessTag : ''}`, attrs, on ? 'pri' : (isG && chosen == null ? 'guess' : ''));
    }).join('');
    const short = arr(it.options).every((o) => String(o.label ?? '').length <= 24);
    const name = it.fileName || fileName || '';
    const take = g && !fin && String(chosen ?? '') !== g.option
      ? btn('Use best guess', `data-take-guess="${esc(id)}"${busy ? ' disabled' : ''}`, 'pri h-cf-take')
      : '';
    const guess = g ? `<div class="h-cf-gl"><p class="h-cf-guess">${guessLine(g)}</p>${take}</div>` : '';
    const state = fin
      ? `<p class="h-cf-final" role="status">${esc(fin)}</p>`
      : (dk.answers[id] != null && !busy ? '<p class="h-deck-state">Answered. Pick another option to change it.</p>' : '');
    return `<article class="h-deck-card cur${fin ? ' final' : ''}" data-item="${esc(id)}">
      <div class="h-cf-k">${esc(KIND[it.kind] || 'Question')}${name ? `<span>${esc(name)}</span>` : ''}</div>
      <p class="h-cf-q">${esc(it.question)}</p>${detailHtml(it)}${guess}<div class="h-deck-opts${short ? ' short' : ''}">${opts}</div>${state}</article>`;
  }

  function rowHtml(dk, key, id) {
    const it = dk.data[id];
    const d = (it && it.detail) || {};
    const v = d.type === 'account' && d.account ? d.account : null;
    const busy = dk.busy === key;
    const answered = dk.answers[id] != null;
    const fin = dk.final[id];
    const pick = answered ? dk.answers[id] : selection(dk, id);
    const g = guessOf(it);
    const opts = arr(it.options).map((o) => {
      const on = pick != null && String(pick) === String(o.id);
      const isG = !!g && g.option === String(o.id);
      const attrs = `data-row-answer="${esc(id)}" data-option="${esc(o.id)}" aria-pressed="${on}"${isG ? ' data-guess="1"' : ''}${busy || answered || fin ? ' disabled' : ''}`;
      return btn(`${esc(o.label)}${isG ? guessTag : ''}`, attrs, on ? 'pri' : '');
    }).join('');
    const others = arr(d.sameName).length;
    const flag = others ? `<span class="h-cf-flag">Same name as ${plural(others, 'other account')}</span>` : '';
    const where = v ? [v.institution ? esc(v.institution) : '', v.mask ? `ending ${esc(v.mask)}` : ''].filter(Boolean).join(', ') : '';
    const acct = `<td data-col="account"><b>${esc(v ? (v.name || 'Unnamed account') : it.question)}</b>${flag}${where ? `<span>${where}</span>` : ''}</td>`;
    const holder = `<td data-col="holder" data-l="Holder">${v && v.holder ? esc(v.holder) : '<span class="h-cf-none">Not in the source</span>'}</td>`;
    const bal = `<td data-col="balance" data-l="Latest balance">${(v && balanceHtml(v.balance, true)) || '<span class="h-cf-none">No balance yet</span>'}</td>`;
    const range = `<td data-col="range" data-l="Dates">${(v && esc(rangeText(v.from, v.to))) || '<span class="h-cf-none">No dated rows</span>'}</td>`;
    const why = g && !answered ? `<p class="h-cf-rwhy">${guessLine(g)}</p>` : '';
    const state = fin ? `<p class="h-cf-rstate">${esc(fin)}</p>` : (answered ? '<p class="h-cf-rstate">Answered. Undo to change it.</p>' : '');
    const ans = `<td class="h-cf-ans"><div class="h-cf-ropts" role="group" aria-label="${esc(v ? v.name || 'Account' : 'Answer')}">${opts}</div>${why}${state}</td>`;
    const det = v
      ? `<td class="h-cf-gx"><details data-row-detail="${esc(id)}"${st.rowOpen[id] ? ' open' : ''}><summary>${icon('chev')}<span>Account detail</span></summary>${acctPanel(v, d)}${sameTable(v, d)}</details></td>`
      : '';
    return `<tr data-row="${esc(id)}"${others ? ' data-same="1"' : ''}${answered ? ' class="done"' : ''}>${acct}${holder}${bal}${range}${ans}${det}</tr>`;
  }

  function groupHtml(dk, key) {
    const kind = key.slice(2);
    const ids = itemsOf(dk, key);
    const busy = dk.busy === key;
    const pend = pendingIds();
    const open = ids.filter((id) => dk.answers[id] == null && !dk.final[id]);
    const ready = open.filter((id) => pend.has(id) && selection(dk, id) != null);
    const head = '<thead><tr><th scope="col">Account</th><th scope="col">Holder</th><th scope="col">Latest balance</th><th scope="col">Dates</th><th scope="col"><span class="h-cf-sr">Answer</span></th></tr></thead>';
    const rows = ids.map((id) => rowHtml(dk, key, id)).join('');
    const finals = [...new Set(ids.map((id) => dk.final[id]).filter(Boolean))];
    const note = open.length
      ? `${ready.length} of ${plural(open.length, 'account')} selected.${ready.length < open.length ? ' Rows with no selection stay for later.' : ''}`
      : 'Every row here is answered. Undo puts them back.';
    const foot = `<div class="h-cf-gfoot"><p>${note}</p>${btn('Use best guesses for all', `data-group-apply="${esc(key)}"${busy || !ready.length ? ' disabled' : ''}`, 'pri')}</div>`;
    const state = finals.map((f) => `<p class="h-cf-final" role="status">${esc(f)}</p>`).join('');
    return `<article class="h-deck-card cur group" data-group="${esc(kind)}">
      <div class="h-cf-k">${esc(KIND[kind] || 'Questions')}<span>${plural(ids.length, 'account')}</span></div>
      <p class="h-cf-q">${esc(GROUP_Q[kind] || 'Answer each row.')}</p>
      <table class="h-cf-group">${head}<tbody>${rows}</tbody></table>${foot}${state}</article>`;
  }

  function decidedSection() {
    const list = ing().decided;
    if (!list.length) return '';
    const items = list.map((d) => {
      const id = String(d.id);
      const fin = d.final ? (FINAL_TEXT[d.final] || String(d.final)) : st.decidedFinal[id];
      const ctl = fin
        ? `<p class="h-decided-final">${esc(fin)}</p>`
        : btn('Undo', `data-decided-undo="${esc(id)}"${st.undoing[id] ? ' disabled' : ''}`, 'ghost');
      const ev = evidenceText(d.evidence);
      return `<li data-decided="${esc(id)}"><div class="h-decided-b"><span class="h-decided-k">${esc(KIND[d.kind] || 'Question')}</span>
        <p class="h-decided-q">${esc(d.question)}</p><p class="h-decided-a">Answer: <b>${esc(d.answerLabel || d.answer || '')}</b></p>${ev ? `<p class="h-decided-e">${esc(ev)}</p>` : ''}</div>${ctl}</li>`;
    }).join('');
    const lede = '<p class="h-mute sm">Fathom answered these from your files and your own answers. Undo puts one back in the deck, and Fathom will not answer it again.</p>';
    return section('Decided for you', `${lede}<ul class="h-decided-l">${items}</ul>`, plural(list.length, 'answer'), 'h-decided');
  }

  function confirmPage(entering) {
    const dk = syncDeck(entering);
    const files = new Map(ing().files.map((f) => [String(f.id), f.name]));
    const n = dk.units.length;
    const caught = (line) => `<div class="h-empty"><i class="h-ok sm">${icon('check')}</i><div><b>All caught up</b><p>${line}</p></div></div>`;
    let deck;
    if (!n) deck = `<div class="h-deck">${caught('New questions show up here when an import needs one.')}</div>`;
    else {
      const at = dk.cur == null ? n : dk.units.indexOf(dk.cur);
      const done = dk.units.filter((k) => unitDone(dk, k)).length;
      const canUndo = dk.busy == null && undoTarget(dk) != null;
      const note = dk.notice ? `<p class="h-deck-notice" role="status">${esc(dk.notice)}</p>` : '';
      const top = `<div class="h-deck-top"><span class="h-deck-pos" data-deck-progress>${Math.min(at + 1, n)} of ${n}</span>
        <div class="h-deck-bar" role="progressbar" aria-label="Answered" aria-valuemin="0" aria-valuemax="${n}" aria-valuenow="${done}"><i style="width:${Math.round((done / n) * 100)}%"></i></div>
        ${btn('Undo', `data-deck="undo"${canUndo ? '' : ' disabled'}`, 'ghost')}</div>`;
      let stack;
      if (dk.cur == null) stack = caught('Every question here is answered. Prev goes back to the last card.');
      else {
        const peeks = dk.units.slice(at + 1, at + 3).map((_, i) => `<div class="h-deck-peek p${i + 1}" aria-hidden="true"></div>`).reverse().join('');
        const card = isGroup(dk.cur) ? groupHtml(dk, dk.cur) : cardHtml(dk, dk.cur, files.get(String(dk.data[dk.cur].fileId)));
        stack = `<div class="h-deck-stack${peeks ? ` n${Math.min(2, n - at - 1)}` : ''}">${peeks}${card}</div>`;
      }
      const allDone = !dk.units.some((k) => unitOpen(dk, k));
      const canNext = dk.cur != null && (at < n - 1 || allDone);
      const hint = '<p class="h-deck-hint"><span class="kb">1 to 9 answer, Enter takes the best guess, J and K move, Z undoes, Esc goes to Year, ? for all shortcuts</span><span class="tch">Swipe right for the next card, left for the previous one</span></p>';
      const nav = `<div class="h-deck-nav">${btn('← Prev', `data-deck="prev"${at > 0 ? '' : ' disabled'}`, 'ghost')}${hint}${btn('Next →', `data-deck="next"${canNext ? '' : ' disabled'}`, 'ghost')}</div>`;
      deck = `<div class="h-deck">${top}${note}${stack}${nav}</div>`;
    }
    const wait = waitingList() || '<p class="h-mute">No files are waiting.</p>';
    return shell(`${pageHead('Household', 'Confirm', 'A few short questions so imports land in the right place.')}
      <div class="h-cols"><div class="h-col-main">${deck}${decidedSection()}</div>
      <div class="h-col-side">${section('Waiting files', wait)}</div></div>`, 'confirm');
  }

  // Move by d units. Next past the last unit reaches All caught up only when nothing is left open.
  function move(d) {
    const dk = st.deck;
    const n = dk.units.length;
    if (!n) return false;
    const at = dk.cur == null ? n : dk.units.indexOf(dk.cur);
    const to = at + d;
    if (to < 0 || to > n) return false;
    if (to === n) {
      if (dk.cur == null || dk.units.some((k) => unitOpen(dk, k))) return false;
      dk.cur = null;
    } else dk.cur = dk.units[to];
    draw();
    return true;
  }

  // Answer (or revise) single card `id` with `opt`, then move to the next open unit.
  function pick(id, opt) {
    const dk = st.deck;
    const it = dk.data[id];
    if (dk.busy != null || isGroup(id) || dk.final[id] || !it || !arr(it.options).some((o) => String(o.id) === String(opt))) return false;
    if (dk.answers[id] != null && String(dk.answers[id]) === String(opt)) {
      if (dk.cur === id) { dk.cur = nextOpen(dk, id); draw(); }
      return true;
    }
    const revise = !pendingNow().some((i) => String(i.id) === id);
    dk.busy = id;
    dk.busyIds = [id];
    dk.busyOpt = String(opt);
    draw();
    dk.notice = '';
    const req = revise ? api.reviseAnswer(id, opt) : api.answer(id, opt);
    req.then((r) => {
      dk.busy = null;
      dk.busyIds = [];
      dk.busyOpt = null;
      if (st.deck === dk && r) {
        if (r.stale) {
          // The question changed while it was being answered: the scenario was refetched, so move on.
          dk.notice = STALE_LINE;
          if (dk.cur === id) dk.cur = nextOpen(dk, id);
          syncDeck(false);
        } else if (r.final) {
          dk.final[id] = r.final;
          dk.hist = histWithout(dk, [id]);
        } else {
          dk.answers[id] = String(opt);
          dk.hist = [...histWithout(dk, [id]), [id]];
          if (dk.cur === id) dk.cur = nextOpen(dk, id);
        }
      }
      draw();
    });
    return true;
  }

  // Select an option on a group row. Local only: nothing is sent until the group is applied.
  function select(id, opt) {
    const dk = st.deck;
    const it = dk.data[id];
    if (dk.busy != null || dk.answers[id] != null || dk.final[id] || !it || !arr(it.options).some((o) => String(o.id) === String(opt))) return false;
    dk.sel[id] = String(opt);
    draw();
    return true;
  }

  // Answer every open row of group card `key` that has a selection (the owner's pick or the best
  // guess) in one request. Rows with no selection stay open.
  function apply(key) {
    const dk = st.deck;
    if (dk.busy != null || !isGroup(key) || !dk.units.includes(key)) return false;
    const pend = pendingIds();
    const list = itemsOf(dk, key)
      .filter((id) => dk.answers[id] == null && !dk.final[id] && pend.has(id))
      .map((id) => ({ id, answer: selection(dk, id) }))
      .filter((x) => x.answer != null);
    if (!list.length) return false;
    const ids = list.map((x) => x.id);
    dk.busy = key;
    dk.busyIds = ids;
    dk.notice = '';
    draw();
    api.answerMany(list).then((r) => {
      dk.busy = null;
      dk.busyIds = [];
      if (st.deck === dk && r) {
        if (r.stale) {
          dk.notice = STALE_LINE;
          syncDeck(false);
        } else if (r.final) {
          dk.notice = r.final;
        } else {
          list.forEach((x) => { dk.answers[x.id] = String(x.answer); delete dk.sel[x.id]; });
          dk.hist = [...histWithout(dk, ids), ids];
          syncDeck(false);
          if (dk.cur === key && !unitOpen(dk, key)) dk.cur = nextOpen(dk, key);
        }
      }
      draw();
    });
    return true;
  }

  // Reopen the most recent non-final answer entry of this session (one card, or a whole group
  // apply) and move to its card.
  function undo() {
    const dk = st.deck;
    const entry = dk.busy == null ? undoTarget(dk) : null;
    if (entry == null) return false;
    const key = unitOf(dk, entry[0]);
    dk.busy = key;
    dk.busyIds = [...entry];
    draw();
    const req = isGroup(key) ? api.reopenMany(entry) : api.reopenAnswer(entry[0]);
    req.then((r) => {
      dk.busy = null;
      dk.busyIds = [];
      if (st.deck === dk && r) {
        if (r.final) {
          entry.forEach((id) => { dk.final[id] = r.final; });
          dk.hist = dk.hist.filter((e) => e !== entry);
        } else if (r.stale) {
          dk.notice = STALE_LINE;
        } else entry.forEach((id) => dropAnswer(dk, id));
        syncDeck(false);
        if (dk.units.includes(key)) dk.cur = key;
      }
      draw();
    });
    return true;
  }

  // Undo an answer Fathom recorded itself (the Decided for you list).
  function undoDecided(id) {
    if (st.undoing[id]) return;
    st.undoing[id] = true;
    draw();
    api.reopenAnswer(id).then((r) => {
      delete st.undoing[id];
      if (r && r.final) st.decidedFinal[id] = r.final;
      draw();
    });
  }

  // Runs a deck action from the key registry (rows from deckBindings). Held keys never repeat an answer or an undo.
  function deckAction(action, e) {
    if (api.route?.name !== 'confirm') return false;
    const dk = st.deck;
    const group = dk.cur != null && isGroup(dk.cur);
    const cur = dk.cur != null && !group ? dk.data[dk.cur] : null;
    if (e?.repeat && ['pick', 'guess', 'undo'].includes(action)) return true;
    switch (action) {
      case 'pick': {
        const o = cur && arr(cur.options)[Number(e?.key) - 1];
        return o ? pick(dk.cur, o.id) : false;
      }
      case 'guess': {
        if (group) return apply(dk.cur);
        const g = guessOf(cur);
        return g ? pick(dk.cur, g.option) : false;
      }
      case 'next': return move(1) || true;
      case 'prev': return move(-1) || true;
      case 'undo': return undo() || true;
      case 'leave': api.go('home'); return true;
      default: return false;
    }
  }

  // Touch and pen swipes on the current card: it follows the finger, swipe right goes to the next
  // card, left to the previous one, and a short drag springs back. A swipe never answers, and a drag
  // that starts on a control, a detail toggle or a scrolling table is left to it.
  const handlePointer = createSwipe({
    when: () => api.route?.name === 'confirm',
    card: 'article.h-deck-card.cur',
    ignore: 'button,a,input,textarea,select,summary,.h-cf-scroll',
    onSwipe: (dir) => move(dir)
  });

  function upload(input) {
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length || st.busy) return;
    st.busy = files.length;
    draw();
    api.upload(files).then((res) => {
      st.busy = 0;
      if (res && Array.isArray(res.files)) st.results = res.files;
      draw();
    });
  }

  function handleClick(e) {
    const t = e.target.closest?.('[data-upload-open],[data-answer],[data-row-answer],[data-group-apply],[data-take-guess],[data-decided-undo],[data-deck],[data-retry],details[data-howto] > summary,details[data-row-detail] > summary');
    if (!t) return false;
    if (t.tagName === 'SUMMARY') {
      // The native toggle runs; the open state is kept so a redraw does not close it.
      const d = t.parentElement;
      if (d.dataset.rowDetail) st.rowOpen[d.dataset.rowDetail] = !d.open;
      else st.open[d.dataset.howto] = !d.open;
      return true;
    }
    e.preventDefault();
    const d = t.dataset;
    if (d.uploadOpen) {
      if (!st.busy) t.parentElement.querySelector('input[type=file][data-upload]')?.click();
      return true;
    }
    if (d.answer) {
      pick(d.answer, d.option);
      return true;
    }
    if (d.rowAnswer) {
      if (select(d.rowAnswer, d.option)) {
        t.ownerDocument.querySelector(`[data-row-answer="${CSS.escape(d.rowAnswer)}"][data-option="${CSS.escape(d.option)}"]`)?.focus();
      }
      return true;
    }
    if (d.groupApply) {
      apply(d.groupApply);
      return true;
    }
    if (d.takeGuess) {
      const g = guessOf(st.deck.data[d.takeGuess]);
      if (g) pick(d.takeGuess, g.option);
      return true;
    }
    if (d.decidedUndo) {
      undoDecided(d.decidedUndo);
      return true;
    }
    if (d.deck) {
      if (d.deck === 'undo') undo();
      else move(d.deck === 'next' ? 1 : -1);
      t.ownerDocument.querySelector(`[data-deck="${d.deck}"]:not([disabled])`)?.focus();
      return true;
    }
    if (d.retry) {
      if (st.retrying[d.retry]) return true;
      const id = d.retry;
      st.retrying[id] = true;
      draw();
      api.retryFile(id).then(() => { delete st.retrying[id]; draw(); });
      return true;
    }
    return false;
  }

  // The file input fires both input and change; only change uploads, input is swallowed.
  function handleChange(e) {
    const t = e.target;
    if (!t?.matches?.('input[type=file][data-upload]')) return false;
    if (e.type === 'change') upload(t);
    return true;
  }

  return { confirmPage, pendingBanner, addFiles, accountMeta, sourcesSection, handleClick, handleChange, deckAction, handlePointer };
}
