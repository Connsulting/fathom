// A household's engine: createEngine over the household store's spend_ledger table, gated by the
// store's settings and the household's outbound flag. Before every call it re-reads
// settings.engine.on and allowed() (either false throws EngineOffError; a paused household behaves
// as engine off in every mode) and settings.cap.usd (default 200), rebuilding the inner engine when
// the cap changes; the inner engine re-checks allowed() and, in live mode, funded() before every
// round. Outside live mode, once any call throws ModelAccountingError the runtime refuses every
// further call; in live mode only an engine that could not record a round in the platform ledger
// (ModelAccountingError code accounting_unrecorded) latches, and a held round refuses through the
// platform hold until it is reconciled (see below). The live
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
// testTransport passed through to createEngine (programmatic only, tests). At construction the
// household's carry row for the current funding month is recorded (ensureCarry) when it has
// pre-MT-05 spend, so that spend counts against the instance cap before it ever reserves. Every round reserves
// with adminCapUsd = settings.cap.usd, legacySpendUsd = the funding month's spend_ledger rows with
// no round_id (carried once per month) and the AsyncLocalStorage principal of the request. Before
// each reserve and in status() the household's final platform rounds of the funding month are
// mirrored into spend_ledger by round_id (idempotent). Live status(): capUsd = min(settings cap,
// allocation), spentUsd = the platform committed spend of the funding month; isOn() is also false
// while the household has a held round. A round held by this engine (unknown cost or over its
// reservation) throws ModelAccountingError without latching: the platform hold is the authority,
// so once node scripts/reconcile-spend.mjs settles it the same engine admits the next call.

import { modelErrorCode } from '../models/port.mjs';
import { selectionFor } from '../models/config.mjs';
import { getSetting } from '../store/db.mjs';
import { createEngine, loadCredential, EngineOffError, ModelAccountingError, ModelCallError } from './index.mjs';
import { createModelLedger, currentPrincipal, ensureCarry, fundingMonth } from '../platform/model-budget.mjs';

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
  generation = 1, fundingNow = Date.now, testTransport = null, modelTransport } = {}) {
  if (!db) throw new TypeError('A store is required');
  if (typeof allowed !== 'function' || typeof funded !== 'function' || typeof fundingNow !== 'function') throw new TypeError('Invalid engine admission');
  const mode = config.engine ?? 'off';
  if (!['live', 'fake', 'off'].includes(mode)) throw new TypeError('Invalid engine mode');
  if (mode === 'live' && (!platform || typeof householdId !== 'string')) throw new TypeError('A live engine needs the platform reservation ledger');
  const ledger = createSpendLedger(db);
  const platformLedger = mode === 'live' ? createModelLedger(platform, { householdId, generation, now: fundingNow }) : null;
  const month = () => fundingMonth(fundingNow());
  // A zero carry is left to the first reserve, so it is never frozen ahead of the month's rows.
  if (platformLedger) {
    const at = fundingNow();
    const legacySpendUsd = ledger.legacySpendUsd(fundingMonth(at));
    if (legacySpendUsd > 0) ensureCarry(platform, { householdId, month: fundingMonth(at), legacySpendUsd, now: at });
  }
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
  const modelCredentials = {};
  const credentialStates = {};
  const failedCredentials = new Set();
  let initPromise = null;
  const state = { credentialState: 'none' };

  // Idempotent: the credential is read on the first call only, never retried.
  function init() {
    initPromise ??= (async () => {
      if (mode !== 'live') return;
      const loaded = new Map();
      for (const purpose of ['chat', 'job', 'confirm', 'extract', 'title', 'categorize']) {
        const selection = selectionFor(config.modelPorts, purpose);
        const file = selection.keyFile || (selection.adapter === 'claude' ? config.claudeCredentialFile : selection.adapter === 'jev' ? config.typesafeKeyFile : null) || null;
        if (!file && !['claude', 'jev'].includes(selection.adapter)) { credentialStates[purpose]='loaded'; continue; }
        if (!loaded.has(file)) {
          try { loaded.set(file, await loadCredential(file)); } catch { loaded.set(file, null); }
        }
        const value = loaded.get(file);
        if (value) modelCredentials[purpose] = value;
        else failedCredentials.add(purpose);
        credentialStates[purpose] = value ? 'loaded' : 'failed';
      }
      auth = modelCredentials.chat ?? null;
      state.credentialState = credentialStates.chat;
    })();
    return initPromise;
  }

  async function engine(purpose) {
    if (refused) throw new ModelAccountingError();
    if (!settingOn(db) || allowed() !== true) throw new EngineOffError();
    const cap = capOf(db);
    await init();
    if (failedCredentials.has(purpose)) throw Object.assign(new ModelCallError('engine credential unavailable'), {code:'authentication'});
    if (!inner || cap !== innerCap) {
      inner = createEngine({ mode, ledger, capUsd: cap, credential: auth ?? undefined, modelConfig: config.modelPorts, modelCredentials, modelTransport, ...(now ? { now } : {}), allowed, funded,
        ...(reservations ? { reservations, testTransport } : {}),
        streamDelayMs: mode === 'fake' && Number.isInteger(config.fakeStreamMs) ? config.fakeStreamMs : 0 });
      innerCap = cap;
    }
    return inner;
  }

  async function guarded(fn, purpose) {
    try {
      return await fn(await engine(purpose));
    } catch (error) {
      // Live: a platform hold refuses while it lasts; only a round this engine could not record
      // latches. Fake and off: any accounting failure latches.
      if (error instanceof ModelAccountingError
        && (platformLedger ? error.code === 'accounting_unrecorded' : error.code !== 'accounting_hold')) refused = true;
      if (!(error instanceof EngineOffError)) error.code ??= modelErrorCode(error);
      throw error;
    }
  }

  return {
    mode,
    modelConfig: config.modelPorts,
    init,
    get credentialState() { return state.credentialState; },
    credentialStateFor: purpose => credentialStates[purpose] ?? 'none',
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
    complete: (req) => guarded((e) => e.call(req), req.purpose),
    call: (req) => guarded((e) => e.call(req), req.purpose),
    extract: (req) => guarded((e) => e.extract(req), 'extract'),
  };
}
