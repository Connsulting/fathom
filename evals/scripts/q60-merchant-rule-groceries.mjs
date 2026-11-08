import { normalizeMerchant } from '../../src/categories/resolve.mjs';

export async function script({ db }) {
  const row = db.prepare("SELECT description FROM transactions WHERE lower(description) LIKE '%warehouse%' ORDER BY id LIMIT 1").get()
    ?? db.prepare('SELECT description FROM transactions ORDER BY id LIMIT 1').get();
  return [
    { toolCalls: [{ name: 'transactions', args: { operation: 'search', text: 'warehouse', limit: 5 } },
      { name: 'categorize', args: { operation: 'merchant_rule', merchant: normalizeMerchant(row.description), category: 'Groceries', propose: true } }], costUsd: 0 },
    { text: 'The merchant rule is ready for you to confirm.', costUsd: 0 },
  ];
}
