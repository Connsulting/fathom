import { restoreRemovedFile } from '../accounts/sources.mjs';
import { CATEGORY_TABLES } from '../categories/resolve.mjs';
import { kindOf, accountMask, compatibleKind, sameInstitution } from './account-match.mjs';
// Store encrypted uploads, stage nonstandard proposals, and persist deterministic rows with provenance.

import { createHash } from 'node:crypto';
import { tx, parseJson } from '../store/db.mjs';
import { refreshPackState } from '../packs/state.mjs';
import { pickParser } from './registry.mjs';
import { identifyAccountRows, dedupeKey } from './dedupe.mjs';
import { cents, institution, LimitError } from './format.mjs';
import { readWorkbook } from './workbook.mjs';
import { delimitedCells } from './format.mjs';
import { sourceFormat } from './model-source.mjs';
import {
  ask, recordFact, archive, normalizeName, CONFIDENCE_FLOOR, OWNER_OPTIONS, KIND_OPTIONS, NEAR_DUPLICATE_OPTIONS, EMPLOYER_OPTIONS, taxYearOptions,
  withholdingRecipient, withRecipient, recipientPayer, summarizeSlot, conflictPayer, conflictAsked, askConflict, askSlotConflict,
} from './confirm.mjs';
import { storeFile, readStoredFile, openVault } from './vault.mjs';
import { recordSource } from './freshness.mjs';
import { autoResolve } from './auto.mjs';
import { accountLabel } from '../shared/account-label.mjs';
import { UNRESOLVED } from './file-status.mjs';
import { isTransient } from '../jobs/transient.mjs';
import { reconcileTransactionPayments } from './transaction-payments.mjs';
import { someSeries } from '../shared/series.mjs';

export const WAITING = Object.freeze(['waiting_for_engine', 'budget_exhausted', 'needs_confirmation', 'needs_clarification', 'needs_source_text']);
export const STATUSES = Object.freeze(['imported', 'duplicate', ...WAITING, 'unsupported', 'too_large', 'failed']);
const RETRYABLE = [...WAITING, 'needs_mapping', 'needs_extraction', 'failed'];
// Statuses an identical re-upload routes again under the same file id, never answered as stored.
const REROUTE = ['pending', 'failed'];

export class IngestError extends Error {
  constructor(status, code) {
    super(code === 'not_found' ? 'file not found' : code === 'invalid_mode' ? 'mode must be retry or reinterpret' : 'file is not eligible for the requested import mode');
    this.name = 'IngestError';
    this.status = status;
    this.code = code;
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const WARNING_ROWS = 5;
const emptyCounts = () => ({ rows: {}, duplicates: 0, crossFormat: 0, revised: 0, superseded: 0, incomplete: 0, warnings: 0, warningCodes: {}, queued: 0 });
const baseName = (name) => String(name ?? '').split(/[\\/]/).pop().slice(0, 255) || 'upload';
const toBytes = (bytes) => (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []));
const json = (value) => (value === undefined || value === null ? null : JSON.stringify(value));
const moneyEq = (a, b) => (a == null && b == null) || (a != null && b != null && Math.round(a * 100) === Math.round(b * 100));
const numEq = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-9);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export { kindOf } from './account-match.mjs';

// Normalized account identity: inst|mask:<mask>, inst|name:<name>, else source:<hash>.
export function accountIdentity(row) {
  if (row.identity) return row.identity;
  const account = row.account ?? {};
  const inst = normalizeName(institution(account.inst));
  if (account.mask) return `${inst}|mask:${account.mask}`;
  const name = normalizeName(account.name);
  if (name) return `${inst}|name:${name}`;
  return `source:${row.locator?.source ?? ''}`;
}
export const accountIdOf = (identity) => 'acct-' + sha256(identity).slice(0, 16);

// opts.household is the household context the request or job runs in: its db must be the one
// being written, and its vault, root and in-flight set are the only ones used.
function householdOf(db, opts) {
  const household = opts?.household;
  if (!household || typeof household.vault !== 'function' || !(household.inFlight instanceof Set) || typeof household.root !== 'string') {
    throw new TypeError('ingest needs opts.household');
  }
  if (household.db !== db) throw new TypeError('ingest opts.household must own the db');
  return household;
}

// Every file in turn, then one auto-resolution pass over the questions they left.
export async function ingestFiles(db, files, opts = {}) {
  householdOf(db, opts);
  const results = [];
  for (const file of files) results.push(await ingestFile(db, file, opts));
  await resolveAfterImport(db, opts);
  return { results };
}

// Auto-resolution after an import's rows are committed: a failure logs a code and never changes
// a file's result.
async function resolveAfterImport(db, opts) {
  try {
    await autoResolve(db, { now: opts.now || new Date().toISOString() });
  } catch (error) {
    console.error('fathom: auto-resolve failed', error?.code ?? error?.name ?? 'error');
  }
}

// file = {name, bytes, mime}. Returns {fileId, name, status, sourceKind, parser, counts, duplicateOf?, reasonCode?}.
// household.inFlight holds the file ids this household is storing or routing now. A 'pending' row
// whose id is not there was left by an interrupted run, and a 'failed' row is retried: both are
// routed again. A prior row in another unresolved status answers that status with duplicateOf (and
// its stored reasonCode), so the client shows its cause. A removed file replays its removal Undo;
// only an active imported prior is 'duplicate'. Checked and added synchronously, before any await.
export async function ingestFile(db, file, opts = {}) {
  const { inFlight } = householdOf(db, opts);
  await db.prepare("DELETE FROM settings WHERE key = 'synthetic_demo'").run();
  const now = opts.now || new Date().toISOString();
  const bytes = toBytes(file.bytes);
  const name = baseName(file.name);
  const hash = sha256(bytes);
  const prior = await db.prepare('SELECT id, source_kind, parser, status, note, counts, removed_at FROM files WHERE sha256 = ?').get(hash);
  const fileId = prior?.id ?? 'f-' + hash.slice(0, 24);
  const answer = (status, extra = {}) => ({ fileId, name, status, sourceKind: prior?.source_kind ?? null, parser: prior?.parser ?? null, counts: emptyCounts(), duplicateOf: fileId, ...extra });
  if (prior?.removed_at && !inFlight.has(fileId)) {
    inFlight.add(fileId);
    try {
      await restoreRemovedFile({ ...opts, db, now }, fileId);
      return { fileId, name, status: prior.status, sourceKind: prior.source_kind, parser: prior.parser,
        counts: parseJson(prior.counts, null) ?? emptyCounts(), restored: true };
    } finally { inFlight.delete(fileId); }
  }
  if (inFlight.has(fileId) || (prior && !REROUTE.includes(prior.status))) {
    // An unresolved file, including one routed right now, answers its own status, never duplicate.
    if (prior && !prior.removed_at && UNRESOLVED.includes(prior.status)) {
      return answer(prior.status, { counts: parseJson(prior.counts, null) ?? emptyCounts(), reasonCode: prior.note ?? null });
    }
    return answer('duplicate');
  }
  inFlight.add(fileId);
  try {
    // An interrupted 'pending' or a 'failed' file already has its encrypted bytes and row; the upload's bytes match by hash.
    if (!prior) {
      const vault = await openVault(opts.household);
      const storedPath = await storeFile({ vault, id: fileId, bytes, purpose: 'upload' });
      await db.prepare(`INSERT INTO files (id, name, mime, size, sha256, uploaded_at, stored_path, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`)
        .run(fileId, name, file.mime ?? null, bytes.length, hash, now, storedPath);
    }
    return await route(db, fileId, { name, bytes, mime: file.mime ?? null }, { ...opts, now });
  } finally {
    inFlight.delete(fileId);
  }
}

// Re-run routing for a file waiting on a mapping or the engine, a failed file, or one left 'pending'
// by an interrupted run, under the same file id.
export async function retryFile(db, fileId, opts = {}) {
  const { inFlight } = householdOf(db, opts);
  const row = await db.prepare('SELECT * FROM files WHERE id = ?').get(String(fileId ?? ''));
  if (!row) throw new IngestError(404, 'not_found');
  if (!['retry', 'reinterpret'].includes(opts.mode ?? 'retry')) throw new IngestError(400, 'invalid_mode');
  if (row.removed_at || inFlight.has(row.id) || !(opts.mode === 'reinterpret' ? row.status === 'imported' : RETRYABLE.includes(row.status) || row.status === 'pending')) throw new IngestError(409, 'not_waiting');
  inFlight.add(row.id);
  try {
    const vault = await openVault(opts.household);
    const bytes = await readStoredFile({ vault, id: row.id, storedPath: row.stored_path, purpose: 'upload' });
    const now = opts.now || new Date().toISOString();
    const out = await route(db, row.id, { name: row.name, bytes: toBytes(bytes), mime: row.mime }, { ...opts, now });
    await resolveAfterImport(db, { ...opts, now });
    return out;
  } finally {
    inFlight.delete(row.id);
  }
}

// The scheduler's resume pass: every live file left 'pending' by an interrupted run, and every
// failed file or transient model failure marked for one automatic retry, is routed again from its
// stored bytes, oldest first. Files this household is routing now are skipped. A refusal or error
// logs a safe class and the pass goes on. Returns { resumed: [{ fileId, status }] }, one entry per
// attempted file.
export async function resumeImports(db, opts = {}) {
  const { inFlight } = householdOf(db, opts);
  const rows = await db.prepare(`SELECT id, status FROM files WHERE removed_at IS NULL AND stored_path IS NOT NULL
                           AND (status = 'pending' OR (status = 'failed' AND note LIKE 'retry:%')
                             OR (status = 'waiting_for_engine' AND note = 'model_transient')) ORDER BY uploaded_at, rowid`).all();
  // A note's change proposal (actions) is only restaged by its owner: a background pass would stage
  // it under the background actor, which the owner cannot review. Such a failed file drops its
  // automatic mark and waits for the owner's Retry.
  const latest = db.prepare('SELECT review_state FROM import_proposals WHERE file_id = ? ORDER BY version DESC, rowid DESC LIMIT 1');
  const resumed = [];
  for (const row of rows) {
    if (inFlight.has(row.id)) continue;
    if (parseJson((await latest.get(row.id))?.review_state, {})?.kind === 'actions') {
      if (row.status === 'failed') await db.prepare("UPDATE files SET note = substr(note, 7) WHERE id = ? AND note LIKE 'retry:%'").run(row.id);
      continue;
    }
    try {
      const out = await retryFile(db, row.id, { ...opts, mode: 'retry', autoRetried: row.status !== 'pending' });
      resumed.push({ fileId: row.id, status: out.status });
    } catch (error) {
      console.error('fathom: import resume failed', failureClass(error));
    }
  }
  return { resumed };
}

export async function retryIncompletePaystubs(db, { household, engine, now, taxYear }) {
  if (!household?.vault || household.db !== db || !engine?.isOn?.()) return;
  const docs = await db.prepare("SELECT d.*, f.name, f.mime, f.stored_path FROM documents d JOIN files f ON f.id = d.file_id WHERE d.doc_type = 'paystub' AND f.removed_at IS NULL").all();
  for (const doc of docs) {
    const fields = parseJson(doc.fields, {}), locator = parseJson(doc.locator, {});
    if (Number(fields.payDate?.slice(0, 4)) !== taxYear || fields.payDate > now.slice(0, 10)
      || !(fields.confidence < CONFIDENCE_FLOOR) || (Number.isFinite(fields.gross) && Number.isFinite(fields.ytdGross)) || locator.paystubRetry) continue;
    if (household.inFlight.has(doc.file_id)) continue;
    household.inFlight.add(doc.file_id);
    try {
      const vault = await openVault(household);
      const bytes = await readStoredFile({ vault, id: doc.file_id, storedPath: doc.stored_path, purpose: 'upload' });
      const file = { fileId: doc.file_id, name: doc.name, mime: doc.mime, bytes: toBytes(bytes) };
      file.format = sourceFormat(file);
      const { interpretFile } = await import('./model-parse.mjs');
      const { validateImport } = await import('./model-validation.mjs');
      const ctx = { db, household, now };
      const interpretation = await interpretFile({ ctx, file });
      const checked = interpretation.valid ? validateImport(ctx, interpretation.proposal, interpretation.source) : null;
      const fresh = checked?.valid ? checked.rows.find(r => r.kind === 'document' && r.docType === 'paystub') : null;
      const same = fresh && fresh.fields.payDate === fields.payDate && normalizeName(fresh.fields.employerName) === normalizeName(fields.employerName);
      await db.prepare('UPDATE documents SET fields = ?, locator = ? WHERE id = ?').run(JSON.stringify(same ? { ...fields, ...fresh.fields } : fields), JSON.stringify({ ...locator,
        paystubRetry: { attemptedAt: now, status: same ? 'extracted' : interpretation.status, ...(same ? { evidence: fresh.locator } : {}) } }), doc.id);
    } catch {
      await db.prepare('UPDATE documents SET locator = ? WHERE id = ?').run(JSON.stringify({ ...locator, paystubRetry: { attemptedAt: now, status: 'failed' } }), doc.id);
    } finally { household.inFlight.delete(doc.file_id); }
  }
}

async function route(db, fileId, file, opts) {
  let out;
  try {
    const plan = await planFile(db, fileId, file, opts);
    if (plan.proposalResult) {
      const result = plan.proposalResult;
      if (result.status !== 'imported') await db.prepare('UPDATE files SET status=?,parser=?,source_kind=?,note=? WHERE id=?').run(result.status, 'model-import', 'model_import', result.reasonCode ?? null, fileId);
      out = { result: { fileId, name: file.name, parser: 'model-import', sourceKind: 'model_import', counts: emptyCounts(), ...result } };
    } else out = await tx(db, async (db) => await persistImport(db, fileId, file, plan, opts));
  } catch (error) {
    if (error instanceof LimitError) return await tooLarge(db, fileId, file);
    const cls = failureClass(error);
    console.error('fathom: ingest failed', cls);
    // A transient class is retried once by the scheduler's resume pass (`retry:` marks it); the retry's own failure is left for the owner.
    const note = isTransient(cls) && !opts.autoRetried ? `retry:${cls}` : cls;
    await db.prepare("UPDATE files SET status = 'failed', note = ? WHERE id = ?").run(note, fileId);
    return { fileId, name: file.name, status: 'failed', sourceKind: null, parser: null, counts: emptyCounts(), reasonCode: note };
  }
  // The rows are committed. A pack refresh failure must not relabel the file as failed: a retry
  // would route rows that are already stored. The next fact change or startup refreshes packs again.
  if (out.factsChanged) {
    try { await refreshPackState(db, { dataDir: opts.household.root, now: opts.now }); } catch (error) { console.error('fathom: pack refresh failed', error?.name ?? 'error'); }
  }
  return out.result;
}

// A failure's safe class, never its message: store_locked for SQLite busy or locked, else the
// error's code or name when it is an identifier, else 'error'.
const SAFE_CLASS = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
function failureClass(error) {
  if (error?.code === 'storage_busy') return 'store_locked';
  return [error?.code, error?.name].find((v) => typeof v === 'string' && SAFE_CLASS.test(v)) ?? 'error';
}

// D1: an input past a parse limit (format.LIMITS) is recorded, not parsed. Its encrypted bytes stay
// in the vault; nothing else is stored.
async function tooLarge(db, fileId, file) {
  const counts = { ...emptyCounts(), warnings: 1, warningCodes: { limit_exceeded: 1 } };
  await db.prepare("UPDATE files SET status = 'too_large', note = 'limit_exceeded', counts = ? WHERE id = ?").run(JSON.stringify(counts), fileId);
  return { fileId, name: file.name, status: 'too_large', sourceKind: null, parser: null, counts };
}

// D2: a note is stored as a reference to its encrypted file, never as text.
async function planFile(db, fileId, file, opts) {
  if (!file.bytes.length) return { status: 'unsupported', warnings: [{ code: 'empty_file', locator: {} }] };
  const parser = opts.mode === 'reinterpret' ? null : opts.parser ?? pickParser(file);
  if (parser) return { status: 'imported', parser: parser.id, label: parser.label, sourceKind: parser.sourceKind,
    mirror: parser.mirror ?? 'manual', parsed: parser.parse(file), capabilities: parser.capabilities ?? {} };
  const format = sourceFormat(file);
  if (!format) return { status: 'unsupported', warnings: [{ code: 'unsupported_format', locator: {} }] };
  try {
    if (format === 'xlsx') readWorkbook(file);
    if (format === 'csv' || format === 'tsv') delimitedCells(file, format === 'tsv' ? '\t' : ',');
  } catch (error) {
    if (error instanceof LimitError) throw error;
    return { status: 'unsupported', warnings: [{ code: 'unsupported_format', locator: {} }] };
  }
  const { prepareImport } = await import('./model-review.mjs');
  return { proposalResult: await prepareImport({ ...opts, db }, { file: { ...file, fileId, format }, fake: opts.fake, reinterpret: opts.mode === 'reinterpret' }) };
}

// The sync half, inside one transaction.
export async function persistImport(db, fileId, file, plan, opts) {
  const now = opts.now;
  const counts = emptyCounts();
  if (plan.extractPath) counts.extractPath = plan.extractPath;
  const ctx = { db, fileId, now, counts, parser: plan.parser ?? null, mirror: plan.mirror ?? 'manual', factsChanged: false, keys: new Set(), emptySnapshots: new Map() };
  // Per code: the count, the first WARNING_ROWS ascending row numbers (warningRows) and how many
  // more rows there are (warningMore, omitted when none). A warning without a row adds no row.
  const rowsOf = new Map();
  const warn = (list) => {
    for (const w of list ?? []) {
      counts.warnings += 1;
      counts.warningCodes[w.code] = (counts.warningCodes[w.code] ?? 0) + 1;
      const row = w.locator?.row;
      if (Number.isInteger(row) && row >= 1) {
        if (!rowsOf.has(w.code)) rowsOf.set(w.code, new Set());
        rowsOf.get(w.code).add(row);
      }
    }
    for (const [code, set] of rowsOf) {
      const sorted = [...set].sort((x, y) => x - y);
      (counts.warningRows ??= {})[code] = sorted.slice(0, WARNING_ROWS);
      if (sorted.length > WARNING_ROWS) (counts.warningMore ??= {})[code] = sorted.length - WARNING_ROWS;
    }
  };
  const parsed = plan.parsed;
  warn(plan.warnings);
  const finish = async (status, extra = {}) => {
    await db.prepare(`UPDATE files SET status = ?, parser = ?, source_kind = ?, counts = ?, note = ?, header_signature = coalesce(?, header_signature) WHERE id = ?`)
      .run(status, plan.parser ?? null, plan.sourceKind ?? null, JSON.stringify(counts), plan.note ?? null, plan.headerSignature ?? null, fileId);
    return {
      result: { fileId, name: file.name, status, sourceKind: plan.sourceKind ?? null, parser: plan.parser ?? null, counts, ...extra },
      factsChanged: ctx.factsChanged,
    };
  };
  if (!parsed) return await finish(plan.status);

  if (plan.reinterpret) {
    ctx.reinterpretedTransactions = new Map();
    const incoming = new Map(), retained = new Set();
    for (const row of parsed.rows.filter(row => row.kind === 'transaction')) for (const key of transactionOrigins(row.locator)) {
      const matches = incoming.get(key) ?? []; matches.push(row); incoming.set(key,matches);
    }
    for (const old of await db.prepare('SELECT * FROM transactions WHERE file_id=?').all(fileId)) {
      const matches = transactionOrigins(parseJson(old.locator,{})).map(key => incoming.get(key) ?? []).find(rows => rows.length === 1) ?? [];
      if (matches.length === 1 && !ctx.reinterpretedTransactions.has(matches[0])) { ctx.reinterpretedTransactions.set(matches[0],old.id); retained.add(old.id); }
      else if (await db.prepare('SELECT 1 FROM transaction_category_corrections WHERE transaction_id=?').get(old.id)) throw new Error('confirmed_transaction_unmapped');
    }
    for (const table of ['transactions', 'balances', 'positions', 'pnl_lines', 'tax_payments', 'documents']) {
      for (const row of await db.prepare(`SELECT * FROM ${table} WHERE file_id=?`).all(fileId)) {
        await archive(db, table, { ...row }, { by: fileId, reason: 'reinterpreted', now });
        if (table === 'transactions' && retained.has(row.id)) {
          await db.prepare('UPDATE transactions SET dedupe_key=NULL WHERE id=?').run(row.id);
          continue;
        }
        if (table === 'transactions') for (const dependent of ['transaction_category_imports', 'transaction_category_corrections', 'transaction_category_guesses']) {
          for (const observation of await db.prepare(`SELECT * FROM ${dependent} WHERE transaction_id=?`).all(row.id)) await archive(db,dependent,{ ...observation },{ by:fileId, fileId, reason:'reinterpreted',now });
          await db.prepare(`DELETE FROM ${dependent} WHERE transaction_id=?`).run(row.id);
        }
        await db.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.id);
      }
    }
  }

  identifyAccountRows(parsed, file);
  warn(parsed.warnings);
  const period = parsed.period ?? { from: null, to: null };

  // Accounts: identity, id, and the file's source id.
  const accountRows = parsed.rows.filter((r) => r.account);
  const connected = connectedAccountFor(db);
  for (const row of accountRows) row.accountId ??= connected(row) ?? accountIdOf(accountIdentity(row));
  const accountIds = [...new Set(accountRows.map((r) => r.accountId))];
  const single = accountIds.length === 1 ? accountIds[0] : null;
  const sourceId = `ing:${plan.parser}:${plan.sourceGroup ? plan.sourceGroup + ':' : ''}${single ?? 'all'}`;
  const singleName = single ? accountName(accountRows.find((r) => r.accountId === single).account) : null;
  ctx.sourceId = sourceId;
  ctx.asOf = period.to ?? now.slice(0, 10);

  const coverage = [...(plan.coverage ?? [])];
  if (plan.capabilities?.targetCoverage) {
    const groups = new Map();
    for (const row of parsed.rows.filter(r => ['balance','position','snapshot'].includes(r.kind))) {
      const group = { table: row.kind === 'balance' ? 'balances' : 'positions', accountId: row.accountId, period: row.date ?? row.asOf, complete: true, authority: row.date ?? row.asOf };
      groups.set(JSON.stringify(group), group);
    }
    coverage.push(...groups.values());
  }
  ctx.coverage = coverage;

  await db.prepare(`UPDATE files SET parser = ?, source_kind = ?, source_id = ?, header_signature = coalesce(?, header_signature),
              period_from = ?, period_to = ?, coverage = ? WHERE id = ?`)
    .run(plan.parser, plan.sourceKind, sourceId, plan.headerSignature ?? null, period.from ?? null, period.to ?? null, json(coverage), fileId);
  await recordSource(db, { id: sourceId, label: singleName ? `${plan.label} (${singleName})` : plan.label, kind: plan.sourceKind, asOf: period.to, now });

  await upsertAccounts(ctx, accountRows);

  const rows = parsed.rows;
  const balances = closingBalances(rows);
  const holds = new Map();
  ctx.categoryRows = new Map();
  for (const row of rows.filter(r => r.kind === 'transaction')) {
    const key = JSON.stringify([row.accountId,cents(row.amount)]);
    const grouped = ctx.categoryRows.get(key) ?? [];
    grouped.push(row); ctx.categoryRows.set(key,grouped);
  }
  for (const row of rows) {
    const parser = row.parser ?? ctx.parser;
    const locator = json(row.locator ?? null);
    switch (row.kind) {
      case 'transaction': await putTransaction(ctx, row, parser, locator); break;
      case 'balance': if (balances.has(row)) await putBalance(ctx, row, parser, locator); break;
      case 'position': await putPosition(ctx, row, parser, locator); break;
      case 'pnl_line': await putPnl(ctx, row, parser, locator); break;
      case 'tax_payment': await putTax(ctx, row, parser, locator); break;
      case 'document': await putDocument(ctx, row, parser, locator); break;
      case 'fact':
        if (row.hold) {
          await db.prepare('INSERT INTO held_facts (hold, key, value, file_id, parser, locator, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(row.hold, row.key, JSON.stringify(row.value), fileId, parser, locator, row.confidence ?? null, now);
          holds.set(row.employerKey, row.employerName);
        } else await putFact(ctx, row, parser);
        break;
      default: break;
    }
  }

  if (coverage?.length) await supersede(ctx, coverage);
  if (plan.capabilities?.positions) await removeOmittedPositions(ctx, rows, parsed.warnings);
  await askEntityAliases(ctx, rows.filter(r => r.kind === 'pnl_line'));
  await askTaxYears(ctx, rows);
  for (const [employerKey, employerName] of holds) {
    const named = employerName ? `Is ${employerName}` : 'Is this employer';
    tally(ctx, await ask(db, {
      kind: 'employer_relation', subject: employerKey, question: `${named} an outside employer or your own business?`,
      options: EMPLOYER_OPTIONS, context: { employerKey, employer: employerName ?? '' }, fileId, now,
    }));
  }
  await refreshFigures(ctx, accountIds);
  const result = await finish(plan.status);
  await reconcileTransactionPayments(db, { now });
  return result;
}

// A file row for an account first seen through SimpleFIN: when the row's own identity has no
// account and exactly one connected account (identity simplefin:...) has the same institution and
// mask, the row belongs to it. Otherwise null (the row's own identity decides).
function connectedAccountFor(db) {
  const cache = new Map();
  return async row => {
    if (row.identity || !accountMask(row.account ?? {})) return null;
    const own = accountIdOf(accountIdentity(row));
    if (cache.has(own)) {
      const target = cache.get(own);
      if (target && !target.identity?.startsWith('simplefin:')) row.account = { ...row.account, inst:target.inst, mask:target.mask, name:target.name };
      return target?.id ?? null;
    }
    let out = null;
    if (!await db.prepare('SELECT 1 FROM accounts WHERE id=?').get(own)) {
      const hits = (await db.prepare(`SELECT DISTINCT a.* FROM simplefin_accounts m JOIN accounts a ON a.id=m.account_id WHERE m.status='mapped'`).all())
        .filter(a => accountMask(a) === accountMask(row.account) && compatibleKind(a,row.account)
          && (sameInstitution(a.inst,row.account.inst) || (a.identity && !a.identity.startsWith('simplefin:') && !row.account.inst)));
      if (hits.length === 1) {
        const target = hits[0];
        out = target.id;
        if (!target.identity?.startsWith('simplefin:')) row.account = { ...row.account, inst:target.inst, mask:target.mask, name:target.name };
      }
    }
    cache.set(own,out ? await db.prepare('SELECT * FROM accounts WHERE id=?').get(out) : null);
    return out;
  };
}

function tally(ctx, outcome) {
  if (outcome?.queued) ctx.counts.queued += 1;
  if (outcome?.factsChanged) ctx.factsChanged = true;
}
const bump = (ctx, kind) => { ctx.counts.rows[kind] = (ctx.counts.rows[kind] ?? 0) + 1; };

function accountName(account) {
  const name = String(account.name ?? '').trim();
  if (name) return name;
  return [institution(account.inst), /^\d{4}$/.test(account.mask ?? '') ? account.mask : ''].filter(Boolean).join(' ') || 'Imported account';
}

// The holder name a source carries for an account, kept once (the first source that names it).
// Returns whether the row named one.
async function recordHolder(ctx, row) {
  const holder = String(row.account?.holder ?? '').trim();
  if (!holder) return false;
  await ctx.db.prepare('INSERT INTO account_holders (account_id, holder, file_id, locator, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id) DO NOTHING')
    .run(row.accountId, holder, ctx.fileId, json(row.locator ?? null), ctx.now);
  return true;
}

async function upsertAccounts(ctx, accountRows) {
  const { db, fileId, now, parser, sourceId, mirror } = ctx;
  const seen = new Set();
  const named = new Set();
  for (const row of accountRows) {
    if (seen.has(row.accountId)) {
      if (!named.has(row.accountId) && await recordHolder(ctx, row)) named.add(row.accountId);
      continue;
    }
    seen.add(row.accountId);
    const identity = accountIdentity(row);
    if (await db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(row.accountId)) {
      await db.prepare('UPDATE accounts SET source_id = ? WHERE id = ? AND source_id IS NOT ?').run(sourceId, row.accountId, sourceId);
      if (await recordHolder(ctx, row)) named.add(row.accountId);
      continue;
    }
    const account = row.account;
    const name = accountName(account);
    const shown = accountLabel(account);
    const kind = kindOf(account.kind);
    const mask = /^\d{4}$/.test(account.mask ?? '') ? account.mask : null;
    await db.prepare(`INSERT INTO accounts (id, inst, mask, name, owner, kind, mirror, file_id, parser, locator, identity, source_id)
                VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.accountId, institution(account.inst) || null, mask, name, kind, mirror, fileId, row.parser ?? parser, json(row.locator ?? null), identity, sourceId);
    if (await recordHolder(ctx, row)) named.add(row.accountId);
    tally(ctx, await ask(db, { kind: 'account_owner', subject: row.accountId, question: `Whose account is ${shown}?`, options: OWNER_OPTIONS, context: {}, fileId, now }));
    if (!kind) tally(ctx, await ask(db, { kind: 'account_kind', subject: row.accountId, question: `What kind of account is ${shown}?`, options: KIND_OPTIONS, context: {}, fileId, now }));
  }
}

// D3 with G1, G2 and C2: what is already known under a transaction key. The stored row, plus
// archived observations of it: confirmed duplicates (G2 tombstones) and incoming rows deduped across
// formats. Each is {description, parser, file_id}.
const OBSERVED = ['duplicate_confirmed', 'duplicate_cross_format'];
async function observations(db, key) {
  const list = [];
  const stored = await db.prepare('SELECT description, parser, file_id FROM transactions WHERE dedupe_key = ?').get(key);
  if (stored) list.push({ ...stored, stored: true });
  const archived = db.prepare(`SELECT row, survivor_key FROM superseded_rows WHERE table_name = 'transactions' AND dedupe_key = ? AND reason IN (${OBSERVED.map(() => '?').join(', ')}) ORDER BY id`);
  for (const a of await archived.all(key, ...OBSERVED)) {
    const r = parseJson(a.row, null);
    if (r) list.push({ description: r.description ?? null, parser: r.parser ?? null, file_id: r.file_id ?? null, survivor_key: a.survivor_key });
  }
  return list;
}

// G1: distinctive words are lowercase runs of 3 or more letters, minus card and payment boilerplate.
const STOP_WORDS = new Set(['card', 'purchase', 'debit', 'credit', 'pos', 'payment', 'online', 'ach', 'the', 'and', 'from', 'for', 'with', 'to']);
const words = (description) => new Set((String(description ?? '').toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !STOP_WORDS.has(w)));

// Whether an incoming row is a posting already observed under its key. When an observation comes
// from the incoming row's parser, only those count, under the same-format rule: equal normalized
// descriptions. Otherwise, across formats, equal descriptions or a shared distinctive word.
// Returns {match: 'same' | 'cross_equal' | 'cross_words', observation} or null (another posting).
function samePosting(list, description, parser) {
  const normalized = normalizeName(description);
  const own = list.filter((o) => (o.parser ?? null) === (parser ?? null));
  if (own.length) {
    const hit = own.find((o) => normalizeName(o.description) === normalized);
    return hit ? { match: 'same', observation: hit } : null;
  }
  const equal = list.find((o) => normalizeName(o.description) === normalized);
  if (equal) return { match: 'cross_equal', observation: equal };
  const mine = words(description);
  const shared = list.find((o) => [...words(o.description)].some((w) => mine.has(w)));
  return shared ? { match: 'cross_words', observation: shared } : null;
}

const activeKey = async (db, key) => (await db.prepare('SELECT 1 FROM transactions WHERE dedupe_key = ?').get(key) ? key : null);
// The active row a key stands for: the key itself, else the first active key reached by following
// confirmed-duplicate survivor links, breadth first. A visited set and a hop cap end cycles, self
// links and missing survivors with null.
const SURVIVOR_HOPS = 16;
async function activeCounterpart(db, key) {
  const survivorsOf = db.prepare(`SELECT survivor_key FROM superseded_rows WHERE table_name = 'transactions' AND dedupe_key = ? AND reason IN ('duplicate_confirmed','duplicate_cross_format')
                                  AND survivor_key IS NOT NULL ORDER BY id DESC`);
  const seen = new Set([key]);
  let frontier = [key];
  for (let hop = 0; frontier.length && hop <= SURVIVOR_HOPS; hop += 1) {
    const next = [];
    for (const k of frontier) {
      if (await activeKey(db, k)) return k;
      for (const { survivor_key: survivor } of await survivorsOf.all(k)) if (!seen.has(survivor)) { seen.add(survivor); next.push(survivor); }
    }
    frontier = next;
  }
  return null;
}

const NEAR_DATES = 'Two imports show the same amount on this account within three days. Are they the same transaction?';
const NEAR_KEY = 'Two imports show the same amount and date or reference number on this account with different descriptions. Are they the same transaction?';

async function recordCategoryImport(ctx, transactionId, values, key) {
  if (!values.category || !Object.hasOwn(CATEGORY_TABLES,values.parser)) return;
  await ctx.db.prepare(`INSERT INTO transaction_category_imports
    (transaction_id,dedupe_key,category,parser,file_id,locator,date,description,updated_at) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(transaction_id) DO UPDATE SET category=excluded.category,parser=excluded.parser,file_id=excluded.file_id,
      locator=excluded.locator,updated_at=excluded.updated_at WHERE transaction_category_imports.dedupe_key=excluded.dedupe_key`)
    .run(transactionId,key,values.category,values.parser,ctx.fileId,values.locator,values.date,values.description,ctx.now);
}
async function categoryCounterpart(ctx,row,parser) {
  if (!row.category || !Object.hasOwn(CATEGORY_TABLES,parser)) return null;
  const candidates=await ctx.db.prepare(`SELECT t.* FROM transactions t WHERE t.account_id=? AND t.parser='simplefin'
    AND round(t.amount*100)=? AND t.date BETWEEN ? AND ?
    AND NOT EXISTS (SELECT 1 FROM transaction_category_imports i WHERE i.transaction_id=t.id) ORDER BY t.date,t.id`)
    .all(row.accountId,Math.round(row.amount*100),addDays(row.date,-2),addDays(row.date,2));
  const matches=candidates.filter(c=>samePosting([c],row.description,parser));
  const overlapping=(ctx.categoryRows.get(JSON.stringify([row.accountId,cents(row.amount)])) ?? [])
    .filter(r=>Math.abs(Date.parse(r.date)-Date.parse(row.date))<=4*86400000);
  if (matches.length===1) {
    const hit=matches[0];
    const competitors=overlapping.filter(r=>samePosting([hit],r.description,parser));
    return competitors.length===1 ? hit : null;
  }
  return !matches.length && candidates.length===1 && overlapping.length===1 ? candidates[0] : null;
}

function transactionOrigins(locator = {}) {
  const refs = locator.fields?.amount?.refs, keys = refs?.length ? ['refs:' + JSON.stringify([...refs].sort())] : [];
  const rows = locator.row != null ? [JSON.stringify([locator.sheet ?? null,locator.row])]
    : [...new Set((locator.derivedFrom ?? []).filter(ref => ref.row != null).map(ref => JSON.stringify([ref.sheet?.index ?? null,ref.row])))];
  if (rows.length === 1) keys.push('row:' + rows[0]);
  return keys;
}

async function putTransaction(ctx, row, parser, locator) {
  const { db, fileId, counts, now } = ctx;
  const values = {
    account_id: row.accountId, date: row.date, amount: cents(row.amount), description: row.description ?? null, category: row.category ?? null,
    external_id: row.externalId ?? null, file_id: fileId, parser, locator, occurrence: row.occurrence ?? null,
  };
  // A known posting is skipped. One deduped across formats is archived as an observation, so a
  // later row of its own format is compared with it under the same-format rule (C2).
  const duplicate = async (found, key) => {
    counts.duplicates += 1;
    const survivorKey=await activeCounterpart(db,found.observation.survivor_key ?? key);
    const survivor=survivorKey && await db.prepare('SELECT id FROM transactions WHERE dedupe_key=?').get(survivorKey);
    if (survivor) await recordCategoryImport(ctx,survivor.id,values,key);
    if (found.match === 'cross_words') counts.crossFormat += 1;
    if (found.match !== 'same' || found.observation.file_id !== fileId) {
      await archive(db, 'transactions', { ...values, dedupe_key: key, normalized_description: normalizeName(row.description) },
        { by: found.observation.file_id ?? null, reason: 'duplicate_cross_format', now, survivorKey });
    }
  };
  let key = dedupeKey(row);
  const retainedId = ctx.reinterpretedTransactions?.get(row);
  if (retainedId) {
    const cols = Object.keys(values);
    await db.prepare(`UPDATE transactions SET ${cols.map(k => `${k}=?`).join(',')},dedupe_key=? WHERE id=?`)
      .run(...cols.map(k => values[k]),key,retainedId);
    counts.revised++;
    return;
  }
  let collided = null;
  let seen = await observations(db, key);
  if (seen.some((o) => o.stored && o.file_id === fileId)) { counts.duplicates += 1; return; }
  if (row.externalAuthoritative && seen.length) {
    const stored = await db.prepare('SELECT * FROM transactions WHERE dedupe_key=? AND parser=?').get(key, parser);
    if (stored && (stored.description !== values.description || stored.date !== values.date || !moneyEq(stored.amount, values.amount))) {
      await archive(db, 'transactions', { ...stored }, { by: fileId, reason: 'revised', now });
      await db.prepare('UPDATE transactions SET description=?,date=?,amount=?,file_id=?,locator=? WHERE id=?')
        .run(values.description, values.date, values.amount, fileId, locator, stored.id);
      counts.revised++;
    } else counts.duplicates++;
    return;
  }
  if (seen.length) {
    const found = samePosting(seen, row.description, parser);
    if (found) return await duplicate(found, key);
    // Another posting under the same key: kept under an alt key and asked about below.
    collided = key;
    key = `${key}:d:${sha256(normalizeName(row.description)).slice(0, 16)}`;
    seen = await observations(db, key);
    if (seen.length) return await duplicate(samePosting(seen, row.description, parser) ?? { match: 'same', observation: seen[0] }, key);
  }
  const categoryTwin=await categoryCounterpart(ctx,row,parser);
  if (categoryTwin) {
    await recordCategoryImport(ctx,categoryTwin.id,values,key);
    await archive(db,'transactions',{...values,dedupe_key:key,normalized_description:normalizeName(row.description)},
      {by:fileId,reason:'duplicate_cross_format',survivorKey:categoryTwin.dedupe_key,now});
    counts.duplicates++; counts.crossFormat++;
    return;
  }
  await db.prepare(`INSERT INTO transactions (account_id, date, amount, description, category, external_id, dedupe_key, file_id, parser, locator, occurrence)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(values.account_id, values.date, values.amount, values.description, values.category, values.external_id, key, fileId, parser, locator, values.occurrence);
  bump(ctx, 'transaction');
  const near = await db.prepare(`SELECT dedupe_key FROM transactions WHERE account_id = ? AND round(amount * 100) = ? AND date BETWEEN ? AND ?
                           AND (file_id IS NULL OR file_id != ?) AND dedupe_key != ? ORDER BY id`)
    .all(row.accountId, Math.round(row.amount * 100), addDays(row.date, -3), addDays(row.date, 3), fileId, key);
  const others = near.map((other) => [other.dedupe_key, NEAR_DATES]);
  // A key collision kept under the alt key is asked about whatever the distance between the dates,
  // against the collided key's active row, or the row its confirmed duplicate was kept against.
  const counterpart = collided && await activeCounterpart(db, collided);
  if (counterpart && counterpart !== key && !near.some((other) => other.dedupe_key === counterpart)) others.push([counterpart, NEAR_KEY]);
  for (const [other, question] of others) {
    const subject = [key, other].sort().join('|');
    tally(ctx, await ask(db, {
      kind: 'near_duplicate', subject, question,
      options: NEAR_DUPLICATE_OPTIONS, context: { accountId: row.accountId, keys: subject.split('|') }, fileId, now,
    }));
  }
}

// Within one file, several balances on one account-day collapse to the closing one: the balance
// that is not another same-day transaction's prior balance (balance - amount); else the first.
function closingBalances(rows) {
  const amountAt = new Map();
  for (const r of rows) if (r.kind === 'transaction') amountAt.set(`${r.accountId}|${JSON.stringify(r.locator ?? null)}`, r.amount);
  const groups = new Map();
  for (const r of rows) {
    if (r.kind !== 'balance') continue;
    const g = `${r.accountId}|${r.date}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ row: r, tx: amountAt.get(`${r.accountId}|${JSON.stringify(r.locator ?? null)}`) });
  }
  const keep = new Set();
  for (const list of groups.values()) {
    const isPrior = (c) => list.some((o) => o !== c && o.tx != null && Math.round((o.row.amount - o.tx) * 100) === Math.round(c.row.amount * 100));
    keep.add((list.find((c) => !isPrior(c)) ?? list[0]).row);
  }
  return keep;
}

const periodTo = async (db, fileId) => (await db.prepare('SELECT period_to FROM files WHERE id = ?').get(fileId))?.period_to ?? null;
// Newer or equal file period (unknown oldest) holds authority over a revision slot.
async function newerOrEqual(db, incomingTo, existingFileId, group = null) {
  const coverage = existingFileId && group ? parseJson((await db.prepare('SELECT coverage FROM files WHERE id=?').get(existingFileId))?.coverage, []) : [];
  const held = coverage.find(g => g.table === group?.table && g.period === group?.period && g.entity === group?.entity && g.slot === group?.slot && g.accountId === group?.accountId);
  const existingTo = held?.authority ?? (existingFileId ? await periodTo(db, existingFileId) : null);
  if (existingTo == null) return true;
  return incomingTo != null && incomingTo >= existingTo;
}

async function putBalance(ctx, row, parser, locator) {
  const { db, fileId, counts, now } = ctx;
  const key = dedupeKey(row);
  const amount = cents(row.amount);
  const stored = await db.prepare('SELECT * FROM balances WHERE account_id = ? AND date = ?').get(row.accountId, row.date);
  if (!stored) {
    await db.prepare('INSERT INTO balances (account_id, date, amount, file_id, parser, locator, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.accountId, row.date, amount, fileId, parser, locator, key);
    bump(ctx, 'balance');
    return;
  }
  const group = ctx.coverage.find(g => g.table === 'balances' && g.accountId === row.accountId && g.period === row.date);
  const authority = await newerOrEqual(db, group?.authority ?? await periodTo(db, fileId), stored.file_id, group);
  if (moneyEq(stored.amount, amount)) {
    if (authority) await db.prepare('UPDATE balances SET file_id = ?, parser = ?, locator = ? WHERE id = ?').run(fileId, parser, locator, stored.id);
    counts.duplicates += 1;
  } else if (authority) {
    await archive(db, 'balances', { ...stored }, { by: fileId, reason: 'revised', now });
    await db.prepare('UPDATE balances SET amount = ?, dedupe_key = ?, file_id = ?, parser = ?, locator = ? WHERE id = ?').run(amount, key, fileId, parser, locator, stored.id);
    counts.revised += 1;
  } else {
    await archive(db, 'balances', { account_id: row.accountId, date: row.date, amount, dedupe_key: key, file_id: fileId, parser, locator }, { by: stored.file_id, reason: 'older_snapshot', now });
    counts.duplicates += 1;
  }
}

async function putPosition(ctx, row, parser, locator) {
  const { db, fileId, counts, now } = ctx;
  const key = dedupeKey(row);
  const values = { quantity: row.quantity ?? null, price: row.price == null ? null : cents(row.price), value: cents(row.value), cost_basis: row.costBasis == null ? null : cents(row.costBasis) };
  const stored = await db.prepare('SELECT * FROM positions WHERE dedupe_key = ?').get(key);
  if (!stored) {
    await db.prepare(`INSERT INTO positions (account_id, as_of, symbol, name, quantity, price, value, cost_basis, file_id, parser, locator, dedupe_key)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.accountId, row.asOf, row.symbol, row.name ?? null, values.quantity, values.price, values.value, values.cost_basis, fileId, parser, locator, key);
    bump(ctx, 'position');
    return;
  }
  const same = numEq(stored.quantity, values.quantity) && moneyEq(stored.price, values.price) && moneyEq(stored.value, values.value) && moneyEq(stored.cost_basis, values.cost_basis);
  const group = ctx.coverage.find(g => g.table === 'positions' && g.accountId === row.accountId && g.period === row.asOf);
  const authority = await newerOrEqual(db, group?.authority ?? await periodTo(db, fileId), stored.file_id, group);
  if (same) {
    if (authority) await db.prepare('UPDATE positions SET file_id = ?, parser = ?, locator = ? WHERE id = ?').run(fileId, parser, locator, stored.id);
    counts.duplicates += 1;
  } else if (authority) {
    await archive(db, 'positions', { ...stored }, { by: fileId, reason: 'revised', now });
    await db.prepare('UPDATE positions SET name = ?, quantity = ?, price = ?, value = ?, cost_basis = ?, file_id = ?, parser = ?, locator = ? WHERE id = ?')
      .run(row.name ?? stored.name, values.quantity, values.price, values.value, values.cost_basis, fileId, parser, locator, stored.id);
    counts.revised += 1;
  } else {
    await archive(db, 'positions', { account_id: row.accountId, as_of: row.asOf, symbol: row.symbol, name: row.name ?? null, ...values, dedupe_key: key, file_id: fileId, parser, locator },
      { by: stored.file_id, reason: 'older_snapshot', now });
    counts.duplicates += 1;
  }
}

const aliasMap = async db => new Map((await db.prepare('SELECT alias,entity FROM entity_aliases').all()).map(row => [row.alias,row.entity]));
async function olderGroup(ctx, group) {
  if (!group) return false;
  const rows = group.table === 'pnl_lines'
    ? await ctx.db.prepare('SELECT file_id FROM pnl_lines WHERE lower(entity)=? AND period=?').all(group.entity.toLowerCase(),group.period)
    : await ctx.db.prepare('SELECT file_id FROM tax_payments WHERE source_slot=? AND substr(date,1,7)=?').all(group.slot,group.period);
  return await someSeries(rows, async row => !await newerOrEqual(ctx.db,group.authority,row.file_id,group));
}
const pnlSlot = (entity, period) => `pnl:${normalizeName(entity)}:${period.slice(0, 4)}`;

async function putPnl(ctx, row, parser, locator) {
  const { db, fileId, counts, now } = ctx;
  const key = dedupeKey(row);
  ctx.keys.add(key);
  const amount = cents(row.amount);
  const stored = await db.prepare('SELECT * FROM pnl_lines WHERE dedupe_key = ?').get(key);
  const group = ctx.coverage.find(g => g.table === 'pnl_lines' && g.entity === row.entity && g.period === row.period);
  if (await olderGroup(ctx,group)) { counts.incomplete++; return; }
  if (!stored) {
    await db.prepare('INSERT INTO pnl_lines (entity, period, category, amount, file_id, parser, locator, dedupe_key, source_slot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.entity, row.period, row.category, amount, fileId, parser, locator, key, pnlSlot(row.entity, row.period));
    bump(ctx, 'pnl_line');
  } else if (moneyEq(stored.amount, amount)) {
    if (group && stored.file_id !== fileId) {
      await archive(db, 'pnl_lines', { ...stored }, { by: fileId, reason: 'duplicate_observation', now });
      await db.prepare('UPDATE pnl_lines SET file_id=?,parser=?,locator=? WHERE id=?').run(fileId,parser,locator,stored.id);
    }
    counts.duplicates += 1;
  } else if (!await newerOrEqual(db, group?.authority ?? await periodTo(db, fileId), stored.file_id, group)) {
    counts.incomplete += 1;
  } else {
    await archive(db, 'pnl_lines', { ...stored }, { by: fileId, reason: 'revised', now });
    await db.prepare('UPDATE pnl_lines SET amount = ?, file_id = ?, parser = ?, locator = ? WHERE id = ?').run(amount, fileId, parser, locator, stored.id);
    counts.revised += 1;
  }
}

async function putTax(ctx, row, parser, locator) {
  const { db, fileId, counts, now } = ctx;
  let slot = row.sourceSlot ?? `tax:${row.taxYear ?? row.sheetYear}:${normalizeName(row.jurisdiction)}:${normalizeName(row.payer)}`;
  let recipient = row.recipient ?? null;
  let payer = row.payer ?? null;
  if (slot?.startsWith('wh:')) {
    // D4 with G4 and H1: every withholding document (paystub, W-2, 1099) belongs to a recipient;
    // remembered answers decide it at import. The payer identity carries the document while the
    // recipient is unknown.
    const r = await withholdingRecipient(db, {
      employerKey: row.employerKey ?? null, employer: row.employer ?? '', issuer: row.issuer ?? '', payer: recipientPayer(row.payer, 'unknown', fileId), fileId, now,
    });
    tally(ctx, r.outcome);
    recipient = r.recipient;
    slot = withRecipient(slot, recipient);
    payer = recipientPayer(row.payer, recipient, fileId);
  }
  const key = dedupeKey({ ...row, payer });
  ctx.keys.add(key);
  const summarizes = Boolean(slot?.startsWith('wh:')) && !slot.endsWith(':unknown');
  const amount = cents(row.amount);
  const shaped = {
    jurisdiction: row.jurisdiction, tax_year: row.taxYear ?? null, date: row.date, amount, kind: row.paymentKind ?? row.kind ?? null, payer,
    date_precision: row.datePrecision ?? null, tax_year_basis: row.taxYearBasis ?? null, dedupe_key: key, source_slot: slot, recipient, file_id: fileId, parser, locator,
  };
  // R15: a W-2 total for the slot summarizes paystub withholding, only once the recipient is known.
  if (summarizes && payer?.startsWith('paystub:')) {
    const w2 = await db.prepare("SELECT file_id FROM tax_payments WHERE source_slot = ? AND payer LIKE 'w2:%' LIMIT 1").get(slot);
    if (w2) {
      if (await db.prepare("SELECT 1 FROM superseded_rows WHERE dedupe_key = ? AND reason = 'summarized'").get(key)) counts.duplicates += 1;
      else { await archive(db, 'tax_payments', shaped, { by: w2.file_id, reason: 'summarized', now }); counts.superseded += 1; }
      return;
    }
  }
  const insert = async (rowPayer, rowKey) => Number((await db.prepare(`INSERT INTO tax_payments (jurisdiction, tax_year, date, amount, kind, file_id, parser, locator, dedupe_key, source_slot, payer, date_precision, tax_year_basis, recipient)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .get(shaped.jurisdiction, shaped.tax_year, shaped.date, amount, shaped.kind, fileId, parser, locator, rowKey, slot, rowPayer, shaped.date_precision, shaped.tax_year_basis, recipient)).id);
  const stored = await db.prepare('SELECT * FROM tax_payments WHERE dedupe_key = ?').get(key);
  const group = ctx.coverage.find(g => g.table === 'tax_payments' && g.slot === slot && g.period === row.date.slice(0, 7));
  if (await olderGroup(ctx,group)) { counts.incomplete++; return; }
  if (!stored) {
    const id = insert(payer, key);
    bump(ctx, 'tax_payment');
    if (summarizes) tally(ctx, await askSlotConflict(db, await db.prepare('SELECT * FROM tax_payments WHERE id = ?').get(id), { now }));
  } else if (moneyEq(stored.amount, amount)) {
    if (group && stored.file_id !== fileId) {
      await archive(db, 'tax_payments', { ...stored }, { by: fileId, reason: 'duplicate_observation', now });
      await db.prepare('UPDATE tax_payments SET file_id=?,parser=?,locator=? WHERE id=?').run(fileId,parser,locator,stored.id);
    }
    counts.duplicates += 1;
  } else if (!await newerOrEqual(db, group?.authority ?? await periodTo(db, fileId), stored.file_id, group)) {
    counts.incomplete += 1;
  } else if (summarizes || row.paymentKind === 'withholding') {
    // K1: a document's withholding of a known recipient with another amount is a conflict, never a
    // revision: a pair already asked about is a repeat; otherwise both stay and the owner is asked.
    if (await conflictAsked(db, key, stored.amount, amount)) counts.duplicates += 1;
    else {
      const later = conflictPayer(payer, fileId);
      const id = insert(later, dedupeKey({ ...row, payer: later }));
      bump(ctx, 'tax_payment');
      const second = await db.prepare('SELECT * FROM tax_payments WHERE id = ?').get(id);
      tally(ctx, await askConflict(db, { key, payer, first: stored, second, now }));
    }
  } else {
    await archive(db, 'tax_payments', { ...stored }, { by: fileId, reason: 'revised', now });
    await db.prepare('UPDATE tax_payments SET amount = ?, file_id = ?, parser = ?, locator = ? WHERE id = ?').run(amount, fileId, parser, locator, stored.id);
    counts.revised += 1;
  }
  if (summarizes && payer?.startsWith('w2:')) counts.superseded += await summarizeSlot(db, slot, { now });
}

async function putDocument(ctx, row, parser, locator) {
  const { db, fileId, counts } = ctx;
  const key = dedupeKey(row);
  if (await db.prepare('SELECT 1 FROM documents WHERE dedupe_key = ?').get(key)) { counts.duplicates += 1; return; }
  await db.prepare('INSERT INTO documents (doc_type, tax_year, fields, file_id, parser, locator, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(row.docType, Number.isInteger(row.taxYear) ? row.taxYear : null, JSON.stringify(row.fields ?? {}), fileId, parser, locator, key);
  bump(ctx, 'document');
}

async function putFact(ctx, row, parser) {
  const r = await recordFact(ctx.db, {
    key: row.key, value: row.value, confidence: row.confidence ?? 1, sourceId: ctx.sourceId, fileId: ctx.fileId, parser,
    locator: row.locator ?? null, asOf: ctx.asOf, now: ctx.now,
  });
  if (r.queued) ctx.counts.queued += 1;
  if (r.written && r.changed) { bump(ctx, 'fact'); ctx.factsChanged = true; } else if (r.written) ctx.counts.duplicates += 1;
}

async function supersede(ctx, coverage) {
  const { db, fileId, counts, now } = ctx;
  for (const group of coverage) {
    if (!group.complete || !['pnl_lines', 'tax_payments'].includes(group.table)) continue;
    const rows = group.table === 'pnl_lines'
      ? await db.prepare('SELECT * FROM pnl_lines WHERE lower(entity)=? AND period=?').all(group.entity.toLowerCase(), group.period)
      : await db.prepare('SELECT * FROM tax_payments WHERE source_slot=? AND substr(date,1,7)=?').all(group.slot, group.period);
    for (const row of rows) {
      if (row.file_id === fileId || ctx.keys.has(row.dedupe_key) || !await newerOrEqual(db, group.authority, row.file_id, group)) continue;
      await archive(db, group.table, { ...row }, { by: fileId, reason: 'removed', now });
      await db.prepare(`DELETE FROM ${group.table} WHERE id=?`).run(row.id); counts.superseded++;
    }
  }
}

// D5 with G5: a positions file or an extracted statement is a complete snapshot of each (account,
// as-of) it lists, unless the file does not prove that account's coverage. A warning other than
// pending activity or an unreadable cost basis makes its account incomplete when it names one (a
// truncated or invalid record carrying the account number), else the whole file. A statement is a
// snapshot only when its extraction carried a holdings list (a snapshot row; an empty list is a
// complete empty snapshot). A complete snapshot archives (reason removed) and removes the stored
// positions of that account and date it no longer lists, where it holds period authority.
const SNAPSHOT_HARMLESS = new Set(['pending_activity', 'invalid_cost_basis']);
// The account id a warning names ({inst, mask} when the parser knew the mask), or null.
const warnedAccountId = (w) => (w.account ? accountIdOf(accountIdentity({ account: w.account })) : null);
async function removeOmittedPositions(ctx, rows, warnings) {
  const { db, fileId, counts, now } = ctx;
  const incomplete = new Set();
  for (const w of warnings ?? []) {
    if (SNAPSHOT_HARMLESS.has(w.code)) continue;
    const id = warnedAccountId(w);
    if (!id) return;
    incomplete.add(id);
  }
  const snapshots = new Map();
  for (const r of rows) {
    if ((r.kind !== 'position' && r.kind !== 'snapshot') || !r.accountId || !r.asOf || incomplete.has(r.accountId)) continue;
    const id = JSON.stringify([r.accountId, r.asOf]);
    if (!snapshots.has(id)) snapshots.set(id, { accountId: r.accountId, asOf: r.asOf, keys: new Set(), locator: null });
    if (r.kind === 'position') snapshots.get(id).keys.add(dedupeKey(r));
    else snapshots.get(id).locator = r.locator ?? null;
  }
  const incomingTo = await periodTo(db, fileId);
  const remove = db.prepare('DELETE FROM positions WHERE id = ?');
  const held = db.prepare('SELECT 1 FROM positions WHERE account_id = ? AND as_of = ? LIMIT 1');
  for (const { accountId, asOf, keys, locator } of snapshots.values()) {
    const group = ctx.coverage.find(g => g.table === 'positions' && g.accountId === accountId && g.period === asOf);
    for (const p of await db.prepare('SELECT * FROM positions WHERE account_id = ? AND as_of = ? ORDER BY id').all(accountId, asOf)) {
      if (keys.has(p.dedupe_key) || p.file_id === fileId || !await newerOrEqual(db, group?.authority ?? incomingTo, p.file_id, group)) continue;
      await archive(db, 'positions', { ...p }, { by: fileId, reason: 'removed', now });
      await remove.run(p.id);
      counts.superseded += 1;
    }
    // H3: a snapshot that leaves nothing held on its date is an empty holdings figure for refreshFigures.
    const prior = ctx.emptySnapshots.get(accountId);
    if (!await held.get(accountId, asOf) && (!prior || asOf > prior.asOf)) ctx.emptySnapshots.set(accountId, { asOf, locator });
  }
}

// An expense-only entity named unlike every income entity may be an alias of one.
async function askEntityAliases(ctx, pnlRows) {
  if (!pnlRows.length) return;
  const { db, fileId, now } = ctx;
  const income = [...new Set((await db.prepare("SELECT DISTINCT entity FROM pnl_lines WHERE category = 'Income' ORDER BY entity").all()).map((r) => r.entity))];
  if (!income.length) return;
  const incomeNames = new Set(income.map(normalizeName));
  const aliases = await aliasMap(db);
  const entities = new Map();
  for (const r of pnlRows) {
    const n = normalizeName(r.entity);
    const e = entities.get(n) ?? { name: r.entity, income: false };
    if (r.category === 'Income') e.income = true;
    entities.set(n, e);
  }
  for (const [n, e] of entities) {
    if (e.income || incomeNames.has(n) || aliases.has(n)) continue;
    tally(ctx, await ask(db, {
      kind: 'entity_alias', subject: n, question: `Is ${e.name} the same business as one of these, or separate?`,
      options: [...income.map((name) => ({ id: `entity:${name}`, label: name })), { id: 'separate', label: 'A separate entity' }],
      context: { alias: e.name }, fileId, now,
    }));
  }
}

// One tax-year question per sheet year whose rows only carry the sheet label.
async function askTaxYears(ctx, rows) {
  const years = [...new Set(rows.filter((r) => r.kind === 'tax_payment' && r.taxYearBasis === 'sheet_label').map((r) => r.sheetYear))].sort();
  for (const year of years) {
    tally(ctx, await ask(ctx.db, {
      kind: 'tax_year', subject: `tax:${year}`, question: `Does the ${year} sheet list payments for tax year ${year}, or payments made during ${year}?`,
      options: taxYearOptions(year), context: { sheetYear: year }, fileId: ctx.fileId, now: ctx.now,
    }));
  }
}

// The latest empty holdings snapshot of an account (H3): this file's, or the one behind a stored
// 0 figure located at a holdings list, whichever is dated later. Returns a figure with asOf, or null.
async function emptyHoldings(ctx, id, key) {
  const { db, fileId, parser, sourceId } = ctx;
  const own = ctx.emptySnapshots.get(id);
  const mine = own ? { v: 0, file_id: fileId, parser, locator: json(own.locator), source_id: sourceId, asOf: own.asOf } : null;
  const stored = await db.prepare(`SELECT g.v, g.file_id, g.parser, g.locator, f.source_id, f.period_to AS asOf FROM figures g LEFT JOIN files f ON f.id = g.file_id
                             WHERE g.key = ?`).get(key);
  const prior = stored && stored.v === 0 && stored.asOf && parseJson(stored.locator, null)?.field === 'holdings' ? stored : null;
  if (!mine || !prior) return mine ?? prior;
  return prior.asOf > mine.asOf ? prior : mine;
}

// Account figures: the latest balance, else the holdings total at the latest as-of date, or 0 when
// an authoritative empty snapshot is dated after every stored position.
export async function refreshFigures(ctx, accountIds) {
  const { db, now } = ctx;
  const accountOf = db.prepare('SELECT id, name, source_id FROM accounts WHERE id = ?');
  for (const id of accountIds) {
    const acct = await accountOf.get(id);
    if (!acct) continue;
    const key = `acct.${id}.balance`;
    let fig = await db.prepare(`SELECT b.amount AS v, b.file_id, b.parser, b.locator, f.source_id FROM balances b LEFT JOIN files f ON f.id = b.file_id
                          WHERE b.account_id = ? ORDER BY b.date DESC, b.id DESC LIMIT 1`).get(id);
    if (!fig) {
      const latest = (await db.prepare('SELECT max(as_of) AS d FROM positions WHERE account_id = ?').get(id))?.d;
      const empty = await emptyHoldings(ctx, id, key);
      if (empty && (!latest || empty.asOf > latest)) fig = empty;
      else if (!latest) continue;
      else {
        const total = (await db.prepare('SELECT sum(value) AS v FROM positions WHERE account_id = ? AND as_of = ?').get(id, latest)).v;
        const last = await db.prepare(`SELECT p.file_id, p.parser, p.locator, f.source_id FROM positions p LEFT JOIN files f ON f.id = p.file_id
                                 WHERE p.account_id = ? AND p.as_of = ? ORDER BY p.id DESC LIMIT 1`).get(id, latest);
        fig = { v: cents(total), file_id: last.file_id, parser: last.parser, locator: last.locator, source_id: last.source_id };
      }
    }
    const src = fig.source_id ?? acct.source_id ?? null;
    await db.prepare(`INSERT INTO figures (key, v, src, kind, label, file_id, parser, locator, updated_at) VALUES (?, ?, ?, 'a', ?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET v = excluded.v, src = excluded.src, kind = excluded.kind, label = excluded.label,
                  file_id = excluded.file_id, parser = excluded.parser, locator = excluded.locator, updated_at = excluded.updated_at`)
      .run(key, fig.v, src, acct.name ?? '', fig.file_id ?? null, fig.parser ?? null, fig.locator ?? null, now);
    await db.prepare('UPDATE accounts SET fig_key = ? WHERE id = ?').run(key, id);
  }
}


const safeTriggerCode = error => [error?.code, error?.name].find(v => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(v)) ?? 'unknown';
export function triggerJob(ctx, jobId) {
  const scheduler = ctx.scheduler ?? ctx.household?.scheduler ?? ctx.services?.household?.scheduler;
  if (!scheduler) return;
  const failed = error => console.error(`fathom: ${jobId} trigger failed`, safeTriggerCode(error));
  try {
    const pending = scheduler.trigger(jobId, 'ingest');
    if (pending && typeof pending.then === 'function') pending.then(null, failed);
  } catch (error) { failed(error); }
}
export const triggerPlan = ctx => triggerJob(ctx, 'plan');
export const triggerGuesses = ctx => triggerJob(ctx, 'confirm-guess');
export const triggerFreshness = ctx => triggerJob(ctx, 'freshness');
