// Asking from a recommendation (rec conversations become Ask threads). AC1: a question asked in the
// rec dialog, typed or from a chip, shows the Ask page's pending block at once inside the dialog's
// conversation section, streams its progress there (no answer text streams), then lands as a
// Fathom message with Sources; the dialog and the Ask page show the same in-flight question in both directions. AC2:
// the Ask list row and the thread header carry a context chip naming the rec; the dialog links back
// with Open in Ask, and Start over detaches the dialog from the thread while the thread stays in Ask.
// Every title carries AC1 or AC2. The demo's fake engine streams answers in chunks 25 ms apart.

import { openScope } from '../src/storage/index.mjs';
import { test, expect, REMOTE, resetDemo, gotoRoute, plain, rec, recDialog, liveStatus, ASK_THREAD_URL, askInput } from './helpers.mjs';
import { householdStoreFile, localDataDir } from './local-store.mjs';

// The main demo server's household store (households/<id>/fathom.sqlite under E2E_DATA).
const STORE = async () => await householdStoreFile(localDataDir());

// A visible rec with three follow-up chips and a title without tokens.
const REC_ID = 'dcfsa';
const R = rec(REC_ID);
const TITLE = plain(R.title);
const CHIPS = (R.qa || []).map((q) => plain(q.q));
// Unmatched free text: the fake engine answers from the household summary, whose count is a number.
const FREE_Q = 'Give me a quick read on where this one stands';
// A long question: the fake engine echoes every number, so the answer streams for several seconds.
const LONG_Q = (n, from) => `Compare ${Array.from({ length: n }, (_, i) => String(from + i * 7)).join(', ')} for me`;

test.use({ timezoneId: 'UTC' });

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

test('AC1 AC2 precondition: the chosen demo rec is visible and has follow-up chips', () => {
  expect(liveStatus(R)).not.toBe('hidden');
  expect(CHIPS.length).toBeGreaterThanOrEqual(2);
  expect(R.title).not.toMatch(/\{/);
});

/* ---------- helpers ---------- */

const conv = (page) => recDialog(page).locator('section.h-conv');
const composer = (page) => recDialog(page).locator(`form.h-compose[data-free="rec:${REC_ID}"] input[name="q"]`);
const chips = (page) => recDialog(page).locator(`button.h-chip[data-askrec="${REC_ID}"]`);
const side = (page) => page.locator('aside.h-askx-side');
const ctxItems = (page) => side(page).locator('.h-askx-item').filter({ has: page.locator('a.h-askx-ctx') });
const headCtx = (page) => page.locator('header.h-askx-head a.h-askx-ctx');

async function openRec(page) {
  await gotoRoute(page, `rec/${REC_ID}`);
  await expect(recDialog(page)).toBeVisible();
  await expect(recDialog(page).locator('#h-dlg-t')).toHaveText(TITLE);
}

async function postJson(request, path, data, headers = {}) {
  const res = await request.post(path, { headers: { 'content-type': 'application/json', ...headers }, data });
  expect(res.status(), `POST ${path}`).toBe(200);
  return res.json();
}

async function threadList(request) {
  const res = await request.get('/api/threads');
  expect(res.status()).toBe(200);
  return res.json();
}

// Records what the dialog's conversation section showed while an answer was in flight. Only the
// dialog is watched: with the dialog open over the Ask page both may carry a pending block.
async function recordDialog(page) {
  await page.evaluate(() => {
    const log = { order: [], me: null, fathomAtPend: null, steps: [], stream: false, verifiedEarly: false };
    window.__recLog = log;
    const look = () => {
      const section = document.querySelector('.h-dlg section.h-conv');
      const pend = section && section.querySelector('.h-askx-pend');
      if (!pend) return;
      if (!log.order.includes('pend')) {
        log.order.push('pend');
        log.fathomAtPend = section.querySelectorAll('.h-msg.fathom').length;
      }
      const me = pend.querySelector('.h-msg.me.pending');
      if (me && log.me == null) log.me = me.textContent;
      if (pend.querySelector('.h-askx-live .h-work') && !log.order.includes('steps')) log.order.push('steps');
      for (const li of pend.querySelectorAll('.h-work-items li.step span')) if (!log.steps.includes(li.textContent)) log.steps.push(li.textContent);
      if (pend.querySelector('.h-askx-stream')) log.stream = true;
      if (pend.querySelector('.h-askx-live .fx-src, .h-askx-live .fx-fig, .h-askx-live .fx-unverified, .h-askx-live [data-fig]')) log.verifiedEarly = true;
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true });
    look();
  });
}

const recLog = (page) => page.evaluate(() => window.__recLog);

async function askInDialog(page, text) {
  const input = composer(page);
  await expect(input).toBeVisible();
  await input.fill(text);
  await input.press('Enter');
}

// The landed answer: one more Fathom message in the dialog, with Sources, and no pending block.
async function expectLanded(page, count, timeout = 30_000) {
  await expect(conv(page).locator('.h-msg.fathom')).toHaveCount(count, { timeout });
  await expect(conv(page).locator('.h-askx-pend')).toHaveCount(0);
  await expect(conv(page).locator('.h-msg.fathom').last().locator('details.h-src')).toHaveCount(1);
}

/* ---------- AC1: pending and streaming in the dialog ---------- */

test('@mobile AC1 a typed question in the rec dialog shows pending at once, streams progress in the dialog and lands with Sources', async ({ page }) => {
  await openRec(page);
  await expect(conv(page).locator('.h-msg')).toHaveCount(0);
  await recordDialog(page);
  await askInDialog(page, FREE_Q);
  await expectLanded(page, 1);
  await expect(conv(page).locator('.h-msg.me')).toHaveCount(1);
  await expect(conv(page).locator('.h-msg.me').first()).toContainText(FREE_Q);
  await expect(conv(page).locator('.h-msg.me.pending')).toHaveCount(0);

  const log = await recLog(page);
  expect(log.order, JSON.stringify(log)).toEqual(['pend', 'steps']);
  expect(log.fathomAtPend, 'the pending block showed before any answer').toBe(0);
  expect(log.me).toContain(FREE_Q);
  expect(log.steps.length, JSON.stringify(log)).toBeGreaterThan(0);
  expect(log.stream, 'no answer text streams').toBe(false);
  expect(log.verifiedEarly, 'nothing in flight is styled as verified').toBe(false);
  await expect(recDialog(page).locator('.fx-checking')).toHaveCount(0);
});

test('AC1 a chip question in the rec dialog shows pending, streams, lands, and the asked chip disappears', async ({ page }) => {
  await openRec(page);
  await expect(chips(page)).toHaveCount(CHIPS.length);
  const asked = (await chips(page).first().textContent()).trim();
  expect(CHIPS).toContain(asked);
  await recordDialog(page);
  await chips(page).first().click();
  await expectLanded(page, 1);
  await expect(conv(page).locator('.h-msg.me').first()).toContainText(asked);
  await expect(chips(page)).toHaveCount(CHIPS.length - 1);
  await expect(chips(page).filter({ hasText: asked })).toHaveCount(0);

  const log = await recLog(page);
  expect(log.order[0]).toBe('pend');
  expect(log.order, JSON.stringify(log)).toContain('steps');
  expect(log.stream).toBe(false);
  expect(log.fathomAtPend).toBe(0);
  expect(log.me).toContain(asked);
  expect(log.verifiedEarly).toBe(false);
});

test('AC1 with the dialog open over the rec thread on Ask, a question asked in the dialog streams in the dialog', async ({ page, request }) => {
  test.setTimeout(120_000);
  const { thread } = await postJson(request, '/api/threads', { recId: REC_ID, text: 'Synthetic opening question' });
  await gotoRoute(page, `ask/${thread.id}`);
  await expect(page.locator('section.h-askx-main .h-msg.fathom')).toHaveCount(1);
  await headCtx(page).click();
  await expect(page).toHaveURL(new RegExp(`#/rec/${REC_ID}$`));
  await expect(recDialog(page)).toBeVisible();
  await expect(conv(page).locator('.h-msg.fathom')).toHaveCount(1);

  await recordDialog(page);
  await askInDialog(page, LONG_Q(300, 1000));
  await expect(conv(page).locator('.h-askx-pend .h-work.live').first()).toBeVisible();
  await expectLanded(page, 2, 60_000);
  const log = await recLog(page);
  expect(log.order, JSON.stringify(log.order)).toContain('steps');
  expect(log.steps.length, 'the dialog showed the progress steps').toBeGreaterThan(0);
  expect(log.stream).toBe(false);
  expect(log.verifiedEarly).toBe(false);
  const stored = await (await request.get(`/api/threads/${thread.id}`)).json();
  expect(stored.messages.length, 'the dialog question went to the same thread').toBe(4);
});

test('AC1 a question asked on the Ask page in a rec thread shows its pending block in the rec dialog opened mid-stream', async ({ page, request }) => {
  test.setTimeout(120_000);
  const { thread } = await postJson(request, '/api/threads', { recId: REC_ID, text: 'Synthetic opening question' });
  await gotoRoute(page, `ask/${thread.id}`);
  await expect(page.locator('section.h-askx-main .h-msg.fathom')).toHaveCount(1);
  const q = LONG_Q(400, 3000);
  const input = askInput(page);
  await input.fill(q);
  await input.press('Enter');
  await expect(page.locator('section.h-askx-main .h-askx-pend .h-work.live').first()).toBeVisible();

  await headCtx(page).click();
  await expect(recDialog(page)).toBeVisible();
  const pend = conv(page).locator('.h-askx-pend');
  await expect(pend).toHaveCount(1);
  await expect(pend.locator('.h-msg.me.pending')).toContainText('Compare 3000, 3007');
  await expect(pend.locator('.h-askx-live')).toHaveCount(1);
  await expectLanded(page, 2, 60_000);
});

test('AC1 a broken stream for a new rec thread recovers only once the thread has its turn', async ({ page, request }) => {
  test.skip(REMOTE, 'drives the local demo server through a second request');
  test.setTimeout(150_000);
  // The page gets a stream that ends before any event (no thread key arrives), while the same
  // request runs for real on the server: the rec thread exists with zero turns while it answers.
  let real = null;
  await page.route('**/api/threads', async (route) => {
    if (route.request().method() !== 'POST' || real) return route.fallback();
    real = request.post('/api/threads', {
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      data: route.request().postDataJSON(),
    });
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' }, body: '' });
  });
  await openRec(page);
  const q = LONG_Q(450, 5000);
  await askInDialog(page, q);
  await expectLanded(page, 1, 90_000);
  await expect(conv(page).locator('.h-msg.me')).toHaveCount(1);
  await expect(conv(page).locator('.h-msg.me').first()).toContainText('Compare 5000, 5007');
  expect(real, 'the request reached the server').not.toBeNull();
  expect((await real).status()).toBe(200);
  const lists = await threadList(request);
  expect(lists.active.filter((t) => t.recId === REC_ID)).toHaveLength(1);
});

/* ---------- AC2: context chip, Open in Ask, Start over ---------- */

test('AC2 the Ask row and thread header carry the rec chip, Open in Ask links back, Start over detaches and a new question makes a second thread', async ({ page, request }) => {
  test.setTimeout(120_000);
  await openRec(page);
  const recTitle = (await recDialog(page).locator('#h-dlg-t').textContent()).trim();
  expect(recTitle).toBe(TITLE);
  await expect(recDialog(page).locator('a.h-conv-open')).toHaveCount(0);
  await expect(recDialog(page).locator('button.h-conv-reset')).toHaveCount(0);
  await chips(page).first().click();
  await expectLanded(page, 1);
  await expect(chips(page)).toHaveCount(CHIPS.length - 1);

  // The Ask list row: a chip beside (not inside) the row link, the rec title as plain text.
  await gotoRoute(page, 'ask');
  await expect(ctxItems(page)).toHaveCount(1);
  const item = ctxItems(page).first();
  const chip = item.locator('a.h-askx-ctx');
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveText(recTitle);
  await expect(chip).toHaveAttribute('href', `#/rec/${REC_ID}`);
  expect(await chip.evaluate((el) => el.children.length), 'plain text, no markup').toBe(0);
  await expect(item.locator('a.h-askx-row a.h-askx-ctx')).toHaveCount(0);
  await expect(item.locator('a.h-askx-row')).toHaveCount(1);
  const id = await item.locator('a.h-askx-row').getAttribute('data-thread');
  expect(id).toMatch(/^[a-f0-9]{12}$/);

  // The open thread's header chip opens the rec dialog.
  await item.locator('a.h-askx-row').click();
  await expect(page).toHaveURL(new RegExp(`#/ask/${id}$`));
  await expect(headCtx(page)).toHaveText(recTitle);
  await expect(headCtx(page)).toHaveAttribute('href', `#/rec/${REC_ID}`);
  await headCtx(page).click();
  await expect(page).toHaveURL(new RegExp(`#/rec/${REC_ID}$`));
  await expect(recDialog(page)).toBeVisible();
  await expect(conv(page).locator('.h-msg.fathom')).toHaveCount(1);

  // Open in Ask goes to the thread.
  const open = recDialog(page).locator('a.h-conv-open');
  await expect(open).toHaveText('Open in Ask');
  await expect(open).toHaveAttribute('href', `#/ask/${id}`);
  await open.click();
  await expect(page).toHaveURL(new RegExp(`#/ask/${id}$`));
  await expect(page).toHaveURL(ASK_THREAD_URL);

  // Back in the dialog, Start over gives a fresh composer and every chip, and no messages.
  await headCtx(page).click();
  await expect(recDialog(page)).toBeVisible();
  await composer(page).fill('Synthetic unsent draft');
  const reset = recDialog(page).locator('button.h-conv-reset');
  await expect(reset).toHaveText('Start over');
  await reset.click();
  await expect(conv(page).locator('.h-msg')).toHaveCount(0);
  await expect(chips(page)).toHaveCount(CHIPS.length);
  await expect(composer(page)).toHaveValue('');
  await expect(recDialog(page).locator('a.h-conv-open')).toHaveCount(0);
  await expect(recDialog(page).locator('button.h-conv-reset')).toHaveCount(0);

  // The thread is still in the Ask list with its messages.
  const lists = await threadList(request);
  const kept = lists.active.find((t) => t.id === id);
  expect(kept, 'still active in Ask').toBeTruthy();
  expect(kept.recId).toBe(REC_ID);
  expect(typeof kept.recDetachedAt).toBe('string');
  const stored = await (await request.get(`/api/threads/${id}`)).json();
  expect(stored.messages.length).toBe(2);
  await gotoRoute(page, `ask/${id}`);
  await expect(side(page).locator(`a.h-askx-row[data-thread="${id}"]`)).toBeVisible();
  await expect(page.locator('section.h-askx-main .h-msg.fathom')).toHaveCount(1);

  // Asking again from the dialog makes a second thread with the same chip.
  await openRec(page);
  await expect(conv(page).locator('.h-msg')).toHaveCount(0);
  await askInDialog(page, FREE_Q);
  await expectLanded(page, 1);
  await gotoRoute(page, 'ask');
  await expect(ctxItems(page)).toHaveCount(2);
  for (const c of await ctxItems(page).locator('a.h-askx-ctx').all()) await expect(c).toHaveText(recTitle);
  const ids = await ctxItems(page).locator('a.h-askx-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-thread')));
  expect(new Set(ids).size).toBe(2);
  expect(ids).toContain(id);
  const after = await threadList(request);
  expect(after.active.filter((t) => t.recId === REC_ID).map((t) => t.id).sort()).toEqual([...ids].sort());
});

test('AC2 a question sent while Start over is in flight goes to a fresh thread, never the detached one', async ({ page }) => {
  test.setTimeout(120_000);
  const SECOND_Q = 'Second question asked after starting over';
  await openRec(page);
  await askInDialog(page, FREE_Q);
  await expectLanded(page, 1);

  // Hold the start-over request so the in-flight state can be observed.
  let startOverCalls = 0;
  await page.route('**/api/recs/*/start-over', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    startOverCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  const reset = recDialog(page).locator('button.h-conv-reset');
  await expect(reset).toBeEnabled();
  await reset.click();

  // In flight: the dialog renders as when a question is pending.
  const form = recDialog(page).locator(`form.h-compose[data-free="rec:${REC_ID}"]`);
  await expect(composer(page)).toHaveAttribute('readonly', '');
  await expect(form).toHaveAttribute('aria-busy', 'true');
  await expect(reset).toBeDisabled();
  const chipCount = await chips(page).count();
  expect(chipCount).toBeGreaterThan(0);
  for (const c of await chips(page).all()) await expect(c).toBeDisabled();

  // Sends are ignored: a forced chip click and Enter with text in the composer start nothing.
  await chips(page).first().click({ force: true });
  await composer(page).evaluate((el, v) => { el.value = v; }, SECOND_Q);
  await composer(page).press('Enter');
  await page.waitForTimeout(300); // the point is to give an ignored send time to show up
  await expect(conv(page).locator('.h-askx-pend')).toHaveCount(0);
  expect(startOverCalls, 'the start-over request was still held').toBe(1);

  // After the response lands the dialog is clean and idle again.
  await expect(conv(page).locator('.h-msg')).toHaveCount(0);
  await expect(recDialog(page).locator('a.h-conv-open')).toHaveCount(0);
  await expect(composer(page)).not.toHaveAttribute('readonly', /.*/);
  await expect(form).not.toHaveAttribute('aria-busy', 'true');
  await expect(conv(page).locator('.h-askx-pend')).toHaveCount(0);

  // The next question goes to a new thread.
  await askInDialog(page, SECOND_Q);
  await expectLanded(page, 1);
  await expect(conv(page).locator('.h-msg.me')).toHaveCount(1);
  await expect(conv(page).locator('.h-msg.me').first()).toContainText(SECOND_Q);

  await gotoRoute(page, 'ask');
  await expect(ctxItems(page)).toHaveCount(2);
  const ids = await ctxItems(page).locator('a.h-askx-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-thread')));
  expect(new Set(ids).size).toBe(2);
  const mine = page.locator('section.h-askx-main .h-msg.me');
  const [newerId, olderId] = ids; // the list is newest first

  await ctxItems(page).locator(`a.h-askx-row[data-thread="${newerId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/ask/${newerId}$`));
  await expect(page.locator('section.h-askx-main .h-msg.fathom')).toHaveCount(1);
  await expect(mine).toHaveCount(1);
  await expect(mine.first()).toContainText(SECOND_Q);

  await ctxItems(page).locator(`a.h-askx-row[data-thread="${olderId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#/ask/${olderId}$`));
  await expect(page.locator('section.h-askx-main .h-msg.fathom')).toHaveCount(1);
  await expect(mine).toHaveCount(1);
  await expect(mine.first()).toContainText(FREE_Q);
  await expect(mine.first()).not.toContainText(SECOND_Q);
});

test('AC2 clicking the Ask row chip opens the rec dialog', async ({ page, request }) => {
  await postJson(request, '/api/threads', { recId: REC_ID, text: 'Synthetic opening question' });
  await gotoRoute(page, 'ask');
  await expect(ctxItems(page)).toHaveCount(1);
  await ctxItems(page).first().locator('a.h-askx-ctx').click();
  await expect(page).toHaveURL(new RegExp(`#/rec/${REC_ID}$`));
  await expect(recDialog(page).locator('#h-dlg-t')).toHaveText(TITLE);
  await expect(conv(page).locator('.h-msg.fathom')).toHaveCount(1);
});

test('AC2 no chip for a thread without a rec or whose rec no longer exists', async ({ page, request }) => {
  test.skip(REMOTE, 'writes the local demo store; BASE_URL targets a remote server');
  const plainThread = (await postJson(request, '/api/threads', { text: 'Synthetic plain question' })).thread;
  const retired = (await postJson(request, '/api/threads', { recId: REC_ID, text: 'Synthetic question about a retired rec' })).thread;
  // The rec named by the thread is gone (a retired planner rec id that no longer exists).
  const db = await openScope({ path: await STORE(), journal: null, busyTimeout: 0 });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    await db.prepare('UPDATE conversations SET rec_id = ? WHERE key = ?').run('synthetic-retired-rec', retired.key);
  } finally {
    await db.close();
  }
  await gotoRoute(page, 'ask');
  await expect(side(page).locator('a.h-askx-row')).toHaveCount(2);
  await expect(side(page).locator('a.h-askx-ctx')).toHaveCount(0);
  for (const th of [plainThread, retired]) {
    await gotoRoute(page, `ask/${th.id}`);
    await expect(page.locator('section.h-askx-main .h-msg.fathom')).toHaveCount(1);
    await expect(headCtx(page)).toHaveCount(0);
  }
});
