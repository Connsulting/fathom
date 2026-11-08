import { AsyncLocalStorage } from 'node:async_hooks';
import { storageError } from './errors.mjs';
import { bindings } from './values.mjs';

const contexts = new AsyncLocalStorage();

class Queue {
  tail = Promise.resolve();

  add(action) {
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }
}

export function createScope(connection) {
  const queue = new Queue();
  let state = 'open', sequence = 0, closing;
  const invalidParent = handle => {
    const active = contexts.getStore()?.get(connection);
    if (active && active !== handle) throw storageError();
  };
  function descriptor(handle, submit, text) {
    return Object.freeze(Object.fromEntries(['get', 'all', 'run'].map(method => [method, async (...values) => {
      invalidParent(handle);
      const args = bindings(values);
      return submit(() => connection.query(text, method, args));
    }])));
  }
  async function callbackHandle(callback) {
    const local = new Queue();
    let active = true;
    const submit = action => {
      invalidParent(handle);
      if (!active) throw storageError();
      return local.add(action);
    };
    const handle = Object.freeze({
      prepare: text => descriptor(handle, submit, text),
      async savepoint(callback) {
        return submit(async () => {
          if (typeof callback !== 'function') throw storageError();
          const name = `storage_sp_${++sequence}`;
          await connection.savepoint(name);
          try {
            const result = await callbackHandle(callback);
            await connection.release(name);
            return result;
          } catch (error) {
            await connection.rollbackTo(name);
            await connection.release(name);
            throw error;
          }
        });
      },
    });
    const context = new Map(contexts.getStore());
    context.set(connection, handle);
    try { return await contexts.run(context, () => callback(handle)); }
    finally { active = false; await local.tail; }
  }
  function submit(action) {
    invalidParent(scope);
    if (state !== 'open') throw storageError('storage_unavailable');
    return queue.add(action);
  }
  const scope = Object.freeze({
    prepare: text => descriptor(scope, submit, text),
    async transaction(callback) {
      return submit(async () => {
        if (typeof callback !== 'function') throw storageError();
        await connection.begin();
        try {
          const result = await callbackHandle(callback);
          await connection.commit();
          return result;
        } catch (error) {
          await connection.rollback();
          throw error;
        }
      });
    },
  });
  return {
    scope,
    assertOutsideTransaction() { invalidParent(scope); },
    async close() {
      invalidParent(scope);
      if (closing) return closing;
      state = 'closing';
      closing = queue.add(async () => {
        try { await connection.close(); } finally { state = 'closed'; }
      });
      return closing;
    },
  };
}
