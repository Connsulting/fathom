// Offline encrypted source snapshots (src/platform/snapshot.mjs), key from FATHOM_BACKUP_KEY_FILE.
// Run with the source server stopped.
//
//   node scripts/source-snapshot.mjs create --out <dir>
//       Snapshot the store and MCP key secret in $FATHOM_DATA into a new .fsnap file (0600) in <dir>.
//   node scripts/source-snapshot.mjs restore --snapshot <file> --out <dir>
//       Authenticate the snapshot and write its files into the new directory <dir>.
//   node scripts/source-snapshot.mjs rollback --snapshot <file> --from <data dir> --out <new data dir>
//       Build a data directory for the previous release: every retained file of <data dir> except
//       the platform database, migration journal and lock, snapshots and store WAL files, with the
//       store and secret from the snapshot. <data dir> is left untouched.
//
// Refusals print `source-snapshot: <code>` on stderr and exit 1; nothing else is printed.

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { newOperationId } from '../src/platform/db.mjs';
import { loadBackupKey } from '../src/platform/backup-key.mjs';
import { adHocSnapshotName, createSourceSnapshot, restoreSourceSnapshot, rollbackFromSnapshot } from '../src/platform/snapshot.mjs';

const blank = v => v == null || v === '';
const safeCode = e => (e && typeof e.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(e.code) ? e.code : 'snapshot_failed');
const usage = () => Object.assign(new Error('usage'), { code: 'usage' });

function parse(argv, allowed) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith('--') || !allowed.includes(flag.slice(2)) || blank(value) || flag.slice(2) in out) throw usage();
    out[flag.slice(2)] = resolve(value);
  }
  for (const name of allowed) if (!(name in out)) throw usage();
  return out;
}

async function main([command, ...rest]) {
  const keyFile = blank(process.env.FATHOM_BACKUP_KEY_FILE) ? undefined : process.env.FATHOM_BACKUP_KEY_FILE;
  if (command === 'create') {
    const { out } = parse(rest, ['out']);
    const key = loadBackupKey(keyFile);
    const dataDir = resolve(blank(process.env.FATHOM_DATA) ? 'data' : process.env.FATHOM_DATA);
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const operationId = newOperationId();
    await createSourceSnapshot({ dataDir, key, out: join(out, adHocSnapshotName(operationId)), operationId, mode: 0o600 });
    return 'created';
  }
  if (command === 'restore') {
    const { snapshot, out } = parse(rest, ['snapshot', 'out']);
    restoreSourceSnapshot({ file: snapshot, key: loadBackupKey(keyFile), out });
    return 'restored';
  }
  if (command === 'rollback') {
    const { snapshot, from, out } = parse(rest, ['snapshot', 'from', 'out']);
    rollbackFromSnapshot({ snapshot, key: loadBackupKey(keyFile), from, out });
    return 'rolled back';
  }
  throw usage();
}

try {
  console.log(`source-snapshot: ${await main(process.argv.slice(2))}`);
} catch (e) {
  console.error(`source-snapshot: ${safeCode(e)}`);
  process.exitCode = 1;
}
