import { callTool } from '../../src/tools/index.mjs';

export async function script({ db, clock }) {
  const args = { operation: 'net_worth', groupBy: 'part' };
  const result = await callTool('accounts', args, { db, clock });
  return [{ toolCalls: [{ name: 'accounts', args }], costUsd: 0 },
    { text: `Net worth is ${result.total.quote}. ${result.groups.map(g => `${g.label}: ${g.figure.quote}`).join('; ')}. Older balances carry forward.`, costUsd: 0 }];
}
