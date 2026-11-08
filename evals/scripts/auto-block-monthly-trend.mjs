export function script() {
  return [
    { toolCalls: [{"name": "spending", "args": {"operation": "total", "groupBy": "month", "window": "ytd"}}], costUsd: 0 },
    { text: 'Monthly spending this year follows.', costUsd: 0 },
  ];
}
