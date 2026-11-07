import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validatePublicUrl } from '../src/config.mjs';
import { DB_FILE, readStoreMode, openMigrated } from '../src/store/db.mjs';
import { createAuthStore, normalizeEmail } from '../src/auth/store.mjs';
import { authLinkMail } from '../src/auth/mail.mjs';
import { createTransport } from '../src/email/transport.mjs';

const quiet = { info() {}, log() {}, warn() {}, error() {} };

export async function main(argv = process.argv.slice(2), env = process.env) {
  let db;
  let store;
  let issued;
  try {
    if (argv.length !== 2 || argv[1] !== '--admin') throw new Error();
    const email = normalizeEmail(argv[0]);
    const config = loadConfig(env);
    validatePublicUrl(config.publicUrl, { required: true });
    const file = join(config.dataDir, DB_FILE);
    if (config.demo === true || readStoreMode(file) !== 'real') throw new Error();
    db = openMigrated(file);
    store = createAuthStore(db);
    store.sweep();
    db.exec('BEGIN IMMEDIATE');
    try {
      if (store.listUsers().some(user => user.enrolledAt !== null)) throw new Error();
      const user = store.inviteUser(email, { role: 'admin' });
      if (user.role !== 'admin') throw new Error();
      issued = { user, ...store.createToken(user.id, 'invite') };
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    const { link, message } = authLinkMail(config, issued.user, issued.token, 'invite');
    const transport = createTransport(config, { log: quiet });
    await transport.send(message);
    console.log(link);
    return 0;
  } catch {
    if (issued) {
      try { store.revokeToken(issued.token); } catch { /* Store may be unavailable. */ }
    }
    console.error('user invite: bootstrap failed');
    return 1;
  } finally {
    db?.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await main();
