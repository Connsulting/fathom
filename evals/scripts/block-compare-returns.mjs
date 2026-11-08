export function script({ turn }) {
  const reads = [0.03, 0.04].map(value => ({ name: 'retirement', args: { operation: 'target', realReturn: { value, source: 'owner', evidence: turn.question } } }));
  return [{ toolCalls: reads, costUsd: 0 },
    { toolCalls: [{ name: 'show', args: { operation: 'compare', options: reads.map(c => ({ source: { tool: c.name, args: c.args, path: '' } })), fields: ['target', 'months'] } }], costUsd: 0 },
    { text: 'The return scenarios follow.\n\n{b:b1}', costUsd: 0 }];
}
