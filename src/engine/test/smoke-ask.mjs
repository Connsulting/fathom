// Shared Ask smoke: seed a temp demo store, ask one question through the live answerer over the
// runtime engine in the given mode, and report what a caller needs to judge the run. Used by the
// fake-mode shape test (test/live-smoke-shape.test.mjs) and the opt-in live test (live.test.mjs).
//
// runAskSmoke({ mode, credentialFile }) -> { groundingOk, spendRows, provenance, notice, paragraphs }
// spendRows are the spend_ledger rows the ask added ({ purpose, model, yyyymm, costUsd }).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../../store/db.mjs';
import { loadConfig } from '../../config.mjs';
import { seedDemo } from '../../../demo/seed.mjs';
import { createRuntimeEngine } from '../runtime.mjs';
import { createLivePacks } from '../../packs/live.mjs';
import { createLiveAnswerer } from '../../api/answerer.mjs';

export const SMOKE_QUESTION = 'How many of my recommendations need me right now?';

export async function runAskSmoke({ mode = 'fake', credentialFile = null } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'fathom-smoke-'));
  const db = openDb(join(dataDir, 'fathom.sqlite'));
  try {
    migrate(db);
    seedDemo(db);
    const env = { FATHOM_DATA: dataDir, FATHOM_ENGINE: mode };
    if (credentialFile) env.FATHOM_CLAUDE_CREDENTIAL_FILE = credentialFile;
    const engine = createRuntimeEngine({ db, config: loadConfig(env) });
    const packs = createLivePacks(db, { dataDir });
    packs.refresh();
    const lastId = db.prepare('SELECT coalesce(max(id), 0) AS id FROM spend_ledger').get().id;
    const reply = await createLiveAnswerer({ engine, packs }).answer({ db, key: 'ask', text: SMOKE_QUESTION });
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
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
