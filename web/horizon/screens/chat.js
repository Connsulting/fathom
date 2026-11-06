/* Horizon chat: the Ask page (conversations), the Sources disclosure under each Fathom answer, and
   the confirm card for a proposed rec change.
   Ask is a list of threads (api.threads) in a sidebar and one open thread in the main pane. #/ask
   is a new conversation: a centered composer with starter chips (api.askStarters, plain text).
   #/ask/<id> shows that thread with the composer docked at the bottom. Titles and starters are
   plain text and always escaped; no figure is ever rendered in a title or chip.
   Message bodies arrive as stored HTML: figure tokens render through api.t as .fx-fig, numbers a
   tool grounded are .fx-src spans, and numbers nothing supports are .fx-unverified spans. This
   module only adds the provenance list and the card; it never re-renders the body.
   Chat never writes: a proposal (provenance.proposal {recId, action, wake?}) changes the rec only
   when the owner clicks Confirm, through the ordinary rec action (api.act). The card wording comes
   from a fixed action map and the rec, never from model text; the wake label is escaped text.
   A goal proposal (provenance.goalProposal {title, note, horizon, target, targetDate}) saves a goal
   only when the owner taps Save, through the goals API (api.goalCreate). Its text is escaped; the
   card reads Saved once an owner goal with that title exists.
   Streaming: with the engine on, a question goes out through api.askStream / api.newThreadStream.
   Until text arrives the pending block lists the run's progress labels; streamed text is raw model
   output rendered by streamHtml (escaped, minimal markdown, every number and token in a neutral
   .fx-checking span, never .fx-src or .fx-fig). The final grounded message replaces it. Only the
   pending block is repainted per event; the page redraws once at the start and once at the end.
   Scrolling: sending pins the owner's question under the thread header and the answer grows below
   it; opening a thread lands on its latest question. */

import { ACTION_STATUS } from '/shared/rules.mjs';
import { escapeUserText, money } from '/shared/tokens.mjs';
import { streamHtml } from '/shared/answer-text.mjs';
import { horizonLabel } from '/shared/goals.mjs';

let H = null;

export function bind(kit) { H = kit; }

const GROUNDED = 'Every number is from your data or a tool result.';
const UNVERIFIED = 'Some numbers could not be verified and are marked.';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const ACTION_LABEL = { start: 'Doing it', complete: 'Done', dismiss: 'Not for us', snooze: 'Later', reopen: 'Reopen' };

function argsText(args) {
  if (args == null) return 'no arguments';
  if (isObj(args) && !Object.keys(args).length) return 'no arguments';
  if (Array.isArray(args) && !args.length) return 'no arguments';
  try { return JSON.stringify(args); } catch (e) { return 'no arguments'; }
}

// Manifest ids or row ids of the packs that were in the prompt, as display names.
function packNames(ids) {
  const { api, arr } = H;
  const packs = arr(api.packs());
  return arr(ids).map((id) => {
    const p = packs.find((x) => x.manifest === id || x.id === id);
    return p ? api.txt(p.label || p.name || id) : String(id);
  });
}

function group(title, items) {
  if (!items.length) return '';
  return `<div class="h-src-g"><div class="h-src-h">${title}</div><ul>${items.join('')}</ul></div>`;
}

// The quiet provenance disclosure for one mapped message ({ id, role, notice, provenance }).
export function sourcesHtml(m) {
  if (!H || !m || m.role !== 'fathom' || m.notice || !isObj(m.provenance)) return '';
  const { api, ui, esc, arr, figHtml } = H;
  const pv = m.provenance;
  const g = isObj(pv.grounding) ? pv.grounding : null;
  const unverified = arr(g && g.unverified);
  const warn = (g && g.ok === false) || unverified.length > 0;
  const ok = !!(g && g.ok) && !warn;

  const tools = arr(pv.tools).filter((t) => t && t.name).map((t) =>
    `<li class="h-src-tool"><code>${esc(t.name)}</code> <span>${esc(argsText(t.args))}</span></li>`);
  const figs = [...new Set(arr(pv.figures).map(String))].map((key) => {
    const f = api.fig(key);
    const label = f && !f.missing ? f.label || key : key;
    return `<li class="h-src-fig"><span>${esc(api.txt(label))}</span>${f && !f.missing ? figHtml(key) : ''}</li>`;
  });
  const lits = arr(pv.literals).filter((l) => l && l.text != null).map((l) =>
    `<li class="h-src-lit"><span class="fx-src">${esc(l.text)}</span> <span>from ${esc(l.source || 'a tool result')}</span></li>`);
  const entries = [...new Set(arr(pv.packEntries).map(String))].map((t) =>
    `<li class="h-src-pack">${esc(t)}</li>`);
  const read = packNames(pv.packIds);

  const det = `src-${m.id}`;
  return `<details class="h-src" data-det="${esc(det)}"${ui.det[det] ? ' open' : ''}><summary>Sources</summary><div class="h-src-b">`
    + (warn ? `<p class="h-src-warn">${UNVERIFIED}</p>` : ok ? `<p class="h-src-ok">${GROUNDED}</p>` : '')
    + group('Tools read', tools)
    + group('Figures', figs)
    + group('Numbers from tools', lits)
    + group('Pack entries', entries)
    + (read.length ? `<p class="h-src-note">Knowledge packs in context: ${read.map(esc).join(', ')}</p>` : '')
    + (pv.model ? `<p class="h-src-note">Answered by ${esc(pv.model)}</p>` : '')
    + '</div></details>';
}

// The confirm card for a Fathom message that proposes a rec change. Done (no button) once the rec's
// status already equals the action's status, so the card follows the stored rec state.
export function proposalHtml(m) {
  if (!H || !m || m.role !== 'fathom' || m.notice || !isObj(m.provenance) || !isObj(m.provenance.proposal)) return '';
  const { api, esc, T } = H;
  const p = m.provenance.proposal;
  const label = Object.hasOwn(ACTION_LABEL, p.action) ? ACTION_LABEL[p.action] : null;
  const r = label && typeof p.recId === 'string' ? api.rec(p.recId) : null;
  if (!r || r.status === 'hidden') return '';
  const wake = p.action === 'snooze' && typeof p.wake === 'string' && p.wake ? p.wake : '';
  const done = r.status === ACTION_STATUS[p.action];
  return `<div class="h-proposal"><p><span class="h-proposal-k">Proposed:</span> ${label}: <b>${T(r.title)}</b>${wake ? ` until ${escapeUserText(wake)}` : ''}</p>`
    + (done
      ? '<span class="h-proposal-done">Done</span>'
      : `<button type="button" class="h-btn pri h-propose" data-propose-rec="${esc(r.id)}" data-propose-action="${esc(p.action)}"${wake ? ` data-propose-wake="${escapeUserText(wake)}"` : ''}>Confirm</button>`)
    + '</div>';
}

// The save card for a Fathom message that proposes a goal.
export function goalProposalHtml(m) {
  if (!H || !m || m.role !== 'fathom' || m.notice || !isObj(m.provenance) || !isObj(m.provenance.goalProposal)) return '';
  const { api, esc } = H;
  const g = m.provenance.goalProposal;
  if (typeof g.title !== 'string' || !g.title.trim()) return '';
  const saved = H.arr(api.s.goals).some((x) => x.origin === 'owner' && x.title === g.title);
  const bits = [horizonLabel(g.horizon)];
  if (typeof g.target === 'number') bits.push(`target ${money(g.target)}, as you said`);
  if (typeof g.targetDate === 'string' && g.targetDate) bits.push(`by ${g.targetDate}`);
  const fields = { title: g.title, note: typeof g.note === 'string' ? g.note : '', horizon: g.horizon || 'now',
    target: typeof g.target === 'number' ? g.target : null, targetDate: g.targetDate || null };
  return `<div class="h-proposal h-goal-proposal"><p><span class="h-proposal-k">New goal:</span> <b>${esc(g.title)}</b> <span class="h-mute">${esc(bits.join(', '))}</span></p>`
    + (saved
      ? '<span class="h-proposal-done">Saved</span>'
      : `<button type="button" class="h-btn pri h-propose" data-propose-goal="${esc(JSON.stringify(fields))}">Save</button>`)
    + '</div>';
}

function proposalClick(e) {
  const g = e.target.closest('button.h-propose[data-propose-goal]');
  if (g && H.root.contains(g)) {
    e.preventDefault();
    let fields = null;
    try { fields = JSON.parse(g.dataset.proposeGoal); } catch { fields = null; }
    if (fields) { g.disabled = true; H.api.goalCreate(fields); }
    return true;
  }
  const t = e.target.closest('button.h-propose[data-propose-rec]');
  if (!t || !H.root.contains(t)) return false;
  e.preventDefault();
  const d = t.dataset;
  H.api.act(d.proposeRec, d.proposeAction, d.proposeAction === 'snooze' ? d.proposeWake : undefined);
  return true;
}

/* ---------- Ask page ---------- */

const NEW_TITLE = 'New conversation';
const HELLO = 'What do you want to know?';
const PLACEHOLDER = 'Ask anything about your money';
const NEW_DRAFT = 'ask:new';
const GROUPS = ['Today', 'Yesterday', 'Previous 7 days', 'Older'];
const DAY = 864e5;

// Icons the shared set does not have, drawn on the same 16px grid.
const svg = (p) => `<svg class="h-i" viewBox="0 0 16 16" aria-hidden="true">${p}</svg>`;
const I = {
  up: svg('<path d="M8 13V3.5M4 7.5l4-4 4 4"/>'),
  menu: svg('<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>'),
  pen: svg('<path d="M10.5 3l2.5 2.5L6 12.5H3.5V10z"/>'),
  archive: svg('<rect x="2.5" y="3" width="11" height="3" rx="0.6"/><path d="M3.5 6v7h9V6M6.5 8.5h3"/>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>')
};

const fresh = () => ({
  view: 'main',       // sidebar list: 'main', 'archived' or 'trash'
  side: false,        // phone: sidebar overlay open
  renaming: null,     // id of the thread whose title is being edited
  renameVal: '',
  pending: null,      // { key, text, n } a question in flight (key null: a new thread)
  pendingTitle: null, // { id, title } a rename in flight
  lastId: null,       // thread shown by the last render ('' for the empty state)
  lastN: 0            // its message count then
});
let A = fresh();

export function reset() { A = fresh(); }

const threads = () => H.arr(H.api.threads ? H.api.threads() : []);
const threadById = (id) => (id ? threads().find((t) => t && t.id === id) || null : null);
const keyOf = (t) => t.key || `ask:${t.id}`;
const titleOf = (t) => (A.pendingTitle && A.pendingTitle.id === t.id ? A.pendingTitle.title : (typeof t.title === 'string' && t.title ? t.title : NEW_TITLE));
const meCount = (key) => H.arr(H.api.conversation(key)).filter((m) => m.role === 'me').length;
const onAsk = () => H.api && H.api.route && H.api.route.name === 'ask';

function dayNum(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY) : null;
}

// Calendar days between the thread's last activity and the app clock, both as UTC dates.
function groupOf(t, today) {
  const d = dayNum(t.lastAt || t.createdAt);
  if (d == null || today == null) return 'Older';
  const ago = today - d;
  if (ago <= 0) return 'Today';
  if (ago === 1) return 'Yesterday';
  if (ago <= 7) return 'Previous 7 days';
  return 'Older';
}

const newestFirst = (list) => list.slice().sort((a, b) => {
  const x = String(a.lastAt || ''), y = String(b.lastAt || '');
  return x === y ? 0 : x < y ? 1 : -1;
});

/* ---------- sidebar ---------- */

function rowHtml(t, openId, mode) {
  const { esc } = H;
  const id = esc(t.id);
  const on = t.id === openId;
  const link = `<a class="h-askx-row${on ? ' on' : ''}" href="#/ask/${encodeURIComponent(t.id)}" data-thread="${id}"${on ? ' aria-current="page"' : ''}><span class="h-askx-t">${esc(titleOf(t))}</span></a>`;
  const ib = (act, label, ic) => `<button type="button" class="h-askx-ib" data-thread-act="${act}" data-tid="${id}" aria-label="${label}" title="${label}">${ic}</button>`;
  const tb = (act, label) => `<button type="button" class="h-askx-tb" data-thread-act="${act}" data-tid="${id}">${label}</button>`;
  let acts;
  if (mode === 'trash') acts = tb('restore', 'Restore') + tb('delete', 'Delete forever');
  else if (mode === 'archived') acts = tb('restore', 'Restore') + tb('trash', 'Move to Trash');
  else acts = ib('archive', 'Archive', I.archive) + ib('trash', 'Move to Trash', I.trash);
  return `<div class="h-askx-item${mode === 'main' ? '' : ' stack'}">${link}<div class="h-askx-acts">${acts}</div></div>`;
}

function sideHtml(openId) {
  const { icon } = H;
  const all = newestFirst(threads());
  const active = all.filter((t) => !t.archivedAt && !t.trashedAt);
  const archived = all.filter((t) => t.archivedAt && !t.trashedAt);
  const trash = all.filter((t) => t.trashedAt);
  let body;
  if (A.view === 'archived' || A.view === 'trash') {
    const inTrash = A.view === 'trash';
    const list = inTrash ? trash : archived;
    body = `<button type="button" class="h-askx-back">${icon('back')}<span>All conversations</span></button>
      <h3 class="h-askx-vt">${inTrash ? 'Trash' : 'Archived'}</h3>
      ${inTrash ? '<p class="h-askx-vnote">Deleted forever after 30 days.</p>' : ''}
      ${list.length ? `<div class="h-askx-rows">${list.map((t) => rowHtml(t, openId, A.view)).join('')}</div>` : `<p class="h-askx-none">${inTrash ? 'Trash is empty.' : 'Nothing archived.'}</p>`}`;
  } else {
    const today = dayNum(H.api.s && H.api.s.meta && H.api.s.meta.clock) ?? dayNum(new Date().toISOString());
    body = GROUPS.map((g) => {
      const list = active.filter((t) => groupOf(t, today) === g);
      return list.length ? `<div class="h-askx-group"><h3>${g}</h3>${list.map((t) => rowHtml(t, openId, 'main')).join('')}</div>` : '';
    }).join('') || '<p class="h-askx-none">No conversations yet.</p>';
  }
  const view = (v, label, n, ic) => `<button type="button" class="h-askx-view${A.view === v ? ' on' : ''}" data-view="${v}" aria-pressed="${A.view === v}">${ic}<span>${label}</span>${n ? `<em>${n}</em>` : ''}</button>`;
  return `<aside class="h-askx-side${A.side ? ' open' : ''}" aria-label="Conversation list">
    <div class="h-askx-top"><button type="button" class="h-askx-new">${icon('plus')}<span>Ask</span><kbd>C</kbd></button></div>
    <nav class="h-askx-list" aria-label="Conversations">${body}</nav>
    <div class="h-askx-foot">${view('archived', 'Archived', archived.length, I.archive)}${view('trash', 'Trash', trash.length, I.trash)}</div>
  </aside>${A.side ? '<div class="h-askx-scrim" data-askx-scrim></div>' : ''}`;
}

/* ---------- main pane ---------- */

const menuBtn = () => `<button type="button" class="h-askx-menu" aria-label="Conversations" aria-expanded="${A.side}">${I.menu}</button>`;

function composeHtml(key, draftKey, docked, busy) {
  const { esc, ui, api } = H;
  const val = (ui.draft && ui.draft[draftKey]) || '';
  return `<form class="h-askx-compose${docked ? ' docked' : ''}" data-key="${esc(key)}"${busy ? ' aria-busy="true"' : ''}>
    <div class="h-askx-box">
      <textarea name="q" rows="1" placeholder="${PLACEHOLDER}" aria-label="Your question" autocomplete="off" data-draft="${esc(draftKey)}"${busy ? ' readonly' : ''}>${esc(val)}</textarea>
      <button type="submit" class="h-askx-send" aria-label="Send"${busy ? ' disabled' : ''}>${I.up}</button>
    </div>
    ${api.engineOn() ? '' : '<p class="h-askx-note">Engine off. Answers are paused until it is back on.</p>'}
  </form>`;
}

function emptyHtml() {
  const { esc, arr, api } = H;
  const starters = arr(api.askStarters ? api.askStarters() : []).slice(0, 4);
  const chips = starters.map((s) => `<button type="button" class="h-chip" data-starter="${esc(s.id)}">${esc(s.q)}</button>`).join('');
  return `<section class="h-askx-main">
    <div class="h-askx-bar">${menuBtn()}</div>
    <div class="h-askx-empty">
      <h1 class="h-askx-hello">${HELLO}</h1>
      ${composeHtml('', NEW_DRAFT, false, false)}
      ${chips ? `<div class="h-askx-chips">${chips}</div>` : ''}
    </div>
  </section>`;
}

const WORKING = 'Working on it';
const RECOVERING = 'Reconnecting to fetch your answer';

// A streamed token shows its plain value (still in the checking style), or nothing when unknown.
function plainToken(tok) {
  const s = H.api.txt(tok);
  return typeof s === 'string' && s && s !== tok && !/[{}]/.test(s) ? s : null;
}

// The live part of a pending question: progress steps until text arrives, then the streamed text
// with the latest step under it.
function liveHtml(p) {
  const { esc } = H;
  const steps = p.steps || [];
  const last = steps.length ? steps[steps.length - 1] : WORKING;
  if (p.stream) {
    return `<div class="h-askx-stream" data-streaming="1"><div class="h-msg-b">${streamHtml(p.stream, plainToken)}</div></div>`
      + `<div class="h-askx-wait" role="status"><i></i>${esc(last)}</div>`;
  }
  if (!steps.length) return `<div class="h-askx-wait" role="status"><i></i>${WORKING}</div>`;
  return `<ol class="h-askx-steps" role="status">${steps.map((st, i) =>
    `<li class="${i === steps.length - 1 ? 'on' : 'done'}"><i></i><span>${esc(st)}</span></li>`).join('')}</ol>`;
}

function pendingHtml(p) {
  return `<div class="h-thread h-askx-pend"><div class="h-msg me pending"><div class="h-msg-b"><p>${H.esc(p.text)}</p></div></div>`
    + `<div class="h-askx-live" aria-live="polite">${liveHtml(p)}</div></div>`;
}

// Repaint only the live block of the pending question (no full redraw per streamed chunk).
function paintLive(p) {
  if (A.pending !== p || !H.root) return;
  const el = H.root.querySelector('.h-askx-pend .h-askx-live');
  if (el) el.innerHTML = liveHtml(p);
}

function streamEvent(p, name, data) {
  if (A.pending !== p) return;
  if (name === 'progress' && data && typeof data.label === 'string') {
    if (p.steps[p.steps.length - 1] !== data.label) p.steps.push(data.label);
  } else if (name === 'text' && data && typeof data.text === 'string') {
    p.stream += data.text;
    p.streamed = true;
  } else if (name === 'reset') {
    p.stream = '';
  } else if (name === 'recovering') {
    p.stream = '';
    p.steps.push(RECOVERING);
  } else return;
  paintLive(p);
}

// th null with a pending new thread: the question shows in place while the thread is created.
function threadHtml(th) {
  const { esc, thread, icon } = H;
  const key = th ? keyOf(th) : '';
  const msgs = th ? H.arr(H.api.conversation(key)) : [];
  let p = A.pending;
  if (p && p.key && p.key === key && meCount(key) > p.n) p = null;
  const mine = p && (th ? p.key === key : p.key == null) ? p : null;
  const trashed = !!(th && th.trashedAt);
  const title = th && A.renaming === th.id
    ? `<input class="h-askx-rename" type="text" maxlength="60" value="${esc(A.renameVal)}" placeholder="${NEW_TITLE}" aria-label="Conversation name" autocomplete="off" data-draft="rename">`
    : `<h2 class="h-askx-title">${esc(th ? titleOf(th) : NEW_TITLE)}</h2>`;
  const tag = trashed ? '<span class="h-askx-tag">In Trash</span>' : th && th.archivedAt ? '<span class="h-askx-tag">Archived</span>' : '';
  const rename = th && !trashed ? `<button type="button" class="h-askx-ib" data-thread-act="rename" data-tid="${esc(th.id)}" aria-label="Rename" title="Rename">${I.pen}</button>` : '';
  const foot = trashed
    ? `<div class="h-askx-trashbar"><p class="h-askx-trashed">In Trash. Restore it to continue.</p><button type="button" class="h-btn" data-thread-act="restore" data-tid="${esc(th.id)}">${icon('back')}Restore</button></div>`
    : composeHtml(key, th ? key : NEW_DRAFT, true, !!A.pending);
  return `<section class="h-askx-main">
    <header class="h-askx-head">${menuBtn()}${title}${tag}${rename}</header>
    <div class="h-askx-msgs">${thread(msgs)}${mine ? pendingHtml(mine) : ''}</div>
    ${foot}
  </section>`;
}

export function render(id) {
  const th = threadById(id);
  const key = th ? keyOf(th) : '';
  const n = key ? H.arr(H.api.conversation(key)).length : 0;
  const shown = th ? th.id : '';
  const here = !!(H.root && H.root.querySelector('.h-askx-main'));
  if (!here || shown !== A.lastId) {
    A.side = false;
    if (A.renaming && A.renaming !== shown) A.renaming = null;
    A.lastId = shown;
    A.lastN = n;
    // Opening a thread lands on its latest question; a thread just created by a streamed answer
    // keeps the place the owner was reading.
    if (th && !(A.pending && A.pending.streamed && A.pending.key == null)) queueMicrotask(scrollToLastMine);
  } else if (th && n > A.lastN) {
    A.lastN = n;
    // A streamed answer was read in place while it arrived; keep the owner where they are.
    if (!(A.pending && A.pending.streamed)) queueMicrotask(scrollToLastMine);
  } else {
    A.lastN = n;
  }
  const main = th || (A.pending && A.pending.key == null) ? threadHtml(th) : emptyHtml();
  return H.shell(`<div class="h-askx">${sideHtml(shown)}${main}</div>`, 'ask');
}

/* ---------- scrolling and focus ---------- */

function scrollEnd() {
  try { window.scrollTo(0, document.documentElement.scrollHeight); } catch (e) { /* ignore */ }
}

// A new answer: put the question that asked it just under the sticky headers.
function scrollToLastMine() {
  if (!H.root) return;
  const list = H.root.querySelectorAll('.h-askx-msgs .h-msg.me');
  const el = list[list.length - 1];
  if (!el) { scrollEnd(); return; }
  const head = H.root.querySelector('.h-askx-head');
  const under = head ? head.getBoundingClientRect().bottom : 0;
  try { window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - under - 16)); } catch (e) { /* ignore */ }
}

function focusInput() {
  const el = H.root && H.root.querySelector('form.h-askx-compose textarea[name="q"]');
  if (!el) return false;
  el.focus();
  const n = el.value.length;
  try { el.setSelectionRange(n, n); } catch (e) { /* ignore */ }
  return true;
}

export function newConversation() {
  A.side = false;
  A.renaming = null;
  if (onAsk() && !(H.api.route.params && H.api.route.params.id)) H.draw();
  else H.api.go('ask', {});
  focusInput();
}

/* ---------- asking ---------- */

// Shows the question at once and keeps the composer read-only until the answer lands. On failure
// the core keeps the old state and shows its error line; the typed text goes back in the composer.
function sendAsk({ key, text, draftKey, starter, refocus }) {
  if (A.pending || !text) return;
  const pend = { key: key || null, text, n: key ? meCount(key) : 0, steps: [], stream: '', streamed: false };
  A.pending = pend;
  if (draftKey) H.ui.draft[draftKey] = '';
  H.draw();
  // The question goes to the top of the view; the answer grows below it.
  scrollToLastMine();
  const api = H.api;
  const live = api.engineOn() && typeof api.askStream === 'function';
  const onEvent = (name, data) => streamEvent(pend, name, data);
  const q = starter ? { questionId: starter } : { text };
  const req = live
    ? (key ? api.askStream(text, key, onEvent) : api.newThreadStream(q, onEvent))
    : (key ? api.askFree(text, key) : api.newThread(q));
  Promise.resolve(req).then((res) => {
    if (A.pending === pend) A.pending = null;
    if (!H.api) return;
    const ok = key ? meCount(key) > pend.n : !!res;
    if (!ok && draftKey && !starter && !H.ui.draft[draftKey]) H.ui.draft[draftKey] = text;
    H.draw();
    if (ok && refocus) focusInput();
  });
}

/* ---------- rename ---------- */

function startRename(id) {
  const th = threadById(id);
  if (!th || th.trashedAt) return;
  A.renaming = id;
  A.renameVal = typeof th.title === 'string' ? th.title : '';
  H.draw();
  const el = H.root.querySelector('input.h-askx-rename');
  if (el) { el.focus(); el.select(); }
}

function endRename(refocus) {
  H.draw();
  if (refocus) H.root.querySelector('header.h-askx-head [data-thread-act="rename"]')?.focus();
}

function cancelRename(refocus) {
  A.renaming = null;
  endRename(refocus);
}

function commitRename(refocus) {
  const id = A.renaming;
  if (!id) return;
  const th = threadById(id);
  const v = A.renameVal.trim().replace(/\s+/g, ' ');
  A.renaming = null;
  if (!th || !v || v === th.title) { endRename(refocus); return; }
  const pt = { id, title: v };
  A.pendingTitle = pt;
  endRename(refocus);
  Promise.resolve(H.api.renameThread(id, v)).then(() => {
    if (A.pendingTitle === pt) A.pendingTitle = null;
    if (H.api) H.draw();
  });
}

/* ---------- events ---------- */

const ASK_SEL = '[data-starter],[data-thread-act],a.h-askx-row,button.h-askx-new,button.h-askx-view,button.h-askx-back,button.h-askx-menu,[data-askx-scrim],h2.h-askx-title';

// Returns true when the click was handled here.
export function onClick(e) {
  if (proposalClick(e)) return true;
  const root = H.root;
  if (!root || !H.api) return false;
  const t = e.target.closest(ASK_SEL);
  // A click anywhere else while renaming saves the name, like leaving the field.
  if (A.renaming && !e.target.closest('input.h-askx-rename') && !(t && t.dataset.threadAct === 'rename')) commitRename(false);
  if (!t || !root.contains(t)) return false;
  const d = t.dataset;
  if (d.starter != null) {
    e.preventDefault();
    const s = H.arr(H.api.askStarters()).find((x) => String(x.id) === d.starter);
    if (s) sendAsk({ key: null, text: s.q, starter: String(s.id), refocus: false });
    return true;
  }
  if (d.threadAct) {
    e.preventDefault();
    if (d.threadAct === 'rename') { if (A.renaming !== d.tid) startRename(d.tid); }
    else H.api.threadAct(d.tid, d.threadAct);
    return true;
  }
  if (t.matches('h2.h-askx-title')) {
    if (e.detail >= 2 && A.lastId) { e.preventDefault(); startRename(A.lastId); }
    return true;
  }
  if (t.matches('a.h-askx-row')) {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return true;
    e.preventDefault();
    A.side = false;
    const r = H.api.route;
    if (r && r.name === 'ask' && r.params && r.params.id === d.thread) H.draw();
    else H.api.go('ask', { id: d.thread });
    return true;
  }
  e.preventDefault();
  if (t.matches('button.h-askx-new')) { newConversation(); return true; }
  if (t.matches('button.h-askx-view')) A.view = A.view === d.view ? 'main' : d.view;
  else if (t.matches('button.h-askx-back')) A.view = 'main';
  else if (t.matches('button.h-askx-menu')) A.side = !A.side;
  else A.side = false;
  H.draw();
  if (t.matches('button.h-askx-back')) H.root.querySelector('button.h-askx-new')?.focus();
  return true;
}

export function onSubmit(e) {
  const f = e.target;
  if (!f || !f.matches || !f.matches('form.h-askx-compose')) return false;
  e.preventDefault();
  const ta = f.querySelector('textarea[name="q"]');
  if (!ta || A.pending) return true;
  sendAsk({ key: f.dataset.key || null, text: ta.value.trim(), draftKey: ta.dataset.draft, refocus: document.activeElement === ta });
  return true;
}

export function onInput(e) {
  const t = e.target;
  if (t && t.matches && t.matches('input.h-askx-rename')) { A.renameVal = t.value; return true; }
  return false;
}

/* ---------- keys ---------- */

const FIELD_SEL = 'form.h-askx-compose textarea[name="q"], input.h-askx-rename';

function inField() {
  const a = document.activeElement;
  return !!(a && a.matches && a.matches(FIELD_SEL) && H.root && H.root.contains(a));
}

// Escape leaves the question box (blur) or cancels a rename; with neither focused it closes the
// phone sidebar. Anything else falls through to the global Escape.
function leaveField() {
  const a = document.activeElement;
  if (a && a.matches && a.matches('input.h-askx-rename')) { cancelRename(true); return; }
  if (a && a.matches && a.matches(FIELD_SEL)) { a.blur(); return; }
  A.side = false;
  H.draw();
}

// Opens #/ask with the text sent as the first question of a new conversation.
export function askNew(text) {
  const q = String(text || '').trim();
  if (!H || !H.api || !q) return;
  if (!onAsk() || (H.api.route.params && H.api.route.params.id)) H.api.go('ask', {});
  if (A.pending) { H.ui.draft[NEW_DRAFT] = q; H.draw(); focusInput(); return; }
  sendAsk({ key: null, text: q, draftKey: NEW_DRAFT, refocus: true });
}

// The Ask page shortcuts, registered as the 'ask' screen table in screens/switcher.js. The
// registry's typing guard keeps c, / and Ctrl+L out of fields; Escape reaches it from a field.
export const ASK_KEYS = [
  { keys: ['c'], label: 'New conversation', group: 'Ask', action: () => newConversation() },
  { keys: ['/'], label: 'Focus the question box', group: 'Ask', action: () => focusInput() },
  { keys: ['mod+l'], label: 'Focus the question box', group: 'Ask', action: () => focusInput() },
  {
    keys: ['escape'], label: 'Leave the question box', group: 'Ask',
    when: () => inField() || (A.side && onAsk()), sheetWhen: () => true,
    action: () => leaveField()
  }
];

// Field keys the registry never sees (its typing guard): Enter sends from the composer
// (Shift+Enter keeps the newline) and Enter saves a rename. design.js calls this from its root
// keydown listener.
export function onFieldKey(e) {
  if (!H || !H.api || e.defaultPrevented || e.isComposing || e.key !== 'Enter') return false;
  const t = e.target;
  if (!t || !t.matches) return false;
  if (t.matches('input.h-askx-rename')) { e.preventDefault(); commitRename(true); return true; }
  if (t.matches('form.h-askx-compose textarea') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    if (t.form) t.form.requestSubmit();
    return true;
  }
  return false;
}
