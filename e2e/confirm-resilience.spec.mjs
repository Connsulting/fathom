// Confirm deck resilience on the demo build: a 409 stale answer shows a short line, refetches and
// moves on; a lost answer reply is retried once only when the item is still pending, and never
// posted twice when the first attempt landed. Failures are forced with request routing; the
// server and store are real. The shared page fixture fails on any console error, and the browser
// logs each forced failure, so this spec uses the base test with its own check: the only console
// errors allowed are failed loads of the answer path itself.

import { test as base } from '@playwright/test';
import { expect, resetDemo, gotoRoute, deckCurrentId } from './helpers.mjs';

const test = base.extend({
  page: async ({ page }, use) => {
    const problems = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const url = (msg.location() && msg.location().url) || '';
      const path = url ? new URL(url).pathname : '';
      if (/Failed to load resource/.test(msg.text()) && /^\/api\/confirm\/\d+\/answer$/.test(path)) return;
      problems.push(`console error: ${msg.text()}${url ? ` (${url})` : ''}`);
    });
    page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
    await use(page);
    expect(problems, 'console errors other than the forced answer failures').toEqual([]);
  },
});

const STALE_LINE = 'This one changed while you were answering; refreshed.';
const answerPath = (id) => `/api/confirm/${id}/answer`;
const isAnswer = (req, id) => req.method() === 'POST' && new URL(req.url()).pathname === answerPath(id);

async function pending(request) {
  const res = await request.get('/api/confirm');
  expect(res.status()).toBe(200);
  return [...(await res.json()).items].sort((a, b) => a.id - b.id);
}

async function item(request, id) {
  const res = await request.get(`/api/confirm/${id}`);
  expect(res.status()).toBe(200);
  return (await res.json()).item;
}

async function openDeck(page, request) {
  const items = await pending(request);
  expect(items.length).toBeGreaterThanOrEqual(2);
  await gotoRoute(page, 'confirm');
  await expect(page.locator('.h-deck')).toBeVisible();
  const id = await deckCurrentId(page);
  return { items, id, it: items.find((i) => i.id === id) };
}

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

test('a stale answer shows a short line, refetches the scenario and moves to the next card', async ({ page, request }) => {
  const { id, it } = await openDeck(page, request);
  await page.route(`**${answerPath(id)}`, (route) => route.fulfill({
    status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'the value changed since this question was asked', code: 'stale' }),
  }));
  const refetch = page.waitForRequest((r) => r.method() === 'GET' && new URL(r.url()).pathname === '/api/scenario');
  await page.locator(`button[data-answer="${id}"][data-option="${it.options[0].id}"]`).click();
  await refetch;
  await expect(page.locator('.h-deck-notice')).toHaveText(STALE_LINE);
  await expect(page.locator('.fx-err')).toHaveCount(0);
  await expect(page.locator(`article.h-deck-card.cur[data-item="${id}"]`)).toHaveCount(0);
  expect((await item(request, id)).status).toBe('pending');
});

test('a network error on an answer re-reads the item and retries once while it is still pending', async ({ page, request }) => {
  const { id, it } = await openDeck(page, request);
  let posts = 0;
  await page.route(`**${answerPath(id)}`, (route) => {
    posts += 1;
    return posts === 1 ? route.abort('connectionreset') : route.continue();
  });
  const reread = page.waitForRequest((r) => r.method() === 'GET' && new URL(r.url()).pathname === `/api/confirm/${id}`);
  await page.locator(`button[data-answer="${id}"][data-option="${it.options[0].id}"]`).click();
  await reread;
  await expect(page.locator(`article.h-deck-card.cur[data-item="${id}"]`)).toHaveCount(0);
  expect(posts).toBe(2);
  const now = await item(request, id);
  expect(now.status).toBe('answered');
  expect(now.answer).toBe(it.options[0].id);
  await expect(page.locator('.fx-err')).toHaveCount(0);
});

test('a 502 after the answer landed is never posted again', async ({ page, request }) => {
  const { id, it } = await openDeck(page, request);
  let posts = 0;
  await page.route(`**${answerPath(id)}`, async (route) => {
    posts += 1;
    await route.fetch();
    return route.fulfill({ status: 502, contentType: 'text/plain', body: 'bad gateway' });
  });
  const answered = [];
  page.on('request', (r) => { if (isAnswer(r, id)) answered.push(r); });
  await page.locator(`button[data-answer="${id}"][data-option="${it.options[0].id}"]`).click();
  await expect(page.locator(`article.h-deck-card.cur[data-item="${id}"]`)).toHaveCount(0);
  expect(posts).toBe(1);
  expect(answered).toHaveLength(1);
  const now = await item(request, id);
  expect(now.status).toBe('answered');
  expect(now.answer).toBe(it.options[0].id);
  await expect(page.locator('.fx-err')).toHaveCount(0);
});
