// Answer text shared by the server (grounded rendering) and the browser (the streaming preview).
// Served to the browser at /shared/answer-text.mjs, so it imports nothing outside src/shared.
//
// stripSources(text) -> text without citations. A citation is a capitalized or all-caps Source,
//   Reference or Citation label (singular or plural, optionally emphasized) and a colon, at text,
//   paragraph or list item start or after a finished sentence, with the quoted titles, URLs and
//   bare titles after it through the sentence end. A citation filling its line removes the line
//   (list marker included); a label line heading a list removes the list. Only whitespace touched by
//   a removal is cleaned. Text that would be left empty is returned unchanged.
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

const LABELS = '(?:Sources?|References?|Citations?|SOURCES?|REFERENCES?|CITATIONS?)';
const EM = '(?:[*_]{1,2})?';
const CITE_LABEL = new RegExp(`${EM}${LABELS}${EM}[ \\t]*:${EM}`, 'y');
const HEADING = new RegExp(`^[ \\t]*${EM}${LABELS}${EM}[ \\t]*:?[ \\t]*${EM}[ \\t]*$`);
const LIST_ITEM = /^[ \t]*(?:[-*•+]|\d{1,2}[.)])[ \t]+/;
const AFTER_SENTENCE = /[.!?]["'”’)\]]?[ \t]+$/;
const ENDS_SENTENCE = /[.!?]["'”’)\]]?[ \t]*$/;
const QUOTE_CLOSE = { '"': '"', '“': '”', '‘': '’' };
const URL_SPAN = /^https?:\/\/[^\s"“”]*[^\s.,;:!?"“”)\]]/i;
const BARE_TITLE = /^[^,;]*?(?=[.!?](?:\s|$)|[,;]|$)/;
const JOINER = /^(?:,|;|and(?=[ \t]))/;
const blank = line => !line.trim();

// From just after the colon (within one line): quoted titles, URLs and bare titles joined by commas,
// semicolons or "and", through the sentence end. An unclosed quote runs to the line end.
function consumeCitation(line, start) {
  let j = start;
  let expectItem = true;
  let titleEnded = false;
  for (;;) {
    const k = j + /^[ \t]*/.exec(line.slice(j))[0].length;
    const body = line.slice(k);
    if (expectItem) {
      if (!body) return k;
      const close = QUOTE_CLOSE[body[0]];
      if (close) {
        const end = body.indexOf(close, 1);
        if (end < 0) return line.length;
        titleEnded = /[.!?]$/.test(body.slice(1, end));
        j = k + end + 1;
      } else {
        const span = URL_SPAN.exec(body) ?? BARE_TITLE.exec(body);
        if (!span || !span[0].length) return j;
        titleEnded = false;
        j = k + span[0].length;
      }
      expectItem = false;
      continue;
    }
    const joiner = JOINER.exec(body);
    if (joiner) { j = k + joiner[0].length; expectItem = true; continue; }
    if (!titleEnded && /^[.!?](?=\s|$)/.test(body)) return k + 1;
    return j;
  }
}

// One line without its citations, or null when the citations filled it. `lineStart` says whether
// the line's first character is at a boundary (text start, paragraph start, after a finished sentence).
function stripLine(line, lineStart) {
  const item = LIST_ITEM.exec(line);
  const contentStart = item ? item[0].length : /^[ \t]*/.exec(line)[0].length;
  let out = '';
  let removed = false;
  let i = 0;
  while (i < line.length) {
    CITE_LABEL.lastIndex = i;
    const m = CITE_LABEL.exec(line);
    const boundary = m && (i === contentStart ? (item || lineStart) : AFTER_SENTENCE.test(line.slice(0, i)));
    if (!boundary) { out += line[i]; i += 1; continue; }
    const end = consumeCitation(line, i + m[0].length);
    if (i === contentStart && blank(line.slice(end))) return null;
    removed = true;
    let after = end;
    while (line[after] === ' ' || line[after] === '\t') after += 1;
    if (after >= line.length) out = out.replace(/[ \t]+$/, '');
    else if (out && !/\s$/.test(out)) out += ' ';
    i = after;
  }
  // A line left as nothing or a bare list marker goes too.
  if (removed && blank(`${out} `.replace(LIST_ITEM, ''))) return null;
  return out;
}

export function stripSources(text) {
  const input = String(text ?? '');
  const lines = input.split('\n');
  const drop = new Array(lines.length).fill(false);
  // Heading blocks: a paragraph whose first line is the label alone and whose other lines are list items.
  for (let i = 0; i < lines.length; i++) {
    if (blank(lines[i]) || (i > 0 && !blank(lines[i - 1])) || !HEADING.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !blank(lines[j]) && LIST_ITEM.test(lines[j])) j += 1;
    if (j > i + 1 && (j === lines.length || blank(lines[j]))) drop.fill(true, i, j);
  }
  const kept = lines.map((line, i) => {
    if (drop[i]) return null;
    const lineStart = i === 0 || blank(lines[i - 1]) || ENDS_SENTENCE.test(lines[i - 1]);
    return stripLine(line, lineStart);
  });
  // Rejoin. Blank lines next to a removed line collapse to one, and none are left at either end.
  const out = [];
  let touched = false;
  for (const line of kept) {
    if (line === null) { touched = true; continue; }
    if (touched) {
      if (blank(line) && (!out.length || blank(out.at(-1)))) continue;
      if (!blank(line)) touched = false;
    }
    out.push(line);
  }
  if (touched) while (out.length && blank(out.at(-1))) out.pop();
  const result = out.join('\n');
  return blank(result) ? input : result;
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
