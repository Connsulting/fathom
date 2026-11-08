import { callTool } from '../../src/tools/index.mjs';

export async function script({ db, clock }) {
  const ctx = { db, clock }, args = { operation: 'net_worth', series: true, months: 120 };
  const result = await callTool('accounts', args, ctx);
  const change = { operation: 'subtract', operands: [{ ref: result.series.at(-1).total.ref }, { ref: result.series[0].total.ref }], label: 'Net worth change' };
  const { figure } = await callTool('calculate', change, ctx);
  return [{ toolCalls: [{ name: 'accounts', args }], costUsd: 0 },
    { toolCalls: [{ name: 'calculate', args: change }], costUsd: 0 },
    { text: `Net worth increased by ${figure.quote} from the first to the latest balance snapshot. Older balances carry forward.`, costUsd: 0 }];
}
