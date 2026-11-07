// Ask everywhere: the docked Ask panel (launcher, dock reflow, overlay and phone sheet, resize and
// persistence), the page chip that names where the owner is, the Ask about button on accounts,
// recs, goals and figures, references on the wire (kind and id only), and the panel sharing the Ask
// page's one pending and streaming implementation. Tags @ae-ac1 .. @ae-ac5 map to the plan's
// acceptance criteria; titles with @mobile also run at 390px, @mobile-only only there. The demo
// server runs the fake engine; nothing is mocked, requests are only observed.

import { test, expect, resetDemo, gotoRoute, recDialog, rec, plain, ASK_THREAD_URL } from './helpers.mjs';

const ACC = 'a_biz';
const REC_ID = 'dcfsa';
const STORE_KEY = 'fathom.askPanel';
const DOCK_MIN = 1040;
// A long question: the fake engine echoes every number, so the answer streams for several seconds.
const LONG_Q = (n, from) => `Compare ${Array.from({ length: n }, (_, i) => String(from + i * 7)).join(', ')} for me`;

test.use({ timezoneId: 'UTC' });

/* ---------- locators and helpers ---------- */

const root = (page) => page.locator('.d-horizon');
const launcher = (page) => page.locator('button.h-askp-launch');
const panel = (page) => page.locator('aside#h-askp.h-askp');
const panelInput = (page) => panel(page).locator('form.h-askx-compose textarea[name="q"]');
const bar = (page, act) => panel(page).locator(`button[data-askp="${act}"]`);
const grip = (page) => panel(page).locator('div.h-askp-grip');
const panelChips = (page) => panel(page).locator('form.h-askx-compose .h-ctx-row .h-ctx');
const pageChip = (page) => panel(page).locator('form.h-askx-compose .h-ctx-row .h-ctx[data-page="1"]');
const addedChips = (page) => panel(page).locator('form.h-askx-compose .h-ctx-row .h-ctx:not([data-page])');
const chip = (page, ref) => panel(page).locator(`form.h-askx-compose .h-ctx-row .h-ctx[data-ref="${ref}"]`);
const answers = (page) => panel(page).locator('.h-askx-msgs .h-msg.fathom');
const mine = (page) => panel(page).locator('.h-askx-msgs .h-msg.me');
const liveWork = (page) => panel(page).locator('.h-work.live');
const addBtn = (page, kind, id) => page.locator(`.h-root button.h-add[data-ctx-add="${kind}"][data-ctx-id="${id}"]`).first();
const accRow = (page) => page.locator(`.h-root [data-account="${ACC}"]`).first();
const askMain = (page) => page.locator('.h-root .h-askx-main');

const isDock = (page) => page.viewportSize().width >= DOCK_MIN;
const isPhone = (page) => page.viewportSize().width <= 720;
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const stored = (page) => page.evaluate((k) => {
  try { return JSON.parse(window.localStorage.getItem(k) || 'null'); } catch { return null; }
}, STORE_KEY);

const refOf = (s) => {
  const i = s.indexOf(':');
  return { kind: s.slice(0, i), id: s.slice(i + 1) };
};

function intersects(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function box(locator) {
  const b = await locator.boundingBox();
  expect(b, 'element has a box').not.toBeNull();
  return b;
}

async function rightEdge(locator) {
  return locator.evaluate((el) => el.getBoundingClientRect().right);
}

async function focusedWithin(page, selector) {
  return page.evaluate((sel) => !!(document.activeElement && document.activeElement.closest(sel)), selector);
}

async function openPanel(page) {
  await expect(launcher(page)).toBeVisible();
  await expect(launcher(page)).toHaveAttribute('aria-expanded', 'false');
  await launcher(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(panelInput(page)).toBeFocused();
}

async function closePanel(page) {
  await bar(page, 'close').click();
  await expect(panel(page)).toBeHidden();
  await expect(launcher(page)).toBeFocused();
}

// Sends a question from the panel composer and waits for its answer in the panel.
async function askInPanel(page, text, timeout = 60_000) {
  const before = await answers(page).count();
  await expect(panelInput(page)).toBeVisible();
  await panelInput(page).fill(text);
  await panelInput(page).press('Enter');
  await expect(answers(page)).toHaveCount(before + 1, { timeout });
}

// Sends a question from the panel without waiting, once the live work block shows.
async function startInPanel(page, text) {
  await panelInput(page).fill(text);
  await panelInput(page).press('Enter');
  await expect(liveWork(page)).toBeVisible({ timeout: 30_000 });
}

// The "+" of one item on a route; at sheet or overlay widths the modal panel is closed first so
// the page is reachable. Leaves the panel open with the chip.
async function addFrom(page, route, kind, id) {
  await gotoRoute(page, route);
  if (!isDock(page) && await panel(page).isVisible()) await closePanel(page);
  const btn = addBtn(page, kind, id);
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  await expect(panel(page)).toBeVisible();
  await expect(chip(page, `${kind}:${id}`)).toBeVisible();
  await expect(panelInput(page)).toBeFocused();
}

async function newThread(request, text) {
  const res = await request.post('/api/threads', { headers: { 'content-type': 'application/json' }, data: { text } });
  expect(res.status(), 'POST /api/threads').toBe(200);
  return (await res.json()).thread;
}

const isAskPost = (r) => r.method() === 'POST' && /^\/api\/(threads|ask)$/.test(new URL(r.url()).pathname);

test.describe('ask everywhere', () => {
  test.beforeEach(async ({ request }) => {
    await resetDemo(request);
  });

  /* ---------- AC1: launcher, dock, overlay, sheet, keys, persistence ---------- */

  test('@ae-ac1 @mobile the launcher on Home, Plan and Money opens the panel and Close returns focus to it', async ({ page }) => {
    for (const route of ['home', 'plan', 'money']) {
      await gotoRoute(page, route);
      const l = launcher(page);
      await expect(l).toBeVisible();
      await expect(l).toHaveAttribute('aria-label', 'Ask');
      await expect(l).toHaveAttribute('aria-controls', 'h-askp');
      await openPanel(page);
      const p = panel(page);
      await expect(p).toHaveAttribute('role', 'complementary');
      await expect(p).toHaveAttribute('aria-label', 'Ask');
      await expect(p).toHaveAttribute('data-mode', isPhone(page) ? 'sheet' : isDock(page) ? 'dock' : 'overlay');
      if (isDock(page)) await expect(l).toHaveAttribute('aria-expanded', 'true');
      await expect(bar(page, 'list')).toBeVisible();
      await expect(bar(page, 'new')).toBeVisible();
      await expect(bar(page, 'expand')).toHaveAttribute('aria-label', 'Open in Ask');
      await expect(bar(page, 'close')).toHaveAttribute('aria-label', 'Close');
      await closePanel(page);
      await expect(l).toHaveAttribute('aria-expanded', 'false');
    }
  });

  test('@ae-ac1 docked, the page reflows beside the panel; the launcher and Plan rec actions stay clear', async ({ page }) => {
    test.skip(!isDock(page), 'dock geometry needs a desktop viewport');
    const vw = page.viewportSize().width;
    const vh = page.viewportSize().height;
    await gotoRoute(page, 'plan');
    await openPanel(page);
    await expect(panel(page)).toHaveAttribute('data-mode', 'dock');
    await expect(root(page)).toHaveClass(/\bh-askp-on\b/);
    const pb = await box(panel(page));
    const w = pb.width;
    expect(Math.abs(pb.x + pb.width - vw)).toBeLessThanOrEqual(1);
    expect(pb.y).toBeLessThanOrEqual(1);
    expect(pb.height).toBeGreaterThanOrEqual(vh - 1);
    const cssW = await root(page).evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--askp-w')));
    expect(Math.abs(cssW - w)).toBeLessThanOrEqual(1);
    await expect(grip(page)).toHaveAttribute('aria-valuenow', String(Math.round(w)));

    expect(await rightEdge(page.locator('.h-root'))).toBeLessThanOrEqual(vw - w + 1);
    expect(await rightEdge(page.locator('header.h-top'))).toBeLessThanOrEqual(vw - w + 1);

    const lb = await box(launcher(page));
    expect(intersects(lb, pb), 'the launcher sits outside the panel').toBe(false);
    const uncovered = await launcher(page).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!hit && el.contains(hit);
    });
    expect(uncovered, 'nothing covers the launcher').toBe(true);

    const action = page.locator('.h-root .h-row .h-acts button').first();
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeVisible();
    expect(intersects(await box(action), await box(panel(page))), 'a Plan rec action is not under the panel').toBe(false);
  });

  test('@ae-ac1 @ae-ac5 @mobile Conversations lists threads in one click, picking one stays on the page, New starts fresh', async ({ page, request }) => {
    const opener = 'Synthetic panel opener question';
    const thread = await newThread(request, opener);
    await gotoRoute(page, 'money');
    await openPanel(page);
    const list = bar(page, 'list');
    await expect(list).toHaveAttribute('aria-pressed', 'false');
    await list.click();
    await expect(list).toHaveAttribute('aria-pressed', 'true');
    const row = panel(page).locator(`.h-askx-list a.h-askx-row[data-thread="${thread.id}"]`);
    await expect(row).toBeVisible();
    await row.click();
    await expect(page).toHaveURL(/#\/money$/);
    await expect(mine(page)).toHaveCount(1);
    await expect(mine(page).first()).toContainText(opener);
    await expect(answers(page)).toHaveCount(1);
    expect((await stored(page)).threadId).toBe(thread.id);

    await bar(page, 'new').click();
    await expect(page).toHaveURL(/#\/money$/);
    await expect(panel(page).locator('.h-msg')).toHaveCount(0);
    await expect(panelInput(page)).toBeVisible();
  });

  test('@ae-ac1 @mobile Esc closes the panel with focus on the launcher, and mod+i toggles it, also from a field', async ({ page }) => {
    await gotoRoute(page, 'money');
    await openPanel(page);
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await expect(launcher(page)).toBeFocused();
    await expect(launcher(page)).toHaveAttribute('aria-expanded', 'false');

    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('ControlOrMeta+i');
    await expect(panel(page)).toBeVisible();
    await expect(panelInput(page)).toBeFocused();
    await page.keyboard.press('ControlOrMeta+i');
    await expect(panel(page)).toBeHidden();
    await expect(launcher(page)).toBeFocused();
    await page.keyboard.press('ControlOrMeta+i');
    await expect(panel(page)).toBeVisible();
  });

  test('@ae-ac1 the grip resizes by keyboard and pointer, and a reload keeps the open state and width', async ({ page }) => {
    test.skip(!isDock(page), 'the grip exists only in dock mode');
    await gotoRoute(page, 'money');
    await openPanel(page);
    const g = grip(page);
    await expect(g).toHaveAttribute('role', 'separator');
    await expect(g).toHaveAttribute('aria-orientation', 'vertical');
    await expect(g).toHaveAttribute('tabindex', '0');
    const v0 = Number(await g.getAttribute('aria-valuenow'));
    expect(v0).toBeGreaterThanOrEqual(320);
    await g.focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(g).toHaveAttribute('aria-valuenow', String(v0 + 32));
    await page.keyboard.press('ArrowRight');
    await expect(g).toHaveAttribute('aria-valuenow', String(v0 + 16));
    await expect.poll(async () => Math.round((await box(panel(page))).width)).toBe(v0 + 16);

    const gb = await box(g);
    const x = gb.x + gb.width / 2;
    const y = gb.y + gb.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 20, y, { steps: 3 });
    await page.mouse.move(x - 40, y, { steps: 3 });
    await page.mouse.up();
    await expect.poll(async () => Number(await g.getAttribute('aria-valuenow'))).toBeGreaterThan(v0 + 16 + 30);
    const v2 = Number(await g.getAttribute('aria-valuenow'));
    expect(v2).toBeLessThanOrEqual(v0 + 16 + 50);
    await expect.poll(async () => (await stored(page))?.width).toBe(v2);

    await page.reload();
    await expect(page.locator('header.h-top')).toBeVisible();
    await expect(panel(page)).toBeVisible();
    await expect(grip(page)).toHaveAttribute('aria-valuenow', String(v2));
    expect(Math.round((await box(panel(page))).width)).toBe(v2);
    const s = await stored(page);
    expect(s.open).toBe(true);
    expect(s.width).toBe(v2);
  });

  test('@ae-ac1 @mobile storage that throws still renders the app and opens the panel', async ({ page }) => {
    await page.addInitScript(() => {
      const blocked = () => { throw new DOMException('Storage is blocked', 'SecurityError'); };
      Storage.prototype.getItem = blocked;
      Storage.prototype.setItem = blocked;
      Storage.prototype.removeItem = blocked;
    });
    await gotoRoute(page, 'money');
    await expect(accRow(page)).toBeVisible();
    await openPanel(page);
    await expect(pageChip(page)).toHaveCount(1);
    await closePanel(page);
  });

  test('@ae-ac1 the width clamps so the page keeps 720px: 380 at 1100 and 320 at 1040 with a persisted 640', async ({ page }) => {
    await page.addInitScript(([k]) => {
      try { window.localStorage.setItem(k, JSON.stringify({ open: true, width: 640, threadId: null, chips: [] })); } catch { /* storage blocked */ }
    }, [STORE_KEY]);
    for (const [vw, want] of [[1100, 380], [1040, 320]]) {
      await page.setViewportSize({ width: vw, height: 900 });
      await gotoRoute(page, 'money');
      await page.reload();
      await expect(page.locator('header.h-top')).toBeVisible();
      await expect(panel(page)).toBeVisible();
      await expect(panel(page)).toHaveAttribute('data-mode', 'dock');
      await expect.poll(async () => Math.round((await box(panel(page))).width), `panel width at ${vw}`).toBe(want);
      await expect(grip(page)).toHaveAttribute('aria-valuenow', String(want));
      const right = await rightEdge(page.locator('.h-root'));
      expect(right).toBeLessThanOrEqual(vw - want + 1);
      expect(right).toBeGreaterThanOrEqual(720 - 1);
    }
  });

  test('@ae-ac1 between 721 and 1039px the panel is a modal right-side overlay', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await gotoRoute(page, 'money');
    await launcher(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toHaveAttribute('data-mode', 'overlay');
    await expect(panelInput(page)).toBeFocused();
    const pb = await box(panel(page));
    expect(Math.abs(pb.x + pb.width - 900)).toBeLessThanOrEqual(1);
    expect(pb.y).toBeLessThanOrEqual(1);
    expect(pb.height).toBeGreaterThanOrEqual(899);
    expect(await rightEdge(page.locator('.h-root')), 'the page does not reflow').toBeGreaterThanOrEqual(899);
    await expect(launcher(page)).toBeHidden();
    await expect(grip(page)).toHaveCount(0);
    expect(await page.locator('.h-root').evaluate((el) => !!el.closest('[inert]')), 'the page is inert').toBe(true);
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      expect(await focusedWithin(page, '#h-askp'), `Tab ${i + 1} stays in the panel`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await expect(launcher(page)).toBeFocused();
  });

  test('@ae-ac1 @mobile-only at phone width the panel is a full-height sheet', async ({ page }) => {
    const { width: vw, height: vh } = page.viewportSize();
    await gotoRoute(page, 'money');
    await expect(launcher(page)).toBeVisible();
    await launcher(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toHaveAttribute('data-mode', 'sheet');
    const pb = await box(panel(page));
    expect(pb.y).toBeLessThanOrEqual(1);
    expect(pb.height).toBeGreaterThanOrEqual(vh - 1);
    expect(pb.x).toBeLessThanOrEqual(1);
    expect(pb.width).toBeGreaterThanOrEqual(vw - 1);
    await expect(launcher(page)).toBeHidden();
    await expect(grip(page)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await closePanel(page);
    await expect(launcher(page)).toBeVisible();
  });

  /* ---------- AC2: page chips ---------- */

  test('@ae-ac2 @mobile the page chip reads Money > Overview with the trend range, can be removed, and returns on the next route', async ({ page }) => {
    await gotoRoute(page, 'money');
    await openPanel(page);
    await expect(panelChips(page).first()).toHaveAttribute('data-page', '1');
    await expect(pageChip(page)).toHaveAttribute('data-ref', 'money:overview');
    await expect(pageChip(page).locator('.h-ctx-l')).toHaveText('On: Money > Overview, last year');
    const x = pageChip(page).locator('button.h-ctx-x');
    await expect(x).toHaveAttribute('aria-label', 'Remove Money > Overview, last year from context');
    await x.click();
    await expect(pageChip(page)).toHaveCount(0);
    await expect(panelInput(page)).toBeFocused();

    await gotoRoute(page, 'accounts');
    await expect(panel(page)).toBeVisible();
    await expect(pageChip(page).locator('.h-ctx-l')).toHaveText('On: Money > Accounts');
  });

  test('@ae-ac2 the page chip names the account in the account dialog and the rec in a rec dialog', async ({ page }) => {
    await gotoRoute(page, 'money');
    await accRow(page).locator('.h-acc-m').click();
    await expect(recDialog(page)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#/account/${ACC}$`));
    const name = (await recDialog(page).locator('#h-dlg-t').textContent()).trim();
    expect(name.length).toBeGreaterThan(0);
    await page.keyboard.press('ControlOrMeta+i');
    await expect(panel(page)).toBeVisible();
    await expect(pageChip(page)).toHaveAttribute('data-ref', `account:${ACC}`);
    // The account name, plus any view detail the page under the dialog publishes.
    await expect(pageChip(page).locator('.h-ctx-l')).toHaveText(new RegExp(`^On: Money > ${reEsc(name)}(, .+)?$`));

    await gotoRoute(page, `rec/${REC_ID}`);
    await expect(recDialog(page)).toBeVisible();
    const title = (await recDialog(page).locator('#h-dlg-t').textContent()).trim();
    expect(title).toBe(plain(rec(REC_ID).title));
    await expect(panel(page)).toBeVisible();
    await expect(pageChip(page)).toHaveAttribute('data-ref', `rec:${REC_ID}`);
    await expect(pageChip(page).locator('.h-ctx-l')).toHaveText(`On: Plan > ${title}`);
  });

  test('@ae-ac2 @mobile the rec thread chip on the Ask page renders through the shared chip', async ({ page, request }) => {
    const res = await request.post('/api/threads', { headers: { 'content-type': 'application/json' }, data: { recId: REC_ID, questionId: 0 } });
    expect(res.status()).toBe(200);
    const { thread } = await res.json();
    await gotoRoute(page, `ask/${thread.id}`);
    const link = page.locator('header.h-askx-head .h-ctx a.h-askx-ctx');
    await expect(link).toBeVisible();
    await expect(link).toContainText(plain(rec(REC_ID).title));
    await expect(link).toHaveAttribute('data-go', 'rec');
    await expect(link).toHaveAttribute('data-id', REC_ID);
    await expect(page.locator('header.h-askx-head .h-ctx button.h-ctx-x')).toHaveCount(0);
  });

  /* ---------- AC3: Ask about ---------- */

  test('@ae-ac3 hovering an account row shows its +, and keyboard focus plus Enter adds the chip and opens the panel', async ({ page }) => {
    test.skip(!isDock(page), 'hover reveal is a pointer affordance');
    await gotoRoute(page, 'accounts');
    const btn = addBtn(page, 'account', ACC);
    await expect(btn).toHaveCount(1);
    await expect(btn).toHaveAttribute('aria-label', /^Ask about .+$/);
    await expect(btn).toHaveAttribute('title', await btn.getAttribute('aria-label'));
    const opacity = () => btn.evaluate((el) => Number(getComputedStyle(el).opacity));
    await page.mouse.move(0, 0);
    await expect.poll(opacity).toBeLessThan(0.5);
    await accRow(page).hover();
    await expect.poll(opacity).toBeGreaterThan(0.9);
    await page.mouse.move(0, 0);

    await btn.focus();
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeVisible();
    await expect(chip(page, `account:${ACC}`)).toBeVisible();
    await expect(chip(page, `account:${ACC}`).locator('.h-ctx-l')).toContainText(
      (await accRow(page).locator('.h-acc-name').first().textContent()).trim());
    await expect(panelInput(page)).toBeFocused();
    await expect(recDialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(/#\/accounts$/);
  });

  test('@ae-ac3 @mobile chips stack on one page and one can be removed; a different page starts a new conversation', async ({ page }) => {
    await addFrom(page, 'accounts', 'account', ACC);
    await expect(recDialog(page)).toHaveCount(0);
    // A second and a third account on the same page stack in the same conversation.
    const others = page.locator(`.h-root button.h-add[data-ctx-add="account"]:not([data-ctx-id="${ACC}"])`);
    expect(await others.count(), 'the demo has more than two accounts').toBeGreaterThan(1);
    const ids = [ACC];
    for (const i of [0, 1]) {
      if (!isDock(page) && await panel(page).isVisible()) await closePanel(page);
      const b = others.nth(i);
      const id = await b.getAttribute('data-ctx-id');
      await b.scrollIntoViewIfNeeded();
      await b.click();
      await expect(chip(page, `account:${id}`)).toBeVisible();
      ids.push(id);
    }
    await expect(addedChips(page)).toHaveCount(3);
    expect(await addedChips(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-ref'))))
      .toEqual(ids.map((id) => `account:${id}`));
    await chip(page, `account:${ids[1]}`).locator('button.h-ctx-x').click();
    await expect(addedChips(page)).toHaveCount(2);
    await expect(chip(page, `account:${ids[1]}`)).toHaveCount(0);
    await expect(panelInput(page)).toBeFocused();
    expect((await stored(page)).chips.map((c) => `${c.kind}:${c.id}`)).toEqual([`account:${ids[0]}`, `account:${ids[2]}`]);

    // The rec on Plan starts a new conversation: the Plan page chip and the rec, no accounts.
    await addFrom(page, 'plan', 'rec', REC_ID);
    await expect(recDialog(page)).toHaveCount(0);
    await expect(pageChip(page)).toHaveAttribute('data-ref', 'page:plan');
    expect(await addedChips(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-ref')))).toEqual([`rec:${REC_ID}`]);
    expect((await stored(page)).chips.map((c) => `${c.kind}:${c.id}`)).toEqual([`rec:${REC_ID}`]);
  });

  test('@ae-ac3 @mobile the figure popover Add to chat adds a figure chip; Enter on a figure focuses it', async ({ page }) => {
    await gotoRoute(page, 'money');
    const fig = page.locator('.h-root .fx-fig[data-fig]').first();
    await fig.scrollIntoViewIfNeeded();
    const key = await fig.getAttribute('data-fig');
    expect(key).toBeTruthy();

    await fig.focus();
    await page.keyboard.press('Enter');
    const add = page.locator('.fx-pop button.fx-pop-add');
    await expect(add).toBeVisible();
    await expect(add).toHaveText('Add to chat');
    await expect(add).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.fx-pop')).toHaveCount(0);
    await expect(fig).toBeFocused();

    await fig.click();
    await expect(add).toBeVisible();
    await add.click();
    await expect(page.locator('.fx-pop')).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
    await expect(chip(page, `figure:${key}`)).toBeVisible();
  });

  test('@ae-ac3 @mobile-only at phone width the + shows without hover', async ({ page }) => {
    await gotoRoute(page, 'accounts');
    const btn = addBtn(page, 'account', ACC);
    await btn.scrollIntoViewIfNeeded();
    await expect(btn).toBeVisible();
    await expect.poll(() => btn.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeGreaterThan(0.9);
    const b = await box(btn);
    expect(b.width).toBeGreaterThanOrEqual(16);
    expect(b.x + b.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
  });

  /* ---------- AC4: references on the wire ---------- */

  test('@ae-ac4 @mobile a panel question carries the page chip and the rec added on that page as kind and id only, not the account added on another page, and the answer renders in the panel', async ({ page }) => {
    test.setTimeout(120_000);
    await addFrom(page, 'money', 'account', ACC);
    // Plan is another page: the rec starts a new conversation and the Money account is left behind.
    await addFrom(page, 'plan', 'rec', REC_ID);
    await expect(chip(page, `account:${ACC}`)).toHaveCount(0);
    await expect(pageChip(page)).toHaveAttribute('data-ref', 'page:plan');
    const expected = [refOf(await pageChip(page).getAttribute('data-ref')), { kind: 'rec', id: REC_ID }];

    const posted = page.waitForRequest(isAskPost);
    await askInPanel(page, 'Synthetic question about this item');
    const req = await posted;
    expect(new URL(req.url()).pathname).toBe('/api/threads');
    const body = req.postDataJSON();
    expect(body.context).toEqual(expected);
    for (const item of body.context) expect(Object.keys(item).sort()).toEqual(['id', 'kind']);
    expect(JSON.stringify(body)).not.toContain('label');
    await expect(page).toHaveURL(/#\/plan$/);
    await expect(answers(page).last()).toBeVisible();
  });

  test('@ae-ac4 a question with no references sends no context', async ({ page }) => {
    await gotoRoute(page, 'ask');
    const input = page.locator('.h-root form.h-askx-compose textarea[name="q"]');
    await expect(input).toBeVisible();
    await expect(page.locator('.h-root form.h-askx-compose .h-ctx')).toHaveCount(0);
    const posted = page.waitForRequest(isAskPost);
    await input.fill('Synthetic question with nothing attached');
    await input.press('Enter');
    const body = (await posted).postDataJSON();
    expect(body).not.toHaveProperty('context');
    await expect(page).toHaveURL(ASK_THREAD_URL);
  });

  /* ---------- AC5: one pending and streaming implementation ---------- */

  test('@ae-ac5 @mobile the panel shows the live work block while the question is in flight, then the answer', async ({ page }) => {
    test.setTimeout(150_000);
    await gotoRoute(page, 'money');
    await openPanel(page);
    await startInPanel(page, LONG_Q(300, 3000));
    await expect(panel(page).locator('.h-askx-pend')).toHaveCount(1);
    await expect(answers(page)).toHaveCount(1, { timeout: 120_000 });
    await expect(liveWork(page)).toHaveCount(0);
    await expect(panel(page).locator('.h-askx-pend')).toHaveCount(0);
    await expect(page).toHaveURL(/#\/money$/);
    expect((await stored(page)).threadId).toMatch(/^[a-f0-9]{12}$/);
  });

  test('@ae-ac5 @mobile Expand opens the same thread on the Ask page with the chips, and Open in panel returns', async ({ page }) => {
    test.setTimeout(120_000);
    await addFrom(page, 'money', 'account', ACC);
    await askInPanel(page, 'Synthetic question to expand');
    const tid = (await stored(page)).threadId;
    expect(tid).toMatch(/^[a-f0-9]{12}$/);

    await bar(page, 'expand').click();
    await expect(page).toHaveURL(new RegExp(`#/ask/${tid}$`));
    await expect(panel(page)).toBeHidden();
    await expect(launcher(page)).toBeHidden();
    await expect(askMain(page).locator('.h-askx-msgs .h-msg.fathom')).toHaveCount(1);
    const askCompose = page.locator('.h-root form.h-askx-compose');
    await expect(askCompose.locator(`.h-ctx-row .h-ctx[data-ref="account:${ACC}"]`)).toBeVisible();
    await expect(askCompose.locator('.h-ctx-row .h-ctx[data-ref="money:overview"]')).toBeVisible();

    const collapse = page.locator('.h-root button[data-askp="collapse"]');
    await expect(collapse).toBeVisible();
    await collapse.click();
    await expect(page).toHaveURL(/#\/money$/);
    await expect(panel(page)).toBeVisible();
    await expect(answers(page)).toHaveCount(1);
    expect((await stored(page)).threadId).toBe(tid);
  });

  test('@ae-ac5 @mobile Expand before the answer completes shows the pending block on the Ask page, then the answer', async ({ page }) => {
    test.setTimeout(180_000);
    await gotoRoute(page, 'money');
    await openPanel(page);
    await askInPanel(page, 'Synthetic opener before a long question');
    const tid = (await stored(page)).threadId;
    expect(tid).toMatch(/^[a-f0-9]{12}$/);
    // Near the 4000-character cap, so the answer is still streaming after Expand on a loaded host.
    await startInPanel(page, LONG_Q(600, 4000));
    await bar(page, 'expand').click();
    await expect(page).toHaveURL(new RegExp(`#/ask/${tid}$`));
    await expect(askMain(page).locator('.h-askx-pend')).toBeVisible();
    await expect(askMain(page).locator('.h-askx-pend .h-msg.me.pending')).toContainText('Compare 4000, 4007');
    await expect(askMain(page).locator('.h-askx-msgs .h-msg.fathom')).toHaveCount(2, { timeout: 120_000 });
    await expect(askMain(page).locator('.h-askx-pend')).toHaveCount(0);
  });

  test('@ae-ac5 @mobile closing the panel while an answer streams and reopening shows the answer in the adopted thread', async ({ page, request }) => {
    test.setTimeout(180_000);
    await gotoRoute(page, 'money');
    await openPanel(page);
    await startInPanel(page, LONG_Q(450, 5000));
    await closePanel(page);
    await launcher(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(answers(page)).toHaveCount(1, { timeout: 120_000 });
    await expect(mine(page).first()).toContainText('Compare 5000, 5007');
    const tid = (await stored(page)).threadId;
    expect(tid).toMatch(/^[a-f0-9]{12}$/);
    const res = await request.get('/api/threads');
    expect(res.status()).toBe(200);
    expect((await res.json()).active.some((t) => t.id === tid)).toBe(true);
  });

  test('@ae-ac5 a rec dialog question completing while the panel shows another thread leaves the panel thread unchanged', async ({ page, request }) => {
    test.setTimeout(120_000);
    const opener = 'Synthetic thread kept in the panel';
    const thread = await newThread(request, opener);
    await gotoRoute(page, 'money');
    await openPanel(page);
    await bar(page, 'list').click();
    await panel(page).locator(`.h-askx-list a.h-askx-row[data-thread="${thread.id}"]`).click();
    await expect(mine(page).first()).toContainText(opener);

    await gotoRoute(page, `rec/${REC_ID}`);
    await expect(recDialog(page)).toBeVisible();
    await expect(panel(page)).toBeVisible();
    await recDialog(page).locator(`button.h-chip[data-askrec="${REC_ID}"]`).first().click();
    await expect(recDialog(page).locator('section.h-conv .h-msg.fathom')).toHaveCount(1, { timeout: 90_000 });
    await expect(mine(page)).toHaveCount(1);
    await expect(mine(page).first()).toContainText(opener);
    expect((await stored(page)).threadId).toBe(thread.id);
  });

  /* ---------- focus and layers ---------- */

  test('@ae-ac1 @ae-ac5 with the account dialog open, sending from the panel keeps focus and the draft in the panel composer', async ({ page }) => {
    test.setTimeout(120_000);
    await gotoRoute(page, 'money');
    await accRow(page).locator('.h-acc-m').click();
    await expect(recDialog(page)).toBeVisible();
    await page.keyboard.press('ControlOrMeta+i');
    await expect(panel(page)).toBeVisible();
    await expect(panelInput(page)).toBeFocused();
    await askInPanel(page, 'Synthetic question beside the dialog');
    await expect(recDialog(page)).toBeVisible();
    await expect(panelInput(page)).toBeFocused();

    await panelInput(page).pressSequentially('draft kept');
    await page.evaluate(() => window.Fathom.api.refresh());
    await expect(panelInput(page)).toBeFocused();
    await expect(panelInput(page)).toHaveValue('draft kept');
    await page.keyboard.type(' still');
    await expect(panelInput(page)).toHaveValue('draft kept still');
  });

  test('@ae-ac1 Esc closes the figure popover, then the dialog, then the panel, with focus on the figure, the trigger and the launcher', async ({ page }) => {
    test.skip(!isDock(page), 'the dialog and the panel side by side need the dock');
    await gotoRoute(page, 'money');
    await openPanel(page);
    await accRow(page).locator('a.h-acc-open').click();
    await expect(recDialog(page)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#/account/${ACC}$`));
    const fig = recDialog(page).locator('.h-ad-balance .fx-fig').first();
    await expect(fig).toBeVisible();
    await fig.click();
    await expect(page.locator('.fx-pop')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.fx-pop')).toHaveCount(0);
    await expect(recDialog(page)).toBeVisible();
    await expect(panel(page)).toBeVisible();
    expect(await page.evaluate(() => !!(document.activeElement && document.activeElement.matches('.h-dlg .fx-fig'))), 'focus on the figure').toBe(true);

    await page.keyboard.press('Escape');
    await expect(recDialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(/#\/money$/);
    await expect(panel(page)).toBeVisible();
    await expect.poll(() => focusedWithin(page, `[data-account="${ACC}"]`), 'focus on the dialog trigger').toBe(true);

    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await expect(launcher(page)).toBeFocused();
  });

  /* ---------- render capture ---------- */

  test('@ae-ac1 @mobile screenshot of the panel open on Money', async ({ page }, testInfo) => {
    await gotoRoute(page, 'money');
    await openPanel(page);
    await expect(pageChip(page)).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: testInfo.outputPath(`ask-panel-${testInfo.project.name}.png`) });
  });
  test('@ae-ac1 with focus in the panel, Confirm keys do not answer the card behind it', async ({ page }) => {
    await gotoRoute(page, 'confirm');
    await expect(page.locator('.h-root article.h-deck-card.cur').first()).toBeVisible();
    const writes = [];
    page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/confirm\//.test(r.url())) writes.push(r.url()); });
    await openPanel(page);
    await bar(page, 'new').focus();
    await page.keyboard.press('1');
    await page.keyboard.press('2');
    // A negative check needs a window: give any write the time a real answer takes to leave.
    await page.waitForTimeout(800);
    expect(writes).toEqual([]);
    await expect(panel(page)).toBeVisible();
  });

  test('@ae-ac5 a first question sent on the Ask page and moved to the panel before it completes lands in the panel thread', async ({ page }) => {
    test.setTimeout(180_000);
    await gotoRoute(page, 'ask');
    const ta = page.locator('.h-root form.h-askx-compose textarea[name="q"]');
    await ta.fill(LONG_Q(600, 5000));
    await ta.press('Enter');
    await expect(page.locator('.h-root .h-work.live')).toBeVisible({ timeout: 30_000 });
    await page.locator('.h-root button[data-askp="collapse"]').click();
    await expect(panel(page)).toBeVisible();
    await expect(answers(page)).toHaveCount(1, { timeout: 120_000 });
    await expect(mine(page)).toHaveCount(1);
    expect((await stored(page)).threadId).toMatch(/^[a-f0-9]{12}$/);
  });

  test('@ae-ac1 Tab moves between a dialog and the docked panel in both directions and never reaches the launcher', async ({ page }) => {
    test.skip(!isDock(page), 'docked panel only');
    for (const route of [`account/${ACC}`, `rec/${REC_ID}`]) {
      await gotoRoute(page, route);
      await expect(page.locator('.h-dlg-host .h-dlg')).toBeVisible();
      if (!(await panel(page).isVisible())) await launcher(page).click();
      await expect(panel(page)).toBeVisible();
      const SEL = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea,summary,[tabindex]:not([tabindex="-1"])';
      const focusEdge = (host, last) => page.evaluate(([h, sel, l]) => {
        const f = [...document.querySelector(h).querySelectorAll(sel)].filter((el) => el.getClientRects().length > 0);
        (l ? f[f.length - 1] : f[0]).focus();
      }, [host, SEL, last]);
      await focusEdge('.h-dlg-host', true);
      await page.keyboard.press('Tab');
      expect(await focusedWithin(page, '#h-askp')).toBe(true);
      await focusEdge('#h-askp', false);
      await page.keyboard.press('Shift+Tab');
      expect(await focusedWithin(page, '.h-dlg-host')).toBe(true);
      expect(await focusedWithin(page, '.h-askp-launch')).toBe(false);
    }
  });
});
