// Opt-in live email check (`npm run email:test`): with FATHOM_LIVE_EMAIL=1, sends one test email
// through the configured FATHOM_EMAIL_* transport and prints only the status and a fixed code.
// Without it, exits 2 and sends nothing. Touches no store; prints no body, address, key or stack.

import { loadConfig, ConfigError } from '../src/config.mjs';
import { createTransport, EmailError } from '../src/email/transport.mjs';
import { simpleDarkEmail } from '../src/email/palette.mjs';

const TEXT = [
  'This is a test email from Fathom.',
  'It confirms the configured email transport can deliver to the configured recipients.',
  'No household data is included.',
].join('\n');
const HTML = simpleDarkEmail({ title: 'Fathom test email', paragraphs: TEXT.split('\n') });

async function main() {
  if (process.env.FATHOM_LIVE_EMAIL !== '1') {
    console.error('email test: refused; set FATHOM_LIVE_EMAIL=1 to send one real test email');
    return 2;
  }
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`email test: failed config ${err.message}`);
    return 1;
  }
  // Silence the transport's own log line so the output is exactly one status line.
  const log = { info: () => {}, log: () => {}, warn: () => {}, error: () => {} };
  try {
    const transport = createTransport(config, { log });
    const r = await transport.send({ subject: 'Fathom test email', text: TEXT, html: HTML });
    console.log(`email test: sent via ${transport.name} to ${r.recipients} recipient(s)`);
    return 0;
  } catch (err) {
    console.error(`email test: failed ${err instanceof EmailError ? err.code : 'other'}`);
    return 1;
  }
}

process.exitCode = await main().catch(() => {
  console.error('email test: failed other');
  return 1;
});
