// Decide on a real-mode store with no S corp: the planner cannot build the salary war game, and
// Decide says what data would unlock it, with a link to Add files. beforeAll builds the synthetic
// household without its S corp in an owned temporary store, plans through the scheduler with no engine
// and starts a real-mode server in process. Skipped when BASE_URL targets a remote server.

import { test, expect } from './helpers.mjs';
import { createLocalData, removeLocalData, startEnrolledServer } from './local-store.mjs';

let DIR;
const CLOCK = '2026-11-05';
const REMOTE = !!(process.env.BASE_URL || process.env.FATHOM_SMOKE_BASE_URL);

let app = null;
let base = '';

test.describe('Decide explains a war game that could not be built', () => {
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
    DIR = createLocalData('decide-not-built');
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

  test('the salary war game card says it needs an S corp and links to Add files', async ({ page }) => {
    await page.goto(`${base}/#/plan`);
    await expect(page.locator('header.h-top')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Decisions', exact: true })).toBeVisible();
    const card = page.locator('article.h-dec.unbuilt[data-not-built="salary"]');
    await expect(card).toBeVisible();
    await expect(card.locator('p')).toHaveText('Salary war game needs an S corp with profit on file.');
    const link = card.locator('a[data-go="add"]');
    await expect(link).toHaveText('Add files');
    await link.click();
    await expect(page).toHaveURL(/#\/add$/);
  });
});
