// Create a read-scope API key in the store this process's environment already points at
// (same loadConfig as scripts/user-invite.mjs). The raw key is written to stdout once.
// Every other message goes to stderr. The key is never logged.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { openServedStore } from '../src/platform/ready.mjs';
import { createAuthStore, normalizeEmail } from '../src/auth/store.mjs';
import { createKeyService, loadServerSecret } from '../src/mcp/keys.mjs';

function usage() {
  console.error('usage: node scripts/mcp-key.mjs create --name <name> --owner <email>');
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length || argv[i + 1].startsWith('--')) return null;
  return argv[i + 1];
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let db, platform;
  try {
    if (argv[0] !== 'create') {
      usage();
      return 1;
    }
    const name = flag(argv, '--name');
    const owner = flag(argv, '--owner');
    const known = new Set(['create', '--name', name, '--owner', owner]);
    if (!name || !owner || argv.some(a => !known.has(a))) {
      usage();
      return 1;
    }
    let email;
    try {
      email = normalizeEmail(owner);
    } catch {
      console.error('mcp-key: unknown owner');
      return 1;
    }
    const config = loadConfig(env);
    let householdId;
    try {
      ({ db, platform, householdId } = openServedStore(config));
    } catch (e) {
      if (e.name !== 'StartupError') throw e;
      console.error(`mcp-key: ${e.code}`);
      return 1;
    }
    const auth = createAuthStore(platform);
    // A key's creator must be an active member of the household this store serves.
    const creatorActive = userId => auth.membership(userId, householdId)?.status === 'active';
    const user = auth.findUser(email);
    if (!user || !creatorActive(user.id)) {
      console.error('mcp-key: unknown owner');
      return 1;
    }
    const dup = db.prepare('SELECT id FROM api_keys WHERE name = ? AND revoked_at IS NULL').get(name.trim());
    if (dup) {
      console.error('mcp-key: active key name already exists');
      return 1;
    }
    const keys = createKeyService({ db, serverSecret: loadServerSecret(config.dataDir), creatorActive });
    const { key } = keys.create({ name, scopes: ['read'], userId: user.id });
    process.stdout.write(`${key}\n`);
    return 0;
  } catch (err) {
    console.error(`mcp-key: ${err && err.message ? err.message : 'failed'}`);
    return 1;
  } finally {
    db?.close();
    platform?.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main();
}
