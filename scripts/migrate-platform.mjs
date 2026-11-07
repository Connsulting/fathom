// `node scripts/migrate-platform.mjs`: the offline MT-01 platform migration of the real store in
// $FATHOM_DATA (see src/platform/migrate.mjs). Stop every Fathom process first and set
// FATHOM_BACKUP_KEY_FILE to a private file holding a 32 byte key; the encrypted source snapshot
// lands in the data directory's snapshots/. Safe to rerun: an interrupted run resumes and a
// completed one is verified and left as it is. Prints only fixed codes: success exits 0, a refusal
// prints `migrate-platform: <code>` on stderr and exits 1.

import { resolve } from 'node:path';
import { migratePlatform } from '../src/platform/migrate.mjs';

const blank = v => v == null || v === '';
const safeCode = e => (e && typeof e.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(e.code) ? e.code : 'migration_failed');

try {
  await migratePlatform({
    dataDir: resolve(blank(process.env.FATHOM_DATA) ? 'data' : process.env.FATHOM_DATA),
    backupKeyFile: blank(process.env.FATHOM_BACKUP_KEY_FILE) ? undefined : process.env.FATHOM_BACKUP_KEY_FILE,
  });
  console.log('migrate-platform: complete');
} catch (e) {
  console.error(`migrate-platform: ${safeCode(e)}`);
  process.exitCode = 1;
}
