import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { createLocalData, localPort, removeLocalData, refuseSuppliedTarget } from './local-store.mjs';

// Add a passkey on another device: a signed-in owner asks Account for an emailed link, opens it
// in a second browser with its own authenticator, and ends with two passkeys and two live
// sessions. Chromium's WebAuthn through CDP virtual authenticators and the actual server
// verifier; helpers are copied from e2e/identity.spec.mjs, trimmed to what this flow needs.
// CDP protocol: https://chromedevtools.github.io/devtools-protocol/tot/WebAuthn/

const REPO = fileURLToPath(new URL('..', import.meta.url));
const REMOTE = !!(process.env.BASE_URL || process.env.FATHOM_SMOKE_BASE_URL);
const OWNER = 'owner@example.test';
const LINK_SUBJECT = 'Add a Fathom passkey on another device';
const LINK_BUTTON = 'Email me a link to add a passkey on another device';
let dataDir;
let base;
let env;
let server;
let serverOutput = '';
const contexts = new Set();
const issuedTokens = new Set();
test.use({ storageState: { cookies: [], origins: [] }, extraHTTPHeaders: {}, trace: 'off', screenshot: 'off', video: 'off' });

test.describe('adding a passkey on another device', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });
  test.skip(REMOTE, 'creates an isolated local server; never runs against a supplied target');

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    refuseSuppliedTarget();
    dataDir = createLocalData('add-passkey');
    const port = await localPort();
    base = `http://localhost:${port}`;
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FATHOM_')));
    const keyFile = join(dataDir, 'data.key');
    writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
    env = {
      ...inherited, FATHOM_DATA: dataDir, FATHOM_DEMO: '0', FATHOM_ENGINE: 'off',
      FATHOM_HOST: 'localhost', FATHOM_PORT: String(port), FATHOM_PUBLIC_URL: base,
      FATHOM_DATA_KEY_FILE: keyFile, FATHOM_CLOCK: '2026-11-05',
      FATHOM_EMAIL_TRANSPORT: 'dev', FATHOM_EMAIL_FROM: 'fathom@example.test', FATHOM_EMAIL_TO: OWNER,
    };
    serverOutput = '';
    server = spawn(process.execPath, ['src/server.mjs'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
    server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
    await expect.poll(async () => {
      if (server.exitCode !== null || server.signalCode !== null) throw new Error('Local auth server exited before readiness');
      try { return (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).status; }
      catch { return 0; }
    }, { timeout: 30_000, message: 'local auth server health' }).toBe(200);
  });

  test.afterEach(async () => {
    for (const context of contexts) await context.close();
    contexts.clear();
  });

  test.afterAll(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const gone = new Promise((done) => server.once('exit', done));
      server.kill('SIGTERM');
      const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
      await gone;
      clearTimeout(timer);
    }
    removeLocalData(dataDir);
    expect(issuedTokens.size, 'the flow issued link tokens').toBeGreaterThan(1);
    expect([...issuedTokens].some((token) => serverOutput.includes(token)), 'link tokens must never reach server logs').toBe(false);
  });

  test('an emailed link adds a passkey in a second browser while the first stays signed in', async ({ browser }) => {
    test.setTimeout(180_000);
    const first = await browserClient(browser, { authenticator: true });
    let ownerIdentity;
    let primaryId;
    let firstCredentials;
    let secondCredentials;
    let firstSession;
    let addLink;

    await test.step('the owner is bootstrapped through the CLI and enrolls a passkey', async () => {
      const before = outboxNames();
      const link = await bootstrapInvite();
      const mailed = await mailedLink(before, OWNER);
      expect(mailed === link, 'operator and email enrollment links must match').toBe(true);
      await visitEnrollment(first, link);
      const registration = await register(first, 'Primary device');
      ownerIdentity = registration.identity;
      primaryId = registration.credentialId;
      // householdId is the opaque platform household id (MT-01 contradiction 8), no longer the integer 1.
      expect(ownerIdentity).toMatchObject({ email: OWNER, role: 'admin', householdId: expect.any(String), operator: false });
      expect(ownerIdentity.householdId.length).toBeGreaterThan(0);
      expect(ownerIdentity.memberships).toEqual([{ householdId: ownerIdentity.householdId, role: 'admin' }]);
      firstCredentials = await first.auth.credentials();
      expect(firstCredentials.length).toBe(1);
      firstSession = await sessionCookie(first);
    });

    await test.step('Account emails an add-a-device link to the owner only', async () => {
      await first.page.goto(`${base}/account`);
      const button = first.page.getByRole('button', { name: LINK_BUTTON, exact: true });
      await expect(button).toBeVisible();
      const before = outboxNames();
      const requested = first.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/passkeys/link');
      await button.click();
      const response = await requested;
      expect(response.request().method()).toBe('POST');
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ sent: true });
      expect((await response.text()).includes('/enroll#'), 'the HTTP response never carries the link').toBe(false);
      await expect(first.page.getByRole('status').filter({ hasText: 'A link is on its way to' })).toContainText(OWNER);
      addLink = await mailedLink(before, OWNER, LINK_SUBJECT);
      const linkMails = addedMessages(before).filter((message) => message.subject === LINK_SUBJECT);
      expect(linkMails).toHaveLength(1);
      expect(linkMails[0].to).toEqual([OWNER]);
      expect(linkMails[0].cc).toBeUndefined();
      expect(linkMails[0].bcc).toBeUndefined();
      expect(await sessionCookie(first)).toBe(firstSession);
    });

    await test.step('a new browser with its own authenticator redeems the link and lands signed in', async () => {
      const second = await browserClient(browser, { authenticator: true });
      expect((await second.context.request.get('/api/scenario')).status()).toBe(401);
      await visitEnrollment(second, addLink);
      const before = outboxNames();
      const registration = await register(second, 'Other device');
      expect(registration.identity.id).toBe(ownerIdentity.id);
      expect(registration.options.excludeCredentials.some((item) => item.id === primaryId)).toBe(true);
      expect((await second.context.request.get('/api/scenario')).status()).toBe(200);
      secondCredentials = await second.auth.credentials();
      expect(secondCredentials.length).toBe(1);
      expect(secondCredentials[0].credentialId).not.toBe(firstCredentials[0].credentialId);
      await expect.poll(() => addedMessages(before).filter((message) => message.subject === 'Fathom passkey added').length,
        { message: 'the passkey added notice was sent' }).toBe(1);
      const notice = addedMessages(before).find((message) => message.subject === 'Fathom passkey added');
      expect(notice.to).toEqual([OWNER]);
      expect(`${notice.text}\n${notice.html}`).not.toMatch(/https?:\/\/|href\s*=|\/enroll/);

      expect((await sessionIdentity(first)).id, 'the first browser is still signed in').toBe(ownerIdentity.id);
      expect(await sessionCookie(first)).toBe(firstSession);
      expect((await first.context.request.get('/api/scenario')).status()).toBe(200);
      await assertPasskeyNames(first, ['Primary device', 'Other device']);
      await assertPasskeyNames(second, ['Primary device', 'Other device']);
      await usedLinkIsDenied(browser, addLink);
    });

    await test.step('each authenticator signs in on its own from a fresh browser', async () => {
      for (const credentials of [firstCredentials, secondCredentials]) {
        const client = await browserClient(browser, { authenticator: true, credentials });
        await signin(client);
        expect((await sessionIdentity(client)).id).toBe(ownerIdentity.id);
        expect((await client.context.request.get('/api/scenario')).status()).toBe(200);
      }
      expect((await sessionIdentity(first)).id, 'other sign-ins leave the first browser signed in').toBe(ownerIdentity.id);
    });
  });
});

async function browserClient(browser, { authenticator = false, credentials = [] } = {}) {
  const context = await browser.newContext({ baseURL: base, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: {} });
  contexts.add(context);
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, body: '' }));
  const page = await context.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  const observations = [];
  await page.exposeBinding('__authObservation', (_source, observation) => observations.push(observation));
  await page.addInitScript(() => {
    const probe = { checks: 0, available: null, conditional: 0, aborted: 0, explicit: 0 };
    window.authProbe = probe;
    if (typeof PublicKeyCredential?.isConditionalMediationAvailable === 'function') {
      const available = PublicKeyCredential.isConditionalMediationAvailable.bind(PublicKeyCredential);
      PublicKeyCredential.isConditionalMediationAvailable = async () => {
        probe.checks += 1;
        probe.available = await available();
        return probe.available;
      };
    }
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = (options) => {
      if (options?.publicKey) {
        if (options.mediation === 'conditional') {
          probe.conditional += 1;
          options.signal?.addEventListener('abort', () => {
            probe.aborted += 1;
            window.__authObservation({ kind: 'abort' });
          }, { once: true });
        } else {
          probe.explicit += 1;
          window.__authObservation({ kind: 'explicit' });
        }
      }
      return get(options);
    };
  });
  const auth = authenticator ? await virtualAuthenticator(context, page, credentials) : null;
  return { context, page, auth, observations };
}

async function virtualAuthenticator(context, page, credentials) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    },
  });
  for (const credential of credentials) await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
  return {
    async presence(enabled) { await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled }); },
    async credentials() { return (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials; },
  };
}

async function register(client, name, button = 'Create passkey') {
  await client.page.getByRole('textbox', { name: 'Passkey name', exact: true }).fill(name);
  const optionsResponse = client.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/register/options')
    .then(async (response) => ({ response, body: await response.json() }));
  const verification = client.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/register/verify');
  await client.page.getByRole('button', { name: button, exact: true }).click();
  const { response: optionsResult, body: { options } } = await optionsResponse;
  expect(optionsResult.status()).toBe(200);
  const verified = await verification;
  expect(verified.status()).toBe(200);
  const submitted = verified.request().postDataJSON();
  expect(submitted.response.clientExtensionResults.credProps.rk).toBe(true);
  expect(submitted.name).toBe(name);
  await sessionCookie(client);
  const identity = await sessionIdentity(client);
  await expect(client.page).toHaveURL((url) => url.pathname === '/' && url.hash.startsWith('#/'));
  return { options, identity, credentialId: submitted.response.id };
}

async function signin(client) {
  client.observations.length = 0;
  await client.auth.presence(false);
  await client.page.goto(`${base}/signin`);
  await expect(client.page.getByRole('button', { name: 'Sign in with a passkey', exact: true })).toBeVisible();
  await expect.poll(() => client.page.evaluate(() => typeof window.authProbe.available), { message: 'conditional mediation capability resolved' }).toBe('boolean');
  const probe = await client.page.evaluate(() => window.authProbe);
  if (probe.available) {
    await expect.poll(() => client.page.evaluate(() => window.authProbe.conditional), { message: 'available conditional ceremony was set up' }).toBeGreaterThan(0);
  }
  await client.page.route('**/api/auth/signin/options', async (route) => {
    await client.auth.presence(true);
    await route.continue();
  }, { times: 1 });
  const verification = client.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/signin/verify');
  await client.page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click({ noWaitAfter: true });
  await expect.poll(() => client.observations.some((item) => item.kind === 'explicit'), { message: 'button invoked real explicit WebAuthn' }).toBe(true);
  const response = await verification;
  expect(response.status()).toBe(200);
  await expect(client.page).toHaveURL((url) => url.pathname === '/' && url.hash.startsWith('#/'));
  expect((await sessionIdentity(client)).email).toBe(OWNER);
}

async function sessionIdentity(client) {
  const response = await client.context.request.get('/api/auth/session');
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.demo).toBe(false);
  return body.identity;
}

async function sessionCookie(client) {
  const cookies = await client.context.cookies(base);
  const session = cookies.find((item) => item.name === '__Host-fathom-session');
  expect(Boolean(session), 'the browser holds a session').toBe(true);
  return session.value;
}

async function assertPasskeyNames(client, names) {
  const response = await client.context.request.get('/api/auth/passkeys');
  expect(response.status()).toBe(200);
  expect((await response.json()).passkeys.map((item) => item.name).sort()).toEqual([...names].sort());
  await client.page.goto(`${base}/account`);
  await expect(client.page.getByRole('button', { name: 'Revoke passkey', exact: true })).toHaveCount(names.length);
  for (const name of names) await expect(passkeyRow(client.page, name)).toBeVisible();
}

function passkeyRow(page, name) {
  return page.getByRole('row').or(page.getByRole('listitem')).filter({ hasText: name });
}

function outboxNames() {
  try { return new Set(readdirSync(join(dataDir, 'outbox')).filter((name) => name.endsWith('.json'))); }
  catch (err) { if (err.code === 'ENOENT') return new Set(); throw new Error('Synthetic outbox could not be read'); }
}

function addedMessages(before) {
  return [...outboxNames()].filter((name) => !before.has(name))
    .map((name) => JSON.parse(readFileSync(join(dataDir, 'outbox', name), 'utf8')));
}

function extractLink(text) {
  const matches = String(text).match(/https?:\/\/[^\s<>"']+/g) || [];
  const links = [...new Set(matches.filter((value) => {
    try {
      const url = new URL(value);
      return url.origin === base && url.pathname === '/enroll' && !url.search && /^#[A-Za-z0-9_-]{43}$/.test(url.hash);
    } catch { return false; }
  }))];
  if (links.length !== 1) throw new Error('Expected one local fragment-only enrollment link');
  issuedTokens.add(new URL(links[0]).hash.slice(1));
  return links[0];
}

async function mailedLink(before, email, subject) {
  let message;
  await expect.poll(() => {
    message = addedMessages(before).find((item) => Array.isArray(item.to) && item.to.length === 1 && item.to[0] === email
      && (subject === undefined || item.subject === subject)
      && /\/enroll#[A-Za-z0-9_-]{43}/.test(`${item.text} ${item.html}`));
    return Boolean(message);
  }, { timeout: 10_000, message: 'synthetic recipient received its auth email' }).toBe(true);
  return extractLink(`${message.text} ${message.html}`);
}

async function bootstrapInvite() {
  refuseSuppliedTarget();
  const child = spawn('npm', ['run', 'user:invite', '--', OWNER, '--admin'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', () => {});
  const code = await new Promise((done, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Packaged bootstrap CLI exceeded its local timeout'));
    }, 20_000);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Packaged bootstrap CLI could not start'));
    });
    child.once('exit', (exitCode) => { clearTimeout(timer); done(exitCode); });
  });
  expect(code, 'packaged bootstrap CLI exit code').toBe(0);
  return extractLink(stdout);
}

async function visitEnrollment(client, link) {
  try { await client.page.goto(link); }
  catch { throw new Error('Local enrollment page failed to load'); }
  await expect.poll(() => client.page.evaluate(() => location.hash === ''), { message: 'link fragment removed from history' }).toBe(true);
  await expect(client.page.getByRole('button', { name: 'Create passkey', exact: true })).toBeVisible();
}

async function usedLinkIsDenied(browser, link) {
  const replay = await browserClient(browser, { authenticator: true });
  await visitEnrollment(replay, link);
  await replay.page.getByRole('textbox', { name: 'Passkey name', exact: true }).fill('Replayed device');
  const denied = replay.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/register/options');
  await replay.page.getByRole('button', { name: 'Create passkey', exact: true }).click();
  expect((await denied).status()).toBe(410);
  await expect(replay.page.locator('body')).toContainText(/expired|used|no longer valid/i);
  expect((await replay.context.request.get('/api/scenario')).status()).toBe(401);
}
