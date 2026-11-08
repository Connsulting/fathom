// A household's engine: createEngine over the household store's spend_ledger table, gated by the
// store's settings and the household's outbound flag. Before every call it re-reads
// settings.engine.on and allowed() (either false throws EngineOffError; a paused household behaves
// as engine off in every mode) and settings.cap.usd (default 200), rebuilding the inner engine when
// the cap changes; the inner engine re-checks allowed() and, in live mode, funded() before every
// round. Once any call throws ModelAccountingError the runtime refuses every further call. The live
// credential is read exactly once, by init(), from config.claudeCredentialFile. credentialState is
// 'loaded', 'failed' or 'none' (fake and off modes never read it). After a failure every live call
// rejects with ModelCallError('engine credential unavailable') and the file is never read again.
// isOn() is false when the mode is off, the setting is off, the household is paused, after an
// accounting refusal, or in live mode without instance funding (funded() false).
// status() -> { mode, on, credentialState, funded, capUsd, spentUsd } for this month (the engine
// clock), for the outbound screen.
//
// Live mode needs the platform reservation ledger (MT-05; src/platform/model-budget.mjs):
// { platform, householdId, generation } (else TypeError; there is no unreserved live path), with
// fundingNow() (epoch ms, default Date.now) choosing the actual UTC funding month and
// testTransport passed through to createEngine (programmatic only, tests). Every round reserves
// with adminCapUsd = settings.cap.usd, legacySpendUsd = the funding month's spend_ledger rows with
// no round_id (carried once per month) and the AsyncLocalStorage principal of the request. Before
// each reserve and in status() the household's final platform rounds of the funding month are
// mirrored into spend_ledger by round_id (idempotent). Live status(): capUsd = min(settings cap,
// allocation), spentUsd = the platform committed spend of the funding month; isOn() is also false
// while the household has a held round.

import { getSetting } from '../store/db.mjs';
import { createEngine, loadCredential, EngineOffError, ModelAccountingError, ModelCallError } from './index.mjs';
import { createModelLedger, currentPrincipal, fundingMonth } from '../platform/model-budget.mjs';

export const DEFAULT_CAP_USD = 200;
const MONTH = /^(\d{4})-?(\d{2})$/;

function monthOf(yyyymm) {
  const m = MONTH.exec(String(yyyymm));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new TypeError('Invalid ledger month');
  return `${m[1]}-${m[2]}`;
}

// Ledger adapter over spend_ledger (yyyymm stored as 'YYYY-MM'). A record with a roundId (a live
// platform round's mirror) upserts by it, so mirroring a round twice leaves one row with its cost.
// legacySpendUsd(yyyymm) sums the month's rows with no round_id.
export function createSpendLedger(db) {
  const sum = db.prepare('SELECT coalesce(sum(cost_usd), 0) AS s FROM spend_ledger WHERE yyyymm = ?');
  const legacy = db.prepare('SELECT coalesce(sum(cost_usd), 0) AS s FROM spend_ledger WHERE yyyymm = ? AND round_id IS NULL');
  const insert = db.prepare(`INSERT INTO spend_ledger (ts, yyyymm, purpose, cost_usd, model, tokens, round_id) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(round_id) WHERE round_id IS NOT NULL DO UPDATE SET cost_usd = excluded.cost_usd WHERE spend_ledger.cost_usd <> excluded.cost_usd`);
  return {
    monthSpendUsd(yyyymm) {
      return Number(Number(sum.get(monthOf(yyyymm)).s).toFixed(12));
    },
    legacySpendUsd(yyyymm) {
      return Number(Number(legacy.get(monthOf(yyyymm)).s).toFixed(12));
    },
    record({ ts, purpose, costUsd, model, tokens, roundId = null } = {}) {
      if (!Number.isFinite(costUsd) || costUsd < 0) throw new TypeError('Invalid ledger cost');
      const iso = new Date(ts).toISOString();
      insert.run(iso, iso.slice(0, 7), String(purpose), costUsd, model == null ? null : String(model), JSON.stringify(tokens ?? {}),
        roundId == null ? null : String(roundId));
    },
  };
}

// A platform round's committed cost (see src/platform/model-budget.mjs).
const committedOf = row => (row.state === 'settled' ? row.cost_usd : Math.max(row.reserved_usd, row.cost_usd ?? 0));

// A missing cap is the default; a malformed one is treated as zero so it never raises spending.
function capOf(db) {
  const cap = getSetting(db, 'cap', { usd: DEFAULT_CAP_USD });
  const usd = cap && typeof cap === 'object' ? cap.usd : undefined;
  if (usd === undefined) return DEFAULT_CAP_USD;
  return Number.isFinite(usd) && usd >= 0 ? usd : 0;
}

const settingOn = (db) => getSetting(db, 'engine', { on: true })?.on !== false;

export function createRuntimeEngine({ db, config = {}, now, allowed = () => true, funded = () => false, platform = null, householdId,
  generation = 1, fundingNow = Date.now, testTransport = null } = {}) {
  if (!db) throw new TypeError('A store is required');
  if (typeof allowed !== 'function' || typeof funded !== 'function' || typeof fundingNow !== 'function') throw new TypeError('Invalid engine admission');
  const mode = config.engine ?? 'off';
  if (!['live', 'fake', 'off'].includes(mode)) throw new TypeError('Invalid engine mode');
  if (mode === 'live' && (!platform || typeof householdId !== 'string')) throw new TypeError('A live engine needs the platform reservation ledger');
  const ledger = createSpendLedger(db);
  const platformLedger = mode === 'live' ? createModelLedger(platform, { householdId, generation, now: fundingNow }) : null;
  const month = () => fundingMonth(fundingNow());
  // Mirror this household's final platform rounds of the funding month into spend_ledger.
  function syncMirror() {
    for (const row of platformLedger.rounds(month())) {
      ledger.record({ ts: row.reserved_at, purpose: row.purpose, costUsd: committedOf(row), model: row.model,
        tokens: { input_tokens: row.input_tokens, output_tokens: row.output_tokens }, roundId: row.id });
    }
  }
  const reservations = platformLedger && {
    reserve({ purpose, model, boundUsd }) {
      syncMirror();
      return platformLedger.reserve({ purpose, model, boundUsd, adminCapUsd: capOf(db), legacySpendUsd: ledger.legacySpendUsd(month()),
        principal: currentPrincipal() });
    },
    settle: (roundId, result) => platformLedger.settle(roundId, result),
    hold: (roundId, code) => platformLedger.hold(roundId, code),
  };
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
    if (!settingOn(db) || allowed() !== true) throw new EngineOffError();
    const cap = capOf(db);
    await init();
    if (state.credentialState === 'failed') throw new ModelCallError('engine credential unavailable');
    if (!inner || cap !== innerCap) {
      inner = createEngine({ mode, ledger, capUsd: cap, credential: auth ?? undefined, ...(now ? { now } : {}), allowed, funded,
        ...(reservations ? { reservations, testTransport } : {}),
        streamDelayMs: mode === 'fake' && Number.isInteger(config.fakeStreamMs) ? config.fakeStreamMs : 0 });
      innerCap = cap;
    }
    return inner;
  }

  async function guarded(fn) {
    try {
      return await fn(await engine());
    } catch (error) {
      // A platform accounting hold refuses while it lasts; only this engine's own failure latches.
      if (error instanceof ModelAccountingError && error.code !== 'accounting_hold') refused = true;
      throw error;
    }
  }

  return {
    mode,
    init,
    get credentialState() { return state.credentialState; },
    isOn: () => mode !== 'off' && !refused && settingOn(db) && allowed() === true
      && (mode !== 'live' || (funded() === true && !platformLedger.held())),
    status() {
      const base = { mode, on: mode !== 'off' && settingOn(db), credentialState: state.credentialState, funded: mode !== 'live' || funded() === true };
      if (platformLedger) {
        syncMirror();
        const s = platformLedger.status(month());
        return { ...base, capUsd: Math.min(capOf(db), s.allocationUsd), spentUsd: s.committedUsd };
      }
      const at = new Date(now ? now() : Date.now());
      return { ...base, capUsd: capOf(db), spentUsd: ledger.monthSpendUsd(at.toISOString().slice(0, 7)) };
    },
    call: (req) => guarded((e) => e.call(req)),
    extract: (req) => guarded((e) => e.extract(req)),
  };
}
