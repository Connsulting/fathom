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
  const packRows = () => temp.db.prepare('SELECT count(*) AS n FROM packs_state').get().n;

  const context = runtimes.get(temp.householdId);
  assert.ok(context, 'the household is served');
  assert.ok(context.packs.loaded().length > 0, 'packs load on read');
  assert.equal(packRows(), 0, 'building and reading the context wrote no pack state');

  runtimes.startAll();
  assert.ok(packRows() > 0, 'starting the household refreshed its pack state');
});
