import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realStore, NOW } from './helpers/ingest.mjs';
import { seedDuplicate } from './helpers/account-merge.mjs';
import { childEnv } from './helpers/server.mjs';
import { reopenItem, pendingItems } from '../src/ingest/confirm.mjs';

const dump = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name}) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
test('operator dry run is read only, apply-sure merges only sure and normal Undo restores', async () => {
  const s = await realStore();
  try {
    const sure = await seedDuplicate(s, { sure: true });
    await seedDuplicate(s, { mask: '5837', sfKey: 'synthetic-unsure' });
    const env = childEnv({ FATHOM_DATA: s.dataDir, FATHOM_DATA_KEY_FILE: s.keyFile, FATHOM_CLOCK: '2032-03-10', FATHOM_ENGINE: 'off' });
    const before = dump(s.db);
    const dry = spawnSync(process.execPath, ['scripts/merge-accounts.mjs'], { env, encoding:'utf8' });
    assert.equal(dry.status,0,dry.stderr); assert.deepEqual(JSON.parse(dry.stdout),{ pairs:2,sure:1,likely:1,merged:0 });
    assert.deepEqual(dump(s.db),before);
    const apply = spawnSync(process.execPath, ['scripts/merge-accounts.mjs','--apply-sure'], { env,encoding:'utf8' });
    assert.equal(apply.status,0,apply.stderr); assert.deepEqual(JSON.parse(apply.stdout),{pairs:2,sure:1,likely:1,merged:1});
    assert.equal(s.db.prepare('SELECT count(*) n FROM accounts').get().n,3);
    assert.equal(pendingItems(s.db).filter(i=>i.context.repair).length,1);
    const q = s.db.prepare("SELECT id FROM confirm_items WHERE kind='account_match' AND answer='same'").get();
    reopenItem(s.db,q.id,{now:NOW});
    assert.ok(s.db.prepare('SELECT 1 FROM accounts WHERE id=?').get(sure.own));
    assert.equal(s.db.prepare('SELECT count(*) n FROM accounts').get().n,4);
  } finally {s.close();}
});
