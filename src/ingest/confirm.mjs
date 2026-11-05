// Confirm queue: short questions an import asks so its rows land in the right place, answered by
// the owner and remembered by (kind, subject) so an equivalent re-import asks nothing new.
// Every answer is applied by deterministic code in one transaction with the answer itself.

import { tx, parseJson } from '../store/db.mjs';
import { upsertFact, deleteFact } from '../store/facts.mjs';
import { dedupeKey } from './dedupe.mjs';
import { cents } from './format.mjs';

export const KINDS = Object.freeze([
  'account_owner', 'account_kind', 'entity_alias', 'tax_year', 'fact_check', 'near_duplicate', 'employer_relation', 'employer_recipient', 'document_recipient',
]);

export const OWNER_OPTIONS = Object.freeze([
  { id: 'owner', label: 'You' }, { id: 'spouse', label: 'Your spouse' }, { id: 'joint', label: 'Joint' }, { id: 'business', label: 'Business' },
]);
export const KIND_OPTIONS = Object.freeze([
  { id: 'checking', label: 'Checking' }, { id: 'cash', label: 'Savings or cash' }, { id: 'card', label: 'Credit card' },
  { id: 'taxable', label: 'Taxable brokerage' }, { id: 'retirement', label: 'Retirement' }, { id: 'roth', label: 'Roth' },
  { id: 'hsa', label: 'HSA' }, { id: '529', label: '529 plan' }, { id: 'business', label: 'Business' }, { id: 'loan', label: 'Loan' },
]);
export const FACT_CHECK_OPTIONS = Object.freeze([{ id: 'yes', label: 'Yes, that is right' }, { id: 'no', label: 'No, ignore it' }]);
export const NEAR_DUPLICATE_OPTIONS = Object.freeze([{ id: 'same', label: 'Same transaction, keep one' }, { id: 'different', label: 'Different, keep both' }]);
export const EMPLOYER_OPTIONS = Object.freeze([{ id: 'outside', label: 'An outside employer' }, { id: 'household', label: 'Our own business' }]);
export const EMPLOYER_RECIPIENT_OPTIONS = Object.freeze([{ id: 'owner', label: 'You' }, { id: 'spouse', label: 'Your spouse' }, { id: 'both', label: 'Both of you' }]);
export const DOCUMENT_RECIPIENT_OPTIONS = Object.freeze([{ id: 'owner', label: 'You' }, { id: 'spouse', label: 'Your spouse' }]);
// Who a withholding row belongs to: the last segment of its wh: slot and tax_payments.recipient.
export const RECIPIENTS = Object.freeze(['owner', 'spouse', 'unknown']);
export const taxYearOptions = (year) => [
  { id: 'tax_year', label: `Tax year ${year}` },
  { id: 'payment_year', label: `Paid during ${year}; January counts toward ${year - 1}` },
];

// Below this extraction confidence a fact is stored unconfirmed and asked about.
export const CONFIDENCE_FLOOR = 0.8;

const STATUS = { not_found: 404, bad_option: 400, answered: 409, stale: 409 };
export class ConfirmError extends Error {
  constructor(code) {
    super(`confirm item ${code.replace('_', ' ')}`);
    this.name = 'ConfirmError';
    this.code = code;
    this.status = STATUS[code] ?? 400;
  }
}

// Normalized names: lowercase letters and digits only (the dedupe.mjs rule).
export const normalizeName = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])])) : value;
export const canonicalJson = (value) => JSON.stringify(canonical(value));
const stamp = (now) => now || new Date().toISOString();

function itemOf(row) {
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    question: row.question,
    options: parseJson(row.options, []),
    context: parseJson(row.context, {}),
    status: row.status,
    answer: row.answer ?? null,
    fileId: row.file_id ?? null,
    createdAt: row.created_at,
  };
}

const findItem = (db, kind, subject) => {
  const row = db.prepare('SELECT * FROM confirm_items WHERE kind = ? AND subject = ?').get(kind, subject);
  return row ? itemOf(row) : null;
};

export function getItem(db, id) {
  const row = db.prepare('SELECT * FROM confirm_items WHERE id = ?').get(id);
  return row ? itemOf(row) : null;
}

export function pendingItems(db) {
  return db.prepare("SELECT * FROM confirm_items WHERE status = 'pending' ORDER BY id").all().map(itemOf);
}

export function listItems(db, { status = 'pending' } = {}) {
  if (status === 'all') return db.prepare('SELECT * FROM confirm_items ORDER BY id').all().map(itemOf);
  if (!['pending', 'answered'].includes(status)) throw new ConfirmError('bad_option');
  return db.prepare('SELECT * FROM confirm_items WHERE status = ? ORDER BY id').all(status).map(itemOf);
}

// Queue a question unless its (kind, subject) is already pending or answered. An answered one is
// applied again to the new data (its stored answer with the new context) and reported remembered.
// Returns {remembered: true, factsChanged} | {existing: true} | {queued: true, id}.
export function ask(db, { kind, subject, question, options, context = {}, fileId = null, now } = {}) {
  if (!KINDS.includes(kind)) throw new TypeError('Unknown confirm kind');
  const prior = findItem(db, kind, subject);
  if (prior && prior.status === 'answered') {
    const applied = applyAnswer(db, { ...prior, context: { ...prior.context, ...context } }, prior.answer, { now });
    return applied.factsChanged ? { remembered: true, factsChanged: true } : { remembered: true };
  }
  if (prior) return { existing: true };
  const r = db.prepare(`INSERT INTO confirm_items (kind, subject, question, options, context, status, file_id, created_at)
                        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .run(kind, subject, question, JSON.stringify(options), JSON.stringify(context ?? {}), fileId, stamp(now));
  return { queued: true, id: Number(r.lastInsertRowid) };
}

// Answer a pending item: refusals change nothing; otherwise the answer is applied and recorded in
// one transaction. Returns the answered item. Pack state is not refreshed here; a caller that
// needs it uses answerItem(), which also reports whether facts changed.
export function answer(db, id, optionId, { now } = {}) {
  return answerItem(db, id, optionId, { now }).item;
}

// answer() plus whether facts changed, for callers that refresh pack state.
export function answerItem(db, id, optionId, { now } = {}) {
  const n = Number(id);
  const item = Number.isInteger(n) && n > 0 ? getItem(db, n) : null;
  if (!item) throw new ConfirmError('not_found');
  if (item.status === 'answered') throw new ConfirmError(item.answer === 'superseded' ? 'stale' : 'answered');
  if (!item.options.some((o) => o.id === optionId)) throw new ConfirmError('bad_option');
  if (item.kind === 'fact_check' && factIsStale(db, item)) throw new ConfirmError('stale');
  return tx(db, () => {
    const { factsChanged } = applyAnswer(db, item, optionId, { now });
    db.prepare("UPDATE confirm_items SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?").run(optionId, stamp(now), item.id);
    return { item: getItem(db, item.id), factsChanged: Boolean(factsChanged) };
  });
}

function factIsStale(db, item) {
  const current = db.prepare('SELECT value FROM facts WHERE key = ?').get(item.context.key);
  if (!current) return false;
  return canonicalJson(parseJson(current.value, null)) !== canonicalJson(item.context.value);
}

// Apply an answer by kind. Returns {factsChanged}.
export function applyAnswer(db, item, optionId, { now } = {}) {
  switch (item.kind) {
    case 'account_owner': {
      const option = OWNER_OPTIONS.find((o) => o.id === optionId);
      if (option) db.prepare('UPDATE accounts SET owner = ? WHERE id = ?').run(option.label, item.subject);
      return {};
    }
    case 'account_kind':
      if (KIND_OPTIONS.some((o) => o.id === optionId)) db.prepare('UPDATE accounts SET kind = ? WHERE id = ?').run(optionId, item.subject);
      return {};
    case 'entity_alias':
      if (typeof optionId === 'string' && optionId.startsWith('entity:')) mergeAlias(db, item.subject, optionId.slice('entity:'.length), { now });
      return {};
    case 'tax_year':
      applyTaxYear(db, item.subject, optionId);
      return {};
    case 'fact_check':
      return applyFactCheck(db, item, optionId, { now });
    case 'near_duplicate':
      if (optionId === 'same') confirmDuplicate(db, item, { now });
      return {};
    case 'employer_relation':
      return applyEmployer(db, item.subject, optionId, { now });
    case 'employer_recipient':
      applyEmployerRecipient(db, item, optionId, { now });
      return {};
    case 'document_recipient':
      if (optionId === 'owner' || optionId === 'spouse') {
        setRecipient(db, db.prepare('SELECT * FROM tax_payments WHERE payer = ? ORDER BY id').all(item.subject), optionId, { now });
      }
      return {};
    default:
      return {};
  }
}

// entity_alias: record the alias, move its P&L rows to the canonical entity and merge collisions.
function mergeAlias(db, alias, entity, { now }) {
  db.prepare(`INSERT INTO entity_aliases (alias, entity, created_at) VALUES (?, ?, ?)
              ON CONFLICT(alias) DO UPDATE SET entity = excluded.entity`).run(alias, entity, stamp(now));
  const rows = db.prepare('SELECT * FROM pnl_lines ORDER BY id').all().filter((r) => normalizeName(r.entity) === alias && r.entity !== entity);
  const byKey = db.prepare('SELECT * FROM pnl_lines WHERE dedupe_key = ?');
  for (const row of rows) {
    const key = dedupeKey({ kind: 'pnl_line', entity, period: row.period, category: row.category });
    const slot = `pnl:${normalizeName(entity)}:${row.period.slice(0, 4)}`;
    const target = byKey.get(key);
    if (target && target.id !== row.id) {
      const cells = [...(parseJson(target.locator, {})?.cells ?? []), ...(parseJson(row.locator, {})?.cells ?? [])];
      const locator = { ...parseJson(target.locator, {}), cells };
      db.prepare('UPDATE pnl_lines SET amount = ?, locator = ? WHERE id = ?').run(cents(target.amount + row.amount), JSON.stringify(locator), target.id);
      archive(db, 'pnl_lines', row, { by: target.file_id, reason: 'alias_merged', now });
      db.prepare('DELETE FROM pnl_lines WHERE id = ?').run(row.id);
    } else {
      db.prepare('UPDATE pnl_lines SET entity = ?, dedupe_key = ?, source_slot = ? WHERE id = ?').run(entity, key, slot, row.id);
    }
  }
}

// tax_year: subject tax:<sheetYear>. tax_year keeps the sheet year; payment_year moves January
// rows to the prior tax year. Applies to every workbook row of that sheet year.
function applyTaxYear(db, subject, optionId) {
  const year = Number(/^tax:(\d{4})$/.exec(subject)?.[1]);
  if (!year) return;
  const basis = optionId === 'payment_year' ? 'confirmed_payment_year' : 'confirmed_tax_year';
  const update = db.prepare('UPDATE tax_payments SET tax_year = ?, tax_year_basis = ? WHERE id = ?');
  for (const row of db.prepare("SELECT id, date FROM tax_payments WHERE source_slot LIKE ?").all(`tax:${year}:%`)) {
    const taxYear = optionId === 'payment_year' && row.date.slice(5, 7) === '01' ? year - 1 : year;
    update.run(taxYear, basis, row.id);
  }
}

function applyFactCheck(db, item, optionId, { now }) {
  const { key, value, fileId = null, parser = null, locator = null, src = null, asOf = null } = item.context;
  if (typeof key !== 'string') return {};
  if (optionId === 'yes') {
    const r = upsertFact(db, { key, value, src, asOf, confirmed: true, provenance: { fileId, parser, locator }, now });
    return { factsChanged: r.written };
  }
  if (optionId === 'no') {
    const current = db.prepare('SELECT value, file_id, confirmed FROM facts WHERE key = ?').get(key);
    if (current && !current.confirmed && canonicalJson(parseJson(current.value, null)) === canonicalJson(value)) {
      return { factsChanged: deleteFact(db, key, { fileId: current.file_id }).deleted };
    }
  }
  return {};
}

// near_duplicate same: the newer row (higher id) is archived and removed. The tombstone keeps the
// row's normalized description, so a later row with its key is skipped only when it is that posting,
// and the kept row's key, so a later collision on the dropped key is asked about against it.
function confirmDuplicate(db, item, { now }) {
  const keys = item.subject.split('|');
  const rows = keys.map((k) => db.prepare('SELECT * FROM transactions WHERE dedupe_key = ?').get(k)).filter(Boolean);
  if (rows.length < 2) return;
  const [keep, drop] = rows.sort((a, b) => a.id - b.id);
  archive(db, 'transactions', { ...drop, normalized_description: normalizeName(drop.description) }, { by: keep.file_id, reason: 'duplicate_confirmed', now, survivorKey: keep.dedupe_key });
  db.prepare('DELETE FROM transactions WHERE id = ?').run(drop.id);
}

// employer_relation: apply every held assertion for this employer, then drop the holds.
function applyEmployer(db, employerKey, optionId, { now }) {
  const hold = `employer:${employerKey}`;
  const held = db.prepare('SELECT * FROM held_facts WHERE hold = ? ORDER BY id').all(hold);
  let factsChanged = false;
  for (const h of held) {
    let key = h.key;
    let value = parseJson(h.value, null);
    if (optionId === 'household') {
      if (h.key !== 'income.w2') continue;
      key = 'income.sCorp';
      value = true;
    } else if (optionId !== 'outside') continue;
    const file = h.file_id ? db.prepare('SELECT source_id, period_to FROM files WHERE id = ?').get(h.file_id) : null;
    const r = recordFact(db, {
      key, value, confidence: h.confidence, sourceId: file?.source_id ?? null, fileId: h.file_id, parser: h.parser,
      locator: parseJson(h.locator, null), asOf: file?.period_to ?? stamp(now).slice(0, 10), now,
    });
    if (r.written) factsChanged = true;
  }
  if (optionId === 'outside' || optionId === 'household') db.prepare('DELETE FROM held_facts WHERE hold = ?').run(hold);
  return { factsChanged };
}

// Withholding recipients (D4). Withholding slots are wh:<payerKey>:...; the recipient is the
// slot's last segment. An employer's withholding rows are its paystub and W-2 rows.
export const withRecipient = (slot, recipient) => String(slot).replace(/:[^:]*$/, `:${recipient}`);
// G4: the payer identity of a withholding row. While the recipient is unknown it is
// <R10 payer>:doc:<file id>, so two members' identical documents never collapse; once resolved it
// is <R10 payer>:<recipient>.
export const recipientPayer = (payer, recipient, fileId) => (recipient === 'unknown' ? `${payer}:doc:${fileId}` : `${payer}:${recipient}`);
const unresolvedPayer = (payer) => String(payer).replace(/:doc:[^:]*$/, '');
const employerRows = (db, employerKey) => db.prepare(`SELECT * FROM tax_payments WHERE source_slot LIKE ?
  AND (payer LIKE 'paystub:%' OR payer LIKE 'w2:%') ORDER BY id`).all(`wh:${employerKey}:%:unknown`);

// A 1099 payer identity starts with the form kind (1099-int), whose label is the kind in capitals.
function documentQuestion(payer, issuer) {
  const [kind, , when] = String(payer).split(':');
  const from = issuer ? ` from ${issuer}` : '';
  if (kind === 'w2') return `Whose ${when} W-2${from} is this?`;
  if (kind === 'paystub') return `Whose paystub${from} paid on ${when} is this?`;
  return `Whose ${when} ${kind.toUpperCase()}${from} is this?`;
}
const askDocument = (db, { employerKey = null, employer = '', issuer = '', payer, fileId = null, now }) => ask(db, {
  kind: 'document_recipient', subject: payer, question: documentQuestion(payer, employerKey ? employer : issuer), options: DOCUMENT_RECIPIENT_OPTIONS,
  context: employerKey ? { employerKey, employer, payer } : { issuer, payer }, fileId, now,
});

// The recipient of a withholding row at import. Remembered answers decide it; otherwise it is
// unknown and the open question is asked: for employer withholding the employer question, or per
// document after "both"; for a 1099 (no employerKey) the document question directly.
// Returns {recipient, outcome} where outcome is ask()'s result when a question was asked.
export function withholdingRecipient(db, { employerKey = null, employer = '', issuer = '', payer, fileId = null, now } = {}) {
  if (!employerKey) {
    const byDocument = findItem(db, 'document_recipient', payer);
    if (byDocument?.status === 'answered') return { recipient: byDocument.answer };
    return { recipient: 'unknown', outcome: askDocument(db, { issuer, payer, fileId, now }) };
  }
  const byEmployer = findItem(db, 'employer_recipient', employerKey);
  if (byEmployer?.status === 'answered' && byEmployer.answer !== 'both') return { recipient: byEmployer.answer };
  if (byEmployer?.status === 'answered') {
    const byDocument = findItem(db, 'document_recipient', payer);
    if (byDocument?.status === 'answered') return { recipient: byDocument.answer };
    return { recipient: 'unknown', outcome: askDocument(db, { employerKey, employer: employer || byEmployer.context.employer, payer, fileId, now }) };
  }
  const question = employer ? `Who is paid by ${employer}?` : 'Who is paid by this employer?';
  return {
    recipient: 'unknown',
    outcome: ask(db, { kind: 'employer_recipient', subject: employerKey, question, options: EMPLOYER_RECIPIENT_OPTIONS, context: { employerKey, employer }, fileId, now }),
  };
}

// R15 per recipient slot: a W-2 row in a slot with a known recipient summarizes that slot's paystub
// rows (archived as summarized, then removed). An unknown slot never summarizes. Returns the count.
export function summarizeSlot(db, slot, { now } = {}) {
  if (!String(slot ?? '').startsWith('wh:') || slot.endsWith(':unknown')) return 0;
  const w2 = db.prepare("SELECT file_id FROM tax_payments WHERE source_slot = ? AND payer LIKE 'w2:%' ORDER BY id LIMIT 1").get(slot);
  if (!w2) return 0;
  const rows = db.prepare("SELECT * FROM tax_payments WHERE source_slot = ? AND payer LIKE 'paystub:%' ORDER BY id").all(slot);
  const remove = db.prepare('DELETE FROM tax_payments WHERE id = ?');
  for (const r of rows) {
    archive(db, 'tax_payments', { ...r }, { by: w2.file_id, reason: 'summarized', now });
    remove.run(r.id);
  }
  return rows.length;
}

// Set the recipient of stored unresolved withholding rows: recompute slot and payer identity and
// rekey each row, then summarize each slot. A rekeyed row whose key another row already holds is
// the same document of the same person: the newer row (higher id) is archived as duplicate.
function setRecipient(db, rows, recipient, { now }) {
  const update = db.prepare('UPDATE tax_payments SET recipient = ?, source_slot = ?, payer = ?, dedupe_key = ? WHERE id = ?');
  const holder = db.prepare('SELECT * FROM tax_payments WHERE dedupe_key = ? AND id != ?');
  const remove = db.prepare('DELETE FROM tax_payments WHERE id = ?');
  const slots = new Set();
  for (const r of rows) {
    if (!String(r.source_slot ?? '').startsWith('wh:') || !r.source_slot.endsWith(':unknown')) continue;
    const slot = withRecipient(r.source_slot, recipient);
    const payer = `${unresolvedPayer(r.payer)}:${recipient}`;
    const key = dedupeKey({ kind: 'tax_payment', jurisdiction: r.jurisdiction, sheetYear: r.tax_year, date: r.date, payer });
    const other = holder.get(key, r.id);
    if (other && other.id < r.id) {
      archive(db, 'tax_payments', { ...r, recipient, source_slot: slot, payer, dedupe_key: key }, { by: other.file_id, reason: 'duplicate', now });
      remove.run(r.id);
      continue;
    }
    if (other) {
      archive(db, 'tax_payments', { ...other }, { by: r.file_id, reason: 'duplicate', now });
      remove.run(other.id);
    }
    update.run(recipient, slot, payer, key, r.id);
    slots.add(slot);
  }
  for (const slot of slots) summarizeSlot(db, slot, { now });
}

// employer_recipient: owner or spouse sets every withholding row of the employer; both asks per
// document (a remembered document answer applies at once).
function applyEmployerRecipient(db, item, optionId, { now }) {
  const rows = employerRows(db, item.subject);
  if (optionId === 'owner' || optionId === 'spouse') { setRecipient(db, rows, optionId, { now }); return; }
  if (optionId !== 'both') return;
  const payers = new Map();
  for (const r of rows) if (!payers.has(r.payer)) payers.set(r.payer, r.file_id);
  for (const [payer, fileId] of payers) askDocument(db, { employerKey: item.subject, employer: item.context.employer ?? '', payer, fileId, now });
}

// Write one extracted fact under the fact-check rules (R5). The subject names the logical source,
// the key and the canonical value. An answered no skips the fact; an answered yes confirms it; a
// written value closes pending checks on other values of the key; a low-confidence write asks.
// Returns {written, changed, queued}.
export function recordFact(db, { key, value, confidence = 1, sourceId = null, fileId = null, parser = null, locator = null, asOf = null, now } = {}) {
  const subject = `${sourceId ?? ''}|${key}|${canonicalJson(value)}`;
  const prior = findItem(db, 'fact_check', subject);
  if (prior && prior.status === 'answered' && prior.answer === 'no') return { written: false, changed: false, queued: false };
  const confirmed = Boolean(prior && prior.status === 'answered' && prior.answer === 'yes');
  const r = upsertFact(db, { key, value, src: sourceId, asOf, confirmed, provenance: { fileId, parser, locator }, now });
  if (!r.written) return { written: false, changed: false, queued: false };
  const json = canonicalJson(value);
  for (const p of pendingItems(db).filter((i) => i.kind === 'fact_check' && i.context.key === key && canonicalJson(i.context.value) !== json)) {
    db.prepare("UPDATE confirm_items SET status = 'answered', answer = 'superseded', answered_at = ? WHERE id = ?").run(stamp(now), p.id);
  }
  let queued = false;
  if (!confirmed && Number(confidence) < CONFIDENCE_FLOOR) {
    const context = { key, value, src: sourceId, asOf, fileId, parser, locator, confidence };
    if (prior && prior.status === 'answered') {
      // A value superseded earlier is asserted again: reopen its question for the new data.
      db.prepare("UPDATE confirm_items SET status = 'pending', answer = NULL, answered_at = NULL, context = ?, file_id = ? WHERE id = ?")
        .run(JSON.stringify(context), fileId, prior.id);
      queued = true;
    } else {
      queued = Boolean(ask(db, {
        kind: 'fact_check', subject, question: `An import says ${key} is ${json}. Is that right?`, options: FACT_CHECK_OPTIONS, context, fileId, now,
      }).queued);
    }
  }
  return { written: true, changed: r.changed, queued };
}

// Archive a stored row in superseded_rows. `by` is the file that replaced it; `survivorKey` the
// dedupe key of the row a confirmed duplicate was kept against.
export function archive(db, table, row, { by = null, reason, now, fileId, survivorKey = null } = {}) {
  db.prepare('INSERT INTO superseded_rows (table_name, dedupe_key, row, file_id, superseded_by, reason, at, survivor_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(table, row.dedupe_key ?? null, JSON.stringify(row), fileId !== undefined ? fileId : (row.file_id ?? null), by, reason, stamp(now), survivorKey);
}
