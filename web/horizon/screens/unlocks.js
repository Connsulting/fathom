import { gapControl } from '../../core/gap-control.js';
// H3: what unlocks an unavailable comparison, always beside it. A war game that was not built, an
// option left out for a contribution limit, and an advisor wait each carry one plain reason from the
// server and one control (TAX1's fix shape) that opens the specific answer in Ask or the upload.
// Pure markup: the click handling is design.js's data-tax-gap-fix handler. kit: {esc, T}.

// A not-built card. `legacy` renders the old page link for stored content from before fixes.
export function notBuiltHtml(name, nb, { esc, legacy }) {
  const control = nb.fix ? gapControl(nb.fix, esc, 'h-btn ghost') : legacy ? legacy(nb) : '';
  return `<article class="h-dec unbuilt" data-not-built="${esc(name)}"><div class="h-dec-b"><p>${esc(nb.text)}</p></div><div class="h-acts">${control}</div></article>`;
}

// Points or options left out of a comparison, each with its reason and fix.
export function excludedHtml(list, { esc, T }) {
  const rows = (Array.isArray(list) ? list : []).filter(e => e && typeof e.invalid === 'string');
  if (!rows.length) return '';
  return `<div class="h-blocker h-wg-excluded" role="note"><b>Left out</b>${rows.map(e =>
    `<p data-excluded="${esc(e.id)}"><span>${T(e.label)}</span>. ${esc(e.invalid)} ${gapControl(e.fix, esc)}</p>`).join('')}</div>`;
}

// The answers a recommendation or comparison waits on from the advisor, each with the control that
// records the answer the advisor gave.
export function advisorWaitsHtml(waits, { esc }) {
  const rows = (Array.isArray(waits) ? waits : []).filter(w => w && typeof w.text === 'string');
  if (!rows.length) return '';
  return `<div class="h-blocker h-advisor-waits" role="note"><b>Waiting on your advisor</b>${rows.map(w =>
    `<p data-advisor-wait="${esc(w.key)}">${esc(w.text)} ${gapControl(w.fix, esc)}</p>`).join('')}</div>`;
}

// The fix beside a reason a comparison, decision or figure is not current.
export const fixHtml = (fix, esc, cls) => (fix ? gapControl(fix, esc, cls) : '');
