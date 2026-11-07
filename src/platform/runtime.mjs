// Household runtimes: one immutable context per household generation, holding that household's
// financial store, root, vault, packs, engine, answerer, scheduler and transport. Nothing financial
// is process-global: the server, the MCP endpoint and the CLIs resolve a context through the
// registry (session membership, MCP key binding or an explicit --household) and hand every caller
// the objects of that one context.
//
// openHouseholdDb({ dataDir, householdId, storageRoot }) -> the open, migrated store at
//   <dataDir>/<storageRoot>/fathom.sqlite. The root must be a contained private directory (every
//   segment 0700, no symlink); store_identity must name householdId before and after migrate()
//   (household_store_mismatch). Closed again on any failure.
// createHouseholdContext({ householdId, generation, mode, db, relativeRoot, config, platform,
//   secrets, transport, transportOptions, engine, packs, answerer, scheduler, handlers, now })
//   builds, in order, the outbound guard, the vault accessor, the financial transport, packs,
//   engine (allowed: outbound engine; funded: platform setting instance_model_cap_usd > 0),
//   answerer and scheduler (allowed: outbound jobs; ctx.household is this context); tests may
//   inject any of transport, engine, packs, answerer, scheduler. Returns a frozen
//   { householdId, generation, mode, db, root, config, inFlight, vault(), packs, engine, answerer,
//   scheduler, transport, outbound, close() } where root is the absolute household root path.
//   vault() resolves once per context to { root, handle } (household-vault root and data key
//   handle); a refusal is a VaultError with code platform_key_missing | platform_key_invalid |
//   data_key_missing (or the root's code) and clears the cache. A household with no data key row
//   gets one provisioned here only while its store holds no vault object.
// createRuntimeRegistry({ platform, config, secrets, transportOptions, build }) -> { get(id), demo(),
//   forIdentity(identity), acquire(ctx), release(ctx), list(), startAll(), close() }.
//   get(id) returns the context of an `active` household with a storage_root, rebuilt when the
//   platform generation changed (the old one closes once every acquire has been released), else
//   null; a build failure logs a code and returns null. demo() is the original household's context
//   on a demo instance and throws otherwise. forIdentity needs identity.householdId and role.
//   startAll() starts every active household (pack state refresh, then its scheduler); contexts
//   built later start the same way.
//   close() stops schedulers and closes every store.

import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, migrate, DB_FILE } from '../store/db.mjs';
import { codeError, householdRootRel, storeIdentity } from './db.mjs';
import { householdRoot, unwrapDataKey, provisionDataKey } from './household-vault.mjs';
import { outboundGuard, recipientsVerified } from './outbound.mjs';
import { VaultError } from '../ingest/vault.mjs';
import { clockNow } from '../scenario/build.mjs';
import { createLivePacks } from '../packs/live.mjs';
import { createRuntimeEngine } from '../engine/runtime.mjs';
import { createLiveAnswerer } from '../api/answerer.mjs';
import { createScheduler, defaultHandlers } from '../jobs/scheduler.mjs';
import { createHouseholdTransport } from '../email/transport.mjs';

const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ROOT_SEGMENTS = 4;
export const FUNDING_SETTING = 'instance_model_cap_usd';

// Log-safe code of an error: its code or name when it is a plain identifier.
const codeOf = err => [err && err.code, err && err.name].find(v => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(v)) || 'unknown';

// The absolute root for `storageRoot` after checking every segment: households/<seg>[/<seg>...],
// each an existing private directory that is not a symlink, resolving to itself.
export function checkHouseholdRoot(dataDir, storageRoot) {
  const segments = typeof storageRoot === 'string' ? storageRoot.split('/') : [];
  if (segments[0] !== 'households' || segments.length < 2 || segments.length > MAX_ROOT_SEGMENTS + 1
    || !segments.slice(1).every(s => SEGMENT.test(s))) throw codeError('household_root_invalid');
  let base;
  try {
    base = realpathSync(dataDir);
  } catch {
    throw codeError('household_root_missing');
  }
  let path = base;
  for (const seg of segments) {
    path = join(path, seg);
    let st;
    try {
      st = lstatSync(path, { throwIfNoEntry: false });
    } catch {
      throw codeError('household_root_invalid');
    }
    if (!st) throw codeError('household_root_missing');
    if (st.isSymbolicLink()) throw codeError('household_root_symlink');
    if (!st.isDirectory()) throw codeError('household_root_invalid');
    if ((st.mode & 0o077) !== 0) throw codeError('household_root_not_private');
  }
  if (realpathSync(path) !== path) throw codeError('household_root_symlink');
  return path;
}

export function openHouseholdDb({ dataDir, householdId, storageRoot }) {
  const root = checkHouseholdRoot(dataDir, storageRoot);
  const file = join(root, DB_FILE);
  if (!existsSync(file)) throw codeError('household_store_missing');
  const db = openDb(file);
  try {
    if (storeIdentity(db)?.householdId !== householdId) throw codeError('household_store_mismatch');
    migrate(db);
    if (storeIdentity(db)?.householdId !== householdId) throw codeError('household_store_mismatch');
    return db;
  } catch (e) {
    try { db.close(); } catch { /* already closed */ }
    throw e;
  }
}

// The instance funding authority for live model calls (MT-05 adds the operator command that sets it).
export function instanceFunded(platform) {
  const row = platform.prepare('SELECT value FROM platform_settings WHERE key = ?').get(FUNDING_SETTING);
  if (!row) return false;
  let v;
  try { v = JSON.parse(row.value); } catch { return false; }
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

// Whether the store holds any object sealed under a data key (so a new key must never replace a lost one).
function holdsVaultObjects(db) {
  return Boolean(db.prepare('SELECT 1 AS x FROM files WHERE stored_path IS NOT NULL LIMIT 1').get()
    || db.prepare('SELECT 1 AS x FROM advisor_packets LIMIT 1').get()
    || db.prepare('SELECT 1 AS x FROM simplefin_connection LIMIT 1').get());
}

// A data key refusal as the VaultError the financial callers map to 409. A data key that does not
// authenticate under the configured platform key means the platform key is wrong.
function vaultRefusal(err) {
  if (err instanceof VaultError) return err;
  const code = codeOf(err);
  return new VaultError(code === 'data_key_invalid' ? 'platform_key_invalid' : code);
}

function createVaultAccessor({ platform, secrets, db, config, householdId, relativeRoot }) {
  let cached = null;
  async function resolve() {
    let platformKey;
    try {
      platformKey = secrets.platformKey();
    } catch (err) {
      throw new VaultError(err?.code === 'platform_key_invalid' ? 'platform_key_invalid' : 'platform_key_missing');
    }
    try {
      const root = await householdRoot({ dataRoot: config.dataDir, householdId, relativeRoot });
      let handle;
      try {
        handle = await unwrapDataKey(platform, { householdId, platformKey });
      } catch (err) {
        if (err?.code !== 'data_key_missing' || holdsVaultObjects(db)) throw err;
        try {
          handle = await provisionDataKey(platform, { householdId, platformKey });
        } catch (again) {
          if (again?.code !== 'data_key_exists') throw again;
          handle = await unwrapDataKey(platform, { householdId, platformKey });
        }
      }
      return Object.freeze({ root, handle });
    } catch (err) {
      throw vaultRefusal(err);
    } finally {
      platformKey.fill(0);
    }
  }
  return function vault() {
    cached ??= resolve().catch(err => {
      cached = null;
      throw err;
    });
    return cached;
  };
}

// Pack load failures never stop a household from being served.
function refreshPacks(packs) {
  try {
    packs.refresh();
  } catch (err) {
    console.error('fathom: pack state refresh failed', codeOf(err));
  }
}

export function createHouseholdContext({
  householdId, generation = 1, mode, db, relativeRoot = householdRootRel(householdId), config, platform, secrets,
  transport = null, transportOptions = {}, engine = null, packs = null, answerer = null, scheduler = null, handlers = null, now = null,
} = {}) {
  if (typeof householdId !== 'string' || !db || !platform || !config || !secrets) throw new TypeError('createHouseholdContext needs a household, store, platform, config and secrets');
  if (mode !== 'real' && mode !== 'demo') throw new TypeError('createHouseholdContext mode must be real or demo');
  const root = join(config.dataDir, relativeRoot);
  const outbound = outboundGuard(platform, householdId);
  const vault = createVaultAccessor({ platform, secrets, db, config, householdId, relativeRoot });
  const householdTransport = transport ?? createHouseholdTransport(config, {
    ...transportOptions, outboxDir: join(root, 'outbox'), outbound,
    verifyRecipients: mode === 'real' ? addresses => recipientsVerified(platform, householdId, addresses) : null,
  });
  // Packs load lazily on read; the pack state refresh (a store write) runs when the household
  // starts serving (startAll, or a later build once started), never on a read path.
  const livePacks = packs ?? createLivePacks(db, { dataDir: root });
  let householdEngine = engine;
  if (!householdEngine) {
    householdEngine = createRuntimeEngine({
      db, config, now: now ?? (() => new Date(clockNow(db, config.clock))),
      allowed: () => outbound.enabled('engine'), funded: () => instanceFunded(platform),
    });
    householdEngine.init().then(() => {
      if (householdEngine.credentialState === 'failed') console.error('fathom: engine credential unavailable');
    }, () => {});
  }
  const householdAnswerer = answerer ?? createLiveAnswerer({ engine: householdEngine, packs: livePacks, root });
  let context = null;
  const householdScheduler = scheduler ?? createScheduler({
    db, config, engine: householdEngine, transport: householdTransport,
    handlers: handlers ?? defaultHandlers({ publicUrl: config.publicUrl }),
    allowed: () => outbound.enabled('jobs'), household: () => context,
  });
  let closing = null;
  context = Object.freeze({
    householdId, generation, mode, db, root, config, inFlight: new Set(), vault, packs: livePacks, engine: householdEngine,
    answerer: householdAnswerer, scheduler: householdScheduler, transport: householdTransport, outbound,
    close() {
      closing ??= (async () => {
        try { await householdScheduler?.stop(); } catch { /* stop never rejects; close anyway */ }
        try { db.close(); } catch { /* already closed */ }
      })();
      return closing;
    },
  });
  return context;
}

// The production builder: open the household's store, then its context (store closed on failure).
export function buildHouseholdContext({ householdId, generation, mode, relativeRoot, platform, config, secrets, transportOptions }) {
  const db = openHouseholdDb({ dataDir: config.dataDir, householdId, storageRoot: relativeRoot });
  try {
    return createHouseholdContext({ householdId, generation, mode, db, relativeRoot, config, platform, secrets, transportOptions });
  } catch (e) {
    try { db.close(); } catch { /* already closed */ }
    throw e;
  }
}

export function createRuntimeRegistry({ platform, config, secrets, transportOptions = {}, build = buildHouseholdContext } = {}) {
  if (!platform || !config || !secrets) throw new TypeError('createRuntimeRegistry needs the platform, config and secrets');
  const rowOf = platform.prepare('SELECT id, status, mode, storage_root, generation FROM households WHERE id = ?');
  const servable = platform.prepare("SELECT id FROM households WHERE status = 'active' AND storage_root IS NOT NULL ORDER BY created_at, id");
  const entries = new Map(); // householdId -> { context, generation }
  const refs = new Map(); // context -> active acquires
  const stale = new Set(); // contexts replaced by a newer generation, closed once released
  let started = false;
  let closed = false;

  function retire(context) {
    if ((refs.get(context) ?? 0) > 0) {
      stale.add(context);
      return;
    }
    stale.delete(context);
    refs.delete(context);
    context.close().catch(() => {});
  }

  function startHousehold(context) {
    if (context.packs) refreshPacks(context.packs);
    try {
      const out = context.scheduler?.start();
      if (out && typeof out.then === 'function') out.then(null, err => console.error('fathom: scheduler start failed', codeOf(err)));
    } catch (err) {
      console.error('fathom: scheduler start failed', codeOf(err));
    }
  }

  function get(householdId) {
    if (closed || typeof householdId !== 'string') return null;
    const row = rowOf.get(householdId);
    if (!row || row.status !== 'active' || row.storage_root == null) return null;
    const generation = Number(row.generation);
    const entry = entries.get(householdId);
    if (entry && entry.generation === generation) return entry.context;
    if (entry) {
      entries.delete(householdId);
      retire(entry.context);
    }
    let context;
    try {
      context = build({ householdId, generation, mode: row.mode, relativeRoot: row.storage_root, platform, config, secrets, transportOptions });
    } catch (err) {
      console.error('fathom: household runtime unavailable', codeOf(err));
      return null;
    }
    entries.set(householdId, { context, generation });
    if (started) startHousehold(context);
    return context;
  }

  return {
    get,
    demo() {
      const served = platform.prepare('SELECT id, mode FROM households WHERE serves_store = 1').get();
      if (!served || served.mode !== 'demo') throw codeError('not_demo');
      const context = get(served.id);
      if (!context) throw codeError('household_unavailable');
      return context;
    },
    forIdentity(identity) {
      if (!identity || typeof identity.householdId !== 'string' || !identity.role) return null;
      return get(identity.householdId);
    },
    acquire(context) {
      refs.set(context, (refs.get(context) ?? 0) + 1);
      return context;
    },
    release(context) {
      const n = (refs.get(context) ?? 0) - 1;
      if (n > 0) refs.set(context, n);
      else {
        refs.delete(context);
        if (stale.has(context)) retire(context);
      }
    },
    list() {
      return servable.all().map(r => r.id);
    },
    startAll() {
      started = true;
      for (const id of servable.all().map(r => r.id)) {
        const context = get(id);
        if (context) startHousehold(context);
      }
    },
    async close() {
      closed = true;
      const all = [...[...entries.values()].map(e => e.context), ...stale];
      entries.clear();
      stale.clear();
      refs.clear();
      await Promise.all(all.map(c => c.close().catch(() => {})));
    },
  };
}
