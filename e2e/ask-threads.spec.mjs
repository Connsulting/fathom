// Ask as conversations (item 13). AC1: the sidebar lists conversations grouped by last activity,
// with new, archive, trash, restore, delete forever and rename. AC2: #/ask is a centered empty
// state with starter chips; sending docks the composer under a centered message column. AC7: the
// Ask keys (c, /, Ctrl+L; Enter, Shift+Enter and Escape in the composer). AC8: at phone width the
// sidebar is an overlay behind the Conversations button. Every test title carries its AC tag.
//
// The age bucketing test writes conversations.last_at straight into the main demo server's store
// (its household store under the E2E_DATA playwright.config.mjs gives it), because the app clock
// stamps every new thread with today. It skips when BASE_URL targets a remote server.

import { DatabaseSync } from 'node:sqlite';
import { test, expect, S, REMOTE, resetDemo, gotoRoute, expectH1, ASK_HELLO, ASK_THREAD_URL, askInput, askOnAsk } from './helpers.mjs';
import { householdStoreFile, localDataDir } from './local-store.mjs';

// The main demo server's household store (households/<id>/fathom.sqlite under E2E_DATA).
const STORE = () => householdStoreFile(localDataDir());

const STARTERS = [
  ['attention', 'What needs my attention right now?'],
  ['taxes', 'How are our tax payments tracking this year?'],
  ['scorp', 'How is the S corp doing this year?'],
  ['yearend', 'What should we do before the year ends?']
];
const FREE_Q = 'Give me a quick read on where the household stands right now';
// A thread is named after its first answer; the fake engine's title is the first question cut to 48 characters.
const FREE_TITLE = 'Give me a quick read on where the household';
const GROUPS = ['Today', 'Yesterday', 'Previous 7 days', 'Older'];

// Grouping compares dates against the app clock; pin the browser zone so a thread stamped late in
// the UTC day still reads as today.
test.use({ timezoneId: 'UTC' });

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

/* ---------- API ---------- */

async function postJson(request, path, data = {}) {
  const res = await request.post(path, { headers: { 'content-type': 'application/json' }, data });
  expect(res.status(), `POST ${path}`).toBe(200);
  return res.json();
}

// Creates a conversation and asks `text` in it. Returns the thread JSON.
async function newThread(request, text) {
  const body = await postJson(request, '/api/threads', { text });
  expect(body.thread.id).toMatch(/^[a-f0-9]{12}$/);
  expect(body.thread.key).toBe(`ask:${body.thread.id}`);
  return body.thread;
}

async function threads(request) {
  const res = await request.get('/api/threads');
  expect(res.status()).toBe(200);
  return res.json();
}

const ids = (list) => (list || []).map((t) => t.id);

test('AC10 opening a fallback thread requests its one title repair and reload does not repeat it', async ({ page, request }) => {
  test.skip(REMOTE, 'This check reads the local demo spend ledger.');
  const thread = await newThread(request, '529 contributions.');
  const store = new DatabaseSync(STORE());
  try { store.prepare("UPDATE conversations SET title = '529 contributions.', title_source = 'auto' WHERE key = ?").run(thread.key); }
  finally { store.close(); }
  const titleCalls = () => {
    const db = new DatabaseSync(STORE(), { readOnly: true });
    try { return db.prepare("SELECT count(*) AS n FROM spend_ledger WHERE purpose = 'title'").get().n; }
    finally { db.close(); }
  };
  const before = titleCalls();
  await gotoRoute(page, 'ask');
  const opened = page.waitForResponse(r => r.request().method() === 'GET' && new URL(r.url()).pathname === `/api/threads/${thread.id}`);
  await row(page, thread.id).click();
  expect((await opened).status()).toBe(200);
  expect(titleCalls()).toBe(before + 1);
  await expect(title(page)).toHaveText('529 contributions');
  await expect(row(page, thread.id)).toContainText('529 contributions');
  const reopened = page.waitForResponse(r => r.request().method() === 'GET' && new URL(r.url()).pathname === `/api/threads/${thread.id}`);
  await page.reload();
  expect((await reopened).status()).toBe(200);
  expect(titleCalls()).toBe(before + 1);
});

test('AC10 creating a thread preserves its repair attempt for a later opening', async ({ page }) => {
  test.skip(REMOTE, 'This check reads the local demo spend ledger.');
  await gotoRoute(page, 'ask');
  const reads = [];
  page.on('request', r => { if (r.method() === 'GET' && /\/api\/threads\/[a-f0-9]{12}$/.test(new URL(r.url()).pathname)) reads.push(r.url()); });
  const id = await askOnAsk(page, '529 contributions');
  const db = new DatabaseSync(STORE(), { readOnly: true });
  try {
    expect(db.prepare('SELECT value FROM settings WHERE key = ?').get(`ask.titleRetried.ask:${id}`)).toBeUndefined();
    expect(reads).toEqual([]);
  } finally { db.close(); }
  await gotoRoute(page, 'ask');
  const opened = page.waitForResponse(r => r.request().method() === 'GET' && new URL(r.url()).pathname === `/api/threads/${id}`);
  await row(page, id).click();
  expect((await opened).status()).toBe(200);
});

/* ---------- page ---------- */

const side = (page) => page.locator('aside.h-askx-side');
const main = (page) => page.locator('section.h-askx-main');
const msgs = (page) => page.locator('div.h-askx-msgs');
const title = (page) => page.locator('header.h-askx-head h2.h-askx-title');
const row = (page, id) => side(page).locator(`a.h-askx-row[data-thread="${id}"]`);

// A row action button. Assumption (the DOM contract does not pin it): the action buttons sit
// inside the row link or inside a per-row wrapper that directly contains the row link.
function rowAct(page, id, act) {
  const r = `a.h-askx-row[data-thread="${id}"]`;
  return side(page).locator(`:is(${r}, :has(> ${r}):not(.h-askx-group)) button[data-thread-act="${act}"]`);
}

function group(page, name) {
  return side(page).locator('div.h-askx-group').filter({ has: page.locator('h3', { hasText: new RegExp(`^${name}$`) }) });
}

async function rowIds(scope) {
  return scope.locator('a.h-askx-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-thread')));
}

function viewBtn(page, view) {
  return side(page).locator(`button.h-askx-view[data-view="${view}"]`);
}

// The footer count; an absent or empty em reads as 0.
async function viewCount(page, view) {
  return viewBtn(page, view).evaluate((b) => Number((b.querySelector('em')?.textContent || '').trim() || 0));
}

// True when the element is laid out, not transparent and not hidden by an ancestor.
async function shown(loc) {
  if (!(await loc.count())) return false;
  return loc.first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.1) return false;
    }
    return true;
  });
}

// Shown and at least partly inside the viewport (an off-canvas drawer is not on screen).
async function onScreen(loc) {
  if (!(await shown(loc))) return false;
  return loc.first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.right > 1 && r.left < window.innerWidth - 1 && r.bottom > 1 && r.top < window.innerHeight - 1;
  });
}

// Back to the main list from Archived or Trash, unless the build already went back by itself.
async function backToMain(page) {
  const back = side(page).locator('button.h-askx-back');
  if (await back.isVisible()) await back.click();
  await expect(back).toBeHidden();
}

async function box(loc) {
  const b = await loc.boundingBox();
  expect(b, 'element has a layout box').toBeTruthy();
  return b;
}

async function openThread(page, id) {
  await gotoRoute(page, `ask/${id}`);
  await expect(page).toHaveURL(new RegExp(`#/ask/${id}$`));
  await expect(title(page)).toBeVisible();
}

async function blurAll(page) {
  await page.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body || document.activeElement == null)).toBe(true);
}

/* ---------- AC2: empty state, starter chips, docking ---------- */

test('AC2: #/ask shows the centered empty state with the question, the input and a round send button', async ({ page }) => {
  await gotoRoute(page, 'ask');
  await expect(page).toHaveURL(/#\/ask$/);
  const hello = page.locator('section.h-askx-main .h-askx-empty h1.h-askx-hello');
  await expect(hello).toHaveText(ASK_HELLO);
  await expectH1(page, ASK_HELLO);

  const empty = page.locator('.h-askx-empty');
  const form = empty.locator('form.h-askx-compose');
  const input = form.locator('textarea[name="q"]');
  const send = form.locator('button.h-askx-send');
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute('placeholder', 'Ask anything about your money');
  await expect(send).toBeVisible();
  await expect(send).toHaveAccessibleName('Send');

  const round = await send.evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const radius = cs.borderTopLeftRadius;
    if (radius.trim().endsWith('%')) return parseFloat(radius) >= 50;
    return parseFloat(radius) >= Math.min(r.width, r.height) / 2 - 0.5;
  });
  expect(round, 'send button is round').toBe(true);

  // Horizontally: the empty state's center matches the main pane's.
  const m = await box(main(page));
  const e = await box(empty);
  expect(Math.abs((e.x + e.width / 2) - (m.x + m.width / 2)), 'empty state horizontal center offset').toBeLessThan(40);

  // Vertically: the heading plus the input block sits in the middle of the visible main area.
  const vh = await page.evaluate(() => window.innerHeight);
  const top = Math.max(m.y, 0);
  const bottom = Math.min(m.y + m.height, vh);
  const visible = bottom - top;
  expect(visible).toBeGreaterThan(200);
  const h = await box(hello);
  const f = await box(form);
  const blockCenter = (h.y + f.y + f.height) / 2;
  expect(Math.abs(blockCenter - (top + bottom) / 2), 'heading and input vertical center offset').toBeLessThan(visible * 0.15);
});

test('AC2: the starter chips are the four figure-free starters in order', async ({ page }) => {
  await gotoRoute(page, 'ask');
  await expectH1(page, ASK_HELLO);
  const chips = page.locator('.h-askx-empty div.h-askx-chips button.h-chip[data-starter]');
  const n = await chips.count();
  expect(n).toBeGreaterThanOrEqual(3);
  expect(n).toBeLessThanOrEqual(4);
  // The demo store has open recs, tax payments and S corp income, so all four show.
  await expect(chips).toHaveCount(4);
  const got = await chips.evaluateAll((els) => els.map((e) => [e.getAttribute('data-starter'), e.textContent.trim()]));
  expect(got).toEqual(STARTERS);
  for (const [, text] of got) expect(text, `starter "${text}" carries no figure`).not.toMatch(/[\d$]/);
  for (let i = 0; i < 4; i++) await expect(chips.nth(i)).toBeVisible();
  // The old suggested-question chips are gone.
  await expect(page.locator('button.h-chip[data-ask]')).toHaveCount(0);
});

test('AC2: a starter chip sends; the owner bubble is right-aligned and the composer docks at the bottom', async ({ page }) => {
  const [id, text] = STARTERS[0];
  await gotoRoute(page, 'ask');
  await expectH1(page, ASK_HELLO);
  await page.locator(`button.h-chip[data-starter="${id}"]`).click();

  await expect(page).toHaveURL(ASK_THREAD_URL);
  const mine = msgs(page).locator('.h-msg.me');
  await expect(mine).toHaveCount(1);
  await expect(mine.first()).toContainText(text);
  const reply = msgs(page).locator('.h-msg.fathom');
  await expect(reply).toHaveCount(1);
  await expect(reply.first()).not.toHaveClass(/\bnotice\b/);
  await expect(reply.first().locator('details.h-src')).toHaveCount(1);

  await expect(page.locator('.h-askx-empty')).toHaveCount(0);
  await expect(page.locator('h1.h-askx-hello')).toHaveCount(0);
  // Named after the first answer (the fake engine's title is the starter question itself).
  await expect(title(page)).toHaveText(text);

  // Owner bubble hugs the right edge of the message column.
  const col = await box(msgs(page));
  const b = await box(mine.first());
  expect(Math.abs((col.x + col.width) - (b.x + b.width)), 'owner bubble right edge offset').toBeLessThan(24);
  expect(b.x - col.x, 'owner bubble starts well right of the column').toBeGreaterThan(80);

  // The message column is a centered reading column.
  const m = await box(main(page));
  expect(col.width).toBeLessThanOrEqual(760);
  expect(Math.abs((col.x + col.width / 2) - (m.x + m.width / 2)), 'message column center offset').toBeLessThan(24);

  // The docked composer sits at the bottom of the viewport once scrolled to the end.
  const docked = page.locator('form.h-askx-compose.docked');
  await expect(docked).toBeVisible();
  await expect(docked.locator('textarea[name="q"]')).toBeVisible();
  await page.evaluate(() => {
    for (const el of [document.scrollingElement, document.querySelector('section.h-askx-main'), document.querySelector('div.h-askx-msgs')]) {
      if (el) el.scrollTop = el.scrollHeight;
    }
  });
  const fb = await box(docked);
  const vh = await page.evaluate(() => window.innerHeight);
  expect(fb.y + fb.height, 'composer bottom is inside the viewport').toBeLessThanOrEqual(vh + 1);
  expect(vh - (fb.y + fb.height), 'composer bottom gap to the viewport bottom').toBeLessThan(24);
});

test('AC2 AC7: in the composer Enter sends, Shift+Enter adds a line and Escape blurs', async ({ page }) => {
  await gotoRoute(page, 'ask');
  await expectH1(page, ASK_HELLO);
  const input = askInput(page);
  await input.click();
  await page.keyboard.type('first line');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('second line');
  await expect(input).toHaveValue('first line\nsecond line');
  await expect(page).toHaveURL(/#\/ask$/);
  await expect(page.locator('.h-msg.me')).toHaveCount(0);

  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(input).not.toBeFocused();
  await expect(page).toHaveURL(/#\/ask$/);

  await input.fill(FREE_Q);
  await input.press('Enter');
  await expect(page).toHaveURL(ASK_THREAD_URL);
  await expect(msgs(page).locator('.h-msg.me')).toHaveCount(1);
  await expect(msgs(page).locator('.h-msg.me').first()).toContainText(FREE_Q);
  await expect(msgs(page).locator('.h-msg.fathom')).toHaveCount(1);
});

/* ---------- AC1: sidebar ---------- */

test('AC1: the Ask button starts a new conversation and the earlier one is listed under Today', async ({ page }) => {
  await gotoRoute(page, 'ask');
  await expect(side(page)).toBeVisible();
  await expect(side(page).locator('a.h-askx-row')).toHaveCount(0);
  const id = await askOnAsk(page, FREE_Q);

  const btn = side(page).locator('button.h-askx-new');
  await expect(btn).toBeVisible();
  await expect(btn).toContainText('Ask');
  await expect(btn.locator('kbd')).toHaveText('C');
  await btn.click();

  await expect(page).toHaveURL(/#\/ask$/);
  await expectH1(page, ASK_HELLO);
  await expect(askInput(page)).toBeVisible();
  await expect(msgs(page).locator('.h-msg')).toHaveCount(0);

  const today = group(page, 'Today');
  await expect(today).toHaveCount(1);
  const r = today.locator(`a.h-askx-row[data-thread="${id}"]`);
  await expect(r).toBeVisible();
  await expect(r).toHaveAttribute('href', `#/ask/${id}`);
  await expect(r.locator('span.h-askx-t')).toHaveText(FREE_TITLE);
  await expect(r).not.toHaveClass(/\bon\b/);
});

test('AC1: rows group under Today, newest activity first, the open row is marked and empty groups are hidden', async ({ page, request }) => {
  const a = await newThread(request, 'What is our cash runway looking like');
  const b = await newThread(request, 'Which accounts moved the most lately');

  await openThread(page, a.id);
  await expect(side(page).locator('div.h-askx-group h3')).toHaveText(['Today']);
  for (const name of GROUPS.slice(1)) await expect(group(page, name)).toHaveCount(0);
  const today = group(page, 'Today');
  expect(await rowIds(today)).toEqual([b.id, a.id]);

  await expect(row(page, a.id)).toHaveClass(/\bon\b/);
  await expect(row(page, a.id)).toHaveAttribute('aria-current', 'page');
  await expect(row(page, b.id)).not.toHaveClass(/\bon\b/);
  await expect(row(page, b.id)).not.toHaveAttribute('aria-current', 'page');

  // Asking again in the older conversation moves it to the top.
  await askOnAsk(page, 'And what about the next quarter');
  await expect(page).toHaveURL(new RegExp(`#/ask/${a.id}$`));
  await expect.poll(() => rowIds(today)).toEqual([a.id, b.id]);
  expect(ids((await threads(request)).active)).toEqual([a.id, b.id]);
});

test('AC1: rows group into Today, Yesterday, Previous 7 days and Older by last activity against the app clock', async ({ page, request }) => {
  test.skip(REMOTE, 'writes the local demo store; BASE_URL targets a remote server');
  const day = (n) => new Date(Date.parse(`${S.meta.clock}T12:00:00.000Z`) - n * 86_400_000).toISOString();
  const ages = [0, 1, 2, 7, 8, 40];
  const made = {};
  for (const n of ages) made[n] = await newThread(request, `Synthetic question for the ${n} day bucket`);

  const db = new DatabaseSync(STORE());
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const set = db.prepare('UPDATE conversations SET last_at = ? WHERE key = ?');
    for (const n of ages) expect(Number(set.run(day(n), `ask:${made[n].id}`).changes), `last_at for the ${n} day thread`).toBe(1);
  } finally {
    db.close();
  }

  await gotoRoute(page, 'ask');
  await expectH1(page, ASK_HELLO);
  await expect(side(page).locator('div.h-askx-group h3')).toHaveText(GROUPS);
  expect(await rowIds(group(page, 'Today'))).toEqual([made[0].id]);
  expect(await rowIds(group(page, 'Yesterday'))).toEqual([made[1].id]);
  expect(await rowIds(group(page, 'Previous 7 days'))).toEqual([made[2].id, made[7].id]);
  expect(await rowIds(group(page, 'Older'))).toEqual([made[8].id, made[40].id]);
});

test('AC1: row actions Archive and Move to Trash appear on hover', async ({ page, request }) => {
  const t = await newThread(request, FREE_Q);
  await gotoRoute(page, 'ask');
  await expectH1(page, ASK_HELLO);
  await blurAll(page);
  await page.mouse.move(0, 0);

  const r = row(page, t.id);
  await expect(r).toBeVisible();
  const archive = rowAct(page, t.id, 'archive');
  const trash = rowAct(page, t.id, 'trash');
  await expect(archive).toHaveCount(1);
  await expect(trash).toHaveCount(1);
  await expect(archive).toHaveAccessibleName('Archive');
  await expect(trash).toHaveAccessibleName('Move to Trash');
  expect(await shown(archive), 'Archive hidden before hover').toBe(false);
  expect(await shown(trash), 'Move to Trash hidden before hover').toBe(false);

  await r.hover();
  await expect.poll(() => shown(archive)).toBe(true);
  await expect.poll(() => shown(trash)).toBe(true);
});

test('AC1: Archive moves a conversation to Archived and Restore brings it back', async ({ page, request }) => {
  const t = await newThread(request, FREE_Q);
  await gotoRoute(page, 'ask');
  await expectH1(page, ASK_HELLO);
  await expect(row(page, t.id)).toBeVisible();
  await expect.poll(() => viewCount(page, 'archived')).toBe(0);

  await row(page, t.id).hover();
  await rowAct(page, t.id, 'archive').click();
  await expect(row(page, t.id)).toHaveCount(0);
  await expect(viewBtn(page, 'archived')).toContainText('Archived');
  await expect(viewBtn(page, 'archived').locator('em')).toHaveText('1');
  let list = await threads(request);
  expect(ids(list.active)).not.toContain(t.id);
  expect(ids(list.archived)).toEqual([t.id]);

  await viewBtn(page, 'archived').click();
  await expect(row(page, t.id)).toBeVisible();
  const restore = rowAct(page, t.id, 'restore');
  await expect(restore).toHaveCount(1);
  await expect(restore).toHaveAccessibleName('Restore');
  await row(page, t.id).hover();
  await restore.click();
  await expect.poll(() => viewCount(page, 'archived')).toBe(0);

  await backToMain(page);
  await expect(group(page, 'Today').locator(`a.h-askx-row[data-thread="${t.id}"]`)).toBeVisible();
  await expect.poll(() => viewCount(page, 'archived')).toBe(0);
  list = await threads(request);
  expect(ids(list.active)).toContain(t.id);
  expect(ids(list.archived)).toEqual([]);
});

test('AC1: Trash, Restore, then Delete forever removes the conversation everywhere', async ({ page, request }) => {
  // A confirm prompt, if the build adds one, is accepted.
  page.on('dialog', (d) => d.accept());
  const t = await newThread(request, FREE_Q);
  await gotoRoute(page, 'ask');
  await expectH1(page, ASK_HELLO);
  await expect.poll(() => viewCount(page, 'trash')).toBe(0);

  const toTrash = async () => {
    await row(page, t.id).hover();
    await rowAct(page, t.id, 'trash').click();
    await expect(row(page, t.id)).toHaveCount(0);
    await expect(viewBtn(page, 'trash')).toContainText('Trash');
    await expect(viewBtn(page, 'trash').locator('em')).toHaveText('1');
  };

  await toTrash();
  expect(ids((await threads(request)).trash)).toEqual([t.id]);
  await viewBtn(page, 'trash').click();
  await expect(side(page).getByText('Deleted forever after 30 days.', { exact: true })).toBeVisible();
  await expect(row(page, t.id)).toBeVisible();
  await expect(rowAct(page, t.id, 'restore')).toHaveAccessibleName('Restore');
  await expect(rowAct(page, t.id, 'delete')).toHaveAccessibleName('Delete forever');
  await row(page, t.id).hover();
  await rowAct(page, t.id, 'restore').click();
  await expect.poll(() => viewCount(page, 'trash')).toBe(0);
  await backToMain(page);
  await expect(row(page, t.id)).toBeVisible();
  await expect.poll(() => viewCount(page, 'trash')).toBe(0);

  await toTrash();
  await viewBtn(page, 'trash').click();
  await expect(row(page, t.id)).toBeVisible();
  await row(page, t.id).hover();
  await rowAct(page, t.id, 'delete').click();
  await expect(row(page, t.id)).toHaveCount(0);
  await expect.poll(() => viewCount(page, 'trash')).toBe(0);

  const list = await threads(request);
  for (const k of ['active', 'archived', 'trash']) expect(ids(list[k]), `${k} after delete`).not.toContain(t.id);
  const gone = await request.get(`/api/threads/${t.id}`);
  expect(gone.status()).toBe(404);
});

test('AC1: rename by double click or the Rename button; Enter saves, Escape cancels', async ({ page, request }) => {
  const name = 'Quarterly planning notes';
  const t = await newThread(request, FREE_Q);
  await openThread(page, t.id);
  await expect(title(page)).toHaveText(FREE_TITLE);

  await title(page).dblclick();
  const input = page.locator('header.h-askx-head input.h-askx-rename');
  await expect(input).toBeVisible();
  await input.fill(name);
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expect(title(page)).toHaveText(name);
  await expect(row(page, t.id).locator('span.h-askx-t')).toHaveText(name);

  await page.reload();
  await expect(title(page)).toHaveText(name);
  await expect(row(page, t.id).locator('span.h-askx-t')).toHaveText(name);
  let saved = (await threads(request)).active.find((x) => x.id === t.id);
  expect(saved.title).toBe(name);
  expect(saved.titleSource).toBe('manual');

  const btn = page.locator('header.h-askx-head button[data-thread-act="rename"]');
  await expect(btn).toHaveAccessibleName('Rename');
  await btn.click();
  await expect(input).toBeVisible();
  await input.fill('Something else entirely');
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(title(page)).toHaveText(name);
  await expect(row(page, t.id).locator('span.h-askx-t')).toHaveText(name);

  await page.reload();
  await expect(title(page)).toHaveText(name);
  saved = (await threads(request)).active.find((x) => x.id === t.id);
  expect(saved.title).toBe(name);
});

test('AC1: reopening a conversation shows its history and a new question appends to it', async ({ page }) => {
  const q1 = FREE_Q;
  const q2 = 'What should we watch over the next few weeks';
  const q3 = 'Anything else we should keep an eye on';

  await gotoRoute(page, 'ask');
  const id = await askOnAsk(page, q1);
  expect(await askOnAsk(page, q2)).toBe(id);
  await expect(msgs(page).locator('.h-msg')).toHaveCount(4);

  await side(page).locator('button.h-askx-new').click();
  await expect(page).toHaveURL(/#\/ask$/);
  await expectH1(page, ASK_HELLO);

  await row(page, id).click();
  await expect(page).toHaveURL(new RegExp(`#/ask/${id}$`));
  const all = msgs(page).locator('.h-msg');
  await expect(all).toHaveCount(4);
  const roles = await all.evaluateAll((els) => els.map((e) => (e.classList.contains('me') ? 'me' : e.classList.contains('fathom') ? 'fathom' : 'other')));
  expect(roles).toEqual(['me', 'fathom', 'me', 'fathom']);
  await expect(msgs(page).locator('.h-msg.me').nth(0)).toContainText(q1);
  await expect(msgs(page).locator('.h-msg.me').nth(1)).toContainText(q2);
  await expect(row(page, id)).toHaveClass(/\bon\b/);

  expect(await askOnAsk(page, q3)).toBe(id);
  await expect(page).toHaveURL(new RegExp(`#/ask/${id}$`));
  await expect(all).toHaveCount(6);
  await expect(msgs(page).locator('.h-msg.me').nth(2)).toContainText(q3);
});

/* ---------- AC7: keys ---------- */

test('AC7: c starts a new conversation, / and Ctrl+L focus the input, typing c in the input stays put, other routes ignore c', async ({ page, request }) => {
  const t = await newThread(request, FREE_Q);

  await openThread(page, t.id);
  await blurAll(page);
  await page.keyboard.press('c');
  await expect(page).toHaveURL(/#\/ask$/);
  await expectH1(page, ASK_HELLO);
  await expect(page.locator('.h-askx-empty textarea[name="q"]')).toBeFocused();

  await openThread(page, t.id);
  const docked = page.locator('form.h-askx-compose.docked textarea[name="q"]');
  await blurAll(page);
  await page.keyboard.press('/');
  await expect(docked).toBeFocused();
  await expect(docked).toHaveValue('');
  await expect(page).toHaveURL(new RegExp(`#/ask/${t.id}$`));

  await blurAll(page);
  await page.keyboard.press('Control+l');
  await expect(docked).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`#/ask/${t.id}$`));

  // While typing, c is just a letter.
  await page.keyboard.type('c');
  await expect(docked).toHaveValue('c');
  await expect(page).toHaveURL(new RegExp(`#/ask/${t.id}$`));
  await expect(title(page)).toBeVisible();

  await gotoRoute(page, 'plan');
  await expectH1(page, 'Everything on the calendar');
  await blurAll(page);
  await page.keyboard.press('c');
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/#\/plan$/);
  await expectH1(page, 'Everything on the calendar');
});

/* ---------- AC8: phone ---------- */

test.describe('AC8 phone', { tag: '@mobile' }, () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('AC8: at 390px the sidebar opens from Conversations and closes when a row is chosen', async ({ page, request }) => {
    const a = await newThread(request, FREE_Q);
    const b = await newThread(request, 'Which accounts moved the most lately');

    await gotoRoute(page, 'ask');
    await expectH1(page, ASK_HELLO);
    await expect.poll(() => onScreen(side(page)), { message: 'sidebar off screen at phone width' }).toBe(false);
    const noScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(await noScroll(), 'no horizontal page scroll on #/ask').toBe(true);

    const menu = page.locator('button.h-askx-menu').filter({ visible: true });
    await expect(menu).toHaveCount(1);
    await expect(menu).toHaveAccessibleName('Conversations');
    await menu.click();
    await expect(page.locator('aside.h-askx-side.open')).toHaveCount(1);
    await expect.poll(() => onScreen(side(page))).toBe(true);
    await expect(row(page, a.id)).toBeVisible();
    await expect(row(page, b.id)).toBeVisible();
    expect(await noScroll(), 'no horizontal page scroll with the sidebar open').toBe(true);
    const tabTop = () => page.locator('nav.h-tabs').evaluate((n) => n.getBoundingClientRect().top);
    const bottomOf = (sel) => page.locator(sel).first().evaluate((n) => n.getBoundingClientRect().bottom);
    await expect(page.locator('nav.h-tabs')).toBeVisible();
    expect(await bottomOf('aside.h-askx-side .h-askx-foot'), 'sidebar footer clears the tab bar').toBeLessThanOrEqual(await tabTop());

    await row(page, a.id).click();
    await expect(page).toHaveURL(new RegExp(`#/ask/${a.id}$`));
    await expect(title(page)).toBeVisible();
    await expect(page.locator('aside.h-askx-side.open')).toHaveCount(0);
    await expect.poll(() => onScreen(side(page))).toBe(false);
    expect(await noScroll(), 'no horizontal page scroll in a conversation').toBe(true);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(page.locator('.h-askx-compose.docked')).toBeVisible();
    expect(await bottomOf('.h-askx-compose.docked'), 'docked input clears the tab bar').toBeLessThanOrEqual(await tabTop());
  });
});
