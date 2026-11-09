// npm run build:your-plans -- --household <id> [--file <id> ...]
// Builds the private Your plans pack of one household (--household, required) from the plan and
// benefits documents in its store (plus any extra files named with --file), through that
// household's engine (FATHOM_ENGINE selects the mode). Uploads are read through the household vault
// (FATHOM_PLATFORM_KEY_FILE on a real instance). Refuses when the household is missing or not
// served, or its vault is unavailable. Prints counts only (entries, sources, sections dropped
// because they did not match the document, warnings), never document text. A written pack
// refreshes the household's pack rows here; a running server loads its manifest on its next
// request (settings packs.generation changes). The store opens only through openCliHousehold.

import { loadConfig } from '../src/config.mjs';
import { openCliHousehold } from '../src/platform/cli.mjs';
import { buildYourPlans, YourPlansRefusal } from '../src/packs/your-plans.mjs';
import { VaultError } from '../src/ingest/vault.mjs';
import { refreshLivePacks } from '../src/packs/live.mjs';
import { EngineOffError, BudgetExceededError } from '../src/engine/index.mjs';

const NAME = 'build:your-plans';

function fail(message) {
  console.error(`${NAME}: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const fileIds = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file' && typeof argv[i + 1] === 'string' && argv[i + 1]) fileIds.push(argv[++i]);
    else fail(`unknown argument ${JSON.stringify(argv[i])}; usage: npm run ${NAME} -- --household <id> [--file <id>]...`);
  }
  return fileIds;
}

async function main() {
  let config;
  try { config = loadConfig(); } catch (e) { fail(e.message); }
  let cli;
  try {
    cli = await openCliHousehold(config, process.argv.slice(2));
  } catch (e) {
    fail(e && typeof e.code === 'string' ? e.code : 'the household could not be opened');
  }
  const { household } = cli;
  const fileIds = parseArgs(cli.argv);
  try {
    const result = await buildYourPlans({ db: household.db, engine: household.engine, household, fileIds, clock: config.clock || undefined });
    if (result.written) await refreshLivePacks(household.db, { dataDir: household.root });
    const counts = `${result.entries} entries from ${result.sources.length} sources, ${result.dropped} sections dropped, ${result.warnings.length} warnings`;
    console.log(`${NAME}: ${result.written ? 'built the Your plans pack' : 'nothing to write'}: ${counts}`);
  } catch (e) {
    if (e instanceof YourPlansRefusal || e instanceof VaultError) fail(e.message);
    if (e instanceof EngineOffError) fail('the engine is off; switch it on or set FATHOM_ENGINE.');
    if (e instanceof BudgetExceededError) fail("this month's engine budget is used up; raise the cap first.");
    fail(`the build failed (${e && e.name ? e.name : 'error'}).`);
  } finally {
    await cli.close();
  }
}

await main();
