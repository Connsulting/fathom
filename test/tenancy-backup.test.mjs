import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { backupFixture, backup, restore, marker } from './helpers/tenancy-backup.mjs';
import { readSnapshotFile } from '../src/platform/snapshot.mjs';

test('a consistent encrypted household bundle contains only its own store, vault, private trees and restricted metadata', async () => {
  const f = await backupFixture();
  try {
    const result = await backup(f);
    const bytes = readFileSync(result.file);
    assert.ok(!bytes.includes(Buffer.from('Synthetic alpha')));
    const { manifest, files } = readSnapshotFile(result.file, f.keys.backupKey);
    assert.equal(manifest.householdBackup.householdId, f.A.id);
    assert.equal(manifest.householdBackup.generation, 1);
    assert.equal(manifest.householdBackup.memberships.length, 2);
    assert.deepEqual(Object.keys(manifest.householdBackup.memberships[0]).sort(), ['role', 'status', 'userId', 'version']);
    assert.ok(!JSON.stringify(manifest).includes(f.B.id));
    for (const forbidden of ['email', 'passkeys', 'auth_sessions', 'provider', 'platformKey']) assert.ok(!Object.hasOwn(manifest.householdBackup, forbidden));
    assert.ok(files.has('fathom.sqlite'));
    assert.ok(files.has('files/synthetic-file.bin'));
    assert.ok(files.has('files/synthetic-packet.bin'));
    assert.ok(files.has('packs/your-plans/entries/synthetic.md'));
    assert.ok(files.has('outbox/synthetic.json'));
    assert.ok([...files.keys()].every(p => !p.startsWith('work/') && !p.includes('platform')));
    assert.equal(marker(f.context(f.A.id)), 'alpha');
    assert.equal(marker(f.context(f.B.id)), 'bravo');
  } finally { await f.close(); }
});

test('missing keys, mismatched identity, tampering, confirmation and symlink failures change no active state', async () => {
  const f = await backupFixture();
  try {
    await assert.rejects(backup(f, 'missing-household'), { code: 'household_unavailable' });
    const valid = await backup(f);
    const generation = () => f.platform.prepare('SELECT generation FROM households WHERE id = ?').get(f.A.id).generation;
    const original = generation();
    await assert.rejects(restore(f, valid.file, { confirmation: f.B.id }), { code: 'restore_confirmation_required' });
    await assert.rejects(restore(f, valid.file, { householdId: f.B.id, confirmation: f.B.id }), { code: 'backup_identity_mismatch' });
    const bytes = readFileSync(valid.file); bytes[bytes.length - 20] ^= 1;
    const corrupt = join(f.destination, 'corrupt.fsnap'); writeFileSync(corrupt, bytes, { mode: 0o600 });
    await assert.rejects(restore(f, corrupt), { code: 'snapshot_invalid' });
    const saved = f.config.backupKeyFile; f.config.backupKeyFile = null;
    await assert.rejects(backup(f), { code: 'backup_key_invalid' });
    await assert.rejects(restore(f, valid.file), { code: 'backup_key_invalid' });
    f.config.backupKeyFile = saved;
    const key = readFileSync(f.keys.platformKeyFile); writeFileSync(f.keys.platformKeyFile, 'f'.repeat(64));
    await assert.rejects(restore(f, valid.file), { code: 'data_key_invalid' });
    writeFileSync(f.keys.platformKeyFile, key);
    symlinkSync(f.B.root, join(f.A.root, 'packs', 'foreign'));
    await assert.rejects(backup(f), { code: 'snapshot_source_invalid' });
    rmSync(join(f.A.root, 'packs', 'foreign'));
    assert.equal(generation(), original);
    assert.equal(marker(f.context(f.A.id)), 'alpha');
    assert.equal(marker(f.context(f.B.id)), 'bravo');
    assert.equal((await backup(f)).status, 'done', 'valid input still succeeds after refusals');
  } finally { await f.close(); }
});
