import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { createServer } from 'node:net';
import { buildRealStore } from '../test/helpers/real-store.mjs';
import { secretEnv, secretsFor } from '../test/helpers/server.mjs';
import { planRun } from '../test/helpers/plan.mjs';
import { startServer } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { createAuthStore } from '../src/auth/store.mjs';

// The missing-data rec on a synthetic single filer late in the year: its filing status is unset
// and its sources are stale, so the rec lists one answer step and its upload steps. Every step is
// product-managed: inline controls, no checkboxes, and the answer step completes itself.
let app, session, origin, dataDir;
const supplied = !!(process.env.BASE_URL || process.env.FATHOM_SMOKE_BASE_URL);
const clock = '2026-12-28';
const variant = { facts: { 'household.filingStatus': undefined, 'household.birthYears': { owner: 1984 }, 'household.names': undefined } };

test.describe('product-managed steps on the missing-data rec', () => {
  test.skip(supplied, 'creates its own local synthetic store');
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async () => {
    const repo = resolve(import.meta.dirname, '..');
    dataDir = resolve(repo, '.e2e-data-steps');
    if (dirname(dataDir) !== repo || !/^\.e2e-data-steps$/.test(basename(dataDir))) throw new Error('Steps fixture needs its own directory');
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir);
    const db = await buildRealStore(dataDir, { clock, variant });
    await planRun(db, { now: clock, dataDir });
    db.prepare("UPDATE recs SET status = CASE WHEN id = 'missing-data' THEN 'proposed' ELSE 'dismissed' END").run();
    db.close();
    const socket = createServer();
    await new Promise(done => socket.listen(Number(process.env.E2E_STEPS_PORT || 0), 'localhost', done));
    const port = socket.address().port;
    await new Promise(done => socket.close(done));
    origin = `http://localhost:${port}`;
    app = await startServer(loadConfig({ FATHOM_DATA: dataDir, FATHOM_DEMO: '0', FATHOM_ENGINE: 'off', FATHOM_HOST: 'localhost', FATHOM_PORT: String(port), FATHOM_PUBLIC_URL: origin, FATHOM_CLOCK: clock, ...secretEnv(secretsFor(dataDir)) }));
    const auth = createAuthStore(app.platform);
    const { user, token } = auth.invite(auth.servedHousehold().id, 'owner@example.test', { role: 'admin' });
    auth.consumeInvitation(token, user.id);
    auth.markEnrolled(user.id);
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

  test('@mobile @st1 the missing-data rec shows inline controls and a step completes itself after an answer', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/#/rec/missing-data`);
    const dlg = page.locator('.h-dlg');
    const steps = dlg.locator('.h-steps');
    await expect(steps).toBeVisible();
    const answer = steps.locator('li.h-step[data-kind="answer"]');
    const uploads = steps.locator('li.h-step[data-kind="upload"]');
    await expect(answer).toHaveCount(1);
    expect(await uploads.count()).toBeGreaterThan(0);
    const total = await steps.locator('li.h-step').count();
    // No free checkboxes and no "I did this" on steps the product verifies.
    await expect(dlg.locator('.h-steps input[type=checkbox], .h-steps [aria-pressed], .h-steps [role=checkbox]')).toHaveCount(0);
    await expect(steps.locator('[data-act="task"]')).toHaveCount(0);
    await expect(uploads.first().getByRole('button', { name: /^Upload/ })).toBeVisible();
    await expect(uploads.first().locator('input[type=file][data-upload]')).toHaveCount(1);
    await expect(answer).toContainText('Tell us your filing status');
    await expect(answer).toContainText('Checks off when you answer');
    await expect(dlg.locator('.h-prog span')).toHaveText(`0 of ${total}`);
    if (process.env.ST1_RENDER_DIR) await shot(page, 'before');

    // The answer step's control is the answer form on the same rec.
    await answer.getByRole('button', { name: 'Answer', exact: true }).click();
    const form = dlg.locator('[data-rec-answers="missing-data"]');
    await expect(form).toBeVisible();
    await form.getByLabel('Single', { exact: true }).check();
    const saved = page.waitForResponse(r => r.url().endsWith('/api/recs/missing-data/answers') && r.request().method() === 'POST');
    await form.getByRole('button', { name: /^Save/ }).click();
    expect((await saved).status()).toBe(200);

    const done = dlg.locator('.h-steps li.h-step[data-kind="answer"]');
    await expect(done).toHaveClass(/\bdone\b/);
    await expect(done).toContainText('Done automatically');
    await expect(done.getByRole('button')).toHaveCount(0);
    await expect(dlg.locator('.h-prog span')).toHaveText(`1 of ${total}`);
    await expect(dlg.locator('.h-steps li.h-step[data-kind="upload"]').first()).not.toHaveClass(/\bdone\b/);
    if (process.env.ST1_RENDER_DIR) await shot(page, 'after');
    await page.reload();
    await expect(page.locator('.h-dlg .h-steps li.h-step[data-kind="answer"]')).toHaveClass(/\bdone\b/);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

async function shot(page, name) {
  mkdirSync(process.env.ST1_RENDER_DIR, { recursive: true });
  await page.evaluate(() => {
    document.activeElement?.blur();
    document.querySelector('.h-steps')?.scrollIntoView({ block: 'start' });
  });
  await page.screenshot({ path: resolve(process.env.ST1_RENDER_DIR, `${test.info().project.name}-${name}.png`) });
}
