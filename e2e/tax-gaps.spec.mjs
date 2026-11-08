import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { buildRealStore, addPayroll, w2Doc, paystubDoc } from '../test/helpers/real-store.mjs';
import { secretEnv, secretsFor } from '../test/helpers/server.mjs';
import { planRun } from '../test/helpers/plan.mjs';
import { startServer } from '../src/server.mjs';
import { dataName } from './data-dir.mjs';
import { loadConfig } from '../src/config.mjs';
import { createAuthStore } from '../src/auth/store.mjs';

let app, session, origin, dataDir;
const supplied = !!(process.env.BASE_URL || process.env.FATHOM_SMOKE_BASE_URL);
test.describe('tax precision gaps on a synthetic household', () => {
  test.skip(supplied && process.env.TAX1_LOCAL !== '1', 'creates its own local synthetic store');
  test.beforeAll(async () => {
    dataDir = resolve(import.meta.dirname, '..', dataName('tax-gaps'));
    if (existsSync(dataDir)) throw new Error('Tax gap fixture needs a fresh owned directory');
    mkdirSync(dataDir);
    const db = await buildRealStore(dataDir, { clock: '2026-11-05', variant: { files: false, entities: [], facts: {
      'business.entities': [], 'income.sCorp': true, 'household.birthYears': { owner: 1981, spouse: 1983, dependents: [] },
    } } });
    await addPayroll(db, w2Doc({ employerName: 'Juniper Studio', person: 'owner', relation: 'household', wages: 72000, box12: [] }));
    await addPayroll(db, paystubDoc({ employerName: 'Cedar Labs', person: 'spouse', relation: 'outside', payDate: '2026-10-31', net: 1600, state: 'VA', confidence: 0.5 }));
    await addPayroll(db, paystubDoc({ employerName: 'Maple Works', person: 'spouse', relation: 'outside', payDate: '2026-10-31', gross: 4000, ytdGross: 40000 }));
    await planRun(db, { now: '2026-11-05', dataDir });
    db.close();
    const socket = createServer();
    await new Promise(done => socket.listen(Number(process.env.TAX1_PORT || 0), 'localhost', done));
    const port = socket.address().port;
    await new Promise(done => socket.close(done));
    origin = `http://localhost:${port}`;
    app = await startServer(loadConfig({ FATHOM_DATA: dataDir, FATHOM_DEMO: '0', FATHOM_ENGINE: 'off', FATHOM_HOST: 'localhost', FATHOM_PORT: String(port), FATHOM_PUBLIC_URL: origin, FATHOM_CLOCK: '2026-11-05', ...secretEnv(secretsFor(dataDir)) }));
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
  test('provenance and dependent recs show direct fixes, Ask is prefilled and upload selects tax forms @mobile', async ({ page, context }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await context.addCookies([{ name: '__Host-fathom-session', value: session.token, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.fulfill({ status: 200, body: '' }));
    await page.goto(`${origin}/#/rec/fed-q4-estimate`);
    await expect(page.locator('.h-dlg')).toContainText('Optional estimate improvements');
    await expect(page.locator('.h-dlg')).toContainText('Cedar Labs');
    await page.locator('.h-dlg .fx-fig').first().click();
    await expect(page.locator('.fx-pop')).toContainText(/estimate with \d+ gaps?/);
    await expect(page.locator('.fx-pop')).toContainText('Cedar Labs');
    await page.screenshot({ path: test.info().outputPath('tax-gap-provenance.png'), fullPage: true });
    await page.locator('.fx-pop').getByRole('button', { name: 'Enter year-to-date pay' }).click();
    await expect(page).toHaveURL(/#\/ask$/);
    await expect(page.locator('textarea[name="q"]')).toHaveValue(/Cedar Labs/);
    await page.goto(`${origin}/#/rec/fed-q4-estimate`);
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.h-dlg').getByRole('button', { name: 'Upload a clearer tax form' }).first().click();
    const opened = await chooser;
    expect(await opened.element().getAttribute('accept')).toBe('.pdf,.txt');
    await expect(page).toHaveURL(/#\/add$/);
    await expect(page.locator('[data-upload-kind="taxforms"]')).toContainText('Tax forms');
    await page.screenshot({ path: test.info().outputPath('tax-gap-upload.png'), fullPage: true });
    expect(errors).toEqual([]);
  });
});
