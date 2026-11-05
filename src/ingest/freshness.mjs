// Freshness of ingest sources: cadence per source kind, state at the scenario clock, the ingest
// summary the scenario carries as live.ingest, and stale notes on plan domains.
// Only sources whose id starts with 'ing:' are ingest sources; demo seeded sources are untouched.

import { getSetting, parseJson } from '../store/db.mjs';
import { escapeUserText } from '../shared/tokens.mjs';
import { howToFor, listHowTo } from './howto.mjs';

const MONTHLY = Object.freeze({ label: 'monthly', staleAfterDays: 45 });

export const CADENCE = Object.freeze({
  bank_csv: MONTHLY,
  card_csv: MONTHLY,
  aggregator_csv: MONTHLY,
  balances: MONTHLY,
  brokerage_positions: MONTHLY,
  statement: MONTHLY,
  pnl_workbook: MONTHLY,
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

function fileOf(row) {
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

export function ingestState(db, { clock } = {}) {
  const at = clockOf(db, clock);
  const items = db.prepare("SELECT * FROM confirm_items WHERE status = 'pending' ORDER BY id").all().map(itemOf);
  // Uploaded files always have stored bytes; the demo seed's provenance row does not.
  const files = db.prepare(`SELECT id, name, status, source_kind, parser, counts, uploaded_at FROM files
                            WHERE stored_path IS NOT NULL ORDER BY uploaded_at DESC, rowid DESC LIMIT ?`)
    .all(FILES_LIMIT).map(fileOf);

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
  const rows = db.prepare(`SELECT a.id, a.source_id, (
      SELECT max(d) FROM (
        SELECT max(date) AS d FROM transactions WHERE account_id = a.id
        UNION ALL SELECT max(date) FROM balances WHERE account_id = a.id
        UNION ALL SELECT max(as_of) FROM positions WHERE account_id = a.id)
    ) AS as_of
    FROM accounts a WHERE a.source_id IS NOT NULL ORDER BY a.id`).all();
  for (const row of rows) {
    const asOf = isoDay(row.as_of) ?? '';
    const kind = kindOf.get(row.source_id);
    accounts[row.id] = { asOf, fresh: asOf && kind ? freshnessOf({ kind, asOf }, at).state : 'unknown', sourceId: row.source_id };
  }

  const staleNotes = sources
    .filter((s) => s.state === 'stale' && DOMAIN_OF[s.kind])
    .map((s) => ({ domain: DOMAIN_OF[s.kind], text: `${s.label} data is ${s.ageDays} days old. Export a fresh copy.` }));

  return { pending: items.length, items, files, sources, accounts, staleNotes, formats: listHowTo() };
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
