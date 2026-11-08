import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { householdArg } from '../src/platform/cli.mjs';
import { openInstance } from '../src/platform/ready.mjs';
import { backupHousehold } from '../src/platform/household-backup.mjs';
import { codeError } from '../src/platform/db.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { householdId, rest } = householdArg(argv);
  if (rest.length) throw codeError('backup_arguments_invalid');
  const config = loadConfig(env);
  const opened = openInstance(config);
  if (!opened) throw codeError('household_unavailable');
  try {
    const result = await backupHousehold({ platform: opened.platform, config, householdId });
    const { file, ...status } = result;
    console.log(JSON.stringify(status));
  } finally { opened.platform.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(/^[a-z_]+$/.test(err?.code) ? err.code : 'backup_failed'); process.exitCode = 1; });
}
