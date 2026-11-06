// Keyboard layer: Ctrl+K quick switcher, G sequences, Plan list ring and rec action keys, the
// shortcut sheet and the typing guard. Rec ids and titles come from demo/scenario.mjs.

import { test, expect, resetDemo, visibleRecs, liveStatus, plain, gotoRoute, expectH1, recDialog, closeDialogWithX, ASK_HELLO, askInput, askOnAsk } from './helpers.mjs';

const switcher = (page) => page.getByRole('dialog', { name: 'Quick switcher' });
const sheet = (page) => page.getByRole('dialog', { name: 'Keyboard shortcuts' });
const qsInput = (page) => page.locator('.h-qs-host input.h-qs-in');
const options = (page) => page.locator('#h-qs-list li.h-qs-o[role="option"]');
const headers = (page) => page.locator('#h-qs-list li.h-qs-g');

// A proposed rec that renders on Plan (proposed is an open status there).
function proposedRec() {
  const r = visibleRecs().find((x) => liveStatus(x) === 'proposed');
  if (!r) throw new Error('demo/scenario.mjs has no visible proposed rec');
  return r;
}
const recRow = (page, id) => page.locator('article.h-row', { has: page.locator(`a[data-go="rec"][data-id="${id}"]`) });

async function blur(page) {
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
}

async function openSwitcher(page) {
  await page.keyboard.press('Control+k');
  await expect(switcher(page)).toBeVisible();
  await expect(qsInput(page)).toBeFocused();
}

async function postJson(request, path, data = {}) {
  const res = await request.post(path, { headers: { 'content-type': 'application/json' }, data });
  expect(res.status(), `POST ${path}`).toBe(200);
  return res.json();
}

async function recStatusOf(request, id) {
  const res = await request.get('/api/scenario');
  expect(res.status()).toBe(200);
  const sc = await res.json();
  return sc.recs.find((x) => x.id === id)?.status;
}

// Press j until the row for `id` carries the ring; bounded by the row count.
async function ringOn(page, id) {
  const row = recRow(page, id);
  await expect(row).toHaveCount(1);
  const n = await page.locator('article.h-row').count();
  for (let i = 0; i <= n; i++) {
    await page.keyboard.press('j');
    if (await row.evaluate((el) => el.classList.contains('h-kfocus'))) return row;
  }
  throw new Error(`j never reached the row for ${id}`);
}

test.describe('keys', () => {
  test.beforeEach(async ({ request }) => {
    await resetDemo(request);
  });

  // 1
  test('Control+K opens the quick switcher; Escape closes it and restores focus', async ({ page }) => {
    await gotoRoute(page, 'brief');
    const plan = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Plan', exact: true });
    await plan.focus();
    await openSwitcher(page);
    await expect(qsInput(page)).toHaveAttribute('placeholder', 'Go to, ask, or run anything');
    await expect(qsInput(page)).toHaveAttribute('role', 'combobox');
    await page.keyboard.press('Escape');
    await expect(switcher(page)).toBeHidden();
    await expect(plan).toBeFocused();
  });

  // 2
  test('Meta+K opens the quick switcher too', async ({ page }) => {
    await gotoRoute(page, 'brief');
    await blur(page);
    await page.keyboard.press('Meta+k');
    await expect(switcher(page)).toBeVisible();
    await expect(qsInput(page)).toBeFocused();
  });

  // 3
  test('empty query shows group headers and the G hint on Go to Plan', async ({ page }) => {
    await gotoRoute(page, 'brief');
    await blur(page);
    await openSwitcher(page);
    const names = (await headers(page).allTextContents()).map((t) => t.trim());
    for (const g of ['Go to', 'Recommendations', 'Decisions', 'Accounts', 'Deadlines', 'Packs']) expect(names, g).toContain(g);
    const plan = page.locator('#h-qs-list li.h-qs-o[data-qs-key="go:plan"]');
    await expect(plan.locator('.h-qs-t')).toHaveText('Plan');
    await expect(plan.locator('kbd.h-qs-k')).toHaveText('G then P');
  });

  // 4
  test('typing part of a rec title filters to a flat ranked list with highlights', async ({ page }) => {
    const r = proposedRec();
    const title = plain(r.title);
    const query = title.split(/\s+/).slice(0, 3).join(' ');
    await gotoRoute(page, 'brief');
    await blur(page);
    await openSwitcher(page);
    await qsInput(page).fill(query);
    const first = options(page).first();
    await expect(first).toHaveAttribute('data-qs-key', `rec:${r.id}`);
    await expect(first.locator('.h-qs-t')).toHaveText(title);
    await expect(first.locator('.h-qs-t mark').first()).toBeVisible();
    await expect(headers(page)).toHaveCount(0);
  });

  // 5
  test('arrow keys and hover move the selection', async ({ page }) => {
    await gotoRoute(page, 'brief');
    await blur(page);
    await openSwitcher(page);
    const opts = options(page);
    await expect(opts.nth(0)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(opts.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(opts.nth(0)).toHaveAttribute('aria-selected', 'false');
    const id1 = await opts.nth(1).getAttribute('id');
    await expect(qsInput(page)).toHaveAttribute('aria-activedescendant', id1);
    await page.keyboard.press('ArrowUp');
    await expect(opts.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(opts.nth(1)).toHaveAttribute('aria-selected', 'false');
    await opts.nth(3).hover();
    await expect(opts.nth(3)).toHaveAttribute('aria-selected', 'true');
    await expect(opts.nth(0)).toHaveAttribute('aria-selected', 'false');
  });

  // 6
  test('typing plan and Enter goes to Plan and closes the switcher', async ({ page }) => {
    await gotoRoute(page, 'brief');
    await blur(page);
    await openSwitcher(page);
    await qsInput(page).fill('plan');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/plan$/);
    await expect(switcher(page)).toBeHidden();
    await expectH1(page, 'Everything on the calendar');
  });

  // 7
  test('a rec opened through the switcher comes back first under Recent; recents hold keys only', async ({ page }) => {
    const r = proposedRec();
    await gotoRoute(page, 'brief');
    await blur(page);
    await openSwitcher(page);
    await qsInput(page).fill(plain(r.title));
    await expect(options(page).first()).toHaveAttribute('data-qs-key', `rec:${r.id}`);
    await page.keyboard.press('Enter');
    await expect(recDialog(page)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#/rec/${r.id}$`));
    await closeDialogWithX(page);
    await blur(page);
    await openSwitcher(page);
    await expect(headers(page).first()).toHaveText('Recent');
    await expect(options(page).first()).toHaveAttribute('data-qs-key', `rec:${r.id}`);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('fathom.qs.recent') || 'null'));
    expect(Array.isArray(stored)).toBe(true);
    expect(stored[0]).toBe(`rec:${r.id}`);
    expect(stored.length).toBeLessThanOrEqual(8);
    expect(new Set(stored).size).toBe(stored.length);
    for (const k of stored) expect(k).toMatch(/^[a-z]+:[A-Za-z0-9_.-]+$/);
  });

  // 8
  test('no match: Enter starts a conversation and sends the typed text', async ({ page }) => {
    const text = 'zzqxv nothing';
    await gotoRoute(page, 'brief');
    await blur(page);
    await openSwitcher(page);
    await qsInput(page).fill(text);
    await expect(options(page)).toHaveCount(0);
    await expect(page.locator('.h-qs-empty')).toHaveText(`No matches. Press Enter to ask "${text}".`);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/ask\/[a-f0-9]{12}$/);
    await expect(switcher(page)).toBeHidden();
    await expect(page.locator('.h-askx .h-msg.me')).toContainText(text);
    await expect(page.locator('.h-askx .h-msg.fathom')).toHaveCount(1);
  });

  // 8b
  test('the switcher lists active conversations newest first and Enter opens one', async ({ page, request }) => {
    const a = (await postJson(request, '/api/threads', { text: 'Synthetic question alpha about cash' })).thread;
    const b = (await postJson(request, '/api/threads', { text: 'Synthetic question beta about taxes' })).thread;
    const c = (await postJson(request, '/api/threads', { text: 'Synthetic question gamma about goals' })).thread;
    await postJson(request, `/api/threads/${b.id}/archive`);

    // Ask again in the oldest active one (a) so it becomes the newest.
    await gotoRoute(page, `ask/${a.id}`);
    const followUp = 'Synthetic follow up about the next quarter';
    expect(await askOnAsk(page, followUp)).toBe(a.id);

    await gotoRoute(page, 'brief');
    await blur(page);
    await openSwitcher(page);
    const convKeys = await options(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-qs-key')).filter((k) => /^conv:/.test(k)));
    expect(convKeys).toEqual([`conv:${a.id}`, `conv:${c.id}`]);
    await expect(headers(page).filter({ hasText: /^Conversations$/ })).toHaveCount(1);
    await expect(page.locator(`#h-qs-list li.h-qs-o[data-qs-key="conv:${b.id}"]`)).toHaveCount(0);
    await expect(page.locator(`#h-qs-list li.h-qs-o[data-qs-key="conv:${a.id}"] .h-qs-t`)).toHaveText('Synthetic question alpha about cash');
    // Named after its first answer.
    await expect(page.locator(`#h-qs-list li.h-qs-o[data-qs-key="conv:${c.id}"] .h-qs-t`)).toHaveText('Synthetic question gamma about goals');

    // Move to the second conversation option (c) and open it.
    const target = page.locator(`#h-qs-list li.h-qs-o[data-qs-key="conv:${c.id}"]`);
    await target.hover();
    await expect(target).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`#/ask/${c.id}$`));
    await expect(switcher(page)).toBeHidden();
    await expect(page.locator('.h-askx .h-msg.me')).toContainText('Synthetic question gamma about goals');
    await expect(page.locator('.h-askx .h-msg.fathom')).toHaveCount(1);
  });

  // 8c
  test('a conversation title with markup characters shows literally in the switcher', async ({ page, request }) => {
    const name = 'Plan & review "Q"';
    const t = (await postJson(request, '/api/threads', { text: 'Synthetic question for the title test' })).thread;
    await postJson(request, `/api/threads/${t.id}/rename`, { title: name });
    await gotoRoute(page, 'brief');
    await blur(page);
    await openSwitcher(page);
    const opt = page.locator(`#h-qs-list li.h-qs-o[data-qs-key="conv:${t.id}"]`);
    await expect(opt.locator('.h-qs-t')).toHaveText(name);
    await expect(opt.locator('.h-qs-t > *')).toHaveCount(0);
    await qsInput(page).fill('Plan & review');
    await expect(opt.locator('.h-qs-t')).toHaveText(name);
    await expect(opt.locator('.h-qs-t').locator('*:not(mark)')).toHaveCount(0);
  });

  // 9
  const G = [['y', 'brief'], ['p', 'plan'], ['d', 'wargame'], ['a', 'ask'], ['c', 'confirm'], ['k', 'packs'], ['f', 'add'], ['e', 'engine'], ['m', 'email'], ['n', 'connect']];
  test('every G sequence reaches its route', async ({ page }) => {
    for (const [k, route] of G) {
      await gotoRoute(page, 'goals');
      await expect(page).toHaveURL(/#\/goals$/);
      await blur(page);
      await page.keyboard.press('g');
      await page.keyboard.press(k);
      await expect(page, `g ${k}`).toHaveURL(new RegExp(`#/${route}$`));
    }
  });

  test('g then a pause past the window then p does not navigate', async ({ page }) => {
    await gotoRoute(page, 'goals');
    await blur(page);
    await page.keyboard.press('g');
    await page.waitForTimeout(1700);
    await page.keyboard.press('p');
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/#\/goals$/);
  });

  // 10
  test('Plan list: j and k move the ring, Enter opens the focused rec', async ({ page }) => {
    await gotoRoute(page, 'plan');
    await expectH1(page, 'Everything on the calendar');
    await blur(page);
    const rows = page.locator('article.h-row');
    expect(await rows.count()).toBeGreaterThan(1);
    await page.keyboard.press('j');
    await expect(rows.nth(0)).toHaveClass(/\bh-kfocus\b/);
    await expect(page.locator('.h-kfocus')).toHaveCount(1);
    await page.keyboard.press('j');
    await expect(rows.nth(1)).toHaveClass(/\bh-kfocus\b/);
    await expect(rows.nth(0)).not.toHaveClass(/\bh-kfocus\b/);
    await page.keyboard.press('k');
    await expect(rows.nth(0)).toHaveClass(/\bh-kfocus\b/);
    await expect(page.locator('.h-kfocus')).toHaveCount(1);
    const id = await rows.nth(0).locator('a[data-go="rec"]').first().getAttribute('data-id');
    await page.keyboard.press('Enter');
    await expect(recDialog(page)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#/rec/${id}$`));
  });

  const ACTIONS = [
    ['d', 'doing', 'Doing it'],
    ['l', 'snoozed', /^Later/],
    ['e', 'done', 'Done'],
    ['Shift+X', 'dismissed', 'Not for us']
  ];
  for (const [key, status, label] of ACTIONS) {
    test(`Plan list: ${key} on a proposed rec sets it ${status}`, async ({ page, request }) => {
      const r = proposedRec();
      expect(await recStatusOf(request, r.id)).toBe('proposed');
      await gotoRoute(page, 'plan');
      await expectH1(page, 'Everything on the calendar');
      await blur(page);
      await ringOn(page, r.id);
      await page.keyboard.press(key);
      await expect.poll(() => recStatusOf(request, r.id)).toBe(status);
      await expect(recRow(page, r.id).locator('.h-st')).toHaveText(label);
    });
  }

  // 11
  test('? shows the shortcut sheet for the current screen', async ({ page }) => {
    await gotoRoute(page, 'plan');
    await expectH1(page, 'Everything on the calendar');
    await blur(page);
    await page.keyboard.press('?');
    const dlg = sheet(page);
    await expect(dlg).toBeVisible();
    const groups = (await dlg.locator('section.h-ks-g h3').allTextContents()).map((t) => t.trim());
    for (const g of ['Global', 'Go to', 'List', 'Recommendation']) expect(groups, g).toContain(g);
    await expect(dlg.locator('.h-ks-l', { hasText: /^Doing it/ })).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toBeHidden();

    await gotoRoute(page, 'ask');
    await expectH1(page, ASK_HELLO);
    await blur(page);
    await page.keyboard.press('?');
    await expect(sheet(page)).toBeVisible();
    const askGroups = (await sheet(page).locator('section.h-ks-g h3').allTextContents()).map((t) => t.trim());
    expect(askGroups).toContain('Global');
    expect(askGroups).toContain('Go to');
    expect(askGroups).not.toContain('Recommendation');
    await expect(sheet(page).locator('.h-ks-l', { hasText: /^Doing it/ })).toHaveCount(0);
    // The Ask keys come from the registry (labels from ASK_KEYS in web/horizon/screens/chat.js).
    await expect(sheet(page).locator('.h-ks-l', { hasText: /^New conversation/ })).toHaveCount(1);
    await expect(sheet(page).locator('.h-ks-l', { hasText: /^Focus the question box/ })).toHaveCount(2);
    await expect(sheet(page).locator('section.h-ks-g', { has: page.locator('.h-ks-l', { hasText: /^New conversation/ }) })).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toBeHidden();
  });

  // 12
  test('typing in the Ask composer is not hijacked; Control+K still opens the switcher', async ({ page }) => {
    await gotoRoute(page, 'ask');
    await expectH1(page, ASK_HELLO);
    const box = askInput(page);
    await box.focus();
    await page.keyboard.type('gp?');
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/#\/ask$/);
    await expect(box).toHaveValue('gp?');
    await expect(sheet(page)).toBeHidden();
    await page.keyboard.press('Control+k');
    await expect(switcher(page)).toBeVisible();
    await expect(qsInput(page)).toBeFocused();
  });

  // 14
  test('rec action buttons on Plan carry key hints in their titles', async ({ page }) => {
    const r = proposedRec();
    await gotoRoute(page, 'plan');
    await expectH1(page, 'Everything on the calendar');
    const row = recRow(page, r.id);
    for (const [act, hint] of [['start', '(D)'], ['snooze', '(L)'], ['complete', '(E)'], ['dismiss', '(Shift+X)']]) {
      await expect(row.locator(`[data-act="${act}"]`), act).toHaveAttribute('title', new RegExp(hint.replace(/[()+]/g, '\\$&')));
    }
    for (const [act, hint] of [['start', '(D)'], ['complete', '(E)']]) {
      const all = page.locator(`article.h-row [data-act="${act}"]`);
      const n = await all.count();
      for (let i = 0; i < n; i++) expect(await all.nth(i).getAttribute('title'), `${act} ${i}`).toContain(hint);
    }
  });
});

// 13
test.describe('keys at phone width', { tag: ['@mobile', '@mobile-only'] }, () => {
  test.beforeEach(async ({ request, page }) => {
    expect(page.viewportSize()?.width).toBe(390);
    await resetDemo(request);
  });

  test('the header search button opens the switcher with no horizontal scroll', async ({ page }) => {
    await gotoRoute(page, 'plan');
    const btn = page.locator('header.h-top button.h-search-btn[data-keys="switcher"]');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAttribute('aria-label', 'Search');
    const before = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(before).toBeLessThanOrEqual(390);
    await btn.tap();
    await expect(switcher(page)).toBeVisible();
    await expect(qsInput(page)).toBeFocused();
    const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    expect(widths.doc).toBeLessThanOrEqual(390);
    expect(widths.body).toBeLessThanOrEqual(390);
  });
});
