// Guided product tour: a short walk through the main screens, one callout per stop, declared in
// TOUR_STOPS (web/horizon/screens/tour.js). On a public demo server it starts on its own once per
// browser; on the private demo server (the config's baseURL) it starts only from Settings or the
// quick switcher. The public demo server runs in-process here, like e2e/public-demo.spec.mjs, and
// every browser context on it is a fresh sandbox.
// Tags: @tour-ac1 the walk, a missing anchor (including a missing last stop) and the Ask panel the
// Ask stop opens and closes, @tour-ac2 layout, dialog semantics, keys and focus at desktop and
// phone width (including starting over an open dialog and focus back on a redrawn opener), @tour-ac3 auto-start once and restart, @tour-ac4 every anchor
// renders, @tour-ac5 Skip and Escape end the tour. Every test runs in the desktop project only; the
// phone blocks set their own viewport.
// The shared page fixture fails on any console error. One test forces the P&L read to fail and the
// browser logs that load, so this spec uses the base test with the same checks, allowing failed
// loads of the P&L endpoint only in the test that opts in with allowPnlFailure.

import { test as base } from '@playwright/test';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, resetDemo, gotoRoute } from './helpers.mjs';
import { loadConfig } from '../src/config.mjs';
import { startServer } from '../src/server.mjs';
import { TOUR_STOPS } from '../web/horizon/screens/tour.js';

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const PNL_PATH = /^\/api\/pnl(\/|$)/;

const test = base.extend({
  allowPnlFailure: [false, { option: true }],
  page: async ({ page, allowPnlFailure }, use) => {
    const problems = [];
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        console.error(`securitypolicyviolation: ${e.violatedDirective} blocked ${e.blockedURI || 'inline'} at ${e.sourceFile || ''}:${e.lineNumber || 0}`);
      });
    });
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const url = (msg.location() && msg.location().url) || '';
      let path = '';
      try { path = url ? new URL(url).pathname : ''; } catch { path = ''; }
      if (/Failed to load resource/.test(msg.text())) {
        if (FONT_HOSTS.some((h) => url.startsWith(`https://${h}/`))) return;
        if (allowPnlFailure && PNL_PATH.test(path)) return;
      }
      problems.push(`console error: ${msg.text()}${url ? ` (${url})` : ''}`);
    });
    page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
    await use(page);
    expect(problems, 'console errors, page errors or CSP violations').toEqual([]);
  }
});

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true };
const N = TOUR_STOPS.length;
const STEP_WAIT = 20_000;
const COUNT_RE = /^(\d+) of (\d+)$/;
const TOUR_DONE = 'fathom.tour.done';

/* ---------- locators ---------- */

const dialog = (page) => page.locator('.h-tour[role="dialog"]');
const countEl = (page) => dialog(page).locator('[data-tour-count]');
const tourBtn = (page, k) => dialog(page).locator(`[data-tour="${k}"]`);
const anchorOn = (page) => page.locator('[data-tour-on]');
const startBtn = (page) => page.locator('[data-tour-start]');

/* ---------- helpers ---------- */

// The route name in the URL hash; no hash is Home.
const hashRoute = (page) => new URL(page.url()).hash.replace(/^#\/?/, '').split('/')[0] || 'home';

async function homeReady(page) {
  await expect(page.locator('header.h-top')).toBeVisible({ timeout: STEP_WAIT });
  await expect(page.locator('section.h-home')).toBeVisible({ timeout: STEP_WAIT });
}

// One read of the open dialog: its stop id and count text, taken in one page turn.
function snap(page) {
  return page.evaluate(() => {
    const d = document.querySelector('.h-tour[role="dialog"]');
    if (!d) return null;
    const c = d.querySelector('[data-tour-count]');
    return { id: d.getAttribute('data-tour-stop'), count: c ? c.textContent.trim() : '' };
  });
}

// Waits for the dialog to show a stop other than `prev` (null: any stop) and returns
// { id, k, of } read from data-tour-stop and the "k of N" count.
async function stopAfter(page, prev) {
  let seen = null;
  await expect.poll(async () => {
    const s = await snap(page);
    if (!s || !s.id || s.id === prev) return null;
    const m = COUNT_RE.exec(s.count);
    if (!m) return null;
    seen = { id: s.id, k: Number(m[1]), of: Number(m[2]) };
    return s.id;
  }, { timeout: STEP_WAIT, message: prev ? `the tour moves off ${prev}` : 'the tour shows a stop' }).not.toBeNull();
  await expect(dialog(page)).toHaveCount(1);
  await expect(dialog(page)).toBeVisible();
  return seen;
}

async function startFromSettings(page) {
  await gotoRoute(page, 'settings');
  await expect(startBtn(page)).toHaveText('Take the tour');
  await startBtn(page).click();
  const first = await stopAfter(page, null);
  expect(first, 'the tour opens on the first stop').toMatchObject({ id: TOUR_STOPS[0].id, k: 1, of: N });
  return first;
}

// The callout shows the stop's copy, the count and the buttons for its place in the walk.
async function checkCallout(page, stop, cur) {
  const d = dialog(page);
  await expect(d.locator('#h-tour-t')).toHaveText(stop.title);
  await expect(d.locator('#h-tour-b')).toHaveText(stop.body);
  expect((await d.locator('#h-tour-t').textContent()).trim().length, 'title is not blank').toBeGreaterThan(0);
  expect((await d.locator('#h-tour-b').textContent()).trim().length, 'body is not blank').toBeGreaterThan(0);
  await expect(countEl(page)).toHaveText(`${cur.k} of ${cur.of}`);
  await expect(tourBtn(page, 'back')).toBeVisible();
  if (cur.k === 1) await expect(tourBtn(page, 'back')).toBeDisabled();
  else await expect(tourBtn(page, 'back')).toBeEnabled();
  if (cur.k < cur.of) {
    await expect(tourBtn(page, 'next')).toBeVisible();
    await expect(tourBtn(page, 'skip')).toBeVisible();
    await expect(tourBtn(page, 'done')).toHaveCount(0);
  } else {
    await expect(tourBtn(page, 'done')).toBeVisible();
    await expect(tourBtn(page, 'done')).toHaveText('Done');
    await expect(tourBtn(page, 'next')).toHaveCount(0);
  }
}

async function boxOf(locator) {
  try { return await locator.boundingBox({ timeout: 2000 }); } catch { return null; }
}

// '' when the callout sits inside the viewport, clear of the marked anchor, and the anchor is at
// least partly in view; otherwise what is wrong. 1px tolerance on every edge.
async function layoutProblem(page) {
  const view = page.viewportSize();
  const marked = await anchorOn(page).count();
  if (marked !== 1) return `${marked} elements carry data-tour-on`;
  const c = await boxOf(dialog(page));
  const a = await boxOf(anchorOn(page));
  if (!c) return 'the callout has no box';
  if (!a) return 'the anchor has no box';
  const r = (b) => `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`;
  if (c.x < -1 || c.y < -1 || c.x + c.width > view.width + 1 || c.y + c.height > view.height + 1) {
    return `callout ${r(c)} leaves the ${view.width}x${view.height} viewport`;
  }
  const overlap = c.x < a.x + a.width - 1 && a.x < c.x + c.width - 1 && c.y < a.y + a.height - 1 && a.y < c.y + c.height - 1;
  if (overlap) return `callout ${r(c)} covers anchor ${r(a)}`;
  if (a.y >= view.height || a.y + a.height <= 0 || a.x >= view.width || a.x + a.width <= 0) return `anchor ${r(a)} is out of view`;
  return '';
}

// Dialog semantics, focus, route and layout for the stop on screen.
async function checkStop(page, stop) {
  const d = dialog(page);
  await expect(d).toHaveAttribute('aria-modal', 'true');
  const labelId = await d.getAttribute('aria-labelledby');
  const descId = await d.getAttribute('aria-describedby');
  expect(labelId, 'aria-labelledby is set').toBeTruthy();
  expect(descId, 'aria-describedby is set').toBeTruthy();
  await expect(d.locator(`[id="${labelId}"]`)).toHaveText(stop.title);
  await expect(d.locator(`[id="${descId}"]`)).toHaveText(stop.body);
  await expect(page.locator(`[id="${labelId}"]`)).toHaveCount(1);
  await expect(page.locator(`[id="${descId}"]`)).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => !!(document.activeElement && document.activeElement.closest('.h-tour[role="dialog"]'))),
    { timeout: STEP_WAIT, message: `focus is inside the callout on ${stop.id}` }).toBe(true);
  await expect.poll(() => hashRoute(page), { timeout: STEP_WAIT, message: `route for ${stop.id}` }).toBe(stop.route);
  await expect.poll(() => layoutProblem(page), { timeout: STEP_WAIT, message: `layout on ${stop.id}` }).toBe('');
}

const shotPath = (label, stop) => {
  const nn = String(TOUR_STOPS.indexOf(stop) + 1).padStart(2, '0');
  return resolve('test-results', 'tour', `${label}-${nn}-${stop.id}.png`);
};

const inertState = (page) => page.evaluate(() => ['.h-root', '.h-dlg-host', '.h-askp-host'].map((s) => {
  const el = document.querySelector(s);
  return el ? !!(el.inert || el.hasAttribute('inert')) : null;
}));

const tourDone = (page) => page.evaluate((k) => { try { return localStorage.getItem(k); } catch { return 'unreadable'; } }, TOUR_DONE);

/* ---------- AC2 walk, shared by the desktop and phone blocks ---------- */

async function walkEveryStop(page, label) {
  test.setTimeout(300_000);
  const posts = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && /^\/api\/confirm\//.test(new URL(req.url()).pathname)) posts.push(new URL(req.url()).pathname);
  });
  let cur = await startFromSettings(page);
  for (let i = 0; i < N; i++) {
    const stop = TOUR_STOPS[i];
    expect(cur, `stop ${i + 1}`).toMatchObject({ id: stop.id, k: i + 1, of: N });
    await checkCallout(page, stop, cur);
    await checkStop(page, stop);
    await checkAskPanel(page, stop.id);
    await page.screenshot({ path: shotPath(label, stop) });

    if (i === 1) {
      // ArrowLeft goes back one stop; Enter comes forward again.
      await page.keyboard.press('ArrowLeft');
      const back = await stopAfter(page, stop.id);
      expect(back, 'ArrowLeft goes back').toMatchObject({ id: TOUR_STOPS[0].id, k: 1, of: N });
      await checkStop(page, TOUR_STOPS[0]);
      await page.keyboard.press('Enter');
      const again = await stopAfter(page, TOUR_STOPS[0].id);
      expect(again, 'Enter advances').toMatchObject({ id: stop.id, k: 2, of: N });
      await checkStop(page, stop);
    }

    if (stop.route === 'confirm') {
      // The deck's own keys (1 to 9 pick, Enter takes the best guess) never reach the deck.
      const card = page.locator('article.h-deck-card.cur');
      const item = (await card.count()) === 1 ? await card.getAttribute('data-item') : null;
      await page.keyboard.press('1');
      await expect(dialog(page)).toHaveAttribute('data-tour-stop', stop.id);
      await expect(countEl(page)).toHaveText(`${i + 1} of ${N}`);
      if (item != null) await expect(page.locator('article.h-deck-card.cur')).toHaveAttribute('data-item', item);
      expect(posts, 'no Confirm answer after 1').toEqual([]);
    }

    if (i === N - 1) {
      await page.keyboard.press('Enter');
      await expect(dialog(page)).toHaveCount(0, { timeout: STEP_WAIT });
      break;
    }
    const key = stop.route === 'confirm' || i % 2 === 1 ? 'Enter' : 'ArrowRight';
    await page.keyboard.press(key);
    cur = await stopAfter(page, stop.id);
  }
  await expect(anchorOn(page)).toHaveCount(0);
  await expect(page.locator('#h-askp'), 'the Ask panel the tour opened is closed after Done').toHaveCount(0, { timeout: STEP_WAIT });
  await expect.poll(() => hashRoute(page), { timeout: STEP_WAIT, message: 'Done returns to the start route' }).toBe('settings');
  expect(await tourDone(page)).toBe('1');
  expect(posts, 'no Confirm answer was posted during the walk').toEqual([]);
}

// The Ask stop shows the Ask side panel; every other stop has it closed again.
async function checkAskPanel(page, stopId) {
  const panel = page.locator('#h-askp');
  if (stopId === 'ask') await expect(panel, 'the Ask stop opens the Ask panel').toBeVisible({ timeout: STEP_WAIT });
  else await expect(panel, `the Ask panel is closed on ${stopId}`).toHaveCount(0, { timeout: STEP_WAIT });
}

async function focusReturns(page) {
  await gotoRoute(page, 'settings');
  await expect(startBtn(page)).toHaveText('Take the tour');
  await startBtn(page).focus();
  await page.keyboard.press('Enter');
  const first = await stopAfter(page, null);
  expect(first).toMatchObject({ id: TOUR_STOPS[0].id, k: 1, of: N });
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0, { timeout: STEP_WAIT });
  await expect.poll(() => hashRoute(page), { timeout: STEP_WAIT }).toBe('settings');
  await expect(startBtn(page)).toBeFocused({ timeout: STEP_WAIT });
}

async function everyAnchorRenders(page) {
  test.setTimeout(180_000);
  for (const stop of TOUR_STOPS.filter((s) => !s.optional)) {
    await gotoRoute(page, stop.route);
    await expect(page.locator(stop.anchor).filter({ visible: true }).first(), `${stop.id}: ${stop.anchor} on #/${stop.route}`)
      .toBeVisible({ timeout: 10_000 });
  }
}

/* ---------- public demo server (auto-start) ---------- */

test.describe('tour on a public demo', () => {
  const port = Number(process.env.E2E_TOUR_PUBLIC_PORT || 5051);
  const origin = `http://localhost:${port}`;
  const data = resolve('.e2e-data-tourpub');
  let app;
  test.use({ baseURL: origin, viewport: DESKTOP });

  test.beforeAll(async () => {
    rmSync(data, { recursive: true, force: true });
    app = await startServer(loadConfig({ FATHOM_PUBLIC_DEMO: '1', FATHOM_DEMO: '1',
      FATHOM_PUBLIC_URL: origin, FATHOM_PORT: String(port), FATHOM_PUBLIC_DEMO_DATA: data,
      FATHOM_DATA: data, FATHOM_ENGINE: 'fake', FATHOM_FAKE_STREAM_MS: '0',
      FATHOM_PUBLIC_DEMO_CREATIONS_PER_IP_PER_DAY: '100', FATHOM_PUBLIC_DEMO_REQUESTS_PER_MINUTE: '10000' }));
  });
  test.afterAll(async () => { await app?.close(); rmSync(data, { recursive: true, force: true }); });

  test('@tour-ac1 the tour starts on first load and walks every stop in table order to Done', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/');
    await homeReady(page);
    let cur = await stopAfter(page, null);
    expect(cur, 'auto-started on the first stop').toMatchObject({ id: TOUR_STOPS[0].id, k: 1, of: N });
    const visited = [];
    for (let guard = 0; guard < N + 2; guard++) {
      const stop = TOUR_STOPS.find((s) => s.id === cur.id);
      expect(stop, `a known stop: ${cur.id}`).toBeTruthy();
      visited.push(cur.id);
      expect(cur.k, `count on ${cur.id}`).toBe(visited.length);
      expect(cur.of, 'no stop is missing on a fresh sandbox').toBe(N);
      await checkCallout(page, stop, cur);
      await checkAskPanel(page, cur.id);
      if (cur.k === cur.of) break;
      await tourBtn(page, 'next').click();
      cur = await stopAfter(page, cur.id);
    }
    expect(visited, 'every stop, in TOUR_STOPS order').toEqual(TOUR_STOPS.map((s) => s.id));
    expect(cur.k).toBe(N);
    await tourBtn(page, 'done').click();
    await expect(dialog(page)).toHaveCount(0, { timeout: STEP_WAIT });
    expect(await tourDone(page)).toBe('1');
  });

  test('@tour-ac3 the tour starts once: Escape, reload, and it stays closed', async ({ page }) => {
    await page.goto('/');
    await homeReady(page);
    const first = await stopAfter(page, null);
    expect(first).toMatchObject({ id: TOUR_STOPS[0].id, k: 1, of: N });
    await expect(countEl(page)).toHaveText(`1 of ${N}`);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0, { timeout: STEP_WAIT });
    await page.reload();
    await homeReady(page);
    await page.waitForTimeout(1000);
    await expect(page.locator('.h-tour')).toHaveCount(0);
    expect(await tourDone(page)).toBe('1');
  });
});

/* ---------- private demo server (the config's baseURL, never auto-starts) ---------- */

test.describe('tour on the private demo, desktop', () => {
  test.use({ viewport: DESKTOP });
  test.beforeEach(async ({ request }) => { await resetDemo(request); });

  test('@tour-ac3 the private demo never auto-starts; Settings and the quick switcher start it', async ({ page }) => {
    await page.goto('/');
    await homeReady(page);
    await page.waitForTimeout(1000);
    await expect(page.locator('.h-tour')).toHaveCount(0);

    await startFromSettings(page);
    await expect(countEl(page)).toHaveText(`1 of ${N}`);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0, { timeout: STEP_WAIT });
    await expect.poll(() => hashRoute(page), { timeout: STEP_WAIT }).toBe('settings');

    await page.keyboard.press('Control+K');
    const input = page.locator('input.h-qs-in');
    await expect(input).toBeFocused({ timeout: STEP_WAIT });
    await page.keyboard.type('take the tour');
    const row = page.locator('#h-qs-list li.h-qs-o[data-qs-key="act:tour"]');
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    const first = await stopAfter(page, null);
    expect(first, 'the switcher action opens the first stop').toMatchObject({ id: TOUR_STOPS[0].id, k: 1 });
    await expect(countEl(page)).toHaveText(`1 of ${N}`);
  });

  test.describe('with the P&L read failing', () => {
    test.use({ allowPnlFailure: true });

    test('@tour-ac1 a stop whose anchor never renders is skipped and the count closes at N-1 of N-1', async ({ page }) => {
      test.setTimeout(240_000);
      await page.route((url) => PNL_PATH.test(url.pathname), (route) => route.fulfill({
        status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'forced failure' })
      }));
      const missing = TOUR_STOPS.filter((s) => s.route === 'pnl').map((s) => s.id);
      expect(missing.length, 'the table has a P&L stop').toBeGreaterThan(0);
      const expected = TOUR_STOPS.filter((s) => s.route !== 'pnl').map((s) => s.id);
      let cur = await startFromSettings(page);
      const visited = [];
      for (let guard = 0; guard < N + 2; guard++) {
        const stop = TOUR_STOPS.find((s) => s.id === cur.id);
        expect(stop, `a known stop: ${cur.id}`).toBeTruthy();
        visited.push(cur.id);
        expect(cur.k, `count on ${cur.id}`).toBe(visited.length);
        await checkCallout(page, stop, cur);
        if (cur.k === cur.of) break;
        await tourBtn(page, 'next').click();
        cur = await stopAfter(page, cur.id);
      }
      for (const id of missing) expect(visited, `${id} never shows`).not.toContain(id);
      expect(visited, 'every other stop, in order').toEqual(expected);
      expect(cur).toMatchObject({ k: N - missing.length, of: N - missing.length });
      await expect(countEl(page)).toHaveText(`${N - missing.length} of ${N - missing.length}`);
      await tourBtn(page, 'done').click();
      await expect(dialog(page)).toHaveCount(0, { timeout: STEP_WAIT });
    });
  });

  test('@tour-ac1 a last stop whose anchor is missing hands Done back to the stop before it at N-1 of N-1', async ({ page }) => {
    test.setTimeout(240_000);
    await page.route('**/api/scenario', async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.packs = [];
      await route.fulfill({ response, json });
    });
    const missing = TOUR_STOPS.filter((s) => s.route === 'packs').map((s) => s.id);
    expect(missing.length, 'the table has a packs stop').toBeGreaterThan(0);
    const lastIdx = TOUR_STOPS.findIndex((s) => s.route === 'packs') - 1;
    expect(lastIdx, 'a stop comes before packs').toBeGreaterThanOrEqual(0);
    const lastStop = TOUR_STOPS[lastIdx];
    expect(lastStop.id).toBe('add-context');
    let cur = await startFromSettings(page);
    const visited = [];
    for (let guard = 0; guard < N + 2; guard++) {
      visited.push(cur.id);
      if (cur.id === lastStop.id) break;
      await tourBtn(page, 'next').click();
      cur = await stopAfter(page, cur.id);
    }
    expect(cur.id, 'the walk reaches the stop before packs').toBe(lastStop.id);
    await expect(countEl(page)).toHaveText(`${N - 1} of ${N}`);
    // Next looks for the packs anchor, finds none, and comes back here as the last stop.
    await tourBtn(page, 'next').click();
    await expect(countEl(page)).toHaveText(`${N - 1} of ${N - 1}`, { timeout: STEP_WAIT });
    await expect(dialog(page)).toHaveAttribute('data-tour-stop', lastStop.id);
    for (const id of missing) await expect(dialog(page), `${id} never shows`).not.toHaveAttribute('data-tour-stop', id);
    await expect(tourBtn(page, 'done')).toBeVisible();
    await expect(tourBtn(page, 'done')).toHaveText('Done');
    await expect(tourBtn(page, 'next')).toHaveCount(0);
    await tourBtn(page, 'done').click();
    await expect(dialog(page)).toHaveCount(0, { timeout: STEP_WAIT });
  });

  test('@tour-ac2 desktop: a recommendation dialog open over Home gives way to the tour, which starts outside it', async ({ page }) => {
    await gotoRoute(page, 'home');
    await homeReady(page);
    await page.locator('section.h-home a[data-go="rec"]').first().click();
    await expect(page.locator('.h-dlg-host')).toBeVisible({ timeout: STEP_WAIT });
    await page.keyboard.press('Control+K');
    await expect(page.locator('input.h-qs-in')).toBeFocused({ timeout: STEP_WAIT });
    await page.keyboard.type('take the tour');
    await expect(page.locator('#h-qs-list li.h-qs-o[data-qs-key="act:tour"]')).toBeVisible();
    await page.keyboard.press('Enter');
    const first = await stopAfter(page, null);
    expect(first, 'the tour opens on the first stop').toMatchObject({ id: TOUR_STOPS[0].id, k: 1, of: N });
    await expect(page.locator('.h-dlg-host')).toBeHidden({ timeout: STEP_WAIT });
    await expect(anchorOn(page)).toHaveCount(1);
    await expect(page.locator('.h-dlg-host [data-tour-on]'), 'the anchor is not inside the dialog host').toHaveCount(0);
    await expect.poll(() => layoutProblem(page), { timeout: STEP_WAIT, message: 'layout with the dialog closed' }).toBe('');
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0, { timeout: STEP_WAIT });
    await expect(anchorOn(page)).toHaveCount(0);
  });

  test('@tour-ac2 desktop: Escape returns focus to the header search button redrawn on another page', async ({ page }) => {
    await gotoRoute(page, 'money');
    await expect(page.locator('.h-search-btn')).toBeVisible({ timeout: STEP_WAIT });
    await page.locator('.h-search-btn').click();
    await expect(page.locator('input.h-qs-in')).toBeFocused({ timeout: STEP_WAIT });
    await page.keyboard.type('take the tour');
    await expect(page.locator('#h-qs-list li.h-qs-o[data-qs-key="act:tour"]')).toBeVisible();
    await page.keyboard.press('Enter');
    const first = await stopAfter(page, null);
    expect(first).toMatchObject({ id: TOUR_STOPS[0].id, k: 1, of: N });
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0, { timeout: STEP_WAIT });
    await expect.poll(() => hashRoute(page), { timeout: STEP_WAIT }).toBe('money');
    await expect(page.locator('.h-search-btn')).toBeFocused({ timeout: STEP_WAIT });
  });

  test('@tour-ac2 desktop: every stop is laid out clear of its anchor, keyboard driven, with no Confirm answer', async ({ page }) => {
    await walkEveryStop(page, 'desktop');
  });

  test('@tour-ac2 desktop: Escape returns focus to Take the tour on Settings', async ({ page }) => {
    await focusReturns(page);
  });

  test('@tour-ac4 desktop: every stop anchor renders on its route', async ({ page }) => {
    await everyAnchorRenders(page);
  });

  test('@tour-ac5 Skip ends the tour and leaves the page interactive', async ({ page }) => {
    await startFromSettings(page);
    expect(await inertState(page), 'the page is inert behind the tour').toEqual([true, true, true]);
    await tourBtn(page, 'skip').click();
    await expect(dialog(page)).toHaveCount(0, { timeout: STEP_WAIT });
    await expect(page.locator('.h-tour-spot')).toHaveCount(0);
    await expect(anchorOn(page)).toHaveCount(0);
    await expect.poll(() => inertState(page), { timeout: STEP_WAIT }).toEqual([false, false, false]);
    await expect.poll(() => hashRoute(page), { timeout: STEP_WAIT }).toBe('settings');
    expect(await tourDone(page)).toBe('1');
    await page.locator('.h-set a[data-go="connect"]').click();
    await expect.poll(() => hashRoute(page), { timeout: STEP_WAIT, message: 'a page link works after Skip' }).toBe('connect');
  });

  test('@tour-ac5 Escape mid-walk on another route ends the tour and returns to the start route', async ({ page }) => {
    test.setTimeout(180_000);
    const target = TOUR_STOPS.findIndex((s, i) => i >= 2 && s.route !== 'settings' && s.route !== TOUR_STOPS[0].route);
    expect(target, 'a later stop on another route').toBeGreaterThan(0);
    let cur = await startFromSettings(page);
    for (let i = 0; i < target; i++) {
      await tourBtn(page, 'next').click();
      cur = await stopAfter(page, cur.id);
    }
    expect(cur.id).toBe(TOUR_STOPS[target].id);
    await expect.poll(() => hashRoute(page), { timeout: STEP_WAIT }).toBe(TOUR_STOPS[target].route);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0, { timeout: STEP_WAIT });
    await expect(anchorOn(page)).toHaveCount(0);
    await expect.poll(() => hashRoute(page), { timeout: STEP_WAIT, message: 'back on the start route' }).toBe('settings');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings', exact: true })).toBeVisible();
    await expect.poll(() => inertState(page), { timeout: STEP_WAIT }).toEqual([false, false, false]);
  });
});

test.describe('tour on the private demo, phone', () => {
  test.use(PHONE);
  test.beforeEach(async ({ request }) => { await resetDemo(request); });

  test('@tour-ac2 phone: every stop is laid out clear of its anchor, keyboard driven, with no Confirm answer', async ({ page }) => {
    await walkEveryStop(page, 'phone');
  });

  test('@tour-ac2 phone: Escape returns focus to Take the tour on Settings', async ({ page }) => {
    await focusReturns(page);
  });

  test('@tour-ac4 phone: every stop anchor renders on its route', async ({ page }) => {
    await everyAnchorRenders(page);
  });
});
