export async function script({ db }) {
  const row = await db.prepare("SELECT id FROM accounts WHERE owner = ? AND kind = 'taxable' ORDER BY id LIMIT 1").get('{n:spouse}');
  if (!row) throw new Error('The synthetic household needs a spouse-owned brokerage account.');
  return [
    { toolCalls: [{ name: 'accounts', args: { operation: 'list' } },
      { name: 'update_account', args: { operation: 'owner', id: row.id, owner: 'owner', propose: true } }], costUsd: 0 },
    { text: 'The account owner change is ready for you to confirm.', costUsd: 0 },
  ];
}
