import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openScope } from '../src/storage/index.mjs';
import { test, expect } from '@playwright/test';
import { createLocalData, localPort, removeLocalData, refuseSuppliedTarget } from './local-store.mjs';
import { secretEnv, secretsFor } from '../test/helpers/server.mjs';
import { browser as httpBrowser, register as httpRegister } from '../test/helpers/tenancy.mjs';
import { createAuthenticator } from '../test/helpers/webauthn.mjs';

// MT-09 browser proof: household selection, role-aware controls and stale-tab isolation on a real
// local instance (docs/multi-tenancy.md, Active household and switching; Lifecycle, recovery and
// browser proof item 8). The owner and the second household's admin enroll over HTTP with the
// software authenticator against the actual server verifier; a browser enrollment uses Chromium's
// virtual authenticator. The operator grant goes through the OS-operator command and
// multi_household_enabled is seeded only in this disposable platform DB. Signed-in browsers get
// the cookie of a real passkey sign-in. Every name and value is synthetic.

const REPO = fileURLToPath(new URL('..', import.meta.url));
const REMOTE = !!(process.env.BASE_URL || process.env.FATHOM_SMOKE_BASE_URL);
const OWNER = 'owner@example.test';
const BRAVO_ADMIN = 'bravo-admin@example.test';
const DELTA = 'delta@example.test';
const CHARLIE = 'charlie@example.test';
const BRAVO_NAME = 'Synthetic Bravo Household';
const ALPHA_LABEL = 'Household 1';
const ALPHA_GOAL = 'Alphacanary cushion';
const BRAVO_GOAL = 'Bravocanary cushion';
const STALE_NOTICE = 'The household changed in another tab';
const SESSION = '__Host-fathom-session';

let dataDir;
let base;
let env;
let server;
const fx = {};

test.use({ storageState: { cookies: [], origins: [] }, extraHTTPHeaders: {}, trace: 'off', screenshot: 'off', video: 'off' });

test.describe('household selection and isolation', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });
  test.skip(REMOTE, 'creates an isolated local server; never runs against a supplied target');

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    refuseSuppliedTarget();
    dataDir = createLocalData('tenancy');
    const port = await localPort();
    base = `http://localhost:${port}`;
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FATHOM_')));
    env = {
      ...inherited, FATHOM_DATA: dataDir, FATHOM_DEMO: '0', FATHOM_ENGINE: 'fake', FATHOM_FAKE_STREAM_MS: '400',
      FATHOM_HOST: 'localhost', FATHOM_PORT: String(port), FATHOM_PUBLIC_URL: base,
      ...secretEnv(secretsFor(dataDir)), FATHOM_CLOCK: '2026-11-05',
      FATHOM_EMAIL_TRANSPORT: 'dev', FATHOM_EMAIL_FROM: 'fathom@example.test', FATHOM_EMAIL_TO: OWNER,
    };
    server = spawn(process.execPath, ['src/server.mjs'], { cwd: REPO, env, stdio: ['ignore', 'ignore', 'ignore'] });
    await expect.poll(async () => {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error('Local server exited before readiness');
      try { return (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).status; }
      catch { return 0; }
    }, { timeout: 30_000, message: 'local server health' }).toBe(200);

    // The owner: bootstrapped by the operator's invite command, enrolled with a passkey.
    fx.owner = await enroll(tokenOf(await run(['scripts/user-invite.mjs', OWNER, '--admin'])));
    fx.A = fx.owner.identity.householdId;
    expect((await run(['scripts/operator.mjs', 'grant', OWNER], { output: false })).code).toBe(0);
    await seedPlatformSetting('multi_household_enabled', true);
    // The operator provisions B; its first admin enrolls from the emailed link.
    let before = outboxNames();
    const made = await fx.owner.client.post('/api/operator/households', { displayName: BRAVO_NAME, adminEmail: BRAVO_ADMIN });
    expect(made.status, made.text).toBe(200);
    fx.B = made.json.household.id;
    fx.bravo = await enroll(await mailedToken(before, BRAVO_ADMIN));
    // Both households finished onboarding; a canary goal in each.
    expect((await fx.owner.client.post('/api/onboarding', { step: 6 })).status).toBe(200);
    expect((await fx.bravo.client.post('/api/onboarding', { step: 6 })).status).toBe(200);
    expect((await fx.owner.client.post('/api/goals', { title: ALPHA_GOAL, horizon: '1-3y' })).status).toBe(200);
    expect((await fx.bravo.client.post('/api/goals', { title: BRAVO_GOAL, horizon: '1-3y' })).status).toBe(200);
    // The owner also joins B as a member; delta is an A member invited to B but not yet joined;
    // charlie is invited to B only.
    before = outboxNames();
    expect((await fx.bravo.client.post('/api/admin/users/invite', { email: OWNER, role: 'member' })).status).toBe(200);
    expect((await fx.owner.client.post('/api/auth/invitations/accept', { token: await mailedToken(before, OWNER) })).status).toBe(200);
    before = outboxNames();
    expect((await fx.owner.client.post('/api/admin/users/invite', { email: DELTA, role: 'member' })).status).toBe(200);
    fx.delta = await enroll(await mailedToken(before, DELTA));
    before = outboxNames();
    expect((await fx.bravo.client.post('/api/admin/users/invite', { email: DELTA, role: 'member' })).status).toBe(200);
    fx.deltaLink = `${base}/enroll#${await mailedToken(before, DELTA)}`;
    before = outboxNames();
    expect((await fx.bravo.client.post('/api/admin/users/invite', { email: CHARLIE, role: 'member' })).status).toBe(200);
    fx.charlieLink = `${base}/enroll#${await mailedToken(before, CHARLIE)}`;
    await clearTours();
  });

  test.afterAll(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const gone = new Promise((done) => server.once('exit', done));
      server.kill('SIGTERM');
      const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
      await gone;
      clearTimeout(timer);
    }
    removeLocalData(dataDir);
  });

  test('a new member enrolls from the emailed link and sees no household picker', async ({ context, page }) => {
    await quietFonts(context);
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    } });
    await page.goto(fx.charlieLink);
    await page.getByRole('textbox', { name: 'Passkey name', exact: true }).fill('Synthetic laptop');
    await page.getByRole('button', { name: 'Create passkey', exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/' && url.hash.startsWith('#/'));
    await clearTours();
    await page.goto(`${base}/#/goals`);
    await expect(page.getByText(BRAVO_GOAL).first()).toBeVisible();
    await expect(page.getByText(ALPHA_GOAL)).toHaveCount(0);
    await expect(page.locator('select[data-hh-switch]'), 'one household: no picker').toHaveCount(0);
    await page.goto(`${base}/#/engine`);
    await expect(page.locator('[data-eng-admin-only]'), 'a member sees no engine controls').toBeVisible();
    await expect(page.locator('[data-fx-engine]')).toHaveCount(0);
  });

  test('an enrolled member joins a second household from its link, then gets the picker', async ({ context, page }) => {
    await signInto(context, fx.delta);
    await page.goto(fx.deltaLink);
    await page.getByRole('button', { name: 'Join the household', exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/');
    const picker = page.locator('select[data-hh-switch]');
    await expect(picker).toBeVisible();
    await expect(picker).toHaveValue(fx.A, { timeout: 10_000 });
    await expect(picker.locator('option')).toHaveText([ALPHA_LABEL, BRAVO_NAME]);
  });

  test('two households: choose after sign-in, switch from the header and see only that household @mobile', async ({ context, page }, info) => {
    await signInto(context, fx.owner);
    await page.goto(`${base}/`);
    await expect(page.getByRole('heading', { name: 'Choose a household' })).toBeVisible();
    await expect(page.getByText(ALPHA_GOAL)).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('chooser.png'), fullPage: true });
    await page.getByRole('button', { name: new RegExp(BRAVO_NAME) }).click();
    const picker = page.locator('select[data-hh-switch]');
    await expect(picker).toHaveValue(fx.B, { timeout: 15_000 });
    await expect(picker.locator('option:checked')).toHaveText(BRAVO_NAME);
    await page.goto(`${base}/#/goals`);
    await expect(page.getByText(BRAVO_GOAL).first()).toBeVisible();
    await expect(page.getByText(ALPHA_GOAL)).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('bravo.png'), fullPage: false });
    // While the switch is in flight the page shows neither household's figures under the new name.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route('**/api/auth/household', async (route) => { await held; await route.continue(); }, { times: 1 });
    await picker.selectOption(fx.A);
    await expect(page.getByRole('alert').filter({ hasText: 'Switching household' })).toBeVisible();
    await expect(page.getByText(BRAVO_GOAL)).toHaveCount(0);
    await expect(page.locator('select[data-hh-switch]')).toHaveCount(0);
    release();
    await expect(picker).toHaveValue(fx.A, { timeout: 15_000 });
    await page.goto(`${base}/#/goals`);
    await expect(page.getByText(ALPHA_GOAL).first()).toBeVisible();
    await expect(page.getByText(BRAVO_GOAL)).toHaveCount(0);
    await page.goto(`${base}/#/settings`);
    await expect(page.locator('.h-who')).toContainText(`Household admin of ${ALPHA_LABEL}`);
    await page.screenshot({ path: info.outputPath('alpha-settings.png'), fullPage: false });
  });

  test('a switch in one tab ends the other tab\'s stream and refuses its delayed write', async ({ context, page }) => {
    await signInto(context, fx.owner);
    await choose(page, fx.A);
    // Stream: tab 1 asks, tab 2 switches while the answer streams.
    const tab2 = await context.newPage();
    await tab2.goto(`${base}/#/goals`);
    await expect(tab2.locator('select[data-hh-switch]')).toHaveValue(fx.A);
    await page.goto(`${base}/#/goals`);
    await page.evaluate(() => {
      window.__events = [];
      window.__stream = window.Fathom.api.newThreadStream({ text: 'Synthetic question during a switch' }, (name) => { window.__events.push(name); });
    });
    await expect.poll(() => page.evaluate(() => window.__events.length), { message: 'the stream started' }).toBeGreaterThan(0);
    await tab2.locator('select[data-hh-switch]').selectOption(fx.B);
    await expect(tab2.locator('select[data-hh-switch]')).toHaveValue(fx.B, { timeout: 15_000 });
    expect(await page.evaluate(() => window.__stream), 'the stream resolved without an answer').toBeNull();
    await expect(page.getByRole('alert').filter({ hasText: STALE_NOTICE })).toBeVisible();
    await expect(page.getByText(BRAVO_GOAL), 'the stale tab shows nothing of the new household').toHaveCount(0);
    expect(await storedQuestions(fx.B)).not.toContain('Synthetic question during a switch');

    // Delayed write: tab 3 (in B) posts a goal held in the network until tab 2 switches back.
    const tab3 = await context.newPage();
    await tab3.goto(`${base}/#/goals`);
    await expect(tab3.locator('select[data-hh-switch]')).toHaveValue(fx.B);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await tab3.route('**/api/goals', async (route) => { await held; await route.continue(); });
    await tab3.evaluate(() => {
      window.__write = window.Fathom.api.fetch('/api/goals', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Delayed stale goal', horizon: '1-3y' }) }).then((r) => r.status, (e) => (e && e.dropped ? 'dropped' : 'failed'));
    });
    const refused = tab3.waitForResponse((r) => new URL(r.url()).pathname === '/api/goals');
    await tab2.reload();
    await tab2.locator('select[data-hh-switch]').selectOption(fx.A);
    await expect(tab2.locator('select[data-hh-switch]')).toHaveValue(fx.A, { timeout: 15_000 });
    release();
    expect((await refused).status(), 'the server refused the delayed write').toBe(409);
    expect(await tab3.evaluate(() => window.__write)).toBe('dropped');
    await expect(tab3.getByRole('alert').filter({ hasText: STALE_NOTICE })).toBeVisible();
    expect(await goalTitles(fx.A)).not.toContain('Delayed stale goal');
    expect(await goalTitles(fx.B)).not.toContain('Delayed stale goal');
    // Liveness: the tab in the current household still writes.
    await tab2.goto(`${base}/#/goals`);
    const live = await tab2.evaluate(() => window.Fathom.api.goalCreate({ title: 'Live goal after switch', horizon: '1-3y' }));
    expect(live).not.toBeNull();
    expect(await goalTitles(fx.A)).toContain('Live goal after switch');
  });

  test('a deep link to another household needs explicit selection; a foreign one is never followed', async ({ context, page }) => {
    await signInto(context, fx.owner);
    await choose(page, fx.B);
    await page.goto(`${base}/?household=${encodeURIComponent(fx.A)}#/goals`);
    await expect(page.getByRole('heading', { name: `This link opens ${ALPHA_LABEL}` })).toBeVisible();
    await expect(page.getByText(ALPHA_GOAL)).toHaveCount(0);
    await page.getByRole('button', { name: `Stay in ${BRAVO_NAME}` }).click();
    await expect(page.locator('select[data-hh-switch]')).toHaveValue(fx.B, { timeout: 15_000 });
    await expect(page).toHaveURL((url) => !url.search.includes('household') && !url.hash.includes('goals'));
    await page.goto(`${base}/?household=${encodeURIComponent(fx.A)}#/goals`);
    await page.getByRole('button', { name: `Open ${ALPHA_LABEL}` }).click();
    await expect(page.locator('select[data-hh-switch]')).toHaveValue(fx.A, { timeout: 15_000 });
    await expect(page).toHaveURL((url) => url.hash === '#/goals' && !url.search.includes('household'));
    await expect(page.getByText(ALPHA_GOAL).first()).toBeVisible();
    // A refused link's fragment is dropped, so a record id it names never opens in the current household.
    await page.goto(`${base}/?household=hh-00000000-0000-4000-8000-000000000000#/confirm/1`);
    await expect(page.getByRole('alert').filter({ hasText: 'That link is for a household you cannot open here' })).toBeVisible();
    await expect(page.locator('select[data-hh-switch]')).toHaveValue(fx.A);
    await expect(page).toHaveURL((url) => !url.search.includes('household') && !url.hash.includes('confirm'));
  });

  test('download links and the admin page carry the household; signing out leaves nothing to the next sign-in', async ({ context, page }) => {
    await signInto(context, fx.owner);
    await choose(page, fx.A);
    await page.goto(`${base}/#/yearend`);
    const href = await page.locator('[data-ye-download]').getAttribute('href');
    expect(new URL(href, base).searchParams.get('household')).toBe(fx.A);
    expect(new URL(href, base).searchParams.get('contextVersion')).toMatch(/^[1-9][0-9]*$/);
    const download = await context.request.get(new URL(href, base).href);
    expect(download.status()).toBe(200);
    await page.goto(`${base}/admin/users`);
    await expect(page.getByRole('heading', { name: `Household: ${ALPHA_LABEL}` })).toBeVisible();
    await expect(page.getByText(DELTA).first()).toBeVisible();
    await expect(page.getByText(BRAVO_ADMIN)).toHaveCount(0);
    await page.goto(`${base}/account`);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === '/signin');
    // Signed out, a deep link keeps its household target through sign-in.
    await page.goto(`${base}/?household=${encodeURIComponent(fx.B)}#/goals`);
    await expect(page).toHaveURL((url) => url.pathname === '/signin' && url.searchParams.get('household') === fx.B && url.hash === '#/goals');
    expect((await context.request.get(`${base}/api/auth/session`)).status()).toBe(200);
    expect((await (await context.request.get(`${base}/api/auth/session`)).json()).identity).toBeNull();
    await signInto(context, fx.owner);
    await page.goto(`${base}/`);
    await expect(page.getByRole('heading', { name: 'Choose a household' })).toBeVisible();
    await expect(page.getByText(ALPHA_GOAL)).toHaveCount(0);
  });
});

// ------------------------------------------------------------------------------ helpers

function run(args, { output = true } = {}) {
  refuseSuppliedTarget();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Local command timed out')); }, 20_000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Local command could not start')); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(output ? stdout : { code }); });
  });
}

const tokenOf = (text) => {
  const match = /\/enroll#([A-Za-z0-9_-]{43})/.exec(String(text));
  if (!match) throw new Error('Expected one enrollment link');
  return match[1];
};

function outboxNames() {
  try { return new Set(readdirSync(join(dataDir, 'outbox')).filter((name) => name.endsWith('.json'))); }
  catch (err) { if (err.code === 'ENOENT') return new Set(); throw err; }
}

async function mailedToken(before, email) {
  let token = null;
  await expect.poll(() => {
    const fresh = [...outboxNames()].filter((name) => !before.has(name))
      .map((name) => JSON.parse(readFileSync(join(dataDir, 'outbox', name), 'utf8')))
      .filter((m) => [].concat(m.to).includes(email));
    token = fresh.length ? tokenOf(fresh.at(-1).text) : null;
    return Boolean(token);
  }, { timeout: 10_000, message: `an enrollment email reached ${email}` }).toBe(true);
  return token;
}

// A person enrolled over HTTP with a software passkey: { client, device, credentialId, identity }.
async function enroll(token) {
  const device = createAuthenticator();
  const client = httpBrowser(base);
  const r = await httpRegister(base, client, device, { token });
  expect(r.verify?.status, r.verify?.text).toBe(200);
  return { client, device, credentialId: device.credentials()[0].id, identity: r.verify.json.identity };
}

// A fresh passkey sign-in through the browser context's own cookie jar: the real options and
// verify routes, answered by the person's software authenticator.
async function signInto(context, person) {
  await quietFonts(context);
  await context.clearCookies();
  const options = await context.request.post(`${base}/api/auth/signin/options`, { data: {}, headers: { origin: base } });
  expect(options.status()).toBe(200);
  const response = person.device.getAssertion((await options.json()).options, { origin: base, credentialId: person.credentialId });
  const verify = await context.request.post(`${base}/api/auth/signin/verify`, { data: { response }, headers: { origin: base } });
  expect(verify.status()).toBe(200);
  expect((await context.cookies(base)).some((c) => c.name === SESSION)).toBe(true);
}

// Guided tours are out of scope here: none starts over these pages.
async function clearTours() {
  const db = await openScope({ path: join(dataDir, 'platform.sqlite'), journal: null, busyTimeout: 0 });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    await db.prepare('UPDATE users SET tour_pending = 0').run();
  } finally { await db.close(); }
}

async function quietFonts(context) {
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, body: '' }));
}

// A fresh sign-in with two households lands on the chooser; pick one.
async function choose(page, householdId) {
  await page.goto(`${base}/`);
  await page.locator(`[data-fx-choose="${householdId}"]`).click();
  await expect(page.locator('select[data-hh-switch]')).toHaveValue(householdId, { timeout: 15_000 });
}

async function seedPlatformSetting(key, value) {
  const db = await openScope({ path: join(dataDir, 'platform.sqlite'), journal: null, busyTimeout: 0 });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    await db.prepare(`INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, JSON.stringify(value), Date.now());
  } finally { await db.close(); }
}

async function householdDb(id, fn) {
  const db = await openScope({ path: join(dataDir, 'households', id, 'fathom.sqlite'), readOnly: true, journal: null, busyTimeout: 0 });
  try { return fn(db); } finally { await db.close(); }
}
const goalTitles = async (id) => await householdDb(id, async (db) => (await db.prepare('SELECT def FROM goals').all()).map((r) => JSON.parse(r.def).title));
const storedQuestions = async (id) => await householdDb(id, async (db) => (await db.prepare("SELECT text FROM messages WHERE role = 'me'").all()).map((r) => r.text));
