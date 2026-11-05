// Phone width (390px, mobile project only): no horizontal page scroll on any main route, and the
// rec modal opens and closes.

import { test, expect, resetDemo, mainRoutes, needsYouIds, gotoRoute, expectH1, openRecFromPage, closeDialogWithX } from './helpers.mjs';

const TAGS = { tag: ['@mobile', '@mobile-only'] };

test.describe('mobile', TAGS, () => {
  test.beforeEach(async ({ request, page }) => {
    expect(page.viewportSize()?.width).toBe(390);
    await resetDemo(request);
  });

  for (const [route, heading] of mainRoutes()) {
    test(`#/${route} has no horizontal page scroll at 390px`, async ({ page }) => {
      await gotoRoute(page, route);
      await expectH1(page, heading);
      const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, inner: window.innerWidth }));
      expect(widths.inner).toBe(390);
      expect(widths.doc, `documentElement.scrollWidth on #/${route}`).toBeLessThanOrEqual(390);
      expect(widths.body, `body.scrollWidth on #/${route}`).toBeLessThanOrEqual(390);
    });
  }

  test('the rec modal opens and closes from Plan', async ({ page }) => {
    await gotoRoute(page, 'plan');
    await openRecFromPage(page, needsYouIds()[0]);
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
    await closeDialogWithX(page);
    await expect(page).toHaveURL(/#\/plan$/);
    await expectH1(page, 'Everything on the calendar');
  });
});
