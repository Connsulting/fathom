// Store-opening CLIs select their household explicitly: there is no default household.
//
// openCliHousehold(config, argv) -> { household, platform, mode, argv, close() }
// argv must carry `--household <id>` (else codeError household_required). The instance opens
// through openInstance (its StartupError codes pass through; an empty data directory is
// household_unavailable), and the household must be active with a storage root (else
// household_unavailable). In live engine mode every household's pre-MT-05 spend is carried first
// (carryAllHouseholds; an unreadable store refuses household_store_unavailable). household is that household's runtime context, built like the server's
// but with its scheduler not started; argv is the remaining arguments. close() stops the
// household's scheduler and closes its store and the platform.

import { codeError } from './db.mjs';
import { openInstance } from './ready.mjs';
import { createInstanceSecrets } from './secrets.mjs';
import { buildHouseholdContext } from './runtime.mjs';
import { carryAllHouseholds } from './model-carry.mjs';

// The household id after --household and the arguments without that pair.
export function householdArg(argv) {
  const i = argv.indexOf('--household');
  const id = i >= 0 ? argv[i + 1] : undefined;
  if (typeof id !== 'string' || !id || id.startsWith('--')) throw codeError('household_required');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || argv.indexOf('--household', i + 1) >= 0) throw codeError('household_invalid');
  return { householdId: id, rest: [...argv.slice(0, i), ...argv.slice(i + 2)] };
}

export async function openCliHousehold(config, argv) {
  const { householdId, rest } = householdArg(argv);
  const opened = await openInstance(config);
  if (!opened) throw codeError('household_unavailable');
  const { platform, mode } = opened;
  let household;
  try {
    const row = await platform.prepare('SELECT status, mode, storage_root, generation FROM households WHERE id = ?').get(householdId);
    if (!row || row.status !== 'active' || row.storage_root == null) throw codeError('household_unavailable');
    // A live CLI may be the first process to open the instance after the upgrade: every
    // household's pre-MT-05 spend is carried before this household can be admitted.
    if (config.engine === 'live') await carryAllHouseholds(platform, { dataDir: config.dataDir });
    household = await buildHouseholdContext({
      householdId, generation: Number(row.generation), mode: row.mode, relativeRoot: row.storage_root, platform, config,
      secrets: createInstanceSecrets({ config, mode }),
    });
  } catch (e) {
    try { await platform.close(); } catch { /* already closed */ }
    throw e;
  }
  let closing = null;
  return {
    household, platform, mode, argv: rest,
    async close() {
      closing ??= household.close().finally(async () => {
        try { await platform.close(); } catch { /* already closed */ }
      });
      return closing;
    },
  };
}
