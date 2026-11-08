// node scripts/category-coverage.mjs --household <id>: category coverage counts of one household of
// the instance in $FATHOM_DATA, as one JSON line. A refusal prints a fixed code.
import { loadConfig } from '../src/config.mjs';
import { openCliHousehold } from '../src/platform/cli.mjs';
import { categoryCoverage } from '../src/categories/store.mjs';

let cli;
try {
  cli = await openCliHousehold(loadConfig(), process.argv.slice(2));
  if (cli.argv.length) {
    console.error('Usage: node scripts/category-coverage.mjs --household <id>');
    process.exitCode = 2;
  } else console.log(JSON.stringify(await categoryCoverage(cli.household.db)));
} catch (error) {
  console.error(typeof error?.code === 'string' && /^[a-z_]{1,64}$/.test(error.code) ? error.code : 'category_coverage_failed');
  process.exitCode = 1;
} finally {
  await cli?.close();
}
