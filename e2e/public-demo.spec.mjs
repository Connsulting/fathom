import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { startServer } from '../src/server.mjs';

const port = Number(process.env.E2E_PORT || 5031);
const origin = `http://localhost:${port}`;
const data = resolve('.e2e-data-pubdemo');
let app;
test.use({ baseURL: origin });

test.beforeAll(async () => {
  rmSync(data, { recursive: true, force: true });
  app = await startServer(loadConfig({ FATHOM_PUBLIC_DEMO: '1', FATHOM_DEMO: '1',
    FATHOM_PUBLIC_URL: origin, FATHOM_PORT: String(port), FATHOM_PUBLIC_DEMO_DATA: data,
    FATHOM_DATA: data, FATHOM_ENGINE: 'fake', FATHOM_FAKE_STREAM_MS: '0' }));
});
test.afterAll(async () => { await app?.close(); rmSync(data, { recursive: true, force: true }); });

test('@mobile public demo visitor flow and two-context isolation', async ({ page, browser }) => {
  await page.goto('/');
  await expect(page.locator('.h-demo-marker')).toHaveText('Demo with sample data');
  expect(page.url()).not.toContain('/signin');
  const bootstrap = await (await page.request.get('/api/scenario')).json();
  expect(bootstrap.live.publicDemo).toBe(true);
  const cookie = (await page.context().cookies()).find(c => c.name === 'fathom_public_demo');
  expect(cookie.httpOnly).toBe(true);
  const items = (await (await page.request.get('/api/confirm')).json()).items;
  await page.goto('/#/confirm');
  const card = page.locator('article.h-deck-card.cur');
  await expect(card).toHaveCount(1);
  const id = Number(await card.getAttribute('data-item'));
  const item = items.find(i => i.id === id);
  const posted = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(`/api/confirm/${id}/answer`));
  await card.locator(`button[data-answer="${id}"]`).first().click();
  expect((await posted).status()).toBe(200);
  expect((await (await page.request.get('/api/confirm')).json()).items.some(i => i.id === item.id)).toBe(false);

  await page.goto('/#/ask');
  const composer = page.locator('form.h-askx-compose textarea[name="q"]');
  await composer.fill('What should I focus on?');
  await composer.press('Enter');
  await expect(page).toHaveURL(/#\/ask\/[a-f0-9]{12}$/);
  await expect(page.locator('.h-thread .h-msg.fathom')).toHaveCount(1);
  await expect(page.locator('.h-demo-marker')).toBeVisible();
  const threadId = page.url().split('/').pop();

  const other = await browser.newContext({ baseURL: origin });
  try {
    const second = await other.newPage();
    await second.goto('/');
    await expect(second.locator('.h-demo-marker')).toBeVisible();
    const pending = (await (await other.request.get('/api/confirm')).json()).items;
    expect(pending.some(i => i.id === id)).toBe(true);
    const threads = await (await other.request.get('/api/threads')).json();
    expect(threads.active.some(t => t.id === threadId)).toBe(false);
    expect((await other.request.get(`/api/threads/${threadId}`)).status()).toBe(404);
  } finally { await other.close(); }
  for (const path of ['/api/simplefin/connect', '/api/files', '/api/email/test', '/mcp']) {
    const res = await page.request.post(path, { headers: { origin }, data: {} });
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toContain('disabled in public demo');
  }
  expect(await page.locator('body').evaluate(el => el.scrollWidth <= window.innerWidth)).toBe(true);
});
