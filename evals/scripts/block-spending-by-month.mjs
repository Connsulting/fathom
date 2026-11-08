export function script() {
  return [
    { toolCalls: [{"name": "spending", "args": {"operation": "total", "groupBy": "month", "window": "ytd"}}], costUsd: 0 },
    { toolCalls: [{"name": "show", "args": {"operation": "chart", "source": {"tool": "spending", "args": {"operation": "total", "groupBy": "month", "window": "ytd"}, "path": "groups"}, "kind": "line", "x": "key", "series": [{"path": "figure"}]}}], costUsd: 0 },
    { text: 'The results follow.\n\n{b:b1}', costUsd: 0 },
  ];
}
