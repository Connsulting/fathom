import { queueCategoryChecks } from '../categories/store.mjs';
// Freshness of ingest sources: cadence per source kind, state at the scenario clock, the ingest
// summary the scenario carries as live.ingest, and stale notes on plan domains.
// Only sources whose id starts with 'ing:' are ingest sources; demo seeded sources are untouched.

import { getSetting, parseJson } from '../store/db.mjs';
import { escapeUserText } from '../shared/tokens.mjs';
import { accountLabel } from '../shared/account-label.mjs';
import { howToFor, listHowTo } from './howto.mjs';
import { monthEnd } from './format.mjs';
import { pendingItems, finalReason } from './confirm.mjs';
import { cardDetail } from './context.mjs';
import { bestGuess } from './bestguess.mjs';

const MONTHLY = Object.freeze({ label: 'monthly', staleAfterDays: 45 });

export const CADENCE = Object.freeze({
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

// A files row as the API returns it.
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

// Pending items with fileName (the item's file name or null), detail (cardDetail), guess (the best
// guess as {option, label, reason, evidence, source, model?, ts?}, reason being the evidence text;
// model and ts for an engine guess), rank and group. Sorted by rank, then (account questions) the
// larger absolute latest balance, then id.
function pendingWithGuesses(db) {
  const extra = new Map(db.prepare(`SELECT ci.id, f.name AS file_name, g.model, g.ts
                                    FROM confirm_items ci LEFT JOIN files f ON f.id = ci.file_id
                                    LEFT JOIN confirm_guesses g ON g.item_id = ci.id
                                    WHERE ci.status = 'pending'`).all().map((r) => [r.id, r]));
  const items = pendingItems(db).map((item) => {
    const r = extra.get(item.id);
    const detail = cardDetail(db, item);
    const g = bestGuess(db, item, detail);
    const guess = g ? {
      option: g.option, label: g.label, reason: g.evidence, evidence: g.evidence, source: g.source,
      ...(g.confidence==null?{}:{confidence:g.confidence}),
      ...(g.source === 'engine' ? { model: r?.model ?? null, ts: r?.ts ?? null } : {}),
    } : null;
    const label = detail?.type === 'account' ? detail.account?.label : '';
    const question = label && item.kind === 'account_owner' ? `Whose account is ${label}?`
      : label && item.kind === 'account_kind' ? `What kind of account is ${label}?`
        : label && detail.account?.name && detail.account.name !== label
          ? String(item.question).split(detail.account.name).join(label)
          : item.question;
    return { ...item, question, fileName: r?.file_name ?? null, detail, guess, rank: rankOf(item.kind), group: GROUPED.has(item.kind) ? item.kind : null };
  });
  return items.sort((a, b) => a.rank - b.rank || (['transaction_category','category_mapping'].includes(a.kind) && ['transaction_category','category_mapping'].includes(b.kind) ? Math.abs(b.context.amount)-Math.abs(a.context.amount) : 0) || (a.group && b.group ? balanceSize(b) - balanceSize(a) : 0) || a.id - b.id);
}

// Answers Fathom recorded itself, newest first: {id, kind, question, answer, answerLabel, rule,
// evidence (the evidence text), final (finalReason or null)}.
function decidedItems(db) {
  return db.prepare(`SELECT ci.id, ci.kind, ci.question, ci.options, ci.status, ci.answer, a.rule, a.evidence
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
      evidence: typeof evidence?.text === 'string' ? evidence.text : '',
      final: finalReason(db, { id: r.id, kind: r.kind, status: r.status, answer: r.answer }),
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

// Each account with an ingest source, its newest row date and its freshness at `at`. One rule for
// the health line, the account list and the account dialog. `kindOf` maps an ingest source id to
// its kind; `only` limits the rows to one account id.
function accountFreshnessRows(db, at, kindOf, only = null) {
  const rows = db.prepare(`SELECT a.id, a.name, a.inst, a.mask, a.kind, a.owner, a.display_name, a.source_id, (
      SELECT max(d) FROM (
        SELECT max(date) AS d FROM transactions WHERE account_id = a.id
        UNION ALL SELECT max(date) FROM balances WHERE account_id = a.id
        UNION ALL SELECT max(as_of) FROM positions WHERE account_id = a.id)
    ) AS as_of
    FROM accounts a WHERE a.source_id IS NOT NULL AND (? IS NULL OR a.id = ?) ORDER BY a.id`).all(only, only);
  return rows.map((row) => {
    const asOf = isoDay(row.as_of) ?? '';
    const kind = kindOf.get(row.source_id);
    return { row, asOf, kind, f: asOf && kind ? freshnessOf({ kind, asOf }, at) : null };
  });
}

// One account's { asOf, fresh, sourceId } as ingestState reports it, without building the rest.
export function accountFreshness(db, accountId, { clock } = {}) {
  const at = clockOf(db, clock);
  const kindOf = new Map(db.prepare("SELECT id, kind FROM sources WHERE substr(id, 1, 4) = 'ing:'").all().map((r) => [r.id, r.kind]));
  const hit = accountFreshnessRows(db, at, kindOf, accountId)[0];
  if (!hit) return { asOf: '', fresh: 'unknown', sourceId: null };
  return { asOf: hit.asOf, fresh: hit.f ? hit.f.state : 'unknown', sourceId: hit.row.source_id };
}

export function ingestState(db, { clock } = {}) {
  const at = clockOf(db, clock);
  queueCategoryChecks(db,{clock:at});
  const items = pendingWithGuesses(db);
  // Uploaded files always have stored bytes; the demo seed's provenance row does not.
  const files = db.prepare(`SELECT id, name, status, source_kind, parser, counts, uploaded_at FROM files
                            WHERE stored_path IS NOT NULL ORDER BY uploaded_at DESC, rowid DESC LIMIT ?`)
    .all(FILES_LIMIT).map(fileOf);
  const waiting = db.prepare(`SELECT id, name, status, source_kind, parser, counts, uploaded_at FROM files
                              WHERE stored_path IS NOT NULL AND status IN ('needs_mapping', 'needs_extraction')
                              ORDER BY uploaded_at DESC, rowid DESC`).all().map(fileOf);

  const sources = db.prepare("SELECT id, label, as_of, kind, last_ingest_at FROM sources WHERE substr(id, 1, 4) = 'ing:' ORDER BY label, id")
    .all().map((row) => {
      const f = freshnessOf({ kind: row.kind, asOf: row.as_of }, at);
      return {
        id: row.id,
        label: row.label,
        kind: row.kind,
        asOf: row.as_of ?? '',
        lastIngestAt: row.last_ingest_at ?? null,
        cadence: f.cadence ? f.cadence.label : null,
        state: f.state,
        ageDays: f.ageDays,
        howTo: howToFor(row.kind),
      };
    });
  const kindOf = new Map(sources.map((s) => [s.id, s.kind]));

  const accounts = {};
  const accountNotes = [];
  for (const { row, asOf, kind, f } of accountFreshnessRows(db, at, kindOf)) {
    accounts[row.id] = { asOf, fresh: f ? f.state : 'unknown', sourceId: row.source_id };
    // A stale source already yields a note covering its accounts; only a stale account in a
    // fresh source needs its own.
    const source = sources.find((s) => s.id === row.source_id);
    if (f && f.state === 'stale' && DOMAIN_OF[kind] && source && source.state !== 'stale') {
      accountNotes.push({ domain: DOMAIN_OF[kind], text: `${accountLabel(row) || row.id} data is ${f.ageDays} days old. Export a fresh copy.` });
    }
  }

  const staleNotes = [
    ...sources
      .filter((s) => s.state === 'stale' && DOMAIN_OF[s.kind])
      .map((s) => ({ domain: DOMAIN_OF[s.kind], text: `${s.label} data is ${s.ageDays} days old. Export a fresh copy.` })),
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
