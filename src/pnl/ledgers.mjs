import { normalizeName } from '../ingest/confirm.mjs';
import { parseJson } from '../store/db.mjs';

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
  return null;
}

// A majority of personal categories and no revenue identify a spending statement.
const PERSONAL_CATEGORIES = new Set([
  'medical', 'healthcare', 'shopping', 'groceries', 'hsa', 'dining', 'restaurants',
  'food', 'entertainment', 'clothing', 'personal care', 'childcare', 'pets', 'household',
  'dining & drinks', 'entertainment & rec.', 'bills & utilities', 'auto & transport',
  'travel & vacation', 'home & garden', 'health & wellness', 'healthcare premiums', 'family care',
]);

export function looksLikeSpending(entity, facts) {
  const lines = entity.lines || [];
  if (entity.classified || ledgerKind(facts, entity.name, lines) || !lines.length) return false;
  if (lines.some(l => /^income$|revenue|sales|client fees|consulting fees/i.test(l.category))) return false;
  const totals = new Map();
  for (const line of lines) totals.set(line.category, (totals.get(line.category) || 0) + line.amount);
  if ([...totals].some(([category, amount]) => amount > 0 && !PERSONAL_CATEGORIES.has(String(category).trim().toLowerCase()))) return false;
  const categories = [...new Set(lines.map(l => String(l.category).trim().toLowerCase()))];
  return categories.filter(c => PERSONAL_CATEGORIES.has(c)).length > categories.length / 2;
}

export const spendingStatement = entity => `${entity.displayName || entity.name} looks like card spending, not a business: no income, mostly personal categories.`;
