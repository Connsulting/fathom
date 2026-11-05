// Engine best guesses for pending confirm questions (plan D6, D7). guessPending sends pending
// questions with no guess row in batches, one engine call each (purpose 'confirm'), and stores a
// row for every question sent: the option when the guess passes validateGuesses, else NULL, so a
// question is never sent twice. A guess never answers anything. Only a live engine, or a per-call
// fake script (tests), is called; engine errors stop the run and are returned as `stopped`.

import { parseJson, tx } from '../store/db.mjs';

export const GUESS_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    guesses: {
      type: 'array',
      items: {
        type: 'object',
        properties: { item: { type: 'integer' }, option: { type: 'string' }, reason: { type: 'string' } },
        required: ['item', 'option', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['guesses'],
  additionalProperties: false,
});

export const REASON_MAX = 160;
const MAX_TOKENS = 2048;

const SYSTEM = [
  'You help a household owner answer short questions about their imported financial files.',
  'For each item, pick the single most likely option id from that item\'s own options, using only that item\'s question, options, context and file metadata.',
  `Give a one-line reason of at most ${REASON_MAX} characters. Never state a number that does not appear in that item.`,
  'Return JSON matching the schema: {"guesses": [{"item": <item id>, "option": <option id>, "reason": <reason>}]}. Leave out an item you cannot judge.',
].join(' ');

// Drop every locator (cell or row references into the file) from a context value.
function withoutLocator(value) {
  if (Array.isArray(value)) return value.map(withoutLocator);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== 'locator').map(([k, v]) => [k, withoutLocator(v)]));
}

// What the engine sees of one item. `file` is the joined file metadata or null.
const payloadOf = (item) => ({
  id: item.id,
  kind: item.kind,
  question: item.question,
  options: item.options.map((o) => ({ id: o.id, label: o.label })),
  context: withoutLocator(item.context ?? {}),
  file: item.file ?? null,
});

// Digit runs with optional thousands commas and decimals (2026, 4,521, 12.50), commas removed.
const numbersIn = (text) => (String(text).match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ''));

// Every number in the item's question, option labels, context and file metadata, as written and
// as a numeric value (12.50 and 12.5).
function itemNumbers(item) {
  const p = payloadOf(item);
  const nums = numbersIn(JSON.stringify([p.question, p.options.map((o) => o.label), p.context, p.file]));
  return new Set([...nums, ...nums.map((n) => String(Number(n)))]);
}

// Accepted guesses: the item is in the batch, the option is one of its options, and the reason
// is one nonempty line of at most REASON_MAX characters quoting only numbers from that item.
export function validateGuesses(batchItems, parsed) {
  const byId = new Map(batchItems.map((i) => [i.id, i]));
  const seen = new Set();
  const out = [];
  for (const g of Array.isArray(parsed?.guesses) ? parsed.guesses : []) {
    if (!g || typeof g !== 'object') continue;
    const item = byId.get(g.item);
    if (!item || seen.has(item.id)) continue;
    if (typeof g.option !== 'string' || !item.options.some((o) => o.id === g.option)) continue;
    const reason = g.reason;
    if (typeof reason !== 'string' || !reason.trim() || reason.length > REASON_MAX || /[\r\n\u2028\u2029]/.test(reason)) continue;
    const known = itemNumbers(item);
    if (!numbersIn(reason).every((n) => known.has(n) || known.has(String(Number(n))))) continue;
    seen.add(item.id);
    out.push({ item: item.id, option: g.option, reason });
  }
  return out;
}

// Up to `limit` pending items with no guess row, oldest first, with their file metadata.
function nextBatch(db, limit) {
  return db.prepare(`SELECT ci.id, ci.kind, ci.question, ci.options, ci.context, f.name AS file_name, f.source_kind, f.parser,
                            f.period_from, f.period_to, ci.file_id
                     FROM confirm_items ci LEFT JOIN files f ON f.id = ci.file_id
                     WHERE ci.status = 'pending' AND NOT EXISTS (SELECT 1 FROM confirm_guesses g WHERE g.item_id = ci.id)
                     ORDER BY ci.id LIMIT ?`).all(limit).map((r) => ({
    id: r.id,
    kind: r.kind,
    question: r.question,
    options: parseJson(r.options, []),
    context: parseJson(r.context, {}),
    file: r.file_id == null || r.file_name == null ? null
      : { name: r.file_name, sourceKind: r.source_kind ?? null, parser: r.parser ?? null, periodFrom: r.period_from ?? null, periodTo: r.period_to ?? null },
  }));
}

// A short code for a stopped run; never a message or a value.
const codeOf = (error) => (error && typeof error.name === 'string' && error.name !== 'Error' ? error.name : 'error');

// One row per item sent; an item removed meanwhile is skipped.
function storeBatch(db, items, accepted, { model, ts }) {
  const byItem = new Map(accepted.map((g) => [g.item, g]));
  const put = db.prepare(`INSERT INTO confirm_guesses (item_id, option_id, reason, model, ts)
                          SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM confirm_items WHERE id = ?)
                          ON CONFLICT(item_id) DO UPDATE SET option_id = excluded.option_id, reason = excluded.reason,
                            model = excluded.model, ts = excluded.ts`);
  tx(db, () => {
    for (const item of items) {
      const g = byItem.get(item.id);
      put.run(item.id, g ? g.option : null, g ? g.reason : null, String(model ?? 'unknown'), ts, item.id);
    }
  });
  return byItem.size;
}

// Returns {skipped: 'engine_off' | 'not_live' | 'none_pending'} or {batches: [{items, guessed,
// costUsd, model}], stopped?: code}. `fake` is one per-call fake script per batch (tests).
export async function guessPending(db, engine, { now, batchSize = 20, maxBatches = Infinity, fake } = {}) {
  if (!engine || !engine.isOn()) return { skipped: 'engine_off' };
  if (fake === undefined && engine.mode !== 'live') return { skipped: 'not_live' };
  const size = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 20;
  const batches = [];
  for (let k = 0; k < maxBatches; k++) {
    const items = nextBatch(db, size);
    if (!items.length) break;
    let response;
    try {
      response = await engine.call({
        purpose: 'confirm', system: SYSTEM, schema: GUESS_SCHEMA, maxTokens: MAX_TOKENS,
        messages: [{ role: 'user', content: JSON.stringify({ items: items.map(payloadOf) }) }],
        ...(fake === undefined ? {} : { fake: fake[k] ?? [] }),
      });
    } catch (error) {
      return { batches, stopped: codeOf(error) };
    }
    let parsed;
    try { parsed = JSON.parse(response.text); } catch { return { batches, stopped: 'bad_response' }; }
    const ts = now || new Date().toISOString();
    const guessed = storeBatch(db, items, validateGuesses(items, parsed), { model: response.model, ts });
    batches.push({ items: items.length, guessed, costUsd: response.costUsd, model: response.model });
  }
  if (!batches.length) return { skipped: 'none_pending' };
  return { batches };
}

// Fire and forget after an import (D7): one run per store at a time; a trigger that arrives
// while one runs makes it run once more after. Never throws; returns the run's promise.
const flights = new WeakMap();
export function scheduleGuesses(db, engine) {
  const running = flights.get(db);
  if (running) {
    running.again = true;
    return running.promise;
  }
  const flight = { again: false };
  flight.promise = (async () => {
    try {
      do {
        flight.again = false;
        try {
          const out = await guessPending(db, engine);
          if (out.stopped) console.error('fathom: guess run failed', out.stopped);
        } catch (error) {
          console.error('fathom: guess run failed', codeOf(error));
        }
      } while (flight.again);
    } finally {
      flights.delete(db);
    }
  })();
  flights.set(db, flight);
  return flight.promise;
}
