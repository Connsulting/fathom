// `node scripts/model-budget.mjs --instance-cap-usd <n>` / `--household <id> --allocation-usd <n>`:
// set the instance's monthly model cap or a household's monthly allocation at the OS boundary
// (src/platform/model-budget.mjs setInstanceCap / setAllocation). Values are dollars from 0 to
// 10000, rounded to cents. A change is audited (model.instance_cap / model.allocation); an
// unchanged value writes nothing. Refuses an allocation above the instance cap and any reduction
// below the current month's committed spend (settled cost plus outstanding reservations). Before
// any change it records every active household's carry row for the funding month (ensureCarry),
// reading that household's pre-MT-05 spend (spend_ledger rows with no round_id) from its store,
// opened read-only after the household-root containment check; so a household that never
// reserved still counts. A store that cannot be read refuses household_store_unavailable. Never
// changes pause flags or reconciles a round. Writes only platform.sqlite. Prints one fixed line:
// `model-budget: set|unchanged` (exit 0) or `model-budget: <code>` on stderr (exit 1).

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openOperatorPlatform } from '../src/platform/ready.mjs';
import { checkHouseholdRoot } from '../src/platform/runtime.mjs';
import { storeIdentity } from '../src/platform/db.mjs';
import { DB_FILE } from '../src/store/db.mjs';
import { ensureCarry, fundingMonth, parseUsd, setAllocation, setInstanceCap } from '../src/platform/model-budget.mjs';

const fail = code => Object.assign(new Error(code), { code });
const codeOf = e => (e && typeof e.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(e.code) ? e.code : 'model_budget_failed');

// The month's pre-MT-05 spend in a household store, opened read-only (never migrated or written).
function legacySpendUsd(dataDir, householdId, storageRoot, month) {
  const file = join(checkHouseholdRoot(dataDir, storageRoot), DB_FILE);
  if (!existsSync(file)) throw fail('household_store_unavailable');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA query_only = ON');
    if (storeIdentity(db)?.householdId !== householdId) throw fail('household_store_unavailable');
    // A store not yet migrated to round_id holds only pre-MT-05 rows.
    const mirrored = db.prepare('PRAGMA table_info(spend_ledger)').all().some(c => c.name === 'round_id');
    const s = Number(db.prepare(`SELECT coalesce(sum(cost_usd), 0) AS s FROM spend_ledger WHERE yyyymm = ?${mirrored ? ' AND round_id IS NULL' : ''}`)
      .get(month).s);
    if (!Number.isFinite(s) || s < 0) throw fail('household_store_unavailable');
    return s;
  } finally {
    db.close();
  }
}

function carryAll(platform, dataDir, now) {
  const month = fundingMonth(now);
  const rows = platform.prepare("SELECT id, storage_root FROM households WHERE status = 'active' AND storage_root IS NOT NULL ORDER BY created_at, id").all();
  for (const { id, storage_root: storageRoot } of rows) {
    let legacy;
    try {
      legacy = legacySpendUsd(dataDir, id, storageRoot, month);
    } catch {
      throw fail('household_store_unavailable');
    }
    if (legacy > 0) ensureCarry(platform, { householdId: id, month, legacySpendUsd: legacy, now });
  }
}

function main(argv, env = process.env) {
  let apply;
  if (argv.length === 2 && argv[0] === '--instance-cap-usd') {
    const usd = parseUsd(argv[1]);
    apply = (platform, now) => setInstanceCap(platform, usd, { now });
  } else if (argv.length === 4 && argv[0] === '--household' && argv[2] === '--allocation-usd' && argv[1] && !argv[1].startsWith('--')) {
    const usd = parseUsd(argv[3]);
    apply = (platform, now) => setAllocation(platform, argv[1], usd, { now });
  } else throw fail('usage');
  const platform = openOperatorPlatform(env);
  try {
    const now = Date.now();
    carryAll(platform, resolve(env.FATHOM_DATA == null || env.FATHOM_DATA === '' ? 'data' : env.FATHOM_DATA), now);
    return apply(platform, now).changed ? 'set' : 'unchanged';
  } finally {
    platform.close();
  }
}

try {
  console.log(`model-budget: ${main(process.argv.slice(2))}`);
} catch (e) {
  console.error(`model-budget: ${codeOf(e)}`);
  process.exitCode = 1;
}
