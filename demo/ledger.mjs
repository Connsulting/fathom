// Deterministic synthetic ledger for the demo store: transactions, balances, positions, monthly
// P and L lines and estimated tax payments. Seeded PRNG only (never Math.random), so every seed
// produces the same rows. Values are synthetic and need not reconcile with the scenario figures,
// except that each account's balance at data-through equals its figure value.

import { cents } from '../src/store/db.mjs';

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const pad = n => String(n).padStart(2, '0');

// mulberry32: small, fast, good enough for synthetic data.
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 'Aug 30, 2026' -> '2026-08-30'
export function isoFromLabel(label) {
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/.exec(String(label || '').trim());
  if (!m || !MONTHS[m[1]]) return null;
  return `${m[3]}-${pad(MONTHS[m[1]])}-${pad(Number(m[2]))}`;
}

const BUSINESS_FLOWS = [
  { description: 'Client payment', category: 'income', sign: 1, min: 6000, max: 18000, per: [2, 3] },
  { description: 'Payroll', category: 'payroll', sign: -1, min: 2800, max: 3600, per: [2, 2] },
  { description: 'Software subscription', category: 'software', sign: -1, min: 30, max: 650, per: [2, 4] },
  { description: 'Contractor invoice', category: 'contractors', sign: -1, min: 500, max: 3000, per: [0, 1] },
  { description: 'Bank fee', category: 'fees', sign: -1, min: 8, max: 30, per: [0, 1] },
  { description: 'Owner distribution', category: 'transfer', sign: -1, min: 2000, max: 5500, per: [1, 2] },
];
const HOUSEHOLD_FLOWS = [
  { description: 'Paycheck deposit', category: 'income', sign: 1, min: 3800, max: 5600, per: [2, 2] },
  { description: 'Grocery', category: 'groceries', sign: -1, min: 55, max: 310, per: [5, 8] },
  { description: 'Utilities', category: 'utilities', sign: -1, min: 70, max: 280, per: [2, 3] },
  { description: 'Restaurant', category: 'dining', sign: -1, min: 25, max: 160, per: [3, 5] },
  { description: 'Childcare', category: 'childcare', sign: -1, min: 600, max: 1200, per: [1, 1] },
  { description: 'Mortgage payment', category: 'housing', sign: -1, min: 2900, max: 2900, per: [1, 1] },
  { description: 'Pharmacy', category: 'health', sign: -1, min: 12, max: 75, per: [0, 2] },
];

const FUNDS = [
  { symbol: 'TMKT', name: 'TMKT Total Market Index', price: 112.4 },
  { symbol: 'INTL', name: 'INTL International Index', price: 58.15 },
  { symbol: 'BNDX', name: 'BNDX Aggregate Bond Index', price: 47.8 },
  { symbol: 'SMCP', name: 'SMCP Small Cap Index', price: 73.25 },
  { symbol: 'TDF5', name: 'TDF5 Target Date 2045 Fund', price: 31.6 },
  { symbol: 'MMKT', name: 'MMKT Money Market Fund', price: 1 },
];

const PNL_CATEGORIES = [
  { category: 'revenue', sign: 1, min: 20000, max: 34000 },
  { category: 'payroll', sign: -1, min: 6500, max: 7500 },
  { category: 'software', sign: -1, min: 200, max: 1100 },
  { category: 'contractors', sign: -1, min: 0, max: 4500 },
  { category: 'other', sign: -1, min: 250, max: 1500 },
];

const TRANSACTION_KINDS = ['checking', 'business'];
const POSITION_KINDS = ['taxable', 'retirement', 'roth', '529'];

// Build the ledger. accounts: [{id, kind, fig}] in scenario order; fig: scenario.fig;
// entities: business names for P and L; year: the clock year; through: ISO data-through date.
export function buildLedger({ accounts, fig, entities, year, through, seed = 73019 }) {
  const rnd = prng(seed);
  const history = prng(seed + 7);
  const between = (min, max) => min + (max - min) * rnd();
  const int = (min, max) => Math.floor(between(min, max + 1));
  const lastMonth = Number(through.slice(5, 7));
  const lastDay = Number(through.slice(8, 10));

  const transactions = [];
  const balances = [];
  const positions = [];
  const pnl = [];
  const taxPayments = [];
  const masks = {};

  accounts.forEach((a) => {
    // Synthetic four digit masks for mirrored accounts; manual and missing ones have none.
    masks[a.id] = a.mirror === 'connected' ? String(int(1000, 9999)) : null;
  });

  for (const a of accounts) {
    if (!TRANSACTION_KINDS.includes(a.kind) || !a.fig) continue;
    const flows = a.kind === 'business' ? BUSINESS_FLOWS : HOUSEHOLD_FLOWS;
    for (let m = 1; m <= lastMonth; m++) {
      const days = m === lastMonth ? lastDay : 28;
      for (const f of flows) {
        const n = int(f.per[0], f.per[1]);
        for (let k = 0; k < n; k++) {
          transactions.push({
            accountId: a.id,
            date: `${year}-${pad(m)}-${pad(int(1, days))}`,
            amount: cents(f.sign * between(f.min, f.max)),
            description: f.description,
            category: f.category,
          });
        }
      }
    }
  }
  const personal = accounts.find(a => a.kind === 'checking' && a.fig);
  if (personal) for (const month of [4,6]) transactions.push({ accountId:personal.id,date:`${year}-${pad(month)}-12`,amount:-415,description:'Example Service',category:'Uncategorized' });
  transactions.sort((x, y) => (x.accountId < y.accountId ? -1 : x.accountId > y.accountId ? 1 : 0) || (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  transactions.forEach((t, i) => { t.locator = `ledger:row ${i + 1}`; t.dedupeKey = `demo-seed:${i + 1}`; });

  for (const a of accounts) {
    const f = a.fig && fig[a.fig];
    if (!f || typeof f.v !== 'number') continue;
    balances.push({ accountId: a.id, date: through, amount: cents(f.v), locator: `balances:${a.id}` });
    // Month-end history, walked back from the current balance with its own generator so the rows
    // above and below do not change: invested kinds grew, cash moves around.
    let v = f.v;
    for (let m = lastMonth - 1; m >= 1; m--) {
      const growth = POSITION_KINDS.includes(a.kind) ? 0.012 + (history() - 0.5) * 0.03 : (history() - 0.5) * 0.12;
      v = Math.max(0, v / (1 + growth));
      const date = `${year}-${pad(m)}-${pad(new Date(Date.UTC(Number(year), m, 0)).getUTCDate())}`;
      balances.push({ accountId: a.id, date, amount: cents(v), locator: `balances:${a.id}:${date}` });
    }
    if (!POSITION_KINDS.includes(a.kind) || f.v <= 0) continue;
    const count = int(2, 3);
    const picks = [];
    while (picks.length < count) {
      const fund = FUNDS[int(0, FUNDS.length - 1)];
      if (!picks.includes(fund)) picks.push(fund);
    }
    const weights = picks.map(() => between(1, 3));
    const total = weights.reduce((s, w) => s + w, 0);
    let left = cents(f.v);
    picks.forEach((fund, i) => {
      const value = i === picks.length - 1 ? cents(left) : cents(f.v * weights[i] / total);
      left = cents(left - value);
      const quantity = Math.round((value / fund.price) * 1000) / 1000;
      positions.push({
        accountId: a.id, asOf: through, symbol: fund.symbol, name: fund.name, quantity, price: fund.price, value,
        costBasis: cents(value * between(0.6, 0.95)), locator: `positions:${a.id}:${i + 1}`,
      });
    });
  }

  for (const entity of entities) {
    for (let m = 1; m <= lastMonth; m++) {
      for (const c of PNL_CATEGORIES) {
        pnl.push({ entity, period: `${year}-${pad(m)}`, category: c.category, amount: cents(c.sign * between(c.min, c.max)) });
      }
    }
  }
  pnl.forEach((p, i) => { p.locator = `pnl:row ${i + 1}`; });

  const quarters = [
    { date: `${year}-01-15`, taxYear: Number(year) - 1 },
    { date: `${year}-04-15`, taxYear: Number(year) },
    { date: `${year}-06-15`, taxYear: Number(year) },
  ];
  for (const q of quarters) {
    taxPayments.push({ jurisdiction: 'federal', taxYear: q.taxYear, date: q.date, amount: cents(between(15000, 24000)), kind: 'estimate' });
    taxPayments.push({ jurisdiction: 'state', taxYear: q.taxYear, date: q.date, amount: cents(between(3500, 6500)), kind: 'estimate' });
  }
  taxPayments.forEach((p, i) => { p.locator = `tax:row ${i + 1}`; });

  // Each estimated payment on or before data-through also leaves the first funded checking account,
  // numbered after the rows above so their locators and dedupe keys do not move.
  if (personal) {
    for (const p of taxPayments) {
      if (p.date > through) continue;
      const n = transactions.length + 1;
      transactions.push({ accountId: personal.id, date: p.date, amount: -p.amount, description: 'Estimated tax payment', category: 'taxes',
        locator: `ledger:row ${n}`, dedupeKey: `demo-seed:${n}` });
    }
  }

  return { masks, transactions, balances, positions, pnl, taxPayments };
}
