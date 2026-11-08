// Create a read-scope API key bound to one household of the instance this process's environment
// points at (same loadConfig as scripts/user-invite.mjs). The owner must be an active member of
// that household. The raw key is written to stdout once. Every other message goes to stderr, as a
// fixed line or code. The key is never logged.
//
// usage: node scripts/mcp-key.mjs create --name <name> --owner <email> --household <id>

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { openInstance } from '../src/platform/ready.mjs';
import { createInstanceSecrets } from '../src/platform/secrets.mjs';
import { createAuthStore, normalizeEmail } from '../src/auth/store.mjs';
import { createKeyService, KeyError } from '../src/mcp/keys.mjs';

function usage() {
  console.error('usage: node scripts/mcp-key.mjs create --name <name> --owner <email> --household <id>');
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length || argv[i + 1].startsWith('--')) return null;
  return argv[i + 1];
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let platform;
  try {
    if (argv[0] !== 'create') {
      usage();
      return 1;
    }
    const name = flag(argv, '--name');
    const owner = flag(argv, '--owner');
    const householdId = flag(argv, '--household');
    if (!householdId && !argv.includes('--household')) {
      console.error('mcp-key: household_required');
      return 1;
    }
    const known = new Set(['create', '--name', name, '--owner', owner, '--household', householdId]);
    if (!name || !owner || !householdId || argv.some(a => !known.has(a))) {
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
    let mode;
    try {
      const opened = await openInstance(config);
      if (!opened) {
        console.error('mcp-key: household_unavailable');
        return 1;
      }
      ({ platform, mode } = opened);
    } catch (e) {
      if (e.name !== 'StartupError') throw e;
      console.error(`mcp-key: ${e.code}`);
      return 1;
    }
    const household = await platform.prepare('SELECT status, storage_root FROM households WHERE id = ?').get(householdId);
    if (!household || household.status !== 'active' || household.storage_root == null) {
      console.error('mcp-key: household_unavailable');
      return 1;
    }
    const auth = createAuthStore(platform);
    // A key's creator must be an active member of the key's household.
    const creatorActive = async (userId, hh) => (await auth.membership(userId, hh))?.status === 'active';
    const user = await auth.findUser(email);
    if (!user || !await creatorActive(user.id, householdId)) {
      console.error('mcp-key: unknown owner');
      return 1;
    }
    const dup = await platform.prepare('SELECT id FROM api_keys WHERE household_id = ? AND name = ? AND revoked_at IS NULL').get(householdId, name.trim());
    if (dup) {
      console.error('mcp-key: active key name already exists');
      return 1;
    }
    const secrets = createInstanceSecrets({ config, mode });
    const keys = createKeyService({ platform, secret: () => secrets.mcpSecret(), creatorActive });
    let key;
    try {
      ({ key } = await keys.create({ householdId, name, scopes: ['read'], userId: user.id }));
    } catch (e) {
      if (e instanceof KeyError && e.code === 'unavailable') {
        console.error('mcp-key: mcp_secret_unavailable');
        return 1;
      }
      throw e;
    }
    process.stdout.write(`${key}\n`);
    return 0;
  } catch (err) {
    console.error(`mcp-key: ${err instanceof KeyError ? err.message : 'failed'}`);
    return 1;
  } finally {
    await platform?.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main();
}
