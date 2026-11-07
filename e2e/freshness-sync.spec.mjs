// After Connect, the Accounts page shows Syncing, then the sync result, and Home and Money
// pick up the new data-through date without a reload. The demo store uses the synthetic bridge.
// Tags: @fr-ac3 @mobile

import { test, expect, resetDemo, gotoRoute, REMOTE } from './helpers.mjs';

test.skip(REMOTE, 'writes to the demo store');

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

async function hold(page, path, gate) {
  await page.route(path, async (route) => {
    const res = await route.fetch();
    await gate;
    await route.fulfill({ response: res });
  });
}

test('connect shows Syncing, then a current data-through line, at desktop and phone width @fr-ac3 @mobile', async ({ page }) => {
  await gotoRoute(page, 'accounts');
  let releaseConnect;
  const connectGate = new Promise((resolve) => { releaseConnect = resolve; });
  await hold(page, '**/api/simplefin/connect', connectGate);
  await page.getByRole('button', { name: 'Use the demo token' }).click();
  await page.locator('form[data-sf-form]').getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByRole('button', { name: 'Syncing' })).toBeVisible();
  releaseConnect();
  const box = page.locator('[data-sf-connected]');
  await expect(box.locator('[data-sf-sync]')).toContainText(/Synced \d+ accounts, data through \w{3} \d+, \d{4}/);
  const checking = page.locator('.h-acc', { hasText: 'Everyday Checking x4821' });
  await expect(checking.locator('.h-fresh')).toHaveText('Fresh');
  const notice = await box.locator('[data-sf-sync]').innerText();
  const day = notice.match(/data through (\w{3} \d+), \d{4}/)[1];

  await page.evaluate(() => { window.location.hash = '#/home'; });
  await expect(page.locator('div.h-dhealth')).toContainText(`Data through ${day}`);
  await page.evaluate(() => { window.location.hash = '#/money'; });
  await expect(page.locator('.h-money-health')).toContainText(`Data through ${day}`);
  await page.evaluate(() => { window.location.hash = '#/accounts'; });
  await expect(page.locator('[data-sf-connected]')).toBeVisible();

  let releaseSync;
  const syncGate = new Promise((resolve) => { releaseSync = resolve; });
  await page.unroute('**/api/simplefin/connect');
  await hold(page, '**/api/jobs/simplefin-sync/run', syncGate);
  await box.getByRole('button', { name: 'Sync now' }).click();
  await expect(box.getByRole('button', { name: 'Syncing' })).toBeVisible();
  releaseSync();
  await expect(box.locator('[data-sf-sync]')).toContainText(/Synced \d+ accounts, data through /);
});
