// Engine screen: Run plan now calls POST /api/jobs/plan/run. A demo household skips planning (the
// route answers 409), and the screen says so in plain words ("Planning runs on real households")
// beside the button instead of an error toast.

import { test as plainTest } from '@playwright/test';
import { expect, resetDemo, gotoRoute, expectH1, REMOTE } from './helpers.mjs';

// The plain fixture: the browser logs the refused 409 as a console error, which the shared
// fixture treats as a failure.
plainTest('Run plan now runs, then reports that planning runs on real households', async ({ page, request }) => {
  plainTest.skip(REMOTE, 'writes to the demo store');
  await resetDemo(request);
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
