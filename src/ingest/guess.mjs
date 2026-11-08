// Legacy stored suggestion format used by card evidence and its focused tests. The scheduler
// now calls the resolver, which may answer grounded fixed choices (superseding plan D6/D7).

import { parseJson, tx } from '../store/db.mjs';

// Why a guess was made, as a fixed code the engine picks and the text shown for it.
export const REASON_CODES = ['account_name', 'institution', 'source_file', 'question', 'imported_values', 'document_type'];
export const REASON_TEXT = Object.freeze({
  account_name: 'The account name suggests this answer.',
  institution: 'The institution and account details suggest this answer.',
  source_file: 'The source file suggests this answer.',
  question: 'The wording of the question suggests this answer.',
  imported_values: 'The values imported with this question suggest this answer.',
  document_type: 'The type of document suggests this answer.',
});

export const GUESS_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    guesses: {
      type: 'array',
      items: {
        type: 'object',
        properties: { item: { type: 'integer' }, option: { type: 'string' }, basis: { type: 'string', enum: REASON_CODES } },
        required: ['item', 'option', 'basis'],
        additionalProperties: false,
      },
    },
  },
  required: ['guesses'],
  additionalProperties: false,
});

const MAX_TOKENS = 2048;

const SYSTEM = [
  'You help a household owner answer short questions about their imported financial files.',
  'For each item, pick the single most likely option id from that item\'s own options, using only that item\'s question, options, context and file metadata.',
  `Give the basis for each guess as one code from this list: ${REASON_CODES.join(', ')}.`,
  'Return JSON matching the schema: {"guesses": [{"item": <item id>, "option": <option id>, "basis": <basis code>}]}. Leave out an item you cannot judge.',
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

// Accepted guesses: the item is in the batch, the option is one of its options and the basis is
// a known code. The stored reason is the fixed text for that code, never engine prose.
export function validateGuesses(batchItems, parsed) {
  const byId = new Map(batchItems.map((i) => [i.id, i]));
  const seen = new Set();
  const out = [];
  for (const g of Array.isArray(parsed?.guesses) ? parsed.guesses : []) {
    if (!g || typeof g !== 'object') continue;
    const item = byId.get(g.item);
    if (!item || seen.has(item.id) || ['transaction_category','category_mapping'].includes(item.kind)) continue;
    if (typeof g.option !== 'string' || !item.options.some((o) => o.id === g.option)) continue;
    if (!REASON_CODES.includes(g.basis)) continue;
    seen.add(item.id);
    out.push({ item: item.id, option: g.option, reason: REASON_TEXT[g.basis] });
  }
  return out;
}

// Up to `limit` pending items with no guess row, oldest first, with their file metadata.
async function nextBatch(db, limit) {
  return (await db.prepare(`SELECT ci.id, ci.kind, ci.question, ci.options, ci.context, f.name AS file_name, f.source_kind, f.parser,
                            f.period_from, f.period_to, ci.file_id
                     FROM confirm_items ci LEFT JOIN files f ON f.id = ci.file_id
                     WHERE ci.status = 'pending' AND ci.kind NOT IN ('transaction_category','category_mapping') AND NOT EXISTS (SELECT 1 FROM confirm_guesses g WHERE g.item_id = ci.id)
                     ORDER BY ci.id LIMIT ?`).all(limit)).map((r) => ({
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
async function storeBatch(db, items, accepted, { model, ts }) {
  const byItem = new Map(accepted.map((g) => [g.item, g]));
  const put = db.prepare(`INSERT INTO confirm_guesses (item_id, option_id, reason, model, ts)
                          SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM confirm_items WHERE id = ?)
                          ON CONFLICT(item_id) DO UPDATE SET option_id = excluded.option_id, reason = excluded.reason,
                            model = excluded.model, ts = excluded.ts`);
  await tx(db, async (db) => {
    for (const item of items) {
      const g = byItem.get(item.id);
      await put.run(item.id, g ? g.option : null, g ? g.reason : null, String(model ?? 'unknown'), ts, item.id);
    }
  });
  return byItem.size;
}

// Returns {skipped: 'engine_off' | 'not_live' | 'none_pending'} or {batches: [{items, guessed,
// costUsd, model}], costUsd, stopped?: code}. costUsd is the run spend: the larger of the confirm
// ledger rows added during the run (failed calls included) and the completed batch costs. `fake` is one per-call fake script per batch (tests).
export async function guessPending(db, engine, { now, batchSize = 20, maxBatches = Infinity, fake } = {}) {
  if (!engine || !await engine.isOn()) return { skipped: 'engine_off' };
  if (fake === undefined && engine.mode !== 'live') return { skipped: 'not_live' };
  const size = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 20;
  const batches = [];
  const mark = (await db.prepare('SELECT coalesce(max(id), 0) AS id FROM spend_ledger').get()).id;
  const spend = db.prepare("SELECT coalesce(sum(cost_usd), 0) AS s FROM spend_ledger WHERE purpose = 'confirm' AND id > ?");
  const costUsd = async () => Number(Math.max(Number((await spend.get(mark)).s) || 0,
    batches.reduce((n, b) => n + (Number(b.costUsd) || 0), 0)).toFixed(12));
  for (let k = 0; k < maxBatches; k++) {
    const items = await nextBatch(db, size);
    if (!items.length) break;
    let response;
    try {
      response = await engine.call({
        purpose: 'confirm', system: SYSTEM, schema: GUESS_SCHEMA, maxTokens: MAX_TOKENS,
        messages: [{ role: 'user', content: JSON.stringify({ items: items.map(payloadOf) }) }],
        ...(fake === undefined ? {} : { fake: fake[k] ?? [] }),
      });
    } catch (error) {
      return { batches, costUsd: await costUsd(), stopped: codeOf(error) };
    }
    let parsed;
    try { parsed = JSON.parse(response.text); } catch { return { batches, costUsd: await costUsd(), stopped: 'bad_response' }; }
    const ts = now || new Date().toISOString();
    const guessed = await storeBatch(db, items, validateGuesses(items, parsed), { model: response.model, ts });
    batches.push({ items: items.length, guessed, costUsd: response.costUsd, model: response.model });
  }
  if (!batches.length) return { skipped: 'none_pending' };
  return { batches, costUsd: await costUsd() };
}
