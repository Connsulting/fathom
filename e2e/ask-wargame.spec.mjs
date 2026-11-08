import { test, expect, resetDemo, gotoRoute, recDialog } from './helpers.mjs';

const panel = page => page.locator('aside#h-askp');
const question = 'Compare the salary options for my S corp side by side.';

async function openSalary(request) {
  const scenario = await (await request.get('/api/scenario')).json();
  const decided = scenario.decisions.find(d => d.wargame === 'salary' && d.status === 'decided');
  expect((await request.post(`/api/decisions/${decided.id}/revisit`, { data: {} })).status()).toBe(200);
  return decided.id;
}

test.beforeEach(async ({ request }) => { await resetDemo(request); });

test('@mobile salary starter, Pick, Undo and Decide use the real builder and registry', async ({ page, request }) => {
  const decisionId = await openSalary(request);
  await gotoRoute(page, 'home');
  await page.keyboard.press('Control+i');
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole('button', { name: question, exact: true }).click();
  const chart = panel(page).locator('figure.h-blk-chart');
  const compare = panel(page).locator('figure.h-blk-compare');
  await expect(chart.locator('svg[role="img"]')).toBeVisible();
  await expect(compare).toBeVisible();
  const state = await (await request.get('/api/scenario')).json();
  const points = state.wargame.salary.points;
  const index = state.live.picks.salary === 0 ? 1 : 0;
  const button = compare.locator('[data-block-pick]').nth(index);
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(compare.locator('section').nth(index)).toContainText('Picked');
  await expect(button).toBeFocused();
  const undo = panel(page).getByRole('button', { name: 'Undo', exact: true });
  await undo.focus();
  await page.keyboard.press('Enter');
  await expect(panel(page).getByText('Undone', { exact: true })).toBeVisible();
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(compare.locator('section').nth(index)).toContainText('Picked');
  const decide = compare.getByRole('button', { name: `Decide on ${points[index].label}`, exact: true });
  await decide.click();
  await expect(compare.locator('[data-block-pick]')).toHaveCount(0);
  const after = await (await request.get('/api/scenario')).json();
  expect(after.decisions.find(d => d.id === decisionId).status).toBe('decided');
  expect(after.live.picks.salary).toBe(index);
  await page.reload();
  await expect(panel(page).locator('.h-action-receipt')).toHaveCount(3);
  const widths = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(widths[0]).toBeLessThanOrEqual(widths[1]);
});

test('@mobile rec tradeoff button opens the Ask panel with the starter and recommendation chip', async ({ page, request }) => {
  await openSalary(request);
  const scenario = await (await request.get('/api/scenario')).json();
  const rec = scenario.recs.find(r => r.scenario === 'salary');
  expect(rec).toBeTruthy();
  await gotoRoute(page, `rec/${rec.id}`);
  await expect(recDialog(page)).toBeVisible();
  await recDialog(page).getByRole('button', { name: 'Ask about this tradeoff', exact: true }).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('figure.h-blk-chart')).toBeVisible();
  await expect(panel(page).locator('figure.h-blk-compare')).toBeVisible();
  await expect(panel(page).locator('.h-ctx-row')).toContainText(await page.evaluate(id => window.Fathom.api.txt(window.Fathom.api.rec(id).title), rec.id));
});

test('deferral starter stores and renders a comparison', async ({ request, page }) => {
  const res = await request.post('/api/threads', { data: { questionId: 'wargame-deferral' } });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.message.provenance.blocks.map(b => b.op)).toEqual(['compare']);
  expect(body.message.provenance.blockNotes).toEqual([]);
  await gotoRoute(page, `ask/${body.thread.id}`);
  await expect(page.locator('figure.h-blk-compare')).toBeVisible();
});
