// Every route renders with its heading, the product chrome is the Horizon shell with no review
// harness, and the brief timeline shows today with past and future. Read-only, tagged @smoke:
// against BASE_URL it never resets or mutates the target.

import { test, expect, S, REMOTE, resetDemo, mainRoutes, needsYouIds, rec, plain, gotoRoute, expectH1, mainNav, recDialog } from './helpers.mjs';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

test.describe('routes', { tag: '@smoke' }, () => {
  test.beforeEach(async ({ request }) => {
    // Locally the other specs mutate the shared demo store, so start from the seed. A remote
    // target is a fresh server and is never reset.
    if (!REMOTE) await resetDemo(request);
  });

  test('healthz reports ok and the schema version', async ({ request }) => {
    const res = await request.get('/healthz');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Number.isInteger(body.schema) && body.schema >= 1).toBe(true);
  });

  for (const [route, heading] of mainRoutes()) {
    test(`#/${route} renders its heading`, async ({ page }) => {
      await gotoRoute(page, route);
      await expectH1(page, heading);
      await expect(recDialog(page)).toHaveCount(0);
    });
  }

  test('#/packs/<first pack> renders the pack', async ({ page }) => {
    const p = S.packs[0];
    await gotoRoute(page, `packs/${p.id}`);
    await expectH1(page, plain(p.name));
  });

  test('#/rec/<first needs-you rec> opens the rec dialog', async ({ page }) => {
    const id = needsYouIds()[0];
    await gotoRoute(page, `rec/${id}`);
    await expect(recDialog(page)).toBeVisible();
    await expectH1(page, plain(rec(id).title));
  });

  test('shell: no harness bar, top menu, More menu groups, logo mark', async ({ page, request }) => {
    await gotoRoute(page, 'brief');
    await expect(page.locator('.fx-harness')).toHaveCount(0);

    await expect(mainNav(page).getByRole('link')).toHaveText(['Year', /^Confirm\d*$/, 'Plan', 'Decide', 'Ask', 'Packs']);

    const more = page.getByRole('button', { name: 'More', exact: true });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#h-more-p')).toBeHidden();
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    const panel = page.locator('#h-more-p');
    await expect(panel).toBeVisible();
    const groups = panel.locator('.h-more-g');
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(0).locator('.h-more-h')).toHaveText('Household');
    await expect(groups.nth(0).getByRole('link')).toHaveText(['Goals', 'Accounts', 'Advisor', 'Year end']);
    await expect(groups.nth(1).locator('.h-more-h')).toHaveText('System');
    await expect(groups.nth(1).getByRole('link')).toHaveText(['Connect', 'Engine', 'Email']);

    await groups.nth(1).getByRole('link', { name: 'Engine', exact: true }).click();
    await expect(page).toHaveURL(/#\/engine$/);
    await expect(page.locator('#h-more-p')).toBeHidden();

    const mark = page.getByRole('link', { name: plain(S.meta.product), exact: true });
    await expect(mark).toHaveClass(/\bh-mark\b/);
    await expect(mark.locator('svg.h-mark-g')).toBeVisible();

    const icon = page.locator('link[rel~="icon"]');
    await expect(icon).toHaveCount(1);
    const href = await icon.getAttribute('href');
    const res = await request.get(new URL(href, page.url()).href);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('<svg');
  });

  test('brief timeline: Today line, months before and after now, positioned items', async ({ page }) => {
    await gotoRoute(page, 'brief');
    const tl = page.locator('.h-tl[data-tl="brief"]');
    await expect(tl).toBeVisible();

    await expect(tl.locator('.h-tl-now-lab')).toContainText('Today');
    await expect(tl.locator('line.h-tl-now')).toHaveCount(1);

    const months = await tl.locator('text.h-tl-mon').evaluateAll((els) => els.map((e) => ({ t: e.textContent.trim(), cur: e.classList.contains('cur') })));
    const cur = months.findIndex((m) => m.cur);
    const clockMonth = MON[Number(S.meta.clock.slice(5, 7)) - 1];
    expect(cur, 'a current month label').toBeGreaterThanOrEqual(0);
    expect(months[cur].t).toBe(clockMonth);
    expect(cur, 'month labels before the current month').toBeGreaterThan(0);
    expect(months.length - 1 - cur, 'month labels after the current month').toBeGreaterThan(0);

    // Horizon positions timeline items with style attributes; CSP must allow them (pinned 14).
    const nowLeft = await tl.locator('.h-tl-now-lab').evaluate((el) => parseFloat(getComputedStyle(el).left));
    expect(nowLeft).toBeGreaterThan(0);
    const lefts = await tl.locator('.h-tl-rec').evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).left)));
    expect(lefts.length).toBeGreaterThan(0);
    expect(lefts.some((x) => Number.isFinite(x) && x > 0), `timeline item lefts ${lefts.join(',')}`).toBe(true);
  });
});
