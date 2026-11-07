import { assertCurrentPair, mergeAccounts, refreshMergedAccounts } from './account-merge.mjs';
// Confirm queue: short questions an import asks so its rows land in the right place, answered by
// the owner and remembered by (kind, subject) so an equivalent re-import asks nothing new.
// Every answer is applied by deterministic code in one transaction with the answer itself.
// Fathom answers some questions itself (auto.mjs, through recordAutoAnswer): such an answer carries
// a confirm_auto row with its rule and evidence, and undoing the answers it rests on undoes it too.

import { tx, parseJson } from '../store/db.mjs';
import { upsertFact, deleteFact } from '../store/facts.mjs';
import { dedupeKey } from './dedupe.mjs';
import { cents } from './format.mjs';
import { captureChanges, revertChanges, touches } from './undo.mjs';

export const KINDS = Object.freeze([
  'account_owner', 'account_kind', 'entity_alias', 'tax_year', 'fact_check', 'near_duplicate', 'employer_relation', 'employer_recipient', 'document_recipient',
  'withholding_conflict', 'account_match',
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
export const ACCOUNT_MATCH_OPTIONS = Object.freeze([{ id: 'same', label: 'Same account, merge them' }, { id: 'different', label: 'Different accounts, keep both' }]);
export const EMPLOYER_OPTIONS = Object.freeze([{ id: 'outside', label: 'An outside employer' }, { id: 'household', label: 'Our own business' }]);
export const EMPLOYER_RECIPIENT_OPTIONS = Object.freeze([{ id: 'owner', label: 'You' }, { id: 'spouse', label: 'Your spouse' }, { id: 'both', label: 'Both of you' }]);
export const DOCUMENT_RECIPIENT_OPTIONS = Object.freeze([{ id: 'owner', label: 'You' }, { id: 'spouse', label: 'Your spouse' }]);
export const WITHHOLDING_CONFLICT_OPTIONS = Object.freeze([
  { id: 'first', label: 'Keep the earlier import' }, { id: 'second', label: 'Keep the later import' }, { id: 'both', label: 'Both are real payments' },
]);
// Who a withholding row belongs to: the last segment of its wh: slot and tax_payments.recipient.
export const RECIPIENTS = Object.freeze(['owner', 'spouse', 'unknown']);
export const taxYearOptions = (year) => [
  { id: 'tax_year', label: `Tax year ${year}` },
  { id: 'payment_year', label: `Paid during ${year}; January counts toward ${year - 1}` },
];

// Below this extraction confidence a fact is stored unconfirmed and asked about.
export const CONFIDENCE_FLOOR = 0.8;

const STATUS = { not_found: 404, bad_option: 400, answered: 409, stale: 409, final: 409, not_answered: 409 };
// `final` carries `reason`: no_undo, imported_since, changed_since or used_since.
export class ConfirmError extends Error {
  constructor(code, reason) {
    super(`confirm item ${code.replace('_', ' ')}`);
    this.name = 'ConfirmError';
    this.code = code;
    this.status = STATUS[code] ?? 400;
    if (reason !== undefined) this.reason = reason;
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
    markUsed(db, prior.id, { now });
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
  const item = answerable(db, id, optionId);
  return tx(db, () => {
    const { factsChanged } = recordAnswer(db, item, optionId, { now });
    return { item: getItem(db, item.id), factsChanged: Boolean(factsChanged) };
  });
}

// The pending item an answer acts on, or the refusal (not_found, answered, bad_option, stale).
function answerable(db, id, optionId) {
  const n = Number(id);
  const item = Number.isInteger(n) && n > 0 ? getItem(db, n) : null;
  if (!item) throw new ConfirmError('not_found');
  if (item.status === 'answered') throw new ConfirmError(item.answer === 'superseded' ? 'stale' : 'answered');
  if (!item.options.some((o) => o.id === optionId)) throw new ConfirmError('bad_option');
  if (optionId !== 'different') assertCurrentPair(db, item);
  if (item.kind === 'fact_check' && factIsStale(db, item)) throw new ConfirmError('stale');
  if (item.kind === 'withholding_conflict' && !conflictCurrent(db, item)) throw new ConfirmError('stale');
  return item;
}

// Answer several pending items in one transaction, each with its own undo log (a group card).
// Every refusal is checked before any write, and again as each row is answered, so any refusal
// changes nothing. answers: [{id, option}]. Returns {items, factsChanged}.
export function answerItems(db, answers, { now } = {}) {
  const list = Array.isArray(answers) ? answers : [];
  for (const a of list) answerable(db, a?.id, a?.option);
  return tx(db, () => {
    let factsChanged = false;
    const items = list.map((a) => {
      const item = answerable(db, a.id, a.option);
      if (recordAnswer(db, item, a.option, { now }).factsChanged) factsChanged = true;
      return getItem(db, item.id);
    });
    return { items, factsChanged };
  });
}

// An answer Fathom made itself: refused like answerItem; otherwise recorded through the same path
// in its own transaction, with the confirm_auto row inside the captured log. evidence is
// {text, basis: item ids, ancestors: item ids, refs?}. Returns the answered item.
export function recordAutoAnswer(db, itemId, optionId, { rule, evidence, now } = {}) {
  if (typeof rule !== 'string' || !rule) throw new TypeError('An auto answer needs its rule');
  const ids = (v) => (Array.isArray(v) ? v.filter((n) => Number.isInteger(n)) : []);
  if (!evidence || typeof evidence.text !== 'string' || !evidence.text) throw new TypeError('An auto answer needs its evidence text');
  const stored = { text: evidence.text, basis: ids(evidence.basis), ancestors: ids(evidence.ancestors), ...(evidence.refs ? { refs: evidence.refs } : {}) };
  const item = answerable(db, itemId, optionId);
  return tx(db, () => {
    recordAnswer(db, item, optionId, { now, auto: { rule, evidence: stored } });
    return getItem(db, item.id);
  });
}

// The auto answer record of an item: {rule, evidence, createdAt}, or null when the owner answered
// it or it is pending.
export function autoInfo(db, itemId) {
  const row = db.prepare('SELECT rule, evidence, created_at FROM confirm_auto WHERE item_id = ?').get(Number(itemId));
  return row ? { rule: row.rule, evidence: parseJson(row.evidence, { text: '', basis: [], ancestors: [] }), createdAt: row.created_at } : null;
}

// Apply and record an answer inside the caller's transaction, storing its change log with the
// ingest epoch (D1, D2). An auto answer ({rule, evidence}) writes its confirm_auto row inside the
// log, so reverting the answer removes it. Returns applyAnswer's result plus the log.
function recordAnswer(db, item, optionId, { now, auto = null }) {
  const { result, changes } = captureChanges(db, () => {
    const applied = applyAnswer(db, item, optionId, { now });
    db.prepare("UPDATE confirm_items SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?").run(optionId, stamp(now), item.id);
    if (auto) {
      db.prepare(`INSERT INTO confirm_auto (item_id, rule, evidence, created_at) VALUES (?, ?, ?, ?)
                  ON CONFLICT(item_id) DO UPDATE SET rule = excluded.rule, evidence = excluded.evidence, created_at = excluded.created_at`)
        .run(item.id, auto.rule, JSON.stringify(auto.evidence), stamp(now));
    }
    return applied;
  });
  db.prepare(`INSERT INTO confirm_undo (item_id, ingest_epoch, changes, created_at, used_at) VALUES (?, ?, ?, ?, NULL)
              ON CONFLICT(item_id) DO UPDATE SET ingest_epoch = excluded.ingest_epoch, changes = excluded.changes,
                created_at = excluded.created_at, used_at = NULL`)
    .run(item.id, ingestEpoch(db), JSON.stringify(changes), stamp(now));
  if (item.context?.repair) refreshMergedAccounts(db, { now: stamp(now) });
  return { ...result, changes };
}

const ingestEpoch = (db) => db.prepare('SELECT coalesce((SELECT n FROM ingest_epoch WHERE id = 1), 0) AS n').get().n;

// D3: a later import or planning run re-applied this answer to rows outside its log, so it is
// final from now on (used_since).
function markUsed(db, id, { now } = {}) {
  db.prepare('UPDATE confirm_undo SET used_at = coalesce(used_at, ?) WHERE item_id = ?').run(stamp(now), id);
}

// Why an answered item can no longer be revised or reopened, or null when it can (and for a
// pending item). Cheap: a later change to a logged row (changed_since) shows only on revert. An
// auto answer to account_owner or account_kind is not final on a later import (imported_since):
// its account columns revert one by one, so an ordinary import does not block it.
const IMPORT_EXEMPT = ['account_owner', 'account_kind'];
export function finalReason(db, item) {
  if (!item || item.status !== 'answered') return null;
  if (item.answer === 'superseded') return 'stale';
  const undo = db.prepare('SELECT ingest_epoch, used_at FROM confirm_undo WHERE item_id = ?').get(item.id);
  if (!undo) return 'no_undo';
  if (undo.used_at != null) return 'used_since';
  if (undo.ingest_epoch !== ingestEpoch(db) && !(IMPORT_EXEMPT.includes(item.kind) && hasAuto(db, item.id))) return 'imported_since';
  return null;
}

const hasAuto = (db, id) => Boolean(db.prepare('SELECT 1 FROM confirm_auto WHERE item_id = ?').get(id));

// The answered item a revise or reopen acts on, or the refusal.
function answeredItem(db, id) {
  const n = Number(id);
  const item = Number.isInteger(n) && n > 0 ? getItem(db, n) : null;
  if (!item) throw new ConfirmError('not_found');
  if (item.status !== 'answered') throw new ConfirmError('not_answered');
  if (item.answer === 'superseded') throw new ConfirmError('stale');
  return item;
}

// Undo the stored answer of an answered item inside the caller's transaction and drop its undo
// row. Returns the log it reverted.
function revertAnswer(db, item) {
  const reason = finalReason(db, item);
  if (reason) throw new ConfirmError('final', reason);
  const changes = parseJson(db.prepare('SELECT changes FROM confirm_undo WHERE item_id = ?').get(item.id).changes, null);
  if (!Array.isArray(changes)) throw new ConfirmError('final', 'no_undo');
  revertChanges(db, changes);
  db.prepare('DELETE FROM confirm_undo WHERE item_id = ?').run(item.id);
  if (item.context?.repair) refreshMergedAccounts(db);
  return changes;
}

// Auto answers that rest on an item: confirm_auto rows whose evidence.ancestors (the transitive
// closure stored at answer time) include it, newest first.
function dependentsOf(db, id) {
  return db.prepare('SELECT item_id, evidence FROM confirm_auto ORDER BY created_at DESC, item_id DESC').all()
    .filter((r) => (parseJson(r.evidence, {})?.ancestors ?? []).includes(id)).map((r) => r.item_id);
}

// Revert the auto answers resting on an item, each in its own savepoint: a final one, or one whose
// revert fails, stays answered. Returns the reverted logs.
function revertDependents(db, id) {
  const logs = [];
  for (const depId of dependentsOf(db, id)) {
    const dep = getItem(db, depId);
    if (!dep || dep.status !== 'answered' || finalReason(db, dep)) continue;
    db.exec('SAVEPOINT confirm_dependent');
    try {
      logs.push(...revertAnswer(db, dep));
      db.exec('RELEASE confirm_dependent');
    } catch {
      db.exec('ROLLBACK TO confirm_dependent');
      db.exec('RELEASE confirm_dependent');
    }
  }
  return logs;
}

// The owner undid an auto answer: Fathom never answers that item again.
const decline = (db, id, { now }) => db.prepare('INSERT INTO confirm_auto_declined (item_id, at) VALUES (?, ?) ON CONFLICT(item_id) DO NOTHING').run(id, stamp(now));

// Change an answered item's answer: revert the auto answers resting on it and the stored answer,
// then answer again, in one transaction (any refusal changes nothing). The same option returns the
// item unchanged. Changing an auto answer declines it. Returns {item, factsChanged}: whether any
// log touched facts.
export function reviseItem(db, id, optionId, { now } = {}) {
  const item = answeredItem(db, id);
  if (!item.options.some((o) => o.id === optionId)) throw new ConfirmError('bad_option');
  if (optionId === item.answer) return { item, factsChanged: false };
  const reason = finalReason(db, item);
  if (reason) throw new ConfirmError('final', reason);
  return tx(db, () => {
    const auto = hasAuto(db, item.id);
    const dependents = revertDependents(db, item.id);
    const reverted = revertAnswer(db, getItem(db, item.id));
    const fresh = getItem(db, item.id);
    if (optionId !== 'different') assertCurrentPair(db, fresh);
    if (fresh.kind === 'fact_check' && factIsStale(db, fresh)) throw new ConfirmError('stale');
    if (fresh.kind === 'withholding_conflict' && !conflictCurrent(db, fresh)) throw new ConfirmError('stale');
    const { changes } = recordAnswer(db, fresh, optionId, { now });
    if (auto) decline(db, item.id, { now });
    return { item: getItem(db, item.id), factsChanged: [dependents, reverted, changes].some((log) => touches(log, 'facts')) };
  });
}

// Put an answered item back to pending, restoring every row its answer touched, after the auto
// answers resting on it. An item the owner reopens (owner or auto answer) is always asked again,
// never auto-answered: it is declined. Returns {item, factsChanged}.
export function reopenItem(db, id, { now } = {}) {
  const item = answeredItem(db, id);
  const reason = finalReason(db, item);
  if (reason) throw new ConfirmError('final', reason);
  return tx(db, () => {
    const reverted = reopenOne(db, item, { now });
    return { item: getItem(db, item.id), factsChanged: touches(reverted, 'facts') };
  });
}

// Reopen inside the caller's transaction and decline the item (dependents reverted with it are not
// declined). Returns every reverted log.
function reopenOne(db, item, { now }) {
  const dependents = revertDependents(db, item.id);
  const reverted = revertAnswer(db, getItem(db, item.id));
  decline(db, item.id, { now });
  return [...dependents, ...reverted];
}

// Reopen several answered items in one transaction (undo of a group card); any refusal changes
// nothing. An item already reverted here as resting on another listed item counts as reopened.
// Returns {items, factsChanged}.
export function reopenItems(db, ids, { now } = {}) {
  const list = Array.isArray(ids) ? ids : [];
  const items = list.map((id) => answeredItem(db, id));
  for (const item of items) {
    const reason = finalReason(db, item);
    if (reason) throw new ConfirmError('final', reason);
  }
  return tx(db, () => {
    let factsChanged = false;
    for (const item of items) {
      const fresh = getItem(db, item.id);
      if (fresh.status === 'pending') {
        decline(db, item.id, { now });
        continue;
      }
      if (touches(reopenOne(db, answeredItem(db, item.id), { now }), 'facts')) factsChanged = true;
    }
    return { items: items.map((i) => getItem(db, i.id)), factsChanged };
  });
}

// The planner's source id (PLANNER_SRC in src/jobs/planner/facts.mjs, which imports this module).
const PLANNER = 'planner';

// An import check is stale when the stored fact no longer holds the value it asks about. A planner
// check asks about a derived value that differs from the owner's notes fact by construction, so it
// records the notes value it was asked against (context.stored) and is stale only when the stored
// fact changed since. A planner check without context.stored (asked before it was recorded) is
// stale; the next planning run asks it again with the field.
function factIsStale(db, item) {
  const current = db.prepare('SELECT value FROM facts WHERE key = ?').get(item.context.key);
  if (item.context.src === PLANNER) {
    if (!Object.hasOwn(item.context, 'stored') || !current) return true;
    return canonicalJson(parseJson(current.value, null)) !== canonicalJson(item.context.stored);
  }
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
    case 'withholding_conflict':
      applyConflict(db, item, optionId, { now });
      return {};
    case 'account_match': {
      if (item.context?.repair) {
        if (optionId === 'same') mergeAccounts(db, item, { now: stamp(now) });
        return {};
      }
      // A SimpleFIN account waiting on this question writes into the imported account (same) or
      // its own new account (different) from the next sync on.
      const { sfKey, candidateId, ownId } = item.context ?? {};
      const target = optionId === 'same' ? candidateId : optionId === 'different' ? ownId : null;
      if (typeof sfKey === 'string' && typeof target === 'string') {
        db.prepare("UPDATE simplefin_accounts SET account_id = ?, status = 'mapped' WHERE sf_key = ?").run(target, sfKey);
      }
      return {};
    }
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
    if (byDocument?.status === 'answered') { markUsed(db, byDocument.id, { now }); return { recipient: byDocument.answer }; }
    return { recipient: 'unknown', outcome: askDocument(db, { issuer, payer, fileId, now }) };
  }
  const byEmployer = findItem(db, 'employer_recipient', employerKey);
  if (byEmployer?.status === 'answered') markUsed(db, byEmployer.id, { now });
  if (byEmployer?.status === 'answered' && byEmployer.answer !== 'both') return { recipient: byEmployer.answer };
  if (byEmployer?.status === 'answered') {
    const byDocument = findItem(db, 'document_recipient', payer);
    if (byDocument?.status === 'answered') { markUsed(db, byDocument.id, { now }); return { recipient: byDocument.answer }; }
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
  if (rows.length) closeStaleConflicts(db, { now });
  return rows.length;
}

// K1: two withholding documents of one recipient share a payer identity (an original and its
// correction, or two real payments). Equal amounts are a duplicate. Differing amounts keep both
// rows: the earlier-imported one holds the identity, the later one <payer>:doc:<file id> until a
// withholding_conflict question is answered. The subject is the identity's key and both amounts,
// so a later import of either amount against it is a repeat: it asks nothing and changes nothing.
const amountCents = (amount) => Math.round(Number(amount) * 100);
export const conflictPayer = (payer, fileId) => `${payer}:doc:${fileId}`;
const conflictSubject = (key, a, b) => [key, ...[amountCents(a), amountCents(b)].sort((x, y) => x - y)].join('|');
export const sameAmount = (a, b) => amountCents(a) === amountCents(b);
export const conflictAsked = (db, key, a, b) => Boolean(findItem(db, 'withholding_conflict', conflictSubject(key, a, b)));

function formLabel(payer) {
  const kind = String(payer).split(':')[0];
  return kind === 'w2' ? 'W-2s' : kind === 'paystub' ? 'paystubs' : `${kind.toUpperCase()}s`;
}

// L1: tax_payments ids are reused, so the question names each stored row by id, dedupe key, file
// id and amount in cents, read as stored now. A pending question whose rows no longer match
// (summarized, archived, rekeyed or changed) is closed as superseded; answering one is refused.
const getPayment = (db, id) => (Number.isInteger(id) ? db.prepare('SELECT * FROM tax_payments WHERE id = ?').get(id) : null);
const rowRef = (row) => ({ id: row.id, key: row.dedupe_key, fileId: row.file_id ?? null, cents: amountCents(row.amount) });
const refCurrent = (db, ref) => {
  const row = getPayment(db, ref?.id);
  return Boolean(row) && row.dedupe_key === ref.key && (row.file_id ?? null) === ref.fileId && amountCents(row.amount) === ref.cents;
};
const conflictCurrent = (db, item) => refCurrent(db, item.context.first) && refCurrent(db, item.context.second);
function closeStaleConflicts(db, { now, except = null } = {}) {
  const close = db.prepare("UPDATE confirm_items SET status = 'answered', answer = 'superseded', answered_at = ? WHERE id = ?");
  for (const p of pendingItems(db)) if (p.kind === 'withholding_conflict' && p.id !== except && !conflictCurrent(db, p)) close.run(stamp(now), p.id);
}

// Queue the question for stored rows first (earlier import, holding key and payer) and second.
export function askConflict(db, { key, payer, first, second, now }) {
  return ask(db, {
    kind: 'withholding_conflict', subject: conflictSubject(key, first.amount, second.amount),
    question: `Two ${formLabel(payer)} from one payer report different ${first.jurisdiction} withholding for ${first.tax_year}. Which should count?`,
    options: WITHHOLDING_CONFLICT_OPTIONS, context: { key, payer, first: rowRef(getPayment(db, first.id)), second: rowRef(getPayment(db, second.id)) }, fileId: second.file_id, now,
  });
}

// M1: payer identity includes the primary income amount, so a correction whose income also changed
// takes another key. A document row of a known recipient in the slot of an active row of the same
// document type from another file under another key is asked about as above, equal amounts or not.
// Paystubs never conflict (pay dates are separate payments). The subject is both rows' keys and
// cents; the context carries no identity, so the survivor keeps its own.
export function askSlotConflict(db, row, { now } = {}) {
  const docType = String(row.payer).split(':')[0];
  if (docType === 'paystub' || !String(row.source_slot ?? '').startsWith('wh:') || row.source_slot.endsWith(':unknown')) return null;
  const other = db.prepare(`SELECT * FROM tax_payments WHERE source_slot = ? AND payer LIKE ? AND dedupe_key != ? AND file_id IS NOT ? AND id != ?
    ORDER BY id LIMIT 1`).get(row.source_slot, `${docType}:%`, row.dedupe_key, row.file_id ?? null, row.id);
  if (!other) return null;
  const [first, second] = other.id < row.id ? [other, row] : [row, other];
  return ask(db, {
    kind: 'withholding_conflict', subject: [first, second].map((r) => `${r.dedupe_key}#${amountCents(r.amount)}`).sort().join('|'),
    question: `Two ${formLabel(first.payer)} from one payer report ${first.jurisdiction} withholding for ${first.tax_year} for the same person. Which should count?`,
    options: WITHHOLDING_CONFLICT_OPTIONS, context: { first: rowRef(getPayment(db, first.id)), second: rowRef(getPayment(db, second.id)) }, fileId: second.file_id, now,
  });
}

// first or second: archive the other row (withholding_conflict); the survivor takes the identity
// when the question names one (K1). N1: the answer records the survivor's identity (dedupe key and
// cents) as context.kept, and a remembered answer keeps the row with that identity, never by position.
const rowIdentity = (row) => `${row.dedupe_key}#${amountCents(row.amount)}`;
function applyConflict(db, item, optionId, { now }) {
  if (optionId !== 'first' && optionId !== 'second') return;
  const { key, payer, first, second, kept } = item.context;
  const rows = [getPayment(db, first?.id), getPayment(db, second?.id)];
  if (!rows[0] || !rows[1]) return;
  const at = kept ? rows.findIndex((r) => rowIdentity(r) === kept) : Number(optionId === 'second');
  if (at < 0) return;
  const [keep, drop] = [rows[at], rows[1 - at]];
  archive(db, 'tax_payments', { ...drop }, { by: keep.file_id, reason: 'withholding_conflict', now });
  db.prepare('DELETE FROM tax_payments WHERE id = ?').run(drop.id);
  if (payer && key) db.prepare('UPDATE tax_payments SET payer = ?, dedupe_key = ? WHERE id = ?').run(payer, key, keep.id);
  if (!kept) {
    const context = { ...item.context, kept: rowIdentity(getPayment(db, keep.id)) };
    db.prepare('UPDATE confirm_items SET context = ? WHERE id = ?').run(JSON.stringify(context), item.id);
  }
  closeStaleConflicts(db, { now, except: item.id });
}

// Set the recipient of stored unresolved withholding rows: recompute slot and payer identity and
// rekey each row, then summarize each slot. A rekeyed row whose key another row already holds with
// the same amount is the same document of the same person: the newer row (higher id) is archived
// as duplicate. A different amount is a withholding conflict (K1).
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
    if (other && !sameAmount(other.amount, r.amount)) {
      if (conflictAsked(db, key, other.amount, r.amount)) {
        archive(db, 'tax_payments', { ...r, recipient, source_slot: slot, payer, dedupe_key: key }, { by: other.file_id, reason: 'duplicate', now });
        remove.run(r.id);
        continue;
      }
      const [first, second] = other.id < r.id ? [other, r] : [r, other];
      const later = conflictPayer(payer, second.file_id);
      const laterKey = dedupeKey({ kind: 'tax_payment', jurisdiction: r.jurisdiction, sheetYear: r.tax_year, date: r.date, payer: later });
      if (second === other) {
        update.run(other.recipient, other.source_slot, later, laterKey, other.id);
        update.run(recipient, slot, payer, key, r.id);
      } else update.run(recipient, slot, later, laterKey, r.id);
      askConflict(db, { key, payer, first, second, now });
      slots.add(slot);
      continue;
    }
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
    askSlotConflict(db, getPayment(db, r.id), { now });
    slots.add(slot);
  }
  for (const slot of slots) summarizeSlot(db, slot, { now });
  closeStaleConflicts(db, { now });
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
  if (prior && prior.status === 'answered' && (prior.answer === 'yes' || prior.answer === 'no')) markUsed(db, prior.id, { now });
  if (prior && prior.status === 'answered' && prior.answer === 'no') return { written: false, changed: false, queued: false };
  const confirmed = Boolean(prior && prior.status === 'answered' && prior.answer === 'yes');
  const r = upsertFact(db, { key, value, src: sourceId, asOf, confirmed, provenance: { fileId, parser, locator }, now });
  if (!r.written && r.reason !== 'unchanged') return { written: false, changed: false, queued: false };
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
