// SimpleFIN Bridge connections on the demo build. A demo store talks to the synthetic fake bridge
// (src/ingest/simplefin.mjs createFakeSimplefin): its demo token claims, any other token is a used
// or unknown token, and the bridge serves four made up accounts. Nothing reaches the network.
//
// Selectors this spec relies on:
//   section "Connect accounts" on #/accounts with the form [data-sf-form] (textarea[data-sf-token],
//   button "Use the demo token", button "Connect"), then [data-sf-connected] with "Connected to
//   SimpleFIN, N accounts, last sync <time>", buttons "Sync now" and "Disconnect".

import { test as plainTest } from '@playwright/test';
import { test, expect, resetDemo, gotoRoute, REMOTE } from './helpers.mjs';

test.skip(REMOTE, 'writes to the demo store');

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

async function connectDemo(page) {
  await page.getByRole('button', { name: 'Use the demo token' }).click();
  await expect(page.locator('textarea[data-sf-token]')).not.toHaveValue('');
  const done = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/simplefin/connect');
  await page.locator('form[data-sf-form]').getByRole('button', { name: 'Connect' }).click();
  expect((await done).status()).toBe(200);
}

test('connect, sync result, Sync now and Disconnect on the Accounts screen', async ({ page, request }) => {
  await gotoRoute(page, 'accounts');
  await expect(page.locator('form[data-sf-form]')).toBeVisible();
  await connectDemo(page);
  const box = page.locator('[data-sf-connected]');
  await expect(box).toContainText(/Connected to SimpleFIN, 4 accounts, last sync \w{3} \d+, \d+:\d{2} (AM|PM)/);
  await expect(page.locator('textarea[data-sf-token]')).toHaveCount(0);
  // Synced accounts appear mirrored, with only the last four digits from the bridge's names.
  const checking = page.locator('.h-acc', { hasText: 'Everyday Checking x4821' });
  await expect(checking).toBeVisible();
  await expect(checking).toContainText('Mirrored');
  // The bridge's unmasked checking at the demo's other bank waits on a match question.
  await expect(box).toContainText('1 connected account needs an answer first');
  const scenario = await (await request.get('/api/scenario')).json();
  expect(JSON.stringify(scenario)).not.toContain('fake-demo-password');
  expect(scenario.live.ingest.items.some((i) => i.kind === 'account_match')).toBe(true);

  const synced = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/jobs/simplefin-sync/run');
  await box.getByRole('button', { name: 'Sync now' }).click();
  const run = await (await synced).json();
  expect(run.run.status).toBe('ok');
  expect(run.run.note).toMatchObject({ accounts: 4, transactions: 0, changed: false });
  await expect(box).toContainText('Connected to SimpleFIN, 4 accounts');

  await box.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.locator('form[data-sf-form]')).toBeVisible();
  await expect(page.locator('[data-sf-connected]')).toHaveCount(0);
  await expect(page.locator('.h-acc', { hasText: 'Everyday Checking x4821' })).toContainText('Manual');
});

// The plain fixture: the browser logs the refused connect request (400) as a console error, which
// the shared fixture treats as a failure.
plainTest('a used setup token shows a clear error and stays disconnected', async ({ page, request }) => {
  plainTest.skip(REMOTE, 'writes to the demo store');
  await resetDemo(request);
  await gotoRoute(page, 'accounts');
  const used = Buffer.from('https://bridge.simplefin.org/simplefin/claim/already-used').toString('base64');
  await page.locator('textarea[data-sf-token]').fill(used);
  await page.locator('form[data-sf-form]').getByRole('button', { name: 'Connect' }).click();
  await expect(page.locator('.fx-err')).toContainText('already used');
  await expect(page.locator('[data-sf-connected]')).toHaveCount(0);
});

// The demo store has finished onboarding; serve every scenario as fresh on Tell us (step 3), which
// holds the connections block.
async function forceAccountsStep(page) {
  await page.route('**/api/**', async (route) => {
    const res = await route.fetch();
    if (!String(res.headers()['content-type'] || '').includes('application/json')) return route.fulfill({ response: res });
    const body = await res.json();
    const sc = body && body.meta ? body : body && body.scenario;
    if (sc && sc.live) Object.assign(sc.live, { demo: 'fresh', onboardStep: 3 });
    return route.fulfill({ response: res, json: body });
  });
}

test('the onboarding Tell us step connects through SimpleFIN and lists imported accounts', async ({ page }) => {
  await forceAccountsStep(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Dump everything in' })).toBeVisible();
  await expect(page.locator('[data-sf-box]')).toBeVisible();
  await expect(page.locator('.h-insts button', { hasText: 'Connect' })).toHaveCount(0);
  await expect(page.getByText('Already in Fathom, not mirrored')).toBeVisible();
  await connectDemo(page);
  await expect(page.locator('[data-sf-connected]')).toContainText('Connected to SimpleFIN, 4 accounts');
  await expect(page.getByRole('button', { name: /^Continue/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('onboarding-accounts.png'), fullPage: true });
});

// Layout at phone width for both states; the connect interaction itself is covered above.
test('the connect block fits a phone screen @mobile', async ({ page, request }) => {
  await gotoRoute(page, 'accounts');
  const form = page.locator('form[data-sf-form]');
  await form.scrollIntoViewIfNeeded();
  await expect(form).toBeVisible();
  await form.screenshot({ path: test.info().outputPath('accounts-form-390.png') });
  const token = Buffer.from('https://bridge.simplefin.org/simplefin/claim/demo-fathom').toString('base64');
  const res = await request.post('/api/simplefin/connect', { headers: { 'content-type': 'application/json' }, data: { token } });
  expect(res.status()).toBe(200);
  await page.reload();
  await expect(page.locator('[data-sf-connected]')).toContainText('Connected to SimpleFIN, 4 accounts');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.locator('[data-sf-connected]').screenshot({ path: test.info().outputPath('accounts-connected-390.png') });
});
