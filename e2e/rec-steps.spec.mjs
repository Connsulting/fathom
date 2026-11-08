import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { createServer } from 'node:net';
import { buildRealStore, addPayroll, paystubDoc } from '../test/helpers/real-store.mjs';
import { secretEnv, secretsFor } from '../test/helpers/server.mjs';
import { planRun } from '../test/helpers/plan.mjs';
import { startServer } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { ask, FACT_CHECK_OPTIONS } from '../src/ingest/confirm.mjs';
import { createAuthStore } from '../src/auth/store.mjs';

let app, session, origin, dataDir;

const supplied = !!(process.env.BASE_URL || process.env.FATHOM_SMOKE_BASE_URL);
const clock = '2026-12-28';
const variant = { facts: { 'household.filingStatus': undefined, 'household.birthYears': { owner: 1984 }, 'household.names': undefined } };

test.describe('product-managed steps on the missing-data rec', () => {
  test.skip(supplied, 'creates its own local synthetic store');
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async () => {
    const repo = resolve(import.meta.dirname, '..');
    dataDir = resolve(repo, `${process.env.E2E_DATA || '.e2e-data'}-steps`);
    if (dirname(dataDir) !== repo || !/^\.e2e-data(?:-[a-z0-9]+)*-steps$/.test(basename(dataDir))) throw new Error('Steps fixture needs its own directory');
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir);
    const db = await buildRealStore(dataDir, { clock, variant });
    await ask(db, { kind: 'fact_check', subject: 'unrelated-synthetic-check', question: 'An unrelated synthetic question',
      options: FACT_CHECK_OPTIONS, context: { key: 'synthetic.unrelated', value: true }, now: clock });
    await addPayroll(db, paystubDoc({ person: 'owner', employerName: 'Sample Outside Employer',
      payDate: '2026-12-15', ytdGross: 60000, federalWithholding: 6000 }));
    await planRun(db, { now: clock, dataDir });

    await db.prepare("UPDATE recs SET status = CASE WHEN id = 'missing-data' THEN 'proposed' ELSE 'dismissed' END").run();
    await db.close();
    const socket = createServer();
    await new Promise(done => socket.listen(Number(process.env.E2E_STEPS_PORT || 0), 'localhost', done));
    const port = socket.address().port;
    await new Promise(done => socket.close(done));
    origin = `http://localhost:${port}`;
    app = await startServer(loadConfig({ FATHOM_DATA: dataDir, FATHOM_DEMO: '0', FATHOM_ENGINE: 'off', FATHOM_HOST: 'localhost', FATHOM_PORT: String(port), FATHOM_PUBLIC_URL: origin, FATHOM_CLOCK: clock, ...secretEnv(secretsFor(dataDir)) }));
    const auth = createAuthStore(app.platform);
    const { user, token } = auth.invite(auth.servedHousehold().id, 'owner@example.test', { role: 'admin' });
    auth.consumeInvitation(token, user.id);
    await auth.markEnrolled(user.id);
    session = auth.createSession(user.id);
  });
  test.afterAll(async () => {
    if (app) await app.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: '__Host-fathom-session', value: session.token, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.fulfill({ status: 200, body: '' }));
  });

  test('@mobile @st1 missing-data improvements have working upload and Ask controls', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/#/rec/missing-data`);
    const dlg = page.locator('.h-dlg');
    const steps = dlg.locator('.h-steps');
    await expect(steps).toBeVisible();
    await expect(steps.locator('input[type=checkbox], [aria-pressed], [role=checkbox], [data-act="task"]')).toHaveCount(0);
    const upload = steps.locator('li.h-step[data-kind="upload"]').first();
    const chooser = page.waitForEvent('filechooser');
    await upload.getByRole('button', { name: /^Upload/ }).click();
    expect(await (await chooser).element().getAttribute('accept')).toBeTruthy();
    await expect(page).toHaveURL(/#\/add$/);
    await page.goto(`${origin}/#/rec/missing-data`);
    await page.locator('.h-dlg').getByRole('button', { name: 'Enter filing status', exact: true }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await expect(page.locator('textarea[name="q"]')).toHaveValue(/filing status/);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('@mobile @st1 an employer gap prefills Ask with its own employer', async ({ page }) => {
    await page.goto(`${origin}/#/rec/missing-data`);
    await page.locator('.h-dlg').getByRole('button', { name: 'Describe the employer', exact: true }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    const draft = page.locator('textarea[name="q"]');
    await expect(draft).toHaveValue(/Sample Outside Employer/);
    await expect(draft).not.toHaveValue(/unrelated synthetic/);

  });
});
