import { gapControl } from '../../core/gap-control.js';
// What a waiting recommendation is waiting on, in plain words, with the action that clears it and a
// link to where it is done, and the estimate gaps on inputs the rec reads, one line each. The
// planner stores the blocker on the rec while it waits; it is gone the moment the rec is no longer
// blocked. Pure markup: the click handling lives in design.js.

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
  const { esc } = H;
  const box = body => `<div class="h-blocker h-blocker-${esc(surface)}" role="note">${body}</div>`;
  // A hold shows only while the rec waits on it.
  const b = r.status === 'waiting' ? r.blocker : null;
  const waiting = b ? box(`<b>Waiting on</b><p>${esc(b.text)}</p><p class="h-blocker-do">${esc(b.task)}</p>${b.fix ? gapControl(b.fix, esc) : linkHtml(r.id, b.link)}`) : '';
  // Each gap on an input this rec reads is one line naming its fix; the full list lives on Missing data.
  const gaps = r.gaps?.length ? box(`<b>Optional estimate improvements</b>${r.gaps.map(g => `<p class="h-gap-ref" data-gap-ref="${esc(g.code)}">${esc(g.message)} ${gapControl(g.action, esc)}</p>`).join('')}`) : '';
  return waiting + gaps;
}
