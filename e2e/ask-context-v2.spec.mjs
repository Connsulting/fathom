// Ask context v2: a conversation belongs to the page it started on. An Ask about button on another
// page starts a new conversation with that page's context and none of the old items, a question
// asked after moving to another page goes as a new thread with only the new page chip, New
// conversation drops every added item, the add button is a chat icon named Ask about <item>, and
// the page chip carries what the screen shows (the P&L month). Tags @askctx2-ac1 .. @askctx2-ac5;
// titles with @mobile also run at 390px. The demo server runs the fake engine; nothing is mocked,
// requests are only observed.

import { test, expect, resetDemo, gotoRoute } from './helpers.mjs';

const ACC = 'a_biz';
const STORE_KEY = 'fathom.askPanel';
const DOCK_MIN = 1040;
const NOTE = 'Your next question starts a new conversation about this page.';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

test.use({ timezoneId: 'UTC' });

/* ---------- locators and helpers ---------- */

const launcher = (page) => page.locator('button.h-askp-launch');
const panel = (page) => page.locator('aside#h-askp.h-askp');
const panelTitle = (page) => panel(page).locator('h2.h-askp-t');
const panelInput = (page) => panel(page).locator('form.h-askx-compose textarea[name="q"]');
const bar = (page, act) => panel(page).locator(`button[data-askp="${act}"]`);
const panelChips = (page) => panel(page).locator('form.h-askx-compose .h-ctx-row .h-ctx');
const pageChip = (page) => panel(page).locator('form.h-askx-compose .h-ctx-row .h-ctx[data-page="1"]');
const addedChips = (page) => panel(page).locator('form.h-askx-compose .h-ctx-row .h-ctx:not([data-page])');
const chip = (page, ref) => panel(page).locator(`form.h-askx-compose .h-ctx-row .h-ctx[data-ref="${ref}"]`);
const note = (page) => panel(page).locator('.h-ctx-note');
const answers = (page) => panel(page).locator('.h-askx-msgs .h-msg.fathom');
const mine = (page) => panel(page).locator('.h-askx-msgs .h-msg.me');
const goalAdd = (page) => page.locator('.h-root section.h-home article.h-gcard button.h-add[data-ctx-add="goal"]').first();
const accAdd = (page, id) => page.locator(`.h-root button.h-add[data-ctx-add="account"][data-ctx-id="${id}"]`).first();
const otherAccAdd = (page) => page.locator(`.h-root button.h-add[data-ctx-add="account"]:not([data-ctx-id="${ACC}"])`).first();

const isDock = (page) => page.viewportSize().width >= DOCK_MIN;
const refsOf = (loc) => loc.evaluateAll((els) => els.map((e) => e.getAttribute('data-ref')));

const stored = (page) => page.evaluate((k) => {
  try { return JSON.parse(window.localStorage.getItem(k) || 'null'); } catch { return null; }
}, STORE_KEY);

const isAskPost = (r) => r.method() === 'POST' && /^\/api\/(threads|ask)$/.test(new URL(r.url()).pathname);

async function closePanel(page) {
  await bar(page, 'close').click();
  await expect(panel(page)).toBeHidden();
}

async function openPanel(page) {
  await expect(launcher(page)).toBeVisible();
  await launcher(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(panelInput(page)).toBeFocused();
}

// At sheet or overlay widths the modal panel covers the page: close it before touching the page.
async function pageReachable(page) {
  if (!isDock(page) && await panel(page).isVisible()) await closePanel(page);
}

// Clicks one Ask about button and waits for its chip in the panel.
async function add(page, btn) {
  await pageReachable(page);
  await btn.scrollIntoViewIfNeeded();
  const ref = `${await btn.getAttribute('data-ctx-add')}:${await btn.getAttribute('data-ctx-id')}`;
  await btn.click();
  await expect(panel(page)).toBeVisible();
  await expect(chip(page, ref)).toBeVisible();
  await expect(panelInput(page)).toBeFocused();
  return ref;
}

// Sends a question from the panel composer, returns the request body once the answer lands.
// fresh: the question starts a new thread, so the panel shows its one answer, not one more.
async function askInPanel(page, text, { fresh = false } = {}) {
  const before = fresh ? 0 : await answers(page).count();
  const posted = page.waitForRequest(isAskPost);
  await panelInput(page).fill(text);
  await panelInput(page).press('Enter');
  const req = await posted;
  await expect(answers(page)).toHaveCount(before + 1, { timeout: 60_000 });
  return { path: new URL(req.url()).pathname, body: req.postDataJSON() };
}

test.describe('ask context v2', () => {
  test.beforeEach(async ({ request }) => {
    await resetDemo(request);
  });

  /* ---------- AC1 and AC5: a conversation per page, New conversation clears ---------- */

  test('@askctx2-ac1 @askctx2-ac5 @mobile an add on another page starts a new conversation; New conversation keeps only the page chip', async ({ page }) => {
    await gotoRoute(page, 'home');
    const goalRef = await add(page, goalAdd(page));
    expect(goalRef).toMatch(/^goal:.+/);
    await expect(pageChip(page)).toHaveAttribute('data-ref', 'page:home');
    expect(await refsOf(addedChips(page))).toEqual([goalRef]);

    // Money: the add starts a new conversation with Money's page chip and the account, no goal.
    await gotoRoute(page, 'money');
    await add(page, accAdd(page, ACC));
    await expect(panelTitle(page)).toHaveText('New conversation');
    await expect(pageChip(page)).toHaveCount(1);
    await expect(pageChip(page)).toHaveAttribute('data-ref', 'money:overview');
    expect(await refsOf(addedChips(page))).toEqual([`account:${ACC}`]);
    await expect(chip(page, goalRef)).toHaveCount(0);
    expect((await stored(page)).chips.map((c) => `${c.kind}:${c.id}`)).toEqual([`account:${ACC}`]);

    // A second add on the same page stacks in the same conversation.
    const other = await add(page, otherAccAdd(page));
    expect(await refsOf(addedChips(page))).toEqual([`account:${ACC}`, other]);

    // New conversation: no added chips, only the page chip.
    await bar(page, 'new').click();
    await expect(addedChips(page)).toHaveCount(0);
    await expect(panelChips(page)).toHaveCount(1);
    await expect(pageChip(page)).toHaveAttribute('data-ref', 'money:overview');
    await expect(panelTitle(page)).toHaveText('New conversation');
    expect((await stored(page)).chips).toEqual([]);
  });

  test('@askctx2-ac1 @mobile coming back to the first page after a new conversation does not bring the old items back', async ({ page }) => {
    await gotoRoute(page, 'home');
    const goalRef = await add(page, goalAdd(page));
    await gotoRoute(page, 'money');
    await add(page, accAdd(page, ACC));
    await gotoRoute(page, 'home');
    await add(page, goalAdd(page));
    expect(await refsOf(addedChips(page))).toEqual([goalRef]);
    await expect(chip(page, `account:${ACC}`)).toHaveCount(0);
  });

  /* ---------- AC2: a question after moving starts a new thread ---------- */

  test('@askctx2-ac2 @mobile after moving to another page the old thread stays readable and the next question starts a new thread with only the page chip', async ({ page }) => {
    test.setTimeout(150_000);
    await gotoRoute(page, 'home');
    await add(page, goalAdd(page));
    const first = await askInPanel(page, 'Synthetic question on the home page');
    expect(first.path).toBe('/api/threads');
    const tid = (await stored(page)).threadId;
    expect(tid).toMatch(/^[a-f0-9]{12}$/);

    await gotoRoute(page, 'money');
    if (!(await panel(page).isVisible())) await openPanel(page);
    // The old thread is still shown, but the chip row is Money's page chip alone, with the note.
    await expect(mine(page)).toHaveCount(1);
    await expect(mine(page).first()).toContainText('Synthetic question on the home page');
    await expect(panelChips(page)).toHaveCount(1);
    await expect(pageChip(page)).toHaveAttribute('data-ref', 'money:overview');
    await expect(note(page)).toHaveText(NOTE);

    const second = await askInPanel(page, 'Synthetic question on the money page', { fresh: true });
    expect(second.path, 'a new thread, not the Home thread').toBe('/api/threads');
    expect(second.body).not.toHaveProperty('key');
    expect(second.body.context).toEqual([{ kind: 'money', id: 'overview@range=1Y' }]);
    const tid2 = (await stored(page)).threadId;
    expect(tid2).toMatch(/^[a-f0-9]{12}$/);
    expect(tid2).not.toBe(tid);
    await expect(mine(page)).toHaveCount(1);
    await expect(mine(page).first()).toContainText('Synthetic question on the money page');
    await expect(note(page)).toHaveCount(0);
    await expect(page).toHaveURL(/#\/money$/);

    // A follow-up on the same page stays in the new thread.
    const third = await askInPanel(page, 'Synthetic follow up on the money page');
    expect(third.path).toBe('/api/ask');
    expect((await stored(page)).threadId).toBe(tid2);
  });

  /* ---------- AC3: the chat icon ---------- */

  test('@askctx2-ac3 @mobile the add button is a chat icon named Ask about the item, its title the same text', async ({ page }) => {
    for (const [route, btn] of [['home', goalAdd], ['money', (p) => accAdd(p, ACC)]]) {
      await gotoRoute(page, route);
      const b = btn(page);
      await expect(b).toHaveCount(1);
      const aria = await b.getAttribute('aria-label');
      expect(aria).toMatch(/^Ask about .+/);
      await expect(b).toHaveAttribute('title', aria);
      await expect(b).toHaveAttribute('type', 'button');
      await expect(b.locator('svg.h-i path')).toHaveCount(2);
      await b.scrollIntoViewIfNeeded();
      await b.focus();
      await expect(b).toBeFocused();
    }
  });

  /* ---------- AC4: the page is always in context ---------- */

  test('@askctx2-ac4 @mobile the P&L page chip names the month picked in the strip and the question carries it', async ({ page }) => {
    test.setTimeout(120_000);
    await gotoRoute(page, 'pnl');
    const strip = page.locator('.h-root [data-pl-months] button.pl-m[data-pl-month]');
    await expect(strip.first()).toBeVisible();
    // A month that is not the selected one.
    const pick = page.locator('.h-root [data-pl-months] button.pl-m[data-pl-month][aria-pressed="false"]').first();
    const month = await pick.getAttribute('data-pl-month');
    expect(month).toMatch(/^\d{4}-\d{2}$/);
    await pick.scrollIntoViewIfNeeded();
    await pick.click();
    await expect(page.locator(`.h-root button.pl-m[data-pl-month="${month}"]`)).toHaveAttribute('aria-pressed', 'true');

    await openPanel(page);
    const name = `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
    await expect(pageChip(page).locator('.h-ctx-l')).toContainText(name);
    await expect(pageChip(page).locator('.h-ctx-l')).toHaveText(new RegExp(`^On: Money > .+, ${name}$`));
    const ref = await pageChip(page).getAttribute('data-ref');
    expect(ref, 'the qualifier never reaches data-ref').not.toContain('@');

    const { body } = await askInPanel(page, 'Synthetic question about this month');
    const kind = ref.slice(0, ref.indexOf(':'));
    const id = ref.slice(ref.indexOf(':') + 1);
    expect(body.context).toEqual([{ kind, id: `${id}@month=${month}` }]);
  });

  test('@askctx2-ac4 @mobile the Money page chip names the trend range and follows a range change', async ({ page }) => {
    await gotoRoute(page, 'money');
    await openPanel(page);
    await expect(pageChip(page).locator('.h-ctx-l')).toHaveText('On: Money > Overview, last year');
    await pageReachable(page);
    const r3 = page.locator('.h-root button.tr-rng[data-trend-range="3M"]');
    await r3.scrollIntoViewIfNeeded();
    await r3.click();
    await expect(r3).toHaveAttribute('aria-pressed', 'true');
    if (!(await panel(page).isVisible())) await openPanel(page);
    await expect(pageChip(page).locator('.h-ctx-l')).toHaveText('On: Money > Overview, last 3 months');
    await expect(pageChip(page)).toHaveAttribute('data-ref', 'money:overview');
  });

  /* ---------- AC5: the Ask page New conversation ---------- */

  test('@askctx2-ac5 New conversation on the Ask page drops the items carried over by Expand', async ({ page }) => {
    test.skip(!isDock(page), 'the Ask page conversation list is a desktop column');
    await gotoRoute(page, 'home');
    const goalRef = await add(page, goalAdd(page));
    await bar(page, 'expand').click();
    await expect(page).toHaveURL(/#\/ask$/);
    const askChips = page.locator('.h-root form.h-askx-compose .h-ctx-row .h-ctx');
    await expect(askChips.and(page.locator(`[data-ref="${goalRef}"]`))).toHaveCount(1);
    await page.locator('.h-root aside.h-askx-side button.h-askx-new').click();
    await expect(page).toHaveURL(/#\/ask$/);
    await expect(askChips).toHaveCount(0);
    expect((await stored(page)).chips).toEqual([]);
  });
});
