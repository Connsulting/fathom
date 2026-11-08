export function script() {
  return [
    { toolCalls: [{"name": "spending", "args": {"operation": "total", "groupBy": "category", "window": "ytd"}}], costUsd: 0 },
    { text: 'Spending by category this year follows.', costUsd: 0 },
  ];
}
