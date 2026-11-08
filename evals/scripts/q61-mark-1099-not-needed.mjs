import { yearendChecklist, taxYearFor } from '../../src/yearend/expected.mjs';

export async function script({ db, clock }) {
  const account = db.prepare("SELECT id FROM accounts WHERE kind = 'cash' AND owner = ? ORDER BY id LIMIT 1").get('{n:spouse}');
  if (!account) throw new Error('The synthetic household needs a cash account for the credit-union case.');
  db.prepare('UPDATE accounts SET display_name = ?, inst = ? WHERE id = ?').run('Synthetic credit union checking', 'Example Credit Union', account.id);
  const year = taxYearFor(clock);
  const item = yearendChecklist(db, { year, clock }).items.find(i => i.key === `1099-int:${account.id}`);
  if (!item) throw new Error('The synthetic household needs an expected interest document for the credit union.');
  return [
    { toolCalls: [{ name: 'household', args: { operation: 'health' } },
      { name: 'answer', args: { operation: 'yearend_mark', year, itemKey: item.key, reason: 'we closed that account', propose: true } }], costUsd: 0 },
    { text: 'The document mark is ready for you to confirm.', costUsd: 0 },
  ];
}
