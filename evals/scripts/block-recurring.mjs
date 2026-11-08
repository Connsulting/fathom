export function script() {
  return [
    { toolCalls: [{"name": "spending", "args": {"operation": "recurring", "status": "all"}}], costUsd: 0 },
    { toolCalls: [{"name": "show", "args": {"operation": "table", "source": {"tool": "spending", "args": {"operation": "recurring", "status": "all"}, "path": "charges"}, "columns": ["merchant", "annualCost"]}}], costUsd: 0 },
    { text: 'The results follow.\n\n{b:b1}', costUsd: 0 },
  ];
}
