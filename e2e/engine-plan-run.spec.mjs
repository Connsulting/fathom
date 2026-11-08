// Engine screen: Run plan now calls POST /api/jobs/plan/run. A demo household skips planning, and
// the screen says so in plain words ("Planning runs on real households") instead of an error toast.

import { test, expect, resetDemo, gotoRoute, expectH1, REMOTE } from './helpers.mjs';

test.skip(REMOTE, 'writes to the demo store');

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

test('Run plan now runs, then reports that planning runs on real households', async ({ page }) => {
  await gotoRoute(page, 'engine');
  await expectH1(page, 'Running');
  const button = page.getByRole('button', { name: 'Run plan now', exact: true });
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();

  const ran = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/jobs/plan/run');
  await button.click();
  expect((await ran).request().method()).toBe('POST');

  const status = page.locator('[data-plan-status]');
  await expect(status).toHaveAttribute('data-plan-phase', 'skipped');
  await expect(status).toContainText('Planning runs on real households');
  await expect(button).toBeEnabled();
  await expect(page.locator('.fx-err')).toHaveCount(0);
});
