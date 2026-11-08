// A household runtime writes pack state only when the household starts serving (startAll, or a
// build after it), never while a context is built or read: an in-process read path stays read-only.
// Every value here is synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createRuntimeRegistry } from '../src/platform/runtime.mjs';
import { tempInstance } from './helpers/server.mjs';

test('building and reading a household context writes no pack state; starting the household refreshes it', async t => {
  const temp = await tempInstance({ mode: 'real' });
  const config = {
    dataDir: temp.dataDir, platformKeyFile: temp.keys.platformKeyFile, mcpSecretFile: temp.keys.mcpSecretFile,
    engine: 'off', clock: null, demo: false, port: 0, host: '127.0.0.1', publicUrl: null, claudeCredentialFile: null, emailTransport: 'dev',
  };
  const runtimes = createRuntimeRegistry({ platform: temp.platform, config, secrets: temp.secrets });
  t.after(async () => {
    await runtimes.close();
    temp.close();
    rmSync(temp.dataDir, { recursive: true, force: true });
  });
  const packRows = async () => (await temp.db.prepare('SELECT count(*) AS n FROM packs_state').get()).n;

  const context = runtimes.get(temp.householdId);
  assert.ok(context, 'the household is served');
  assert.equal(context.isCurrent(), true);
  await temp.platform.prepare('UPDATE households SET generation = generation + 1 WHERE id = ?').run(temp.householdId);
  assert.equal(context.isCurrent(), false, 'a captured generation cannot dispatch after replacement');
  await temp.platform.prepare('UPDATE households SET generation = generation - 1 WHERE id = ?').run(temp.householdId);
  await temp.platform.prepare("UPDATE households SET status = 'suspended' WHERE id = ?").run(temp.householdId);
  assert.equal(context.isCurrent(), false);
  await temp.platform.prepare("UPDATE households SET status = 'active' WHERE id = ?").run(temp.householdId);
  assert.equal(context.isCurrent(), true);
  assert.ok(context.packs.loaded().length > 0, 'packs load on read');
  assert.equal(await packRows(), 0, 'building and reading the context wrote no pack state');

  await runtimes.startAll();
  assert.ok(await packRows() > 0, 'starting the household refreshed its pack state');
});
