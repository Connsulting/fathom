export const BUCKETS = Object.freeze(['household', 'business', 'income', 'transfer', 'tax', 'saving', 'excluded']);

const aggregator = Object.freeze({
  Shopping: 'household', Income: 'income', 'Dining & Drinks': 'household', Business: 'business',
  'Credit Card Payment': 'transfer', 'Entertainment & Rec.': 'household', 'Bills & Utilities': 'household',
  'Auto & Transport': 'household', Groceries: 'household', 'Travel & Vacation': 'household',
  'Software & Tech': 'household', 'Home & Garden': 'household', Mortgage: 'household',
  'Income Tax': 'tax', Investment: 'saving', Medical: 'household', Childcare: 'household',
  'Internal Transfers': 'transfer', Gifts: 'household', Uncategorized: null, 'Health & Wellness': 'household',
  'Personal Care': 'household', 'Healthcare Premiums': 'household', Taxes: 'tax', 'Cash & Checks': 'household',
  'Mortgage Principal': 'saving', HSA: 'saving', Pets: 'household', Fees: 'household', Ignore: 'excluded',
  'Family Care': 'household', 'Charitable Donations': 'household', 'Savings Transfer': 'transfer', Legal: 'household',
});
export const CATEGORY_TABLES = Object.freeze({
  aggregator,
  'demo-seed': Object.freeze({ income: 'income', payroll: 'business', software: 'business', contractors: 'business',
    fees: 'business', transfer: 'transfer', groceries: 'household', utilities: 'household', dining: 'household',
    childcare: 'household', housing: 'household', health: 'household', Uncategorized: null }),
});
export const DEFAULT_CATEGORY = Object.freeze({ household: 'Shopping', business: 'Business', income: 'Income',
  transfer: 'Internal Transfers', tax: 'Taxes', saving: 'Investment', excluded: 'Ignore' });
export const businessAccount = a => a?.business === true || a?.kind === 'business' || String(a?.owner ?? '').toLowerCase() === 'business';
export const spendingAccount = a => !!a && ['checking','savings','cash','card'].includes(a.kind) && !businessAccount(a);
export const sourceBucket = (parser, category) => Object.hasOwn(CATEGORY_TABLES, parser ?? '')
  && Object.hasOwn(CATEGORY_TABLES[parser], category ?? '') ? CATEGORY_TABLES[parser][category] : null;
export const knownCategory = (parser, category) => Object.hasOwn(CATEGORY_TABLES, parser ?? '')
  && Object.hasOwn(CATEGORY_TABLES[parser], category ?? '');
export function normalizeMerchant(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/\b\d{1,4}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b/g, ' ')
    .replace(/\b(?:pos|debit|credit|card|purchase|pending|sq|tst|paypal)\b/g, ' ')
    .replace(/\b\d+\b/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
const cents = v => Math.round(v * 100);
const day = date => Date.parse(date + 'T00:00:00Z') / 86400000;
const order = (a,b) => a.date.localeCompare(b.date) || a.id - b.id;
export function matchTransfers(sources, candidates, days = 5) {
  const used = new Set(), matched = new Set(), byCents = new Map();
  for (const c of candidates) {
    const key = cents(c.amount), list = byCents.get(key) ?? [];
    list.push({ c, d: day(c.date) }); byCents.set(key,list);
  }
  for (const s of sources) {
    let best = null;
    for (const {c,d} of byCents.get(-cents(s.amount)) ?? []) {
      if (used.has(c.id) || c.account_id === s.account_id) continue;
      const gap = Math.abs(d-day(s.date));
      if (gap > days) continue;
      if (!best || gap < best.gap || (gap === best.gap && c.id < best.c.id)) best = {c,gap};
    }
    if (best) { used.add(best.c.id); matched.add(s.id); }
  }
  return matched;
}
const payment = text => /\b(?:auto\s*pay|payment|pmt)\b/i.test(text ?? '');
function cardPayment(t, byId, accounts) {
  if (!payment(t.description)) return false;
  if (t.amount > 0) return byId.get(t.account_id)?.kind === 'card' && !businessAccount(byId.get(t.account_id));
  if (t.amount >= 0) return false;
  const text = String(t.description).toLowerCase();
  return accounts.some(a => a.kind === 'card' && !businessAccount(a) && (
    (a.mask && new RegExp(`\\b${a.mask}\\b`).test(text))
    || [a.inst,a.name].some(name => {
      if (typeof name !== 'string' || name.trim().length < 4 || !text.includes(name.trim().toLowerCase())) return false;
      const identity = normalizeMerchant(name);
      return identity && !accounts.some(other => other.kind !== 'card'
        && [other.inst,other.name].some(value => value && normalizeMerchant(value) === identity));
    })));
}

// Source-name identity always uses the parser which supplied that category, including enrichment.
export function importedCategory(t) {
  return { category: t.imported_category ?? t.category ?? null, parser: t.category_parser ?? t.parser ?? null,
    fileId: t.category_file_id ?? t.file_id ?? null, locator: t.category_locator ?? t.locator ?? null };
}

// transferSourceIds gives the calculator's in-window spending rows first claim on counterpart rows.
export function resolveCategories({ transactions, accounts, corrections = [], merchantRules = [], sourceRules = [], guesses = [], transferSourceIds, transferDays = 5 }) {
  const rows = transactions.toSorted(order), byId = new Map(accounts.map(a=>[a.id,a]));
  const correction = new Map(corrections.map(r=>[r.transaction_id,r]));
  const merchants = new Map(merchantRules.map(r=>[r.merchant,r]));
  const sources = new Map(sourceRules.map(r=>[JSON.stringify([r.parser,r.category]),r]));
  const guessed = new Map(guesses.filter(r=>sourceBucket('aggregator',r.category)).map(r=>[r.transaction_id,r]));
  const result = new Map(), memory = new Map();
  const set = (t, category, bucket, layer, evidence = {}) => result.set(t.id, {category,bucket,layer,evidence});
  for (const t of rows) {
    const own = correction.get(t.id), imported = importedCategory(t), merchant = normalizeMerchant(t.description);
    const rule = merchants.get(merchant), mapped = sources.get(JSON.stringify([imported.parser,imported.category]));
    if (own) set(t,own.category,own.bucket,'correction',{transactionId:t.id});
    else if (rule && merchant) set(t,rule.category,rule.bucket,'correction',{merchant});
    else if (mapped) set(t,imported.category,mapped.bucket,'correction',imported);
    else if (sourceBucket(imported.parser,imported.category)) set(t,imported.category,sourceBucket(imported.parser,imported.category),'import',imported);
    const learned = own ?? (sourceBucket(imported.parser,imported.category) ? { category: imported.category, bucket: sourceBucket(imported.parser,imported.category), updated_at: t.category_at ?? t.date } : null);
    if (merchant && learned) {
      const sample = { ...learned, id:t.id, at: learned.updated_at ?? t.date, evidence: own ? {transactionId:t.id} : imported };
      const prior = memory.get(merchant);
      if (!prior || sample.at > prior.at || (sample.at === prior.at && sample.id > prior.id)) memory.set(merchant,sample);
    }
  }
  const priority = new Set(transferSourceIds ?? rows.filter(t=>spendingAccount(byId.get(t.account_id))).map(t=>t.id));
  const ranked = rows.toSorted((a,b)=>Number(priority.has(b.id))-Number(priority.has(a.id))
    || Number(spendingAccount(byId.get(b.account_id)))-Number(spendingAccount(byId.get(a.account_id))) || order(a,b));
  const out = matchTransfers(ranked.filter(t=>t.amount<0 && !result.has(t.id)), rows.filter(t=>t.amount>0),transferDays);
  const incoming = matchTransfers(ranked.filter(t=>t.amount>0 && !result.has(t.id)), rows.filter(t=>t.amount<0 && !businessAccount(byId.get(t.account_id))),transferDays);
  for (const t of rows) {
    if (result.has(t.id)) continue;
    const imported = importedCategory(t), unknown = imported.category && imported.category !== 'Uncategorized' && !knownCategory(imported.parser,imported.category);
    const finish = (category,bucket,layer,evidence) => set(t,unknown ? imported.category : category,bucket,layer,{...evidence,...(unknown ? {imported} : {})});
    if (out.has(t.id) || incoming.has(t.id) || cardPayment(t,byId,accounts)) finish('Internal Transfers','transfer','structural',{transactionId:t.id});
    else {
      const learned = memory.get(normalizeMerchant(t.description)), guess = guessed.get(t.id);
      if (learned) finish(learned.category,learned.bucket,'merchant',{transactionId:learned.id,...learned.evidence});
      else if (guess) finish(guess.category,sourceBucket('aggregator',guess.category),'guess',{transactionId:t.id,model:guess.model});
      else finish('Uncategorized',t.amount>0 ? 'income' : 'household','uncategorized',{transactionId:t.id});
    }
  }
  return result;
}
