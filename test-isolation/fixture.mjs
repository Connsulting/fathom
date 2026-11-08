import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../test/helpers/server.mjs';
import { startRuntime, writeInstanceKeys } from '../test/helpers/tenancy-runtime.mjs';
import { browser, register, signIn } from '../test/helpers/tenancy.mjs';
import { createAuthenticator } from '../test/helpers/webauthn.mjs';
import { createAuthStore } from '../src/auth/store.mjs';

export const headersOf = person => ({ cookie: `__Host-fathom-session=${person.client.session()}`,
  'x-fathom-household': person.identity.householdId, 'x-fathom-context-version': String(person.identity.contextVersion) });

export function ok(r) {
  assert.equal(r.status, 200, `HTTP ${r.status}: ${r.text?.slice(0, 160)}`);
  return r.json;
}

export async function isolationFixture({ engine = 'fake', extra = {}, engineOptions = null } = {}) {
  const root = await tempDir('fathom-isolation-');
  const dataDir = join(root, 'data');
  const keys = writeInstanceKeys(join(root, 'keys'));
  let server;
  try {
    mkdirSync(join(root, 'backups'), { mode: 0o700 });
    server = await startRuntime({ dataDir, keys, engine, extra: {
      FATHOM_BACKUP_KEY_FILE: keys.backupKeyFile, FATHOM_BACKUP_DESTINATION: join(root, 'backups'), ...extra,
    }, engineOptions });
    const { app, baseUrl } = server;
    const store = createAuthStore(app.platform);
    const mail = () => {
      const dir = join(dataDir, 'outbox');
      return existsSync(dir) ? readdirSync(dir).filter(n => n.endsWith('.json')).map(name => ({ name,
        ...JSON.parse(readFileSync(join(dir, name), 'utf8')) })) : [];
    };
    const mailedToken = (before, email) => {
      const seen = new Set(before.map(m => m.name));
      const sent = mail().filter(m => !seen.has(m.name) && [].concat(m.to).includes(email));
      assert.ok(sent.length, 'enrollment reached the local mail sink');
      const token = /\/enroll#([A-Za-z0-9_-]{43})/.exec(sent.at(-1).text)?.[1];
      assert.ok(token, 'mail has an enrollment link');
      return token;
    };
    const enroll = async token => {
      const client = browser(baseUrl), device = createAuthenticator();
      const result = await register(baseUrl, client, device, { token });
      ok(result.options);
      const identity = ok(result.verify).identity;
      assert.ok(client.session(), 'server issued a verified WebAuthn session');
      return { client, device, identity, credentialId: device.credentials()[0].id };
    };
    const invite = async (hh, email, role = 'member') => {
      const before = mail();
      ok(await hh.admin.client.post('/api/admin/users/invite', { email, role }));
      return enroll(mailedToken(before, email));
    };
    const A = { id: app.platform.prepare('SELECT id FROM households WHERE serves_store = 1').get().id, canary: 'ALPHAFINCH' };
    // The first invitation is the OS operator bootstrap. All sessions are verified by HTTP WebAuthn.
    A.admin = await enroll(store.invite(A.id, 'alpha-admin@example.test', { role: 'admin' }).token);
    store.grantOperator(A.admin.identity.id);
    A.admin.identity = ok(await A.admin.client.get('/api/auth/session')).identity;
    const before = mail();
    const made = ok(await A.admin.client.post('/api/operator/households', {
      displayName: 'Synthetic Bravo Household', adminEmail: 'bravo-admin@example.test',
    }));
    const B = { id: made.household.id, canary: 'BRAVOTERN' };
    B.admin = await enroll(mailedToken(before, 'bravo-admin@example.test'));
    A.member = await invite(A, 'alpha-member@example.test');
    B.member = await invite(B, 'bravo-member@example.test');
    const dual = await invite(A, 'dual-member@example.test');
    const prior = mail();
    ok(await B.admin.client.post('/api/admin/users/invite', { email: 'dual-member@example.test', role: 'member' }));
    dual.identity = ok(await dual.client.post('/api/auth/invitations/accept', { token: mailedToken(prior, 'dual-member@example.test') })).identity;
    const operator = await invite(A, 'operator@example.test');
    store.grantOperator(operator.identity.id);
    store.removeMember(A.id, operator.identity.id, { actorId: A.admin.identity.id });
    const signed = await signIn(baseUrl, operator.device, operator.credentialId);
    operator.client = signed.client;
    operator.identity = ok(signed.verify).identity;
    for (const hh of [A, B]) {
      Object.defineProperties(hh, {
        ctx: { get: () => app.runtimes.get(hh.id) },
        db: { get: () => hh.ctx.db },
      });
    }
    return { root, dataDir, keys, app, baseUrl, store, platform: app.platform, server, A, B, dual, operator,
      mail, mailedToken, enroll, invite,
      async close() { await server.close(); rmSync(root, { recursive: true, force: true }); } };
  } catch (e) {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
}
