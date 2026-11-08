// node scripts/merge-accounts.mjs --household <id> [--apply-sure]: list (and with --apply-sure,
// answer) the account merge pairs of one real household. Prints counts only; a refusal prints a
// fixed code (household_required, household_unavailable or a readiness code) or a fixed line.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { openCliHousehold } from '../src/platform/cli.mjs';
import { detectAccountPairs, queueAccountPairs, backfillMergedIdentity } from '../src/ingest/account-merge.mjs';
import { answerItem } from '../src/ingest/confirm.mjs';
import { createScheduler, defaultHandlers } from '../src/jobs/scheduler.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  let cli, scheduler;
  try {
    const config = loadConfig(env);
    if (config.demo === true) throw new Error();
    try {
      cli = await openCliHousehold(config, argv);
    } catch (e) {
      if (typeof e?.code !== 'string') throw e;
      console.error(`merge-accounts: ${e.code}`);
      return 1;
    }
    const rest = cli.argv;
    if (rest.length > 1 || (rest.length && rest[0] !== '--apply-sure')) throw new Error();
    const apply = rest[0] === '--apply-sure';
    const { household } = cli;
    if (household.mode !== 'real') throw new Error();
    const db = household.db;
    const pairs = await detectAccountPairs(db);
    const counts = { pairs:pairs.length, sure:pairs.filter(p=>p.confidence==='sure').length, likely:pairs.filter(p=>p.confidence==='likely').length, merged:0 };
    if (apply) {
      await queueAccountPairs(db);
      for (const p of pairs.filter(p=>p.confidence==='sure')) {
        const current = (await detectAccountPairs(db)).find(x=>x.candidateId===p.candidateId && x.ownId===p.ownId && x.confidence==='sure');
        if (!current) continue;
        const q = await db.prepare("SELECT id FROM confirm_items WHERE kind='account_match' AND subject=? AND status='pending'").get(`merge:${p.candidateId}:${p.ownId}`);
        if (!q) continue;
        await answerItem(db,q.id,'same');
        counts.merged += 1;
      }
      // Older merges left survivors without the institution or last 4 a merge now carries over.
      await backfillMergedIdentity(db);
      if (counts.merged) {
        scheduler = createScheduler({db,config,engine:null,handlers:defaultHandlers(),log:{log(){}},
          allowed:()=>household.outbound.enabled('jobs'),household:()=>household});
        const run = await scheduler.trigger('plan','confirm');
        if (!run || run.status !== 'ok') throw new Error();
      }
    }
    console.log(JSON.stringify(counts));
    return 0;
  } catch {
    console.error('account merge: operation failed');
    return 1;
  } finally {
    await scheduler?.stop();
    await cli?.close();
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await main();
