export function script() {
  return [
    { toolCalls: [{"name": "spending", "args": {"operation": "total", "groupBy": "merchant", "limit": 10, "window": "ytd"}}], costUsd: 0 },
    { toolCalls: [{"name": "show", "args": {"operation": "table", "source": {"tool": "spending", "args": {"operation": "total", "groupBy": "merchant", "limit": 10, "window": "ytd"}, "path": "groups"}, "columns": ["key", "figure"]}}], costUsd: 0 },
    { text: 'The results follow.\n\n{b:b1}', costUsd: 0 },
  ];
}
