export function script() {
  return [{ toolCalls: [{ name: 'show', args: { operation: 'chart', kind: 'line', source: { tool: 'accounts', args: { operation: 'net_worth' }, path: 'months' }, x: 'month', series: [{ path: 'total' }] } }], costUsd: 0 },
    { text: 'Fathom does not have that result in this answer.', costUsd: 0 }];
}
