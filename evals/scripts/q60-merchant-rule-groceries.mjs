import { normalizeMerchant } from '../../src/categories/resolve.mjs';

export async function script({ db }) {
  const row = await db.prepare("SELECT id FROM transactions WHERE category = 'groceries' ORDER BY id LIMIT 1").get();
  if (!row) throw new Error('The synthetic household needs a grocery transaction for the warehouse-club case.');
  const description = 'Synthetic warehouse club';
  await db.prepare('UPDATE transactions SET description = ? WHERE id = ?').run(description, row.id);
  return [
    { toolCalls: [{ name: 'transactions', args: { operation: 'search', text: 'warehouse', limit: 5 } },
      { name: 'categorize', args: { operation: 'merchant_rule', merchant: normalizeMerchant(description), category: 'Groceries', propose: true } }], costUsd: 0 },
    { text: 'The merchant rule is ready for you to confirm.', costUsd: 0 },
  ];
}
