// RQ2 AC4: answering a question rec on Plan moves it to Done with "Answered" and the answer, while
// a household-wide hold (married filing separately) and an unrelated payroll gap exist. The store is
// synthetic and served by this spec on its own port.

import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { buildRealStore, paystubDoc } from '../test/helpers/real-store.mjs';
import { secretEnv, secretsFor } from '../test/helpers/server.mjs';
import { planRun } from '../test/helpers/plan.mjs';
import { startServer } from '../src/server.mjs';
import { dataName } from './data-dir.mjs';
import { loadConfig } from '../src/config.mjs';
import { createAuthStore } from '../src/auth/store.mjs';

const clock = '2026-11-05';
let app, session, origin, dataDir;
const supplied = !!(process.env.BASE_URL || process.env.FATHOM_SMOKE_BASE_URL);

test.describe('an answered question rec is done on a synthetic household', () => {
  test.skip(supplied && process.env.RQ2_LOCAL !== '1', 'creates its own local synthetic store');
  test.beforeAll(async () => {
    dataDir = resolve(import.meta.dirname, '..', dataName('rq2-answered'));
    if (existsSync(dataDir)) throw new Error('The RQ2 fixture needs a fresh owned directory');
    mkdirSync(dataDir);
    const db = await buildRealStore(dataDir, { clock, variant: {
      facts: { 'household.birthYears': undefined, 'household.filingStatus': 'mfs' },
      payroll: [paystubDoc({ employerName: 'Cedar Labs', person: 'spouse', relation: 'outside', payDate: '2026-10-31', net: 1600, state: 'VA', confidence: 0.5 })],
    } });
    await planRun(db, { now: clock, dataDir });
    await db.close();
    const socket = createServer();
    await new Promise(done => socket.listen(Number(process.env.RQ2_PORT || 0), 'localhost', done));
    const port = socket.address().port;
    await new Promise(done => socket.close(done));
    origin = `http://localhost:${port}`;
    app = await startServer(loadConfig({ FATHOM_DATA: dataDir, FATHOM_DEMO: '0', FATHOM_ENGINE: 'off', FATHOM_HOST: 'localhost', FATHOM_PORT: String(port), FATHOM_PUBLIC_URL: origin, FATHOM_CLOCK: clock, ...secretEnv(secretsFor(dataDir)) }));
    const auth = createAuthStore(app.platform);
    const { user, token } = auth.invite(auth.servedHousehold().id, 'owner@example.test', { role: 'admin' });
    await auth.consumeInvitation(token, user.id);
    await auth.markEnrolled(user.id);
    session = await auth.createSession(user.id);
  });
  test.afterAll(async () => {
    if (app) await app.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  test('saving the birth year on Plan shows the rec as Done with the answer, never waiting', async ({ page, context }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await context.addCookies([{ name: '__Host-fathom-session', value: session.token, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.fulfill({ status: 200, body: '' }));
    await page.goto(`${origin}/#/plan`);
    const row = page.locator('article.h-row').filter({ has: page.locator('[data-go="rec"][data-id="va529"]') });
    const form = row.locator('[data-rec-answers="va529"]');
    await expect(form).toBeVisible();
    await expect(row).toContainText('What year were you born?');
    await form.getByRole('spinbutton').fill('1981');
    const saved = page.waitForResponse(r => r.url().endsWith('/api/recs/va529/answers') && r.request().method() === 'POST');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    const response = await saved;
    expect(response.status()).toBe(200);
    const { scenario } = await response.json();
    const rec = scenario.recs.find(r => r.id === 'va529');
    expect(rec.status).toBe('done');
    expect(rec.blocker).toBeUndefined();

    const done = page.locator('details[data-plan-group="done"]');
    await expect(done).toBeVisible();
    if (!(await done.evaluate(el => el.open))) await done.locator('summary').click();
    const doneRow = done.locator('article.h-row').filter({ has: page.locator('[data-go="rec"][data-id="va529"]') });
    await expect(doneRow).toBeVisible();
    await expect(doneRow.locator('.h-st')).toHaveText('Done');
    await expect(doneRow.locator('[data-rec-answered="va529"]')).toContainText('Answered');
    await expect(doneRow).toContainText('What year were you born?');
    await expect(doneRow).toContainText('1981');
    await expect(doneRow).not.toContainText('Waiting');
    await expect(doneRow.locator('.h-blocker')).toHaveCount(0);
    await expect(doneRow.locator('[data-rec-answered="va529"]').getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
    await expect(page.locator('details[data-plan-group="done"] [data-rec-answers="va529"], section[data-plan-group] [data-go="rec"][data-id="va529"]')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('rq2-answered-done.png'), fullPage: true });

    await page.goto(`${origin}/#/rec/va529`);
    const dialog = page.locator('.h-dlg');
    await expect(dialog).toContainText('Answered');
    await expect(dialog).toContainText('1981');
    await expect(dialog).not.toContainText('Waiting on');
    expect(errors).toEqual([]);
  });
});
