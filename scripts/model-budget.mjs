// `node scripts/model-budget.mjs --instance-cap-usd <n>` / `--household <id> --allocation-usd <n>`:
// set the instance's monthly model cap or a household's monthly allocation at the OS boundary
// (src/platform/model-budget.mjs setInstanceCap / setAllocation). Values are dollars from 0 to
// 10000, rounded to cents. A change is audited (model.instance_cap / model.allocation); an
// unchanged value writes nothing. Refuses an allocation above the instance cap and any reduction
// below the current month's committed spend (settled cost plus outstanding reservations). Before
// any change it records every non-deleted household's carry row for the funding month
// (carryAllHouseholds, src/platform/model-carry.mjs), reading that household's pre-MT-05 spend
// (spend_ledger rows with no round_id) from its store, opened read-only after the household-root
// containment check; so a household that never reserved, active or suspended, still counts. A
// store that cannot be read refuses household_store_unavailable. Never
// changes pause flags or reconciles a round. Writes only platform.sqlite. Prints one fixed line:
// `model-budget: set|unchanged` (exit 0) or `model-budget: <code>` on stderr (exit 1).

import { resolve } from 'node:path';
import { openOperatorPlatform } from '../src/platform/ready.mjs';
import { parseUsd, setAllocation, setInstanceCap } from '../src/platform/model-budget.mjs';
import { carryAllHouseholds } from '../src/platform/model-carry.mjs';

const fail = code => Object.assign(new Error(code), { code });
const codeOf = e => (e && typeof e.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(e.code) ? e.code : 'model_budget_failed');

async function main(argv, env = process.env) {
  let apply;
  if (argv.length === 2 && argv[0] === '--instance-cap-usd') {
    const usd = parseUsd(argv[1]);
    apply = async (platform, now) => await setInstanceCap(platform, usd, { now });
  } else if (argv.length === 4 && argv[0] === '--household' && argv[2] === '--allocation-usd' && argv[1] && !argv[1].startsWith('--')) {
    const usd = parseUsd(argv[3]);
    apply = async (platform, now) => await setAllocation(platform, argv[1], usd, { now });
  } else throw fail('usage');
  const platform = await openOperatorPlatform(env);
  try {
    const now = Date.now();
    await carryAllHouseholds(platform, { dataDir: resolve(env.FATHOM_DATA == null || env.FATHOM_DATA === '' ? 'data' : env.FATHOM_DATA), now });
    return (await apply(platform, now)).changed ? "set" : "unchanged";
  } finally {
    await platform.close();
  }
}

try {
  console.log(`model-budget: ${await main(process.argv.slice(2))}`);
} catch (e) {
  console.error(`model-budget: ${codeOf(e)}`);
  process.exitCode = 1;
}
