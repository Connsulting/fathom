// Decide on a real-mode store with no S corp: the planner cannot build the salary war game, and
// Decide says what data would unlock it, with a link to Add files. beforeAll builds the synthetic
// household without its S corp in .e2e-data-decide, plans through the scheduler with no engine
// and starts a real-mode server in process. Skipped when BASE_URL targets a remote server.

import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from './helpers.mjs';

const DIR = fileURLToPath(new URL('../.e2e-data-decide/', import.meta.url));
const CLOCK = '2026-11-05';
const REMOTE = !!process.env.BASE_URL;
const OWNER = 'owner@example.test';
const AUTH = Object.freeze({ 'Tailscale-User-Login': OWNER });

let app = null;
let base = '';

test.describe('Decide explains a war game that could not be built', () => {
  test.skip(REMOTE, 'needs a local real-mode server; BASE_URL targets a remote one');
  test.describe.configure({ mode: 'serial' });
  test.use({ extraHTTPHeaders: AUTH });
  test.beforeEach(async ({ context }) => {
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({
      status: 200, body: '', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
    }));
  });

  test.beforeAll(async () => {
    const { buildRealStore, SOLE_PROP } = await import('../test/helpers/real-store.mjs');
    const { planRun } = await import('../test/helpers/plan.mjs');
    const { startServer } = await import('../src/server.mjs');
    const { loadConfig } = await import('../src/config.mjs');
    rmSync(DIR, { recursive: true, force: true });
    const db = await buildRealStore(DIR, { clock: CLOCK, variant: { entities: [SOLE_PROP] } });
    try {
      expect((await planRun(db, { now: CLOCK, dataDir: DIR })).status).toBe('ok');
    } finally {
      db.close();
    }
    app = await startServer({ ...loadConfig({ FATHOM_DATA: DIR, FATHOM_DEMO: '0', FATHOM_ENGINE: 'off', FATHOM_CLOCK: CLOCK, FATHOM_OWNER_LOGINS: OWNER }), port: 0 });
    base = app.url;
  });

  test.afterAll(async () => {
    if (app) await app.close();
    app = null;
    rmSync(DIR, { recursive: true, force: true });
  });

  test('the salary war game card says it needs an S corp and links to Add files', async ({ page }) => {
    await page.goto(`${base}/#/wargame`);
    await expect(page.locator('header.h-top')).toBeVisible();
    const card = page.locator('article.h-dec.unbuilt[data-not-built="salary"]');
    await expect(card).toBeVisible();
    await expect(card.locator('p')).toHaveText('Salary war game needs an S corp with profit on file.');
    const link = card.locator('a[data-go="add"]');
    await expect(link).toHaveText('Add files');
    await link.click();
    await expect(page).toHaveURL(/#\/add$/);
  });
});
