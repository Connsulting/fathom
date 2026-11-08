// Chart labels keep their proportions at every width. An svg with preserveAspectRatio="none"
// stretches to its box, so any <text> inside it stretches too; labels live in HTML instead.

import { test, expect, resetDemo, gotoRoute, recDialog } from './helpers.mjs';

const ID = 'a_biz';
const WIDTHS = [360, 768, 1280];

// Counts <text> inside stretched svgs and measures the given HTML labels against canvas text of
// the same string and font. getAttribute keeps the svg attribute's case, unlike some selectors.
function audit(page, labelSelector) {
  return page.evaluate(async (sel) => {
    await document.fonts.ready;
    const stretched = [...document.querySelectorAll('svg')]
      .filter((s) => s.getAttribute('preserveAspectRatio') === 'none')
      .reduce((n, s) => n + s.querySelectorAll('text').length, 0);
    const ctx = document.createElement('canvas').getContext('2d');
    const labels = [...document.querySelectorAll(sel)].map((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      ctx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
      return { text: el.textContent, w: r.width, h: r.height, measured: ctx.measureText(el.textContent).width, inSvg: !!el.closest('svg') };
    });
    return { stretched, labels };
  }, labelSelector);
}

function expectNormalText(labels) {
  for (const l of labels) {
    expect(l.inSvg, `${l.text} is HTML`).toBe(false);
    expect(l.text.trim().length, 'label has text').toBeGreaterThan(0);
    expect(l.h, `${l.text} height`).toBeGreaterThan(0);
    expect(l.w / l.h, `${l.text} aspect`).toBeLessThan(8);
    expect(Math.abs(l.w - l.measured) / l.measured, `${l.text} width ${l.w} vs ${l.measured}`).toBeLessThan(0.25);
  }
}

// The demo store has finished onboarding; serve the scenario as a fresh one on the given step.
async function forceFresh(page, step) {
  await page.route('**/api/**', async (route) => {
    const res = await route.fetch();
    if (!String(res.headers()['content-type'] || '').includes('application/json')) return route.fulfill({ response: res });
    const body = await res.json();
    const sc = body && body.meta ? body : body && body.scenario;
    if (sc && sc.live) Object.assign(sc.live, { demo: 'fresh', onboardStep: step });
    return route.fulfill({ response: res, json: body });
  });
}

test.describe('chart labels', { tag: '@ui3-ac1' }, () => {
  test.beforeEach(async ({ request }) => { await resetDemo(request); });

  for (const width of WIDTHS) {
    test(`Money and the account dialog draw no stretched text at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await gotoRoute(page, 'money');
      expect((await audit(page, '.h-spark-x span')).stretched).toBe(0);

      await page.goto(`/#/account/${ID}`);
      const dlg = recDialog(page);
      await expect(dlg).toBeVisible();
      const spark = dlg.locator('.h-spark');
      await expect(spark).toHaveCount(1);
      await spark.scrollIntoViewIfNeeded();
      const xs = spark.locator('.h-spark-x span');
      await expect(xs).toHaveCount(2);
      await expect(xs.first()).toBeVisible();
      await expect(xs.last()).toBeVisible();
      const { stretched, labels } = await audit(page, '.h-dlg .h-spark-x span');
      expect(stretched).toBe(0);
      expect(labels).toHaveLength(2);
      expectNormalText(labels);
    });

    test(`the onboarding build rail draws no stretched text at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await forceFresh(page, 5);
      try {
        await page.goto('/#/onboarding/5');
        const months = page.locator('.h-build .h-build-x span');
        await expect(months).toHaveCount(12);
        await expect(months.first()).toBeVisible();
        const { stretched, labels } = await audit(page, '.h-build-x span');
        expect(stretched).toBe(0);
        expectNormalText(labels);
      } finally {
        await page.unrouteAll({ behavior: 'wait' });
      }
    });
  }
});
