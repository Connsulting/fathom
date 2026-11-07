import { callTool, getTool } from '../../src/tools/index.mjs';

export async function script({ db, clock }) {
  const spendArgs = { operation: 'total', window: 'trailing_12', measure: 'spending' };
  const incomeArgs = { operation: 'total', window: 'trailing_12', measure: 'income' };
  const spend = await callTool('spending', spendArgs, { db, clock });
  const income = await callTool('spending', incomeArgs, { db, clock });
  const calls = [
    { name: 'spending', args: spendArgs },
    { name: 'spending', args: incomeArgs },
  ];
  if (getTool('calculate')) {
    const args = {
      operation: 'divide',
      label: 'Savings rate',
      operands: [
        { expr: { operation: 'subtract', operands: [{ ref: income.total.ref }, { ref: spend.total.ref }] } },
        { ref: income.total.ref },
      ],
    };
    const result = await callTool('calculate', args, { db, clock });
    calls.push({ name: 'calculate', args });
    const figure = result.result ?? result;
    return [
      { toolCalls: calls, costUsd: 0 },
      { text: `The returned savings rate is ${figure.quote ?? figure.value}.`, costUsd: 0 },
    ];
  }
  return [
    { toolCalls: calls, costUsd: 0 },
    { text: 'Savings rate arithmetic is not available yet.', costUsd: 0 },
  ];
}
