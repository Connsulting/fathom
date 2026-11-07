// Real-mode polish, end to end through the UI on a real-mode server built in process: Accounts
// trend lines from uploaded balances, plain "what changed" titles, the Engine screen's model per
// purpose, Decide on this and Revisit on the salary war game, and Files in the switcher and the
// More menu. Runs at desktop and at 390px (every test carries @mobile). Skipped against a remote
// server.

import { test, expect, expectPopoverSource } from './helpers.mjs';
import { createLocalData, removeLocalData, startEnrolledServer } from './local-store.mjs';

let DIR;
const CLOCK = '2026-11-05';
const REMOTE = !!(process.env.BASE_URL || process.env.FATHOM_SMOKE_BASE_URL);

let app = null;
let base = '';

async function fetchScenario() {
  const res = await fetch(`${base}/api/scenario`, { headers: app.headers });
  expect(res.status).toBe(200);
  return res.json();
}

async function go(page, route) {
  await page.goto(`${base}/#/${route}`);
  await expect(page.locator('header.h-top')).toBeVisible();
}

test.describe('real-mode polish', () => {
  test.skip(REMOTE, 'needs a local real-mode server; BASE_URL targets a remote one');
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(async ({ context }) => {
    await app.authenticate(context);
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({
      status: 200, body: '', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
    }));
  });

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    const { buildRealStore } = await import('../test/helpers/real-store.mjs');
    const { planRun } = await import('../test/helpers/plan.mjs');

    DIR = createLocalData('real-polish');
    const db = await buildRealStore(DIR, { clock: CLOCK });
    try {
      // Three months of balances for the two first accounts so trend lines have something to draw.
      const ids = db.prepare('SELECT id FROM accounts ORDER BY sort, id LIMIT 2').all().map((r) => r.id);
      db.exec('DELETE FROM balances');
      const put = db.prepare('INSERT INTO balances (account_id, date, amount) VALUES (?, ?, ?)');
      ids.forEach((id, k) => {
        [['2026-08-31', 1000], ['2026-09-30', 1250], ['2026-10-31', 1500]].forEach(([d, v]) => put.run(id, d, v * (k + 1)));
      });
      const result = await planRun(db, { now: CLOCK, dataDir: DIR });
      expect(result.status).toBe('ok');
    } finally {
      db.close();
    }
    app = await startEnrolledServer({ dataDir: DIR, clock: CLOCK });
    base = app.url;
  });

  test.afterAll(async () => {
    if (app) await app.close();
    app = null;
    removeLocalData(DIR);
  });

  test('@mobile Accounts draws a trend line per account and for net worth, from uploaded balances', async ({ page }) => {
    const sc = await fetchScenario();
    const keys = Object.keys(sc.series);
    expect(keys[0]).toBe('net');
    expect(keys.length).toBeGreaterThanOrEqual(3);
    await go(page, 'accounts');
    await expect(page.locator('.h-sparks .h-spark')).toHaveCount(keys.length);
    await expect(page.locator('.h-spark[data-series="net"] svg polyline.a')).toHaveCount(1);
    await expect(page.locator('.h-spark[data-series="net"] svg text').first()).toHaveText('Aug 2026');
    // The last point is a figure that opens its provenance.
    await page.locator('.h-spark[data-series="net"] .fx-fig').click();
    await expectPopoverSource(page, 'Account balances you uploaded');
    const widths = await page.evaluate(() => ({ inner: window.innerWidth, doc: document.documentElement.scrollWidth }));
    expect(widths.doc).toBeLessThanOrEqual(widths.inner);
  });

  test('@mobile What changed and Detected use plain titles, never a raw fact key', async ({ page }) => {
    const sc = await fetchScenario();
    expect(sc.events.length).toBeGreaterThan(0);
    for (const e of sc.events) expect(e.title, e.title).not.toMatch(/^[a-z]+\.[A-Za-z0-9.]+ changed$/);
    await go(page, 'brief');
    const titles = await page.locator('.h-evs li b').allTextContents();
    expect(titles.length).toBeGreaterThan(0);
    for (const t of titles) expect(t).not.toMatch(/\b[a-z]+\.[A-Za-z0-9]+ changed\b/);
    if (sc.events.some((e) => e.title === 'S corp income detected')) {
      await expect(page.locator('.h-evs li b', { hasText: 'S corp income detected' })).toBeVisible();
    }
  });

  test('@mobile Engine lists the model for every purpose', async ({ page }) => {
    const sc = await fetchScenario();
    await go(page, 'engine');
    const list = page.locator('ul.h-eng-models');
    await expect(list).toBeVisible();
    await expect(list.locator('li')).toHaveCount(5);
    for (const { purpose, model } of sc.engine.models) {
      await expect(list.locator(`li[data-purpose="${purpose}"] b`)).toHaveText(model);
    }
  });

  test('@mobile Decide on this decides the picked salary point and Revisit reopens it', async ({ page }) => {
    const before = await fetchScenario();
    const game = before.wargame.salary;
    const index = game.points.findIndex((p) => !p.current);
    expect(index).toBeGreaterThanOrEqual(0);
    await go(page, 'wargame/salary');
    await expect(page.locator('.h-decided')).toHaveCount(0);
    await page.locator(`g.h-sc-pt[data-i="${index}"]`).dispatchEvent('click');
    await expect(page.locator(`g.h-sc-pt.on[data-i="${index}"]`)).toHaveCount(1);
    await page.getByRole('button', { name: 'Decide on this' }).click();
    const lead = page.locator('.h-decided');
    await expect(lead.locator('.h-kicker')).toHaveText('Decided');
    await expect(lead.locator('p .fx-fig').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Decide on this' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Revisit' })).toBeVisible();

    const decided = await fetchScenario();
    const d = decided.decisions.find((x) => x.id === 'salary-2026');
    expect(d.status).toBe('decided');
    expect(d.line).toContain(`wg.salary.${game.points[index].id}.`);

    await go(page, 'wargame');
    await page.locator('details.h-details[data-det="decided"] summary').click();
    await expect(page.locator('article.h-dec.decided')).toHaveCount(1);

    await go(page, 'wargame/salary');
    await page.getByRole('button', { name: 'Revisit' }).click();
    await expect(page.locator('.h-decided')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Decide on this' })).toBeVisible();
    const reopened = await fetchScenario();
    expect(reopened.decisions.find((x) => x.id === 'salary-2026').status).toBe('open');
  });

  test('@mobile Files is in the quick switcher and in the More menu', async ({ page }) => {
    await go(page, 'brief');
    await page.keyboard.press('Control+k');
    const input = page.locator('.h-qs-host input.h-qs-in');
    await expect(input).toBeVisible();
    await input.fill('files');
    const row = page.locator('#h-qs-list li.h-qs-o[data-qs-key="go:add"]');
    await expect(row.locator('.h-qs-t')).toHaveText('Files');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/add$/);

    await go(page, 'brief');
    await page.locator('.h-more-btn').click();
    const link = page.locator('.h-more-p a[data-go="add"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveText('Files');
    await link.click();
    await expect(page).toHaveURL(/#\/add$/);
  });
});
