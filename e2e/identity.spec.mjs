import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { openDb } from '../src/store/db.mjs';
import { digest } from '../src/auth/store.mjs';
import { ask, OWNER_OPTIONS } from '../src/ingest/confirm.mjs';
import { createLocalData, localPort, removeLocalData, refuseSuppliedTarget } from './local-store.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const REMOTE = !!(process.env.BASE_URL || process.env.FATHOM_SMOKE_BASE_URL);
const OWNER = 'owner@example.test';
const MEMBER = 'member@example.test';
const SECOND_ADMIN = 'second-admin@example.test';
let dataDir;
let base;
let env;
let server;
let serverOutput = '';
let confirmationId;
const contexts = new Set();
const issuedTokens = new Set();
const privateMaterial = new Set();
test.use({ storageState: { cookies: [], origins: [] }, extraHTTPHeaders: {}, trace: 'off', screenshot: 'off', video: 'off' });

// These tests use Chromium's actual WebAuthn implementation and the actual server verifier.
// CDP protocol: https://chromedevtools.github.io/devtools-protocol/tot/WebAuthn/
test.describe('passkey accounts through the browser', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });
  test.skip(REMOTE, 'creates an isolated local server; never runs against a supplied target');

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    refuseSuppliedTarget();
    dataDir = createLocalData('passkey-auth');
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
    expect([...issuedTokens].some((token) => serverOutput.includes(token)), 'auth tokens must never reach server logs').toBe(false);
  });

  test('anonymous access exposes only health and auth pages; forged headers cannot load the household', async ({ browser }) => {
    const client = await browserClient(browser);
    expect((await client.context.request.get('/healthz')).status()).toBe(200);
    expect((await client.context.request.head('/healthz')).status()).toBe(200);
    expect((await client.context.request.get('/auth/return-path.js')).status()).toBe(200);
    const session = await client.context.request.get('/api/auth/session');
    expect(await session.json()).toEqual({ identity: null, demo: false });
    expect(session.headers()['cache-control']).toContain('no-store');
    const signin = await client.page.goto(`${base}/signin`);
    expect(signin.status()).toBe(200);
    await expect(client.page.getByRole('button', { name: 'Sign in with a passkey', exact: true })).toBeVisible();
    await expect(client.page.getByRole('button', { name: 'Email recovery link', exact: true })).toBeVisible();
    expect(client.scenarioRequests).toEqual([]);
    for (const headers of [{}, { 'Tailscale-User-Login': OWNER, 'Tailscale-User-Name': 'Synthetic Administrator' }]) {
      for (const path of ['/api/scenario', '/api/identity', '/api/files', '/api/keys']) {
        expect((await client.context.request.get(path, { headers })).status(), `unsigned GET ${path}`).toBe(401);
      }
      for (const path of ['/', '/account', '/admin/users', '/unknown']) {
        const redirected = await client.context.request.get(path, { headers, maxRedirects: 0 });
        expect(redirected.status(), `unsigned GET ${path}`).toBe(303);
        expect(redirected.headers().location).toBe(path === '/' ? '/signin' : `/signin?next=${encodeURIComponent(path)}`);
      }
    }
    const deep = await client.page.goto(`${base}/#/plan`);
    expect(deep.status()).toBe(200);
    await expect(client.page).toHaveURL(`${base}/signin#/plan`);
    await expect(client.page.getByRole('button', { name: 'Sign in with a passkey', exact: true })).toBeVisible();
    expect(client.scenarioRequests).toEqual([]);
    expect((await client.context.request.get('/healthz')).status()).toBe(200);
  });

  test('bootstrap, passkeys, household membership and recovery use real CDP ceremonies', async ({ browser }) => {
    test.setTimeout(240_000);
    const admin = await browserClient(browser, { authenticator: true });
    let ownerIdentity;
    let primaryCredentials;
    let secondaryCredentials;
    let primaryId;
    let otherOwner;
    let member;
    let memberKey;
    let adminKey;
    let enrollmentLink;
    let secondAdmin;

    await test.step('packaged bootstrap CLI emails the exact operator link and enrollment creates an admin session', async () => {
      const before = outboxNames();
      enrollmentLink = await bootstrapInvite();
      const mailed = await mailedLink(before, OWNER);
      expect(enrollmentLink === mailed, 'operator and email enrollment links must match').toBe(true);
      await visitEnrollment(admin, enrollmentLink);
      expect(admin.scenarioRequests).toEqual([]);
      await admin.page.route('**/api/auth/register/verify', async route => {
        const body = route.request().postDataJSON();
        expect(body.response.clientExtensionResults.credProps.rk).toBe(true);
        delete body.response.clientExtensionResults.credProps;
        await route.continue({ postData: JSON.stringify(body) });
      }, { times: 1 });
      await admin.page.getByRole('textbox', { name: 'Passkey name', exact: true }).fill('Unreported discoverability');
      const refusedVerification = admin.page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/register/verify');
      await admin.page.getByRole('button', { name: 'Create passkey', exact: true }).click();
      const refused = await refusedVerification;
      expect(refused.status()).toBe(400);
      expect(await refused.json()).toEqual({ error: 'a discoverable passkey is required' });
      await expect(admin.page.locator('body')).toContainText('Try another browser or passkey provider.');
      const db = openDb(join(dataDir, 'fathom.sqlite'));
      try {
        const user = db.prepare('SELECT id, enrolled_at FROM users WHERE email = ?').get(OWNER);
        expect(user.enrolled_at).toBe(null);
        expect(db.prepare('SELECT count(*) AS n FROM passkeys WHERE user_id = ?').get(user.id).n).toBe(0);
        expect(db.prepare('SELECT count(*) AS n FROM auth_challenges WHERE user_id = ?').get(user.id).n).toBe(0);
        expect(db.prepare('SELECT count(*) AS n FROM auth_tokens WHERE user_id = ?').get(user.id).n).toBe(1);
      } finally { db.close(); }
      expect((await admin.context.request.get('/api/scenario')).status()).toBe(401);
      await admin.auth.replace();
      const notice = securitySnapshot();
      const registration = await register(admin, 'Primary device');
      await securityNotices(notice, 'Fathom passkey added', [OWNER]);
      expect(registration.options.authenticatorSelection).toMatchObject({
        residentKey: 'required', requireResidentKey: true, userVerification: 'required',
      });
      expect(registration.options.extensions.credProps).toBe(true);
      expect(registration.options.attestation).toBe('none');
      ownerIdentity = registration.identity;
      expect(ownerIdentity).toMatchObject({ email: OWNER, login: OWNER, name: OWNER, householdId: 1, role: 'admin' });
      expect((await sessionIdentity(admin)).id).toBe(ownerIdentity.id);
      const cookies = await admin.context.cookies(base);
      const cookie = cookies.find((item) => item.name === '__Host-fathom-session');
      expect(Boolean(cookie)).toBe(true);
      expect({ secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, path: cookie.path }).toEqual({
        secure: true, httpOnly: true, sameSite: 'Lax', path: '/',
      });
      await expect(admin.page.getByRole('heading', { level: 1, name: 'What is the money for?', exact: true })).toBeVisible();
      await expect(admin.page.locator('.h-ob-steps')).not.toContainText('Sign in');
      await expect(admin.page.locator('body')).not.toContainText('Demo sign-in');
      primaryCredentials = await admin.auth.credentials();
      expect(primaryCredentials.length).toBe(1);
      primaryId = registration.credentialId;
      await assertPasskeyNames(admin, ['Primary device']);
      await usedLinkIsDenied(browser, enrollmentLink);
      expect((await admin.context.request.get('/api/scenario')).status()).toBe(200);
    });

    await test.step('authenticated boot precedes scenario fetch and the Settings page links to real auth pages', async () => {
      seedReturningHousehold();
      await admin.page.goto(`${base}/`);
      await expect(admin.page).toHaveURL(/#\/home$/);
      // Home's data-health line counts the open question and links to Confirm.
      await expect(admin.page.locator('div.h-dhealth')).toContainText('1 question to confirm');
      await admin.page.locator('div.h-dhealth a[data-go="confirm"]').click();
      await expect(admin.page).toHaveURL(/#\/confirm$/);
      const answered = admin.page.waitForResponse((response) => new URL(response.url()).pathname === `/api/confirm/${confirmationId}/answer`);
      await admin.page.locator(`[data-answer="${confirmationId}"][data-option="owner"]`).click();
      expect((await answered).status()).toBe(200);
      await admin.page.goto(`${base}/`);
      await expect(admin.page).toHaveURL(/#\/home$/);
      await expect(admin.page.locator('div.h-dhealth')).not.toContainText('to confirm');
      await expect(admin.page.locator('div.h-dhealth a[data-go="confirm"]')).toHaveCount(0);
      await admin.page.locator('header.h-top a.h-gear').click();
      await expect(admin.page).toHaveURL(/#\/settings$/);
      const settings = admin.page.locator('section.h-settings');
      await expect(settings.getByRole('link', { name: 'Account', exact: true })).toHaveAttribute('href', '/account');
      await expect(settings.getByRole('link', { name: 'Household', exact: true })).toHaveAttribute('href', '/admin/users');
      await expect(settings.getByRole('link', { name: 'Setup', exact: true })).toBeVisible();
      await expect(settings).toContainText(OWNER);
      await settings.getByRole('link', { name: 'Account', exact: true }).click();
      await expect(admin.page).toHaveURL(`${base}/account`);
      await expect(admin.page.getByRole('button', { name: 'Add passkey', exact: true })).toBeVisible();
      await assertAuthenticatedBoot(admin);
    });

    await test.step('adding a second device preserves both passkeys and the current session', async () => {
      await admin.auth.replace();
      const beforeSession = await sessionCookie(admin);
      const notice = securitySnapshot();
      const registration = await register(admin, 'Secondary device', 'Add passkey');
      await securityNotices(notice, 'Fathom passkey added', [OWNER]);
      expect(await sessionCookie(admin)).toBe(beforeSession);
      expect(registration.options.excludeCredentials.some((item) => item.id === primaryId)).toBe(true);
      expect(registration.identity.id).toBe(ownerIdentity.id);
      await assertPasskeyNames(admin, ['Primary device', 'Secondary device']);
      secondaryCredentials = await admin.auth.credentials();
      expect(secondaryCredentials.length).toBe(1);
      expect((await admin.context.request.get('/api/scenario')).status()).toBe(200);
      otherOwner = await browserClient(browser, { authenticator: true, credentials: primaryCredentials });
      await signin(otherOwner);
      primaryCredentials = await otherOwner.auth.credentials();
      expect((await sessionIdentity(otherOwner)).id).toBe(ownerIdentity.id);
    });

    await test.step('revoking one passkey signs out every session; the surviving passkey still signs in', async () => {
      const revoked = admin.page.waitForResponse((response) => response.request().method() === 'POST' && /\/api\/auth\/passkeys\/[^/]+\/revoke$/.test(new URL(response.url()).pathname));
      await passkeyRow(admin.page, 'Secondary device').getByRole('button', { name: 'Revoke passkey', exact: true }).click();
      expect((await revoked).status()).toBe(200);
      await expect(admin.page).toHaveURL(`${base}/signin`);
      expect((await admin.context.request.get('/api/scenario')).status()).toBe(401);
      expect((await otherOwner.context.request.get('/api/scenario')).status()).toBe(401);
      const removedDevice = await browserClient(browser, { authenticator: true, credentials: secondaryCredentials });
      await signin(removedDevice, 400);
      expect((await removedDevice.context.request.get('/api/scenario')).status()).toBe(401);
      await admin.auth.replace(primaryCredentials);
      await signin(admin);
      primaryCredentials = await admin.auth.credentials();
      await assertPasskeyNames(admin, ['Primary device']);
      expect((await admin.context.request.get('/api/scenario')).status()).toBe(200);
    });

    await test.step('the only enrolled admin cannot demote or remove itself', async () => {
      await admin.page.goto(`${base}/admin/users`);
      const row = userRow(admin.page, OWNER);
      const role = row.getByRole('combobox', { name: 'Role', exact: true });
      if (await role.isDisabled()) {
        expect((await post(admin, `/api/admin/users/${ownerIdentity.id}/role`, { role: 'member' })).status()).toBe(409);
      } else {
        const demotion = admin.page.waitForResponse((response) => new URL(response.url()).pathname === `/api/admin/users/${ownerIdentity.id}/role`);
        await role.selectOption('member');
        expect((await demotion).status()).toBe(409);
      }
      expect((await sessionIdentity(admin)).role).toBe('admin');
      await admin.page.reload();
      const remove = userRow(admin.page, OWNER).getByRole('button', { name: 'Remove user', exact: true });
      if (await remove.isDisabled()) {
        expect((await post(admin, `/api/admin/users/${ownerIdentity.id}/remove`, {})).status()).toBe(409);
      } else {
        const removal = admin.page.waitForResponse((response) => new URL(response.url()).pathname === `/api/admin/users/${ownerIdentity.id}/remove`);
        await remove.click();
        expect((await removal).status()).toBe(409);
      }
      expect((await admin.context.request.get('/api/admin/users')).status()).toBe(200);
      expect((await admin.context.request.get('/api/scenario')).status()).toBe(200);
    });

    await test.step('a second admin enrolls through an actual invitation after last-admin protection was proved', async () => {
      expect((await post(admin, '/api/admin/users/invite', { email: 'pending-admin@example.test', role: 'admin' })).status()).toBe(200);
      await admin.page.goto(`${base}/admin/users`);
      const before = outboxNames();
      const inviteForm = admin.page.locator('form').filter({ has: admin.page.getByRole('button', { name: 'Invite user', exact: true }) });
      await inviteForm.getByRole('textbox', { name: 'Email', exact: true }).fill(SECOND_ADMIN);
      await inviteForm.getByRole('combobox', { name: 'Role', exact: true }).selectOption('admin');
      const invited = admin.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/admin/users/invite');
      await admin.page.getByRole('button', { name: 'Invite user', exact: true }).click();
      expect((await invited).status()).toBe(200);
      const link = await mailedLink(before, SECOND_ADMIN);
      secondAdmin = await browserClient(browser, { authenticator: true });
      await visitEnrollment(secondAdmin, link);
      const notice = securitySnapshot();
      const registration = await register(secondAdmin, 'Second admin device');
      expect(registration.identity).toMatchObject({ email: SECOND_ADMIN, role: 'admin', householdId: 1 });
      expect(registration.identity.id).not.toBe(ownerIdentity.id);
      await securityNotices(notice, 'Fathom passkey added', [SECOND_ADMIN]);
      expect((await secondAdmin.context.request.get('/api/admin/users')).status()).toBe(200);
      await usedLinkIsDenied(browser, link);
    });

    await test.step('a security notice delivery failure preserves a completed real registration and its session', async () => {
      await secondAdmin.page.goto(`${base}/account`);
      await secondAdmin.auth.replace();
      const beforeSession = await sessionCookie(secondAdmin);
      const sendsBefore = emailSendCount();
      const outputStart = serverOutput.length;
      const outbox = join(dataDir, 'outbox');
      const saved = join(dataDir, 'saved-notice-outbox');
      renameSync(outbox, saved);
      try {
        writeFileSync(outbox, 'Synthetic transport obstruction', { mode: 0o600 });
        const registration = await register(secondAdmin, 'Second admin backup', 'Add passkey');
        expect(registration.identity.email).toBe(SECOND_ADMIN);
      } finally {
        rmSync(outbox, { force: true });
        renameSync(saved, outbox);
      }
      await expect.poll(() => serverOutput.slice(outputStart).includes('security_notice_failed'), {
        message: 'delivery failure produces the fixed security notice error',
      }).toBe(true);
      const failureLog = serverOutput.slice(outputStart);
      expect(failureLog.split('\n').filter(line => line.includes('security_notice_failed'))).toHaveLength(1);
      for (const value of [SECOND_ADMIN, dataDir, 'Synthetic transport obstruction', 'EEXIST', 'ENOTDIR', 'ENOENT']) {
        expect(failureLog.includes(value), 'notice failure logs contain no transport diagnostics or addresses').toBe(false);
      }
      expect(emailSendCount()).toBe(sendsBefore);
      expect(await sessionCookie(secondAdmin)).toBe(beforeSession);
      await assertPasskeyNames(secondAdmin, ['Second admin device', 'Second admin backup']);
      expect((await secondAdmin.context.request.get('/api/admin/users')).status()).toBe(200);
    });

    await test.step('a member enrolls from its emailed invite and cannot enter any admin surface', async () => {
      await admin.page.goto(`${base}/admin/users`);
      const before = outboxNames();
      const inviteForm = admin.page.locator('form').filter({ has: admin.page.getByRole('button', { name: 'Invite user', exact: true }) });
      await inviteForm.getByRole('textbox', { name: 'Email', exact: true }).fill(MEMBER);
      await inviteForm.getByRole('combobox', { name: 'Role', exact: true }).selectOption('member');
      const invited = admin.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/admin/users/invite');
      await admin.page.getByRole('button', { name: 'Invite user', exact: true }).click();
      const inviteResponse = await invited;
      expect(inviteResponse.status()).toBe(200);
      expect((await inviteResponse.text()).includes('/enroll#'), 'admin HTTP response must not disclose enrollment link').toBe(false);
      member = await browserClient(browser, { authenticator: true });
      const link = await mailedLink(before, MEMBER);
      await visitEnrollment(member, link);
      const notice = securitySnapshot();
      const registration = await register(member, 'Member device');
      await securityNotices(notice, 'Fathom passkey added', [MEMBER]);
      expect(registration.identity).toMatchObject({ email: MEMBER, role: 'member', householdId: 1 });
      await member.page.goto(`${base}/`);
      await expect(member.page).toHaveURL(/#\/home$/);
      await member.page.locator('header.h-top a.h-gear').click();
      await expect(member.page).toHaveURL(/#\/settings$/);
      await expect(member.page.locator('section.h-settings').getByRole('link', { name: 'Account', exact: true })).toBeVisible();
      await expect(member.page.locator('section.h-settings').getByRole('link', { name: 'Household', exact: true })).toHaveCount(0);
      const denied = await member.page.goto(`${base}/admin/users`);
      expect(denied.status()).toBe(403);
      expect((await member.context.request.get('/api/admin/users')).status()).toBe(403);
      for (const [path, data] of [
        ['/api/admin/users/invite', { email: 'uninvited@example.test', role: 'admin' }],
        [`/api/admin/users/${ownerIdentity.id}/role`, { role: 'member' }],
        [`/api/admin/users/${ownerIdentity.id}/remove`, {}],
        [`/api/admin/users/${ownerIdentity.id}/passkeys/${primaryId}/revoke`, {}],
      ]) {
        expect((await post(member, path, data)).status(), 'member admin mutation denial').toBe(403);
      }
      expect((await member.context.request.get('/api/scenario')).status()).toBe(200);
      expect((await admin.context.request.get('/api/admin/users')).status()).toBe(200);
      await usedLinkIsDenied(browser, link);
    });

    await test.step('removing a user immediately revokes its session and creator-owned MCP key', async () => {
      await member.page.goto(`${base}/#/connect`);
      await member.page.locator('#key-name-input').fill('Synthetic member key');
      const created = member.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/keys' && response.request().method() === 'POST');
      await member.page.getByTestId('create-key').click();
      expect((await created).status()).toBe(200);
      await expect(member.page.getByTestId('new-key')).toBeVisible();
      memberKey = (await member.page.getByTestId('new-key').textContent()).trim();
      privateMaterial.add(memberKey);
      expect(/^fathom_[A-Za-z0-9_-]{43}$/.test(memberKey)).toBe(true);
      const adminCreated = await post(admin, '/api/keys', { name: 'Synthetic surviving admin key', scopes: ['read'] });
      expect(adminCreated.status()).toBe(200);
      const adminKeyBody = await adminCreated.json();
      adminKey = adminKeyBody.key;
      privateMaterial.add(adminKey);
      const memberKeys = await member.context.request.get('/api/keys');
      expect(memberKeys.status()).toBe(200);
      expect((await memberKeys.json()).keys.some((key) => key.id === adminKeyBody.record.id)).toBe(false);
      expect((await mcp(memberKey)).status).toBe(200);
      expect((await mcp(adminKey)).status).toBe(200);
      expect((await post(member, `/api/keys/${adminKeyBody.record.id}/revoke`, {})).status()).toBe(403);
      expect((await member.context.request.get('/api/scenario')).status()).toBe(200);
      const memberIdentity = await sessionIdentity(member);
      await admin.page.goto(`${base}/admin/users`);
      const removed = admin.page.waitForResponse((response) => new URL(response.url()).pathname === `/api/admin/users/${memberIdentity.id}/remove`);
      await userRow(admin.page, MEMBER).getByRole('button', { name: 'Remove user', exact: true }).click();
      expect((await removed).status()).toBe(200);
      await expect(userRow(admin.page, MEMBER)).toHaveCount(0);
      expect((await member.context.request.get('/api/scenario')).status()).toBe(401);
      expect((await mcp(memberKey)).status).toBe(401);
      expect((await mcp(adminKey)).status).toBe(200);
      expect((await admin.context.request.get('/api/scenario')).status()).toBe(200);
    });

    await test.step('sign-out revokes its session and emailed recovery replaces lost keys only after verification', async () => {
      await otherOwner.auth.replace(primaryCredentials);
      await signin(otherOwner);
      primaryCredentials = await otherOwner.auth.credentials();
      await admin.page.goto(`${base}/account`);
      const signout = admin.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/signout');
      await admin.page.getByRole('button', { name: 'Sign out', exact: true }).click();
      expect((await signout).status()).toBe(200);
      await expect(admin.page).toHaveURL(`${base}/signin`);
      expect((await admin.context.request.get('/api/scenario')).status()).toBe(401);
      expect((await otherOwner.context.request.get('/api/scenario')).status()).toBe(200);
      const before = outboxNames();
      await admin.auth.replace();
      await admin.page.getByRole('textbox', { name: 'Email', exact: true }).fill(OWNER);
      const recovering = admin.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/recover');
      await admin.page.getByRole('button', { name: 'Email recovery link', exact: true }).click();
      const recoveryResponse = await recovering;
      expect(recoveryResponse.status()).toBe(200);
      expect((await recoveryResponse.text()).includes('/enroll#')).toBe(false);
      const recoveryLink = await mailedLink(before, OWNER);
      expect((await otherOwner.context.request.get('/api/scenario')).status()).toBe(200);
      await visitEnrollment(admin, recoveryLink);
      const notice = securitySnapshot();
      const registration = await register(admin, 'Recovered device');
      await securityNotices(notice, 'Fathom account recovered', [OWNER, SECOND_ADMIN]);
      expect(registration.identity.id).toBe(ownerIdentity.id);
      expect((await otherOwner.context.request.get('/api/scenario')).status()).toBe(401);
      expect((await secondAdmin.context.request.get('/api/admin/users')).status()).toBe(200);
      await assertPasskeyNames(admin, ['Recovered device']);
      const oldDevice = await browserClient(browser, { authenticator: true, credentials: primaryCredentials });
      await signin(oldDevice, 400);
      expect((await oldDevice.context.request.get('/api/scenario')).status()).toBe(401);
      const recoveredCredentials = await admin.auth.credentials();
      const returning = await browserClient(browser, { authenticator: true, credentials: recoveredCredentials });
      await signin(returning);
      expect((await sessionIdentity(returning)).id).toBe(ownerIdentity.id);
      await usedLinkIsDenied(browser, recoveryLink);
      expect((await returning.context.request.get('/api/scenario')).status()).toBe(200);
      await assertAuthenticatedBoot(admin);
      await assertAuthenticatedBoot(returning);
      otherOwner = returning;
    });

    await test.step('a signed-out deep link returns through sign-in, and an expired session keeps the route', async () => {
      const returning = await browserClient(browser, { authenticator: true, credentials: await otherOwner.auth.credentials() });
      await returning.page.goto(`${base}/#/plan`);
      await expect(returning.page).toHaveURL(`${base}/signin#/plan`);
      await signin(returning, 200, '#/plan');
      await expect(returning.page).toHaveURL(/#\/plan$/);
      const raw = (await returning.context.cookies(base)).find((item) => item.name === '__Host-fathom-session').value;
      const db = openDb(join(dataDir, 'fathom.sqlite'));
      try { db.prepare('DELETE FROM auth_sessions WHERE hash = ?').run(digest(raw)); }
      finally { db.close(); }
      await returning.page.evaluate(() => window.Fathom.api.goalCreate({ name: 'Synthetic' })).catch(() => {});
      await expect(returning.page).toHaveURL(/\/signin#\/plan$/);
      expect((await returning.context.request.get('/api/scenario')).status()).toBe(401);
    });

    await test.step('revoking the final passkey signs out every session and explains email recovery', async () => {
      await admin.page.goto(`${base}/account`);
      const revoked = admin.page.waitForResponse((response) => response.request().method() === 'POST' && /\/api\/auth\/passkeys\/[^/]+\/revoke$/.test(new URL(response.url()).pathname));
      await passkeyRow(admin.page, 'Recovered device').getByRole('button', { name: 'Revoke passkey', exact: true }).click();
      expect((await revoked).status()).toBe(200);
      await expect(admin.page).toHaveURL(`${base}/signin`);
      await expect(admin.page.locator('body')).toContainText(/recover|email/i);
      expect((await admin.context.request.get('/api/scenario')).status()).toBe(401);
      expect((await otherOwner.context.request.get('/api/scenario')).status()).toBe(401);
      await expect(admin.page.getByRole('button', { name: 'Email recovery link', exact: true })).toBeVisible();
      expect((await mcp(adminKey)).status).toBe(200);
      expect((await admin.context.request.get('/healthz')).status()).toBe(200);
    });
  });
});

async function browserClient(browser, { authenticator = false, credentials = [] } = {}) {
  const context = await browser.newContext({ baseURL: base, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: {} });
  contexts.add(context);
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, body: '' }));
  const page = await context.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  const scenarioRequests = [];
  const sessionResponses = [];
  const observations = [];
  await page.exposeBinding('__authObservation', (_source, observation) => observations.push(observation));
  let sequence = 0;
  let document = 0;
  const identityDocuments = new WeakMap();
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) document += 1;
    const path = new URL(request.url()).pathname;
    if (path === '/api/scenario') scenarioRequests.push({ sequence: ++sequence, document });
    if (['/api/auth/session', '/api/identity'].includes(path)) identityDocuments.set(request, document);
  });
  page.on('response', (response) => {
    if (['/api/auth/session', '/api/identity'].includes(new URL(response.url()).pathname)) {
      sessionResponses.push({ sequence: ++sequence, document: identityDocuments.get(response.request()), body: response.json().catch(() => null) });
    }
  });
  await page.addInitScript(() => {
    const probe = { checks: 0, available: null, conditional: 0, aborted: 0, explicit: 0 };
    window.authProbe = probe;
    if (typeof PublicKeyCredential?.isConditionalMediationAvailable === 'function') {
      const available = PublicKeyCredential.isConditionalMediationAvailable.bind(PublicKeyCredential);
      PublicKeyCredential.isConditionalMediationAvailable = async () => {
        probe.checks += 1;
        probe.available = await available();
        window.__authObservation({ kind: 'availability', available: probe.available });
        return probe.available;
      };
    }
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = (options) => {
      if (options?.publicKey) {
        if (options.mediation === 'conditional') {
          probe.conditional += 1;
          window.__authObservation({ kind: 'conditional' });
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
  return { context, page, auth, scenarioRequests, sessionResponses, observations };
}

async function virtualAuthenticator(context, page, credentials) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  let authenticatorId;
  async function replace(saved = []) {
    if (authenticatorId) await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    ({ authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
        hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
      },
    }));
    for (const credential of saved) await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
  }
  await replace(credentials);
  return {
    replace,
    async presence(enabled) { await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled }); },
    async credentials() { return (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials; },
  };
}

async function register(client, name, button = 'Create passkey') {
  await client.page.getByRole('textbox', { name: 'Passkey name', exact: true }).fill(name);
  const optionsResponse = client.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/register/options')
    .then(async response => ({ response, body: await response.json() }));
  const verification = client.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/register/verify');
  await client.page.getByRole('button', { name: button, exact: true }).click();
  const { response: optionsResult, body: { options } } = await optionsResponse;
  expect(optionsResult.status()).toBe(200);
  const verified = await verification;
  expect(verified.status()).toBe(200);
  expect(verified.headers()['cache-control']).toContain('no-store');
  const submitted = verified.request().postDataJSON();
  expect(submitted.response.clientExtensionResults.credProps.rk).toBe(true);
  expect(submitted.name).toBe(name);
  for (const value of [submitted.response.id, submitted.response.rawId, submitted.response.response?.attestationObject,
    submitted.response.response?.clientDataJSON, options.user.id, options.challenge]) {
    if (typeof value === 'string' && value) privateMaterial.add(value);
  }
  await sessionCookie(client);
  const identity = await sessionIdentity(client);
  if (button === 'Create passkey') {
    await expect(client.page).toHaveURL(url => url.pathname === '/' && url.hash.startsWith('#/'));
  }
  return { options, identity, credentialId: submitted.response.id };
}

async function signin(client, expectedStatus = 200, hash = '#/home') {
  client.observations.length = 0;
  const optionsResponses = [];
  const observationStart = client.observations.length;
  const observations = () => client.observations.slice(observationStart);
  const capture = (response) => {
    if (new URL(response.url()).pathname === '/api/auth/signin/options') optionsResponses.push(response.json());
  };
  client.page.on('response', capture);
  try {
    await client.auth.presence(false);
    await client.page.goto(`${base}/signin${hash === '#/home' ? '' : hash}`);
    await expect(client.page.getByRole('button', { name: 'Sign in with a passkey', exact: true })).toBeVisible();
    await expect.poll(() => client.page.evaluate(() => window.authProbe.checks), { message: 'conditional mediation capability was checked' }).toBeGreaterThan(0);
    await expect.poll(() => client.page.evaluate(() => typeof window.authProbe.available), { message: 'conditional mediation capability resolved' }).toBe('boolean');
    const probe = await client.page.evaluate(() => window.authProbe);
    if (probe.available) {
      await expect.poll(() => client.page.evaluate(() => window.authProbe.conditional), { message: 'available conditional ceremony was set up' }).toBeGreaterThan(0);
    }
    await client.page.route('**/api/auth/signin/options', async route => {
      await client.auth.presence(true);
      await route.continue();
    }, { times: 1 });
    const verification = client.page.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/signin/verify');
    await client.page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click({ noWaitAfter: true });
    await expect.poll(() => observations().some((item) => item.kind === 'explicit'), { message: 'button invoked real explicit WebAuthn' }).toBe(true);
    const response = await verification;
    expect(response.status()).toBe(expectedStatus);
    if (probe.available) {
      const aborted = observations().findIndex((item) => item.kind === 'abort');
      const explicit = observations().findIndex((item) => item.kind === 'explicit');
      expect(aborted, 'pending conditional ceremony was aborted').toBeGreaterThanOrEqual(0);
      expect(aborted).toBeLessThan(explicit);
    }
    const optionBodies = await Promise.all(optionsResponses);
    expect(optionBodies.length).toBeGreaterThan(0);
    for (const body of optionBodies) {
      expect(body.options.userVerification).toBe('required');
      expect(body.options.allowCredentials).toBeUndefined();
    }
    if (expectedStatus === 200) {
      await expect(client.page).toHaveURL((url) => url.hash === hash);
      expect((await sessionIdentity(client)).email).toBe(OWNER);
      await assertAuthenticatedBoot(client);
    } else {
      expect((await client.context.request.get('/api/scenario')).status()).toBe(401);
      await expect(client.page.locator('body')).toContainText(/passkey|sign in/i);
    }
  } finally {
    client.page.off('response', capture);
  }
}

async function assertAuthenticatedBoot(client) {
  const sessions = await Promise.all(client.sessionResponses.map(async (entry) => ({ ...entry, body: await entry.body })));
  expect(client.scenarioRequests.length, 'authenticated app fetched the scenario').toBeGreaterThan(0);
  for (const request of client.scenarioRequests) {
    expect(sessions.some((entry) => entry.document === request.document && entry.sequence < request.sequence && entry.body?.identity), 'scenario fetch must follow authenticated identity in the same document').toBe(true);
  }
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
  for (const cookie of cookies.filter(item => item.name.startsWith('__Host-fathom-'))) privateMaterial.add(cookie.value);
  const session = cookies.find(item => item.name === '__Host-fathom-session');
  expect(Boolean(session), 'real registration or sign-in established a session').toBe(true);
  return session.value;
}

async function assertPasskeyNames(client, names) {
  const response = await client.context.request.get('/api/auth/passkeys');
  expect(response.status()).toBe(200);
  expect(JSON.stringify(await response.json())).not.toMatch(/"(?:public_key|publicKey|counter|user_handle|userHandle)"\s*:/);
  await client.page.goto(`${base}/account`);
  await expect(client.page.getByRole('button', { name: 'Revoke passkey', exact: true })).toHaveCount(names.length);
  for (const name of names) await expect(passkeyRow(client.page, name)).toBeVisible();
}

function userRow(page, email) {
  return page.getByRole('row').or(page.getByRole('listitem')).filter({ hasText: email });
}
function passkeyRow(page, name) {
  return page.getByRole('row').or(page.getByRole('listitem')).filter({ hasText: name });
}

function post(client, path, data) {
  return client.context.request.post(path, { headers: { Origin: base }, data });
}

async function mcp(key) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'synthetic-auth-e2e', version: '0.0.0' },
    } }),
  });
  await response.text();
  return response;
}

function outboxNames() {
  try { return new Set(readdirSync(join(dataDir, 'outbox')).filter((name) => name.endsWith('.json'))); }
  catch (err) { if (err.code === 'ENOENT') return new Set(); throw new Error('Synthetic outbox could not be read'); }
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

async function mailedLink(before, email) {
  let message;
  await expect.poll(() => {
    const added = [...outboxNames()].filter((name) => !before.has(name));
    const messages = added.map((name) => JSON.parse(readFileSync(join(dataDir, 'outbox', name), 'utf8')));
    message = messages.find((item) => Array.isArray(item.to) && item.to.length === 1 && item.to[0] === email
      && /\/enroll#[A-Za-z0-9_-]{43}/.test(`${item.text} ${item.html}`));
    return Boolean(message);
  }, { timeout: 10_000, message: 'synthetic recipient received its auth email' }).toBe(true);
  return extractLink(`${message.text} ${message.html}`);
}

function emailSendCount() {
  const db = openDb(join(dataDir, 'fathom.sqlite'));
  try { return db.prepare('SELECT count(*) AS n FROM email_sends').get().n; }
  finally { db.close(); }
}

function securitySnapshot() {
  return { names: outboxNames(), emailSends: emailSendCount() };
}

async function securityNotices(before, subject, recipients) {
  let messages = [];
  await expect.poll(() => {
    messages = [...outboxNames()].filter(name => !before.names.has(name))
      .map(name => JSON.parse(readFileSync(join(dataDir, 'outbox', name), 'utf8')))
      .filter(message => ['Fathom passkey added', 'Fathom account recovered'].includes(message.subject));
    return messages.filter(message => message.subject === subject).length;
  }, { message: 'committed WebAuthn registration delivered its security notices' }).toBe(recipients.length);
  expect(messages).toHaveLength(recipients.length);
  expect(messages.map(message => message.to).sort()).toEqual(recipients.map(email => [email]).sort());
  for (const context of contexts) {
    for (const cookie of await context.cookies(base)) {
      if (cookie.name.startsWith('__Host-fathom-') && cookie.value) privateMaterial.add(cookie.value);
    }
  }
  for (const message of messages) {
    expect(message.subject).toBe(subject);
    expect(message.to).toHaveLength(1);
    expect(message.cc).toBeUndefined();
    expect(message.bcc).toBeUndefined();
    expect(typeof message.text).toBe('string');
    expect(typeof message.html).toBe('string');
    const body = `${message.subject}\n${message.text}\n${message.html}`;
    expect(body).toMatch(/passkey/i);
    if (subject === 'Fathom account recovered') {
      const content = `${message.text} ${message.html}`;
      expect(content).toMatch(/recover/i);
      expect(content).toMatch(/complet|recovered|success|finish/i);
      expect(content).toMatch(/new passkey/i);
    }
    expect(body).not.toMatch(/https?:\/\/|href\s*=|\/enroll|fathom_[A-Za-z0-9_-]{43}|-----BEGIN/);
    for (const value of [...issuedTokens, ...privateMaterial]) {
      expect(body.includes(value), 'security notices contain no link tokens, sessions or credential material').toBe(false);
    }
  }
  expect(emailSendCount(), 'security notices bypass financial email_sends').toBe(before.emailSends);
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
  await expect.poll(() => client.page.evaluate(() => location.hash === ''), { message: 'enrollment fragment removed from history' }).toBe(true);
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
  expect((await replay.context.request.get('/healthz')).status()).toBe(200);
}

function seedReturningHousehold() {
  const db = openDb(join(dataDir, 'fathom.sqlite'));
  try {
    db.prepare("INSERT INTO accounts (id, inst, name, owner, kind, mirror, parser) VALUES ('acct-auth-e2e', 'Synthetic Bank', 'Synthetic Checking', NULL, 'checking', 'manual', 'e2e')").run();
    const result = ask(db, {
      kind: 'account_owner', subject: 'acct-auth-e2e', question: 'Whose account is Synthetic Checking?',
      options: OWNER_OPTIONS, context: {}, now: '2026-11-05T12:00:00.000Z',
    });
    expect(result.queued).toBe(true);
    confirmationId = result.id;
  } finally { db.close(); }
}
