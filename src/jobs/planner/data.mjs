// Planning data: everything the planner reads from the store for one run, plus the date helpers,
// the planning tax year (R10), household entities (R1) and per-source freshness (T9.5).
//
// loadPlanningData(db, clock) -> {clock, year, taxYear, accounts, pnl, taxPayments, taxPaymentsNext,
//   withholding, documents, transactions, files, confirm, conflictArchive, aliases, freshness}
//   taxPayments: this tax year's active rows; taxPaymentsNext: next year's (only for the tax_year
//   check); withholding: every active withholding row of any year (who a document belongs to);
//   confirm: ingest's answers the planner reads; conflictArchive: tax_payments rows a
//   withholding_conflict answer dropped; aliases: entity_aliases rows.
// ownerOf(value) -> 'owner' | 'spouse' | 'joint' | 'business' | null (ingest stores option labels)

import { docRecipient, employerKeyOf, matchEntity } from './payroll.mjs';
import { parseJson, cents } from '../../store/db.mjs';
import { accountNaming } from '../../accounts/naming.mjs';
import { addDays, daysBetween } from '../../scenario/build.mjs';
import { monthEnd } from '../../ingest/format.mjs';
import { ledgerDisplayName, ledgerKind, looksLikeSpending, spendingStatement, businessEntry, ownerEntityIdentity, summaryPerson, accountEntityLink, PERSONAL_CATEGORIES, personalIncomeCategory, payrollIncomeCategory, summaryTransfer } from '../../pnl/ledgers.mjs';
import { loadCategoryInputs } from '../../categories/store.mjs';
import { resolveCategories } from '../../categories/resolve.mjs';
import { staleAccountIds } from '../../../web/core/account-freshness.js';
import { connectedThrough, sourceStates } from '../../ingest/coverage.mjs';
import { OWNER_OPTIONS, normalizeName } from '../../ingest/confirm.mjs';
import { mapSeries } from '../../shared/series.mjs';

export const SUPPORTED_TAX_YEARS = Object.freeze([2026]);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STALE_DAYS = 45;

// ---------------------------------------------------------------- dates

export const monthOf = iso => Number(String(iso).slice(5, 7));
export const yearOf = iso => Number(String(iso).slice(0, 4));
export const dayLabel = iso => `${MONTHS[monthOf(iso) - 1]} ${Number(iso.slice(8, 10))}`;
export const dateLabel = iso => `${dayLabel(iso)}, ${iso.slice(0, 4)}`;
export const monthLabel = period => `${MONTHS[monthOf(period) - 1]} ${period.slice(0, 4)}`;
export { addDays, daysBetween, monthEnd };

// `now` as an ISO date: a Date, an ISO date or timestamp string, epoch ms, or undefined.
export function isoDateOf(now) {
  if (now == null || now === '') return undefined;
  if (now instanceof Date) return now.toISOString().slice(0, 10);
  if (typeof now === 'number') return new Date(now).toISOString().slice(0, 10);
  const s = String(now);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}

// R10: the latest supported year Y <= the clock year whose return is not yet due (clock on or
// before Apr 15 of Y + 1), or null.
export function planningYear(clock) {
  for (let y = yearOf(clock); y >= yearOf(clock) - 1; y--) {
    if (clock <= `${y + 1}-04-15` && SUPPORTED_TAX_YEARS.includes(y)) return y;
  }
  return null;
}

// ---------------------------------------------------------------- text helpers

export const slugOf = name => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase() && String(a ?? '').trim() !== '';
const sum = list => cents(list.reduce((a, b) => a + b, 0));
export { sum };

// Labels carry no digits except inside the identifiers the grounding guard masks.
export function cleanLabel(text) {
  return String(text ?? '')
    .replace(/(401\s*\(\s*k\s*\)|401k|529|W-2|1099)|\d+/gi, (m, keep) => keep || '')
    .replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').trim();
}

// ---------------------------------------------------------------- categories (R1)

export const isOfficer = c => /officer/i.test(c);
export const isPayrollTax = c => /payroll tax/i.test(c);
export const isIncome = c => c === 'Income';
export const isEmployer401k = c => /401\(?k\)?|retirement contribution|profit sharing/i.test(c);
export const isCharitable = c => /charit|donat/i.test(c ?? '');

// ---------------------------------------------------------------- load

// Ingest writes the account_owner option label ('You', 'Your spouse', ...) into accounts.owner.
export function ownerOf(value) {
  const ids = OWNER_OPTIONS.map(o => o.id);
  if (ids.includes(value)) return value;
  const option = OWNER_OPTIONS.find(o => o.label === value);
  return option ? option.id : null;
}

const CONFIRM_KINDS = ['employer_recipient', 'document_recipient', 'withholding_conflict', 'employer_relation', 'tax_year', 'fact_check', 'account_owner'];

// An owner fact's value (any src but the planner's own), or undefined.
async function ownerFact(db, key) {
  const row = await db.prepare("SELECT value FROM facts WHERE key = ? AND (src IS NULL OR src != 'planner')").get(key);
  return row ? parseJson(row.value, undefined) : undefined;
}

export async function loadPlanningData(db, clock) {
  const taxYear = planningYear(clock);
  const year = taxYear ?? yearOf(clock);
  const lastPeriod = yearOf(clock) === year ? clock.slice(0, 7) : `${year}-12`;

  const pnl = (await db.prepare('SELECT * FROM pnl_lines WHERE period >= ? AND period <= ? ORDER BY id').all(`${year}-01`, lastPeriod)).map(r => ({ ...r }));
  const pnlHistory = (await db.prepare('SELECT * FROM pnl_lines WHERE period <= ? ORDER BY id').all(lastPeriod)).map(r => ({ ...r }));
  // A business account's entity: the owner's accounts.businessEntity answer, else the household's
  // only business when there is exactly one.
  const named = await ownerFact(db, 'accounts.businessEntity');
  const byAccount = named && typeof named === 'object' && !Array.isArray(named) ? named : {};
  const listed = await ownerFact(db, 'business.entities');
  const ledgerFacts = { 'pnl.ledgers': await ownerFact(db, 'pnl.ledgers'), 'business.entities': listed };
  const businessNames = [...new Map((Array.isArray(listed) ? listed.filter(e => e && (!e.inferred || e.nameSource === 'owner')).map(e => e.name) : [])
    .filter(n => typeof n === 'string' && normalizeName(n) && !['spending', 'inactive', 'income_history'].includes(ledgerKind(ledgerFacts, n, pnlHistory.filter(l => sameName(l.entity, n))))).map(n => [normalizeName(n), n.trim()])).values()];
  const householdNames = parseJson((await db.prepare("SELECT value FROM facts WHERE key = 'household.names'").get())?.value, {}) || {};
  const holders = new Map((await db.prepare('SELECT account_id, holder FROM account_holders').all()).map((r) => [r.account_id, r.holder]));
  const naming = await accountNaming(db);
  const accountStates = (await sourceStates(db, clock)).accounts;
  const accounts = await mapSeries((await db.prepare('SELECT * FROM accounts WHERE archived_at IS NULL ORDER BY sort, id').all()), async a => {
    const kind = String(a.kind || '').toLowerCase();
    const stated = typeof byAccount[a.id] === 'string' && byAccount[a.id].trim() ? byAccount[a.id].trim() : null;
    return {
      id: a.id, inst: a.inst, mask: a.mask, name: a.name || '', display_name: a.display_name || null,
      holder: holders.get(a.id) || null, householdNames, ...naming.hint(a.id), owner: ownerOf(a.owner), kind,
      fileId: a.file_id, entity: stated ?? a.entity ?? (kind === 'business' && businessNames.length === 1 ? businessNames[0] : null),
      latest: await latestBalance(db, a.id, clock), fresh: accountStates.get(a.id)?.state ?? 'unknown',
    };
  });

  const taxPayments = (await db.prepare('SELECT * FROM tax_payments WHERE tax_year = ? ORDER BY id').all(year)).map(r => ({ ...r }));
  const taxPaymentsNext = (await db.prepare('SELECT * FROM tax_payments WHERE tax_year = ? ORDER BY id').all(year + 1)).map(r => ({ ...r }));
  const withholding = (await db.prepare("SELECT id, file_id, payer, recipient, jurisdiction, tax_year FROM tax_payments WHERE kind = 'withholding' ORDER BY id").all()).map(r => ({ ...r }));
  const confirm = (await db.prepare(`SELECT id, kind, subject, status, answer, context, file_id FROM confirm_items WHERE kind IN (${CONFIRM_KINDS.map(() => '?').join(', ')}) ORDER BY id`)
    .all(...CONFIRM_KINDS)).map(r => ({ id: r.id, kind: r.kind, subject: r.subject, status: r.status, answer: r.answer ?? null, context: parseJson(r.context, {}) || {}, fileId: r.file_id ?? null }));
  const conflictArchive = (await db.prepare("SELECT id, file_id, superseded_by, row FROM superseded_rows WHERE table_name = 'tax_payments' AND reason = 'withholding_conflict' ORDER BY id")
    .all()).map(r => ({ id: r.id, fileId: r.file_id ?? null, supersededBy: r.superseded_by ?? null, row: parseJson(r.row, {}) || {} }));
  const aliases = (await db.prepare('SELECT alias, entity FROM entity_aliases ORDER BY alias').all()).map(r => ({ alias: r.alias, entity: r.entity }));
  const documents = (await db.prepare('SELECT * FROM documents ORDER BY id').all()).map(d => ({
    id: d.id, docType: String(d.doc_type || '').toLowerCase(), taxYear: d.tax_year, fields: parseJson(d.fields, {}) || {}, fileId: d.file_id,
  }));
  const transactions = (await db.prepare('SELECT * FROM transactions WHERE date > ? AND date <= ? ORDER BY id').all(addDays(clock, -400), clock)).map(r => ({ ...r }));
  const categoryInput = await loadCategoryInputs(db);
  categoryInput.transactions = categoryInput.transactions.filter(t => t.date <= clock);
  const categories = resolveCategories(categoryInput);
  const businessActivity = accounts.filter(a => a.kind === 'business').map(account => ({ accountId: account.id,
    rows: categoryInput.transactions.filter(t => t.account_id === account.id && t.date >= `${year}-01-01`).flatMap(t => {
      const entry = businessEntry(t, categories.get(t.id));
      return entry ? [{ ...t, section: entry.section, originalCategory: entry.category, category: entry.section === 'income' ? 'Income' : entry.category, period: t.date.slice(0, 7), sourceTable: 'transactions' }] : [];
    }),
  }));
  const files = (await db.prepare('SELECT id, name, source_id, source_kind, uploaded_at, status FROM files WHERE removed_at IS NULL ORDER BY uploaded_at, id').all()).map(r => ({ ...r }));

  return {
    clock, year, taxYear, accounts, pnl, pnlHistory, businessActivity, categoryInput, taxPayments, taxPaymentsNext, withholding, documents, transactions, files,
    confirm, conflictArchive, aliases, freshness: await freshness(db, clock, accounts, businessActivity),
  };
}

async function latestBalance(db, accountId, clock) {
  const b = await db.prepare('SELECT id, date, amount, file_id FROM balances WHERE account_id = ? AND date <= ? ORDER BY date DESC, id DESC LIMIT 1').get(accountId, clock);
  if (b) return { date: b.date, amount: cents(b.amount), source: 'balances', ids: [b.id], fileId: b.file_id };
  const p = await db.prepare('SELECT max(as_of) AS d FROM positions WHERE account_id = ? AND as_of <= ?').get(accountId, clock);
  if (!p || !p.d) return null;
  const rows = await db.prepare('SELECT id, value, file_id FROM positions WHERE account_id = ? AND as_of = ? ORDER BY id').all(accountId, p.d);
  return { date: p.d, amount: sum(rows.map(r => r.value ?? 0)), source: 'positions', ids: rows.map(r => r.id), fileId: rows[0] ? rows[0].file_id : null };
}

// Federal installment due dates (Apr 15, Jun 15, Sep 15, Jan 15): the latest on or before clock.
function lastInstallmentDue(clock) {
  const y = yearOf(clock);
  const dates = [`${y - 1}-09-15`, `${y}-01-15`, `${y}-04-15`, `${y}-06-15`, `${y}-09-15`];
  return dates.filter(d => d <= clock).at(-1);
}

export const SOURCE_LABELS = Object.freeze({
  balances: 'Account balances',
  transactions: 'Account transactions',
  pnl: 'Business profit and loss',
  tax_payments: 'Estimated tax payment log',
});

async function freshness(db, clock, accounts, businessActivity) {
  const one = async sql => (await db.prepare(sql).get(clock) || {}).d || null;
  const bal = await one('SELECT max(date) AS d FROM balances WHERE date <= ?');
  const pos = await one('SELECT max(as_of) AS d FROM positions WHERE as_of <= ?');
  const period = [await one('SELECT max(period) AS d FROM pnl_lines WHERE period <= substr(?, 1, 7)'), ...businessActivity.flatMap(a => a.rows.map(r => r.period))].filter(Boolean).sort().at(-1);
  const latest = {
    balances: [bal, pos].filter(Boolean).sort().at(-1) || null,
    // SimpleFIN covering every account with transactions keeps the log current (ingest/coverage.mjs).
    transactions: [await one('SELECT max(date) AS d FROM transactions WHERE date <= ?'), await connectedThrough(db, clock)].filter(Boolean).sort().at(-1) || null,
    pnl: period ? monthEnd(period) : null,
    tax_payments: await one('SELECT max(date) AS d FROM tax_payments WHERE date <= ?'),
  };
  const stale = staleAccountIds(accounts);
  const tracked = (await sourceStates(db, clock)).accounts.size > 0;
  return Object.entries(latest).map(([id, date]) => {
    let state = 'current';
    if (tracked && ['balances', 'transactions'].includes(id)) state = stale.length ? 'stale' : 'current';
    else if (!date) state = 'missing';
    else if (id === 'tax_payments') state = date < lastInstallmentDue(clock) ? 'stale' : 'current';
    else if (daysBetween(date, clock) > STALE_DAYS) state = 'stale';
    return { id, label: SOURCE_LABELS[id], latest: date, state };
  });
}

// ---------------------------------------------------------------- entities (R1, T8)

// Household businesses: the business.entities fact gives classification; P&L entities match by
// trimmed, case-insensitive name; an unmatched P&L entity is unclassified.
export function resolveEntities(data, facts) {
  const TYPES = ['s_corp', 'sole_prop', 'llc_single', 'partnership', 'c_corp'];
  const out = [];
  const add = e => {
    if (!e || typeof e.name !== 'string' || !e.name.trim() || (e.status === 'final_year' && e.finalYear < data.year)) return;
    if (out.some(x => sameName(x.name, e.name))) return;
    out.push({
      name: e.name.trim(), slug: slugOf(e.name), type: TYPES.includes(e.type) ? e.type : null,
      owner: e.owner === 'spouse' ? 'spouse' : 'owner', sstb: typeof e.sstb === 'boolean' ? e.sstb : null,
      docId: null, fileId: null, payrollEmployer: e.inferenceKind === 'household_payroll', ownerAccountLink: !e.inferred && !!e.accountId, status: e.status || 'active', finalYear: e.finalYear, classified: TYPES.includes(e.type), lines: [], accountIds: [],
    });
  };
  const listed = facts['business.entities'];
  if (Array.isArray(listed)) for (const e of listed) add(e);
  for (const line of data.pnl) {
    let e = out.find(x => sameName(x.name, line.entity));
    if (!e) {
      out.push({ name: String(line.entity).trim(), slug: slugOf(line.entity), type: null, owner: 'owner', sstb: null, docId: null, fileId: null, classified: false, lines: [], accountIds: [] });
      e = out.at(-1);
    }
    e.lines.push(line);
  }
  const ownerNames = (Array.isArray(listed) ? listed : []).filter(e => e && (!e.inferred || e.nameSource === 'owner') && !['personal', 'inactive', 'income_history', 'not_mine'].includes(e.type));
  for (const activity of data.businessActivity || []) {
    if (!activity.rows.length) continue;
    const account = data.accounts.find(a => a.id === activity.accountId);
    const name = accountEntityLink(listed, account.id)?.name || facts['accounts.businessEntity']?.[account.id] || account.entity || ownerNames.find(e => e.accountIds?.includes(account.id))?.name || (ownerNames.length === 1 ? ownerNames[0].name : null);
    const candidate = activity.rows.some(r => r.section === 'income') && activity.rows.some(r => r.section === 'expenses');
    let e = name ? out.find(e => sameName(e.name, name)) : null;
    if (!e && !candidate) continue;
    if (!e) {
      const label = name || `account:${account.id}`;
      add({ name: label, owner: account.owner });
      e = out.at(-1);
      if (!name) { e.needsName = true; e.slug = `account-${slugOf(account.id)}`; e.accountLabel = account.display_name || account.name || 'Business account'; }
    }
    e.accountIds.push(account.id);
    e.accountCandidate = e.accountCandidate || candidate;
    const covered = new Set(e.lines.filter(l => l.sourceTable !== 'transactions').map(l => l.period));
    e.lines.push(...activity.rows.filter(r => !covered.has(r.period)));
  }
  for (const e of out) {
    e.displayName = e.accountLabel || (e.lines.length && e.lines[0].sourceTable !== 'transactions' ? ledgerDisplayName(e.lines[0]) : e.name);
    e.months = e.lines.length ? Math.max(...e.lines.map(l => monthOf(l.period))) : 0;
  }
  return out.filter(e => !['spending', 'inactive', 'income_history'].includes(ledgerKind(facts, e.name, e.lines))
    && !(Array.isArray(listed) && listed.some(prior => sameName(prior?.name, e.name) && prior.status === 'final_year' && prior.finalYear < data.year)));
}

export function inferEntities(data, facts) {
  const listed = Array.isArray(facts['business.entities']) ? facts['business.entities'] : [];
  const value = structuredClone(listed.flatMap(e => !e?.inferred ? [e] : e.nameSource === 'owner' ? [ownerEntityIdentity(e)] : []));
  const baseFacts = { ...facts, 'business.entities': value };
  const payrollRows = [];
  const undone = name => Object.entries(facts['business.entityInference'] || {}).some(([key, flag]) => sameName(key, name) && flag?.undone);
  const payrollDocs = data.documents.filter(d => (d.docType === 'w2' && Number(d.taxYear) === data.year)
    || (d.docType === 'paystub' && yearOf(d.fields.payDate) === data.year));
  const employers = new Map();
  for (const doc of payrollDocs) {
    const name = String(doc.fields.employerName || '').trim();
    const relation = data.confirm.find(i => i.kind === 'employer_relation' && i.subject === employerKeyOf(name) && i.status === 'answered' && i.answer === 'household');
    const person = docRecipient(data, doc).person;
    if (!name || !relation || !person) continue;
    const key = employerKeyOf(name);
    if (!employers.has(key)) employers.set(key, { name, docs: [], people: new Set(), relation });
    employers.get(key).docs.push(doc);
    employers.get(key).people.add(person);
  }
  const businessAccounts = data.accounts.filter(a => a.kind === 'business');
  for (const employer of employers.values()) {
    if (employer.people.size !== 1 || undone(employer.name)) continue;
    const existing = matchEntity(data, resolveEntities(data, baseFacts), employer.name);
    if (existing?.classified || ledgerKind(baseFacts, employer.name)) continue;
    const prior = value.findIndex(e => sameName(e?.name, employer.name));
    const soleAccount = businessAccounts.length === 1 ? businessAccounts[0] : null;
    const explicitLink = soleAccount ? accountEntityLink(value, soleAccount.id) : null;
    if (explicitLink && !explicitLink.inferred && ['s_corp', 'sole_prop', 'llc_single', 'partnership', 'c_corp'].includes(explicitLink.type)) continue;
    const assigned = soleAccount ? facts['accounts.businessEntity']?.[soleAccount.id] : null;
    const assignedBusiness = assigned ? matchEntity(data, resolveEntities(data, baseFacts), assigned) : null;
    const linkAccount = soleAccount && (!assignedBusiness?.classified || sameName(assignedBusiness.name, employer.name));
    const entity = { name: employer.name, type: facts['income.sCorp'] === true ? 's_corp' : null, owner: [...employer.people][0],
      inferred: true, inferenceKind: 'household_payroll', nameSource: prior >= 0 ? 'owner' : 'employer',
      ...(linkAccount ? { accountId: soleAccount.id } : {}), evidence: {
        rule: 'Employer marked as a household business; employee from payroll recipient answers',
        documentCount: employer.docs.length, kinds: [...new Set(employer.docs.map(d => d.docType))],
      } };
    if (prior >= 0) value[prior] = { ...value[prior], ...entity }; else value.push(entity);
    payrollRows.push({ table: 'confirm_items', id: employer.relation.id }, ...employer.docs.map(d => ({ table: 'documents', id: d.id, fileId: d.fileId })));
  }
  const entities = resolveEntities({ ...data, pnl: data.pnlHistory || data.pnl }, baseFacts);
  for (const entity of entities) entity.budgetLedger = entity.lines.some(l => data.files?.some(f => f.id === l.file_id && /budget|personal|household|spending/i.test(f.name)));
  const add = (entity, type, rule) => {
    const nameSource = listed.some(e => sameName(e?.name, entity.name) && (!e.inferred || e.nameSource === 'owner')) ? 'owner' : entity.accountIds.length ? 'account' : 'ledger';
    const entry = { name: entity.name, type, inferred: true, nameSource, ...(entity.accountIds.length ? { accountIds: entity.accountIds } : {}), evidence: {
      rule, lineCount: entity.lines.length, kinds: [...new Set(entity.lines.map(l => l.originalCategory || l.category))].sort(),
    } };
    if (['personal', 'income_history'].includes(type)) {
      const attribution = summaryPerson(entity, baseFacts) || (type === 'income_history' ? { person: 'owner', source: 'owner_income_history' } : null);
      entry.owner = attribution?.person ?? null;
      entry.personSource = attribution?.source ?? null;
    }
    const i = value.findIndex(e => sameName(e?.name, entity.name));
    if (i < 0) value.push(entry); else value[i] = { ...value[i], ...entry };
    return value[i < 0 ? value.length - 1 : i];
  };
  const spending = [];
  const ambiguousSummaries = new Set();
  for (const entity of entities) {
    if (entity.classified || entity.accountIds.length || undone(entity.name) || ledgerKind(baseFacts, entity.name, entity.lines)) continue;
    const attribution = summaryPerson(entity, baseFacts);
    const totals = new Map();
    for (const line of entity.lines) {
      const category = String(line.category).trim().toLowerCase();
      totals.set(category, (totals.get(category) || 0) + line.amount);
    }
    const categories = [...totals.keys()];
    const otherIncome = categories.filter(category => totals.get(category) > 0 && !personalIncomeCategory(category)
      && !payrollIncomeCategory(category) && !entity.lines.some(l => String(l.category).trim().toLowerCase() === category && summaryTransfer(l)));
    const summary = attribution?.source === 'household_names' && categories.length > 0
      && !categories.some(c => /revenue|sales|client fees|consulting fees|officer|payroll/i.test(c))
      && categories.filter(c => PERSONAL_CATEGORIES.has(c)).length >= categories.length / 3;
    if (summary && otherIncome.length > 1) { ambiguousSummaries.add(entity); continue; }
    if (!summary && !looksLikeSpending(entity, baseFacts)) continue;
    spending.push(entity);
    const entry = add(entity, 'personal', summary
      ? `Per-person summary for ${attribution.person === 'owner' ? 'you' : 'your spouse'}: personal income and household spending by month.`
      : spendingStatement(entity));
    if (summary && otherIncome.length) entry.evidence.otherIncome = otherIncome.map(category => {
      const label = entity.lines.find(l => String(l.category).trim().toLowerCase() === category).category;
      return { category: label, stated: `Counted ${label} as ${attribution.person === 'owner' ? 'your' : "your spouse's"} other income from the summary sheet` };
    });
  }
  const cutoff = new Date(`${data.clock}T00:00:00Z`); cutoff.setUTCMonth(cutoff.getUTCMonth() - 6);
  const inactive = entities.filter(e => !e.classified && !e.accountIds.length && !spending.includes(e) && !ambiguousSummaries.has(e) && !undone(e.name) && !ledgerKind(baseFacts, e.name, e.lines)
    && e.lines.length && new Set(e.lines.map(l => l.period)).size <= 3 && e.lines.every(l => l.period < cutoff.toISOString().slice(0, 7)));
  for (const entity of inactive) {
    const history = new Set(entity.lines.map(l => l.category)).size === 1 && entity.lines.some(l => l.amount > 0)
      && entity.lines.every(l => l.amount >= 0 && /income|revenue|sales|client|consult/i.test(l.category));
    add(entity, history ? 'income_history' : 'inactive', history ? 'Past client-income summary for the owner; no current business activity'
      : 'At most three months of ledger activity, with nothing in the last six months');
  }
  const remaining = entities.filter(e => !spending.includes(e) && !inactive.includes(e));
  const accounts = remaining.filter(e => e.accountCandidate);
  const candidates = accounts.length ? accounts : remaining.filter(e => !ambiguousSummaries.has(e) && e.lines.some(l => /^income$|revenue|sales|client fees|consulting fees|payroll|officer|salary|wages/i.test(l.category)));
  if (facts['income.sCorp'] === true && !remaining.some(e => e.type === 's_corp') && candidates.length === 1 && !candidates[0].classified && !candidates[0].needsName && !undone(candidates[0].name)) {
    add(candidates[0], 's_corp', candidates[0].accountIds.length ? 'S corp income stated and the only active business account ledger with income and expense activity'
      : 'S corp income stated and the only remaining ledger with revenue or payroll');
  }
  const order = name => { const i = listed.findIndex(e => sameName(e?.name, name)); return i < 0 ? listed.length : i; };
  value.sort((a, b) => order(a?.name) - order(b?.name));
  return { value, changed: JSON.stringify(value) !== JSON.stringify(listed), rows: [...payrollRows, ...entities.flatMap(e => e.lines.map(l => ({ table: l.sourceTable || 'pnl_lines', id: l.id, fileId: l.file_id })))] };
}

// P&L sums for one entity (amounts: income positive, expenses negative).
export function pnlSums(entity) {
  const lines = entity.lines;
  const pick = test => lines.filter(l => test(l.category));
  return {
    income: sum(pick(isIncome).map(l => l.amount)),
    expenses: sum(lines.filter(l => l.section ? l.section === 'expenses' : l.amount < 0).map(l => -l.amount)),
    net: sum(lines.map(l => l.amount)),
    salary: sum(pick(isOfficer).map(l => -l.amount)),
    payrollTax: sum(pick(isPayrollTax).map(l => -l.amount)),
    employer401k: sum(pick(isEmployer401k).map(l => -l.amount)),
    ids: { all: lines.map(l => l.id), income: pick(isIncome).map(l => l.id), salary: pick(isOfficer).map(l => l.id), payrollTax: pick(isPayrollTax).map(l => l.id) },
    rows: { all: lines, income: pick(isIncome), salary: pick(isOfficer), payrollTax: pick(isPayrollTax) },
    fileId: lines[0] ? lines[0].file_id : null,
  };
}

// Transactions in the planning year up to the clock.
export function ytd(data, t) {
  const end = `${data.year}-12-31` < data.clock ? `${data.year}-12-31` : data.clock;
  return t.date >= `${data.year}-01-01` && t.date <= end;
}
