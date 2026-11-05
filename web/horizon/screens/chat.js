/* Horizon chat: the Sources disclosure under each Fathom answer, and the confirm card for a
   proposed rec change.
   Message bodies arrive as stored HTML: figure tokens render through api.t as .fx-fig, numbers a
   tool grounded are .fx-src spans, and numbers nothing supports are .fx-unverified spans. This
   module only adds the provenance list and the card; it never re-renders the body.
   Chat never writes: a proposal (provenance.proposal {recId, action, wake?}) changes the rec only
   when the owner clicks Confirm, through the ordinary rec action (api.act). The card wording comes
   from a fixed action map and the rec, never from model text; the wake label is escaped text. */

import { ACTION_STATUS } from '/shared/rules.mjs';
import { escapeUserText } from '/shared/tokens.mjs';

let H = null;

export function bind(kit) { H = kit; }

const GROUNDED = 'Every number is from your data or a tool result.';
const UNVERIFIED = 'Some numbers could not be verified and are marked.';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const ACTION_LABEL = { accept: 'Accept', start: 'Start', complete: 'Mark done', dismiss: 'Dismiss', snooze: 'Snooze', reopen: 'Reopen' };

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
  return `<div class="h-proposal"><p><span class="h-proposal-k">Proposed:</span> ${label} <b>${T(r.title)}</b>${wake ? ` until ${escapeUserText(wake)}` : ''}</p>`
    + (done
      ? '<span class="h-proposal-done">Done</span>'
      : `<button type="button" class="h-btn pri h-propose" data-propose-rec="${esc(r.id)}" data-propose-action="${esc(p.action)}"${wake ? ` data-propose-wake="${escapeUserText(wake)}"` : ''}>Confirm</button>`)
    + '</div>';
}

// Returns true when the click was handled here.
export function onClick(e) {
  const t = e.target.closest('button.h-propose[data-propose-rec]');
  if (!t || !H.root.contains(t)) return false;
  e.preventDefault();
  const d = t.dataset;
  H.api.act(d.proposeRec, d.proposeAction, d.proposeAction === 'snooze' ? d.proposeWake : undefined);
  return true;
}
