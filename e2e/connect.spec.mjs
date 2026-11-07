// Connect screen: app-issued API keys for the MCP server. One-time key reveal, copy, client
// snippets, the key list, revoke, scope display and validation, all through the real UI, plus a
// raw POST /mcp to prove a key works while active and is refused after revoke.
// The demo store persists across tests, so every key name is unique and every key is revoked in
// afterEach. This spec never resets the demo.

import { test, expect, gotoRoute, expectH1 } from './helpers.mjs';

const KEY_RE = /^fathom_[A-Za-z0-9_-]{43}$/;
const NAME_PREFIX = 'e2e-connect-';
const JSON_HEADERS = { 'content-type': 'application/json' };

let counter = 0;
function uniqueName(tag) {
  counter += 1;
  return `${NAME_PREFIX}${tag}-${Date.now()}-${counter}`;
}

function mcpUrl(testInfo) {
  return `${testInfo.project.use.baseURL}/mcp`;
}

function initializeBody() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'e2e-connect', version: '0.0.0' }
    }
  };
}

function mcpHeaders(key) {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (key) h.authorization = `Bearer ${key}`;
  return h;
}

async function postInitialize(request, key) {
  return request.post('/mcp', { headers: mcpHeaders(key), data: initializeBody() });
}

const keyRows = (page) => page.getByTestId('key-row');
const rowFor = (page, name) => keyRows(page).filter({ hasText: name });

// Fill the form and press Create. Returns the revealed key once the panel shows it.
async function createKey(page, name, { write = false } = {}) {
  await page.locator('#key-name-input').fill(name);
  if (write) await page.getByTestId('key-scope-write:recs').click();
  await page.getByTestId('create-key').click();
  const el = page.getByTestId('new-key');
  await expect(el).toBeVisible();
  const key = ((await el.textContent()) || '').trim();
  expect(key).toMatch(KEY_RE);
  return key;
}

async function revokeInUi(page, name) {
  const row = rowFor(page, name);
  await row.getByTestId('revoke-key').click();
  await row.getByTestId('confirm-revoke').click();
  await expect(row.getByTestId('key-status')).toHaveText(/revoked/i);
}

test.describe('connect', () => {
  test.beforeEach(async ({ page }) => {
    await gotoRoute(page, 'connect');
    await expectH1(page, 'Bring your own AI');
    await expect(page.locator('#key-name-input')).toBeVisible();
  });

  // Revoke every key this spec created, through the API (idempotent, so UI-revoked keys are fine).
  test.afterEach(async ({ request }) => {
    const res = await request.get('/api/keys');
    if (res.status() !== 200) return;
    const { keys } = await res.json();
    for (const k of keys) {
      if (!String(k.name).startsWith(NAME_PREFIX) || k.revokedAt) continue;
      const r = await request.post(`/api/keys/${k.id}/revoke`, { headers: JSON_HEADERS, data: {} });
      expect(r.status(), `revoke ${k.id}`).toBe(200);
    }
  });

  test('heading, kicker, MCP URL, and no sample transcript', async ({ page }, testInfo) => {
    await expect(page.locator('.h-ph .h-kicker')).toHaveText('Connect');
    await expectH1(page, 'Bring your own AI');
    await expect(page.getByText(mcpUrl(testInfo), { exact: true })).toBeVisible();
    await expect(page.getByText('From a session')).toHaveCount(0);
  });

  test('create a read key: one-time reveal, copy, snippets, Done clears it everywhere', async ({ page, context }, testInfo) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const name = uniqueName('reveal');
    const url = mcpUrl(testInfo);

    // Before any key exists the snippets carry the placeholder.
    await expect(page.getByTestId('snippet-claude')).toContainText('<your-key>');
    await expect(page.getByTestId('snippet-json')).toContainText('<your-key>');

    const key = await createKey(page, name);
    await expect(page.getByText(/shown once|only once|one time/i).first()).toBeVisible();

    // Copy puts exactly the key on the clipboard.
    await page.getByTestId('copy-new-key').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(key);

    // Snippets carry the real key while it is revealed.
    const claude = page.getByTestId('snippet-claude');
    const claudeText = ((await claude.textContent()) || '').replace(/\s+/g, ' ').trim();
    expect(claudeText).toContain(`claude mcp add --transport http fathom ${url} --header "Authorization: Bearer ${key}"`);
    expect(claudeText).not.toContain('<your-key>');
    const cfg = JSON.parse((await page.getByTestId('snippet-json').textContent()) || '');
    expect(cfg).toEqual({
      mcpServers: { fathom: { type: 'http', url, headers: { Authorization: `Bearer ${key}` } } }
    });

    // The key is never written to browser storage, even while shown.
    const storedWhileShown = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
    expect(storedWhileShown).not.toContain(key);
    expect(page.url()).not.toContain(key);

    // The list row exists and the key is not in it.
    await expect(rowFor(page, name)).toHaveCount(1);
    expect(((await rowFor(page, name).textContent()) || '')).not.toContain(key);

    // Done discards the key from the DOM entirely and snippets fall back to the placeholder.
    await page.getByTestId('key-done').click();
    await expect(page.getByTestId('new-key')).toHaveCount(0);
    expect(await page.content()).not.toContain(key);
    await expect(page.getByTestId('snippet-claude')).toContainText('<your-key>');
    await expect(page.getByTestId('snippet-json')).toContainText('<your-key>');
    expect((await page.getByTestId('snippet-claude').textContent()) || '').not.toContain(key);
    expect((await page.getByTestId('snippet-json').textContent()) || '').not.toContain(key);
    await expect(rowFor(page, name)).toHaveCount(1);

    // A reload shows the row but never the key, and nothing is in storage or the URL.
    await page.reload();
    await expectH1(page, 'Bring your own AI');
    await expect(rowFor(page, name)).toHaveCount(1);
    await expect(page.getByTestId('new-key')).toHaveCount(0);
    expect(await page.content()).not.toContain(key);
    const storedAfter = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
    expect(storedAfter).not.toContain(key);
    expect(page.url()).not.toContain(key);
  });

  test('key list shows name, scope, created, last used never, and status', async ({ page }) => {
    const readName = uniqueName('list-read');
    const writeName = uniqueName('list-write');
    await createKey(page, readName);
    await page.getByTestId('key-done').click();
    await createKey(page, writeName, { write: true });
    await page.getByTestId('key-done').click();

    const readRow = rowFor(page, readName);
    await expect(readRow).toHaveCount(1);
    await expect(readRow.getByTestId('key-name')).toHaveText(readName);
    await expect(readRow).toContainText('Read only');
    await expect(readRow).not.toContainText('Read + Change recommendation status and owner');
    await expect(readRow).toContainText(/never/i);
    await expect(readRow.getByTestId('key-status')).toHaveText(/active/i);

    // Created renders as some date or time text beyond the fields above.
    const rest = ((await readRow.textContent()) || '')
      .replace(readName, '')
      .replace(/Read only|never|active|Revoke/gi, '');
    expect(rest).toMatch(/\d|today|just now|ago/i);

    // The write key reads "Read + Change recommendation status and owner", also with last used "never" and active.
    const writeRow = rowFor(page, writeName);
    await expect(writeRow).toHaveCount(1);
    await expect(writeRow).toContainText('Read + Change recommendation status and owner');
    await expect(writeRow).toContainText(/never/i);
    await expect(writeRow.getByTestId('key-status')).toHaveText(/active/i);
  });

  test('POST /mcp is 200 with an active key, 401 after revoke, 401 with no key', async ({ page, request }) => {
    const name = uniqueName('revoke');
    const key = await createKey(page, name);
    await page.getByTestId('key-done').click();

    // Liveness: an active key is not refused and gets a real initialize result.
    const live = await postInitialize(request, key);
    expect(live.status()).toBe(200);
    const body = await live.json();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.result?.protocolVersion).toBeTruthy();

    // No key at all is refused.
    const anon = await postInitialize(request, null);
    expect(anon.status()).toBe(401);

    // Revoke needs the inline confirm step: the first click alone does not revoke.
    const row = rowFor(page, name);
    await row.getByTestId('revoke-key').click();
    await expect(row.getByTestId('key-status')).toHaveText(/active/i);
    expect((await postInitialize(request, key)).status()).toBe(200);
    await row.getByTestId('confirm-revoke').click();
    await expect(row.getByTestId('key-status')).toHaveText(/revoked/i);
    await expect(row.getByTestId('revoke-key')).toHaveCount(0);

    const dead = await postInitialize(request, key);
    expect(dead.status()).toBe(401);
  });

  test('revoke through the UI flips the row to revoked and sticks after reload', async ({ page }) => {
    const name = uniqueName('flip');
    await createKey(page, name);
    await page.getByTestId('key-done').click();
    await revokeInUi(page, name);
    await page.reload();
    await expectH1(page, 'Bring your own AI');
    await expect(rowFor(page, name).getByTestId('key-status')).toHaveText(/revoked/i);
  });

  test('write scope: write key is listed as read and write, tool list marks scopes', async ({ page, request }) => {
    const name = uniqueName('write');
    const key = await createKey(page, name, { write: true });
    await page.getByTestId('key-done').click();

    const row = rowFor(page, name);
    await expect(row).toContainText('Read + Change recommendation status and owner');
    await expect(row.getByTestId('key-status')).toHaveText(/active/i);

    // The server agrees on the stored scopes.
    const res = await request.get('/api/keys');
    const { keys } = await res.json();
    const rec = keys.find((k) => k.name === name);
    expect(rec?.scopes).toEqual(['read', 'write:recs']);
    expect(JSON.stringify(keys)).not.toContain(key);

    // Tool list: the write tool carries a write marker, read tools carry a read marker.
    const tools = page.getByTestId('tool-row');
    const writeTool = tools.filter({ has: page.locator('code', { hasText: /^act_on_recommendation$/ }) });
    await expect(writeTool).toHaveCount(1);
    await expect(writeTool).toContainText(/\bwrite\b/i);
    for (const t of ['household', 'knowledge', 'knowledge', 'knowledge']) {
      // Match the tool by its name element: descriptions may mention other tools by name.
      const r = tools.filter({ has: page.locator('code', { hasText: new RegExp(`^${t}$`) }) });
      await expect(r, `${t} tool row`).toHaveCount(1);
      await expect(r).toContainText(/\bread\b/i);
      await expect(r).not.toContainText(/\bwrite\b/i);
    }
  });

  test('an empty name shows an inline error and creates no key', async ({ page, request }) => {
    const before = await keyRows(page).count();
    const listBefore = (await (await request.get('/api/keys')).json()).keys.length;

    await page.locator('#key-name-input').fill('');
    await page.getByTestId('create-key').click();

    const alert = page.getByRole('alert').first();
    await expect(alert).toBeVisible();
    expect(((await alert.textContent()) || '').trim().length).toBeGreaterThan(0);
    await expect(page.getByTestId('new-key')).toHaveCount(0);
    await expect(keyRows(page)).toHaveCount(before);
    const listAfter = (await (await request.get('/api/keys')).json()).keys.length;
    expect(listAfter).toBe(listBefore);
  });
});
