/* Horizon keyboard layer: key normalization, the typing guard, fuzzy scoring and ranking for the
   quick switcher, and the binding registry with two-key sequences.
   Pure module: no DOM or window access. Elements and events are duck typed, so node:test imports
   it directly. The clock is injected. */

const MODIFIERS = new Set(['shift', 'control', 'meta', 'alt', 'altgraph', 'os', 'hyper', 'super']);

// A keydown event as a binding key: 'mod+k', 'shift+x', 'g', '?', 'escape', 'arrowdown'. Null for
// anything a binding never names (Alt chords, bare modifiers, unidentified keys).
export function normalizeKey(e) {
  if (!e || typeof e.key !== 'string' || !e.key) return null;
  const key = e.key;
  const lower = key.toLowerCase();
  if (MODIFIERS.has(lower) || lower === 'unidentified' || lower === 'dead') return null;
  if (e.altKey) return null;
  if (e.ctrlKey || e.metaKey) return 'mod+' + lower;
  if (key.length === 1) {
    if (/^[a-z]$/i.test(key)) return e.shiftKey ? 'shift+' + lower : lower;
    return key;
  }
  return lower;
}

export function isTypingTarget(el) {
  if (!el) return false;
  if (el.isContentEditable === true) return true;
  const tag = String(el.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

// Typing in a field is never hijacked; only Escape and the switcher chord reach the registry.
export function passesGuard(key, target) {
  return !isTypingTarget(target) || key === 'escape' || key === 'mod+k';
}

/* ---------- fuzzy matching ---------- */

const BOUNDARY = new Set([' ', '-', '/', '(', ')', '_', '.', ',', ':']);

function wordStarts(text) {
  const out = new Array(text.length).fill(false);
  for (let i = 0; i < text.length; i++) {
    if (i === 0) { out[i] = true; continue; }
    const p = text[i - 1], c = text[i];
    if (BOUNDARY.has(p) && !BOUNDARY.has(c)) out[i] = true;
    else if (p !== p.toUpperCase() && c === c.toUpperCase() && c !== c.toLowerCase()) out[i] = true;
  }
  return out;
}

// Prefer a consecutive letter, then the next word start, then the next occurrence.
function preferredHits(q, low, starts) {
  const hits = [];
  let from = 0;
  for (const ch of q) {
    const prev = hits.length ? hits[hits.length - 1] : -1;
    let at = -1;
    if (prev >= 0 && low[prev + 1] === ch) at = prev + 1;
    if (at < 0) for (let i = from; i < low.length; i++) if (low[i] === ch && starts[i]) { at = i; break; }
    if (at < 0) at = low.indexOf(ch, from);
    if (at < 0) return null;
    hits.push(at);
    from = at + 1;
  }
  return hits;
}

function leftmostHits(q, low) {
  const hits = [];
  let from = 0;
  for (const ch of q) {
    const at = low.indexOf(ch, from);
    if (at < 0) return null;
    hits.push(at);
    from = at + 1;
  }
  return hits;
}

// Case insensitive subsequence match. Weights, heaviest first: a match at index 0, matches at
// word starts, consecutive runs; gaps and text length cost a little.
export function fuzzyScore(query, text) {
  const q = String(query ?? '').toLowerCase().replace(/\s+/g, '');
  const t = String(text ?? '');
  if (!q) return { score: 0, hits: [] };
  const low = t.toLowerCase();
  if (low.length !== t.length) return null;
  const starts = wordStarts(t);
  const hits = preferredHits(q, low, starts) || leftmostHits(q, low);
  if (!hits) return null;
  let score = 0;
  hits.forEach((h, i) => {
    score += 1;
    if (h === 0) score += 15;
    if (starts[h]) score += 10;
    if (i > 0) {
      const gap = h - hits[i - 1] - 1;
      if (gap === 0) score += 6;
      else score -= Math.min(gap, 12) * 0.5;
    }
  });
  score -= Math.min(hits[0], 20) * 0.25;
  score -= t.length * 0.1;
  return { score: Math.round(score * 100) / 100, hits };
}

const RECENT_BOOST = 30;

// items: [{ key, title, group }]; recents: item keys, most recent first.
// Returns [{ item, score, hits, recent }].
export function rankItems(items, query, recents) {
  const list = Array.isArray(items) ? items : [];
  const rec = Array.isArray(recents) ? recents : [];
  const idx = new Map();
  rec.forEach((k, i) => { if (!idx.has(k)) idx.set(k, i); });
  const q = String(query ?? '').trim();
  if (!q) {
    const byKey = new Map(list.map((it) => [it.key, it]));
    const first = [...idx.keys()].filter((k) => byKey.has(k)).map((k) => byKey.get(k));
    const seen = new Set(first.map((it) => it.key));
    return [
      ...first.map((item) => ({ item, score: 0, hits: [], recent: true })),
      ...list.filter((it) => !seen.has(it.key)).map((item) => ({ item, score: 0, hits: [], recent: false }))
    ];
  }
  const out = [];
  list.forEach((item, order) => {
    const m = fuzzyScore(q, item.title);
    if (!m) return;
    const recent = idx.has(item.key);
    const score = m.score + (recent ? RECENT_BOOST - idx.get(item.key) : 0);
    out.push({ item, score, hits: m.hits, recent, order });
  });
  out.sort((a, b) => b.score - a.score || a.order - b.order);
  return out.map(({ item, score, hits, recent }) => ({ item, score, hits, recent }));
}

/* ---------- display ---------- */

const NAMED = { arrowdown: 'Down', arrowup: 'Up', arrowleft: 'Left', arrowright: 'Right', escape: 'Esc', enter: 'Enter', tab: 'Tab', ' ': 'Space' };

function tokenText(tok) {
  if (NAMED[tok]) return NAMED[tok];
  if (tok.startsWith('mod+')) return 'Ctrl+' + tokenText(tok.slice(4));
  if (tok.startsWith('shift+')) return 'Shift+' + tokenText(tok.slice(6));
  if (tok.length === 1) return tok.toUpperCase();
  return tok.charAt(0).toUpperCase() + tok.slice(1);
}

export function hintText(keyString) {
  return String(keyString ?? '').split(' ').filter(Boolean).map(tokenText).join(' then ');
}

/* ---------- registry ---------- */

export function createKeys({ now = () => Date.now(), seqWindow = 1500 } = {}) {
  const regs = []; // { scope, bindings }
  let current = '';
  let prefix = '';
  let prefixAt = 0;

  function register(scope, bindings) {
    const entry = { scope: String(scope), bindings: Array.isArray(bindings) ? bindings : [] };
    regs.push(entry);
    return () => {
      const i = regs.indexOf(entry);
      if (i >= 0) regs.splice(i, 1);
    };
  }

  function active(opts = {}) {
    const scopes = current && current !== 'global' ? [current, 'global'] : ['global'];
    const out = [];
    for (const scope of scopes) {
      for (const r of regs) {
        if (r.scope !== scope) continue;
        for (const b of r.bindings) {
          const cond = opts.forSheet ? (b.sheetWhen ?? b.when) : b.when;
          if (typeof cond === 'function' && !cond()) continue;
          out.push({ ...b, scope });
        }
      }
    }
    return out;
  }

  const find = (list, key) => list.find((b) => Array.isArray(b.keys) && b.keys.includes(key));

  function handle(e, target) {
    if (!e || e.isComposing) return false;
    const key = normalizeKey(e);
    if (!key) return false;
    if (!passesGuard(key, target)) { prefix = ''; return false; }
    const list = active();
    if (prefix) {
      const p = prefix;
      const fresh = now() - prefixAt <= seqWindow;
      prefix = '';
      if (fresh) {
        const seq = find(list, p + ' ' + key);
        if (seq) { seq.action(e); return true; }
      }
    }
    const single = find(list, key);
    if (single) { single.action(e); return true; }
    const starts = list.some((b) => Array.isArray(b.keys) && b.keys.some((k) => k.includes(' ') && k.split(' ')[0] === key));
    if (starts) { prefix = key; prefixAt = now(); return true; }
    return false;
  }

  return {
    register,
    setScreen(name) {
      const n = String(name ?? '');
      if (n !== current) prefix = '';
      current = n;
    },
    screen: () => current,
    active,
    handle,
    pending: () => prefix,
    hintText
  };
}
