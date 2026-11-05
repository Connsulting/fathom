/* Horizon ingest screens: Add files, per-file results, the Confirm deck, the pending banner,
   account freshness and the Sources list. Text from the server (file names, questions, option
   labels, guess reasons, source labels) is plain text and always goes through esc(), never token
   resolution. */

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
  { key: 'Escape', label: 'Back to Year', action: 'leave' }
];

// The deck keys as keyboard registry rows (web/horizon/keys.js), one row per action in DECK_KEYS
// order, keys in normalizeKey form. run(actionName, event) does the work.
const DECK_LABEL = {
  pick: 'Answer with that option', guess: "Take Fathom's guess", next: 'Next card',
  prev: 'Previous card', undo: 'Undo the last answer', leave: 'Back to Year'
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

const byId = (a, b) => (Number(a) - Number(b)) || (a < b ? -1 : a > b ? 1 : 0);
const freshDeck = () => ({ ids: [], data: {}, answers: {}, hist: [], final: {}, cur: null, busy: null, busyOpt: null, demo: null });

const cadenceText = (c) => (c && typeof c === 'object' ? String(c.label || '') : String(c || ''));

export function ingestScreens(h) {
  const { api, shell, section, pageHead, btn, icon, esc, draw } = h;
  // Module state survives scenario re-renders (the design redraws the whole page on every change).
  const st = { busy: 0, results: null, retrying: {}, open: {}, deck: freshDeck() };
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
     Session state lives in st.deck: ids in session order, item data cached so answered cards can
     be revisited, answers {id: optionId}, the undo history and final notices {id: message}.
     cur is the current id, or null for the All caught up end state. */

  const pendingNow = () => ing().items.filter((i) => !i.status || i.status === 'pending');
  const unanswered = (dk, id) => dk.answers[id] == null && dk.busy !== id;

  function syncDeck(entering) {
    let dk = st.deck;
    const pend = pendingNow();
    const ids = pend.map((i) => String(i.id)).sort(byId);
    const pset = new Set(ids);
    if (dk.demo !== api.demo() || (entering && !dk.ids.some((id) => pset.has(id)))) {
      dk = st.deck = freshDeck();
      dk.demo = api.demo();
    }
    pend.forEach((i) => { dk.data[String(i.id)] = i; });
    const added = [];
    for (const id of ids) {
      if (!dk.ids.includes(id)) { dk.ids.push(id); added.push(id); }
      else if (dk.answers[id] != null && dk.busy !== id) dropAnswer(dk, id);
    }
    // Drop cards that left the queue without an answer from this session.
    const old = dk.ids;
    dk.ids = old.filter((id) => pset.has(id) || dk.answers[id] != null || dk.busy === id);
    if (dk.cur != null && !dk.ids.includes(dk.cur)) {
      const after = old.slice(old.indexOf(dk.cur) + 1).find((id) => dk.ids.includes(id));
      dk.cur = after ?? null;
      if (dk.cur != null && !unanswered(dk, dk.cur)) dk.cur = nextOpen(dk, dk.cur);
    }
    if (dk.cur == null && added.length) dk.cur = added[0];
    return dk;
  }

  function dropAnswer(dk, id) {
    delete dk.answers[id];
    delete dk.final[id];
    dk.hist = dk.hist.filter((x) => x !== id);
  }

  // The next unanswered id after `id` in session order, wrapping; null when every card is answered.
  function nextOpen(dk, id) {
    const at = dk.ids.indexOf(id);
    const order = [...dk.ids.slice(at + 1), ...dk.ids.slice(0, Math.max(0, at))];
    return order.find((x) => unanswered(dk, x)) ?? null;
  }

  const undoTarget = (dk) => [...dk.hist].reverse().find((id) => !dk.final[id]) ?? null;

  function guessOf(it) {
    const g = it && it.guess;
    if (!g || g.option == null) return null;
    const o = arr(it.options).find((x) => String(x.id) === String(g.option));
    return o ? { option: String(o.id), label: o.label, reason: g.reason } : null;
  }

  function cardHtml(dk, id, fileName) {
    const it = dk.data[id];
    const fin = dk.final[id];
    const busy = dk.busy === id;
    const chosen = busy && dk.busyOpt != null ? dk.busyOpt : dk.answers[id];
    const g = guessOf(it);
    const opts = arr(it.options).map((o, n) => {
      const on = chosen != null && String(chosen) === String(o.id);
      const attrs = `data-answer="${esc(id)}" data-option="${esc(o.id)}" aria-pressed="${on}"${g && g.option === String(o.id) ? ' data-guess="1"' : ''}${busy || fin ? ' disabled' : ''}`;
      return btn(`<span class="h-deck-n">${n + 1}</span> · ${esc(o.label)}`, attrs, on ? 'pri' : '');
    }).join('');
    const short = arr(it.options).every((o) => String(o.label ?? '').length <= 24);
    const name = it.fileName || fileName || '';
    const guess = g ? `<p class="h-cf-guess">Fathom's guess: <b>${esc(g.label)}</b>${g.reason ? `<span class="h-cf-why">${esc(g.reason)}</span>` : ''}</p>` : '';
    const state = fin
      ? `<p class="h-cf-final" role="status">${esc(fin)}</p>`
      : (dk.answers[id] != null && !busy ? '<p class="h-deck-state">Answered. Pick another option to change it.</p>' : '');
    return `<article class="h-deck-card cur${fin ? ' final' : ''}" data-item="${esc(id)}">
      <div class="h-cf-k">${esc(KIND[it.kind] || 'Question')}${name ? `<span>${esc(name)}</span>` : ''}</div>
      <p class="h-cf-q">${esc(it.question)}</p>${guess}<div class="h-deck-opts${short ? ' short' : ''}">${opts}</div>${state}</article>`;
  }

  function confirmPage(entering) {
    const dk = syncDeck(entering);
    const files = new Map(ing().files.map((f) => [String(f.id), f.name]));
    const n = dk.ids.length;
    const caught = (line) => `<div class="h-empty"><i class="h-ok sm">${icon('check')}</i><div><b>All caught up</b><p>${line}</p></div></div>`;
    let deck;
    if (!n) deck = `<div class="h-deck">${caught('New questions show up here when an import needs one.')}</div>`;
    else {
      const at = dk.cur == null ? n : dk.ids.indexOf(dk.cur);
      const done = dk.ids.filter((id) => dk.answers[id] != null).length;
      const canUndo = dk.busy == null && undoTarget(dk) != null;
      const top = `<div class="h-deck-top"><span class="h-deck-pos" data-deck-progress>${Math.min(at + 1, n)} of ${n}</span>
        <div class="h-deck-bar" role="progressbar" aria-label="Answered" aria-valuemin="0" aria-valuemax="${n}" aria-valuenow="${done}"><i style="width:${Math.round((done / n) * 100)}%"></i></div>
        ${btn('Undo', `data-deck="undo"${canUndo ? '' : ' disabled'}`, 'ghost')}</div>`;
      let stack;
      if (dk.cur == null) stack = caught('Every question here is answered. Prev goes back to the last card.');
      else {
        const peeks = dk.ids.slice(at + 1, at + 3).map((_, i) => `<div class="h-deck-peek p${i + 1}" aria-hidden="true"></div>`).reverse().join('');
        stack = `<div class="h-deck-stack${peeks ? ` n${Math.min(2, n - at - 1)}` : ''}">${peeks}${cardHtml(dk, dk.cur, files.get(String(dk.data[dk.cur].fileId)))}</div>`;
      }
      const allDone = !dk.ids.some((id) => unanswered(dk, id));
      const canNext = dk.cur != null && (at < n - 1 || allDone);
      const hint = '<p class="h-deck-hint"><span class="kb">1 to 9 answer, Enter takes the guess, J and K move, Z undoes, Esc goes to Year, ? for all shortcuts</span><span class="tch">Swipe right for the next card, left for the previous one</span></p>';
      const nav = `<div class="h-deck-nav">${btn('← Prev', `data-deck="prev"${at > 0 ? '' : ' disabled'}`, 'ghost')}${hint}${btn('Next →', `data-deck="next"${canNext ? '' : ' disabled'}`, 'ghost')}</div>`;
      deck = `<div class="h-deck">${top}${stack}${nav}</div>`;
    }
    const wait = waitingList() || '<p class="h-mute">No files are waiting.</p>';
    return shell(`${pageHead('Household', 'Confirm', 'A few short questions so imports land in the right place.')}
      <div class="h-cols"><div class="h-col-main">${deck}</div>
      <div class="h-col-side">${section('Waiting files', wait)}</div></div>`, 'confirm');
  }

  // Move by d cards. Next past the last card reaches All caught up only when nothing is left open.
  function move(d) {
    const dk = st.deck;
    const n = dk.ids.length;
    if (!n) return false;
    const at = dk.cur == null ? n : dk.ids.indexOf(dk.cur);
    const to = at + d;
    if (to < 0 || to > n) return false;
    if (to === n) {
      if (dk.cur == null || dk.ids.some((id) => unanswered(dk, id))) return false;
      dk.cur = null;
    } else dk.cur = dk.ids[to];
    draw();
    return true;
  }

  // Answer (or revise) card `id` with `opt`, then move to the next open card.
  function pick(id, opt) {
    const dk = st.deck;
    const it = dk.data[id];
    if (dk.busy != null || dk.final[id] || !it || !arr(it.options).some((o) => String(o.id) === String(opt))) return false;
    if (dk.answers[id] != null && String(dk.answers[id]) === String(opt)) {
      if (dk.cur === id) { dk.cur = nextOpen(dk, id); draw(); }
      return true;
    }
    const revise = !pendingNow().some((i) => String(i.id) === id);
    dk.busy = id;
    dk.busyOpt = String(opt);
    draw();
    const req = revise ? api.reviseAnswer(id, opt) : api.answer(id, opt).then((item) => (item ? { item } : null));
    req.then((r) => {
      dk.busy = null;
      dk.busyOpt = null;
      if (st.deck === dk && r) {
        if (r.final) {
          dk.final[id] = r.final;
          dk.hist = dk.hist.filter((x) => x !== id);
        } else {
          dk.answers[id] = String(opt);
          dk.hist = [...dk.hist.filter((x) => x !== id), id];
          if (dk.cur === id) dk.cur = nextOpen(dk, id);
        }
      }
      draw();
    });
    return true;
  }

  // Reopen the most recent non-final answer of this session and move to its card.
  function undo() {
    const dk = st.deck;
    const id = dk.busy == null ? undoTarget(dk) : null;
    if (id == null) return false;
    dk.busy = id;
    draw();
    api.reopenAnswer(id).then((r) => {
      dk.busy = null;
      if (st.deck === dk && r) {
        if (r.final) {
          dk.final[id] = r.final;
          dk.hist = dk.hist.filter((x) => x !== id);
        } else dropAnswer(dk, id);
        dk.cur = id;
      }
      draw();
    });
    return true;
  }

  // Runs a deck action from the key registry (rows from deckBindings). Held keys never repeat an answer or an undo.
  function deckAction(action, e) {
    if (api.route?.name !== 'confirm') return false;
    const dk = st.deck;
    const cur = dk.cur != null ? dk.data[dk.cur] : null;
    if (e?.repeat && ['pick', 'guess', 'undo'].includes(action)) return true;
    switch (action) {
      case 'pick': {
        const o = cur && arr(cur.options)[Number(e?.key) - 1];
        return o ? pick(dk.cur, o.id) : false;
      }
      case 'guess': {
        const g = guessOf(cur);
        return g ? pick(dk.cur, g.option) : false;
      }
      case 'next': return move(1) || true;
      case 'prev': return move(-1) || true;
      case 'undo': return undo() || true;
      case 'leave': api.go('brief'); return true;
      default: return false;
    }
  }

  // Touch and pen swipes on the current card: it follows the finger, swipe right goes to the next
  // card, left to the previous one, and a short drag springs back. A swipe never answers.
  let drag = null;
  function handlePointer(e) {
    if (e.type === 'pointerdown') {
      drag = null;
      if (api.route?.name !== 'confirm' || (e.pointerType !== 'touch' && e.pointerType !== 'pen')) return false;
      const el = e.target.closest?.('article.h-deck-card.cur');
      if (!el || e.target.closest('button,a,input,textarea,select')) return false;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, on: false, el };
      return true;
    }
    if (!drag || e.pointerId !== drag.id) return false;
    // A redraw during the drag (resize, a scenario change) replaces the card element.
    if (!drag.el.isConnected) drag.el = document.querySelector('article.h-deck-card.cur') || drag.el;
    if (e.type === 'pointermove') {
      const dx = e.clientX - drag.x;
      if (!drag.on) {
        if (Math.abs(dx) < 6 || Math.abs(dx) < Math.abs(e.clientY - drag.y)) return true;
        drag.on = true;
        drag.el.classList.add('drag');
      }
      drag.dx = dx;
      drag.el.style.transform = `translateX(${dx}px) rotate(${(dx / 30).toFixed(2)}deg)`;
      return true;
    }
    const d = drag;
    drag = null;
    const far = e.type === 'pointerup' && d.on && Math.abs(d.dx) >= Math.min(80, (d.el.offsetWidth || 320) * 0.25);
    d.el.classList.remove('drag');
    d.el.style.transform = '';
    if (far) move(d.dx > 0 ? 1 : -1);
    return true;
  }

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
    const t = e.target.closest?.('[data-upload-open],[data-answer],[data-deck],[data-retry],details[data-howto] > summary');
    if (!t) return false;
    if (t.tagName === 'SUMMARY') {
      const d = t.parentElement;
      st.open[d.dataset.howto] = !d.open;
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
