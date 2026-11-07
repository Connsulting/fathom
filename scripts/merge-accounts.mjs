import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { DB_FILE, readStoreMode } from '../src/store/db.mjs';
import { openServedStore } from '../src/platform/ready.mjs';
import { detectAccountPairs, queueAccountPairs } from '../src/ingest/account-merge.mjs';
import { answerItem } from '../src/ingest/confirm.mjs';
import { createScheduler, defaultHandlers } from '../src/jobs/scheduler.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  let db, platform, scheduler;
  try {
    if (argv.length > 1 || (argv.length && argv[0] !== '--apply-sure')) throw new Error();
    const apply = argv[0] === '--apply-sure';
    const config = loadConfig(env);
    const file = join(config.dataDir, DB_FILE);
    if (config.demo === true || readStoreMode(file) !== 'real') throw new Error();
    // A real store opens only through openServedStore, which also brings it to the latest schema.
    try {
      ({ db, platform } = openServedStore(config));
    } catch (e) {
      if (e.name !== 'StartupError') throw e;
      console.error(`merge-accounts: ${e.code}`);
      return 1;
    }
    const pairs = detectAccountPairs(db);
    const counts = { pairs:pairs.length, sure:pairs.filter(p=>p.confidence==='sure').length, likely:pairs.filter(p=>p.confidence==='likely').length, merged:0 };
    if (apply) {
      queueAccountPairs(db);
      for (const p of pairs.filter(p=>p.confidence==='sure')) {
        const current = detectAccountPairs(db).find(x=>x.candidateId===p.candidateId && x.ownId===p.ownId && x.confidence==='sure');
        if (!current) continue;
        const q = db.prepare("SELECT id FROM confirm_items WHERE kind='account_match' AND subject=? AND status='pending'").get(`merge:${p.candidateId}:${p.ownId}`);
        if (!q) continue;
        answerItem(db,q.id,'same');
        counts.merged += 1;
      }
      if (counts.merged) {
        scheduler = createScheduler({db,config,engine:null,handlers:defaultHandlers(),log:{log(){}}});
        const run = await scheduler.trigger('plan','confirm');
        if (run.status !== 'ok') throw new Error();
      }
    }
    console.log(JSON.stringify(counts));
    return 0;
  } catch {
    console.error('account merge: operation failed');
    return 1;
  } finally {
    await scheduler?.stop();
    db?.close();
    platform?.close();
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await main();
