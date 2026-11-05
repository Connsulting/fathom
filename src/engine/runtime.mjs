// Runtime engine seam: the gateway engine (src/engine createEngine) over the store's spend_ledger.
// Before every call it honors settings.engine.on and re-reads the monthly cap (settings.cap.usd,
// 200 when unusable). Live mode reads the credential file once at construction; a failed read
// makes calls throw ModelCallError without ever naming the file or the secret.
//
// createRuntimeEngine({db, config, responses}) -> {mode, call(args), extract(args)}

import { getSetting } from '../store/db.mjs';
import { createEngine, loadCredential, EngineOffError, ModelCallError } from './index.mjs';

const DEFAULT_CAP = 200;

// Gateway month keys are 'YYYYMM'; the table stores 'YYYY-MM'.
export function createStoreLedger(db) {
  return {
    monthSpendUsd(month) {
      const m = /^(\d{4})-?(\d{2})$/.exec(String(month));
      if (!m) return 0;
      const row = db.prepare('SELECT coalesce(sum(cost_usd), 0) AS s FROM spend_ledger WHERE yyyymm = ?').get(`${m[1]}-${m[2]}`);
      return Number(row.s);
    },
    record({ ts, purpose, costUsd, model, tokens }) {
      const stamp = new Date(ts).toISOString();
      db.prepare('INSERT INTO spend_ledger (ts, yyyymm, purpose, cost_usd, model, tokens) VALUES (?, ?, ?, ?, ?, ?)')
        .run(stamp, stamp.slice(0, 7), purpose, costUsd, model ?? null, JSON.stringify(tokens ?? {}));
    },
  };
}

function capOf(db) {
  const cap = getSetting(db, 'cap', { usd: DEFAULT_CAP });
  const usd = cap && cap.usd;
  return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : DEFAULT_CAP;
}

export function createRuntimeEngine({ db, config = {}, responses = [] }) {
  const mode = config.engine || 'off';
  const ledger = createStoreLedger(db);
  const credential = mode === 'live'
    ? loadCredential(config.claudeCredentialFile || '').catch(() => null)
    : Promise.resolve(undefined);
  const engines = new Map();

  async function inner() {
    const setting = getSetting(db, 'engine', { on: true });
    if (setting && setting.on === false) throw new EngineOffError();
    const cred = await credential;
    if (mode === 'live' && !cred) throw new ModelCallError('Claude credential unavailable');
    const cap = capOf(db);
    if (!engines.has(cap)) engines.set(cap, createEngine({ mode, ledger, capUsd: cap, credential: cred, responses }));
    return engines.get(cap);
  }

  return {
    mode,
    async call(args) { return (await inner()).call(args); },
    async extract(args) { return (await inner()).extract(args); },
  };
}
