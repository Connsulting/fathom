// Owner display names on Money Accounts: inline rename, then the same name in the switcher and
// on the confirm card that names the account.

import { test, expect, resetDemo, gotoRoute, deckFind } from './helpers.mjs';

test.describe('account display names', { tag: '@an-acN' }, () => {
  test.beforeEach(async ({ request }) => {
    await resetDemo(request);
  });

  test('rename on Accounts shows in the switcher and on a question card', async ({ page, request }) => {
    const scenario = await (await request.get('/api/scenario')).json();
    const item = scenario.live.ingest.items.find((i) => i.kind === 'account_owner' && i.subject);
    expect(item, 'demo has an account question').toBeTruthy();
    await gotoRoute(page, 'accounts');
    const first = page.locator(`[data-account="${item.subject}"] .h-acc-name`);
    await expect(first).toBeVisible();
    await first.click();
    const input = page.locator('[data-acc-name]');
    await input.fill('Household reserve');
    await input.press('Enter');
    await expect(page.locator('.h-acc-name', { hasText: 'Household reserve' })).toBeVisible();

    await page.keyboard.press('Control+k');
    await expect(page.locator('.h-qs-t', { hasText: 'Household reserve' })).toBeVisible();
    await page.keyboard.press('Escape');

    await gotoRoute(page, 'confirm');
    const card = await deckFind(page, `[data-item="${item.id}"]`);
    await expect(card.locator('[data-field="name"]')).toContainText('Household reserve');
    await card.locator('[data-field="name"] .h-acc-name').click();
    await expect(card.locator('[data-acc-name]')).toBeVisible();
    await card.locator('[data-acc-name]').press('Escape');
    await expect(card.locator('[data-field="name"]')).toContainText('Household reserve');
  });
});

test.describe('account display names on a phone', { tag: ['@mobile', '@mobile-only', '@an-acN'] }, () => {
  test.beforeEach(async ({ request }) => {
    await resetDemo(request);
  });

  test('rename on Accounts at phone width', async ({ page }) => {
    await gotoRoute(page, 'accounts');
    const first = page.locator('.h-acc-name').first();
    await first.click();
    const input = page.locator('[data-acc-name]');
    await input.fill('Phone reserve');
    await input.press('Enter');
    await expect(page.locator('.h-acc-name', { hasText: 'Phone reserve' })).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(page.locator('.h-qs-t', { hasText: 'Phone reserve' })).toBeVisible();
  });
});
