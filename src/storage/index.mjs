import { openConnection } from './sqlite/connection.mjs';
import { createScope } from './kernel.mjs';
import { storageError } from './errors.mjs';

function validPath(config) {
  return config && typeof config.path === 'string' && config.path.length > 0 && !config.path.includes('\0');
}

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
