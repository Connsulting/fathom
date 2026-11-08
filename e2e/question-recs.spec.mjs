import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { createServer } from 'node:net';
import { buildRealStore } from '../test/helpers/real-store.mjs';
import { secretEnv, secretsFor } from '../test/helpers/server.mjs';
import { planRun } from '../test/helpers/plan.mjs';
import { startServer } from '../src/server.mjs';
import { dataName } from './data-dir.mjs';
import { loadConfig } from '../src/config.mjs';
import { createAuthStore } from '../src/auth/store.mjs';

let app, session, origin, dataDir, store, householdId;
const supplied = !!(process.env.BASE_URL || process.env.FATHOM_SMOKE_BASE_URL);
const ownLocal = process.env.QRECS_LOCAL === '1';
const clock = '2026-11-05';

async function post(path, body) {
  const r = await fetch(origin + path, { method: 'POST', headers: { Cookie: `__Host-fathom-session=${session.token}`, Origin: origin, 'Content-Type': 'application/json', 'X-Fathom-Household': householdId, 'X-Fathom-Context-Version': '1' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

test.describe('answerable questions on the synthetic planning household', () => {
  test.skip(supplied && !ownLocal, 'creates its own local synthetic store');
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async () => {
    const repo = resolve(import.meta.dirname, '..');
    dataDir = resolve(repo, process.env.E2E_DATA || dataName('qrecs'));
    const owned = dataName('qrecs');
    if (dirname(dataDir) !== repo || (basename(dataDir) !== owned && !basename(dataDir).startsWith(`${owned}-`)) || existsSync(dataDir)) throw new Error('Question fixture needs a fresh owned directory');
    mkdirSync(dataDir);
    const db = await buildRealStore(dataDir, { clock, variant: { facts: { 'accounts.va529': undefined } } });
    // No institution on file, so the Virginia plan is asked rather than inferred.
    await db.prepare("UPDATE accounts SET display_name = 'College fund', inst = '' WHERE kind = '529'").run();
    await db.prepare('INSERT INTO goals (id, def, sort) VALUES (?, ?, 0)').run('question-college', JSON.stringify({ title: 'College savings', kind: 'education', horizon: 'This year' }));
    await planRun(db, { now: clock, dataDir });
    await db.close();
    const socket = createServer();
    await new Promise(done => socket.listen(Number(process.env.E2E_PORT || 0), 'localhost', done));
    const port = socket.address().port;
    await new Promise(done => socket.close(done));
    origin = `http://localhost:${port}`;
    app = await startServer(loadConfig({ FATHOM_DATA: dataDir, FATHOM_DEMO: '0', FATHOM_ENGINE: 'off', FATHOM_HOST: 'localhost', FATHOM_PORT: String(port), FATHOM_PUBLIC_URL: origin, FATHOM_CLOCK: clock, ...secretEnv(secretsFor(dataDir)) }));
    const auth = createAuthStore(app.platform);
    const { user, token } = auth.invite(auth.servedHousehold().id, 'owner@example.test', { role: 'admin' });
    await auth.consumeInvitation(token, user.id);
    await auth.markEnrolled(user.id);
    session = await auth.createSession(user.id);
    householdId = auth.servedHousehold().id;
    // The served household's own store, through the server's runtime registry.
    store = app.runtimes.get(auth.servedHousehold().id).db;
  });
  test.afterAll(async () => {
    if (app) await app.close();
    if (app && dataDir) rmSync(dataDir, { recursive: true, force: true });
  });
  test.beforeEach(async ({ context }) => {
    await store.prepare("DELETE FROM facts WHERE key = 'accounts.va529'").run();
    expect((await post('/api/jobs/plan/run', {})).status).toBe(200);
    await store.prepare("UPDATE recs SET status = CASE WHEN id = 'va529' THEN 'proposed' ELSE 'dismissed' END").run();
    await context.addCookies([{ name: '__Host-fathom-session', value: session.token, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.fulfill({ status: 200, body: '' }));
  });

  for (const surface of ['home', 'plan', 'dialog']) {
    test(`@mobile @qr-ac1 @qr-ac2 @qr-ac4 ${surface} saves the Virginia answers and shows the figured action`, async ({ page, isMobile }) => {
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(`${origin}/#/${surface === 'dialog' ? 'rec/va529' : surface}`);
      const container = surface === 'home' ? page.locator('article.h-next') : surface === 'dialog' ? page.locator('.h-dlg') : page.locator('article.h-row').filter({ has: page.locator('[data-go="rec"][data-id="va529"]') });
      const form = container.locator('[data-rec-answers="va529"]');
      await expect(form).toBeVisible();
      const plan = 'Is this Virginia\'s own 529 program (Invest529), which is the only kind Virginia deducts?';
      await expect(container).toContainText('College fund (3333)');
      await expect(container).toContainText(plan);
      await expect(container.getByRole('button', { name: 'Done', exact: true })).toHaveCount(0);
      await expect(form.getByRole('button', { name: 'Not now', exact: true })).toBeVisible();
      await expect(form.getByRole('button', { name: 'Ask', exact: true })).toBeVisible();
      await form.getByRole('group', { name: plan }).getByLabel('Yes', { exact: true }).check();
      await expect(form.getByRole('group', { name: /age 70 or older/ })).toHaveCount(0);
      await form.getByRole('spinbutton').fill('0');
      await expect(form.getByRole('spinbutton')).toHaveAttribute('step', '0.01');
      await expect(form).toContainText('USD');
      if (process.env.QRECS_RENDER_DIR) {
        mkdirSync(process.env.QRECS_RENDER_DIR, { recursive: true });
        await page.evaluate(() => {
          document.activeElement?.blur();
          window.scrollTo(0, 0);
          document.querySelector('.h-dlg')?.scrollTo(0, 0);
          document.querySelector('.h-dlg-body')?.scrollTo(0, 0);
        });
        await page.screenshot({ path: resolve(process.env.QRECS_RENDER_DIR, `${test.info().project.name}-${surface}.png`), fullPage: true });
      }
      const saved = page.waitForResponse(r => r.url().endsWith('/api/recs/va529/answers') && r.request().method() === 'POST');
      await form.getByRole('button', { name: 'Save', exact: true }).click();
      const response = await saved;
      expect(response.status()).toBe(200);
      const { scenario } = await response.json();
      const action = scenario.recs.find(r => r.id === 'va529');
      expect(action.question).toBeUndefined();
      expect(action.mine.some(m => m.fig === 'va529.deductionLeft')).toBe(true);
      expect(scenario.fig['va529.deductionLeft'].v).toBeGreaterThan(0);
      if (surface === 'home' && !isMobile) {
        await expect(page.locator('article.h-next')).toHaveCount(0);
        await expect(page.locator('.h-next-hint')).toHaveCount(0);
        const row = page.locator('.h-due-r[data-rec="va529"]');
        await expect(row).toContainText('Use the rest of this year Virginia 529 deduction');
        await row.locator('[data-go="rec"]').click();
        await expect(page.locator('.h-dlg .fx-fig').first()).toBeVisible();
      } else {
        await expect(container).toContainText('Use the rest of this year Virginia 529 deduction');
        await expect(container.locator('.fx-fig').first()).toBeVisible();
        await expect(container.locator('[data-rec-answers]')).toHaveCount(0);
      }
      await page.reload();
      await expect(page.locator('body')).toContainText('Use the rest of this year Virginia 529 deduction');
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }

  test('@mobile @qr-ac1 @qr-ac3 Not now keeps the question unanswered; completion is refused', async ({ page }) => {
    await page.goto(`${origin}/#/home`);
    const form = page.locator('article.h-next [data-rec-answers="va529"]');
    await expect(form).toBeVisible();
    const refused = await post('/api/recs/va529/action', { action: 'complete' });
    expect(refused.status).toBe(409);
    await form.getByRole('button', { name: 'Not now', exact: true }).click();
    await expect(page.locator('article.h-next [data-rec-answers="va529"]')).toHaveCount(0);
    expect(await store.prepare("SELECT value FROM facts WHERE key = 'accounts.va529'").get()).toBeUndefined();
    await page.goto(`${origin}/#/rec/va529`);
    await expect(page.locator('.h-dlg [data-rec-answers="va529"]')).toBeVisible();
  });
});
