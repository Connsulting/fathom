// What an Ask answer leaves out, from the tool results it read.
//
// leftOutOf(toolResults) -> [{ code, text, fix }]: every figure gap in a non-error result in plain
//   words (gap-words.mjs), plus one 'truncated' line per truncated result; deduped by text, at most 8.
// continueRead(name, args, result, call) -> an open-ended transactions search read on, page by page,
//   up to CONTINUE_CAP rows; any other read comes back unchanged.

import { GAP_CODES } from '../calc/figure.mjs';
import { plainGap } from '../shared/gap-words.mjs';

export const CONTINUE_CAP = 200;
const MAX_ENTRIES = 8;
const NOUNS = { spending: 'spending', accounts: 'balance', calculate: 'calculation' };
const num = n => n.toLocaleString('en-US');

function gapsOf(value, out, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value.gaps)) for (const g of value.gaps) if (g && GAP_CODES.includes(g.code)) out.push(g);
  for (const child of Object.values(value)) gapsOf(child, out, seen);
  return out;
}

function truncationText(name, result) {
  if (name === 'transactions' && Array.isArray(result.rows) && Number.isFinite(result.total))
    return `Showed the first ${num(result.rows.length)} of ${num(result.total)} matching transactions.`;
  if (name === 'knowledge' && Array.isArray(result.results) && Number.isFinite(result.total))
    return `Showed the first ${num(result.results.length)} of ${num(result.total)} matching entries.`;
  const noun = NOUNS[name] ?? String(name).replaceAll('_', ' ');
  return `Part of the ${noun} result was cut to fit, so the answer covers only part of it.`;
}

export function leftOutOf(toolResults) {
  const out = new Map();
  const add = entry => { if (!out.has(entry.text)) out.set(entry.text, entry); };
  for (const r of toolResults ?? []) {
    if (!r || r.isError || !r.result || typeof r.result !== 'object') continue;
    for (const g of gapsOf(r.result, [])) add(plainGap(g));
    if (r.result.truncated === true) add({ code: 'truncated', text: truncationText(r.name, r.result), fix: null });
  }
  return [...out.values()].slice(0, MAX_ENTRIES);
}

export async function continueRead(name, args, result, call) {
  if (name !== 'transactions' || args?.operation !== 'search' || !result?.truncated || !result.next
    || args.limit !== undefined || args.cursor !== undefined || args.ids !== undefined) return result;
  let merged = { ...result, rows: [...result.rows] };
  while (merged.truncated && merged.next && merged.rows.length < CONTINUE_CAP) {
    // Each page asks only for the rows left under the cap, so its next cursor stays exact.
    const page = await call({ ...args, cursor: merged.next, limit: CONTINUE_CAP - merged.rows.length });
    merged = { ...page, total: merged.total, rows: [...merged.rows, ...page.rows] };
  }
  return merged;
}
