export async function script({ db }) {
  const row = db.prepare("SELECT id FROM accounts WHERE owner = 'Your spouse' AND kind IN ('taxable','brokerage') ORDER BY id LIMIT 1").get()
    ?? db.prepare('SELECT id FROM accounts ORDER BY id LIMIT 1').get();
  return [
    { toolCalls: [{ name: 'accounts', args: { operation: 'list' } },
      { name: 'update_account', args: { operation: 'owner', id: row.id, owner: 'owner', propose: true } }], costUsd: 0 },
    { text: 'The account owner change is ready for you to confirm.', costUsd: 0 },
  ];
}
