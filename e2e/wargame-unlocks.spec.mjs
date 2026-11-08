// H3: a war game the planner could not build sits beside the control that unlocks it. beforeAll
// builds the synthetic household without its S corp in an owned temporary store, plans through the
// scheduler with no engine and starts a real-mode server in process on a port of its own. The
// salary card names the missing input and its one control opens the profit and loss upload.
// Skipped when BASE_URL targets a remote server.

import { test, expect } from './helpers.mjs';
import { createLocalData, removeLocalData, startEnrolledServer } from './local-store.mjs';

let DIR;
const CLOCK = '2026-11-05';
const REMOTE = !!(process.env.BASE_URL || process.env.FATHOM_SMOKE_BASE_URL);

let app = null;
let base = '';

test.describe('a war game that could not be built shows its unlock', () => {
  test.skip(REMOTE, 'needs a local real-mode server; BASE_URL targets a remote one');
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(async ({ context }) => {
    await app.authenticate(context);
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({
      status: 200, body: '', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
    }));
  });

  test.beforeAll(async () => {
    const { buildRealStore, SOLE_PROP } = await import('../test/helpers/real-store.mjs');
    const { planRun } = await import('../test/helpers/plan.mjs');
    DIR = createLocalData('wargame-unlocks');
    const db = await buildRealStore(DIR, { clock: CLOCK, variant: { entities: [SOLE_PROP] } });
    try {
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

  test('the salary card names the missing S corp and its control opens the profit and loss upload', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/#/plan`);
    await expect(page.locator('header.h-top')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Decisions', exact: true })).toBeVisible();
    const card = page.locator('article.h-dec.unbuilt[data-not-built="salary"]');
    await expect(card).toBeVisible();
    await expect(card.locator('p')).toHaveText('Salary war game needs an S corp with profit on file.');
    const control = card.getByRole('button', { name: 'Upload the S corp profit and loss' });
    await expect(control).toBeVisible();
    await expect(card.locator('a[data-go="add"]')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('wargame-unlock-card.png'), fullPage: true });
    const chooser = page.waitForEvent('filechooser');
    await control.click();
    const opened = await chooser;
    expect(await opened.element().getAttribute('accept')).toBe('.xlsx,.csv');
    await expect(page).toHaveURL(/#\/add$/);
    await expect(page.locator('[data-upload-kind="pnl"]')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
