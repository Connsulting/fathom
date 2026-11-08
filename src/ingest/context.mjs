import { categoryDetail } from '../categories/store.mjs';
// Card context for confirm questions: what the owner needs on the card to answer it, read from
// stored rows only. Every figure carries its file (or SimpleFIN) and date. Account numbers never
// appear beyond the stored 4-digit mask, and SimpleFIN account ids never appear at all.
// A View balance is {amount, date, fileId, fileName, basis, sources: [{fileId, fileName}]}: sources
// lists every contributing file, fileName names them all, fileId is set only when there is one.
// cardDetail(db, item) returns one of:
//   {type: 'account', account: View, sameName: View[], differs: string[]}   account_owner, account_kind
//   {type: 'compare', fields: string[], entries: object[], differs: string[]} near_duplicate,
//                                                         withholding_conflict
//   the compare shape plus {account: View | null, sameName: View[],          account_match
//     snapshot: {recent: [{date, amount, description}], balanceDate}}
//   {type: 'values', file: {id, name} | null, values: [{label, value}]}     every other kind

import { parseJson } from '../store/db.mjs';
import { accountLabel } from '../shared/account-label.mjs';
import { accountNaming } from '../accounts/naming.mjs';
import { cents } from './format.mjs';
import { normalizeName } from './confirm.mjs';
import { parsers } from './registry.mjs';
import { id as MAPPED_ID, label as MAPPED_LABEL } from './mapping.mjs';
import { labelOf } from './extract.mjs';

export const ACCOUNT_FIELDS = Object.freeze(['institution', 'mask', 'holder', 'owner', 'kind', 'balance', 'from', 'to', 'files']);
export const NEAR_FIELDS = Object.freeze(['date', 'amount', 'description', 'account', 'file']);
export const WITHHOLDING_FIELDS = Object.freeze(['date', 'amount', 'payer', 'jurisdiction', 'taxYear', 'recipient', 'file']);
export const MATCH_FIELDS = Object.freeze(['institution', 'name', 'mask', 'balance', 'balanceDate', 'from', 'to', 'count', 'file']);
const RECENT = 3;
const BRIDGE_FILE = 'SimpleFIN';

const num = (value) => (value == null || !Number.isFinite(Number(value)) ? null : cents(Number(value)));
const maxOf = (...values) => values.filter(Boolean).sort().at(-1) ?? null;
const minOf = (...values) => values.filter(Boolean).sort()[0] ?? null;

// The label of a files.parser value: a registry parser, the mapped export, or an extracted document.
export function parserLabel(parser) {
  if (typeof parser !== 'string' || !parser) return null;
  const known = parsers.find((p) => p.id === parser);
  if (known) return known.label;
  const historical = { 'pnl-workbook': 'Business P&L', 'tax-payments': 'Tax payments', 'balances': 'Balances', 'account-map': 'Account metadata', 'notes': 'Notes', 'model-import': 'Reviewed import' };
  if (historical[parser]) return historical[parser];
  if (parser === MAPPED_ID) return MAPPED_LABEL;
  if (parser.startsWith('extract-')) return labelOf(parser.slice('extract-'.length));
  return 'Historical import';
}

// {id, name, parser} of a stored file, or null.
export function fileInfo(db, id) {
  if (id == null) return null;
  const row = db.prepare('SELECT id, name, parser FROM files WHERE id = ?').get(id);
  return row ? { id: row.id, name: row.name, parser: row.parser ?? null } : null;
}
const fileName = (db, id) => fileInfo(db, id)?.name ?? null;

// ---------------------------------------------------------------- account view

function accountView(db, id) {
  const a = db.prepare('SELECT id, inst, mask, name, owner, kind, file_id, display_name FROM accounts WHERE id = ?').get(id) ?? { id };
  const holder = db.prepare('SELECT holder FROM account_holders WHERE account_id = ?').get(id)?.holder ?? null;
  const tx = db.prepare('SELECT count(*) AS n, min(date) AS f, max(date) AS t FROM transactions WHERE account_id = ?').get(id);
  const bal = db.prepare('SELECT count(*) AS n, min(date) AS f, max(date) AS t FROM balances WHERE account_id = ?').get(id);
  const pos = db.prepare('SELECT count(*) AS n, min(as_of) AS f, max(as_of) AS t FROM positions WHERE account_id = ?').get(id);
  const files = db.prepare(`SELECT id, name FROM files WHERE id IN (
      SELECT file_id FROM accounts WHERE id = ?1
      UNION SELECT file_id FROM transactions WHERE account_id = ?1
      UNION SELECT file_id FROM balances WHERE account_id = ?1
      UNION SELECT file_id FROM positions WHERE account_id = ?1)
    ORDER BY uploaded_at, rowid`).all(id).map((f) => ({ id: f.id, name: f.name }));
  const recent = db.prepare(`SELECT t.date, t.amount, t.description, f.name AS file_name FROM transactions t
                             LEFT JOIN files f ON f.id = t.file_id WHERE t.account_id = ? ORDER BY t.date DESC, t.id DESC LIMIT ?`)
    .all(id, RECENT).map((r) => ({ date: r.date, amount: num(r.amount), description: r.description ?? '', fileName: r.file_name ?? null }));
  return {
    id: a.id,
    institution: a.inst || null,
    name: a.name ?? null,
    label: accountLabel({
      ...a, holder, ...accountNaming(db).hint(a.id),
      householdNames: parseJson(db.prepare("SELECT value FROM facts WHERE key = 'household.names'").get()?.value, {}) || {},
    }),
    mask: a.mask ?? null,
    kind: a.kind ?? null,
    owner: a.owner ?? null,
    holder,
    files,
    from: minOf(tx.f, bal.f, pos.f),
    to: maxOf(tx.t, bal.t, pos.t),
    rows: { transactions: tx.n, balances: bal.n, positions: pos.n },
    balance: latestBalance(db, id),
    recent,
  };
}

// A balance with its contributing files: fileId only when one file, fileName naming them all.
function withSources(amount, date, basis, files) {
  const sources = files.map((f) => ({ fileId: f.file_id ?? null, fileName: f.name ?? null }));
  const names = sources.map((f) => f.fileName).filter(Boolean);
  return {
    amount, date, fileId: sources.length === 1 ? sources[0].fileId : null, fileName: names.length ? names.join(', ') : null, basis, sources,
  };
}

// The latest stored balance, else the total of the latest positions snapshot; null when neither.
function latestBalance(db, id) {
  const b = db.prepare(`SELECT b.date, b.amount, b.file_id, f.name FROM balances b LEFT JOIN files f ON f.id = b.file_id
                        WHERE b.account_id = ? ORDER BY b.date DESC, b.id DESC LIMIT 1`).get(id);
  if (b) return withSources(num(b.amount), b.date, 'balance', b.file_id != null ? [b] : []);
  const p = db.prepare(`SELECT as_of, sum(value) AS total FROM positions
                        WHERE account_id = ?1 AND as_of = (SELECT max(as_of) FROM positions WHERE account_id = ?1) GROUP BY as_of`).get(id);
  if (!p || p.total == null) return null;
  const files = db.prepare(`SELECT p.file_id, f.name FROM positions p LEFT JOIN files f ON f.id = p.file_id
                            WHERE p.account_id = ? AND p.as_of = ? AND p.file_id IS NOT NULL GROUP BY p.file_id ORDER BY min(p.id)`).all(id, p.as_of);
  return withSources(num(p.total), p.as_of, 'holdings', files);
}

// The value of a view field as compared for `differs`.
function accountField(view, field) {
  if (field === 'balance') return view.balance ? view.balance.amount : null;
  if (field === 'files') return view.files.map((f) => f.name).sort();
  return view[field] ?? null;
}
const differsAcross = (rows, fields, valueOf) => (rows.length < 2 ? []
  : fields.filter((field) => new Set(rows.map((r) => JSON.stringify(valueOf(r, field) ?? null))).size > 1));

// Views of the other accounts whose normalized name equals the view's.
function sameNameViews(db, view) {
  const key = normalizeName(view.name);
  return key
    ? db.prepare('SELECT id, name FROM accounts WHERE id != ? ORDER BY id').all(view.id)
      .filter((a) => normalizeName(a.name) === key).map((a) => accountView(db, a.id))
    : [];
}

function accountDetail(db, accountId) {
  const account = accountView(db, accountId);
  const sameName = sameNameViews(db, account);
  return { type: 'account', account, sameName, differs: differsAcross([account, ...sameName], ACCOUNT_FIELDS, accountField) };
}

// ---------------------------------------------------------------- compare cards

const compare = (fields, entries) => ({ type: 'compare', fields: [...fields], entries, differs: differsAcross(entries, fields, (e, f) => e[f]) });

// The stored row under a dedupe key, else its latest archived image.
function rowByKey(db, table, key) {
  if (typeof key !== 'string') return null;
  const stored = db.prepare(`SELECT * FROM ${table} WHERE dedupe_key = ?`).get(key);
  if (stored) return stored;
  const archived = db.prepare('SELECT row FROM superseded_rows WHERE table_name = ? AND dedupe_key = ? ORDER BY id DESC LIMIT 1').get(table, key);
  return archived ? parseJson(archived.row, null) : null;
}

function nearDuplicateDetail(db, item) {
  const accountName = db.prepare('SELECT name FROM accounts WHERE id = ?');
  const keys = Array.isArray(item.context?.keys) ? item.context.keys : String(item.subject).split('|');
  const entries = keys.map((key) => {
    const row = rowByKey(db, 'transactions', key);
    return {
      key,
      date: row?.date ?? null,
      amount: num(row?.amount),
      description: row?.description ?? null,
      account: row ? accountName.get(row.account_id)?.name ?? null : null,
      file: row ? fileName(db, row.file_id) : null,
    };
  });
  return compare(NEAR_FIELDS, entries);
}

// A withholding payer identity as words: the form label and, for employer forms, the employer name
// the questions recorded. A workbook payer is its column name.
function payerLabel(db, payer) {
  const text = String(payer ?? '');
  const [kind, key] = text.split(':');
  const form = text.includes(':') ? labelOf(kind) : null;
  if (!form || form === labelOf('other')) return payer ?? null;
  const ctx = db.prepare(`SELECT context FROM confirm_items WHERE kind IN ('employer_recipient', 'employer_relation') AND subject = ? ORDER BY id LIMIT 1`).get(key);
  const employer = String(parseJson(ctx?.context, {})?.employer ?? '').trim();
  return employer ? `${form}, ${employer}` : form;
}

function paymentByRef(db, ref) {
  if (!ref) return null;
  const row = Number.isInteger(ref.id) ? db.prepare('SELECT * FROM tax_payments WHERE id = ?').get(ref.id) : null;
  if (row && row.dedupe_key === ref.key) return row;
  return rowByKey(db, 'tax_payments', ref.key);
}

function withholdingDetail(db, item) {
  const entries = [item.context?.first, item.context?.second].map((ref) => {
    const row = paymentByRef(db, ref);
    return {
      date: row?.date ?? null,
      amount: num(row?.amount),
      payer: row ? payerLabel(db, row.payer) : null,
      jurisdiction: row?.jurisdiction ?? null,
      taxYear: row?.tax_year ?? null,
      recipient: row?.recipient ?? null,
      file: row ? fileName(db, row.file_id) : null,
    };
  });
  return compare(WITHHOLDING_FIELDS, entries);
}

function accountMatchDetail(db, item) {
  const { sfKey, candidateId } = item.context ?? {};
  const v = candidateId ? accountView(db, candidateId) : null;
  const imported = {
    institution: v?.institution ?? null,
    name: v?.name ?? null,
    mask: v?.mask ?? null,
    balance: v?.balance?.amount ?? null,
    balanceDate: v?.balance?.date ?? null,
    from: v?.from ?? null,
    to: v?.to ?? null,
    count: v ? v.rows.transactions : null,
    file: v && v.files.length ? v.files.map((f) => f.name).join(', ') : null,
  };
  const row = typeof sfKey === 'string' ? db.prepare('SELECT snapshot FROM simplefin_snapshots WHERE sf_key = ?').get(sfKey) : null;
  const snap = parseJson(row?.snapshot, null) ?? {};
  const name = snap.name ?? (typeof sfKey === 'string' ? db.prepare('SELECT name FROM simplefin_accounts WHERE sf_key = ?').get(sfKey)?.name : null);
  const bridge = {
    institution: snap.inst || null,
    name: name ?? null,
    mask: /^\d{4}$/.test(String(snap.mask ?? '')) ? snap.mask : null,
    balance: num(snap.balance),
    balanceDate: snap.balanceDate ?? null,
    from: snap.from ?? null,
    to: snap.to ?? null,
    count: Number.isFinite(snap.count) ? snap.count : null,
    file: BRIDGE_FILE,
  };
  const snapshot = {
    recent: (Array.isArray(snap.recent) ? snap.recent : []).slice(0, RECENT)
      .map((r) => ({ date: r?.date ?? null, amount: num(r?.amount), description: r?.description ?? null })),
    balanceDate: snap.balanceDate ?? null,
  };
  return { ...compare(MATCH_FIELDS, [imported, bridge]), account: v, sameName: v ? sameNameViews(db, v) : [], snapshot };
}

// ---------------------------------------------------------------- values cards

const paymentValue = (db, r) => ({ label: [payerLabel(db, r.payer), r.date, r.jurisdiction].filter(Boolean).join(' '), value: num(r.amount) });

function valuesOf(db, item) {
  const c = item.context ?? {};
  switch (item.kind) {
    case 'fact_check': {
      const stored = db.prepare('SELECT value FROM facts WHERE key = ?').get(c.key);
      return [
        { label: 'Fact', value: c.key ?? null },
        { label: 'Imported value', value: c.value ?? null },
        ...(c.confidence != null ? [{ label: 'Extraction confidence', value: c.confidence }] : []),
        ...(stored ? [{ label: 'Value on file now', value: parseJson(stored.value, null) }] : []),
      ];
    }
    case 'entity_alias': {
      const rows = db.prepare('SELECT entity, period FROM pnl_lines').all().filter((r) => normalizeName(r.entity) === item.subject);
      const periods = rows.map((r) => r.period).sort();
      return [
        { label: 'Business name in the file', value: c.alias ?? item.subject },
        { label: 'Profit and loss rows', value: rows.length },
        ...(periods.length ? [{ label: 'Months', value: periods[0] === periods.at(-1) ? periods[0] : `${periods[0]} to ${periods.at(-1)}` }] : []),
      ];
    }
    case 'tax_year': {
      const year = Number(c.sheetYear ?? /^tax:(\d{4})$/.exec(item.subject)?.[1]);
      const rows = db.prepare('SELECT * FROM tax_payments WHERE source_slot LIKE ? ORDER BY date, id').all(`tax:${year}:%`);
      return [
        { label: 'Sheet year', value: year },
        { label: 'Payment rows', value: rows.length },
        { label: 'January payments', value: rows.filter((r) => r.date.slice(5, 7) === '01').length },
        ...rows.map((r) => paymentValue(db, r)),
      ];
    }
    case 'employer_relation': {
      const held = db.prepare('SELECT key, value FROM held_facts WHERE hold = ? ORDER BY id').all(`employer:${c.employerKey ?? item.subject}`);
      return [{ label: 'Employer', value: c.employer || null }, ...held.map((h) => ({ label: h.key, value: parseJson(h.value, null) }))];
    }
    case 'employer_recipient': {
      const rows = db.prepare('SELECT * FROM tax_payments WHERE source_slot LIKE ? ORDER BY date, id').all(`wh:${c.employerKey ?? item.subject}:%`);
      return [{ label: 'Employer', value: c.employer || null }, ...rows.map((r) => paymentValue(db, r))];
    }
    case 'document_recipient': {
      const rows = db.prepare('SELECT * FROM tax_payments WHERE payer = ? ORDER BY date, id').all(item.subject);
      return [
        { label: c.employerKey ? 'Employer' : 'Issuer', value: (c.employer || c.issuer) || null },
        ...rows.map((r) => paymentValue(db, r)),
      ];
    }
    default:
      return [];
  }
}

function valuesDetail(db, item) {
  const file = fileInfo(db, item.fileId ?? item.context?.fileId ?? null);
  return { type: 'values', file: file ? { id: file.id, name: file.name } : null, values: valuesOf(db, item) };
}

// ---------------------------------------------------------------- entry point

export function cardDetail(db, item) {
  switch (item?.kind) {
    case 'transaction_category':
    case 'category_mapping': return categoryDetail(db,item);
    case 'account_owner':
    case 'account_kind': return accountDetail(db, item.subject);
    case 'near_duplicate': return nearDuplicateDetail(db, item);
    case 'withholding_conflict': return withholdingDetail(db, item);
    case 'account_match': return accountMatchDetail(db, item);
    default: return valuesDetail(db, item ?? {});
  }
}
