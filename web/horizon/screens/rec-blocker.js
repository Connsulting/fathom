import { gapControl } from '../../core/gap-control.js';
// What a waiting recommendation is waiting on, in plain words, with the action that clears it and a
// link to where it is done. The planner stores the blocker on the rec while it waits; it is gone
// the moment the rec is no longer blocked. Pure markup: the click handling lives in design.js.

let H;
export const bind = kit => { H = kit; };

const PAGE = Object.freeze({ upload: ['add', 'Open Files'], confirm: ['confirm', 'Open Confirm'], accounts: ['money', 'Open Accounts'] });

// The link to where a task or blocker is done: a page, or Ask with this recommendation attached.
export function linkHtml(recId, link, cls = 'h-btn') {
  const { esc } = H;
  if (link === 'ask') return `<button type="button" class="${cls}" data-ask-next="${esc(recId)}">Ask about it</button>`;
  const page = PAGE[link];
  return page ? `<a class="${cls}" href="#/${page[0]}" data-go="${page[0]}">${page[1]}</a>` : '';
}

export function html(r, surface) {
  if (r.gaps?.length) return `<div class="h-blocker h-blocker-${H.esc(surface)}" role="note"><b>Optional estimate improvements</b>${r.gaps.map(g => `<p>${H.esc(g.message)} ${gapControl(g.action, H.esc)}</p>`).join('')}</div>`;
  if (r.status !== 'waiting' || !r.blocker) return '';
  const { esc } = H;
  const b = r.blocker;
  return `<div class="h-blocker h-blocker-${esc(surface)}" role="note"><b>Waiting on</b><p>${esc(b.text)}</p><p class="h-blocker-do">${esc(b.task)}</p>${b.fix ? gapControl(b.fix, esc) : linkHtml(r.id, b.link)}</div>`;
}
