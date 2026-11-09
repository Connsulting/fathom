import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realStore, NOW } from './helpers/ingest.mjs';
import { seedDuplicate } from './helpers/account-merge.mjs';
import { childEnv, dumpStore, secretEnv } from './helpers/server.mjs';
import { buildLegacyStore } from './helpers/tenancy.mjs';
import { reopenItem, pendingItems } from '../src/ingest/confirm.mjs';
import { mapSeries } from '../src/shared/series.mjs';

async function historyPair(db, { fileId, sfId, sfKey, fileName, fileKind, connectedKind, august }) {
  await db.prepare('INSERT INTO accounts (id, identity, name, kind, mirror) VALUES (?,?,?,?,?)')
    .run(sfId, `simplefin:${sfKey}`, connectedKind === 'business' ? 'operating business' : 'operating', connectedKind, 'connected');
  await db.prepare("INSERT INTO simplefin_accounts (sf_key, account_id, status, name, created_at, backfilled) VALUES (?,?,'mapped',?,?,1)")
    .run(sfKey, sfId, connectedKind, NOW);
  await db.prepare("INSERT INTO accounts (id, identity, name, kind, mirror) VALUES (?,?,?,?,?)")
    .run(fileId, `file:${fileId}`, fileName, fileKind, 'manual');
  const put = db.prepare('INSERT INTO balances (account_id, date, amount) VALUES (?,?,?)');
  for (const [id, rows] of [[fileId, [['2032-06-30', 1000], ['2032-07-31', 1100.5], ['2032-08-31', 900.25]]],
    [sfId, [['2032-06-30', 1000], ['2032-07-31', 1100.5], [august, 900.25], ['2032-09-15', 40]]]])
    for (const [date, amount] of rows) await put.run(id, date, amount);
}

// Data dir entries, ignoring the -wal/-shm sidecars a read-only SQLite open of a WAL store leaves.
const listing = dir => readdirSync(dir).filter(f => !/-(wal|shm)$/.test(f)).sort();
const dump = async db => await mapSeries((await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()), async ({name}) => [name, await db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
test('operator dry run is read only, apply-sure merges only sure and normal Undo restores', async () => {
  const s = await realStore();
  try {
    const sure = await seedDuplicate(s, { sure: true });
    await seedDuplicate(s, { mask: '5837', sfKey: 'synthetic-unsure' });
    const env = childEnv({ FATHOM_DATA: s.dataDir, ...secretEnv(s.keys), FATHOM_CLOCK: '2032-03-10', FATHOM_ENGINE: 'off' });
    const before = await dump(s.db);
    const dry = spawnSync(process.execPath, ['scripts/merge-accounts.mjs', '--household', s.householdId], { env, encoding:'utf8' });
    assert.equal(dry.status,0,dry.stderr); assert.deepEqual(JSON.parse(dry.stdout),{ pairs:2,sure:1,likely:1,merged:0 });
    assert.deepEqual(await dump(s.db),before);
    const apply = spawnSync(process.execPath, ['scripts/merge-accounts.mjs', '--household', s.householdId, '--apply-sure'], { env,encoding:'utf8' });
    assert.equal(apply.status,0,apply.stderr); assert.deepEqual(JSON.parse(apply.stdout),{pairs:2,sure:1,likely:1,merged:1});
    assert.equal((await s.db.prepare('SELECT count(*) n FROM accounts').get()).n,3);
    assert.equal((await pendingItems(s.db)).filter(i=>i.context.repair).length,1);
    const q = await s.db.prepare("SELECT id FROM confirm_items WHERE kind='account_match' AND answer='same'").get();
    await reopenItem(s.db,q.id,{now:NOW});
    assert.ok(await s.db.prepare('SELECT 1 FROM accounts WHERE id=?').get(sure.own));
    assert.equal((await s.db.prepare('SELECT count(*) n FROM accounts').get()).n,4);
  } finally {await s.close();}
});
test('AC3: apply-sure fills the institution and last 4 of an already merged survivor, and a dry run does not', async () => {
  const s = await realStore();
  try {
    const sure = await seedDuplicate(s, { sure: true });
    const env = childEnv({ FATHOM_DATA: s.dataDir, ...secretEnv(s.keys), FATHOM_CLOCK: '2032-03-10', FATHOM_ENGINE: 'off' });
    const first = spawnSync(process.execPath, ['scripts/merge-accounts.mjs', '--household', s.householdId, '--apply-sure'], { env, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).merged, 1);
    assert.equal(await s.db.prepare('SELECT 1 FROM accounts WHERE id=?').get(sure.own), undefined, 'precondition: the pair is merged');
    // An older merge: the survivor lost what the merge now fills.
    await s.db.prepare('UPDATE accounts SET inst=NULL, mask=NULL WHERE id=?').run(sure.keep);

    const dry = spawnSync(process.execPath, ['scripts/merge-accounts.mjs', '--household', s.householdId], { env, encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    let survivor = await s.db.prepare('SELECT inst, mask FROM accounts WHERE id=?').get(sure.keep);
    assert.deepEqual({ ...survivor }, { inst: null, mask: null }, 'a dry run writes nothing');

    const apply = spawnSync(process.execPath, ['scripts/merge-accounts.mjs', '--household', s.householdId, '--apply-sure'], { env, encoding: 'utf8' });
    assert.equal(apply.status, 0, apply.stderr);
    assert.equal(JSON.parse(apply.stdout).merged, 0, 'nothing left to merge');
    survivor = await s.db.prepare('SELECT inst, mask FROM accounts WHERE id=?').get(sure.keep);
    assert.deepEqual({ ...survivor }, { inst: 'Example Bank', mask: '6294' });
  } finally { await s.close(); }
});
test('an unmigrated real store refuses platform_migration_required for dry run and apply, unchanged', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fathom-legacy-'));
  try {
    const legacy = await buildLegacyStore(dataDir, { users: false });
    const files = listing(dataDir);
    const before = await dumpStore(legacy.file);
    const env = childEnv({ FATHOM_DATA: dataDir, FATHOM_CLOCK: '2032-03-10', FATHOM_ENGINE: 'off' });
    for (const args of [[], ['--apply-sure']]) {
      const r = spawnSync(process.execPath, ['scripts/merge-accounts.mjs', '--household', 'hh-synthetic-legacy', ...args], { env, encoding:'utf8' });
      assert.equal(r.status, 1);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, 'merge-accounts: platform_migration_required\n');
    }
    assert.deepEqual(listing(dataDir), files);
    assert.deepEqual(await dumpStore(legacy.file), before);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
test('apply-sure merges both month-end history pairs', async () => {
  const s = await realStore();
  try {
    await historyPair(s.db, { fileId: 'file-check', sfId: 'sf-cash', sfKey: 'sf-cash', fileName: 'checking', fileKind: 'checking', connectedKind: 'cash', august: '2032-08-28' });
    await historyPair(s.db, { fileId: 'file-biz', sfId: 'sf-biz', sfKey: 'sf-biz', fileName: 'business', fileKind: 'business', connectedKind: 'business', august: '2032-08-27' });
    const env = childEnv({ FATHOM_DATA: s.dataDir, ...secretEnv(s.keys), FATHOM_CLOCK: '2032-09-15', FATHOM_ENGINE: 'off' });
    const dry = spawnSync(process.execPath, ['scripts/merge-accounts.mjs', '--household', s.householdId], { env, encoding:'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual(JSON.parse(dry.stdout), { pairs: 2, sure: 2, likely: 0, merged: 0 });
    assert.equal((await s.db.prepare('SELECT count(*) n FROM accounts').get()).n, 4);
    const apply = spawnSync(process.execPath, ['scripts/merge-accounts.mjs', '--household', s.householdId, '--apply-sure'], { env, encoding:'utf8' });
    assert.equal(apply.status, 0, apply.stderr);
    assert.deepEqual(JSON.parse(apply.stdout), { pairs: 2, sure: 2, likely: 0, merged: 2 });
    assert.equal((await s.db.prepare('SELECT count(*) n FROM accounts').get()).n, 2);
    assert.deepEqual((await s.db.prepare('SELECT account_id FROM simplefin_accounts ORDER BY sf_key').all()).map(r => r.account_id), ['file-biz', 'file-check']);
  } finally { await s.close(); }
});
test('apply-sure merges a survivor with a balance-only file and Undo restores it', async () => {
  const s = await realStore();
  try {
    await s.db.prepare('INSERT INTO accounts (id, identity, name, kind, mirror) VALUES (?,?,?,?,?)')
      .run('survivor', 'file:survivor', 'operating', 'cash', 'connected');
    await s.db.prepare("INSERT INTO simplefin_accounts (sf_key, account_id, status, name, created_at, backfilled) VALUES (?,?,'mapped',?,?,1)")
      .run('sf-survivor', 'survivor', 'operating', NOW);
    await s.db.prepare("INSERT INTO accounts (id, identity, name, kind, mirror) VALUES (?,?,?,?,?)")
      .run('file-only', 'file:file-only', 'checking', 'checking', 'manual');
    const put = s.db.prepare('INSERT INTO balances (account_id, date, amount) VALUES (?,?,?)');
    for (const [date, amount] of [['2032-06-15', 800], ['2032-06-30', 1000], ['2032-07-15', 1050], ['2032-07-31', 1100.5], ['2032-08-15', 950], ['2032-08-31', 900.25], ['2032-09-15', 40]])
      await put.run('survivor', date, amount);
    for (const [date, amount] of [['2032-06-30', 1000], ['2032-07-31', 1100.5], ['2032-08-31', 900.25]])
      await put.run('file-only', date, amount);
    const env = childEnv({ FATHOM_DATA: s.dataDir, ...secretEnv(s.keys), FATHOM_CLOCK: '2032-09-15', FATHOM_ENGINE: 'off' });
    const apply = spawnSync(process.execPath, ['scripts/merge-accounts.mjs', '--household', s.householdId, '--apply-sure'], { env, encoding: 'utf8' });
    assert.equal(apply.status, 0, apply.stderr);
    assert.deepEqual(JSON.parse(apply.stdout), { pairs: 1, sure: 1, likely: 0, merged: 1 });
    assert.equal((await s.db.prepare('SELECT count(*) n FROM accounts').get()).n, 1);
    assert.equal((await s.db.prepare('SELECT account_id FROM simplefin_accounts').get()).account_id, 'file-only');
    const q = await s.db.prepare("SELECT id FROM confirm_items WHERE kind='account_match' AND answer='same'").get();
    await reopenItem(s.db, q.id, { now: NOW });
    assert.ok(await s.db.prepare('SELECT 1 FROM accounts WHERE id=?').get('survivor'));
    assert.equal((await s.db.prepare('SELECT count(*) n FROM accounts').get()).n, 2);
  } finally { await s.close(); }
});
