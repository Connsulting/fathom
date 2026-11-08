export function staleAccountIds(accounts = []) {
  return accounts.filter(account => account?.fresh === 'stale').map(account => account.id);
}
