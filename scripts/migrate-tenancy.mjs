// `node scripts/migrate-tenancy.mjs`: the offline MT-03 tenancy migration of the instance in
// $FATHOM_DATA (see src/platform/migrate-tenancy.mjs). Stop every Fathom process first and set
// five private files: FATHOM_BACKUP_KEY_FILE (encrypts the snapshot in the data directory's
// snapshots/), FATHOM_DATA_KEY_FILE (the legacy upload key), FATHOM_PLATFORM_KEY_FILE (wraps the
// household data key), FATHOM_MCP_SECRET_FILE (the same 64 hex characters as api-key-secret).
// Safe to rerun: an interrupted run resumes and a completed one is reconciled. Prints only
// `migrate-tenancy: complete <householdId>` (exit 0) or `migrate-tenancy: <code>` on stderr (exit 1).

import { resolve } from 'node:path';
import { migrateTenancy } from '../src/platform/migrate-tenancy.mjs';

const blank = v => v == null || v === '';
const env = name => (blank(process.env[name]) ? undefined : process.env[name]);
const safeCode = e => (e && typeof e.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(e.code) ? e.code : 'migration_failed');

try {
  const { householdId } = await migrateTenancy({
    dataDir: resolve(env('FATHOM_DATA') ?? 'data'),
    backupKeyFile: env('FATHOM_BACKUP_KEY_FILE'),
    legacyKeyFile: env('FATHOM_DATA_KEY_FILE'),
    platformKeyFile: env('FATHOM_PLATFORM_KEY_FILE'),
    mcpSecretFile: env('FATHOM_MCP_SECRET_FILE'),
  });
  console.log(`migrate-tenancy: complete ${householdId}`);
} catch (e) {
  console.error(`migrate-tenancy: ${safeCode(e)}`);
  process.exitCode = 1;
}
