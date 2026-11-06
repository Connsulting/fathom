// Onboarding steps that are real: the sign-in line, the Tell us note saved through ingest and the
// "what we heard" step derived from stored facts. Two parts.
//
// 1. The demo build (the shared demo server), served as a fresh store on each step.
// 2. A real-mode store past first run, on its own server (FATHOM_DEMO=0, engine off, one allowed
//    login), where Setup in More lands on Tell us and the heard step lists the stored household
//    with provenance and edit links.
//
// Desktop and 390px. Real-mode URLs are absolute to its own server, so the configured baseURL is
// ignored there.

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, expectH1, REMOTE, resetDemo } from './helpers.mjs';
import { openDb } from '../src/store/db.mjs';
import { upsertFact } from '../src/store/facts.mjs';
import { ask, FACT_CHECK_OPTIONS } from '../src/ingest/confirm.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const NOTE = 'We file jointly in Virginia, I run an S corporation and my spouse freelances. Two kids.';

test.describe.configure({ mode: 'serial' });
test.skip(REMOTE, 'starts its own local server and writes notes; not part of a remote smoke run');

/* ---------- part 1: the demo build ---------- */

// The demo store has finished onboarding; serve every scenario as a fresh one on the given step.
async function forceFresh(page, step) {
  await page.route('**/api/**', async (route) => {
    const res = await route.fetch();
    if (!String(res.headers()['content-type'] || '').includes('application/json')) return route.fulfill({ response: res });
    const body = await res.json();
    const sc = body && body.meta ? body : body && body.scenario;
    if (sc && sc.live) Object.assign(sc.live, { demo: 'fresh', onboardStep: step });
    return route.fulfill({ response: res, json: body });
  });
}

test.describe('demo build', () => {
  test.beforeEach(async ({ request }) => { await resetDemo(request); });
  test.afterEach(async ({ request }) => { await resetDemo(request); });

  test('sign-in step: an honest private-network line, no fake passkey @mobile', async ({ page }) => {
    await forceFresh(page, 0);
    await page.goto('/#/onboarding/0');
    const who = page.locator('[data-ob-who]');
    await expect(who).toBeVisible();
    await expect(who).toContainText('private network');
    await expect(who).not.toContainText('Signed in through');
    await expect(page.locator('body')).not.toContainText('passkey');
    await expect(page.locator('body')).not.toContainText('Demo sign-in');
    await expect(page.locator('input[type=email]')).toHaveCount(0);
    await expect(page.locator('form[data-signin]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expectH1(page, 'Dump everything in');
  });

  test('Tell us: the note is saved through ingest and what was understood is shown @mobile', async ({ page, request }) => {
    await forceFresh(page, 1);
    await page.goto('/#/onboarding/1');
    await expectH1(page, 'Dump everything in');
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
    const box = page.locator('textarea[data-dump]');
    await expect(box).toHaveValue('');
    await box.fill(NOTE);
    const saved = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/onboarding/notes' && r.request().method() === 'POST');
    await page.getByRole('button', { name: /Save and read/ }).click();
    const res = await saved;
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.file.parser).toBe('notes');
    const panel = page.locator('[data-understood]');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Saved');
    await expect(box).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
    // It is a real notes file in the store, listed with the others.
    const files = await (await request.get('/api/files')).json();
    expect(files.files.some((f) => /^Setup notes \d{4}-\d{2}-\d{2}\.md$/.test(f.name))).toBe(true);
  });

  test('every step renders, and Here is what we heard lists stored facts with provenance @mobile', async ({ page }) => {
    await forceFresh(page, 3);
    await page.goto('/#/onboarding/3');
    await expectH1(page, 'Here is what we heard');
    const filing = page.locator('[data-heard-item="fact:household.filingStatus"]');
    await expect(filing).toContainText('Married filing jointly');
    await expect(filing).toContainText('From demo scenario');
    await expect(page.locator('[data-heard="accounts"]')).toBeVisible();
    // Nothing from the old hand-written mock content is shown.
    await expect(page.locator('.h-heards')).not.toContainText('Life events');
    // Away from the app, edit goes back to Tell us.
    await filing.getByRole('link', { name: 'Correct in notes' }).click();
    await expectH1(page, 'Dump everything in');
    for (const step of [2, 4, 5]) {
      await page.goto(`/#/onboarding/${step}`);
      await expect(page.locator('.h-ob-card h1')).toBeVisible();
    }
  });
});

/* ---------- part 2: a real store past first run ---------- */

const PORT = Number(process.env.E2E_PORT || 4173) + 10;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = join(REPO, '.e2e-data-onboarding');
const DB_FILE = join(DATA_DIR, 'fathom.sqlite');
const KEY_FILE = join(DATA_DIR, 'data.key');
const OWNER = 'owner@example.test';
let child = null;
let output = '';

async function waitHealthy(ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`onboarding server exited early:\n${output}`);
    try { if ((await fetch(`${BASE}/healthz`)).status === 200) return; } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`onboarding server not healthy after ${ms} ms:\n${output}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// A returning owner: one note file with facts (one of them asked), an entity, an account.
function seedHousehold() {
  const db = openDb(DB_FILE);
  const now = '2026-11-05T12:00:00.000Z';
  try {
    db.prepare("INSERT INTO files (id, name, mime, size, uploaded_at, status) VALUES ('f-e2e-note', 'earlier-notes.md', 'text/markdown', 1, ?, 'imported')").run(now);
    const prov = { fileId: 'f-e2e-note', parser: 'extract-notes' };
    upsertFact(db, { key: 'household.filingStatus', value: 'mfj', provenance: prov, now });
    upsertFact(db, { key: 'household.state', value: 'VA', provenance: prov, now });
    upsertFact(db, { key: 'household.dependents', value: 2, provenance: prov, now });
    upsertFact(db, { key: 'income.sCorp', value: true, confirmed: true, src: 'you', now });
    ask(db, { kind: 'fact_check', subject: 'src|household.dependents|2', question: 'An import says household.dependents is 2. Is that right?', options: FACT_CHECK_OPTIONS, context: { key: 'household.dependents', value: 2 }, fileId: 'f-e2e-note', now });
    db.prepare("INSERT INTO pnl_lines (entity, period, category, amount, file_id, parser) VALUES ('Northwind Advisory', '2026-01', 'Income', 100, 'f-e2e-note', 'pnl-workbook')").run();
    db.prepare("INSERT INTO accounts (id, inst, name, owner, kind, mirror, parser) VALUES ('acct-e2e-ob', 'Synthetic Bank', 'Synthetic Checking', 'owner', 'checking', 'manual', 'e2e')").run();
  } finally {
    db.close();
  }
}

test.describe('real store past first run', () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000); // a busy runner can take a while to start a server
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(KEY_FILE, randomBytes(32), { mode: 0o600 });
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('FATHOM_')) env[k] = v;
    child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: REPO,
      env: { ...env, FATHOM_DEMO: '0', FATHOM_ENGINE: 'off', FATHOM_DATA: DATA_DIR, FATHOM_DATA_KEY_FILE: KEY_FILE, FATHOM_PORT: String(PORT), FATHOM_OWNER_LOGINS: OWNER },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    await waitHealthy(150_000);
    seedHousehold();
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

  test.use({ extraHTTPHeaders: { 'Tailscale-User-Login': OWNER, 'Tailscale-User-Name': 'Test Owner' } });
  // The browser sends the identity header on every request, including cross-origin fonts, whose
  // preflight would refuse it; serve the font hosts locally (empty).
  test.beforeEach(async ({ context }) => {
    await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({
      status: 200, body: '', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
    }));
  });

  test('Setup in More opens Tell us; the note is saved while the engine is off; the heard step lists the household @mobile', async ({ page, request }) => {
    await page.goto(`${BASE}/`);
    await expect(page).toHaveURL(/#\/brief$/);
    await page.locator('.h-more-btn').click();
    const setup = page.locator('.h-more-p a[data-go="onboarding"]', { hasText: 'Setup' });
    await expect(setup).toBeVisible();
    await setup.click();
    await expect(page).toHaveURL(/#\/onboarding\/1$/);
    await expectH1(page, 'Dump everything in');
    await expect(page.locator('.h-ob-steps')).not.toContainText('Sign in');
    await expect(page.locator('body')).not.toContainText('passkey');
    await expect(page.getByRole('link', { name: 'Back to the app' })).toBeVisible();

    // Tell us: saved encrypted, waiting for the engine.
    await page.locator('textarea[data-dump]').fill(NOTE);
    const saved = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/onboarding/notes' && r.request().method() === 'POST');
    await page.getByRole('button', { name: /Save and read/ }).click();
    const res = await saved;
    expect(res.status()).toBe(200);
    expect((await res.json()).file.status).toBe('needs_extraction');
    const panel = page.locator('[data-understood]');
    await expect(panel).toContainText('The engine is off');
    await expect(panel).not.toContainText('Virginia');
    const files = await (await request.get(`${BASE}/api/files`)).json();
    const note = files.files.find((f) => /^Setup notes /.test(f.name));
    expect(note && note.status).toBe('needs_extraction');

    // Accounts step is not ours; continue through it to the heard step.
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page).toHaveURL(/#\/onboarding\/2$/);
    await page.locator('.h-ob-card').getByRole('button', { name: /Continue|Skip for now/ }).click();
    await expect(page).toHaveURL(/#\/onboarding\/3$/);
    await expectH1(page, 'Here is what we heard');
    const state = page.locator('[data-heard-item="fact:household.state"]');
    await expect(state).toContainText('VA');
    await expect(state).toContainText('From earlier-notes.md');
    await expect(page.locator('[data-heard-item="fact:household.filingStatus"]')).toContainText('Married filing jointly');
    await expect(page.locator('[data-heard-item="fact:income.sCorp"]')).toContainText('confirmed by you');
    await expect(page.locator('[data-heard-item="entity:Northwind Advisory"]')).toContainText('From earlier-notes.md');
    await expect(page.locator('[data-heard-item="accounts:checking"]')).toContainText('1');
    await expect(page.locator('[data-heard-item="accounts:checking"]').getByRole('link', { name: 'Edit in Accounts' })).toBeVisible();
    // A value the store does not hold is not shown.
    await expect(page.locator('.h-heards')).not.toContainText('Expecting a child');
    await expect(page.locator('[data-heard-open] b')).toHaveText('1');
    await expect(page.locator('[data-heard-open]')).toContainText('question is still open');

    // The asked fact links to the real Confirm deck.
    await page.locator('[data-heard-item="fact:household.dependents"]').getByRole('link', { name: 'Review in Confirm' }).click();
    await expect(page).toHaveURL(/#\/confirm$/);
  });

  test('Setup finishes back on the brief, and Back to the app leaves at any step', async ({ page }) => {
    await page.goto(`${BASE}/#/onboarding/5`);
    await expect(page.locator('.h-ob-card h1')).toBeVisible();
    await page.getByRole('button', { name: /Back to my brief/ }).click({ timeout: 15_000 });
    await expect(page).toHaveURL(/#\/brief$/);
    await page.goto(`${BASE}/#/onboarding`);
    await expect(page).toHaveURL(/#\/onboarding\/1$/);
    await page.getByRole('link', { name: 'Back to the app' }).click();
    await expect(page).toHaveURL(/#\/brief$/);
  });
});
