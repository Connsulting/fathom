// Opt-in test delivery for one explicitly selected household. The household transport checks
// its outbound flag and verified recipients and writes dev mail only to its private outbox.

import { loadConfig, ConfigError } from '../src/config.mjs';
import { openCliHousehold } from '../src/platform/cli.mjs';
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
  let cli;
  try {
    cli = await openCliHousehold(config, process.argv.slice(2));
    if (cli.argv.length) throw Object.assign(new Error(), { code: 'invalid_arguments' });
    const transport = cli.household.transport;
    const r = await transport.send({ subject: 'Fathom test email', text: TEXT, html: HTML });
    console.log(`email test: sent via ${transport.name} to ${r.recipients} recipient(s)`);
    return 0;
  } catch (err) {
    const code = typeof err?.code === 'string' && /^[a-z_]+$/.test(err.code) ? err.code : 'other';
    console.error(`email test: failed ${code}`);
    return 1;
  } finally {
    await cli?.close();
  }
}

process.exitCode = await main().catch(() => {
  console.error('email test: failed other');
  return 1;
});
