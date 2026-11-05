// Knowledge-base excerpts for recs: the first paragraph of a pack entry after its title and the
// Tax year / Reviewed lines, with trailing citation links dropped (the cite is separate) and other
// markdown links reduced to their text, at most 420 characters cut at a sentence end. Title, body
// and cite are then escaped with braces neutralized (MG14), after the cut so no entity is split:
// pack text renders as text and never resolves as a scenario token.
//
// kbExcerpt(packs, packId, entryId) -> {title, body, cite, pack} | null

import { getEntry } from '../../packs/index.mjs';
import { dataText } from '../triggers/common.mjs';

const MAX = 420;

function firstParagraph(body) {
  const para = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!para.length) {
      if (!line || line.startsWith('#') || /^(tax year|reviewed)\s*:/i.test(line)) continue;
      para.push(line);
    } else if (!line || line.startsWith('#')) {
      break;
    } else {
      para.push(line);
    }
  }
  return para.join(' ');
}

function plain(text) {
  return text
    .replace(/([.!?])(?:\s*\[[^\]]*\]\([^)]*\))+\s*/g, '$1 ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cut(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
  if (end > 0) return head.slice(0, end + 1);
  return head.slice(0, max - 3).replace(/\s+\S*$/, '') + '...';
}

// The escaped excerpt stays within MAX: cut the plain text, escape, and cut shorter if escaping
// grew it past the limit.
function excerptText(text) {
  let max = MAX;
  let out = dataText(cut(text, max));
  while (out.length > MAX && max > 0) {
    max -= out.length - MAX;
    out = dataText(cut(text, Math.max(0, max)));
  }
  return out;
}

export function kbExcerpt(packs, packId, entryId) {
  const entry = getEntry(packs, packId, entryId);
  if (!entry) return null;
  return {
    title: dataText(entry.title),
    body: excerptText(plain(firstParagraph(entry.body))),
    cite: entry.cites[0] ? dataText(entry.cites[0].label) : '',
    pack: packId,
  };
}
