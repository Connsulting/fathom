import { test, expect } from '@playwright/test';

test('pace API supplies the demo goal data, provenance and explicit stale health', async ({ request }) => {
  await request.post('/api/demo/reset', { data: {} });
  const response = await request.get('/api/pace');
  expect(response.ok()).toBe(true);
  const pace = await response.json();
  const reserve = pace.goals.find(g => g.id === 'reserve');
  expect(reserve.actual.v).toBe(117900);
  expect(reserve.target.v).toBe(166000);
  expect(reserve.status).toBe('unknown');
  expect(reserve.reason).toBe('stale_data');
  expect(reserve.expected.locator.calc).toBe('goalPace');
  expect(pace.series.goals.reserve.series).toHaveLength(12);
  expect(pace.series.goals.reserve.series[11].projected).toBe(true);
  expect((await (await request.get('/api/scenario')).json()).pace).toEqual(pace);
});
