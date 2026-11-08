import { CATEGORY_TABLES } from '../categories/resolve.mjs';
import { kindOf, accountMask, compatibleKind, sameInstitution } from './account-match.mjs';
// Ingest pipeline: store each upload encrypted, route it to a parser, a learned column mapping or
// model extraction, and persist its rows with provenance in one transaction per file: accounts by
// identity, deduplication, revisions and supersede by coverage, confirm questions, sources and
// account figures. Deterministic code decides every stored value. Nothing here logs file contents
// or values; a failure logs an error code only. File text is never stored: a note is kept as a
// reference to its encrypted file, and an input past the parse limits is recorded as too_large.

import { createHash } from 'node:crypto';
import { tx, parseJson } from '../store/db.mjs';
import { refreshPackState } from '../packs/state.mjs';
import { pickParser } from './registry.mjs';
import { identifyAccountRows, dedupeKey } from './dedupe.mjs';
import { readWorkbook, ledgerHeader, taxHeader } from './workbook.mjs';
import { entityOf } from './parsers/pnl-workbook.mjs';
import { header as headerText, cents, institution, isoDate, LimitError } from './format.mjs';
import { readTable, mapTabular, isZip, sourceKindOf as mappedSourceKind, id as MAPPED_ID, label as MAPPED_LABEL } from './mapping.mjs';
import { extractDocument, isPdf, plainText, labelOf } from './extract.mjs';
import {
  ask, recordFact, archive, normalizeName, OWNER_OPTIONS, KIND_OPTIONS, NEAR_DUPLICATE_OPTIONS, EMPLOYER_OPTIONS, taxYearOptions,
  withholdingRecipient, withRecipient, recipientPayer, summarizeSlot, conflictPayer, conflictAsked, askConflict, askSlotConflict,
} from './confirm.mjs';
import { storeFile, readStoredFile, openVault } from './vault.mjs';
import { recordSource } from './freshness.mjs';
import { autoResolve } from './auto.mjs';
import { accountLabel } from '../shared/account-label.mjs';

export const STATUSES = Object.freeze(['imported', 'duplicate', 'needs_mapping', 'needs_extraction', 'unsupported', 'too_large', 'failed']);
const WAITING = ['needs_mapping', 'needs_extraction'];

export class IngestError extends Error {
  constructor(status, code) {
    super(code === 'not_found' ? 'file not found' : 'file is not waiting for a retry');
    this.name = 'IngestError';
    this.status = status;
    this.code = code;
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
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
  resolveAfterImport(db, opts);
  return { results };
}

// Auto-resolution after an import's rows are committed: a failure logs a code and never changes
// a file's result.
function resolveAfterImport(db, opts) {
  try {
    autoResolve(db, { now: opts.now || new Date().toISOString() });
  } catch (error) {
    console.error('fathom: auto-resolve failed', error?.code ?? error?.name ?? 'error');
  }
}

// file = {name, bytes, mime}. Returns {fileId, name, status, sourceKind, parser, counts, duplicateOf?}.
// household.inFlight holds the file ids this household is storing or routing now. A 'pending' row
// whose id is not there was left by an interrupted run and may be routed again. Checked and added
// synchronously, before any await.
export async function ingestFile(db, file, opts = {}) {
  const { inFlight } = householdOf(db, opts);
  db.prepare("DELETE FROM settings WHERE key = 'synthetic_demo'").run();
  const now = opts.now || new Date().toISOString();
  const bytes = toBytes(file.bytes);
  const name = baseName(file.name);
  const hash = sha256(bytes);
  const prior = db.prepare('SELECT id, source_kind, parser, status FROM files WHERE sha256 = ?').get(hash);
  const fileId = prior?.id ?? 'f-' + hash.slice(0, 24);
  if (inFlight.has(fileId) || (prior && prior.status !== 'pending')) {
    return { fileId, name, status: 'duplicate', sourceKind: prior?.source_kind ?? null, parser: prior?.parser ?? null, counts: emptyCounts(), duplicateOf: fileId };
  }
  inFlight.add(fileId);
  try {
    // An interrupted 'pending' file already has its encrypted bytes and row; the upload's bytes match by hash.
    if (!prior) {
      const vault = await openVault(opts.household);
      const storedPath = await storeFile({ vault, id: fileId, bytes, purpose: 'upload' });
      db.prepare(`INSERT INTO files (id, name, mime, size, sha256, uploaded_at, stored_path, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`)
        .run(fileId, name, file.mime ?? null, bytes.length, hash, now, storedPath);
    }
    return await route(db, fileId, { name, bytes, mime: file.mime ?? null }, { ...opts, now });
  } finally {
    inFlight.delete(fileId);
  }
}

// Re-run routing for a file waiting on a mapping or the engine, or left 'pending' by an
// interrupted run, under the same file id.
export async function retryFile(db, fileId, opts = {}) {
  const { inFlight } = householdOf(db, opts);
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(String(fileId ?? ''));
  if (!row) throw new IngestError(404, 'not_found');
  if (inFlight.has(row.id) || !(WAITING.includes(row.status) || row.status === 'pending')) throw new IngestError(409, 'not_waiting');
  inFlight.add(row.id);
  try {
    const vault = await openVault(opts.household);
    const bytes = await readStoredFile({ vault, id: row.id, storedPath: row.stored_path, purpose: 'upload' });
    const now = opts.now || new Date().toISOString();
    const out = await route(db, row.id, { name: row.name, bytes: toBytes(bytes), mime: row.mime }, { ...opts, now });
    resolveAfterImport(db, { ...opts, now });
    return out;
  } finally {
    inFlight.delete(row.id);
  }
}

async function route(db, fileId, file, opts) {
  let out;
  try {
    const plan = await planFile(db, fileId, file, opts);
    out = tx(db, () => persistImport(db, fileId, file, plan, opts));
  } catch (error) {
    if (error instanceof LimitError) return tooLarge(db, fileId, file);
    console.error('fathom: ingest failed', error?.code ?? error?.name ?? 'error');
    db.prepare("UPDATE files SET status = 'failed' WHERE id = ?").run(fileId);
    return { fileId, name: file.name, status: 'failed', sourceKind: null, parser: null, counts: emptyCounts() };
  }
  // The rows are committed. A pack refresh failure must not relabel the file as failed: a re-upload
  // of the same bytes is a duplicate, so the wrong status would stick. The next fact change or
  // startup refreshes packs again.
  if (out.factsChanged) {
    try { refreshPackState(db, { dataDir: opts.household.root, now: opts.now }); } catch (error) { console.error('fathom: pack refresh failed', error?.name ?? 'error'); }
  }
  return out.result;
}

// D1: an input past a parse limit (format.LIMITS) is recorded, not parsed. Its encrypted bytes stay
// in the vault; nothing else is stored.
function tooLarge(db, fileId, file) {
  const counts = { ...emptyCounts(), warnings: 1, warningCodes: { limit_exceeded: 1 } };
  db.prepare("UPDATE files SET status = 'too_large', note = 'limit_exceeded', counts = ? WHERE id = ?").run(JSON.stringify(counts), fileId);
  return { fileId, name: file.name, status: 'too_large', sourceKind: null, parser: null, counts };
}

// D2: a note is stored as a reference to its encrypted file, never as text.
function noteReference(fileId, bytes, text) {
  const body = String(text ?? '');
  const lines = body ? body.split(/\r\n|\r|\n/).length - (/(\r\n|\r|\n)$/.test(body) ? 1 : 0) : 0;
  return { ref: fileId, sha256: sha256(bytes), chars: body.length, lines };
}

function householdEntities(db) {
  return db.prepare(`SELECT entity AS name FROM pnl_lines UNION SELECT entity FROM entity_aliases
                     UNION SELECT name FROM accounts WHERE kind = 'business' AND name IS NOT NULL`).all().map((r) => r.name);
}

// The async half: parse, map or extract. Returns what persist() needs.
async function planFile(db, fileId, file, opts) {
  const { engine, now } = opts;
  if (!file.bytes.length) return { status: 'unsupported', warnings: [{ code: 'empty_file', locator: {} }] };
  const parser = opts.parser ?? pickParser(file);
  if (parser) {
    const parsed = parser.parse(file);
    let status = 'imported';
    let extractPath;
    if (parser.id === 'notes') {
      for (const row of parsed.rows) {
        if (row.kind === 'document' && row.docType === 'notes') row.fields = noteReference(fileId, file.bytes, row.fields?.text);
      }
      const ex = await extractDocument(engine, file, { docType: 'notes', households: { entities: householdEntities(db) }, fileId });
      extractPath = ex.extractPath;
      if (ex.status === 'imported') {
        parsed.rows.push(...ex.rows.map((r) => ({ ...r, parser: 'extract-notes' })));
        parsed.warnings.push(...ex.warnings);
      } else status = 'needs_extraction';
    }
    return { status, parser: parser.id, label: parser.label, sourceKind: parser.sourceKind, mirror: parser.mirror ?? 'manual', parsed, extractPath };
  }
  const table = readTable(file);
  if (table) {
    const mapped = await mapTabular(db, engine, file, { now });
    if (mapped.status !== 'imported') return { status: 'needs_mapping', headerSignature: mapped.signature };
    return { status: 'imported', parser: MAPPED_ID, label: MAPPED_LABEL, sourceKind: mappedSourceKind(mapped.mapping), parsed: mapped.result, headerSignature: mapped.signature };
  }
  if (isZip(file.bytes) || /\.xlsx$/i.test(file.name ?? '')) return { status: 'unsupported', warnings: [{ code: 'unsupported_workbook', locator: {} }] };
  if (isPdf(file) || plainText(file) !== null) {
    const ex = await extractDocument(engine, file, { households: { entities: householdEntities(db) }, fileId });
    if (ex.status !== 'imported') return { status: 'needs_extraction', extractPath: ex.extractPath, note: ex.reason === 'pdf_unreadable' ? 'pdf_unreadable' : null };
    return {
      status: 'imported', parser: `extract-${ex.docType}`, label: labelOf(ex.docType), sourceKind: ex.sourceKind,
      parsed: { rows: ex.rows, warnings: ex.warnings, period: ex.period }, extractPath: ex.extractPath,
    };
  }
  return { status: 'unsupported', warnings: [{ code: 'unsupported_format', locator: {} }] };
}

// The sync half, inside one transaction.
export function persistImport(db, fileId, file, plan, opts) {
  const now = opts.now;
  const counts = emptyCounts();
  if (plan.extractPath) counts.extractPath = plan.extractPath;
  const ctx = { db, fileId, now, counts, parser: plan.parser ?? null, mirror: plan.mirror ?? 'manual', factsChanged: false, keys: new Set(), emptySnapshots: new Map() };
  const warn = (list) => {
    for (const w of list ?? []) {
      counts.warnings += 1;
      counts.warningCodes[w.code] = (counts.warningCodes[w.code] ?? 0) + 1;
    }
  };
  const parsed = plan.parsed;
  warn(plan.warnings);
  const finish = (status, extra = {}) => {
    db.prepare(`UPDATE files SET status = ?, parser = ?, source_kind = ?, counts = ?, note = ?, header_signature = coalesce(?, header_signature) WHERE id = ?`)
      .run(status, plan.parser ?? null, plan.sourceKind ?? null, JSON.stringify(counts), plan.note ?? null, plan.headerSignature ?? null, fileId);
    return {
      result: { fileId, name: file.name, status, sourceKind: plan.sourceKind ?? null, parser: plan.parser ?? null, counts, ...extra },
      factsChanged: ctx.factsChanged,
    };
  };
  if (!parsed) return finish(plan.status);

  identifyAccountRows(parsed, file);
  warn(parsed.warnings);
  const period = parsed.period ?? { from: null, to: null };

  // Accounts: identity, id, and the file's source id.
  const accountRows = parsed.rows.filter((r) => r.account);
  const connected = connectedAccountFor(db);
  for (const row of accountRows) row.accountId ??= connected(row) ?? accountIdOf(accountIdentity(row));
  const accountIds = [...new Set(accountRows.map((r) => r.accountId))];
  const single = accountIds.length === 1 ? accountIds[0] : null;
  const sourceId = `ing:${plan.parser}:${single ?? 'all'}`;
  const singleName = single ? accountName(accountRows.find((r) => r.accountId === single).account) : null;
  ctx.sourceId = sourceId;
  ctx.asOf = period.to ?? now.slice(0, 10);

  const pnlRows = plan.parser === 'pnl-workbook' ? regroupPnl(db, parsed.rows.filter((r) => r.kind === 'pnl_line')) : null;
  let coverage = null;
  if (plan.parser === 'pnl-workbook') {
    coverage = pnlCoverage(db, file, pnlRows);
    if (!pnlRows.length) warn([{ code: 'empty_workbook', locator: {} }]);
  } else if (plan.parser === 'tax-payments') coverage = taxCoverage(file);
  ctx.incomplete = incompleteParts(db, file, plan.parser, parsed.warnings);

  db.prepare(`UPDATE files SET parser = ?, source_kind = ?, source_id = ?, header_signature = coalesce(?, header_signature),
              period_from = ?, period_to = ?, coverage = ? WHERE id = ?`)
    .run(plan.parser, plan.sourceKind, sourceId, plan.headerSignature ?? null, period.from ?? null, period.to ?? null, json(coverage), fileId);
  recordSource(db, { id: sourceId, label: singleName ? `${plan.label} (${singleName})` : plan.label, kind: plan.sourceKind, asOf: period.to, now });

  upsertAccounts(ctx, accountRows);

  const rows = pnlRows ? [...parsed.rows.filter((r) => r.kind !== 'pnl_line'), ...pnlRows] : parsed.rows;
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
      case 'transaction': putTransaction(ctx, row, parser, locator); break;
      case 'balance': if (balances.has(row)) putBalance(ctx, row, parser, locator); break;
      case 'position': putPosition(ctx, row, parser, locator); break;
      case 'pnl_line': putPnl(ctx, row, parser, locator); break;
      case 'tax_payment': putTax(ctx, row, parser, locator, plan.parser === 'tax-payments'); break;
      case 'document': putDocument(ctx, row, parser, locator); break;
      case 'fact':
        if (row.hold) {
          db.prepare('INSERT INTO held_facts (hold, key, value, file_id, parser, locator, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(row.hold, row.key, JSON.stringify(row.value), fileId, parser, locator, row.confidence ?? null, now);
          holds.set(row.employerKey, row.employerName);
        } else putFact(ctx, row, parser);
        break;
      default: break;
    }
  }

  if (coverage?.length) supersede(ctx, coverage);
  removeOmittedPositions(ctx, rows, parsed.warnings);
  askEntityAliases(ctx, pnlRows ?? []);
  if (plan.parser === 'tax-payments') askTaxYears(ctx, rows);
  for (const [employerKey, employerName] of holds) {
    const named = employerName ? `Is ${employerName}` : 'Is this employer';
    tally(ctx, ask(db, {
      kind: 'employer_relation', subject: employerKey, question: `${named} an outside employer or your own business?`,
      options: EMPLOYER_OPTIONS, context: { employerKey, employer: employerName ?? '' }, fileId, now,
    }));
  }
  refreshFigures(ctx, accountIds);
  return finish(plan.status);
}

// A file row for an account first seen through SimpleFIN: when the row's own identity has no
// account and exactly one connected account (identity simplefin:...) has the same institution and
// mask, the row belongs to it. Otherwise null (the row's own identity decides).
function connectedAccountFor(db) {
  const cache = new Map();
  return row => {
    if (row.identity || !accountMask(row.account ?? {})) return null;
    const own = accountIdOf(accountIdentity(row));
    if (cache.has(own)) {
      const target = cache.get(own);
      if (target && !target.identity?.startsWith('simplefin:')) row.account = { ...row.account, inst:target.inst, mask:target.mask, name:target.name };
      return target?.id ?? null;
    }
    let out = null;
    if (!db.prepare('SELECT 1 FROM accounts WHERE id=?').get(own)) {
      const hits = db.prepare(`SELECT DISTINCT a.* FROM simplefin_accounts m JOIN accounts a ON a.id=m.account_id WHERE m.status='mapped'`).all()
        .filter(a => accountMask(a) === accountMask(row.account) && compatibleKind(a,row.account)
          && (sameInstitution(a.inst,row.account.inst) || (a.identity && !a.identity.startsWith('simplefin:') && !row.account.inst)));
      if (hits.length === 1) {
        const target = hits[0];
        out = target.id;
        if (!target.identity?.startsWith('simplefin:')) row.account = { ...row.account, inst:target.inst, mask:target.mask, name:target.name };
      }
    }
    cache.set(own,out ? db.prepare('SELECT * FROM accounts WHERE id=?').get(out) : null);
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
function recordHolder(ctx, row) {
  const holder = String(row.account?.holder ?? '').trim();
  if (!holder) return false;
  ctx.db.prepare('INSERT INTO account_holders (account_id, holder, file_id, locator, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id) DO NOTHING')
    .run(row.accountId, holder, ctx.fileId, json(row.locator ?? null), ctx.now);
  return true;
}

function upsertAccounts(ctx, accountRows) {
  const { db, fileId, now, parser, sourceId, mirror } = ctx;
  const seen = new Set();
  const named = new Set();
  for (const row of accountRows) {
    if (seen.has(row.accountId)) {
      if (!named.has(row.accountId) && recordHolder(ctx, row)) named.add(row.accountId);
      continue;
    }
    seen.add(row.accountId);
    const identity = accountIdentity(row);
    if (db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(row.accountId)) {
      db.prepare('UPDATE accounts SET source_id = ? WHERE id = ? AND source_id IS NOT ?').run(sourceId, row.accountId, sourceId);
      if (recordHolder(ctx, row)) named.add(row.accountId);
      continue;
    }
    const account = row.account;
    const name = accountName(account);
    const shown = accountLabel(account);
    const kind = kindOf(account.kind);
    const mask = /^\d{4}$/.test(account.mask ?? '') ? account.mask : null;
    db.prepare(`INSERT INTO accounts (id, inst, mask, name, owner, kind, mirror, file_id, parser, locator, identity, source_id)
                VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.accountId, institution(account.inst) || null, mask, name, kind, mirror, fileId, row.parser ?? parser, json(row.locator ?? null), identity, sourceId);
    if (recordHolder(ctx, row)) named.add(row.accountId);
    tally(ctx, ask(db, { kind: 'account_owner', subject: row.accountId, question: `Whose account is ${shown}?`, options: OWNER_OPTIONS, context: {}, fileId, now }));
    if (!kind) tally(ctx, ask(db, { kind: 'account_kind', subject: row.accountId, question: `What kind of account is ${shown}?`, options: KIND_OPTIONS, context: {}, fileId, now }));
  }
}

// D3 with G1, G2 and C2: what is already known under a transaction key. The stored row, plus
// archived observations of it: confirmed duplicates (G2 tombstones) and incoming rows deduped across
// formats. Each is {description, parser, file_id}.
const OBSERVED = ['duplicate_confirmed', 'duplicate_cross_format'];
function observations(db, key) {
  const list = [];
  const stored = db.prepare('SELECT description, parser, file_id FROM transactions WHERE dedupe_key = ?').get(key);
  if (stored) list.push({ ...stored, stored: true });
  const archived = db.prepare(`SELECT row, survivor_key FROM superseded_rows WHERE table_name = 'transactions' AND dedupe_key = ? AND reason IN (${OBSERVED.map(() => '?').join(', ')}) ORDER BY id`);
  for (const a of archived.all(key, ...OBSERVED)) {
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

const activeKey = (db, key) => (db.prepare('SELECT 1 FROM transactions WHERE dedupe_key = ?').get(key) ? key : null);
// The active row a key stands for: the key itself, else the first active key reached by following
// confirmed-duplicate survivor links, breadth first. A visited set and a hop cap end cycles, self
// links and missing survivors with null.
const SURVIVOR_HOPS = 16;
function activeCounterpart(db, key) {
  const survivorsOf = db.prepare(`SELECT survivor_key FROM superseded_rows WHERE table_name = 'transactions' AND dedupe_key = ? AND reason IN ('duplicate_confirmed','duplicate_cross_format')
                                  AND survivor_key IS NOT NULL ORDER BY id DESC`);
  const seen = new Set([key]);
  let frontier = [key];
  for (let hop = 0; frontier.length && hop <= SURVIVOR_HOPS; hop += 1) {
    const next = [];
    for (const k of frontier) {
      if (activeKey(db, k)) return k;
      for (const { survivor_key: survivor } of survivorsOf.all(k)) if (!seen.has(survivor)) { seen.add(survivor); next.push(survivor); }
    }
    frontier = next;
  }
  return null;
}

const NEAR_DATES = 'Two imports show the same amount on this account within three days. Are they the same transaction?';
const NEAR_KEY = 'Two imports show the same amount and date or reference number on this account with different descriptions. Are they the same transaction?';

function recordCategoryImport(ctx, transactionId, values, key) {
  if (!values.category || !Object.hasOwn(CATEGORY_TABLES,values.parser)) return;
  ctx.db.prepare(`INSERT INTO transaction_category_imports
    (transaction_id,dedupe_key,category,parser,file_id,locator,date,description,updated_at) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(transaction_id) DO UPDATE SET category=excluded.category,parser=excluded.parser,file_id=excluded.file_id,
      locator=excluded.locator,updated_at=excluded.updated_at WHERE transaction_category_imports.dedupe_key=excluded.dedupe_key`)
    .run(transactionId,key,values.category,values.parser,ctx.fileId,values.locator,values.date,values.description,ctx.now);
}
function categoryCounterpart(ctx,row,parser) {
  if (!row.category || !Object.hasOwn(CATEGORY_TABLES,parser)) return null;
  const candidates=ctx.db.prepare(`SELECT t.* FROM transactions t WHERE t.account_id=? AND t.parser='simplefin'
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

function putTransaction(ctx, row, parser, locator) {
  const { db, fileId, counts, now } = ctx;
  const values = {
    account_id: row.accountId, date: row.date, amount: cents(row.amount), description: row.description ?? null, category: row.category ?? null,
    external_id: row.externalId ?? null, file_id: fileId, parser, locator, occurrence: row.occurrence ?? null,
  };
  // A known posting is skipped. One deduped across formats is archived as an observation, so a
  // later row of its own format is compared with it under the same-format rule (C2).
  const duplicate = (found, key) => {
    counts.duplicates += 1;
    const survivorKey=activeCounterpart(db,found.observation.survivor_key ?? key);
    const survivor=survivorKey && db.prepare('SELECT id FROM transactions WHERE dedupe_key=?').get(survivorKey);
    if (survivor) recordCategoryImport(ctx,survivor.id,values,key);
    if (found.match === 'cross_words') counts.crossFormat += 1;
    if (found.match !== 'same') {
      archive(db, 'transactions', { ...values, dedupe_key: key, normalized_description: normalizeName(row.description) },
        { by: found.observation.file_id ?? null, reason: 'duplicate_cross_format', now, survivorKey });
    }
  };
  let key = dedupeKey(row);
  let collided = null;
  let seen = observations(db, key);
  if (seen.some((o) => o.stored && o.file_id === fileId)) { counts.duplicates += 1; return; }
  if (row.externalAuthoritative && seen.length) { counts.duplicates += 1; return; }
  if (seen.length) {
    const found = samePosting(seen, row.description, parser);
    if (found) return duplicate(found, key);
    // Another posting under the same key: kept under an alt key and asked about below.
    collided = key;
    key = `${key}:d:${sha256(normalizeName(row.description)).slice(0, 16)}`;
    seen = observations(db, key);
    if (seen.length) return duplicate(samePosting(seen, row.description, parser) ?? { match: 'same', observation: seen[0] }, key);
  }
  const categoryTwin=categoryCounterpart(ctx,row,parser);
  if (categoryTwin) {
    recordCategoryImport(ctx,categoryTwin.id,values,key);
    archive(db,'transactions',{...values,dedupe_key:key,normalized_description:normalizeName(row.description)},
      {by:fileId,reason:'duplicate_cross_format',survivorKey:categoryTwin.dedupe_key,now});
    counts.duplicates++; counts.crossFormat++;
    return;
  }
  db.prepare(`INSERT INTO transactions (account_id, date, amount, description, category, external_id, dedupe_key, file_id, parser, locator, occurrence)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(values.account_id, values.date, values.amount, values.description, values.category, values.external_id, key, fileId, parser, locator, values.occurrence);
  bump(ctx, 'transaction');
  const near = db.prepare(`SELECT dedupe_key FROM transactions WHERE account_id = ? AND round(amount * 100) = ? AND date BETWEEN ? AND ?
                           AND (file_id IS NULL OR file_id != ?) AND dedupe_key != ? ORDER BY id`)
    .all(row.accountId, Math.round(row.amount * 100), addDays(row.date, -3), addDays(row.date, 3), fileId, key);
  const others = near.map((other) => [other.dedupe_key, NEAR_DATES]);
  // A key collision kept under the alt key is asked about whatever the distance between the dates,
  // against the collided key's active row, or the row its confirmed duplicate was kept against.
  const counterpart = collided && activeCounterpart(db, collided);
  if (counterpart && counterpart !== key && !near.some((other) => other.dedupe_key === counterpart)) others.push([counterpart, NEAR_KEY]);
  for (const [other, question] of others) {
    const subject = [key, other].sort().join('|');
    tally(ctx, ask(db, {
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

const periodTo = (db, fileId) => db.prepare('SELECT period_to FROM files WHERE id = ?').get(fileId)?.period_to ?? null;
// Newer or equal file period (unknown oldest) holds authority over a revision slot.
function newerOrEqual(db, incomingTo, existingFileId) {
  const existingTo = existingFileId ? periodTo(db, existingFileId) : null;
  if (existingTo == null) return true;
  return incomingTo != null && incomingTo >= existingTo;
}

function putBalance(ctx, row, parser, locator) {
  const { db, fileId, counts, now } = ctx;
  const key = dedupeKey(row);
  const amount = cents(row.amount);
  const stored = db.prepare('SELECT * FROM balances WHERE account_id = ? AND date = ?').get(row.accountId, row.date);
  if (!stored) {
    db.prepare('INSERT INTO balances (account_id, date, amount, file_id, parser, locator, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.accountId, row.date, amount, fileId, parser, locator, key);
    bump(ctx, 'balance');
    return;
  }
  const authority = newerOrEqual(db, periodTo(db, fileId), stored.file_id);
  if (moneyEq(stored.amount, amount)) {
    if (authority) db.prepare('UPDATE balances SET file_id = ?, parser = ?, locator = ? WHERE id = ?').run(fileId, parser, locator, stored.id);
    counts.duplicates += 1;
  } else if (authority) {
    archive(db, 'balances', { ...stored }, { by: fileId, reason: 'revised', now });
    db.prepare('UPDATE balances SET amount = ?, dedupe_key = ?, file_id = ?, parser = ?, locator = ? WHERE id = ?').run(amount, key, fileId, parser, locator, stored.id);
    counts.revised += 1;
  } else {
    archive(db, 'balances', { account_id: row.accountId, date: row.date, amount, dedupe_key: key, file_id: fileId, parser, locator }, { by: stored.file_id, reason: 'older_snapshot', now });
    counts.duplicates += 1;
  }
}

function putPosition(ctx, row, parser, locator) {
  const { db, fileId, counts, now } = ctx;
  const key = dedupeKey(row);
  const values = { quantity: row.quantity ?? null, price: row.price == null ? null : cents(row.price), value: cents(row.value), cost_basis: row.costBasis == null ? null : cents(row.costBasis) };
  const stored = db.prepare('SELECT * FROM positions WHERE dedupe_key = ?').get(key);
  if (!stored) {
    db.prepare(`INSERT INTO positions (account_id, as_of, symbol, name, quantity, price, value, cost_basis, file_id, parser, locator, dedupe_key)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.accountId, row.asOf, row.symbol, row.name ?? null, values.quantity, values.price, values.value, values.cost_basis, fileId, parser, locator, key);
    bump(ctx, 'position');
    return;
  }
  const same = numEq(stored.quantity, values.quantity) && moneyEq(stored.price, values.price) && moneyEq(stored.value, values.value) && moneyEq(stored.cost_basis, values.cost_basis);
  const authority = newerOrEqual(db, periodTo(db, fileId), stored.file_id);
  if (same) {
    if (authority) db.prepare('UPDATE positions SET file_id = ?, parser = ?, locator = ? WHERE id = ?').run(fileId, parser, locator, stored.id);
    counts.duplicates += 1;
  } else if (authority) {
    archive(db, 'positions', { ...stored }, { by: fileId, reason: 'revised', now });
    db.prepare('UPDATE positions SET name = ?, quantity = ?, price = ?, value = ?, cost_basis = ?, file_id = ?, parser = ?, locator = ? WHERE id = ?')
      .run(row.name ?? stored.name, values.quantity, values.price, values.value, values.cost_basis, fileId, parser, locator, stored.id);
    counts.revised += 1;
  } else {
    archive(db, 'positions', { account_id: row.accountId, as_of: row.asOf, symbol: row.symbol, name: row.name ?? null, ...values, dedupe_key: key, file_id: fileId, parser, locator },
      { by: stored.file_id, reason: 'older_snapshot', now });
    counts.duplicates += 1;
  }
}

// P&L rows: entity mapped through entity_aliases, then regrouped (summed, cells concatenated).
function aliasMap(db) {
  return new Map(db.prepare('SELECT alias, entity FROM entity_aliases').all().map((a) => [a.alias, a.entity]));
}
function regroupPnl(db, rows) {
  const aliases = aliasMap(db);
  const groups = new Map();
  for (const r of rows) {
    const entity = aliases.get(normalizeName(r.entity)) ?? r.entity;
    const key = JSON.stringify([normalizeName(entity), r.period, normalizeName(r.category)]);
    const cells = r.locator?.cells ?? (r.locator?.cell ? [r.locator.cell] : []);
    if (!groups.has(key)) groups.set(key, { ...r, entity, amount: 0, locator: { ...r.locator, cells: [] }, sourceEntity: r.entity });
    const g = groups.get(key);
    g.amount = cents(g.amount + r.amount);
    g.locator.cells.push(...cells);
  }
  return [...groups.values()];
}
const pnlSlot = (entity, period) => `pnl:${normalizeName(entity)}:${period.slice(0, 4)}`;

function putPnl(ctx, row, parser, locator) {
  const { db, fileId, counts, now } = ctx;
  const key = dedupeKey(row);
  ctx.keys.add(key);
  const amount = cents(row.amount);
  const stored = db.prepare('SELECT * FROM pnl_lines WHERE dedupe_key = ?').get(key);
  if (!stored) {
    db.prepare('INSERT INTO pnl_lines (entity, period, category, amount, file_id, parser, locator, dedupe_key, source_slot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.entity, row.period, row.category, amount, fileId, parser, locator, key, pnlSlot(row.entity, row.period));
    bump(ctx, 'pnl_line');
  } else if (moneyEq(stored.amount, amount)) {
    counts.duplicates += 1;
  } else if (ctx.incomplete.pnl(row.entity, row.category, row.period)) {
    counts.incomplete += 1;
  } else {
    archive(db, 'pnl_lines', { ...stored }, { by: fileId, reason: 'revised', now });
    db.prepare('UPDATE pnl_lines SET amount = ?, file_id = ?, parser = ?, locator = ? WHERE id = ?').run(amount, fileId, parser, locator, stored.id);
    counts.revised += 1;
  }
}

function putTax(ctx, row, parser, locator, workbook) {
  const { db, fileId, counts, now } = ctx;
  let slot = workbook ? `tax:${row.sheetYear}:${normalizeName(row.jurisdiction)}:${normalizeName(row.payer)}` : (row.sourceSlot ?? null);
  let recipient = workbook ? null : (row.recipient ?? null);
  let payer = row.payer ?? null;
  if (!workbook && slot?.startsWith('wh:')) {
    // D4 with G4 and H1: every withholding document (paystub, W-2, 1099) belongs to a recipient;
    // remembered answers decide it at import. The payer identity carries the document while the
    // recipient is unknown.
    const r = withholdingRecipient(db, {
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
    const w2 = db.prepare("SELECT file_id FROM tax_payments WHERE source_slot = ? AND payer LIKE 'w2:%' LIMIT 1").get(slot);
    if (w2) {
      if (db.prepare("SELECT 1 FROM superseded_rows WHERE dedupe_key = ? AND reason = 'summarized'").get(key)) counts.duplicates += 1;
      else { archive(db, 'tax_payments', shaped, { by: w2.file_id, reason: 'summarized', now }); counts.superseded += 1; }
      return;
    }
  }
  const insert = (rowPayer, rowKey) => Number(db.prepare(`INSERT INTO tax_payments (jurisdiction, tax_year, date, amount, kind, file_id, parser, locator, dedupe_key, source_slot, payer, date_precision, tax_year_basis, recipient)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(shaped.jurisdiction, shaped.tax_year, shaped.date, amount, shaped.kind, fileId, parser, locator, rowKey, slot, rowPayer, shaped.date_precision, shaped.tax_year_basis, recipient).lastInsertRowid);
  const stored = db.prepare('SELECT * FROM tax_payments WHERE dedupe_key = ?').get(key);
  if (!stored) {
    const id = insert(payer, key);
    bump(ctx, 'tax_payment');
    if (summarizes) tally(ctx, askSlotConflict(db, db.prepare('SELECT * FROM tax_payments WHERE id = ?').get(id), { now }));
  } else if (moneyEq(stored.amount, amount)) {
    counts.duplicates += 1;
  } else if (slot && ctx.incomplete.tax.has(slot)) {
    counts.incomplete += 1;
  } else if (summarizes) {
    // K1: a document's withholding of a known recipient with another amount is a conflict, never a
    // revision: a pair already asked about is a repeat; otherwise both stay and the owner is asked.
    if (conflictAsked(db, key, stored.amount, amount)) counts.duplicates += 1;
    else {
      const later = conflictPayer(payer, fileId);
      const id = insert(later, dedupeKey({ ...row, payer: later }));
      bump(ctx, 'tax_payment');
      const second = db.prepare('SELECT * FROM tax_payments WHERE id = ?').get(id);
      tally(ctx, askConflict(db, { key, payer, first: stored, second, now }));
    }
  } else {
    archive(db, 'tax_payments', { ...stored }, { by: fileId, reason: 'revised', now });
    db.prepare('UPDATE tax_payments SET amount = ?, file_id = ?, parser = ?, locator = ? WHERE id = ?').run(amount, fileId, parser, locator, stored.id);
    counts.revised += 1;
  }
  if (summarizes && payer?.startsWith('w2:')) counts.superseded += summarizeSlot(db, slot, { now });
}

function putDocument(ctx, row, parser, locator) {
  const { db, fileId, counts } = ctx;
  const key = dedupeKey(row);
  if (db.prepare('SELECT 1 FROM documents WHERE dedupe_key = ?').get(key)) { counts.duplicates += 1; return; }
  db.prepare('INSERT INTO documents (doc_type, tax_year, fields, file_id, parser, locator, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(row.docType, Number.isInteger(row.taxYear) ? row.taxYear : null, JSON.stringify(row.fields ?? {}), fileId, parser, locator, key);
  bump(ctx, 'document');
}

function putFact(ctx, row, parser) {
  const r = recordFact(ctx.db, {
    key: row.key, value: row.value, confidence: row.confidence ?? 1, sourceId: ctx.sourceId, fileId: ctx.fileId, parser,
    locator: row.locator ?? null, asOf: ctx.asOf, now: ctx.now,
  });
  if (r.queued) ctx.counts.queued += 1;
  if (r.written && r.changed) { bump(ctx, 'fact'); ctx.factsChanged = true; } else if (r.written) ctx.counts.duplicates += 1;
}

// Coverage (R4, R11). P&L: a sheet's entity crossed with the years of that entity's rows in this
// file; an entity with no rows covers a year only when every row in the file falls in that year;
// no rows at all covers nothing.
function pnlCoverage(db, file, pnlRows) {
  if (!pnlRows.length) return [];
  const aliases = aliasMap(db);
  const years = new Map();
  for (const r of pnlRows) {
    const e = normalizeName(r.entity);
    if (!years.has(e)) years.set(e, new Set());
    years.get(e).add(r.period.slice(0, 4));
  }
  const allYears = new Set(pnlRows.map((r) => r.period.slice(0, 4)));
  const slots = new Set();
  for (const sheet of readWorkbook(file).sheets) {
    if (!ledgerHeader(sheet)) continue;
    const raw = entityOf(sheet.name);
    const entity = normalizeName(aliases.get(normalizeName(raw)) ?? raw);
    if (!entity) continue;
    const own = years.get(entity);
    if (own?.size) for (const y of own) slots.add(`pnl:${entity}:${y}`);
    else if (allYears.size === 1) slots.add(`pnl:${entity}:${[...allYears][0]}`);
  }
  return [...slots].sort();
}

// Tax: every year-named sheet with a tax header covers each Paid column's jurisdiction and payer.
function taxCoverage(file) {
  const slots = new Set();
  for (const sheet of readWorkbook(file).sheets) for (const slot of taxSheetSlots(sheet).values()) slots.add(slot);
  return [...slots].sort();
}

// A tax sheet's Paid columns mapped to their slots (empty without a tax header).
function taxSheetSlots(sheet) {
  const order = (column) => [...column].reduce((v, ch) => v * 26 + ch.charCodeAt(0) - 64, 0);
  const slots = new Map();
  const found = taxHeader(sheet);
  if (!found) return slots;
  for (const [column, cell] of sheet.rows[found.index].cells) {
    if (!/\bpaid$/.test(headerText(cell.value))) continue;
    const group = found.groups.filter((g) => order(g.column) <= order(column)).at(-1);
    if (!group) continue;
    const payer = String(cell.value).trim().replace(/\s+paid$/i, '');
    slots.set(column, `tax:${Number(sheet.name)}:${normalizeName(group.jurisdiction)}:${normalizeName(payer)}`);
  }
  return slots;
}

// What this file parsed only partly (F1): an unreadable amount cell must not remove or revise
// stored rows it may have fed. P&L: the warned row's entity (through entity_aliases), category and
// month; an unreadable date widens it to every month and an empty category to every category.
// Tax: the warned cell's Paid column slot, or every Paid slot of its sheet when the column is not
// a known Paid column or the warning is an unreadable Month label (invalid_tax_month).
// Returns { pnl(entity, category, period) -> bool, tax: Set of slots }.
const PARTIAL_CODES = new Set(['formula_without_cache', 'invalid_pnl_row', 'invalid_tax_payment', 'invalid_tax_month']);
function incompleteParts(db, file, parser, warnings) {
  const pnl = [], tax = new Set();
  const parts = { tax, pnl: (entity, category, period) => pnl.some((m) => m.entity === normalizeName(entity)
    && (m.category == null || m.category === normalizeName(category)) && (m.period == null || m.period === period)) };
  const warned = (warnings ?? []).filter((w) => PARTIAL_CODES.has(w.code) && w.locator?.sheet != null);
  if (!warned.length || (parser !== 'pnl-workbook' && parser !== 'tax-payments')) return parts;
  const workbook = readWorkbook(file);
  const sheets = new Map(workbook.sheets.map((sheet) => [sheet.name, sheet]));
  const aliases = aliasMap(db);
  for (const w of warned) {
    const sheet = sheets.get(w.locator.sheet);
    const [, column, rowNumber] = String(w.locator.cell ?? '').match(/^([A-Z]+)(\d+)$/) ?? [];
    if (parser === 'tax-payments') {
      const sheetSlots = sheet ? taxSheetSlots(sheet) : new Map();
      if (w.code !== 'invalid_tax_month' && sheetSlots.has(column)) tax.add(sheetSlots.get(column));
      else for (const slot of sheetSlots.values()) tax.add(slot);
      continue;
    }
    const raw = entityOf(w.locator.sheet);
    const entity = normalizeName(aliases.get(normalizeName(raw)) ?? raw);
    if (!entity) continue;
    const found = sheet && ledgerHeader(sheet);
    const row = found && sheet.rows.find((r) => r.number === Number(rowNumber));
    if (!row) { pnl.push({ entity, category: null, period: null }); continue; }
    const income = found.columns.has('payment date');
    const date = isoDate(row.cells.get(found.columns.get(income ? 'payment date' : 'date'))?.value, workbook.date1904);
    const category = income ? 'Income' : String(row.cells.get(found.columns.get('category'))?.value ?? '').trim();
    pnl.push({ entity, category: category ? normalizeName(category) : null, period: date ? date.slice(0, 7) : null });
  }
  return parts;
}

// Rows of a covered slot from other files whose key this file lacks are archived and removed,
// except rows this file parsed only partly (incompleteParts).
function supersede(ctx, coverage) {
  const { db, fileId, counts, now } = ctx;
  for (const [table, prefix] of [['pnl_lines', 'pnl:'], ['tax_payments', 'tax:']]) {
    const remove = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
    for (const slot of coverage.filter((s) => s.startsWith(prefix) && !ctx.incomplete.tax.has(s))) {
      for (const r of db.prepare(`SELECT * FROM ${table} WHERE source_slot = ? AND (file_id IS NULL OR file_id != ?) ORDER BY id`).all(slot, fileId)) {
        if (ctx.keys.has(r.dedupe_key)) continue;
        if (table === 'pnl_lines' && ctx.incomplete.pnl(r.entity, r.category, r.period)) continue;
        archive(db, table, { ...r }, { by: fileId, reason: 'removed', now });
        remove.run(r.id);
        counts.superseded += 1;
      }
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
const SNAPSHOT_PARSERS = new Set(['brokerage-positions', 'extract-statement']);
const SNAPSHOT_HARMLESS = new Set(['pending_activity', 'invalid_cost_basis']);
// The account id a warning names ({inst, mask} when the parser knew the mask), or null.
const warnedAccountId = (w) => (w.account ? accountIdOf(accountIdentity({ account: w.account })) : null);
function removeOmittedPositions(ctx, rows, warnings) {
  const { db, fileId, counts, now } = ctx;
  if (!SNAPSHOT_PARSERS.has(ctx.parser)) return;
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
  const incomingTo = periodTo(db, fileId);
  const remove = db.prepare('DELETE FROM positions WHERE id = ?');
  const held = db.prepare('SELECT 1 FROM positions WHERE account_id = ? AND as_of = ? LIMIT 1');
  for (const { accountId, asOf, keys, locator } of snapshots.values()) {
    for (const p of db.prepare('SELECT * FROM positions WHERE account_id = ? AND as_of = ? ORDER BY id').all(accountId, asOf)) {
      if (keys.has(p.dedupe_key) || p.file_id === fileId || !newerOrEqual(db, incomingTo, p.file_id)) continue;
      archive(db, 'positions', { ...p }, { by: fileId, reason: 'removed', now });
      remove.run(p.id);
      counts.superseded += 1;
    }
    // H3: a snapshot that leaves nothing held on its date is an empty holdings figure for refreshFigures.
    const prior = ctx.emptySnapshots.get(accountId);
    if (!held.get(accountId, asOf) && (!prior || asOf > prior.asOf)) ctx.emptySnapshots.set(accountId, { asOf, locator });
  }
}

// An expense-only entity named unlike every income entity may be an alias of one.
function askEntityAliases(ctx, pnlRows) {
  if (!pnlRows.length) return;
  const { db, fileId, now } = ctx;
  const income = [...new Set(db.prepare("SELECT DISTINCT entity FROM pnl_lines WHERE category = 'Income' ORDER BY entity").all().map((r) => r.entity))];
  if (!income.length) return;
  const incomeNames = new Set(income.map(normalizeName));
  const aliases = aliasMap(db);
  const entities = new Map();
  for (const r of pnlRows) {
    const n = normalizeName(r.entity);
    const e = entities.get(n) ?? { name: r.entity, income: false };
    if (r.category === 'Income') e.income = true;
    entities.set(n, e);
  }
  for (const [n, e] of entities) {
    if (e.income || incomeNames.has(n) || aliases.has(n)) continue;
    tally(ctx, ask(db, {
      kind: 'entity_alias', subject: n, question: `Is ${e.name} the same business as one of these, or separate?`,
      options: [...income.map((name) => ({ id: `entity:${name}`, label: name })), { id: 'separate', label: 'A separate entity' }],
      context: { alias: e.name }, fileId, now,
    }));
  }
}

// One tax-year question per sheet year whose rows only carry the sheet label.
function askTaxYears(ctx, rows) {
  const years = [...new Set(rows.filter((r) => r.kind === 'tax_payment' && r.taxYearBasis === 'sheet_label').map((r) => r.sheetYear))].sort();
  for (const year of years) {
    tally(ctx, ask(ctx.db, {
      kind: 'tax_year', subject: `tax:${year}`, question: `Does the ${year} sheet list payments for tax year ${year}, or payments made during ${year}?`,
      options: taxYearOptions(year), context: { sheetYear: year }, fileId: ctx.fileId, now: ctx.now,
    }));
  }
}

// The latest empty holdings snapshot of an account (H3): this file's, or the one behind a stored
// 0 figure located at a holdings list, whichever is dated later. Returns a figure with asOf, or null.
function emptyHoldings(ctx, id, key) {
  const { db, fileId, parser, sourceId } = ctx;
  const own = ctx.emptySnapshots.get(id);
  const mine = own ? { v: 0, file_id: fileId, parser, locator: json(own.locator), source_id: sourceId, asOf: own.asOf } : null;
  const stored = db.prepare(`SELECT g.v, g.file_id, g.parser, g.locator, f.source_id, f.period_to AS asOf FROM figures g LEFT JOIN files f ON f.id = g.file_id
                             WHERE g.key = ?`).get(key);
  const prior = stored && stored.v === 0 && stored.asOf && parseJson(stored.locator, null)?.field === 'holdings' ? stored : null;
  if (!mine || !prior) return mine ?? prior;
  return prior.asOf > mine.asOf ? prior : mine;
}

// Account figures: the latest balance, else the holdings total at the latest as-of date, or 0 when
// an authoritative empty snapshot is dated after every stored position.
export function refreshFigures(ctx, accountIds) {
  const { db, now } = ctx;
  const accountOf = db.prepare('SELECT id, name, source_id FROM accounts WHERE id = ?');
  for (const id of accountIds) {
    const acct = accountOf.get(id);
    if (!acct) continue;
    const key = `acct.${id}.balance`;
    let fig = db.prepare(`SELECT b.amount AS v, b.file_id, b.parser, b.locator, f.source_id FROM balances b LEFT JOIN files f ON f.id = b.file_id
                          WHERE b.account_id = ? ORDER BY b.date DESC, b.id DESC LIMIT 1`).get(id);
    if (!fig) {
      const latest = db.prepare('SELECT max(as_of) AS d FROM positions WHERE account_id = ?').get(id)?.d;
      const empty = emptyHoldings(ctx, id, key);
      if (empty && (!latest || empty.asOf > latest)) fig = empty;
      else if (!latest) continue;
      else {
        const total = db.prepare('SELECT sum(value) AS v FROM positions WHERE account_id = ? AND as_of = ?').get(id, latest).v;
        const last = db.prepare(`SELECT p.file_id, p.parser, p.locator, f.source_id FROM positions p LEFT JOIN files f ON f.id = p.file_id
                                 WHERE p.account_id = ? AND p.as_of = ? ORDER BY p.id DESC LIMIT 1`).get(id, latest);
        fig = { v: cents(total), file_id: last.file_id, parser: last.parser, locator: last.locator, source_id: last.source_id };
      }
    }
    const src = fig.source_id ?? acct.source_id ?? null;
    db.prepare(`INSERT INTO figures (key, v, src, kind, label, file_id, parser, locator, updated_at) VALUES (?, ?, ?, 'a', ?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET v = excluded.v, src = excluded.src, kind = excluded.kind, label = excluded.label,
                  file_id = excluded.file_id, parser = excluded.parser, locator = excluded.locator, updated_at = excluded.updated_at`)
      .run(key, fig.v, src, acct.name ?? '', fig.file_id ?? null, fig.parser ?? null, fig.locator ?? null, now);
    db.prepare('UPDATE accounts SET fig_key = ? WHERE id = ?').run(key, id);
  }
}


const safeTriggerCode = error => [error?.code, error?.name].find(v => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(v)) ?? 'unknown';
function triggerJob(ctx, jobId) {
  if (!ctx.scheduler) return;
  const failed = error => console.error(`fathom: ${jobId} trigger failed`, safeTriggerCode(error));
  try {
    const pending = ctx.scheduler.trigger(jobId, 'ingest');
    if (pending && typeof pending.then === 'function') pending.then(null, failed);
  } catch (error) { failed(error); }
}
export const triggerPlan = ctx => triggerJob(ctx, 'plan');
export const triggerGuesses = ctx => triggerJob(ctx, 'confirm-guess');
export const triggerFreshness = ctx => triggerJob(ctx, 'freshness');
