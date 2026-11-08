/* Memories view model: what Fathom has been told to remember (scenario preferences, newest first).
   Pure functions; no DOM and no api, so node can import it. */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const arr = (a) => (Array.isArray(a) ? a : []);
const ASK_KEY = /^ask:[a-f0-9]{12}$/;

// The filter box shows only when there are at least this many memories.
export const FILTER_MIN = 6;

export function summaryLine(n) {
  const k = Number(n) || 0;
  if (k <= 0) return 'Fathom does not remember anything yet';
  return `Fathom remembers ${k} ${k === 1 ? 'thing' : 'things'}`;
}

// The Settings row for the What Fathom knows page: route, link label and the one-line summary.
export function settingsRow(memories) {
  return { route: 'memories', label: 'What Fathom knows', desc: summaryLine(arr(memories).length) };
}

// The packs that are on, in the order given.
export const activePacks = (packs) => arr(packs).filter((p) => p && p.status === 'active');

// A pack's status line in plain words. The server explains a status with the rule it matched
// ("Matching activation rule: income.sCorp is true (eq true: true)."); that sentence is for
// developers, so it is dropped and any plain sentence after it is kept.
const RULE = /^(Matching (activation|suggestion) rule\b.*?|No matching activation or suggestion rule)\.(\s+|$)/;
const STATUS_LINE = {
  active: 'On because it applies to your household.',
  suggested: 'Might apply to your household.',
  exploring: 'You are exploring this with a what-if.',
  available: 'Not on for your household. Ask a what-if to explore it.'
};
export function packLine(pack) {
  const why = String(pack?.why ?? '').trim();
  const plain = RULE.test(why) ? why.replace(RULE, '').trim() : why;
  return plain || STATUS_LINE[pack?.status] || '';
}

// Case-insensitive substring match on the memory text; an empty query keeps every memory.
export function filterMemories(list, query) {
  const q = String(query ?? '').trim().toLowerCase();
  const all = arr(list);
  if (!q) return all.slice();
  return all.filter((m) => String(m?.text ?? '').toLowerCase().includes(q));
}

// Where a memory came from. threads is api.threads(): { id, key, title, trashedAt, ... }. A thread
// in the trash is not linked.
export function sourceOf(memory, threads) {
  const m = memory || {};
  const key = typeof m.conversationKey === 'string' && ASK_KEY.test(m.conversationKey) ? m.conversationKey : null;
  if (key) {
    const id = key.slice(4);
    const t = arr(threads).find((x) => x && (x.key === key || x.id === id));
    if (t && !t.trashedAt) {
      const title = typeof t.title === 'string' && t.title.trim() ? t.title.trim() : 'an Ask conversation';
      return { kind: 'ask', threadId: id, label: title };
    }
  }
  if (m.origin === 'ask') return { kind: 'ask', threadId: null, label: 'Ask' };
  if (m.origin === 'you') return { kind: 'you', label: 'Added by you' };
  return { kind: 'earlier', label: 'Added earlier' };
}

// 'Nov 6' in UTC, with the year when it is not the year of now; '' when iso does not parse.
export function whenLabel(iso, now = new Date()) {
  if (iso == null || iso === '') return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const n = new Date(now);
  const year = Number.isNaN(n.getTime()) ? null : n.getUTCFullYear();
  const base = `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return year === d.getUTCFullYear() ? base : `${base}, ${d.getUTCFullYear()}`;
}
