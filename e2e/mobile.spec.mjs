// Phone width (390px, mobile project only): no horizontal page scroll on any main route, and the
// rec modal opens and closes.

import { test, expect, S, resetDemo, mainRoutes, headingFor, needsYouIds, gotoRoute, expectH1, openRecFromPage, closeDialogWithX, askOnAsk, plain, dataHealth, questionsToConfirm } from './helpers.mjs';

const TAGS = { tag: ['@mobile', '@mobile-only'] };

test.describe('mobile', TAGS, () => {
  test.beforeEach(async ({ request, page }) => {
    expect(page.viewportSize()?.width).toBe(390);
    await resetDemo(request);
  });

  for (const [route, heading] of mainRoutes()) {
    test(`#/${route} has no horizontal page scroll at 390px`, async ({ page, request }) => {
      await gotoRoute(page, route);
      await expectH1(page, await headingFor(heading, request));
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

// Phone tab bar, overflow menu, tap popovers and the home screen manifest.
const TABS = [['home', 'Home'], ['confirm', 'Confirm'], ['plan', 'Plan'], ['wargame', 'Decide'], ['ask', 'Ask']];
const OVERFLOW = ['packs', 'goals', 'accounts', 'advisor', 'yearend', 'connect', 'engine', 'email'];

test.describe('phone shell', TAGS, () => {
  test.beforeEach(async ({ request, page }) => {
    expect(page.viewportSize()?.width).toBe(390);
    await resetDemo(request);
  });

  test('the tab bar lists the main screens and the top nav is folded', async ({ page }) => {
    await gotoRoute(page, 'home');
    const tabs = page.locator('nav.h-tabs a');
    await expect(tabs).toHaveCount(TABS.length);
    for (const [i, [k, l]] of TABS.entries()) {
      await expect(tabs.nth(i)).toHaveAttribute('data-go', k);
      await expect(tabs.nth(i).locator('> span')).toContainText(l);
    }
    await expect(page.locator('.h-nav')).toBeHidden();
    await expect(page.locator('.h-search-btn')).toBeVisible();
    await expect(page.locator('.h-more-btn')).toBeVisible();
    const bar = await page.locator('nav.h-tabs').boundingBox();
    expect(Math.round(bar.y + bar.height)).toBe(844);
    for (const box of await tabs.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()))) {
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
  });

  for (const [route, label] of TABS) {
    test(`the ${label} tab navigates and nothing hides under the bar`, async ({ page }) => {
      await gotoRoute(page, route === 'home' ? 'plan' : 'home');
      await page.locator(`nav.h-tabs a[data-go="${route}"]`).click();
      await expect(page).toHaveURL(new RegExp(`#/${route}$`));
      const tab = page.locator(`nav.h-tabs a[data-go="${route}"]`);
      await expect(tab).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('main h1')).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const gap = await page.evaluate(() => {
        // The lowest rendered box in the page content, whatever element draws it.
        let lastBottom = 0;
        for (const el of document.querySelectorAll('main.h-main *')) {
          if (!el.checkVisibility()) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) lastBottom = Math.max(lastBottom, r.bottom);
        }
        return document.querySelector('nav.h-tabs').getBoundingClientRect().top - lastBottom;
      });
      expect(gap, `last element of #/${route} clears the tab bar`).toBeGreaterThanOrEqual(0);
    });
  }

  test('the Confirm tab and the top nav carry no pending badge; Home says it instead', { tag: ['@ac4'] }, async ({ page, request }) => {
    const pending = (await (await request.get('/api/confirm')).json()).items.length;
    expect(pending, 'the demo seeds pending questions').toBeGreaterThan(0);
    await gotoRoute(page, 'home');
    await expect(page.locator('nav.h-tabs a[data-go="confirm"]')).toHaveCount(1);
    await expect(page.locator('nav.h-tabs a[data-go="confirm"] > span')).toHaveText('Confirm');
    await expect(page.locator('.h-nav-n')).toHaveCount(0);
    await expect(dataHealth(page)).toContainText(questionsToConfirm(pending));
  });

  test('the overflow menu reaches the other screens', async ({ page }) => {
    for (const k of OVERFLOW) {
      await gotoRoute(page, 'home');
      await page.locator('.h-more-btn').click();
      const link = page.locator(`#h-more-p a[data-go="${k}"]`);
      await expect(link).toBeVisible();
      await link.click();
      await expect(page).toHaveURL(new RegExp(`#/${k}$`));
      await expect(page.locator('#h-more-p')).toBeHidden();
      await expect(page.locator('.h-more-btn')).toHaveClass(/\bon\b/);
    }
  });

  test('a tap opens a figure popover, a tap outside and Escape close it', async ({ page }) => {
    // A suggested question whose canned answer carries a figure.
    const q = S.ask.suggested.find((x) => (x.a || []).some((p) => /\{fk?:[A-Za-z0-9_]+\}/.test(p)));
    await gotoRoute(page, 'ask');
    await askOnAsk(page, plain(q.q));
    const fig = page.locator('.h-thread .h-msg:not(.me) .fx-fig').first();
    await expect(fig).toBeVisible();
    await fig.tap();
    await expect(page.locator('.fx-pop')).toBeVisible();
    await page.locator('.h-thread .h-msg.me').first().tap();
    await expect(page.locator('.fx-pop')).toHaveCount(0);
    await fig.tap();
    await expect(page.locator('.fx-pop')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.fx-pop')).toHaveCount(0);
  });

  test('the home screen manifest and icons are served', async ({ page, request }) => {
    await gotoRoute(page, 'home');
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    const res = await request.get(href);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('application/manifest+json');
    const m = await res.json();
    expect(m).toMatchObject({ name: 'Fathom', short_name: 'Fathom', display: 'standalone', start_url: '/' });
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
    for (const src of [apple, ...m.icons.map((i) => i.src)]) {
      const r = await request.get(src);
      expect(r.status(), src).toBe(200);
      expect(r.headers()['content-type']).toBe('image/png');
    }
  });
});
