// `node scripts/model-budget.mjs --instance-cap-usd <n>` / `--household <id> --allocation-usd <n>`:
// set the instance's monthly model cap or a household's monthly allocation at the OS boundary
// (src/platform/model-budget.mjs setInstanceCap / setAllocation). Values are dollars from 0 to
// 10000, rounded to cents. A change is audited (model.instance_cap / model.allocation); an
// unchanged value writes nothing. Refuses an allocation above the instance cap and any reduction
// below the current month's committed spend (settled cost plus outstanding reservations). Never
// changes pause flags or reconciles a round. Touches only platform.sqlite. Prints one fixed line:
// `model-budget: set|unchanged` (exit 0) or `model-budget: <code>` on stderr (exit 1).

import { openOperatorPlatform } from '../src/platform/ready.mjs';
import { parseUsd, setAllocation, setInstanceCap } from '../src/platform/model-budget.mjs';

const fail = code => Object.assign(new Error(code), { code });
const codeOf = e => (e && typeof e.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(e.code) ? e.code : 'model_budget_failed');

function main(argv) {
  let apply;
  if (argv.length === 2 && argv[0] === '--instance-cap-usd') {
    const usd = parseUsd(argv[1]);
    apply = platform => setInstanceCap(platform, usd);
  } else if (argv.length === 4 && argv[0] === '--household' && argv[2] === '--allocation-usd' && argv[1] && !argv[1].startsWith('--')) {
    const usd = parseUsd(argv[3]);
    apply = platform => setAllocation(platform, argv[1], usd);
  } else throw fail('usage');
  const platform = openOperatorPlatform();
  try {
    return apply(platform).changed ? 'set' : 'unchanged';
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
