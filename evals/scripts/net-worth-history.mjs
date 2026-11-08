import { callTool } from '../../src/tools/index.mjs';

export async function script({ db, clock }) {
  const args = { operation: 'net_worth', series: true, months: 120 };
  const result = await callTool('accounts', args, { db, clock });
  return [{ toolCalls: [{ name: 'accounts', args }], costUsd: 0 },
    { text: `Net worth at the latest balance date is ${result.total.quote}. The monthly series carries older balances forward.`, costUsd: 0 }];
}
