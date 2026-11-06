// Ask answers stream (item 19), at desktop and 390px (every title carries @mobile). The demo's fake
// engine streams its scripted answer in deterministic chunks (FATHOM_FAKE_STREAM_MS apart), so the
// page sees the real event stream: progress labels first, then text whose numbers are still being
// checked, then the grounded answer. A recorder in the page watches the pending block between
// events; nothing in the app is stubbed except where a test breaks the stream on purpose.

import { test, expect, resetDemo, gotoRoute, ASK_THREAD_URL, askInput } from './helpers.mjs';

const QUICK = 'Give me a quick read on where the household stands right now';
const FOLLOW = 'And what should I look at first?';

test.use({ timezoneId: 'UTC' });

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

// Records what the pending block showed while the answer streamed.
async function record(page) {
  await page.evaluate(() => {
    const log = { order: [], steps: [], texts: [], checking: false, verifiedEarly: false, pinned: null };
    window.__askLog = log;
    const look = () => {
      const pend = document.querySelector('.h-askx-pend');
      if (!pend) return;
      for (const li of pend.querySelectorAll('.h-askx-steps li span')) {
        if (!log.steps.includes(li.textContent)) log.steps.push(li.textContent);
      }
      if (pend.querySelector('.h-askx-steps') && !log.order.includes('steps')) log.order.push('steps');
      const st = pend.querySelector('.h-askx-stream');
      if (!st) return;
      if (!log.order.includes('text')) {
        log.order.push('text');
        const me = pend.querySelector('.h-msg.me');
        const head = document.querySelector('.h-askx-head');
        if (me && head) log.pinned = { me: me.getBoundingClientRect().top, head: head.getBoundingClientRect().bottom, y: window.scrollY, max: document.documentElement.scrollHeight - window.innerHeight, ih: window.innerHeight, pend: pend.getBoundingClientRect().height };
      }
      const t = st.textContent;
      if (log.texts[log.texts.length - 1] !== t) log.texts.push(t);
      if (st.querySelector('.fx-checking')) log.checking = true;
      if (st.querySelector('.fx-src, .fx-fig, .fx-unverified, [data-fig]')) log.verifiedEarly = true;
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}

const askLog = (page) => page.evaluate(() => window.__askLog);

async function send(page, text) {
  const input = askInput(page);
  await expect(input).toBeVisible();
  await input.fill(text);
  await input.press('Enter');
}

async function headBottom(page) {
  return page.locator('.h-askx-head').evaluate((el) => el.getBoundingClientRect().bottom);
}

test('@mobile progress shows before text, text streams, and numbers flip from checking to sourced', async ({ page }) => {
  await gotoRoute(page, 'ask');
  await record(page);
  await send(page, QUICK);
  await expect(page).toHaveURL(ASK_THREAD_URL);
  const answer = page.locator('.h-askx-msgs .h-msg.fathom').last();
  await expect(answer).toBeVisible();
  await expect(page.locator('.h-askx-pend')).toHaveCount(0);

  const log = await askLog(page);
  expect(log.order).toEqual(['steps', 'text']);
  expect(log.steps[0]).toBe('Reading your household summary');
  // Labels are fixed plain text: no tool names, arguments or values.
  for (const s of log.steps) expect(s).toMatch(/^[A-Z][a-z ]+$/);
  // The text grew over several paints, and its numbers were only ever in the checking style.
  expect(log.texts.length).toBeGreaterThan(2);
  expect(log.texts[0].length).toBeLessThan(log.texts[log.texts.length - 1].length);
  expect(log.checking).toBe(true);
  expect(log.verifiedEarly).toBe(false);

  // The grounded answer replaced the stream: the number is sourced now, nothing is still checking.
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
  console.log(JSON.stringify(log.pinned));
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
});

test('@mobile-only a streamed answer at 390px', async ({ page }, info) => {
  await gotoRoute(page, 'ask');
  await send(page, 'What should we do before the year ends? Please list the steps.');
  await expect(page).toHaveURL(ASK_THREAD_URL);
  await expect(page.locator('.h-askx-msgs .h-msg.fathom')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('ask-stream-390.png') });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // Mid-stream: a long answer streams for a few seconds; its numbers are still in the checking style.
  const many = Array.from({ length: 300 }, (_, i) => String(5000 + i * 3)).join(', ');
  await send(page, `Compare ${many} for me`);
  await expect(page.locator('.h-askx-stream .fx-checking').first()).toBeVisible();
  await page.locator('.h-askx-live').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: info.outputPath('ask-stream-390-live.png') });
  await expect(page.locator('.h-askx-msgs .h-msg.fathom')).toHaveCount(2);
});
