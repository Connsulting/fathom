/* Horizon chat: the Ask page (conversations), the Sources disclosure under each Fathom answer, and
   the confirm card for a proposed rec change.
   Ask is a list of threads (api.threads) in a sidebar and one open thread in the main pane. #/ask
   is a new conversation: a centered composer with starter chips (api.askStarters, plain text).
   #/ask/<id> shows that thread with the composer docked at the bottom. Titles and starters are
   plain text and always escaped; no figure is ever rendered in a title or chip.
   Message bodies arrive as stored HTML: figure tokens render through api.t as .fx-fig, numbers a
   tool grounded are .fx-src spans, and numbers nothing supports are neutral .fx-checking
   .fx-unchecked spans titled "Not checked against your data" (older stored answers carry
   .fx-unverified). This module only adds the provenance list and the card; it never re-renders
   the body's text. bodyHtml(m) places an answer's stored blocks (provenance.blocks) after their
   paragraphs and its block notes under it, through ask-blocks.js.
   Historical proposal messages: a proposal (provenance.proposal {recId, action, wake?}) changes the rec only
   when the owner clicks Confirm, through the ordinary rec action (api.act). The card wording comes
   from a fixed action map and the rec, never from model text; the wake label is escaped text.
   A goal proposal (provenance.goalProposal {title, note, horizon, target, targetDate}) saves a goal
   only when the owner taps Save, through the goals API (api.goalCreate). Its text is escaped; the
   card reads Saved once an owner goal with that title exists.
   A stored proposal (provenance.pendingAction {tool, operation, args, description, details?,
   resolved?}) shows a card with the server's plain-language description and at most a few
   labelled detail lines (never ids, codes or argument names), plus Confirm and Not now while it is unresolved
   and the latest message of its thread (api.proposalDecide); else its state (Confirmed, Not now,
   Out of date). Nothing is written until the owner confirms. The confirmed reply's receipt shows
   the same description (provenance.description).
   Streaming: with the engine on, a question goes out through api.askStream / api.newThreadStream.
   The pending block is a work block (a row button: spinner, "Working…", step count, chevron; its
   body lists steps and notes) above the text streaming in the current round. Progress labels are
   steps; an interim event (text a tool round streamed) moves the streamed text into the block as a
   note. A reset clears the streamed text: after superseded engine frames, or on a regeneration,
   whose "Revised to remove N unchecked figures" step arrives first, so nothing leaves the screen
   without a step saying why. Draft notes (stored before regenerations stopped keeping the first
   attempt) still render with their tag. The block is open while nothing streams and collapsed
   while text streams, until the owner toggles it for that answer. Streamed text and notes are raw
   model output rendered by streamHtml (escaped, minimal markdown, every number and token in a
   neutral .fx-checking span, never .fx-src or .fx-fig). The final grounded message replaces the pending block and carries
   the stored block (workHtml, provenance.work { ms, items }), collapsed by default, its open
   state in ui.det. Only the pending blocks are repainted per event (a focused live row keeps
   focus); the page redraws once at the start and once at the end.
   Recs: a question asked in a rec dialog is an Ask thread carrying recId (api.recThread is the
   thread the dialog shows). This module is the one pending and streaming implementation for both:
   design.js asks through askFromRec and renders recPendingHtml in the dialog, so the same question
   in flight shows on the Ask page and in the dialog, and every pending block on screen streams.
   A thread asked from a rec carries a context chip (a.h-askx-ctx, the rec title as escaped plain
   text, data-go="rec") in its sidebar row, beside the row link, and in its header; design.js opens
   the rec dialog from it. A thread whose rec no longer exists or is hidden has no chip.
   Scrolling: sending pins the owner's question under the thread header and the answer grows below
   it; opening a thread lands on its latest question. In the rec dialog the pending block is
   scrolled into view inside the dialog. */

import { ACTION_STATUS } from '/shared/rules.mjs';
import { escapeUserText, money, esc } from '/shared/tokens.mjs';
import { streamHtml } from '/shared/answer-text.mjs';
import { horizonLabel } from '/shared/goals.mjs';
import { chipHtml } from './ask-context.js';
import { useKit, messageBodyHtml } from './ask-blocks.js';

let H = null;

export function bind(kit) {
  H = kit;
  useKit({ esc, money, getApi: () => kit.api, askAgain: (text, key) => sendAsk({ text, key }), registerFigures: (map) => { if (kit.api && kit.api.registerFigures) kit.api.registerFigures(map); } });
}

// A message's body: its stored html, with an answer's blocks placed after paragraph `after` and
// its block notes as muted lines under it (ask-blocks.js). Every host that shows Fathom messages
// (the Ask page and panel, the rec dialog, Packs) draws bodies through this.
export function bodyHtml(m) {
  return `<div class="h-msg-b">${messageBodyHtml(m)}</div>`;
}

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
    + (pv.model ? `<p class="h-src-note">Answered by Fathom</p>` : '')
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

const RESOLVED_LABEL = { confirmed: 'Confirmed', declined: 'Not now', stale: 'Out of date' };
// Stored text (a description the server built from stored names) shown as plain text: demo
// {n:key} tokens resolve to their names, everything is escaped.
const plainText = (s) => (H.X ? H.X(s) : H.esc(s));
// The server describes every proposal (src/actions/describe.mjs) and fills older stored ones
// when it serves them, so this fallback only covers a message from an unexpected source.
const FALLBACK_DESCRIPTION = 'The change described above.';
const descriptionOf = (p) => (typeof p.description === 'string' && p.description.trim() ? p.description : FALLBACK_DESCRIPTION);
const detailsOf = (p) => H.arr(p.details).filter((d) => isObj(d) && typeof d.label === 'string' && d.label && typeof d.value === 'string' && d.value).slice(0, 4);

// The card for a Fathom message that carries a stored proposal: one plain-language sentence and
// at most a few labelled detail lines, never ids, codes or argument names. opts.latest: the
// message is the latest in its thread (default true); an older unresolved proposal reads Out of date.
export function pendingActionHtml(m, { latest = true } = {}) {
  if (!H || !m || m.role !== 'fathom' || m.notice || !isObj(m.provenance) || !isObj(m.provenance.pendingAction)) return '';
  const { esc } = H;
  const p = m.provenance.pendingAction;
  const details = detailsOf(p);
  const status = isObj(p.resolved) ? p.resolved.status : latest ? null : 'stale';
  const id = esc(m.id);
  return `<div class="h-proposal h-pending-action"><p><span class="h-proposal-k">Proposed:</span> <b>${plainText(descriptionOf(p))}</b></p>`
    + (details.length ? `<ul class="h-pending-args">${details.map((d) => `<li><span class="h-mute">${esc(d.label)}:</span> ${plainText(d.value)}</li>`).join('')}</ul>` : '')
    + (status
      ? `<span class="h-proposal-done">${esc(RESOLVED_LABEL[status] || 'Out of date')}</span>`
      : `<div class="h-pending-btns"><button type="button" class="h-btn pri" data-proposal-decide="confirm" data-proposal-message="${id}">Confirm</button>`
        + `<button type="button" class="h-btn" data-proposal-decide="decline" data-proposal-message="${id}">Not now</button></div>`)
    + '</div>';
}

// The id of the thread holding message `messageId`: the open Ask thread, else any thread.
function proposalThread(messageId) {
  const has = (th) => th && H.arr(H.api.conversation(keyOf(th))).some((m) => m.id === messageId);
  const r = H.api.route;
  const open = r && r.name === 'ask' && r.params && r.params.id ? threadById(r.params.id) : null;
  if (has(open)) return open.id;
  const th = threads().find(has);
  return th ? th.id : null;
}

function proposalClick(e) {
  const pd = e.target.closest('button[data-proposal-decide]');
  if (pd && H.root.contains(pd)) {
    e.preventDefault();
    const id = pd.dataset.proposalMessage;
    const threadId = proposalThread(id);
    const buttons = [...(pd.closest('.h-pending-action') || pd).querySelectorAll('button[data-proposal-decide]')];
    if (!threadId || pd.disabled) return true;
    buttons.forEach((b) => { b.disabled = true; });
    Promise.resolve(H.api.proposalDecide(threadId, id, pd.dataset.proposalDecide))
      .finally(() => buttons.forEach((b) => { if (b.isConnected) b.disabled = false; }));
    return true;
  }
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
  pending: null,      // { key, recId, text, n } a question in flight (key null: a new thread;
                      // recId: asked from that rec's dialog)
  pendingTitle: null, // { id, title } a rename in flight
  lastId: null,       // thread shown by the last render ('' for the empty state)
  lastN: 0            // its message count then
});
let A = fresh();

export function reset() { A = fresh(); }

const threads = () => H.arr(H.api.threads ? H.api.threads() : []);
const threadById = (id) => (id ? threads().find((t) => t && t.id === id) || null : null);
export const keyOf = (t) => t.key || `ask:${t.id}`;
// The key of the thread a rec's dialog shows, or null when it has none.
const recKey = (recId) => { const th = H.api.recThread(recId); return th ? keyOf(th) : null; };
// A question in flight that starts a new thread from the Ask page (not from a rec dialog).
const newOnAsk = (p) => !!p && p.key == null && !p.recId;
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

// The context chip of a thread asked from a rec that is still on the plan, or ''.
function ctxChip(t) {
  const { api, esc } = H;
  const r = t && typeof t.recId === 'string' && t.recId ? api.rec(t.recId) : null;
  if (!r || r.status === 'hidden') return '';
  return chipHtml({ kind: 'rec', id: r.id, label: api.txt(r.title) }, { esc, href: `#/rec/${encodeURIComponent(r.id)}`, go: 'rec', id: r.id, cls: 'h-askx-ctx', bare: true });
}

/* ---------- sidebar ---------- */

function rowHtml(t, openId, mode) {
  const { esc } = H;
  const id = esc(t.id);
  const on = t.id === openId;
  const ctx = ctxChip(t);
  const link = `<a class="h-askx-row${on ? ' on' : ''}" href="#/ask/${encodeURIComponent(t.id)}" data-thread="${id}"${on ? ' aria-current="page"' : ''}><span class="h-askx-t">${esc(titleOf(t))}</span></a>`;
  const ib = (act, label, ic) => `<button type="button" class="h-askx-ib" data-thread-act="${act}" data-tid="${id}" aria-label="${label}" title="${label}">${ic}</button>`;
  const tb = (act, label) => `<button type="button" class="h-askx-tb" data-thread-act="${act}" data-tid="${id}">${label}</button>`;
  let acts;
  if (mode === 'trash') acts = tb('restore', 'Restore') + tb('delete', 'Delete forever');
  else if (mode === 'archived') acts = tb('restore', 'Restore') + tb('trash', 'Move to Trash');
  else acts = ib('archive', 'Archive', I.archive) + ib('trash', 'Move to Trash', I.trash);
  return `<div class="h-askx-item${mode === 'main' ? '' : ' stack'}${ctx ? ' ctx' : ''}">${link}${ctx}<div class="h-askx-acts">${acts}</div></div>`;
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

// The conversation list alone, for the Ask panel.
export function listHtml(openId) { return sideHtml(openId); }

/* ---------- main pane ---------- */

const menuBtn = () => `<button type="button" class="h-askx-menu" aria-label="Conversations" aria-expanded="${A.side}">${I.menu}</button>`;

function composeHtml(key, draftKey, docked, busy) {
  const { esc, ui, api } = H;
  const val = (ui.draft && ui.draft[draftKey]) || '';
  return `<form class="h-askx-compose${docked ? ' docked' : ''}" data-key="${esc(key)}"${busy ? ' aria-busy="true"' : ''}>
    ${H.ctxChipsHtml ? H.ctxChipsHtml() : ''}
    <div class="h-askx-box">
      <textarea name="q" rows="1" placeholder="${PLACEHOLDER}" aria-label="Your question" autocomplete="off" data-draft="${esc(draftKey)}"${busy ? ' readonly' : ''}>${esc(val)}</textarea>
      <button type="submit" class="h-askx-send" aria-label="Send"${busy ? ' disabled' : ''}>${I.up}</button>
    </div>
    ${api.engineOn() ? '' : '<p class="h-askx-note">Engine off. Answers are paused until it is back on.</p>'}
  </form>`;
}

function emptyHtml(host) {
  const { esc, arr, api } = H;
  const starters = arr(api.askStarters ? api.askStarters() : []).slice(0, 4);
  const chips = starters.map((s) => `<button type="button" class="h-chip" data-starter="${esc(s.id)}">${esc(s.q)}</button>`).join('');
  // In the panel: a smaller hello and the composer docked at the bottom.
  if (host === 'panel') {
    return `<section class="h-askx-main"><div class="h-askx-msgs"><div class="h-askx-empty"><h2 class="h-askx-hello">${HELLO}</h2>${chips ? `<div class="h-askx-chips">${chips}</div>` : ''}</div></div>${composeHtml('', NEW_DRAFT, true, !!A.pending)}</section>`;
  }
  return `<section class="h-askx-main">
    <div class="h-askx-bar">${menuBtn()}${H.askPanelBtn ? H.askPanelBtn() : ''}</div>
    <div class="h-askx-empty">
      <h1 class="h-askx-hello">${HELLO}</h1>
      ${composeHtml('', NEW_DRAFT, false, false)}
      ${chips ? `<div class="h-askx-chips">${chips}</div>` : ''}
    </div>
  </section>`;
}

const WORKING = 'Working…';
const RECOVERING = 'Reconnecting to fetch your answer';
const DRAFT_TAG = 'Earlier draft, replaced after the number check';
const LIVE_ROW = 'button.h-work-row[data-work="live"]';

// A streamed token shows its plain value (still in the checking style), or nothing when unknown.
function plainToken(tok) {
  const s = H.api.txt(tok);
  return typeof s === 'string' && s && s !== tok && !/[{}]/.test(s) ? s : null;
}

/* ---------- the work block ---------- */

const stepCount = (items) => items.filter((x) => x.k === 'step').length;
const stepsLabel = (n) => (n === 0 ? '' : n === 1 ? '1 step' : `${n} steps`);

// The block's item list. pulse marks the last step as the one running (live, nothing streaming).
// Notes are model text: escaped and rendered by the neutral streamHtml, never as figures.
function itemsHtml(items, pulse) {
  const { esc } = H;
  let last = -1;
  if (pulse) items.forEach((x, i) => { if (x.k === 'step') last = i; });
  return `<ol class="h-work-items">${items.map((x, i) => (x.k === 'note'
    ? `<li class="note${x.draft ? ' draft' : ''}">${x.draft ? `<span class="h-work-tag">${DRAFT_TAG}</span>` : ''}<div class="h-work-note">${streamHtml(x.text, plainToken)}</div></li>`
    : `<li class="step${i === last ? ' on' : ''}"><i></i><span>${esc(x.label)}</span></li>`)).join('')}</ol>`;
}

// One block: a row button (label, step count, chevron; a spinner while live) and, only while
// open, the body with the items. key is 'live' or the message id.
function blockHtml({ key, live, open, label, items, pulse }) {
  const { esc } = H;
  const k = esc(key);
  const bid = `h-work-b-${k}`;
  const n = stepsLabel(stepCount(items));
  return `<div class="h-work${live ? ' live' : ''}"><button type="button" class="h-work-row" data-work="${k}" aria-expanded="${open}" aria-controls="${bid}">`
    + (live ? '<i class="h-work-spin" aria-hidden="true"></i>' : '')
    + `<span class="h-work-l">${label}</span>${n ? `<span class="h-work-n">${n}</span>` : ''}</button>`
    + (open ? `<div class="h-work-body" id="${bid}">${items.length ? itemsHtml(items, pulse) : ''}</div>` : '')
    + '</div>';
}

// Stored items, shape checked: { k:'step', label } or { k:'note', text, draft? }.
function workItems(list) {
  return H.arr(list).filter((x) => isObj(x) && ((x.k === 'step' && typeof x.label === 'string' && x.label)
    || (x.k === 'note' && typeof x.text === 'string' && x.text.trim())));
}

// The finished block above a Fathom answer (provenance.work { ms, items }), collapsed by default,
// open state kept per message in ui.det. A message stored before the block existed has none.
// A goal receipt's status is the goal's lifecycle (open, done, archived), listed with its fields;
// any other receipt's status is a recommendation action.
function receiptValue(value, scope) {
  if (value == null) return 'Not set';
  if (typeof value === 'boolean') return value ? 'Checked' : 'Unchecked';
  if (typeof value !== 'object') return String(value);
  if (value.status && scope !== 'write:goals') return `${ACTION_LABEL[{ doing: 'start', done: 'complete', dismissed: 'dismiss', snoozed: 'snooze', proposed: 'reopen' }[value.status]] || value.status}${value.wake ? ` (${value.wake})` : ''}`;
  return Object.entries(value).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k === 'targetDate' ? 'date' : k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
}

// A remembered preference reads as a memory with a link to the Memories page; a source change
// shows its label; any other receipt shows its label and the value before and after.
function receiptLine(a) {
  const { esc } = H;
  if (a.scope === 'write:sources') return `<p><b>${esc(a.label)}</b></p>`;
  if (a.scope !== 'write:preferences' || typeof (a.after ?? a.before) !== 'string') return `<p><b>${esc(a.label)}</b>: ${esc(receiptValue(a.before, a.scope))} → ${esc(receiptValue(a.after, a.scope))}</p>`;
  const had = a.before != null && a.before !== '';
  const head = a.after == null ? 'Memory deleted' : had ? 'Memory updated' : 'Memory saved';
  const text = a.after == null ? a.before : a.after;
  return `<p><b>${head}</b>: ${esc(receiptValue(text, a.scope))} <a href="${H.href('memories')}" data-go="memories" class="h-mem-all">See all memories</a></p>`;
}

// The receipt of a confirmed proposal reads like its card: the proposal's description replaces
// the first receipt's line (a remembered preference keeps its link to the Memories page).
function confirmedLine(a, description) {
  const link = a.scope === 'write:preferences' ? ` <a href="${H.href('memories')}" data-go="memories" class="h-mem-all">See all memories</a>` : '';
  return `<p><b>${plainText(description)}</b>${link}</p>`;
}

export function workHtml(m) {
  if (!H || !m || m.role !== 'fathom' || !isObj(m.provenance)) return '';
  const { esc } = H;
  const described = m.provenance.confirmedProposal && typeof m.provenance.description === 'string' && m.provenance.description.trim()
    ? m.provenance.description : null;
  const actions = H.arr(m.provenance.actions).map((a, i) => `<div class="h-action-receipt" data-receipt="${esc(a.id)}" role="status">${described && i === 0 ? confirmedLine(a, described) : receiptLine(a)}`
    + (a.planningPending ? '<p class="h-mute">Saved. Planning is pending.</p>' : '')
    + (a.undo?.available === false ? `<span class="h-mute">${esc(a.undo.reason)}</span>` : a.undone ? '<span class="h-mute">Undone</span>' : `<button type="button" class="h-btn" data-undo-action="${esc(a.id)}"${m.provenance.blockControl ? ` data-blk-ctl="${esc(m.provenance.blockControl)}"` : ''}>Undo</button>`) + '</div>').join('');
  if (m.notice || !isObj(m.provenance.work)) return actions;
  const w = m.provenance.work;
  const ms = Number(w.ms);
  const secs = Math.max(1, Math.round((Number.isFinite(ms) && ms > 0 ? ms : 0) / 1000));
  const open = !!H.ui.det[`work-${m.id}`];
  return blockHtml({ key: String(m.id), live: false, open, label: `Worked for ${secs}s`, items: workItems(w.items), pulse: false }) + actions;
}

// Open while nothing streams, collapsed while text streams, unless the owner chose for this answer.
const liveOpen = (p) => (p.open == null ? !p.stream : p.open);

// The live part of a pending question: the work block, then the text streaming in this round.
function liveHtml(p) {
  return blockHtml({ key: 'live', live: true, open: liveOpen(p), label: WORKING, items: p.items, pulse: !p.stream })
    + (p.stream ? `<div class="h-askx-stream" data-streaming="1"><div class="h-msg-b">${streamHtml(p.stream, plainToken)}</div></div>` : '');
}

function pendingHtml(p) {
  return `<div class="h-thread h-askx-pend"><div class="h-msg me pending"><div class="h-msg-b"><p>${H.esc(p.text)}</p></div></div>`
    + `<div class="h-askx-live" aria-live="polite">${liveHtml(p)}</div></div>`;
}

// Repaint only the live blocks of the pending question (no full redraw per streamed chunk). With
// the rec dialog open over the Ask page both may show the same question, and both stream. A
// focused live row keeps focus across the repaint.
function paintLive(p) {
  if (A.pending !== p || !H.root) return;
  const html = liveHtml(p);
  const a = document.activeElement;
  H.root.querySelectorAll('.h-askx-pend .h-askx-live').forEach((el) => {
    const had = !!(a && el.contains(a) && a.matches(LIVE_ROW));
    el.innerHTML = html;
    if (had) el.querySelector(LIVE_ROW)?.focus({ preventScroll: true });
  });
}

// A row click: the live row sets the owner's choice for this answer and repaints the live block;
// a finished row flips its stored open state and redraws, then focus goes back to that row.
// w: { key, open, inDlg } read from the clicked row.
function toggleWork({ key, open, inDlg }) {
  if (key === 'live') {
    const p = A.pending;
    if (!p) return;
    p.open = !open;
    paintLive(p);
    return;
  }
  H.ui.det[`work-${key}`] = !open;
  H.draw();
  const sel = `button.h-work-row[data-work="${CSS.escape(key)}"]`;
  const el = [...H.root.querySelectorAll(sel)].find((x) => !!x.closest('.h-dlg') === inDlg);
  if (el) el.focus({ preventScroll: true });
}

// The pending question, or null once its turn is stored (the final answer replaces the block).
function livePending() {
  const p = A.pending;
  if (!p) return null;
  // A new thread asked from a rec is stored once the rec has an attached thread with the turn.
  const k = p.key || (p.recId ? recKey(p.recId) : null);
  return k && meCount(k) > p.n ? null : p;
}

// The pending block for a rec dialog: the question in flight when it was asked from this rec or
// into the thread the dialog shows (threadKey, possibly asked on the Ask page), else ''.
export function recPendingHtml(recId, threadKey) {
  if (!H || !H.api) return '';
  const p = livePending();
  if (!p || !((recId && p.recId === recId) || (threadKey && p.key === threadKey))) return '';
  return pendingHtml(p);
}

// True while a question is in flight (one at a time, from the Ask page or a rec dialog).
export function askBusy() { return !!A.pending; }

// Moves a new conversation in flight (no thread yet, not asked from a rec) to another host, so the
// thread its answer creates is adopted there (Open in panel while the first answer streams).
export function handPending(host) {
  if (newOnAsk(A.pending)) A.pending.host = host;
}

// A step, unless it repeats the item right before it (the stored list collapses the same way).
function pushStep(p, label) {
  const last = p.items[p.items.length - 1];
  if (!(last && last.k === 'step' && last.label === label)) p.items.push({ k: 'step', label });
}

function pushNote(p, text) {
  if (typeof text === 'string' && text.trim()) p.items.push({ k: 'note', text });
}

// An interim round's text moves into the block as a note. A reset clears the stream; on a
// regeneration the revision step has already arrived, so the cleared text has a stated reason.
function streamEvent(p, name, data) {
  if (A.pending !== p) return;
  if (name === 'progress' && data && typeof data.label === 'string') {
    pushStep(p, data.label);
  } else if (name === 'text' && data && typeof data.text === 'string') {
    p.stream += data.text;
    p.streamed = true;
  } else if (name === 'interim') {
    const t = data && typeof data.text === 'string' && data.text.trim() ? data.text : p.stream;
    pushNote(p, t);
    p.stream = '';
  } else if (name === 'reset') {
    p.stream = '';
  } else if (name === 'recovering') {
    p.stream = '';
    pushStep(p, RECOVERING);
  } else return;
  paintLive(p);
}

// th null with a pending new thread: the question shows in place while the thread is created.
function threadHtml(th, host) {
  const { esc, thread, icon } = H;
  const key = th ? keyOf(th) : '';
  const msgs = th ? H.arr(H.api.conversation(key)) : [];
  let p = A.pending;
  if (p && p.key && p.key === key && meCount(key) > p.n) p = null;
  // This thread's question, or a new thread started on this page (not one asked from a rec).
  const mine = p && (th ? p.key === key : newOnAsk(p)) ? p : null;
  const trashed = !!(th && th.trashedAt);
  const title = th && A.renaming === th.id
    ? `<input class="h-askx-rename" type="text" maxlength="60" value="${esc(A.renameVal)}" placeholder="${NEW_TITLE}" aria-label="Conversation name" autocomplete="off" data-draft="rename">`
    : `<h2 class="h-askx-title">${esc(th ? titleOf(th) : NEW_TITLE)}</h2>`;
  const tag = trashed ? '<span class="h-askx-tag">In Trash</span>' : th && th.archivedAt ? '<span class="h-askx-tag">Archived</span>' : '';
  const rename = th && !trashed ? `<button type="button" class="h-askx-ib" data-thread-act="rename" data-tid="${esc(th.id)}" aria-label="Rename" title="Rename">${I.pen}</button>` : '';
  const foot = trashed
    ? `<div class="h-askx-trashbar"><p class="h-askx-trashed">In Trash. Restore it to continue.</p><button type="button" class="h-btn" data-thread-act="restore" data-tid="${esc(th.id)}">${icon('back')}Restore</button></div>`
    : composeHtml(key, th ? key : NEW_DRAFT, true, !!A.pending);
  // In the panel the title sits in the panel bar: no header, menu or rename here.
  const head = host === 'panel' ? '' : `<header class="h-askx-head">${menuBtn()}${title}${tag}${th ? ctxChip(th) : ''}${rename}${H.askPanelBtn ? H.askPanelBtn() : ''}</header>`;
  return `<section class="h-askx-main">
    ${head}
    <div class="h-askx-msgs">${thread(msgs)}${mine ? pendingHtml(mine) : ''}</div>
    ${foot}
  </section>`;
}

// The main pane alone (a thread, or the new-conversation state) for a host: 'page' or 'panel'.
export function paneHtml(id, host = 'page') {
  const th = threadById(id);
  return th || newOnAsk(A.pending) ? threadHtml(th, host) : emptyHtml(host);
}

export function render(id) {
  const th = threadById(id);
  const key = th ? keyOf(th) : '';
  const n = key ? H.arr(H.api.conversation(key)).length : 0;
  const shown = th ? th.id : '';
  const here = !!(H.root && H.root.querySelector('.h-root .h-askx-main'));
  if (!here || shown !== A.lastId) {
    A.side = false;
    if (A.renaming && A.renaming !== shown) A.renaming = null;
    A.lastId = shown;
    A.lastN = n;
    // Opening a thread lands on its latest question; a thread just created by a streamed answer
    // keeps the place the owner was reading.
    if (th && !(newOnAsk(A.pending) && A.pending.streamed)) queueMicrotask(scrollToLastMine);
  } else if (th && n > A.lastN) {
    A.lastN = n;
    // A streamed answer was read in place while it arrived; keep the owner where they are.
    if (!(A.pending && A.pending.streamed)) queueMicrotask(scrollToLastMine);
  } else {
    A.lastN = n;
  }
  return H.shell(`<div class="h-askx">${sideHtml(shown)}${paneHtml(id)}</div>`);
}

/* ---------- scrolling and focus ---------- */

function scrollEnd() {
  try { window.scrollTo(0, document.documentElement.scrollHeight); } catch (e) { /* ignore */ }
}

// The element a host's pane lives in: the Ask panel, or the page. Null when the panel is closed.
const scopeOf = (host) => (H.root ? H.root.querySelector(host === 'panel' ? '.h-askp' : '.h-root') : null);

// A new answer: put the question that asked it just under the sticky headers (in the panel, at
// the top of the panel's own scroller).
function scrollToLastMine(host) {
  const scope = scopeOf(host);
  if (!scope) return;
  const list = scope.querySelectorAll('.h-askx-msgs .h-msg.me');
  const el = list[list.length - 1];
  if (host === 'panel') {
    const box = scope.querySelector('.h-askp-body');
    if (box && el) box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 12;
    return;
  }
  if (!el) { scrollEnd(); return; }
  const head = scope.querySelector('.h-askx-head');
  const under = head ? head.getBoundingClientRect().bottom : 0;
  try { window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - under - 16)); } catch (e) { /* ignore */ }
}

// The rec dialog: bring the pending block into view inside the dialog (the page under it stays).
function scrollDialogPend() {
  const el = H.root && H.root.querySelector('.h-dlg .h-askx-pend');
  if (el) try { el.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ }
}

function focusRecInput(recId) {
  const el = H.root && H.root.querySelector(`.h-dlg form.h-compose[data-free="rec:${CSS.escape(recId)}"] input[name="q"]`);
  if (el) el.focus();
}

function focusInput(host) {
  const scope = scopeOf(host);
  const el = scope && scope.querySelector('form.h-askx-compose textarea[name="q"]');
  if (!el) return false;
  el.focus();
  const n = el.value.length;
  try { el.setSelectionRange(n, n); } catch (e) { /* ignore */ }
  return true;
}

export function newConversation() {
  if (H.askClear) H.askClear();
  A.side = false;
  A.renaming = null;
  if (onAsk() && !(H.api.route.params && H.api.route.params.id)) H.draw();
  else H.api.go('ask', {});
  focusInput();
}

/* ---------- asking ---------- */

// Shows the question at once and keeps the composer read-only until the answer lands. text is
// what the pending block shows; questionId (a starter id, or an index into rec.qa with recId) asks
// the canned question instead of the text. key null starts a new thread, asked from recId when set.
// On failure the core keeps the old state and shows its error line; typed text goes back in the
// composer. Returns false when nothing was sent.
function sendAsk({ key, recId, text, questionId, draftKey, refocus, host = 'page' }) {
  if (A.pending || !text) return false;
  // A panel question after the owner moved to another page starts a new conversation (askBegin).
  const k = host === 'panel' && H.askBegin && H.askBegin() ? null : (key || null);
  const rid = recId || null;
  const hasQ = questionId != null && questionId !== '';
  // items: the work block's steps and notes; stream: this round's tentative text; open: null
  // follows the auto rule, true or false is the owner's choice for this answer. host: where it
  // was asked ('page', 'panel' or 'dialog').
  const pend = { key: k, recId: rid, text, n: k ? meCount(k) : 0, items: [], stream: '', streamed: false, open: null, t0: Date.now(), host };
  A.pending = pend;
  if (draftKey) H.ui.draft[draftKey] = '';
  H.draw();
  // The question goes to the top of the view (inside the dialog for a rec); the answer grows below.
  if (rid) scrollDialogPend(); else scrollToLastMine(host);
  const api = H.api;
  const live = api.engineOn() && typeof api.askStream === 'function';
  const onEvent = (name, data) => streamEvent(pend, name, data);
  const q = hasQ ? { questionId } : { text };
  // References (kind and id) the owner put in the composer, when there are any.
  const context = H.askRefs ? H.askRefs(host) : [];
  if (context.length) q.context = context;
  const req = live
    ? (k ? api.askStream(q, k, onEvent) : api.newThreadStream({ ...q, recId: rid }, onEvent))
    : (k ? (hasQ ? api.ask(questionId, k, { context: q.context }) : api.askFree(text, k, { context: q.context })) : api.newThread({ ...q, recId: rid }));
  Promise.resolve(req).then((res) => {
    if (A.pending === pend) A.pending = null;
    if (!H.api) return;
    const ok = k ? meCount(k) > pend.n : !!res;
    if (!ok && draftKey && !hasQ && !H.ui.draft[draftKey]) H.ui.draft[draftKey] = text;
    // pend.host, not the host it was sent from: Open in panel may have handed it over (handPending).
    if (!k && res && res.thread && H.onThread) H.onThread(res.thread, pend.host);
    H.draw();
    if (ok && refocus) { if (rid) focusRecInput(rid); else focusInput(pend.host); }
  });
  return true;
}

const hostOf = (el) => (el && el.closest && el.closest('.h-askp') ? 'panel' : 'page');

// A question from a rec dialog, asked into the rec's attached thread (none: a new thread asked
// from the rec); text is the typed or chip text, questionId the rec.qa index for a chip. Returns
// false when another question is still in flight.
export function askWargame(text) {
  return sendAsk({ key: null, text, host: 'panel' });
}

export function askFromRec({ recId, text, questionId, draftKey, refocus }) {
  if (!H || !H.api || !recId) return false;
  return sendAsk({ key: recKey(recId), recId, text: String(text || '').trim(), questionId, draftKey, refocus, host: 'dialog' });
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
  const undo = e.target.closest('[data-undo-action]');
  if (undo && H?.root?.contains(undo)) {
    e.preventDefault();
    undo.disabled = true;
    const ctl = undo.dataset.blkCtl;
    Promise.resolve(H.api.actionUndo(undo.dataset.undoAction)).finally(() => {
      if (undo.isConnected) undo.disabled = false;
      if (ctl) H.root.querySelector(`[data-blk-ctl="${CSS.escape(ctl)}"]`)?.focus({ preventScroll: true });
    });
    return true;
  }
  if (proposalClick(e)) return true;
  const root = H.root;
  if (!root || !H.api) return false;
  // A context chip opens the rec dialog (design.js, data-go="rec"); the phone sidebar closes first.
  if (A.side && e.target.closest('a.h-askx-ctx')) A.side = false;
  const t = e.target.closest(ASK_SEL);
  const w0 = e.target.closest('button.h-work-row');
  const w = w0 && root.contains(w0) ? { key: w0.dataset.work, open: w0.getAttribute('aria-expanded') === 'true', inDlg: !!w0.closest('.h-dlg') } : null;
  // A click anywhere else while renaming saves the name, like leaving the field.
  if (A.renaming && !e.target.closest('input.h-askx-rename') && !(t && t.dataset.threadAct === 'rename')) commitRename(false);
  if (w) { e.preventDefault(); toggleWork(w); return true; }
  if (!t || !root.contains(t)) return false;
  const d = t.dataset;
  if (d.starter != null) {
    e.preventDefault();
    const s = H.arr(H.api.askStarters()).find((x) => String(x.id) === d.starter);
    if (s) sendAsk({ key: null, text: s.q, questionId: String(s.id), refocus: false, host: hostOf(t) });
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
  sendAsk({ key: f.dataset.key || null, text: ta.value.trim(), draftKey: ta.dataset.draft, refocus: document.activeElement === ta, host: hostOf(f) });
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
export function prefillAsk(text) {
  if (!H || !text) return;
  H.ui.draft[NEW_DRAFT] = String(text);
  A.side = false;
  A.renaming = null;
  H.api.go('ask', {});
  H.draw();
  focusInput();
}

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
