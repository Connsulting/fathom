// Ingest pipeline: store each upload encrypted, route it to a parser, a learned column mapping or
// model extraction, and persist its rows with provenance in one transaction per file: accounts by
// identity, deduplication, revisions and supersede by coverage, confirm questions, sources and
// account figures. Deterministic code decides every stored value. Nothing here logs file contents
// or values; a failure logs an error code only.

import { createHash } from 'node:crypto';
import { tx, getSetting } from '../store/db.mjs';
import { refreshPackState } from '../packs/state.mjs';
import { pickParser } from './registry.mjs';
import { identifyAccountRows, dedupeKey } from './dedupe.mjs';
import { readWorkbook, ledgerHeader, taxHeader } from './workbook.mjs';
import { entityOf } from './parsers/pnl-workbook.mjs';
import { header as headerText, cents, institution, isoDate } from './format.mjs';
import { readTable, mapTabular, sourceKindOf as mappedSourceKind, id as MAPPED_ID, label as MAPPED_LABEL } from './mapping.mjs';
import { extractDocument, isPdf, plainText, labelOf } from './extract.mjs';
import {
  ask, recordFact, archive, normalizeName, OWNER_OPTIONS, KIND_OPTIONS, NEAR_DUPLICATE_OPTIONS, EMPLOYER_OPTIONS, taxYearOptions,
} from './confirm.mjs';
import { storeFile, readStoredFile, loadDataKey } from './vault.mjs';
import { recordSource } from './freshness.mjs';

export const STATUSES = Object.freeze(['imported', 'duplicate', 'needs_mapping', 'needs_extraction', 'unsupported', 'failed']);
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
const emptyCounts = () => ({ rows: {}, duplicates: 0, revised: 0, superseded: 0, incomplete: 0, warnings: 0, warningCodes: {}, queued: 0 });
const baseName = (name) => String(name ?? '').split(/[\\/]/).pop().slice(0, 255) || 'upload';
const toBytes = (bytes) => (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []));
const json = (value) => (value === undefined || value === null ? null : JSON.stringify(value));
const isZip = (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const moneyEq = (a, b) => (a == null && b == null) || (a != null && b != null && Math.round(a * 100) === Math.round(b * 100));
const numEq = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 1e-9);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Account kind from an export's account type; unknown is null (and asked about).
export function kindOf(kind) {
  const k = String(kind ?? '').trim().toLowerCase();
  if (!k) return null;
  if (/roth/.test(k)) return 'roth';
  if (/\bhsa\b|health savings/.test(k)) return 'hsa';
  if (/529/.test(k)) return '529';
  if (/401|403|457|\bira\b|\bsep\b|retirement|pension/.test(k)) return 'retirement';
  if (/credit|\bcard\b/.test(k)) return 'card';
  if (/business/.test(k)) return 'business';
  if (/checking|savings|\bcash\b|money market/.test(k)) return 'cash';
  if (/brokerage|individual|joint|taxable|investment/.test(k)) return 'taxable';
  if (/loan|mortgage|line of credit/.test(k)) return 'loan';
  return null;
}

// Normalized account identity: inst|mask:<mask>, inst|name:<name>, else source:<hash>.
export function accountIdentity(row) {
  const account = row.account ?? {};
  const inst = normalizeName(institution(account.inst));
  if (account.mask) return `${inst}|mask:${account.mask}`;
  const name = normalizeName(account.name);
  if (name) return `${inst}|name:${name}`;
  return `source:${row.locator?.source ?? ''}`;
}
export const accountIdOf = (identity) => 'acct-' + sha256(identity).slice(0, 16);

async function dataKey(db, opts) {
  if (opts.key) return opts.key;
  const config = opts.config ?? {};
  return loadDataKey({ dataDir: config.dataDir, keyFile: config.dataKeyFile, mode: getSetting(db, 'mode', 'real') });
}
const dataDirOf = (opts) => opts.config?.dataDir ?? opts.dataDir;

export async function ingestFiles(db, files, opts = {}) {
  const results = [];
  for (const file of files) results.push(await ingestFile(db, file, opts));
  return { results };
}

// file = {name, bytes, mime}. Returns {fileId, name, status, sourceKind, parser, counts, duplicateOf?}.
export async function ingestFile(db, file, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const bytes = toBytes(file.bytes);
  const name = baseName(file.name);
  const hash = sha256(bytes);
  const prior = db.prepare('SELECT id, source_kind, parser FROM files WHERE sha256 = ?').get(hash);
  if (prior) {
    return { fileId: prior.id, name, status: 'duplicate', sourceKind: prior.source_kind ?? null, parser: prior.parser ?? null, counts: emptyCounts(), duplicateOf: prior.id };
  }
  const fileId = 'f-' + hash.slice(0, 24);
  const key = await dataKey(db, opts);
  const storedPath = await storeFile({ dataDir: dataDirOf(opts), key, id: fileId, bytes });
  db.prepare(`INSERT INTO files (id, name, mime, size, sha256, uploaded_at, stored_path, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`)
    .run(fileId, name, file.mime ?? null, bytes.length, hash, now, storedPath);
  return route(db, fileId, { name, bytes, mime: file.mime ?? null }, { ...opts, now });
}

// Re-run routing for a file waiting on a mapping or the engine, under the same file id.
export async function retryFile(db, fileId, opts = {}) {
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(String(fileId ?? ''));
  if (!row) throw new IngestError(404, 'not_found');
  if (!WAITING.includes(row.status)) throw new IngestError(409, 'not_waiting');
  const key = await dataKey(db, opts);
  const bytes = await readStoredFile({ dataDir: dataDirOf(opts), key, id: row.id, storedPath: row.stored_path });
  return route(db, row.id, { name: row.name, bytes: toBytes(bytes), mime: row.mime }, { ...opts, now: opts.now || new Date().toISOString() });
}

async function route(db, fileId, file, opts) {
  try {
    const plan = await planFile(db, fileId, file, opts);
    const out = tx(db, () => persist(db, fileId, file, plan, opts));
    if (out.factsChanged) refreshPackState(db, { dataDir: dataDirOf(opts), now: opts.now });
    return out.result;
  } catch (error) {
    console.error('fathom: ingest failed', error?.code ?? error?.name ?? 'error');
    db.prepare("UPDATE files SET status = 'failed' WHERE id = ?").run(fileId);
    return { fileId, name: file.name, status: 'failed', sourceKind: null, parser: null, counts: emptyCounts() };
  }
}

function householdEntities(db) {
  return db.prepare(`SELECT entity AS name FROM pnl_lines UNION SELECT entity FROM entity_aliases
                     UNION SELECT name FROM accounts WHERE kind = 'business' AND name IS NOT NULL`).all().map((r) => r.name);
}

// The async half: parse, map or extract. Returns what persist() needs.
async function planFile(db, fileId, file, opts) {
  const { engine, now } = opts;
  if (!file.bytes.length) return { status: 'unsupported', warnings: [{ code: 'empty_file', locator: {} }] };
  const parser = pickParser(file);
  if (parser) {
    const parsed = parser.parse(file);
    let status = 'imported';
    if (parser.id === 'notes') {
      const ex = await extractDocument(engine, file, { docType: 'notes', households: { entities: householdEntities(db) }, fileId });
      if (ex.status === 'imported') {
        parsed.rows.push(...ex.rows.map((r) => ({ ...r, parser: 'extract-notes' })));
        parsed.warnings.push(...ex.warnings);
      } else status = 'needs_extraction';
    }
    return { status, parser: parser.id, label: parser.label, sourceKind: parser.sourceKind, parsed };
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
    if (ex.status !== 'imported') return { status: 'needs_extraction' };
    return { status: 'imported', parser: `extract-${ex.docType}`, label: labelOf(ex.docType), sourceKind: ex.sourceKind, parsed: { rows: ex.rows, warnings: ex.warnings, period: ex.period } };
  }
  return { status: 'unsupported', warnings: [{ code: 'unsupported_format', locator: {} }] };
}

// The sync half, inside one transaction.
function persist(db, fileId, file, plan, opts) {
  const now = opts.now;
  const counts = emptyCounts();
  const ctx = { db, fileId, now, counts, parser: plan.parser ?? null, factsChanged: false, keys: new Set() };
  const warn = (list) => {
    for (const w of list ?? []) {
      counts.warnings += 1;
      counts.warningCodes[w.code] = (counts.warningCodes[w.code] ?? 0) + 1;
    }
  };
  const parsed = plan.parsed;
  warn(plan.warnings);
  const finish = (status, extra = {}) => {
    db.prepare(`UPDATE files SET status = ?, parser = ?, source_kind = ?, counts = ?, header_signature = coalesce(?, header_signature) WHERE id = ?`)
      .run(status, plan.parser ?? null, plan.sourceKind ?? null, JSON.stringify(counts), plan.headerSignature ?? null, fileId);
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
  for (const row of accountRows) row.accountId = accountIdOf(accountIdentity(row));
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

function upsertAccounts(ctx, accountRows) {
  const { db, fileId, now, parser, sourceId } = ctx;
  const seen = new Set();
  for (const row of accountRows) {
    if (seen.has(row.accountId)) continue;
    seen.add(row.accountId);
    const identity = accountIdentity(row);
    if (db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(row.accountId)) {
      db.prepare('UPDATE accounts SET source_id = ? WHERE id = ?').run(sourceId, row.accountId);
      continue;
    }
    const account = row.account;
    const name = accountName(account);
    const kind = kindOf(account.kind);
    const mask = /^\d{4}$/.test(account.mask ?? '') ? account.mask : null;
    db.prepare(`INSERT INTO accounts (id, inst, mask, name, owner, kind, mirror, file_id, parser, locator, identity, source_id)
                VALUES (?, ?, ?, ?, NULL, ?, 'manual', ?, ?, ?, ?, ?)`)
      .run(row.accountId, institution(account.inst) || null, mask, name, kind, fileId, row.parser ?? parser, json(row.locator ?? null), identity, sourceId);
    tally(ctx, ask(db, { kind: 'account_owner', subject: row.accountId, question: `Whose account is ${name}?`, options: OWNER_OPTIONS, context: {}, fileId, now }));
    if (!kind) tally(ctx, ask(db, { kind: 'account_kind', subject: row.accountId, question: `What kind of account is ${name}?`, options: KIND_OPTIONS, context: {}, fileId, now }));
  }
}

function putTransaction(ctx, row, parser, locator) {
  const { db, fileId, counts, now } = ctx;
  const key = dedupeKey(row);
  if (db.prepare('SELECT 1 FROM transactions WHERE dedupe_key = ?').get(key)
    || db.prepare("SELECT 1 FROM superseded_rows WHERE dedupe_key = ? AND reason = 'duplicate_confirmed'").get(key)) {
    counts.duplicates += 1;
    return;
  }
  db.prepare(`INSERT INTO transactions (account_id, date, amount, description, category, external_id, dedupe_key, file_id, parser, locator, occurrence)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.accountId, row.date, cents(row.amount), row.description ?? null, row.category ?? null, row.externalId ?? null, key, fileId, parser, locator, row.occurrence ?? null);
  bump(ctx, 'transaction');
  const near = db.prepare(`SELECT dedupe_key FROM transactions WHERE account_id = ? AND round(amount * 100) = ? AND date BETWEEN ? AND ?
                           AND (file_id IS NULL OR file_id != ?) AND dedupe_key != ? ORDER BY id`)
    .all(row.accountId, Math.round(row.amount * 100), addDays(row.date, -3), addDays(row.date, 3), fileId, key);
  for (const other of near) {
    const subject = [key, other.dedupe_key].sort().join('|');
    tally(ctx, ask(db, {
      kind: 'near_duplicate', subject, question: 'Two imports show the same amount on this account within three days. Are they the same transaction?',
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

// Newer or equal file period (unknown oldest) holds authority over a revision slot.
function newerOrEqual(db, incomingTo, existingFileId) {
  const existingTo = existingFileId ? db.prepare('SELECT period_to FROM files WHERE id = ?').get(existingFileId)?.period_to ?? null : null;
  if (existingTo == null) return true;
  return incomingTo != null && incomingTo >= existingTo;
}
const periodTo = (db, fileId) => db.prepare('SELECT period_to FROM files WHERE id = ?').get(fileId)?.period_to ?? null;

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
  const key = dedupeKey(row);
  ctx.keys.add(key);
  const slot = workbook ? `tax:${row.sheetYear}:${normalizeName(row.jurisdiction)}:${normalizeName(row.payer)}` : (row.sourceSlot ?? null);
  const amount = cents(row.amount);
  const payer = row.payer ?? null;
  const shaped = {
    jurisdiction: row.jurisdiction, tax_year: row.taxYear ?? null, date: row.date, amount, kind: row.paymentKind ?? row.kind ?? null, payer,
    date_precision: row.datePrecision ?? null, tax_year_basis: row.taxYearBasis ?? null, dedupe_key: key, source_slot: slot, file_id: fileId, parser, locator,
  };
  // R15: a W-2 total for the slot summarizes paystub withholding.
  if (slot && payer?.startsWith('paystub:')) {
    const w2 = db.prepare("SELECT file_id FROM tax_payments WHERE source_slot = ? AND payer LIKE 'w2:%' LIMIT 1").get(slot);
    if (w2) {
      if (db.prepare("SELECT 1 FROM superseded_rows WHERE dedupe_key = ? AND reason = 'summarized'").get(key)) counts.duplicates += 1;
      else { archive(db, 'tax_payments', shaped, { by: w2.file_id, reason: 'summarized', now }); counts.superseded += 1; }
      return;
    }
  }
  const stored = db.prepare('SELECT * FROM tax_payments WHERE dedupe_key = ?').get(key);
  if (!stored) {
    db.prepare(`INSERT INTO tax_payments (jurisdiction, tax_year, date, amount, kind, file_id, parser, locator, dedupe_key, source_slot, payer, date_precision, tax_year_basis)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(shaped.jurisdiction, shaped.tax_year, shaped.date, amount, shaped.kind, fileId, parser, locator, key, slot, payer, shaped.date_precision, shaped.tax_year_basis);
    bump(ctx, 'tax_payment');
  } else if (moneyEq(stored.amount, amount)) {
    counts.duplicates += 1;
  } else if (slot && ctx.incomplete.tax.has(slot)) {
    counts.incomplete += 1;
  } else {
    archive(db, 'tax_payments', { ...stored }, { by: fileId, reason: 'revised', now });
    db.prepare('UPDATE tax_payments SET amount = ?, file_id = ?, parser = ?, locator = ? WHERE id = ?').run(amount, fileId, parser, locator, stored.id);
    counts.revised += 1;
  }
  if (slot && payer?.startsWith('w2:')) {
    for (const r of db.prepare("SELECT * FROM tax_payments WHERE source_slot = ? AND payer LIKE 'paystub:%' ORDER BY id").all(slot)) {
      archive(db, 'tax_payments', { ...r }, { by: fileId, reason: 'summarized', now });
      db.prepare('DELETE FROM tax_payments WHERE id = ?').run(r.id);
      counts.superseded += 1;
    }
  }
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
    for (const slot of coverage.filter((s) => s.startsWith(prefix) && !ctx.incomplete.tax.has(s))) {
      for (const r of db.prepare(`SELECT * FROM ${table} WHERE source_slot = ? AND (file_id IS NULL OR file_id != ?) ORDER BY id`).all(slot, fileId)) {
        if (ctx.keys.has(r.dedupe_key)) continue;
        if (table === 'pnl_lines' && ctx.incomplete.pnl(r.entity, r.category, r.period)) continue;
        archive(db, table, { ...r }, { by: fileId, reason: 'removed', now });
        db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(r.id);
        counts.superseded += 1;
      }
    }
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

// Account figures: the latest balance, else the holdings total at the latest as-of date.
function refreshFigures(ctx, accountIds) {
  const { db, now } = ctx;
  const ids = new Set(accountIds.map((id) => db.prepare('SELECT id FROM accounts WHERE id = ?').get(id)?.id).filter(Boolean));
  for (const id of ids) {
    const acct = db.prepare('SELECT id, name, source_id FROM accounts WHERE id = ?').get(id);
    let fig = db.prepare(`SELECT b.amount AS v, b.file_id, b.parser, b.locator, f.source_id FROM balances b LEFT JOIN files f ON f.id = b.file_id
                          WHERE b.account_id = ? ORDER BY b.date DESC, b.id DESC LIMIT 1`).get(id);
    if (!fig) {
      const latest = db.prepare('SELECT max(as_of) AS d FROM positions WHERE account_id = ?').get(id)?.d;
      if (!latest) continue;
      const total = db.prepare('SELECT sum(value) AS v FROM positions WHERE account_id = ? AND as_of = ?').get(id, latest).v;
      const last = db.prepare(`SELECT p.file_id, p.parser, p.locator, f.source_id FROM positions p LEFT JOIN files f ON f.id = p.file_id
                               WHERE p.account_id = ? AND p.as_of = ? ORDER BY p.id DESC LIMIT 1`).get(id, latest);
      fig = { v: cents(total), file_id: last.file_id, parser: last.parser, locator: last.locator, source_id: last.source_id };
    }
    const key = `acct.${id}.balance`;
    const src = fig.source_id ?? acct.source_id ?? null;
    db.prepare(`INSERT INTO figures (key, v, src, kind, label, file_id, parser, locator, updated_at) VALUES (?, ?, ?, 'a', ?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET v = excluded.v, src = excluded.src, kind = excluded.kind, label = excluded.label,
                  file_id = excluded.file_id, parser = excluded.parser, locator = excluded.locator, updated_at = excluded.updated_at`)
      .run(key, fig.v, src, acct.name ?? '', fig.file_id ?? null, fig.parser ?? null, fig.locator ?? null, now);
    db.prepare('UPDATE accounts SET fig_key = ? WHERE id = ?').run(key, id);
  }
}

