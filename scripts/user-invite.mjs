// node scripts/user-invite.mjs <email> --admin: bootstrap the first admin of the instance's
// original household (households.serves_store). Real instances only, opened through openInstance
// (an unmigrated layout refuses with its readiness code); touches only platform.sqlite. Refuses once
// any member of that household has enrolled. Prints the enrollment link only after the email is
// sent (auth mail: the instance transport, dev outbox <dataDir>/outbox); a failed send revokes it.
// Errors print a fixed line (or a readiness code), never the address or the link.

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validatePublicUrl } from '../src/config.mjs';
import { openInstance } from '../src/platform/ready.mjs';
import { servedHousehold } from '../src/platform/db.mjs';
import { createAuthStore, normalizeEmail } from '../src/auth/store.mjs';
import { authLinkMail } from '../src/auth/mail.mjs';
import { createTransport } from '../src/email/transport.mjs';

const quiet = { info() {}, log() {}, warn() {}, error() {} };

export async function main(argv = process.argv.slice(2), env = process.env) {
  let opened;
  let store;
  let issued;
  try {
    if (argv.length !== 2 || argv[1] !== '--admin') throw new Error();
    const email = normalizeEmail(argv[0]);
    const config = loadConfig(env);
    validatePublicUrl(config.publicUrl, { required: true });
    if (config.demo === true) throw new Error();
    opened = await openInstance(config);
    if (!opened || opened.mode !== 'real') throw new Error();
    store = createAuthStore(opened.platform);
    store.sweep();
    const household = await servedHousehold(opened.platform);
    if (!household || household.status === 'deleted') throw new Error();
    issued = await store.transaction(async (store) => {
      const hh = household.id;
      const enrolled = (await store.listPeople(hh)).some(person => person.enrolledAt !== null && store.membership(person.id, hh)?.status === 'active');
      if (enrolled) throw new Error();
      return store.invite(hh, email, { role: 'admin' });
    });
    const { link, message } = authLinkMail(config, issued.user, issued.token, 'invite');
    const transport = createTransport(config, { outboxDir: join(config.dataDir, 'outbox'), log: quiet });
    await transport.send(message);
    console.log(link);
    return 0;
  } catch (err) {
    if (issued) {
      try { await store.revokeInvitation(issued.token); } catch { /* Store may be unavailable. */ }
    }
    console.error(`user invite: ${err?.name === 'StartupError' ? err.code : 'bootstrap failed'}`);
    return 1;
  } finally {
    await opened?.platform.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await main();
