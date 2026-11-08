import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './server.mjs';
import { browser, register } from './tenancy.mjs';
import { createAuthenticator } from './webauthn.mjs';
import { startRuntime, writeInstanceKeys, writePrivate } from './tenancy-runtime.mjs';
import { createAuthStore } from '../../src/auth/store.mjs';
import { PURPOSES, storeObject, sealConnectionSecret } from '../../src/platform/household-vault.mjs';
import { loadConfig } from '../../src/config.mjs';

export async function backupFixture() {
  const root = await tempDir('fathom-backup-');
  const dataDir = join(root, 'data');
  const keys = writeInstanceKeys(join(root, 'keys'));
  const destination = join(root, 'backups');
  mkdirSync(destination, { mode: 0o700 });
  const server = await startRuntime({ dataDir, keys, engine: 'off', extra: {
    FATHOM_BACKUP_KEY_FILE: keys.backupKeyFile, FATHOM_BACKUP_DESTINATION: destination,
  } });
  const platform = server.app.platform;
  const store = createAuthStore(platform);
  const enroll = async (id, email, role = 'admin') => {
    const invitation = store.invite(id, email, { role });
    const client = browser(server.baseUrl);
    const device = createAuthenticator();
    const result = await register(server.baseUrl, client, device, { token: invitation.token });
    assert.equal(result.verify?.status, 200, result.verify?.text);
    return { userId: invitation.user.id, client, device };
  };
  try {
    const A = { id: platform.prepare('SELECT id FROM households WHERE serves_store = 1').get().id };
    A.admin = await enroll(A.id, 'alpha@example.test');
    A.member = await enroll(A.id, 'member@example.test', 'member');
    store.grantOperator(A.admin.userId);
    store.setPlatformSetting('multi_household_enabled', true);
    const made = await A.admin.client.post('/api/operator/households', { displayName: 'Synthetic Bravo', adminEmail: 'bravo@example.test' });
    assert.equal(made.status, 200, made.text);
    const B = { id: made.json.household.id };
    B.admin = await enroll(B.id, 'bravo@example.test');
    for (const [hh, marker] of [[A, 'alpha'], [B, 'bravo']]) {
      const ctx = server.app.runtimes.get(hh.id);
      hh.root = ctx.root;
      ctx.db.prepare("INSERT INTO facts (key, value, updated_at) VALUES ('backup.marker', ?, '2026-11-01')").run(JSON.stringify(marker));
      const { root: vaultRoot, handle } = await ctx.vault();
      const bytes = Buffer.from(`Synthetic ${marker} upload`);
      const path = await storeObject({ root: vaultRoot, handle, purpose: PURPOSES.upload, objectId: 'synthetic-file', bytes });
      const { createHash } = await import('node:crypto');
      const hash = createHash('sha256').update(bytes).digest('hex');
      ctx.db.prepare("INSERT INTO files (id, name, mime, size, sha256, stored_path, status, uploaded_at) VALUES ('synthetic-file', 'synthetic.txt', 'text/plain', ?, ?, ?, 'imported', '2026-11-01')").run(bytes.length, hash, path);
      const packet = Buffer.from(`Synthetic ${marker} packet`);
      const packetPath = await storeObject({ root: vaultRoot, handle, purpose: PURPOSES.advisorPacket, objectId: 'synthetic-packet', bytes: packet });
      ctx.db.prepare("INSERT INTO advisor_packets (id, created_at, clock, rec_ids, stored_path, sha256, bytes) VALUES ('synthetic-packet', '2026-11-01', '2026-11-01', '[]', ?, ?, ?)")
        .run(packetPath, createHash('sha256').update(packet).digest('hex'), packet.length);
      ctx.db.prepare("INSERT INTO simplefin_connection (id, access_blob, status, connected_at) VALUES (1, ?, 'ok', '2026-11-01')")
        .run(sealConnectionSecret(handle, 'https://synthetic:synthetic@sfin.example.invalid/simplefin'));
      writePrivate(join(ctx.root, 'packs', 'your-plans', 'entries', 'synthetic.md'), `# Synthetic ${marker} private plan\n`);
      writePrivate(join(ctx.root, 'outbox', 'synthetic.json'), JSON.stringify({ text: `Synthetic ${marker} historical mail` }));
      writePrivate(join(ctx.root, 'work', 'transient.txt'), 'Synthetic transient');
      hh.key = (await hh.admin.client.post('/api/keys', { name: 'Synthetic backup key', scopes: ['read'] })).json;
    }
    return { root, dataDir, keys, destination, server, platform, store, A, B, enroll,
      config: loadConfig(server.env),
      context: id => server.app.runtimes.get(id),
      async close() { await server.close(); rmSync(root, { recursive: true, force: true }); },
    };
  } catch (err) { await server.close(); rmSync(root, { recursive: true, force: true }); throw err; }
}

export const marker = ctx => JSON.parse(ctx.db.prepare("SELECT value FROM facts WHERE key = 'backup.marker'").get().value);
export const changeMarker = (ctx, value) => ctx.db.prepare("UPDATE facts SET value = ? WHERE key = 'backup.marker'").run(JSON.stringify(value));
export const platformRows = (platform, table, householdId) => platform.prepare(`SELECT * FROM ${table} WHERE household_id = ? ORDER BY rowid`).all(householdId);
export async function backup(f, id = f.A.id) {
  const { backupHousehold } = await import('../../src/platform/household-backup.mjs');
  return backupHousehold({ platform: f.platform, config: f.config, runtimes: f.server.app.runtimes, householdId: id });
}
export async function restore(f, file, options = {}) {
  const { restoreHousehold } = await import('../../src/platform/household-backup.mjs');
  return restoreHousehold({ platform: f.platform, config: f.config, runtimes: f.server.app.runtimes,
    householdId: f.A.id, confirmation: f.A.id, file, ...options });
}
