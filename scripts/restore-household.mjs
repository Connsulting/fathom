import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { householdArg } from '../src/platform/cli.mjs';
import { openInstance } from '../src/platform/ready.mjs';
import { restoreHousehold } from '../src/platform/household-backup.mjs';
import { codeError } from '../src/platform/db.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { householdId, rest } = householdArg(argv);
  const args = new Map();
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--bundle', '--confirm'].includes(rest[i]) || !rest[i + 1] || args.has(rest[i])) throw codeError('restore_arguments_invalid');
    args.set(rest[i], rest[i + 1]);
  }
  if (!args.has('--bundle') || args.get('--confirm') !== householdId) throw codeError('restore_confirmation_required');
  const config = loadConfig(env);
  const opened = openInstance(config);
  if (!opened) throw codeError('household_unavailable');
  try {
    const result = await restoreHousehold({ platform: opened.platform, config, householdId, confirmation: args.get('--confirm'), file: args.get('--bundle') });
    console.log(JSON.stringify(result));
  } finally { opened.platform.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(/^[a-z_]+$/.test(err?.code) ? err.code : 'restore_failed'); process.exitCode = 1; });
}
