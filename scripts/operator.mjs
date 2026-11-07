// `node scripts/operator.mjs grant <email>` / `revoke <email>`: grant or revoke instance operator
// authority at the OS boundary (whoever can run this on the host holding $FATHOM_DATA). Only an
// enrolled account can be granted; revoking the last operator is refused. The auth store audits
// each change. Touches only platform.sqlite. Prints fixed codes only, never the email: success
// exits 0, a refusal prints `operator: <code>` on stderr and exits 1.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PLATFORM_FILE, LOCK_FILE, openPlatform } from '../src/platform/db.mjs';
import { LOCK_FILE as TENANCY_LOCK_FILE } from '../src/platform/migrate-tenancy.mjs';
import { createAuthStore } from '../src/auth/store.mjs';

const blank = v => v == null || v === '';
const fail = code => Object.assign(new Error(code), { code });

function codeOf(e) {
  if (e && typeof e.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(e.code)) return e.code;
  if (e && e.status === 409) return 'last_operator';
  if (e && e.status === 404) return 'no_such_user';
  if (e && (e.status === 400 || e.status === 403)) return 'not_enrolled';
  return 'operator_failed';
}

function main([command, email, ...extra]) {
  if (!['grant', 'revoke'].includes(command) || blank(email) || extra.length) throw fail('usage');
  const dataDir = resolve(blank(process.env.FATHOM_DATA) ? 'data' : process.env.FATHOM_DATA);
  if (existsSync(join(dataDir, LOCK_FILE))) throw fail('platform_migration_in_progress');
  if (existsSync(join(dataDir, TENANCY_LOCK_FILE))) throw fail('tenancy_migration_in_progress');
  const file = join(dataDir, PLATFORM_FILE);
  if (!existsSync(file)) throw fail('platform_migration_required');
  const platform = openPlatform(file);
  try {
    const store = createAuthStore(platform);
    const user = store.findUser(email);
    if (!user) throw fail('no_such_user');
    if (command === 'grant') {
      if (user.enrolledAt == null) throw fail('not_enrolled');
      store.grantOperator(user.id, { actorId: null });
      return 'granted';
    }
    store.revokeOperator(user.id, { actorId: null });
    return 'revoked';
  } finally {
    platform.close();
  }
}

try {
  console.log(`operator: ${main(process.argv.slice(2))}`);
} catch (e) {
  console.error(`operator: ${codeOf(e)}`);
  process.exitCode = 1;
}
