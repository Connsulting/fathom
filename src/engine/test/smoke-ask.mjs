// Shared Ask smoke: seed a temp demo instance, ask one question in a new Ask thread through the live
// answerer over the runtime engine in the given mode, and report what a caller needs to judge the
// run. Used by the fake-mode shape test (test/live-smoke-shape.test.mjs) and the opt-in live test
// (live.test.mjs).
//
// runAskSmoke({ mode, credentialFile }) -> { groundingOk, spendRows, provenance, notice, paragraphs }
// spendRows are the spend_ledger rows the ask added ({ purpose, model, yyyymm, costUsd }).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../config.mjs';
import { seedDemo } from '../../../demo/seed.mjs';
import { createInstance } from '../../platform/db.mjs';
import { createInstanceSecrets } from '../../platform/secrets.mjs';
import { setAllocation } from '../../platform/model-budget.mjs';
import { createHouseholdContext, FUNDING_SETTING } from '../../platform/runtime.mjs';
import { createAuthStore } from '../../auth/store.mjs';
import { createThread } from '../../api/threads.mjs';
import { clockNow } from '../../scenario/build.mjs';

export const SMOKE_QUESTION = 'How many of my recommendations need me right now?';

// The demo instance is a disposable one in a temp directory; its household context (engine, packs,
// answerer) is built the way the server builds it (src/platform/runtime.mjs). Live mode needs the
// instance funding authority and a household allocation, seeded here only in this disposable platform DB.
export async function runAskSmoke({ mode = 'fake', credentialFile = null } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'fathom-smoke-'));
  const env = { FATHOM_DATA: dataDir, FATHOM_ENGINE: mode };
  if (credentialFile) env.FATHOM_CLAUDE_CREDENTIAL_FILE = credentialFile;
  const config = loadConfig(env);
  const secrets = createInstanceSecrets({ config, mode: 'demo' });
  const platformKey = secrets.platformKey();
  let made;
  try {
    made = createInstance(dataDir, { mode: 'demo', init: seedDemo, platformKey });
  } finally {
    platformKey.fill(0);
  }
  const { db, platform, householdId } = made;
  let household = null;
  try {
    createAuthStore(platform).setPlatformSetting(FUNDING_SETTING, 25);
    setAllocation(platform, householdId, 25);
    household = createHouseholdContext({ householdId, mode: 'demo', db, config, platform, secrets });
    const lastId = db.prepare('SELECT coalesce(max(id), 0) AS id FROM spend_ledger').get().id;
    const { key } = createThread(db, clockNow(db));
    const reply = await household.answerer.answer({ db, key, text: SMOKE_QUESTION });
    const spendRows = db.prepare('SELECT purpose, model, yyyymm, cost_usd FROM spend_ledger WHERE id > ? ORDER BY id').all(lastId)
      .map(r => ({ purpose: r.purpose, model: r.model, yyyymm: r.yyyymm, costUsd: r.cost_usd }));
    return {
      groundingOk: !reply.notice && reply.provenance?.grounding?.ok === true,
      spendRows,
      provenance: reply.provenance ?? null,
      notice: !!reply.notice,
      paragraphs: reply.paragraphs,
    };
  } finally {
    if (household) await household.close();
    else db.close();
    platform.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
