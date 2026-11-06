// Answer text shared by the server (grounded rendering) and the browser (the streaming preview).
// Served to the browser at /shared/answer-text.mjs, so it imports nothing outside src/shared.
//
// stripSources(text) -> text without a trailing "Sources:" paragraph, heading block or sentence.
// listMarkerSpans(text) -> [{ index, length }] of ordered-list markers ("1. ") at line starts, which
//   grounding masks (a list number is not a figure).
// markdownBlocks(html) -> [block] from escaped HTML: each block is either paragraph inner HTML (the
//   caller wraps it in <p>) or a complete <ul>/<ol>. Only paragraphs, "- " / "* " bullets, "1. "
//   numbered lists and **bold** are recognized; the input is already escaped, so every tag in the
//   output is one of p, ul, ol, li, strong or a span the caller added.
// isListBlock(block) -> true for a <ul>/<ol> block (not wrapped in <p>).
// streamHtml(text, resolveToken?) -> HTML for a partial model answer while it streams: escaped,
//   with every number and every scenario token in a neutral .fx-checking span (never .fx-src or
//   .fx-fig), Sources stripped and a half-written trailing token hidden. resolveToken(token) returns
//   the token's plain text or null ("..." is shown).

import { escapeUserText } from './tokens.mjs';

const LABEL = '(?:[*_]{1,2})?\\s*(?:sources?|references?|citations?)\\s*(?:[*_]{1,2})?';
const LEAD_BLOCK = new RegExp(`^\\s*${LABEL}[ \\t]*(?::|\\n|$)`, 'i');
const TAIL_SENTENCE = new RegExp(`([.!?)])[ \\t]+${LABEL}\\s*:[^\\n]*$`, 'i');
const TAIL_LINE = new RegExp(`\\n[ \\t]*${LABEL}\\s*:[^\\n]*$`, 'i');

export function stripSources(text) {
  let s = String(text ?? '').replace(/\s+$/, '');
  for (;;) {
    const blocks = s.split(/\n[ \t]*\n/);
    if (blocks.length < 2 || !LEAD_BLOCK.test(blocks.at(-1))) break;
    s = blocks.slice(0, -1).join('\n\n').replace(/\s+$/, '');
  }
  if (LEAD_BLOCK.test(s) && !/\n[ \t]*\n/.test(s)) return s;
  return s.replace(TAIL_LINE, '').replace(TAIL_SENTENCE, '$1').replace(/\s+$/, '');
}

const OL_MARK = /^([ \t]*)(\d{1,2})[.)](?=[ \t])/gm;

export function listMarkerSpans(text) {
  return [...String(text ?? '').matchAll(OL_MARK)].map(m => ({ index: m.index + m[1].length, length: m[0].length - m[1].length }));
}

const UL = /^[-*•+][ \t]+(.*)$/;
const OL = /^(\d{1,2})[.)][ \t]+(.*)$/;
// Bold over plain escaped text or whole spans the caller added; never across a partial tag.
const BOLD = /\*\*(?=\S)((?:[^*<]|<span\b[^>]*>[^<]*<\/span>)+?)\*\*/g;

const inline = s => s.replace(BOLD, '<strong>$1</strong>');

export function markdownBlocks(html) {
  const out = [];
  for (const block of String(html ?? '').split(/\n[ \t]*\n\s*/)) {
    let para = [];
    let list = null;
    const flushP = () => { if (para.length) out.push(inline(para.join('\n'))); para = []; };
    const flushL = () => {
      if (!list) return;
      const start = list.tag === 'ol' && list.start !== 1 ? ` start="${list.start}"` : '';
      out.push(`<${list.tag}${start}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
      list = null;
    };
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const u = UL.exec(line);
      const o = u ? null : OL.exec(line);
      if (u || o) {
        flushP();
        const tag = u ? 'ul' : 'ol';
        if (list && list.tag !== tag) flushL();
        list ??= { tag, start: o ? Number(o[1]) : 1, items: [] };
        list.items.push(u ? u[1] : o[2]);
      } else {
        flushL();
        para.push(line);
      }
    }
    flushP();
    flushL();
  }
  return out.filter(b => b.replace(/<[^>]*>/g, '').trim() !== '' || /<span\b/.test(b));
}

export const isListBlock = block => /^<(?:ul|ol)[\s>]/.test(block);

export const wrapBlocks = blocks => blocks.map(b => (isListBlock(b) ? b : `<p>${b}</p>`)).join('');

const TOKEN_LIKE = /\{(?:fk|f|l|p|n):[^{}]*\}/g;
// A number, as the grounding check reads one, without its magnitude words (they stay plain text).
const NUMBER = /-?\$?\d(?:[\d,]*\d)?(?:\.\d+)?%?/g;
const CHECKING = '<span class="fx-checking" title="Checking this number">';

function checkingNumbers(segment) {
  let out = '';
  let at = 0;
  for (const m of segment.matchAll(NUMBER)) {
    const lineStart = m.index === 0 || segment[m.index - 1] === '\n';
    // An ordered-list marker stays plain so the list still reads as a list.
    if (lineStart && /^\d{1,2}$/.test(m[0]) && /^[.)][ \t]/.test(segment.slice(m.index + m[0].length))) continue;
    out += escapeUserText(segment.slice(at, m.index)) + CHECKING + escapeUserText(m[0]) + '</span>';
    at = m.index + m[0].length;
  }
  return out + escapeUserText(segment.slice(at));
}

export function streamHtml(text, resolveToken = () => null) {
  const s = stripSources(String(text ?? '').replace(/\{[^{}\s]*$/, ''));
  let html = '';
  let at = 0;
  for (const m of s.matchAll(TOKEN_LIKE)) {
    html += checkingNumbers(s.slice(at, m.index));
    let shown = null;
    try { shown = resolveToken(m[0]); } catch { shown = null; }
    html += CHECKING + escapeUserText(typeof shown === 'string' && shown ? shown : '...') + '</span>';
    at = m.index + m[0].length;
  }
  html += checkingNumbers(s.slice(at));
  return wrapBlocks(markdownBlocks(html));
}
