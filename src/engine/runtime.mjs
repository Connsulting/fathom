// The server's engine: createEngine over the spend_ledger table, gated by the store's settings.
// Before every call it re-reads settings.engine.on (false throws EngineOffError) and settings.cap.usd
// (default 200), rebuilding the inner engine when the cap changes. Once any call throws
// ModelAccountingError the runtime refuses every further call. The live credential is read once
// exactly once, by init() at startup, from config.claudeCredentialFile. credentialState is 'loaded',
// 'failed' or 'none' (fake and off modes never read it). After a failure every live call rejects
// with ModelCallError('engine credential unavailable') and the file is never read again.

import { getSetting } from '../store/db.mjs';
import { createEngine, loadCredential, EngineOffError, ModelAccountingError, ModelCallError } from './index.mjs';

export const DEFAULT_CAP_USD = 200;
const MONTH = /^(\d{4})-?(\d{2})$/;

function monthOf(yyyymm) {
  const m = MONTH.exec(String(yyyymm));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new TypeError('Invalid ledger month');
  return `${m[1]}-${m[2]}`;
}

// Ledger adapter over spend_ledger (yyyymm stored as 'YYYY-MM').
export function createSpendLedger(db) {
  const sum = db.prepare('SELECT coalesce(sum(cost_usd), 0) AS s FROM spend_ledger WHERE yyyymm = ?');
  const insert = db.prepare('INSERT INTO spend_ledger (ts, yyyymm, purpose, cost_usd, model, tokens) VALUES (?, ?, ?, ?, ?, ?)');
  return {
    monthSpendUsd(yyyymm) {
      return Number(Number(sum.get(monthOf(yyyymm)).s).toFixed(12));
    },
    record({ ts, purpose, costUsd, model, tokens } = {}) {
      if (!Number.isFinite(costUsd) || costUsd < 0) throw new TypeError('Invalid ledger cost');
      const iso = new Date(ts).toISOString();
      insert.run(iso, iso.slice(0, 7), String(purpose), costUsd, model == null ? null : String(model), JSON.stringify(tokens ?? {}));
    },
  };
}

// A missing cap is the default; a malformed one is treated as zero so it never raises spending.
function capOf(db) {
  const cap = getSetting(db, 'cap', { usd: DEFAULT_CAP_USD });
  const usd = cap && typeof cap === 'object' ? cap.usd : undefined;
  if (usd === undefined) return DEFAULT_CAP_USD;
  return Number.isFinite(usd) && usd >= 0 ? usd : 0;
}

const settingOn = (db) => getSetting(db, 'engine', { on: true })?.on !== false;

export function createRuntimeEngine({ db, config = {}, now } = {}) {
  if (!db) throw new TypeError('A store is required');
  const mode = config.engine ?? 'off';
  if (!['live', 'fake', 'off'].includes(mode)) throw new TypeError('Invalid engine mode');
  const ledger = createSpendLedger(db);
  let inner = null;
  let innerCap = null;
  let refused = false;
  let auth = null;
  let initPromise = null;
  const state = { credentialState: 'none' };

  // Idempotent: the credential is read on the first call only, never retried.
  function init() {
    initPromise ??= (async () => {
      if (mode !== 'live') return;
      try {
        auth = await loadCredential(config.claudeCredentialFile);
        state.credentialState = 'loaded';
      } catch {
        state.credentialState = 'failed';
      }
    })();
    return initPromise;
  }

  async function engine() {
    if (refused) throw new ModelAccountingError();
    if (!settingOn(db)) throw new EngineOffError();
    const cap = capOf(db);
    await init();
    if (state.credentialState === 'failed') throw new ModelCallError('engine credential unavailable');
    if (!inner || cap !== innerCap) {
      inner = createEngine({ mode, ledger, capUsd: cap, credential: auth ?? undefined, ...(now ? { now } : {}) });
      innerCap = cap;
    }
    return inner;
  }

  async function guarded(fn) {
    try {
      return await fn(await engine());
    } catch (error) {
      if (error instanceof ModelAccountingError) refused = true;
      throw error;
    }
  }

  return {
    mode,
    init,
    get credentialState() { return state.credentialState; },
    isOn: () => mode !== 'off' && !refused && settingOn(db),
    call: (req) => guarded((e) => e.call(req)),
    extract: (req) => guarded((e) => e.extract(req)),
  };
}
