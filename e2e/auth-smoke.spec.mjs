import { test, expect } from '@playwright/test';
import { installWriteGuard } from './helpers.mjs';
test.use({ storageState: { cookies: [], origins: [] }, extraHTTPHeaders: {}, trace: 'off', screenshot: 'off' });

test.describe('signed-out real server', { tag: '@auth-smoke' }, () => {
  test.skip(process.env.FATHOM_SMOKE_TARGET !== 'real', 'requires an explicitly supplied real server');

  test('health and sign-in are public; household pages and APIs refuse anonymous and forged headers', async ({ browser, baseURL }) => {
    expect(Boolean(process.env.FATHOM_SMOKE_BASE_URL || process.env.BASE_URL), 'smoke target must be supplied').toBe(true);
    const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: {} });
    const blocked = [];
    try {
      await installWriteGuard(context, baseURL, blocked);
      const health = await context.request.get('/healthz');
      expect(health.status()).toBe(200);
      expect((await health.json()).ok).toBe(true);
      const head = await context.request.head('/healthz');
      expect(head.status()).toBe(200);
      const session = await context.request.get('/api/auth/session');
      expect(session.status()).toBe(200);
      expect(await session.json()).toEqual({ identity: null, demo: false });
      expect(session.headers()['cache-control']).toContain('no-store');

      const page = await context.newPage();
      const householdRequests = [];
      page.on('request', (req) => {
        if (new URL(req.url()).pathname === '/api/scenario') householdRequests.push(req.method());
      });
      await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, body: '' }));
      const signin = await page.goto('/signin');
      expect(signin.status()).toBe(200);
      await expect(page.getByRole('button', { name: 'Sign in with a passkey', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Email recovery link', exact: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Email', exact: true })).toBeVisible();
      expect(householdRequests).toEqual([]);

      for (const headers of [{}, { 'Tailscale-User-Login': 'owner@example.test', 'Tailscale-User-Name': 'Synthetic Administrator' }]) {
        for (const path of ['/api/scenario', '/api/identity']) {
          const response = await context.request.get(path, { headers });
          expect(response.status(), `signed-out GET ${path}`).toBe(401);
        }
        for (const path of ['/', '/account', '/admin/users']) {
          const response = await context.request.get(path, { headers, maxRedirects: 0 });
          expect(response.status(), `signed-out GET ${path}`).toBe(303);
          expect(response.headers().location).toBe(path === '/' ? '/signin' : `/signin?next=${encodeURIComponent(path)}`);
        }
      }
      const denied = await page.goto('/');
      expect(denied.status()).toBe(200);
      await expect(page).toHaveURL(/\/signin$/);
      await expect(page.getByRole('button', { name: 'Sign in with a passkey', exact: true })).toBeVisible();
      expect(householdRequests).toEqual([]);
      // Passive conditional mediation may ask for options; the guard blocks it before sending.
      expect(blocked.filter((entry) => entry !== 'POST /api/auth/signin/options'), 'unexpected smoke write attempt').toEqual([]);
      expect((await context.request.get('/healthz')).status()).toBe(200);
    } finally {
      await context.close();
    }
  });
});
