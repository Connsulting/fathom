// Ask answers stream (item 19), at desktop and 390px (every title carries @mobile). The demo's fake
// engine runs its scripted answer in deterministic chunks (FATHOM_FAKE_STREAM_MS apart), so the
// page sees the real event stream: progress labels while the answer is worked out, then the
// grounded answer, once. No answer text streams (ST2). A recorder in the page watches the pending
// block between events; nothing in the app is stubbed except where a test breaks the stream on
// purpose.

import { test, expect, resetDemo, gotoRoute, ASK_THREAD_URL, askInput } from './helpers.mjs';

const QUICK = 'Give me a quick read on where the household stands right now';
const FOLLOW = 'And what should I look at first?';

test.use({ timezoneId: 'UTC' });

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

// Records what the pending block showed while the answer was in flight, and the answer as it
// landed. pinned is measured when the first step shows.
async function record(page) {
  await page.evaluate(() => {
    const before = document.querySelectorAll('.h-askx-msgs .h-msg.fathom').length;
    const log = { order: [], steps: [], answers: [], stream: false, verifiedEarly: false, pinned: null };
    window.__askLog = log;
    const look = () => {
      const pend = document.querySelector('.h-askx-pend');
      if (document.querySelector('.h-askx-stream')) log.stream = true;
      if (pend) {
        for (const li of pend.querySelectorAll('.h-work-items li.step span')) {
          if (!log.steps.includes(li.textContent)) log.steps.push(li.textContent);
        }
        if (pend.querySelector('.h-work-items li.step') && !log.order.includes('steps')) {
          log.order.push('steps');
          const me = pend.querySelector('.h-msg.me');
          const head = document.querySelector('.h-askx-head');
          if (me && head) log.pinned = { me: me.getBoundingClientRect().top, head: head.getBoundingClientRect().bottom, y: window.scrollY };
        }
        if (pend.querySelector('.h-askx-live .fx-src, .h-askx-live .fx-fig, .h-askx-live .fx-unverified, .h-askx-live [data-fig]')) log.verifiedEarly = true;
      }
      const all = document.querySelectorAll('.h-askx-msgs .h-msg.fathom .h-msg-b');
      if (all.length > before) {
        if (!log.order.includes('answer')) log.order.push('answer');
        const t = all[all.length - 1].textContent.replace(/\s+/g, ' ').trim();
        if (t && log.answers[log.answers.length - 1] !== t) log.answers.push(t);
      }
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}

const askLog = (page) => page.evaluate(() => window.__askLog);

async function send(page, text) {
  // Layout must be final before the page measures where to pin the question (a late web font
  // reflows the thread above it).
  await page.evaluate(() => document.fonts.ready);
  const input = askInput(page);
  await expect(input).toBeVisible();
  await input.fill(text);
  await input.press('Enter');
}

async function headBottom(page) {
  return page.locator('.h-askx-head').evaluate((el) => el.getBoundingClientRect().bottom);
}

test('@mobile progress shows before the answer, and the answer appears once with its numbers sourced', async ({ page }) => {
  await gotoRoute(page, 'ask');
  await record(page);
  await send(page, QUICK);
  await expect(page).toHaveURL(ASK_THREAD_URL);
  const answer = page.locator('.h-askx-msgs .h-msg.fathom').last();
  await expect(answer).toBeVisible();
  await expect(page.locator('.h-askx-pend')).toHaveCount(0);

  const log = await askLog(page);
  expect(log.order, JSON.stringify(log)).toEqual(['steps', 'answer']);
  expect(log.steps[0]).toBe('Looking at your household');
  // Labels are fixed plain text: no tool names, arguments or values.
  for (const s of log.steps) expect(s).toMatch(/^[A-Z][a-z ]+$/);
  // No answer text streamed; the answer was set once and stayed as it landed.
  expect(log.stream, JSON.stringify(log)).toBe(false);
  expect(log.verifiedEarly).toBe(false);
  const shown = (await answer.locator('.h-msg-b').textContent()).replace(/\s+/g, ' ').trim();
  expect(log.answers, JSON.stringify(log)).toEqual([shown]);

  // The grounded answer: the number is sourced, nothing is still checking.
  await expect(answer.locator('.fx-src').first()).toBeVisible();
  await expect(page.locator('.fx-checking')).toHaveCount(0);
  await expect(answer.locator('details.h-src')).toHaveCount(1);
});

test('@mobile sending pins the question under the header while the answer grows below it', async ({ page, request }) => {
  // A thread with a long first exchange, so the new question would sit far down the page.
  const many = Array.from({ length: 160 }, (_, i) => String(1000 + i * 7)).join(', ');
  const res = await request.post('/api/threads', { headers: { 'content-type': 'application/json' }, data: { text: `Compare ${many} for me` } });
  expect(res.status()).toBe(200);
  const { thread } = await res.json();
  await gotoRoute(page, `ask/${thread.id}`);
  await expect(page.locator('.h-askx-msgs .h-msg.fathom')).toHaveCount(1);

  await record(page);
  await send(page, FOLLOW);
  await expect(page.locator('.h-askx-msgs .h-msg.fathom')).toHaveCount(2);
  const log = await askLog(page);
  expect(log.pinned).not.toBeNull();
  expect(log.pinned.y).toBeGreaterThan(0);
  expect(log.pinned.me).toBeGreaterThanOrEqual(log.pinned.head - 1);
  expect(log.pinned.me, JSON.stringify(log.pinned)).toBeLessThan(log.pinned.head + 40);

  // After the answer lands the question is still on screen, not scrolled under the header.
  const mine = page.locator('.h-askx-msgs .h-msg.me').last();
  const top = await mine.evaluate((el) => el.getBoundingClientRect().top);
  expect(top).toBeGreaterThanOrEqual((await headBottom(page)) - 1);
  await expect(mine).toBeInViewport();
});

test('@mobile the message list scrolls back to the top of a long answer', async ({ page }) => {
  const many = Array.from({ length: 420 }, (_, i) => String(2000 + i * 3)).join(', ');
  await gotoRoute(page, 'ask');
  await send(page, `Compare ${many} for me`);
  await expect(page).toHaveURL(ASK_THREAD_URL);
  const answer = page.locator('.h-askx-msgs .h-msg.fathom').last();
  await expect(answer).toBeVisible();
  const box = await answer.boundingBox();
  const viewport = page.viewportSize();
  expect(box.height).toBeGreaterThan(viewport.height / 2);

  // Scroll to the end, then wheel all the way back up: nothing traps the scroll.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.mouse.move(viewport.width / 2, viewport.height / 2);
  for (let i = 0; i < 20 && (await page.evaluate(() => window.scrollY)) > 0; i++) await page.mouse.wheel(0, -1500);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  const answerTop = await answer.evaluate((el) => el.getBoundingClientRect().top);
  expect(answerTop).toBeGreaterThanOrEqual(await headBottom(page));
  await expect(page.locator('.h-askx-msgs .h-msg.me').first()).toBeInViewport();
});

test('@mobile reopening a conversation lands on its latest question', async ({ page, request }) => {
  const many = Array.from({ length: 120 }, (_, i) => String(3000 + i * 13)).join(', ');
  const res = await request.post('/api/threads', { headers: { 'content-type': 'application/json' }, data: { text: `Compare ${many} for me` } });
  const { thread } = await res.json();
  const again = await request.post('/api/ask', { headers: { 'content-type': 'application/json' }, data: { key: thread.key, text: FOLLOW } });
  expect(again.status()).toBe(200);
  await gotoRoute(page, `ask/${thread.id}`);
  await page.evaluate(() => document.fonts.ready);
  const latest = page.locator('.h-askx-msgs .h-msg.me').last();
  await expect(latest).toContainText(FOLLOW);
  await expect(latest).toBeInViewport();
  const top = await latest.evaluate((el) => el.getBoundingClientRect().top);
  expect(top).toBeGreaterThanOrEqual((await headBottom(page)) - 1);
});

test('@mobile a broken stream falls back to fetching the stored answer', async ({ page }) => {
  // Let the real request run to completion on the server, then hand the page a stream cut off
  // before its final event.
  await page.route('**/api/threads', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const response = await route.fetch();
    const body = await response.text();
    const cut = body.indexOf('event: final');
    expect(cut).toBeGreaterThan(0);
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' }, body: body.slice(0, cut) });
  });
  await gotoRoute(page, 'ask');
  await record(page);
  await send(page, QUICK);
  await expect(page).toHaveURL(ASK_THREAD_URL);
  const answer = page.locator('.h-askx-msgs .h-msg.fathom').last();
  await expect(answer.locator('.fx-src').first()).toBeVisible();
  await expect(page.locator('.fx-err')).toHaveCount(0);
  await expect(page.locator('.h-askx-msgs .h-msg.me')).toHaveCount(1);
  const log = await askLog(page);
  expect(log.verifiedEarly).toBe(false);
  expect(log.stream).toBe(false);
});

test('@mobile-only an answer at 390px, and the work block while one is in flight', async ({ page }, info) => {
  await gotoRoute(page, 'ask');
  await send(page, 'What should we do before the year ends? Please list the steps.');
  await expect(page).toHaveURL(ASK_THREAD_URL);
  await expect(page.locator('.h-askx-msgs .h-msg.fathom')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('ask-stream-390.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // In flight: a long answer takes a few seconds; the pending block shows the live work block only.
  const many = Array.from({ length: 300 }, (_, i) => String(5000 + i * 3)).join(', ');
  await send(page, `Compare ${many} for me`);
  await expect(page.locator('.h-askx-pend .h-work.live').first()).toBeVisible();
  await expect(page.locator('.h-askx-stream')).toHaveCount(0);
  await page.locator('.h-askx-live').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: info.outputPath('ask-stream-390-live.png') });
  await expect(page.locator('.h-askx-msgs .h-msg.fathom')).toHaveCount(2);
});
