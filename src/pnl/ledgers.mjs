import { normalizeName } from '../ingest/confirm.mjs';
import { parseJson } from '../store/db.mjs';
import { sourceBucket } from '../categories/resolve.mjs';

export function ledgerDisplayName(line) {
  const locator = typeof line.locator === 'string' ? parseJson(line.locator, {}) : line.locator;
  const sheet = locator?.sheet;
  return String((typeof sheet === 'string' ? sheet.replace(/[\s:._()[\]{}-]+(?:actual[\s:._()[\]{}-]+)?(?:income|expenses?)[\s)\]}]*$/iu, '').trim() : '') || line.entity).trim();
}

export function ledgerKind(facts, name, lines = []) {
  const map = facts['pnl.ledgers'];
  const names = new Set([name, ...lines.map(ledgerDisplayName)].map(normalizeName));
  const entry = map && !Array.isArray(map) ? Object.entries(map).find(([key]) => names.has(normalizeName(key)))?.[1] : null;
  if (['spending', 'business'].includes(entry?.kind)) return entry.kind;
  const entity = Array.isArray(facts['business.entities']) ? facts['business.entities'].find(e => names.has(normalizeName(e?.name))) : null;
  if (['personal', 'not_mine'].includes(entity?.type)) return 'spending';
  if (entity?.type === 'income_history') return 'income_history';
  if (entity?.type === 'inactive') return 'inactive';
  return null;
}

export function accountEntityLink(listed, accountId) {
  return (Array.isArray(listed) ? listed : []).filter(e => e?.accountId === accountId)
    .sort((a, b) => Number(!!a.inferred) - Number(!!b.inferred))[0] || null;
}

export function ownerEntityIdentity(entity) {
  const { type, inferred, evidence, accountIds, accountId, inferenceKind, nameSource, personSource, ...identity } = entity;
  return identity;
}

const personName = text => normalizeName(String(text || '').replace(/\s+(?:personal\s+)?(?:summary|summary sheet|monthly summary|budget|income and expenses|income & expenses)$/i, '').replace(/['’]s$/i, ''));
const nameWords = text => (String(text || '').normalize('NFKC').toLowerCase().replace(/['’]s\b/g, '').match(/[\p{L}\p{N}]+/gu) || []).join(' ');
export const payrollIncomeCategory = category => /^(?:income|wages|salary|paychecks?|employment income|wages and salary)$/i.test(String(category).trim());
export const personalIncomeCategory = category => payrollIncomeCategory(category) || /^(?:client income|self.employment income|interest income|dividend income|other income)$/i.test(String(category).trim());
export const summaryTransfer = line => line.bucket === 'transfer' || sourceBucket(line.parser, line.category) === 'transfer'
  || sourceBucket('aggregator', line.category) === 'transfer' || /transfer|venmo|zelle|paypal/i.test(line.category);
export function summaryIncomeAssumption(entry, category) {
  const assumed = entry?.inferred && entry.type === 'personal' && entry.evidence?.otherIncome?.find(a => normalizeName(a.category) === normalizeName(category));
  return assumed ? { stated: assumed.stated, key: 'business.entities', path: [entry.name], undoKey: 'business.entityInference' } : null;
}
export const summaryAssumptions = rows => [...new Map(rows.filter(r => r.incomeAssumption)
  .map(r => [JSON.stringify(r.incomeAssumption), r.incomeAssumption])).values()];
export function summaryPerson(entity, facts) {
  const labels = [entity.name, entity.displayName, ...(entity.lines || []).map(ledgerDisplayName)].filter(Boolean);
  const names = new Set(labels.map(personName));
  const manual = (Array.isArray(facts['business.entities']) ? facts['business.entities'] : []).find(e => e && !e.inferred
    && ['personal', 'income_history'].includes(e.type) && names.has(personName(e.name)) && ['owner', 'spouse'].includes(e.owner));
  if (manual) return { person: manual.owner, source: 'owner_classification' };
  const assigned = Object.entries(facts['pnl.people'] || {}).find(([name, person]) => names.has(personName(name)) && ['owner', 'spouse'].includes(person));
  if (assigned) return { person: assigned[1], source: 'owner_answer' };
  const household = facts['household.names'] || {};
  const matches = ['owner', 'spouse'].filter(person => [household[person], ...(person === 'owner' ? [household.me] : [])]
    .filter(n => typeof n === 'string' && n.trim()).some(n => [n, n.trim().split(/\s+/)[0]].some(candidate => names.has(personName(candidate))
      || labels.some(label => ` ${nameWords(label)} `.includes(` ${nameWords(candidate)} `)))));
  return matches.length === 1 ? { person: matches[0], source: 'household_names' } : null;
}

// A majority of personal categories and no revenue identify a spending statement.
export const PERSONAL_CATEGORIES = new Set([
  'medical', 'healthcare', 'shopping', 'groceries', 'hsa', 'dining', 'restaurants',
  'food', 'entertainment', 'clothing', 'personal care', 'childcare', 'pets', 'household',
  'dining & drinks', 'entertainment & rec.', 'bills & utilities', 'auto & transport',
  'travel & vacation', 'home & garden', 'health & wellness', 'healthcare premiums', 'family care',
]);

export function looksLikeSpending(entity, facts) {
  const lines = entity.lines || [];
  if (entity.classified || ledgerKind(facts, entity.name, lines) || !lines.length) return false;
  const personal = !!summaryPerson(entity, facts)
    || (entity.budgetLedger && /^[\p{L}]+(?:[ '’\-][\p{L}]+){0,3}$/u.test(entity.displayName || entity.name));
  if (lines.some(l => (personal ? /revenue|sales|client fees|consulting fees|officer|payroll/i : /^income$|revenue|sales|client fees|consulting fees/i).test(l.category))) return false;
  const totals = new Map();
  for (const line of lines) totals.set(line.category, (totals.get(line.category) || 0) + line.amount);
  if ([...totals].some(([category, amount]) => amount > 0 && !(personal && personalIncomeCategory(category)) && !PERSONAL_CATEGORIES.has(String(category).trim().toLowerCase()))) return false;
  const categories = [...new Set(lines.map(l => String(l.category).trim().toLowerCase()))];
  const spending = categories.filter(c => PERSONAL_CATEGORIES.has(c)).length;
  return spending > categories.length / 2 || (personal && spending > 0 && categories.every(c => PERSONAL_CATEGORIES.has(c) || personalIncomeCategory(c)));
}

export const spendingStatement = entity => `${entity.displayName || entity.name} looks like personal spending: mostly household categories.`;

export function businessEntry(transaction, category) {
  if (category.layer === 'uncategorized') return { section: transaction.amount > 0 ? 'income' : 'expenses', category: 'Uncategorized' };
  if (category.bucket === 'income') return { section: 'income', category: category.category };
  if (category.bucket === 'business') return { section: 'expenses', category: category.category };
  return null;
}
