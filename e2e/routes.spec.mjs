// Every route renders with its heading, the product chrome is the Horizon shell with no review
// harness, and the Plan timeline shows today with past and future and the What changed dots. Read-only, tagged @smoke:
// against a base URL it never resets or mutates the target.
//
// FATHOM_SMOKE_TARGET=real (default demo) swaps the demo-scenario assertions for checks that hold
// on any real store: shell and a heading, empty states, the nav and the quick switcher, and
// provenance markup on figures that render. Real mode also aborts any non-GET/HEAD request to
// the app origin.

import { test, expect, S, REMOTE, SMOKE_REAL, resetDemo, mainRoutes, headingFor, needsYouIds, rec, plain, gotoRoute, expectH1, mainNav, recDialog } from './helpers.mjs';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Routes whose heading is product chrome, not a row from the demo scenario.
const REAL_ROUTES = [
  'home', 'pace', 'plan', 'ask', 'wargame', 'wargame/salary', 'wargame/deferral',
  'goals', 'accounts', 'pnl', 'advisor', 'yearend', 'connect', 'engine', 'email', 'packs', 'money', 'settings', 'memories'
];

test.describe('routes', { tag: '@smoke' }, () => {
  test.skip(SMOKE_REAL && !process.env.FATHOM_SMOKE_STORAGE_STATE, 'authenticated real-store smoke requires supplied storageState');
  test.beforeEach(async ({ request }) => {
    // Locally the other specs mutate the shared demo store, so start from the seed. A remote
    // target is never reset. Real mode never reaches this reset: the shared fixture aborts writes.
    if (!SMOKE_REAL && !REMOTE) await resetDemo(request);
  });

  test('healthz reports ok and the schema version', async ({ request }) => {
    const res = await request.get('/healthz');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Number.isInteger(body.schema) && body.schema >= 1).toBe(true);
  });

  if (!SMOKE_REAL) {
    for (const [route, heading] of mainRoutes()) {
      test(`#/${route} renders its heading`, async ({ page, request }) => {
        await gotoRoute(page, route);
        await expectH1(page, await headingFor(heading, request));
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
  } else {
    for (const route of REAL_ROUTES) {
      test(`#/${route} renders its shell and a heading`, async ({ page }) => {
        await gotoRoute(page, route);
        await expect(page.locator('header.h-top')).toBeVisible();
        const h1 = page.getByRole('heading', { level: 1 }).first();
        await expect(h1).toBeVisible();
        await expect(h1).not.toHaveText(/^\s*$/);
        await expectProvenance(page);
      });
    }

    test('Decide with nothing open shows the empty state or the decision list', async ({ page }) => {
      await gotoRoute(page, 'wargame');
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      const rows = page.locator('article.h-dec');
      if (await rows.count()) await expect(rows.first()).toBeVisible();
      else await expect(page.getByText('Nothing is waiting on a decision.')).toBeVisible();
    });

    test('a missing war game stays on Decide instead of crashing', async ({ page }) => {
      await gotoRoute(page, 'wargame/salary');
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await expect(page.locator('header.h-top')).toBeVisible();
    });

    test('#/packs opens a pack when the list has one', async ({ page }) => {
      await gotoRoute(page, 'packs');
      await expect(page.getByRole('heading', { level: 1, name: 'What Fathom knows' })).toBeVisible();
      const link = page.locator('main a[href*="#/packs/"]').first();
      if (await link.count()) {
        await link.click();
        await expect(page).toHaveURL(/#\/packs\/[^/]+$/);
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        await expectProvenance(page);
      } else {
        await expect(page.locator('main')).toBeVisible();
      }
    });

    test('a plan rec opens its dialog, or the plan shows the empty state', async ({ page }) => {
      await gotoRoute(page, 'plan');
      const link = page.locator('main a[data-go="rec"]').first();
      if (await link.count()) {
        await link.click();
        await expect(recDialog(page)).toBeVisible();
        await expect(recDialog(page).getByRole('heading', { level: 1 })).toBeVisible();
        await expectProvenance(page);
      } else {
        await expect(page.getByText('No recommendations yet.')).toBeVisible();
      }
    });
  }

  test('shell: no harness bar, four tabs, the gear opens the Settings page, logo mark', async ({ page, request }) => {
    await gotoRoute(page, 'home');
    await expect(page.locator('.fx-harness')).toHaveCount(0);

    // Four tabs, Home first; no count badge anywhere in the nav (Home's data-health line counts).
    await expect(mainNav(page).getByRole('link')).toHaveText(['Home', 'Plan', 'Ask', 'Money']);
    await expect(page.locator('.h-nav-n')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'More', exact: true })).toHaveCount(0);
    await expect(page.locator('.h-more-btn, #h-more-p')).toHaveCount(0);

    const gear = page.locator('header.h-top a.h-gear');
    await expect(gear).toBeVisible();
    await expect(gear).toHaveAccessibleName('Settings');
    await gear.click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expectH1(page, 'Settings');
    await expect(gear).toHaveAttribute('aria-current', 'page');
    const panel = page.locator('section.h-settings');
    await expect(panel).toBeVisible();
    if (SMOKE_REAL) {
      for (const name of ['Connect', 'Engine', 'Email', 'Setup', 'Account']) {
        await expect(panel.getByRole('link', { name, exact: true })).toBeVisible();
      }
      const { identity } = await (await request.get('/api/identity')).json();
      await expect(panel.getByRole('link', { name: 'Household', exact: true })).toHaveCount(identity.role === 'admin' ? 1 : 0);
    } else {
      for (const name of ['Connect', 'Engine', 'Email']) {
        await expect(panel.getByRole('link', { name, exact: true })).toBeVisible();
      }
      for (const name of ['Setup', 'Account', 'Household']) {
        await expect(panel.getByRole('link', { name, exact: true })).toHaveCount(0);
      }
    }

    await panel.getByRole('link', { name: 'Engine', exact: true }).click();
    await expect(page).toHaveURL(/#\/engine$/);

    const mark = SMOKE_REAL
      ? page.locator('a.h-mark')
      : page.getByRole('link', { name: plain(S.meta.product), exact: true });
    await expect(mark).toHaveClass(/\bh-mark\b/);
    await expect(mark.locator('svg.h-mark-g')).toBeVisible();
    await expect(mark).toHaveAttribute('data-go', 'home');

    const icon = page.locator('link[rel~="icon"]');
    await expect(icon).toHaveCount(1);
    const href = await icon.getAttribute('href');
    const res = await request.get(new URL(href, page.url()).href);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('<svg');
  });

  test('nav stays put and Ctrl+K opens the switcher', async ({ page }) => {
    test.skip(!SMOKE_REAL, 'demo smoke covers the nav inside the shell test');
    await gotoRoute(page, 'home');
    await expect(mainNav(page)).toBeVisible();
    await page.keyboard.press('Control+k');
    const qs = page.getByRole('dialog', { name: 'Quick switcher' });
    await expect(qs).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(qs).toBeHidden();
  });

  test('Plan timeline: Today line, months before and after now, positioned items, past event dots', { tag: ['@ac5'] }, async ({ page }) => {
    // The year timeline moved from Home to Plan; Home has none.
    await gotoRoute(page, 'home');
    await expect(page.locator('section.h-home')).toBeVisible();
    await expect(page.locator('.h-tl')).toHaveCount(0);

    await gotoRoute(page, 'plan');
    const tl = page.locator('.h-tl[data-tl="plan"]');
    await expect(tl).toBeVisible();

    await expect(tl.locator('.h-tl-now-lab')).toContainText('Today');
    await expect(tl.locator('line.h-tl-now')).toHaveCount(1);

    const months = await tl.locator('text.h-tl-mon').evaluateAll((els) => els.map((e) => ({ t: e.textContent.trim(), cur: e.classList.contains('cur') })));
    const cur = months.findIndex((m) => m.cur);
    expect(cur, 'a current month label').toBeGreaterThanOrEqual(0);
    expect(months.length).toBeGreaterThan(1);

    const nowLeft = await tl.locator('.h-tl-now-lab').evaluate((el) => parseFloat(getComputedStyle(el).left));
    expect(nowLeft).toBeGreaterThan(0);

    if (!SMOKE_REAL) {
      const clockMonth = MON[Number(S.meta.clock.slice(5, 7)) - 1];
      expect(months[cur].t).toBe(clockMonth);
      expect(cur, 'month labels before the current month').toBeGreaterThan(0);
      expect(months.length - 1 - cur, 'month labels after the current month').toBeGreaterThan(0);

      // Horizon positions timeline items with style attributes; CSP must allow them (pinned 14).
      const lefts = await tl.locator('.h-tl-rec').evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).left)));
      expect(lefts.length).toBeGreaterThan(0);
      expect(lefts.some((x) => Number.isFinite(x) && x > 0), `timeline item lefts ${lefts.join(',')}`).toBe(true);

      // What changed events on or before the clock are dots on the axis, as the brief timeline had.
      const clock = Date.parse(S.meta.clock + 'T00:00:00Z');
      const year = Number(S.meta.clock.slice(0, 4));
      const past = (S.events || []).filter((e) => {
        const [mon, day] = String(e.date).split(' ');
        const at = Date.UTC(year, MON.indexOf(mon), Number(day));
        return Number.isFinite(at) && at <= clock;
      });
      expect(past.length, 'the demo has past events').toBeGreaterThan(0);
      await expect(tl.locator('circle.h-tl-ev')).toHaveCount(past.length);
    }
  });
});

async function expectProvenance(page) {
  const bare = await page.locator('.fx-fig').evaluateAll((els) => els
    .filter((el) => !el.getAttribute('data-fig'))
    .map((el) => (el.textContent || '').trim().slice(0, 80)));
  expect(bare, 'figure missing data-fig').toEqual([]);
}
