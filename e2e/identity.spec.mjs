// Owner identity and the returning owner, on a real store: its own server (not the demo
// webServer), started here with FATHOM_DEMO=0 and one allowed login. Without the identity header
// the app is the Not authorized page; with it, an empty store shows onboarding without the demo
// sign-in step, a store with data lands on Home (whose data-health line counts the pending
// questions and links to Confirm while any are pending), the More menu shows who is signed in
// (escaped), and Home and Accounts link to the Add more files page.
// Desktop only. URLs are absolute to this server, so the configured baseURL is ignored.

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, expectH1, REMOTE, dataHealth, healthConfirm } from './helpers.mjs';
import { openDb } from '../src/store/db.mjs';
import { ask, OWNER_OPTIONS } from '../src/ingest/confirm.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const DATA_DIR = join(REPO, '.e2e-data-identity');
const DB_FILE = join(DATA_DIR, 'fathom.sqlite');
const PORT = Number(process.env.E2E_IDENTITY_PORT || 4185);
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER = 'owner@example.test';
const HEADER_LOGIN = ' Owner@Example.test ';
const HEADER_NAME = '<b>Test Owner</b>';
const ACCOUNT_ID = 'acct-e2e-identity';

test.describe.configure({ mode: 'serial' });
test.skip(REMOTE, 'starts its own local server; not part of a remote smoke run');

let child = null;
let output = '';
let itemId = null;

function serverEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('FATHOM_')) env[k] = v;
  return {
    ...env,
    FATHOM_DEMO: '0',
    FATHOM_ENGINE: 'off',
    FATHOM_DATA: DATA_DIR,
    FATHOM_PORT: String(PORT),
    FATHOM_OWNER_LOGINS: OWNER,
  };
}

async function waitHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`identity server exited early:\n${output}`);
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.status === 200) return;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`identity server not healthy after ${timeoutMs} ms:\n${output}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test.beforeAll(async () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  child = spawn(process.execPath, ['src/server.mjs'], { cwd: REPO, env: serverEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  await waitHealthy(30_000);
});

test.afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const gone = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
    await gone;
    clearTimeout(timer);
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// One account and one pending owner question, written straight into the running store (WAL).
function seedReturningOwner() {
  const db = openDb(DB_FILE);
  try {
    db.prepare(`INSERT INTO accounts (id, inst, name, owner, kind, mirror, parser)
                VALUES (?, 'Synthetic Bank', 'Synthetic Checking', NULL, 'checking', 'manual', 'e2e')`).run(ACCOUNT_ID);
    const r = ask(db, {
      kind: 'account_owner', subject: ACCOUNT_ID, question: 'Whose account is Synthetic Checking?',
      options: OWNER_OPTIONS, context: {}, now: new Date().toISOString(),
    });
    if (!r.queued) throw new Error(`expected a queued question, got ${JSON.stringify(r)}`);
    return r.id;
  } finally {
    db.close();
  }
}

test.describe('without the identity header', () => {
  test('the app is the Not authorized page and the API is 401', async ({ browser }) => {
    const ctx = await browser.newContext({ extraHTTPHeaders: {} });
    try {
      const page = await ctx.newPage();
      const res = await page.goto(`${BASE}/`);
      expect(res.status()).toBe(401);
      await expect(page.locator('body')).toContainText('Not authorized');
      const api = await ctx.request.get(`${BASE}/api/scenario`);
      expect(api.status()).toBe(401);
      expect(await api.json()).toEqual({ error: 'unauthorized' });
    } finally {
      await ctx.close();
    }
  });
});

test.describe('signed in through the identity header', () => {
  test.use({ extraHTTPHeaders: { 'Tailscale-User-Login': HEADER_LOGIN, 'Tailscale-User-Name': HEADER_NAME } });
  // In production tailscale serve adds these headers on the server side; here the browser sends
  // them on every request, including the cross-origin font requests, whose CORS preflight would
  // refuse them. Serve the font hosts locally (empty) so only Fathom's own requests matter.
  test.beforeEach(async ({ context }) => {
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({
      status: 200, body: '', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
    }));
  });

  test('an empty real store shows onboarding without the sign-in step', async ({ page }) => {
    const res = await page.goto(`${BASE}/`);
    expect(res.status()).toBe(200);
    await expect(page.locator('.h-ob')).toBeVisible();
    await expectH1(page, 'Dump everything in');
    await expect(page.locator('.h-ob-steps')).toBeVisible();
    await expect(page.locator('.h-ob-steps')).not.toContainText('Sign in');
    await expect(page.locator('body')).not.toContainText('Demo sign-in');
    await expect(page.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
  });

  test('a returning owner with a pending question lands on Home, and its Confirm link opens Confirm', async ({ page }) => {
    itemId = seedReturningOwner();
    await page.goto(`${BASE}/`);
    await expect(page).toHaveURL(/#\/home$/);
    const line = dataHealth(page);
    await expect(line).toBeVisible();
    await expect(line).toContainText('1 question to confirm');
    await expect(line).not.toContainText('1 questions');
    await expect(page.locator('.h-nav-n')).toHaveCount(0);
    await healthConfirm(page).click();
    await expect(page).toHaveURL(/#\/confirm$/);
    await expect(page.locator(`article.h-deck-card.cur [data-answer="${itemId}"][data-option="owner"]`)).toBeVisible();
  });

  test('the More menu shows the signed-in name as literal text', async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page).toHaveURL(/#\/home$/);
    await page.locator('.h-more-btn').click();
    const panel = page.locator('.h-more-p');
    await expect(panel).toBeVisible();
    const who = panel.locator('.h-who');
    await expect(who).toBeVisible();
    await expect(who).toContainText(`Signed in as ${HEADER_NAME}`);
    await expect(who.locator('b')).toHaveCount(0);
    await expect(panel).toContainText(HEADER_LOGIN.trim());
  });

  test('after the question is answered the owner still lands on Home, without the Confirm link', async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page).toHaveURL(/#\/home$/);
    await healthConfirm(page).click();
    await expect(page).toHaveURL(/#\/confirm$/);
    const answered = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/confirm/${itemId}/answer`);
    await page.locator(`[data-answer="${itemId}"][data-option="owner"]`).click();
    expect((await answered).status()).toBe(200);
    await expect(page.locator('.h-empty', { hasText: 'All caught up' })).toBeVisible();
    await page.goto(`${BASE}/`);
    await expect(page).toHaveURL(/#\/home$/);
    await expect(page.locator('header.h-top')).toBeVisible();
    await expect(dataHealth(page)).toBeVisible();
    await expect(dataHealth(page)).not.toContainText('to confirm');
    await expect(healthConfirm(page)).toHaveCount(0);
  });

  test('Home and Accounts link to the Add more files page with the uploader', async ({ page }) => {
    // Home's link is the data-health line's Files link; Accounts keeps Add more files.
    for (const [route, label] of [['home', 'Files'], ['accounts', 'Add more files']]) {
      await page.goto(`${BASE}/#/${route}`);
      await expect(page.locator('header.h-top')).toBeVisible();
      const scope = route === 'home' ? dataHealth(page) : page.locator('main');
      const link = scope.locator('a[data-go="add"]', { hasText: label }).first();
      await expect(link, `${label} on ${route}`).toBeVisible();
      await expect(link).toHaveAttribute('href', /#\/add$/);
      await link.click();
      await expect(page).toHaveURL(/#\/add$/);
      await expectH1(page, 'Add more files');
      await expect(page.locator('input[type=file][data-upload]')).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Add files', exact: true })).toBeVisible();
    }
  });
});
