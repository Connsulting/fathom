import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../../src/storage/index.mjs';

const invalid = { code: 'storage_invalid', message: 'storage_invalid' };
const unavailable = { code: 'storage_unavailable', message: 'storage_unavailable' };
const gate = () => Promise.withResolvers();

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'storage-port-'));
  const path = join(dir, 'scope.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE,
      amount REAL CHECK(amount >= 0), parent INTEGER REFERENCES items(id), bytes BLOB);
    CREATE TABLE effects (id INTEGER);
    CREATE TRIGGER item_insert AFTER INSERT ON items BEGIN
      INSERT INTO effects VALUES (new.id);
    END;`);
  db.close();
  const storage = await openStorage({ platform: { path }, households: [
    { householdId: 'synthetic-a', generation: 1, path: join(dir, 'a.sqlite') },
    { householdId: 'synthetic-b', generation: 1, path: join(dir, 'b.sqlite') },
  ] });
  t.after(async () => { await storage.close(); rmSync(dir, { recursive: true, force: true }); });
  return { storage, scope: await storage.platform(), path };
}

test('logical descriptors are frozen, lazy, async and return normalized plain values', async t => {
  const { scope } = await fixture(t);
  const broken = scope.prepare('not valid SQL');
  assert.ok(Object.isFrozen(broken));
  const rejected = broken.get();
  assert.ok(rejected instanceof Promise);
  await assert.rejects(rejected, invalid);
  const insert = scope.prepare('INSERT INTO items (label, amount, bytes) VALUES (?, ?, ?) RETURNING id');
  const pending = insert.get('synthetic', 1.25, new Uint8Array([0, 255, 7]));
  assert.ok(pending instanceof Promise);
  assert.deepEqual(await pending, { id: 1 });
  assert.deepEqual(await scope.prepare('SELECT id, label, amount, parent, bytes FROM items').all(), [
    { id: 1, label: 'synthetic', amount: 1.25, parent: null, bytes: new Uint8Array([0, 255, 7]) },
  ]);
  assert.equal(await scope.prepare('SELECT id FROM items WHERE id = ?').get(99), undefined);
  assert.deepEqual(await scope.prepare('UPDATE items SET amount = ? WHERE id = ?').run(2.5, 1), { changes: 1 });
  assert.deepEqual(await scope.prepare('SELECT count(*) AS n FROM effects').get(), { n: 1 });
  assert.deepEqual(await scope.prepare('SELECT ? AS n, ? AS text').get(Number.MAX_SAFE_INTEGER, 'é_%\\'),
    { n: Number.MAX_SAFE_INTEGER, text: 'é_%\\' });
  for (let i = 0; i < 260; i++) assert.deepEqual(await scope.prepare(`SELECT ${i} AS n`).get(), { n: i });
  assert.deepEqual(await insert.get('second', null, new Uint8Array()), { id: 2 });
  assert.deepEqual(await scope.prepare('WITH selected AS (SELECT id FROM items) SELECT * FROM selected').run(), { changes: 0 });
  assert.deepEqual(await scope.prepare("WITH selected AS (SELECT 'third' AS label) INSERT INTO items (label) SELECT label FROM selected").run(), { changes: 1 });
});

test('bindings and result normalization refuse unsupported values without poisoning the connection', async t => {
  const { scope } = await fixture(t);
  const q = scope.prepare('SELECT ? AS value');
  for (const value of [undefined, true, false, NaN, Infinity, -Infinity, 1n, {}, [], Number.MAX_SAFE_INTEGER + 1, 'nul\0text']) {
    await assert.rejects(q.get(value), invalid);
  }
  for (const sql of ["SELECT char(0) AS value", 'SELECT 9223372036854775807 AS value', 'SELECT 1e999 AS value',
    'SELECT ?1 AS value', 'SELECT :value', 'SELECT 1; SELECT 2', 'BEGIN', 'PRAGMA foreign_keys = OFF']) {
    await assert.rejects(scope.prepare(sql).get(), invalid);
  }
  await assert.rejects(q.get(), invalid);
  await assert.rejects(q.get(1, 2), invalid);
  assert.deepEqual(await q.get(null), { value: null });
  assert.deepEqual(await q.get(0), { value: 0 });
  assert.deepEqual(await scope.prepare("SELECT ';?1:word' AS value /* ; ? */; -- trailing\n").get(), { value: ';?1:word' });
});

test('savepoints rollback independently and all handles expire after their callback', async t => {
  const { scope } = await fixture(t);
  let outer, nested, saved;
  const result = await scope.transaction(async tx => {
    outer = tx;
    saved = tx.prepare('SELECT count(*) AS n FROM items');
    await tx.prepare('INSERT INTO items (label) VALUES (?)').run('outer');
    await assert.rejects(tx.savepoint(async child => {
      nested = child;
      await child.prepare('INSERT INTO items (label) VALUES (?)').run('rolled-back');
      await child.savepoint(async deeper => {
        await deeper.prepare('INSERT INTO items (label) VALUES (?)').run('also-rolled-back');
      });
      throw new Error('synthetic rollback');
    }), /synthetic rollback/);
    assert.deepEqual(await saved.get(), { n: 1 });
    return tx.savepoint(async child => {
      await child.prepare('INSERT INTO items (label) VALUES (?)').run('kept');
      return 'callback result';
    });
  });
  assert.equal(result, 'callback result');
  await assert.rejects(saved.get(), invalid);
  await assert.rejects(outer.savepoint(async () => {}), invalid);
  await assert.rejects(nested.prepare('SELECT 1').get(), invalid);
  await assert.rejects(scope.transaction(async tx => {
    await tx.prepare('INSERT INTO items (label) VALUES (?)').run('outer-rollback');
    throw new Error('outer failure');
  }), /outer failure/);
  assert.deepEqual(await scope.prepare('SELECT label FROM items ORDER BY id').all(), [{ label: 'outer' }, { label: 'kept' }]);
});

test('parent handles fail promptly inside callbacks while explicit handles remain live', { timeout: 3000 }, async t => {
  const { scope, storage } = await fixture(t);
  const parent = scope.prepare('SELECT 1 AS n');
  await scope.transaction(async tx => {
    await assert.rejects(parent.get(), invalid);
    await assert.rejects(scope.transaction(async () => {}), invalid);
    await assert.rejects(storage.close(), invalid);
    await tx.savepoint(async child => {
      await assert.rejects(tx.prepare('SELECT 1').get(), invalid);
      await assert.rejects(tx.savepoint(async () => {}), invalid);
      assert.deepEqual(await child.prepare('SELECT 2 AS n').get(), { n: 2 });
    });
    assert.deepEqual(await tx.prepare('SELECT 3 AS n').get(), { n: 3 });
  });
  assert.deepEqual(await parent.get(), { n: 1 });
});

test('two simultaneous transactions and a standalone operation serialize around nested rollback', async t => {
  const { scope } = await fixture(t);
  const entered = gate(), release = gate();
  const order = [];
  const first = scope.transaction(async tx => {
    order.push('first'); entered.resolve();
    await tx.prepare('INSERT INTO items (label) VALUES (?)').run('first');
    await release.promise;
    await assert.rejects(tx.savepoint(async child => {
      await child.prepare('INSERT INTO items (label) VALUES (?)').run('discard');
      throw new Error('discard');
    }), /discard/);
    order.push('first-end');
  });
  await entered.promise;
  const second = scope.transaction(async tx => {
    order.push('second');
    assert.deepEqual(await tx.prepare('SELECT count(*) AS n FROM items').get(), { n: 1 });
    await tx.prepare('INSERT INTO items (label) VALUES (?)').run('second');
  });
  const standalone = scope.prepare('SELECT count(*) AS n FROM items').get();
  assert.deepEqual(order, ['first']);
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(await standalone, { n: 2 });
  assert.deepEqual(order, ['first', 'first-end', 'second']);
});

test('concurrent savepoints serialize and failed constraints do not break later queued work', async t => {
  const { scope } = await fixture(t);
  await scope.transaction(async tx => {
    const results = await Promise.allSettled([
      tx.savepoint(async child => {
        await child.prepare('INSERT INTO items (label) VALUES (?)').run('discard');
        throw new Error('discard');
      }),
      tx.savepoint(async child => child.prepare('INSERT INTO items (label) VALUES (?)').run('keep')),
    ]);
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[1].status, 'fulfilled');
    await assert.rejects(tx.prepare('INSERT INTO items (label) VALUES (?)').run('keep'), { code: 'constraint_unique' });
    await tx.prepare('INSERT INTO items (label) VALUES (?)').run('after');
  });
  assert.deepEqual(await scope.prepare('SELECT label FROM items ORDER BY id').all(), [{ label: 'keep' }, { label: 'after' }]);
});

test('SQLite errors expose only fixed codes and successful operations remain usable', async t => {
  const { scope, path } = await fixture(t);
  await scope.prepare('INSERT INTO items (id, label) VALUES (?, ?)').run(1, 'synthetic-private-marker');
  for (const [sql, code] of [
    ["INSERT INTO items (label) VALUES ('synthetic-private-marker')", 'constraint_unique'],
    ["INSERT INTO items (id, label) VALUES (1, 'another')", 'constraint_unique'],
    ["INSERT INTO items (label, parent) VALUES ('orphan', 99)", 'constraint_foreign_key'],
    ["INSERT INTO items (label, amount) VALUES ('negative', -1)", 'constraint_check'],
    ['INSERT INTO items (label) VALUES (NULL)', 'constraint_check'],
    ['SELECT * FROM missing_synthetic_table', 'storage_invalid'],
  ]) {
    await assert.rejects(scope.prepare(sql).run(), error => {
      assert.equal(error.code, code); assert.equal(error.message, code);
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(JSON.stringify(error), /synthetic-private-marker|items|sqlite/);
      return true;
    });
  }
  const lock = new DatabaseSync(path);
  lock.exec('BEGIN IMMEDIATE');
  try {
    await assert.rejects(scope.transaction(async () => assert.fail('must not enter')), { code: 'storage_busy', message: 'storage_busy' });
  } finally { lock.exec('ROLLBACK'); lock.close(); }
  assert.deepEqual(await scope.prepare('SELECT count(*) AS n FROM items').get(), { n: 1 });
  await assert.rejects(openStorage({ platform: { path: join(path, 'missing.sqlite') } }), unavailable);
});

test('close drains admitted transactions, rejects later work and is idempotent', async t => {
  const { scope, storage } = await fixture(t);
  const entered = gate(), release = gate();
  const active = scope.transaction(async tx => {
    entered.resolve(); await release.promise;
    await tx.prepare('INSERT INTO items (label) VALUES (?)').run('before-close');
  });
  await entered.promise;
  const admitted = scope.prepare('SELECT count(*) AS n FROM items').get();
  const closing = storage.close();
  await assert.rejects(scope.prepare('SELECT 1').get(), unavailable);
  await assert.rejects(storage.platform(), unavailable);
  release.resolve();
  await active;
  assert.deepEqual(await admitted, { n: 1 });
  await closing;
  await storage.close();
  await assert.rejects(scope.transaction(async () => {}), unavailable);
});

test('configured scopes keep independent connections and require exact household generations', async t => {
  const { storage, scope } = await fixture(t);
  const a = await storage.household({ householdId: 'synthetic-a', generation: 1 });
  const b = await storage.household({ householdId: 'synthetic-b', generation: 1 });
  assert.equal(a, await storage.household({ householdId: 'synthetic-a', generation: 1 }));
  await assert.rejects(storage.household({ householdId: 'synthetic-a', generation: 2 }), invalid);
  await assert.rejects(storage.household({ householdId: 'missing', generation: 1 }), invalid);
  await assert.rejects(storage.household(null), invalid);
  await scope.transaction(async () => {
    assert.deepEqual(await a.prepare('SELECT 1 AS n').get(), { n: 1 });
    assert.deepEqual(await b.prepare('SELECT 2 AS n').get(), { n: 2 });
  });
});

test('invalid configuration fails with a fixed code before opening connections', async () => {
  for (const config of [undefined, null, {}, { platform: { path: '' } }, { platform: { path: ':memory:' }, households: null },
    { platform: { path: ':memory:' }, households: [{ path: ':memory:', householdId: 'a', generation: 0 }] },
    { platform: { path: ':memory:' }, households: [
      { path: ':memory:', householdId: 'a', generation: 1 }, { path: ':memory:', householdId: 'a', generation: 2 },
    ] }]) await assert.rejects(openStorage(config), invalid);
  const storage = await openStorage({ platform: { path: ':memory:' } });
  assert.deepEqual(await (await storage.platform()).prepare('SELECT 1 AS n').get(), { n: 1 });
  await storage.close();
});

test('production modules and existing helpers never import the unused kernel', () => {
  function inspect(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (path !== 'src/storage') inspect(path); }
      else if (path.endsWith('.mjs')) assert.doesNotMatch(readFileSync(path, 'utf8'), /(?:from\s*|import\s*\()['"][^'"]*storage\//, path);
    }
  }
  inspect('src'); inspect('test/helpers');
});
