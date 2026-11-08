import { test, expect } from '@playwright/test';

test('@mobile @ax-confirm Confirm on an Ask proposal saves the goal and shows its receipt with Undo', async ({ page, request }) => {
  expect((await request.post('/api/demo/reset', { data: {} })).ok()).toBeTruthy();
  await page.goto('/#/ask');
  const input = page.locator('form.h-askx-compose textarea[name="q"]').first();
  await input.fill('propose a goal: Boat fund $5,000');
  await input.press('Enter');
  const card = page.locator('.h-pending-action');
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Not now', exact: true })).toBeVisible();
  const before = await (await request.get('/api/scenario')).json();
  expect(before.goals.filter(g => g.origin === 'owner' && g.title.startsWith('Boat fund'))).toHaveLength(0);
  await card.getByRole('button', { name: 'Confirm', exact: true }).click();
  const receipt = page.locator('.h-action-receipt');
  await expect(receipt).toContainText('Boat fund');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await expect(page.locator('.h-pending-action').getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0);
  const after = await (await request.get('/api/scenario')).json();
  const saved = after.goals.filter(g => g.origin === 'owner' && g.title.startsWith('Boat fund'));
  expect(saved).toHaveLength(1);
  expect(saved[0].target).toBe(5000);
});
