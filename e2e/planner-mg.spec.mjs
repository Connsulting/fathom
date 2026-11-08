// Missing salary range keeps its war game as history; tax estimates continue with named gaps.

import { test, expect } from './helpers.mjs';
import { createLocalData, removeLocalData, startEnrolledServer } from './local-store.mjs';

let DIR;
const CLOCK = '2026-11-05';
const REMOTE = !!(process.env.BASE_URL || process.env.FATHOM_SMOKE_BASE_URL);
const ADVISOR = 'Lee & Park <img src=x onerror=alert(1)>';
const THREAD_REC = 'fed-q4-estimate';
const THREAD_KEY = 'ask:0f0e0d0c0b0a';
const AGI_NOTE = 'Adjusted gross income stands in for modified adjusted gross income.';

let app = null;
let base = '';
let scenario = null;
let plain = (s) => String(s ?? '');

async function go(page, route) {
  await page.goto(`${base}/#/${route}`);
  await expect(page.locator('header.h-top')).toBeVisible();
}

// The first rec on the plan whose grounded figures include one matching `want`.
function recWithFigure(want) {
  for (const r of scenario.recs) {
    if (r.status === 'hidden') continue;
    const m = (r.mine || []).find((x) => scenario.fig[x.fig] && want(scenario.fig[x.fig]));
    if (m) return { rec: r, key: m.fig };
  }
  return null;
}

test.skip(REMOTE, 'needs a local real-mode server; BASE_URL targets a remote one');
test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ context }) => {
  await app.authenticate(context);
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({
    status: 200, body: '', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
  }));
});

test.beforeAll(async () => {
  const { buildRealStore, addFact, removeFact, accountIdByMask, MASKS } = await import('../test/helpers/real-store.mjs');
  const { planRun } = await import('../test/helpers/plan.mjs');
  const { resolveTokens } = await import('../src/shared/tokens.mjs');

  DIR = createLocalData('planner-mg');
  const db = await buildRealStore(DIR, { clock: CLOCK, variant: { facts: { 'household.names': { advisor: ADVISOR } } } });
  try {
    expect((await planRun(db, { now: CLOCK, dataDir: DIR })).status).toBe('ok');
    // A conversation asked from the rec is an Ask thread carrying the rec as its context.
    await db.prepare('INSERT INTO conversations (key, created_at, last_at, rec_id) VALUES (?, ?, ?, ?)')
      .run(THREAD_KEY, `${CLOCK}T09:00:00.000Z`, `${CLOCK}T10:00:00.000Z`, THREAD_REC);
    await db.prepare("INSERT INTO messages (conversation_key, role, text, refs, notice, ts) VALUES (?, 'me', ?, '[]', 0, ?)")
      .run(THREAD_KEY, 'Synthetic owner question for this check.', `${CLOCK}T09:00:00.000Z`);
    await db.prepare("INSERT INTO messages (conversation_key, role, text, refs, notice, ts) VALUES (?, 'advisor', ?, '[]', 0, ?)")
      .run(THREAD_KEY, '<p>Synthetic advisor note for this check.</p>', `${CLOCK}T10:00:00.000Z`);
    const collegeId = accountIdByMask(db, MASKS.college);
    addFact(db, 'accounts.va529', { [collegeId]: { virginiaPlan: true } });
    addFact(db, 'accounts.va529CarryforwardDefault', { [collegeId]: { undone: true } });
    removeFact(db, 'business.salaryRange');
    expect((await planRun(db, { now: CLOCK, dataDir: DIR })).status).toBe('ok');
  } finally {
    await db.close();
  }
  app = await startEnrolledServer({ dataDir: DIR, clock: CLOCK });
  base = app.url;
  const res = await fetch(`${base}/api/scenario`, { headers: app.headers });
  expect(res.status).toBe(200);
  scenario = await res.json();
  plain = (s) => resolveTokens(scenario, s, false);
});

test.afterAll(async () => {
  if (app) await app.close();
  app = null;
  removeLocalData(DIR);
});

test('MG14: markup and an ampersand in the advisor name show as literal text in a rec conversation', async ({ page }) => {
  expect(scenario.names.advisor).toBe(ADVISOR);
  await go(page, `rec/${THREAD_REC}`);
  const dlg = page.locator('.h-dlg[role="dialog"]');
  await expect(dlg).toBeVisible();
  const who = dlg.locator('.h-thread .h-msg.advisor .h-msg-who');
  await expect(who).toHaveCount(1);
  await expect(who).toContainText(ADVISOR);
  expect(await who.textContent()).not.toContain('&amp;');
  await expect(page.locator('.h-thread img')).toHaveCount(0);
});

test('MG12: an unavailable war game is listed as history on Decide and cannot be picked', async ({ page }) => {
  const dec = scenario.decisions.find((d) => d.id === 'salary-2026');
  expect(dec, 'the salary decision is kept').toBeTruthy();
  expect(dec.status).toBe('unavailable');
  expect(typeof dec.unavailable).toBe('string');
  expect(scenario.wargame.salary.status).toBe('unavailable');

  await go(page, 'wargame');
  await expect(page.getByRole('heading', { level: 1, name: 'What is open, and what is coming', exact: true })).toBeVisible();
  await expect(page.locator('article.h-dec.open', { hasText: plain(dec.title) })).toHaveCount(0);
  const history = page.locator('details', { hasText: 'No longer current' });
  await expect(history).toHaveCount(1);
  await history.locator('summary').click();
  const row = history.locator('article.h-dec', { hasText: plain(dec.title) });
  await expect(row).toBeVisible();
  await expect(row).toContainText(plain(dec.unavailable));
  await expect(row.getByRole('link', { name: 'See the history' })).toBeVisible();
  await expect(row.getByRole('link', { name: 'War game', exact: true })).toHaveCount(0);

  const pick = await fetch(`${base}/api/wargame/salary/pick`, {
    method: 'POST', headers: { ...app.headers, 'content-type': 'application/json' }, body: JSON.stringify({ index: 0 }),
  });
  expect(pick.status).toBe(409);
});

test('MG12: a current tax figure popover names the precision gap and its fix', async ({ page }) => {
  expect(scenario.fig['sh.va.remaining'].gaps.some(g => g.code === 'va529_answers_missing')).toBe(true);
  const found = recWithFigure(f => f.gaps?.some(g => g.code === 'va529_answers_missing'));
  expect(found).toBeTruthy();
  await go(page, `rec/${found.rec.id}`);
  const fig = page.locator(`.h-dlg .h-mine .fx-fig[data-fig="${found.key}"]`);
  await expect(fig).not.toHaveAttribute('data-unavailable', '1');
  await fig.click();
  const pop = page.locator('.fx-pop');
  await expect(pop).toContainText('Completeness');
  await expect(pop).toContainText(/estimate with/);
  await expect(pop.getByRole('button', { name: 'Enter college savings details' })).toBeVisible();
});

test('MGN1: a figure popover shows its readable assumption', async ({ page }) => {
  const found = recWithFigure((f) => !f.unavailable && Array.isArray(f.notes) && f.notes.includes(AGI_NOTE));
  expect(found, 'a rec on the plan cites a figure with the AGI note').toBeTruthy();
  await go(page, `rec/${found.rec.id}`);
  await page.locator(`.h-dlg .h-mine .fx-fig[data-fig="${found.key}"]`).click();
  const pop = page.locator('.fx-pop');
  await expect(pop).toBeVisible();
  const row = pop.locator('.fx-pop-row', { hasText: AGI_NOTE });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.fx-pop-k')).toHaveText('Assumes');
  await expect(pop.locator('.fx-pop-row', { hasText: 'Not current' })).toHaveCount(0);
});
