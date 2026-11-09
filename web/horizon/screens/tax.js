/* Horizon Tax this year (#/tax): projected, paid so far and left to pay per jurisdiction, each a
   stored planner figure with its provenance popover, and the gaps that would sharpen the estimate
   with their fixes. The model (./tax-model.js) picks the keys; this file only lays them out and does
   no money math. Also the Home card and the pace board's tax meter with no reserve recorded. */

import { gapControl } from '../../core/gap-control.js';
import { taxPanelModel, taxMeterFallback, NO_PROJECTION_FIX } from './tax-model.js';

let H = null;

export function bind(kit) { H = kit; }

const model = () => taxPanelModel(H.api.s.fig);

// A figure row: its label and the stored value. sub marks the two parts of paid so far.
function row(label, key, { sub = false, abs = false } = {}) {
  return `<div class="h-tax-r${sub ? ' sub' : ''}" data-tax-key="${H.esc(key)}"><dt>${H.esc(label)}</dt><dd>${H.figHtml(key, abs ? { abs: true } : {})}</dd></div>`;
}

function leftLabel(r) { return r.overpaid ? 'Overpaid so far' : 'Left to pay'; }

function card(r) {
  const k = r.keys;
  const rows = [
    k.proj ? row('Projected tax', k.proj) : '',
    k.paid ? row('Paid so far', k.paid) : '',
    k.withheld ? row('Withheld', k.withheld, { sub: true }) : '',
    k.estimates ? row('Estimated payments', k.estimates, { sub: true }) : '',
    k.remaining ? `<div class="h-tax-r total${r.overpaid ? ' over' : ''}" data-tax-key="${H.esc(k.remaining)}"><dt>${leftLabel(r)}</dt><dd>${H.figHtml(k.remaining, { abs: true })}</dd></div>` : ''
  ].join('');
  return `<article class="h-tax-card" data-tax-row="${H.esc(r.id)}"><h3>${H.esc(r.title)}</h3><dl>${rows}</dl></article>`;
}

function gapsHtml(gaps) {
  if (!gaps.length) return '<p class="h-mute">Nothing missing. The estimate uses everything on file.</p>';
  return `<ul class="h-tax-gaps">${gaps.map((g) => `<li data-tax-gap="${H.esc(g.code)}"${g.rough ? ' class="rough"' : ''}><p>${H.esc(g.text)}</p>${gapControl(g.fix, H.esc)}</li>`).join('')}</ul>`;
}

export function render() {
  const m = model();
  const back = `<a class="h-back" href="${H.href('home')}" data-go="home">${H.icon('back')}Home</a>`;
  const head = `<div class="h-tax-head">${m.year ? `<div class="h-kicker">Tax year ${m.year}</div>` : ''}<h1>Tax this year</h1>`
    + '<p class="h-lede">What the household is projected to owe, what is paid so far and what is left, from your stored figures.</p></div>';
  if (!m.available) {
    const none = `<p class="h-tax-none">No tax projection yet. Add an income document to project this year's tax. ${gapControl(NO_PROJECTION_FIX, H.esc)}</p>`;
    return H.shell(`<section class="h-tax">${back}${head}${none}</section>`);
  }
  const cards = `<div class="h-tax-cards">${m.rows.map(card).join('')}</div>`;
  const sharpen = H.section(`What would sharpen this${m.gaps.length ? ` <em>${m.gaps.length}</em>` : ''}`, gapsHtml(m.gaps), '', 'h-tax-sharpen');
  return H.shell(`<section class="h-tax">${back}${head}<div class="h-tax-cols"><div class="h-tax-main">${H.section('By jurisdiction', cards)}</div><div class="h-tax-side">${sharpen}</div></div></section>`);
}

// Home: the left-to-pay figures in one card that opens the screen. Empty with no federal projection.
export function homeHtml() {
  const m = model();
  if (!m.available || !m.rows.some((r) => r.id === 'fed' && r.keys.proj)) return '';
  const lines = m.rows.filter((r) => r.keys.remaining).map((r) => `<span class="h-taxh-r" data-tax-row="${H.esc(r.id)}"><span>${H.esc(r.title)} ${r.overpaid ? 'overpaid' : 'left to pay'}</span>`
    + `<b>${H.figHtml(r.keys.remaining, { abs: true, inert: true })}</b></span>`).join('');
  const body = lines || '<span class="h-taxh-r"><span>Projection on file</span></span>';
  return `<div class="h-home-sec h-taxh-sec"><h2>Tax this year</h2></div>`
    + `<a class="h-taxh" href="${H.href('tax')}" data-go="tax" aria-label="Tax this year">${body}<span class="h-taxh-go">See Tax this year${H.icon('arrow')}</span></a>`;
}

// The pace board's tax meter when no reserve is recorded: paid so far against projected, in words,
// a link to the screen and the one control to say where tax money is set aside. Null when no
// federal projection is stored.
export function meterFallbackHtml(label) {
  const fb = taxMeterFallback(H.api.s.fig);
  if (!fb) return null;
  const word = { fed: 'federal', state: 'state' };
  const parts = fb.parts.map((p) => (p.paid
    ? `Paid ${H.figHtml(p.paid)} of ${H.figHtml(p.proj)} projected ${word[p.id]} tax`
    : `${H.figHtml(p.proj)} projected ${word[p.id]} tax`));
  return `<div class="h-meter" data-meter="tax"><div class="h-meter-top"><span>${label}</span></div>`
    + `<p class="h-meter-none h-tax-meter">No tax reserve is tracked yet. ${parts.join('. ')}.</p>`
    + `<p class="h-tax-meter-acts"><a class="h-link" href="${H.href('tax')}" data-go="tax">See Tax this year</a>${gapControl(fb.fix, H.esc, 'h-link')}</p></div>`;
}
