/* "Or tell Fathom in your own words": one free-text box under a question (a rec question form or
   a Confirm card) that hands the typed sentence to Ask. target is 'rec:<recId>' or
   'confirm:<itemId>'. Drafts survive redraws; the root handlers in design.js call ownWordsInput
   and ownWordsSend. */

export const OWN_WORDS_LABEL = 'Or tell Fathom in your own words';
const drafts = new Map();

export function ownWordsHtml(esc, target, surface = 'page') {
  const id = `ow-${surface}-${String(target).replace(/[^A-Za-z0-9_-]/g, '-')}`;
  return `<div class="h-own-words" data-own-words="${esc(target)}"><label for="${esc(id)}">${OWN_WORDS_LABEL}</label>`
    + `<textarea id="${esc(id)}" rows="2" data-own-words-text="${esc(target)}">${esc(drafts.get(target) ?? '')}</textarea>`
    + `<button type="button" class="h-btn ghost" data-own-words-send="${esc(target)}">Tell Fathom</button></div>`;
}

// Keeps the draft without a redraw so the caret stays. True when the event was a box's.
export function ownWordsInput(e) {
  const t = e.target;
  if (!t?.matches?.('textarea[data-own-words-text]')) return false;
  drafts.set(t.dataset.ownWordsText, String(t.value ?? ''));
  return true;
}

// A Tell Fathom click: {kind: 'rec' | 'confirm', id, text} with the draft cleared, or null when the
// click is not a box's. text is '' when the box is empty.
export function ownWordsSend(e) {
  const b = e.target?.closest?.('[data-own-words-send]');
  if (!b) return null;
  const target = b.dataset.ownWordsSend;
  const box = b.closest('[data-own-words]')?.querySelector('textarea[data-own-words-text]');
  const text = String(box?.value ?? drafts.get(target) ?? '').trim();
  const at = target.indexOf(':');
  if (text) drafts.delete(target);
  return { kind: target.slice(0, at), id: target.slice(at + 1), text };
}
