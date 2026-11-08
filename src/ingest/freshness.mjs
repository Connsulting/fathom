import { queueCategoryChecks } from '../categories/store.mjs';
// Freshness of ingest sources: cadence per source kind, state at the scenario clock, the ingest
// summary the scenario carries as live.ingest, and stale notes on plan domains.
// Only sources whose id starts with 'ing:' are ingest sources; demo seeded sources are untouched.

import { getSetting, parseJson } from '../store/db.mjs';
import { escapeUserText } from '../shared/tokens.mjs';
import { accountNaming } from '../accounts/naming.mjs';
import { howToFor, listHowTo } from './howto.mjs';
import { monthEnd } from './format.mjs';
import { pendingItems, finalReason } from './confirm.mjs';
import { cardDetail } from './context.mjs';
import { bestGuess } from './bestguess.mjs';
import { sourceStates } from './coverage.mjs';
import { accountLabel } from '../shared/account-label.mjs';
import { transactionDisplayName, plainEvidence } from '../categories/display.mjs';

const MONTHLY = Object.freeze({ label: 'monthly', staleAfterDays: 45 });

export const CADENCE = Object.freeze({
  model_import: MONTHLY,
  bank_csv: MONTHLY,
  card_csv: MONTHLY,
  aggregator_csv: MONTHLY,
  balances: MONTHLY,
  brokerage_positions: MONTHLY,
  statement: MONTHLY,
  pnl_workbook: MONTHLY,
  // A connected account synced inside the monthly window is fresh. A file feed on the same
  // account does not keep it stale: account freshness uses the newest row, not the file source date.
  simplefin: MONTHLY,
  paystub: Object.freeze({ label: 'per pay period', staleAfterDays: 35 }),
  tax_payments: Object.freeze({ label: 'quarterly', staleAfterDays: 100 }),
  tax_doc: Object.freeze({ label: 'annual', staleAfterDays: 400 }),
  notes: null,
  other: null,
});

export const DOMAIN_OF = Object.freeze({
  bank_csv: 'cash',
  card_csv: 'cash',
  aggregator_csv: 'cash',
  balances: 'cash',
  simplefin: 'cash',
  brokerage_positions: 'invest',
  statement: 'invest',
  pnl_workbook: 'entities',
  tax_payments: 'tax',
  tax_doc: 'tax',
  paystub: 'payroll',
});

// Names for a domain the store does not have yet (the demo scenario's names).
const DOMAIN_NAMES = Object.freeze({
  cash: 'Cash and reserves',
  invest: 'Investments, tax view',
  entities: 'Entities and filings',
  tax: 'Estimated tax',
  payroll: 'Payroll and owner pay',
});

const DAY_MS = 86400000;
const FILES_LIMIT = 50;

// 'YYYY-MM-DD' (optionally followed by a time) to epoch ms at UTC midnight, or null.
function dayMs(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? ms : null;
}

const isoDay = (value) => (dayMs(value) == null ? null : String(value).slice(0, 10));
const today = () => new Date().toISOString().slice(0, 10);

export function freshnessOf({ kind, asOf } = {}, clock) {
  const cadence = CADENCE[kind] ?? null;
  const at = dayMs(asOf);
  const now = dayMs(clock ?? today()) ?? dayMs(today());
  if (!cadence || at == null) return { state: 'unknown', ageDays: null, cadence };
  const ageDays = Math.max(0, Math.floor((now - at) / DAY_MS));
  return { state: ageDays > cadence.staleAfterDays ? 'stale' : 'fresh', ageDays, cadence };
}

// Upserts an ingest source, keeping the latest ISO as_of and stamping last_ingest_at.
export function recordSource(db, { id, label, kind, asOf, now } = {}) {
  if (typeof id !== 'string' || id === '') throw new TypeError('A source id is required');
  const stamp = now || new Date().toISOString();
  const existing = db.prepare('SELECT as_of FROM sources WHERE id = ?').get(id);
  const incoming = isoDay(asOf);
  const stored = existing ? isoDay(existing.as_of) : null;
  const latest = incoming && (!stored || incoming > stored) ? incoming : (stored ?? (existing ? existing.as_of : null));
  db.prepare(`INSERT INTO sources (id, label, as_of, kind, last_ingest_at, note) VALUES (?, ?, ?, ?, ?, '')
              ON CONFLICT(id) DO UPDATE SET label = excluded.label, as_of = excluded.as_of, kind = excluded.kind,
                last_ingest_at = excluded.last_ingest_at`)
    .run(id, String(label ?? id), latest, kind ?? null, stamp);
  return { id, asOf: latest };
}

export function listImportedFiles(db) {
  const result = { files: db.prepare('SELECT id, name, status, source_kind, parser, counts, uploaded_at FROM files WHERE removed_at IS NULL ORDER BY uploaded_at DESC, rowid DESC').all().map(row => fileWithProposal(db,row)) };
  while (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024 && result.files.length) {
    result.files.splice(Math.floor(result.files.length / 2));
    result.truncated = true;
  }
  return result;
}

// A files row as the API returns it.
function fileWithProposal(db, row) {
  const file = fileOf(row);
  const proposal = db.prepare('SELECT id,version,status,reason_code,review_state FROM import_proposals WHERE file_id=? ORDER BY version DESC,rowid DESC LIMIT 1').get(row.id);
  if (!proposal) return file;
  const review = parseJson(proposal.review_state, {}) ?? {};
  const presentation = review.presentation ?? {};
  const batch = db.prepare('SELECT receipt_id FROM import_batches WHERE proposal_id=? AND proposal_version=?').get(proposal.id,proposal.version);
  const kind = review.kind === 'actions' ? 'actions' : 'import';
  const list = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);
  // Each header column of the approved structure with the layout field reading it (null when unused).
  const tables = review.layout?.tables ?? [];
  const columns = kind === 'import' ? list(review.structural?.headers, 50).flatMap((h, i) => list(h?.columns, 50).map(c => ({ ordinal: c.ordinal, label: String(c.label ?? ''),
    field: Object.entries(tables[i]?.fields ?? {}).find(([, s]) => Array.isArray(s?.columns) && s.columns.includes(c.ordinal))?.[0] ?? null }))).slice(0, 50) : [];
  const actions = kind === 'actions' ? list(presentation.actions, 20).map(a => {
    const e = a?.expectedTransaction;
    return { label: String(a?.label ?? ''), subject: e?.subject ?? null, dueDate: e?.dueDate ?? null, amount: Number.isFinite(e?.amount) ? e.amount : null };
  }) : [];
  return { ...file, proposal: { id: proposal.id, version: proposal.version, status: proposal.status, reasonCode: proposal.reason_code,
    summary: presentation.summary ?? null, counts: presentation.counts ?? null, receiptId: batch?.receipt_id ?? null,
    kind, delta: list(presentation.delta, 20), errors: list(presentation.errors, 10),
    question: typeof presentation.question === 'string' ? presentation.question : null, actions,
    notes: Array.isArray(presentation.notes) ? presentation.notes.length : 0,
    permission: Array.isArray(presentation.permission?.scopes) ? presentation.permission.scopes : null, columns } };
}

export function fileOf(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    sourceKind: row.source_kind ?? null,
    parser: row.parser ?? null,
    counts: parseJson(row.counts, null),
    uploadedAt: row.uploaded_at,
  };
}

function clockOf(db, clock) {
  if (clock) return clock;
  const stored = getSetting(db, 'clock', null);
  return typeof stored === 'string' && dayMs(stored) != null ? stored : today();
}

// Rank by impact (plan, Ingest state 2): tax questions first, then fact checks, account questions,
// matches and aliases, near duplicates last. Account questions carry a group the deck folds into
// one card.
const RANK = Object.freeze({
  tax_year: 0, employer_relation: 0, employer_recipient: 0, document_recipient: 0, withholding_conflict: 0,
  transaction_category: 1, category_mapping: 1, fact_check: 1, account_kind: 2, account_owner: 2, account_match: 3, entity_alias: 3, near_duplicate: 4,
});
const GROUPED = new Set(['account_owner', 'account_kind']);
const rankOf = (kind) => RANK[kind] ?? 5;
const balanceSize = (item) => Math.abs(item.detail?.account?.balance?.amount ?? 0);

// The transaction a category question is about, as the Confirm screen shows it: a readable name
// (structured bank text read first, else the clean merchant name), the raw bank text (behind a toggle), signed amount, ISO date and account. null for any
// other kind of question.
function txnOf(kind, context) {
  if (kind !== 'transaction_category') return null;
  const c = context && typeof context === 'object' ? context : {};
  return { name: transactionDisplayName(c.description), raw: String(c.description ?? ''), amount: c.amount ?? null, date: c.date ?? null, account: String(c.account ?? '') };
}
// Category evidence is shown to a person: no vendor name, model id or percentage.
const evidenceFor = (kind, text) => (kind === 'transaction_category' ? plainEvidence(text) : String(text ?? ''));

// Pending items with fileName (the item's file name or null), detail (cardDetail), guess (the best
// guess as {option, label, reason, evidence, source, model?, ts?}, reason being the evidence text;
// model and ts for an engine guess), rank and group. Sorted by rank, then (account questions) the
// larger absolute latest balance, then id.
function pendingWithGuesses(db) {
  const extra = new Map(db.prepare(`SELECT ci.id, f.name AS file_name, g.model, g.ts
                                    FROM confirm_items ci LEFT JOIN files f ON f.id = ci.file_id
                                    LEFT JOIN confirm_guesses g ON g.item_id = ci.id
                                    WHERE ci.status = 'pending'`).all().map((r) => [r.id, r]));
  const items = pendingItems(db).filter(item => item.kind !== 'resolver_fact').map((item) => {
    const r = extra.get(item.id);
    const detail = cardDetail(db, item);
    const g = bestGuess(db, item, detail);
    const evidence = g ? evidenceFor(item.kind, g.evidence) : '';
    const guess = g ? {
      option: g.option, label: g.label, reason: evidence, evidence, source: g.source,
      ...(g.confidence==null?{}:{confidence:g.confidence}),
      ...(g.source === 'engine' ? { model: r?.model ?? null, ts: r?.ts ?? null } : {}),
    } : null;
    const label = detail?.type === 'account' ? detail.account?.label : '';
    const question = label && item.kind === 'account_owner' ? `Whose account is ${label}?`
      : label && item.kind === 'account_kind' ? `What kind of account is ${label}?`
        : label && detail.account?.name && detail.account.name !== label
          ? String(item.question).split(detail.account.name).join(label)
          : item.question;
    const txn = txnOf(item.kind, item.context);
    return { ...item, question, fileName: r?.file_name ?? null, detail, guess, rank: rankOf(item.kind), group: GROUPED.has(item.kind) ? item.kind : null, ...(txn ? { txn } : {}) };
  });
  return items.sort((a, b) => a.rank - b.rank || (['transaction_category','category_mapping'].includes(a.kind) && ['transaction_category','category_mapping'].includes(b.kind) ? Math.abs(b.context.amount)-Math.abs(a.context.amount) : 0) || (a.group && b.group ? balanceSize(b) - balanceSize(a) : 0) || a.id - b.id);
}

// Answers Fathom recorded itself, newest first: {id, kind, question, answer, answerLabel, rule,
// evidence (the evidence text), final (finalReason or null), txn (category answers only)}.
function decidedItems(db) {
  return db.prepare(`SELECT ci.id, ci.kind, ci.question, ci.options, ci.context, ci.status, ci.answer, a.rule, a.evidence
                     FROM confirm_auto a JOIN confirm_items ci ON ci.id = a.item_id
                     WHERE ci.status = 'answered' ORDER BY a.created_at DESC, ci.id DESC`).all().map((r) => {
    const option = parseJson(r.options, []).find((o) => o.id === r.answer);
    const evidence = parseJson(r.evidence, null);
    return {
      id: r.id,
      kind: r.kind,
      question: r.question,
      answer: r.answer,
      answerLabel: option ? option.label : r.answer,
      rule: r.rule,
      evidence: evidenceFor(r.kind, typeof evidence?.text === 'string' ? evidence.text : ''),
      final: finalReason(db, { id: r.id, kind: r.kind, status: r.status, answer: r.answer }),
      ...(r.kind === 'transaction_category' ? { txn: txnOf(r.kind, parseJson(r.context, {})) } : {}),
    };
  });
}

// Newest ISO date on or before the clock. Same sources the planner uses for its data-through
// label: transactions, balances, positions, tax payments, and the month-end of the newest P&L
// period. An account's own as-of is still the max of that account's rows, so a connected sync
// dated yesterday is fresh even when its file source as_of is older.
export function householdDataThrough(db, clock) {
  const at = isoDay(clockOf(db, clock));
  if (!at) return null;
  const row = db.prepare(`SELECT max(d) AS d FROM (
      SELECT max(date) AS d FROM transactions WHERE date <= ?
      UNION ALL SELECT max(date) FROM balances WHERE date <= ?
      UNION ALL SELECT max(as_of) FROM positions WHERE as_of <= ?
      UNION ALL SELECT max(date) FROM tax_payments WHERE date <= ?
    )`).get(at, at, at, at);
  const period = db.prepare('SELECT max(period) AS d FROM pnl_lines WHERE period <= substr(?, 1, 7)').get(at);
  const dates = [isoDay(row && row.d), monthEnd(period && period.d)].filter(Boolean);
  return dates.sort().at(-1) ?? null;
}

// On-read freshness for every path that changes data (sync, import, confirm, merge, undo).
// Callers that do not rebuild the scenario still get the same snapshot the pages read.
export function refreshFreshness(db, { clock } = {}) {
  const state = ingestState(db, { clock });
  return { ...state, dataThrough: householdDataThrough(db, clock) };
}

// One account's { asOf, fresh, sourceId } as ingestState reports it, without building the rest.
// fresh follows the shared rule (coverage.mjs sourceStates): 'archived' for an archived account.
export function accountFreshness(db, accountId, { clock } = {}) {
  const hit = sourceStates(db, clockOf(db, clock)).accounts.get(accountId);
  if (!hit) return { asOf: '', fresh: 'unknown', sourceId: null };
  return { asOf: hit.asOf, fresh: hit.state, sourceId: hit.sourceId };
}

// Sources the Files page lists: stale first, then fresh, then history, then by name.
const STATE_RANK = Object.freeze({ stale: 0, fresh: 1, history: 2 });
const rankOfState = (state) => STATE_RANK[state] ?? 3;

// Each ingest source by its real origin (see sourceList), with its state from the shared rule.
// `states` is sourceStates(db, at). A source whose files were all removed is left out.
function sourceList(db, at, states) {
  const naming = accountNaming(db);
  const labelOf = (id) => accountLabel(naming.byId.get(id) ?? { id });
  const liveFiles = db.prepare(`SELECT id, name, stored_path, period_from, period_to FROM files
                                WHERE source_id = ? AND removed_at IS NULL ORDER BY uploaded_at DESC, rowid DESC`);
  const anyFile = db.prepare('SELECT 1 FROM files WHERE source_id = ? LIMIT 1');
  const rowRange = new Map(db.prepare(`SELECT f.source_id AS source, min(r.d) AS a, max(r.d) AS b FROM files f JOIN (
      SELECT file_id, date AS d FROM transactions UNION ALL SELECT file_id, date FROM balances UNION ALL SELECT file_id, as_of FROM positions
    ) r ON r.file_id = f.id WHERE f.source_id IS NOT NULL AND f.removed_at IS NULL GROUP BY f.source_id`).all().map((r) => [r.source, r]));
  const ownSources = db.prepare('SELECT id FROM accounts WHERE source_id = ?');
  const rows = db.prepare("SELECT id, label, as_of, kind, last_ingest_at FROM sources WHERE substr(id, 1, 4) = 'ing:' ORDER BY id").all();
  const out = [];
  for (const row of rows) {
    const files = liveFiles.all(row.id);
    if (!files.length && anyFile.get(row.id)) continue;
    const st = states.sources.get(row.id);
    const simplefin = row.kind === 'simplefin';
    const ids = new Set(st ? st.fed.keys() : []);
    if (simplefin) for (const a of ownSources.all(row.id)) ids.add(a.id);
    const accounts = [...ids].map((id) => {
      const a = states.accounts.get(id);
      const archived = a ? a.archived : !!naming.byId.get(id)?.archived_at;
      return { id, label: labelOf(id), state: a ? a.state : (archived ? 'archived' : 'unknown'), archived };
    }).sort((x, y) => x.label.localeCompare(y.label) || x.id.localeCompare(y.id));
    const insts = [...new Set(accounts.map((a) => String(naming.byId.get(a.id)?.inst ?? '').trim()))];
    let name;
    if (simplefin) name = insts.filter(Boolean).join(', ') || 'Bank connection';
    else if (insts.length === 1 && insts[0]) name = insts[0];
    else if (files.length) name = files.length > 1 ? `${files[0].name} and ${files.length - 1} more file${files.length === 2 ? '' : 's'}` : files[0].name;
    else name = row.label;
    const periods = files.length > 0 && files.every((f) => isoDay(f.period_from) && isoDay(f.period_to));
    const days = rowRange.get(row.id);
    const range = periods
      ? { from: files.map((f) => isoDay(f.period_from)).sort()[0], to: files.map((f) => isoDay(f.period_to)).sort().at(-1) }
      : { from: isoDay(days?.a) ?? null, to: isoDay(days?.b) ?? null };
    const f = freshnessOf({ kind: row.kind, asOf: row.as_of }, at);
    out.push({
      id: row.id,
      name,
      // The parser label, kept for compatibility; no screen shows it.
      label: row.label,
      kind: row.kind,
      asOf: row.as_of ?? '',
      lastIngestAt: row.last_ingest_at ?? null,
      cadence: f.cadence ? f.cadence.label : null,
      state: st ? st.state : f.state,
      ageDays: f.ageDays,
      range,
      accounts,
      files: simplefin ? [] : files.filter((x) => x.stored_path != null).map((x) => ({ id: x.id, name: x.name, removable: true })),
      howTo: howToFor(row.kind),
    });
  }
  // Two sources named for the same institution (an export and a newer activity file of one bank)
  // add their newest file name, so each row says which one it is.
  const count = new Map();
  for (const s of out) count.set(s.name, (count.get(s.name) ?? 0) + 1);
  for (const s of out) if (count.get(s.name) > 1 && s.files.length) s.name = `${s.name}, ${s.files[0].name}`;
  return out.sort((a, b) => rankOfState(a.state) - rankOfState(b.state) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

// The Sources view the API and the accounts.sources tool return: each source's id, real name,
// parser label, kind, state, range, last data date, cadence, accounts and live files.
export function sourcesView(db, { clock } = {}) {
  const at = clockOf(db, clock);
  return sourceList(db, at, sourceStates(db, at)).map(({ lastIngestAt, howTo, ...rest }) => rest);
}

export function ingestState(db, { clock } = {}) {
  const at = clockOf(db, clock);
  queueCategoryChecks(db,{clock:at});
  const items = pendingWithGuesses(db);
  // Uploaded files always have stored bytes; the demo seed's provenance row does not.
  const files = db.prepare(`SELECT id, name, status, source_kind, parser, counts, uploaded_at FROM files
                            WHERE stored_path IS NOT NULL AND removed_at IS NULL ORDER BY uploaded_at DESC, rowid DESC LIMIT ?`)
    .all(FILES_LIMIT).map(row => fileWithProposal(db,row));
  const waiting = db.prepare(`SELECT id, name, status, source_kind, parser, counts, uploaded_at FROM files
                              WHERE stored_path IS NOT NULL AND removed_at IS NULL AND status IN ('needs_mapping', 'needs_extraction', 'waiting_for_engine', 'budget_exhausted', 'needs_confirmation', 'needs_clarification', 'needs_source_text')
                              ORDER BY uploaded_at DESC, rowid DESC`).all().map(row => fileWithProposal(db,row));

  const states = sourceStates(db, at);
  const sources = sourceList(db, at, states);
  const naming = accountNaming(db);

  const accounts = {};
  const accountNotes = [];
  for (const [id, a] of states.accounts) {
    accounts[id] = { asOf: a.asOf, fresh: a.state, sourceId: a.sourceId };
    // A stale source already yields a note covering its accounts; only a stale account in a
    // source that is not stale needs its own.
    const source = sources.find((s) => s.id === a.sourceId);
    if (a.state === 'stale' && DOMAIN_OF[a.kind] && source && source.state !== 'stale') {
      accountNotes.push({ domain: DOMAIN_OF[a.kind], text: `${accountLabel(naming.byId.get(id) ?? { id }) || id} data is ${a.ageDays} days old. Export a fresh copy.` });
    }
  }

  const staleNotes = [
    ...sources
      .filter((s) => s.state === 'stale' && DOMAIN_OF[s.kind])
      .map((s) => ({ domain: DOMAIN_OF[s.kind], text: `${s.name} data is ${s.ageDays} days old. Export a fresh copy.` })),
    ...accountNotes,
  ];

  return { pending: items.length, items, decided: decidedItems(db), files, waiting, sources, accounts, staleNotes, formats: listHowTo() };
}

// Returns a new domains array: each stale note is appended (escaped) to its domain's note, a
// covered domain moves to waiting, and a missing domain is added as waiting.
export function applyFreshness(domains, state) {
  const out = (domains || []).map((d) => ({ ...d }));
  for (const note of (state && state.staleNotes) || []) {
    const text = escapeUserText(note.text);
    const domain = out.find((d) => d.id === note.domain);
    if (domain) {
      domain.note = domain.note ? `${domain.note} ${text}` : text;
      if (domain.status === 'covered') domain.status = 'waiting';
    } else {
      out.push({ id: note.domain, name: DOMAIN_NAMES[note.domain] ?? note.domain, status: 'waiting', watching: '', note: text });
    }
  }
  return out;
}
