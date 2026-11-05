// Merge-gate fix round, the human-visible outcomes on a real-mode store. beforeAll builds the
// synthetic household in .e2e-data-planner-mg with an advisor name that carries markup and an
// ampersand, plans it, adds an advisor message to a rec conversation, then leaves the Virginia
// 529 answers incomplete and plans again, so both war games and the Virginia targets go
// unavailable while staying on file. The server runs in process on an ephemeral port (port 0),
// so it never collides with another spec's server. Skipped when BASE_URL targets a remote server.

import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from './helpers.mjs';

const DIR = fileURLToPath(new URL('../.e2e-data-planner-mg/', import.meta.url));
const CLOCK = '2026-11-05';
const REMOTE = !!process.env.BASE_URL;
const ADVISOR = 'Lee & Park <img src=x onerror=alert(1)>';
const THREAD_REC = 'fed-q4-estimate';
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

test.beforeAll(async () => {
  const { buildRealStore, addFact, accountIdByMask, MASKS } = await import('../test/helpers/real-store.mjs');
  const { runPlanning } = await import('../src/jobs/planner.mjs');
  const { startServer } = await import('../src/server.mjs');
  const { loadConfig } = await import('../src/config.mjs');
  const { resolveTokens } = await import('../src/shared/tokens.mjs');

  rmSync(DIR, { recursive: true, force: true });
  const db = await buildRealStore(DIR, { clock: CLOCK, variant: { facts: { 'household.names': { advisor: ADVISOR } } } });
  try {
    expect((await runPlanning(db, null, { now: CLOCK })).status).toBe('ok');
    db.prepare('INSERT OR IGNORE INTO conversations (key, created_at) VALUES (?, ?)').run(THREAD_REC, `${CLOCK}T09:00:00.000Z`);
    db.prepare("INSERT INTO messages (conversation_key, role, text, refs, notice, ts) VALUES (?, 'advisor', ?, '[]', 0, ?)")
      .run(THREAD_REC, '<p>Synthetic advisor note for this check.</p>', `${CLOCK}T10:00:00.000Z`);
    addFact(db, 'accounts.va529', { [accountIdByMask(db, MASKS.college)]: { virginiaPlan: true, ownerAge70Plus: false } });
    expect((await runPlanning(db, null, { now: CLOCK })).status).toBe('ok');
  } finally {
    db.close();
  }
  app = await startServer({ ...loadConfig({ FATHOM_DATA: DIR, FATHOM_DEMO: '0', FATHOM_ENGINE: 'off', FATHOM_CLOCK: CLOCK }), port: 0 });
  base = app.url;
  const res = await fetch(`${base}/api/scenario`);
  expect(res.status).toBe(200);
  scenario = await res.json();
  plain = (s) => resolveTokens(scenario, s, false);
});

test.afterAll(async () => {
  if (app) await app.close();
  app = null;
  rmSync(DIR, { recursive: true, force: true });
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
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index: 0 }),
  });
  expect(pick.status).toBe(409);
});

test('MG12: a retained figure popover says it is not current and why', async ({ page }) => {
  expect(scenario.fig['sh.va.remaining'] && scenario.fig['sh.va.remaining'].unavailable).toMatch(/\S/);
  const found = recWithFigure((f) => typeof f.unavailable === 'string' && f.unavailable.length > 0);
  expect(found, 'a rec on the plan cites a retained figure').toBeTruthy();
  await go(page, `rec/${found.rec.id}`);
  const fig = page.locator(`.h-dlg .h-mine .fx-fig[data-fig="${found.key}"]`);
  await expect(fig).toHaveAttribute('data-unavailable', '1');
  await fig.click();
  const pop = page.locator('.fx-pop');
  await expect(pop).toBeVisible();
  const row = pop.locator('.fx-pop-row', { hasText: 'Not current' });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.fx-pop-v')).toHaveText(scenario.fig[found.key].unavailable);
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
