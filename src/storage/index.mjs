import { openConnection } from './sqlite/connection.mjs';
import { createScope, currentHandle, registerScope } from './kernel.mjs';

export { currentHandle };
import { storageError } from './errors.mjs';

function validPath(config) {
  return config && typeof config.path === 'string' && config.path.length > 0 && !config.path.includes('\0');
}

export { storageError } from './errors.mjs';

// One scope over one store file, opened on demand (a household store, the platform database, the
// public-demo control store or an offline tool's source). Resolves a scope that also has close().
// Options: readOnly, journal ('wal' | 'delete' | null), busyTimeout, foreignKeys, queryOnly, exclusive.
export async function openScope(config = {}) {
  if (!validPath(config)) throw storageError();
  const entry = createScope(await openConnection(config));
  const scope = Object.freeze({ ...entry.scope, close: () => entry.close() });
  registerScope(scope, entry.connection);
  return scope;
}

// Run fn atomically on a handle: a scope opens a write transaction, a transaction handle a
// savepoint. fn receives the handle to use for every statement inside.
export function atomically(handle, fn) {
  return handle.transaction ? handle.transaction(fn) : handle.savepoint(fn);
}

const discard = Symbol('rehearse');

// Run fn(handle) in a transaction or savepoint that is always rolled back; resolves fn's result.
export async function rehearse(handle, fn) {
  let result;
  try {
    await atomically(handle, async inner => {
      result = await fn(inner);
      throw discard;
    });
  } catch (error) {
    if (error !== discard) throw error;
  }
  return result;
}

// Whether a handle is a transaction (or savepoint) handle rather than a scope.
export const inTransaction = handle => !handle.transaction;

export async function openStorage(config = {}) {
  if (!config || typeof config !== 'object') throw storageError();
  const { platform, households = [] } = config;
  if (!validPath(platform) || !Array.isArray(households)) throw storageError();
  const identities = new Set();
  for (const config of households) {
    if (!validPath(config) || typeof config.householdId !== 'string' || !config.householdId
      || !Number.isSafeInteger(config.generation) || config.generation < 1
      || identities.has(config.householdId)) throw storageError();
    identities.add(config.householdId);
  }
  const opened = [];
  async function open(config) {
    const entry = createScope(await openConnection(config));
    opened.push(entry);
    return entry.scope;
  }
  let platformScope;
  const householdScopes = new Map();
  try {
    platformScope = await open(platform);
    for (const config of households) {
      householdScopes.set(config.householdId, { generation: config.generation, scope: await open(config) });
    }
  } catch (error) {
    await Promise.allSettled(opened.map(entry => entry.close()));
    throw error;
  }
  let closing;
  function assertOpen() {
    if (closing) throw storageError('storage_unavailable');
  }
  return Object.freeze({
    async platform() { assertOpen(); return platformScope; },
    async household(identity = {}) {
      assertOpen();
      if (!identity || typeof identity !== 'object') throw storageError();
      const { householdId, generation } = identity;
      const entry = householdScopes.get(householdId);
      if (!entry || entry.generation !== generation) throw storageError();
      return entry.scope;
    },
    async close() {
      for (const entry of opened) entry.assertOutsideTransaction();
      closing ??= Promise.all(opened.map(entry => entry.close())).then(() => {});
      return closing;
    },
  });
}
