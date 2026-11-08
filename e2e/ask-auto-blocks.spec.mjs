// AV2 automatic Ask visuals: the demo server's fake engine answers the monthly spending question by
// reading spending by month without calling show, and Fathom appends the chart itself. The chart
// is drawn in the Ask page with no console or page errors, its stored provenance says it was
// drawn automatically, and the block status check replays it as current.

import { test, expect, resetDemo, gotoRoute, askOnAsk } from './helpers.mjs';

const QUESTION = 'How has our monthly spending changed this year?';
const MONTH_ARGS = { operation: 'total', groupBy: 'month', window: 'ytd' };

test.use({ timezoneId: 'UTC' });

test('an answer with no model block draws an automatic monthly spending chart', async ({ page, request }) => {
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });
  page.on('pageerror', (err) => errors.push(`page: ${err.message}`));
  await resetDemo(request);
  await gotoRoute(page, 'ask');
  const id = await askOnAsk(page, QUESTION);

  const res = await request.get(`/api/threads/${id}`);
  expect(res.status(), `GET /api/threads/${id}`).toBe(200);
  const { messages } = await res.json();
  const reply = messages.filter((m) => m.role === 'fathom').at(-1);
  expect(reply.notice).toBe(false);
  expect(reply.text).not.toContain('{b:');
  const blocks = reply.provenance.blocks;
  expect(blocks).toHaveLength(1);
  const [block] = blocks;
  expect(block.origin).toBe('auto');
  expect(block.op).toBe('chart');
  expect(block.snapshot.kind).toBe('bar');
  expect(block.calls).toEqual([{ tool: 'spending', args: MONTH_ARGS }]);
  expect(reply.provenance.tools.some((t) => t.name === 'show')).toBe(false);

  const figure = page.locator('.h-root').locator(`figure.h-blk[data-blk="${reply.id}:${block.id}"]`);
  await expect(figure).toBeVisible();
  await expect(figure.locator('figcaption')).toHaveText(block.snapshot.title);
  const chart = figure.locator('svg[role="img"]');
  await expect(chart).toBeVisible();
  await expect(chart).toHaveAttribute('aria-label', /^Bar chart of /);

  const status = await request.get(`/api/threads/${id}/blocks`);
  expect(status.status(), `GET /api/threads/${id}/blocks`).toBe(200);
  const listed = (await status.json()).blocks.filter((b) => b.messageId === reply.id);
  expect(listed).toEqual([{ messageId: reply.id, id: block.id, state: 'current', changed: 0 }]);

  expect(errors, 'console and page errors').toEqual([]);
});
