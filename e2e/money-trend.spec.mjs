// Money opens with one household trend: net worth over time with its parts toggled on and off, a
// range control, a hover or tap readout and aggregate figures that list the accounts they sum. The
// per-account sparkline wall is gone from Money; Accounts has one line per group heading. Demo data
// first (desktop and 390px), then a real-mode store with an account whose data stopped.
// Tags: @mt-ac1 chart, range, parts, readout, provenance and the carried span; @mt-ac3 no wall,
// group lines, account trend in the dialog; @mt-ac4 phone width.

import { test, expect, gotoRoute, expectPopoverSource } from './helpers.mjs';
import { createLocalData, removeLocalData, startEnrolledServer } from './local-store.mjs';

const xLabels = (page) => page.locator('[data-trend] .tr-x').allTextContents();
const readout = (page) => page.locator('[data-trend-read]');
const lineCount = (page, id) => page.locator(`[data-trend] .tr-l.tr-c-${id}`).count();

async function hoverAt(page, fraction) {
  const hit = page.locator('[data-trend-hit]');
  const box = await hit.boundingBox();
  await page.mouse.move(box.x + box.width * fraction, box.y + box.height / 2);
}

test.describe('Money household trend, demo data', () => {
  test('@mt-ac1 @mobile Money shows one net worth chart with the current value as a figure that lists its accounts', async ({ page, request }) => {
    await gotoRoute(page, 'money');
    await expect(page.locator('[data-trend]')).toHaveCount(1);
    await expect(page.locator('[data-trend] .tr-svg')).toHaveCount(1);
    expect(await lineCount(page, 'total')).toBeGreaterThan(0);

    const sc = await (await request.get('/api/scenario')).json();
    const t = sc.trend;
    expect(t.points.length).toBeGreaterThanOrEqual(4);
    const total = sc.fig[t.fig.total];
    expect(total.sums.length).toBeGreaterThan(5);
    const sum = Math.round(total.sums.reduce((s, a) => s + a.v, 0) * 100) / 100;
    expect(sum).toBe(total.v);
    for (const p of t.parts) {
      const f = sc.fig[t.fig.parts[p.id]];
      expect(f.sums.length, p.id).toBeGreaterThan(0);
      expect(Math.round(f.sums.reduce((s, a) => s + a.v, 0) * 100) / 100, p.id).toBe(f.v);
    }

    await page.locator('[data-trend-total] .fx-fig').click();
    await expectPopoverSource(page, 'Account balances, summed');
    const rows = page.locator('.fx-pop .fx-pop-sums .fx-pop-row');
    await expect(rows).toHaveCount(total.sums.length);
    await expect(rows.first()).toContainText(/\$[\d,]+, 20\d\d-\d\d-\d\d/);
    await page.keyboard.press('Escape');

    // Each part has its own current value as a figure.
    for (const p of t.parts) await expect(page.locator(`[data-part="${p.id}"] .fx-fig`)).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath('money-trend.png'), fullPage: false });
  });

  test('@mt-ac1 @mobile the range control changes the x-axis and the line', async ({ page }) => {
    await gotoRoute(page, 'money');
    await expect(page.locator('[data-trend-range="1Y"]')).toHaveAttribute('aria-pressed', 'true');
    const year = await xLabels(page);
    const yearLine = await page.locator('[data-trend] .tr-l.total').first().getAttribute('points');
    await page.locator('[data-trend-range="3M"]').click();
    await expect(page.locator('[data-trend-range="3M"]')).toHaveAttribute('aria-pressed', 'true');
    const quarter = await xLabels(page);
    expect(quarter[0]).not.toBe(year[0]);
    expect(quarter[0]).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    expect(quarter.at(-1)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    expect(await page.locator('[data-trend] .tr-l.total').first().getAttribute('points')).not.toBe(yearLine);
    await page.locator('[data-trend-range="All"]').click();
    const all = await xLabels(page);
    expect(all[0]).toMatch(/^[A-Z][a-z]{2} 20\d\d$/);
    expect(all.at(-1)).toBe(year.at(-1));
  });

  test('@mt-ac1 @mobile a part toggles on and off, and the last line cannot be turned off', async ({ page }) => {
    await gotoRoute(page, 'money');
    const cash = page.locator('[data-trend-part="cash"]');
    await expect(cash).toHaveAttribute('aria-pressed', 'false');
    expect(await lineCount(page, 'cash')).toBe(0);
    await cash.click();
    await expect(page.locator('[data-trend-part="cash"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await lineCount(page, 'cash')).toBeGreaterThan(0);
    await expect(readout(page)).toContainText('Cash');
    await expect(readout(page)).toContainText('Net worth');
    await page.locator('[data-trend-part="total"]').click();
    expect(await lineCount(page, 'total')).toBe(0);
    await expect(readout(page)).not.toContainText('Net worth');
    await page.locator('[data-trend-part="cash"]').click();
    await expect(page.locator('[data-trend-part="cash"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await lineCount(page, 'cash')).toBeGreaterThan(0);
  });

  test('@mt-ac1 hover shows the date and each shown part\'s value, and the keys move it', async ({ page }) => {
    await gotoRoute(page, 'money');
    await page.locator('[data-trend-part="retirement"]').click();
    const last = await readout(page).innerText();
    await hoverAt(page, 0.05);
    await expect(readout(page)).not.toHaveText(last);
    const text = await readout(page).innerText();
    expect(text).toMatch(/[A-Z][a-z]{2} \d{1,2}, 20\d\d/);
    expect(text).toContain('Net worth');
    expect(text).toContain('Retirement');
    expect((text.match(/\$[\d,]+/g) || []).length).toBe(2);
    const guide = await page.locator('[data-trend-guide]').getAttribute('x1');
    await hoverAt(page, 0.95);
    expect(await page.locator('[data-trend-guide]').getAttribute('x1')).not.toBe(guide);
    await page.locator('[data-trend-hit]').focus();
    const before = await readout(page).innerText();
    await page.keyboard.press('ArrowLeft');
    await expect(readout(page)).not.toHaveText(before);
    await page.keyboard.press('Home');
    const first = await readout(page).locator('time').getAttribute('datetime');
    await page.keyboard.press('End');
    expect(await readout(page).locator('time').getAttribute('datetime')).not.toBe(first);
  });

  test('@mt-ac3 @mobile Money has no per-account sparkline wall; Accounts has one line per group heading', async ({ page, request }) => {
    await gotoRoute(page, 'money');
    await expect(page.locator('[data-trend]')).toBeVisible();
    await expect(page.locator('.h-spark')).toHaveCount(0);
    await expect(page.locator('.h-sparks')).toHaveCount(0);
    await expect(page.locator('[data-group-trend]')).toHaveCount(0);
    await expect(page.locator('[data-account]').first()).toBeVisible();

    const sc = await (await request.get('/api/scenario')).json();
    await gotoRoute(page, 'accounts');
    await expect(page.locator('[data-trend]')).toHaveCount(0);
    await expect(page.locator('.h-spark')).toHaveCount(0);
    const groups = page.locator('[data-group-trend]');
    await expect(groups).toHaveCount(sc.trend.groups.length);
    for (const g of sc.trend.groups) {
      const line = page.locator(`[data-group-trend="${g.id}"]`);
      await expect(line.locator('svg polyline')).not.toHaveCount(0);
      await expect(line.locator('.fx-fig')).toHaveCount(1);
      await expect(line.locator('xpath=ancestor::section[1]//h2')).toHaveText(g.id);
    }
    const widths = await page.evaluate(() => ({ inner: window.innerWidth, doc: document.documentElement.scrollWidth }));
    expect(widths.doc).toBeLessThanOrEqual(widths.inner);
  });

  test('@mt-ac4 @mobile the chart fills the width and the range and part controls stay reachable', async ({ page }) => {
    await gotoRoute(page, 'money');
    const plot = await page.locator('[data-trend] .tr-plot').boundingBox();
    const svg = await page.locator('[data-trend] .tr-svg').boundingBox();
    expect(svg.width).toBeGreaterThanOrEqual(plot.width - 1);
    const vw = page.viewportSize().width;
    expect(plot.x).toBeGreaterThanOrEqual(0);
    expect(plot.x + plot.width).toBeLessThanOrEqual(vw);
    if (vw < 700) expect(svg.width).toBeGreaterThanOrEqual(vw - 48);
    for (const sel of ['[data-trend-range="3M"]', '[data-trend-range="1Y"]', '[data-trend-range="All"]', '[data-trend-part="total"]', '[data-trend-part="cash"]']) {
      const el = page.locator(sel);
      await el.scrollIntoViewIfNeeded();
      const b = await el.boundingBox();
      expect(b.x, sel).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, sel).toBeLessThanOrEqual(vw);
      expect(b.height, sel).toBeGreaterThanOrEqual(30);
    }
    await page.locator('[data-trend-range="3M"]').click();
    await page.locator('[data-trend-part="cash"]').click();
    await expect(page.locator('[data-trend-part="cash"]')).toHaveAttribute('aria-pressed', 'true');
    const hit = await page.locator('[data-trend-hit]').boundingBox();
    const before = await readout(page).innerText();
    if (page.viewportSize().width < 700) await page.touchscreen.tap(hit.x + hit.width * 0.1, hit.y + hit.height / 2);
    else await page.mouse.move(hit.x + hit.width * 0.1, hit.y + hit.height / 2);
    await expect(readout(page)).not.toHaveText(before);
    const widths = await page.evaluate(() => ({ inner: window.innerWidth, doc: document.documentElement.scrollWidth }));
    expect(widths.doc).toBeLessThanOrEqual(widths.inner);
    await page.screenshot({ path: test.info().outputPath('money-trend-narrow.png'), fullPage: true });
  });
});

// ---------------------------------------------------------------- an account whose data stopped

const CLOCK = '2026-11-05';
const REMOTE = !!(process.env.BASE_URL || process.env.FATHOM_SMOKE_BASE_URL);

test.describe('Money household trend, a stopped account', () => {
  test.skip(REMOTE, 'needs a local real-mode server; BASE_URL targets a remote one');
  test.describe.configure({ mode: 'serial' });
  let DIR;
  let app = null;
  let base = '';

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
    DIR = createLocalData('money-trend');
    const db = await buildRealStore(DIR, { clock: CLOCK });
    try {
      const ids = db.prepare('SELECT id FROM accounts ORDER BY sort, id LIMIT 3').all().map((r) => r.id);
      expect(ids.length).toBe(3);
      db.prepare("UPDATE accounts SET kind = 'checking' WHERE id = ?").run(ids[0]);
      db.prepare("UPDATE accounts SET kind = 'savings' WHERE id = ?").run(ids[1]);
      db.prepare("UPDATE accounts SET kind = 'credit' WHERE id = ?").run(ids[2]);
      db.exec('DELETE FROM balances; DELETE FROM positions');
      const put = db.prepare('INSERT INTO balances (account_id, date, amount) VALUES (?, ?, ?)');
      [['2026-06-30', 900], ['2026-07-31', 950], ['2026-08-31', 1000], ['2026-09-30', 1100], ['2026-10-31', 1200]].forEach(([d, v]) => put.run(ids[0], d, v));
      // The savings account stopped in August; the card is current.
      [['2026-06-30', 4000], ['2026-07-31', 4100], ['2026-08-31', 4200]].forEach(([d, v]) => put.run(ids[1], d, v));
      [['2026-06-30', 300], ['2026-07-31', 250], ['2026-08-31', 200], ['2026-09-30', 150], ['2026-10-31', 100]].forEach(([d, v]) => put.run(ids[2], d, v));
      expect((await planRun(db, { now: CLOCK, dataDir: DIR })).status).toBe('ok');
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

  test('@mt-ac1 the carried span is dashed, shaded and named, and debt is subtracted', async ({ page }) => {
    await page.goto(`${base}/#/money`);
    await expect(page.locator('[data-trend]')).toBeVisible();
    await expect(page.locator('[data-trend-note]')).toHaveText(/^Includes 1 account last updated Aug 31\./);
    await expect(page.locator('[data-trend] .tr-carry')).toHaveCount(1);
    await expect(page.locator('[data-trend] .tr-l.total.carried')).not.toHaveCount(0);
    await expect(page.locator('[data-trend] .tr-l.total:not(.carried)')).not.toHaveCount(0);
    // Net worth now: 1200 + 4200 carried - 100 owed.
    await expect(page.locator('[data-trend-total] .fx-fig')).toContainText('5,300');
    await expect(readout(page)).toContainText('1 account is carried forward here');
    await hoverAt(page, 0.02);
    await expect(readout(page)).not.toContainText('carried forward');
    await page.locator('[data-trend-total] .fx-fig').click();
    await expect(page.locator('.fx-pop .fx-pop-sums')).toContainText('carried forward');
    await expect(page.locator('.fx-pop .fx-pop-sums')).toContainText('2026-08-31');
    await page.keyboard.press('Escape');
    await page.locator('[data-trend-part="debt"]').click();
    await expect(readout(page)).toContainText('Debt');
    await expect(readout(page)).toContainText('-$100');
  });

  test('@mt-ac3 no wall on Money, and the account trend lives in the account dialog', async ({ page }) => {
    await page.goto(`${base}/#/money`);
    await expect(page.locator('[data-trend]')).toBeVisible();
    await expect(page.locator('.h-spark')).toHaveCount(0);
    await page.locator('[data-account]').first().click();
    await expect(page.locator('.h-dlg .h-spark')).toHaveCount(1);
  });
});
