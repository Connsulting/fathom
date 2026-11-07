// Advisor packet feedback: an empty review queue explains the disabled Prepare button,
// preparing always shows a spinner then a result, and verdict and check-in failures are visible.
// Desktop and phone (@mobile). Demo data only.

import { test as base } from '@playwright/test';
import { expect, gotoRoute, resetDemo } from './helpers.mjs';

// The shared page fixture fails on any console error. These tests force 409 and 500 replies, and
// the browser logs those loads, so only failed loads of the advisor writes are allowed.
const test = base.extend({
  page: async ({ page }, use) => {
    const problems = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const url = (msg.location() && msg.location().url) || '';
      const path = url ? new URL(url).pathname : '';
      if (/Failed to load resource/.test(msg.text()) && /^\/api\/advisor\/(packets|checkin|reviews\/[^/]+\/verdict)$/.test(path)) return;
      problems.push(`console error: ${msg.text()}${url ? ` (${url})` : ''}`);
    });
    page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
    await use(page);
    expect(problems, 'console errors other than the forced advisor failures').toEqual([]);
  },
});

const EMPTY = 'Send a recommendation to your advisor first; it lands here for review';

async function clearWaiting(page) {
  await gotoRoute(page, 'advisor');
  const ids = await page.locator('[data-review]').evaluateAll((els) => els.map((el) => el.getAttribute('data-review')));
  for (const id of ids) {
    const status = await page.evaluate(async (reviewId) => {
      const res = await fetch('/api/advisor/reviews/' + encodeURIComponent(reviewId) + '/verdict', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ verdict: 'confirmed', note: '', date: '2026-11-01' }),
      });
      return res.status;
    }, id);
    expect(status, `verdict for ${id}`).toBe(200);
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
}

test.describe('advisor packet feedback', { tag: ['@mobile', '@ap-ac4'] }, () => {
  test.beforeEach(async ({ request }) => {
    await resetDemo(request);
  });

  test('empty queue explains the disabled button', { tag: '@ap-ac1' }, async ({ page }) => {
    await clearWaiting(page);
    const packet = page.locator('section', { has: page.getByRole('button', { name: 'Prepare packet' }) });
    await expect(packet).toContainText(EMPTY);
    const plan = packet.getByRole('link', { name: 'Plan' });
    await expect(plan).toHaveAttribute('href', /plan/);
    const button = packet.getByRole('button', { name: 'Prepare packet' });
    await expect(button).toBeDisabled();
    await expect(button).not.toHaveClass(/\bpri\b/);
    const bg = await button.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgb(63, 207, 174)');
  });

  test('prepare shows a spinner, then the packet and a download', { tag: '@ap-ac2' }, async ({ page }) => {
    await page.route('**/api/advisor/packets', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.continue();
    });
    await gotoRoute(page, 'advisor');
    const button = page.getByRole('button', { name: 'Prepare packet' });
    const downloadPromise = page.waitForEvent('download');
    await button.click();
    await expect(page.locator('.h-spin')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Preparing' })).toHaveAttribute('aria-busy', 'true');
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^advisor-packet-\d{4}-\d{2}-\d{2}\.html$/);
    await expect(page.getByRole('status')).toContainText('Packet ready.');
    const again = page.getByRole('link', { name: 'Download again' });
    await expect(again).toBeVisible();
    const [second] = await Promise.all([page.waitForEvent('download'), again.click()]);
    expect(second.suggestedFilename()).toBe(download.suggestedFilename());
  });

  test('a 409 from the packet API is shown', { tag: '@ap-ac2' }, async ({ page }) => {
    await page.route('**/api/advisor/packets', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'nothing is waiting on review' }) });
    });
    await gotoRoute(page, 'advisor');
    await page.getByRole('button', { name: 'Prepare packet' }).click();
    await expect(page.locator('.h-adv-status')).toContainText('nothing is waiting on review');
  });

  test('a 500 from the packet API is shown', { tag: '@ap-ac2' }, async ({ page }) => {
    await page.route('**/api/advisor/packets', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'the packet could not be stored' }) });
    });
    await gotoRoute(page, 'advisor');
    await page.getByRole('button', { name: 'Prepare packet' }).click();
    await expect(page.locator('.h-adv-status')).toContainText('the packet could not be stored');
  });

  test('a failed verdict is shown on the form', { tag: '@ap-ac3' }, async ({ page }) => {
    await page.route('**/api/advisor/reviews/*/verdict', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'could not record the verdict' }) });
    });
    await gotoRoute(page, 'advisor');
    const row = page.locator('ul.h-advws > li').first();
    await row.getByRole('button', { name: 'Record verdict' }).click();
    const form = row.locator('form.h-advf');
    await form.getByLabel('Confirmed').check();
    await form.getByRole('button', { name: 'Save verdict' }).click();
    await expect(form.getByRole('alert')).toContainText('could not record the verdict');
    await expect(form).toBeVisible();
  });

  test('a failed check-in is shown on the form', { tag: '@ap-ac3' }, async ({ page }) => {
    await page.route('**/api/advisor/checkin', (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'could not save the check-in' }) });
    });
    await gotoRoute(page, 'advisor');
    await page.getByRole('button', { name: 'Change check-in' }).click();
    const form = page.locator('form.h-advci');
    await form.getByLabel('Date').fill('2026-12-17');
    await form.getByRole('button', { name: 'Save check-in' }).click();
    await expect(form.getByRole('alert')).toContainText('could not save the check-in');
    await expect(form).toBeVisible();
  });
});
