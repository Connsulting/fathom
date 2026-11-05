// Knowledge-base excerpts for recs: the first paragraph of a pack entry after its title and the
// Tax year / Reviewed lines, with trailing citation links dropped (the cite is separate) and other
// markdown links reduced to their text, at most 420 characters cut at a sentence end.
//
// kbExcerpt(packs, packId, entryId) -> {title, body, cite, pack} | null

import { getEntry } from '../../packs/index.mjs';

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

function cut(text) {
  if (text.length <= MAX) return text;
  const head = text.slice(0, MAX);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
  if (end > 0) return head.slice(0, end + 1);
  return head.slice(0, MAX - 3).replace(/\s+\S*$/, '') + '...';
}

export function kbExcerpt(packs, packId, entryId) {
  const entry = getEntry(packs, packId, entryId);
  if (!entry) return null;
  return {
    title: entry.title,
    body: cut(plain(firstParagraph(entry.body))),
    cite: entry.cites[0] ? entry.cites[0].label : '',
    pack: packId,
  };
}
