// Engine best guesses for pending confirm questions (plan D6, D7). guessPending sends pending
// questions with no guess row in batches, one engine call each (purpose 'confirm'), and stores a
// row for every question sent: the option when the guess passes validateGuesses, else NULL, so a
// question is never sent twice. A guess never answers anything. Only a live engine, or a per-call
// fake script (tests), is called; engine errors stop the run and are returned as `stopped`. The
// scheduler job 'confirm-guess' (src/jobs/scheduler.mjs) is the only caller outside tests.

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
  `Give a one-line reason of at most ${REASON_MAX} characters. The reason must contain no numbers at all: no digits and no numeric characters of any kind.`,
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

// Quantity-word vocabulary: number words, fractions and ordinals, percent words and multipliers.
// Any word ending in -fold also counts.
// A reason may use one only if the item's own text does. Matched as whole words, case-insensitive,
// in any inflected form (plural, -d, -ed, -ing); a space in an entry matches any run of whitespace.
const QUANTITY_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
  'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
  'hundred', 'thousand', 'million', 'billion', 'trillion',
  'half', 'quarter', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'percent', 'per cent', 'pct', 'percentage', 'basis point', 'bps',
  'twice', 'double', 'triple', 'quadruple', 'quintuple', 'sextuple', 'septuple', 'octuple', 'dozen', 'halve',
];
// Every inflected form mapped to its base word ("thousands" -> "thousand", "tripling" -> "triple").
const BASE_OF = new Map([['halves', 'half']]);
for (const base of QUANTITY_WORDS) {
  const stem = base.replace(/[ey]$/, '');
  const forms = [base, `${base}s`, `${base}es`, `${base}d`, `${base}ed`, `${base}ing`, `${stem}ing`];
  if (base.endsWith('y')) forms.push(`${stem}ies`);
  for (const f of forms) if (!BASE_OF.has(f)) BASE_OF.set(f, base);
}
const SPELLED = new RegExp(`\\b(?:[a-z]*fold|${[...BASE_OF.keys()].map((w) => w.replace(' ', '\\s+')).join('|')})\\b`, 'gi');
// Vocabulary words in the text, each normalized to its lowercase base word.
const spelledIn = (text) => (String(text).match(SPELLED) ?? []).map((w) => {
  const word = w.toLowerCase().replace(/\s+/g, ' ');
  return BASE_OF.get(word) ?? word;
});

// The item's own text: question, option labels, context and file metadata.
function itemText(item) {
  const p = payloadOf(item);
  return JSON.stringify([p.question, p.options.map((o) => o.label), p.context, p.file]);
}

// Accepted guesses: the item is in the batch, the option is one of its options, and the reason
// is one nonempty line of at most REASON_MAX characters with no numeric character at all and no
// quantity word (see QUANTITY_WORDS) that the item's own text lacks.
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
    const text = itemText(item);
    const words = new Set(spelledIn(text));
    if (/\p{N}/u.test(reason) || !spelledIn(reason).every((w) => words.has(w))) continue;
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
// costUsd, model}], costUsd, stopped?: code}. costUsd is the run spend: the larger of the confirm
// ledger rows added during the run (failed calls included) and the completed batch costs. `fake` is one per-call fake script per batch (tests).
export async function guessPending(db, engine, { now, batchSize = 20, maxBatches = Infinity, fake } = {}) {
  if (!engine || !engine.isOn()) return { skipped: 'engine_off' };
  if (fake === undefined && engine.mode !== 'live') return { skipped: 'not_live' };
  const size = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 20;
  const batches = [];
  const mark = db.prepare('SELECT coalesce(max(id), 0) AS id FROM spend_ledger').get().id;
  const spend = db.prepare("SELECT coalesce(sum(cost_usd), 0) AS s FROM spend_ledger WHERE purpose = 'confirm' AND id > ?");
  const costUsd = () => Number(Math.max(Number(spend.get(mark).s) || 0,
    batches.reduce((n, b) => n + (Number(b.costUsd) || 0), 0)).toFixed(12));
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
      return { batches, costUsd: costUsd(), stopped: codeOf(error) };
    }
    let parsed;
    try { parsed = JSON.parse(response.text); } catch { return { batches, costUsd: costUsd(), stopped: 'bad_response' }; }
    const ts = now || new Date().toISOString();
    const guessed = storeBatch(db, items, validateGuesses(items, parsed), { model: response.model, ts });
    batches.push({ items: items.length, guessed, costUsd: response.costUsd, model: response.model });
  }
  if (!batches.length) return { skipped: 'none_pending' };
  return { batches, costUsd: costUsd() };
}
