// AC3: `npm run seed:demo` loads the synthetic scenario (ported into demo/) at the November state,
// rebuilds a demo store, and refuses a real store.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import demo from '../demo/scenario.mjs';
import {
  ROOT, DB_FILE, PLATFORM_FILE, SERVER_TIMEOUT, tempDir, tempDb, tempInstance, runCommand, openStore, dumpStore, withServer, withPlatform, postJson,
  servedStore,
} from './helpers/server.mjs';
import { rmSync } from 'node:fs';
import { setSetting, getSetting } from '../src/store/db.mjs';
import { JOBS } from '../src/jobs/scheduler.mjs';

const T = { timeout: SERVER_TIMEOUT };
const seed = dataDir => runCommand('npm', ['run', 'seed:demo', '--', '--household', servedStore(dataDir)?.householdId ?? 'synthetic-legacy'], { env: { FATHOM_DATA: dataDir } });
const novemberStatus = r => (r.statusByDemo && r.statusByDemo.november) || r.status;
const cents = n => Math.round(n * 100) / 100 === n;

async function seededDir() {
  const instance = await tempInstance({ mode: 'demo' });
  const { dataDir } = instance;
  instance.close();
  const r = await seed(dataDir);
  assert.equal(r.code, 0, `seed:demo failed:\n${r.stdout}\n${r.stderr}`);
  return dataDir;
}

// The demo household's store (MT-03: households/<id>/fathom.sqlite, named by platform.sqlite).
async function withStore(dataDir, fn) {
  const db = await openStore(servedStore(dataDir).file);
  try { return await fn(db); } finally { db.close(); }
}

test('demo/scenario.mjs is a faithful port of mock-v2/scenario/example.js', () => {
  const code = readFileSync(join(ROOT, 'mock-v2/scenario/example.js'), 'utf8');
  const sandbox = { window: {} };
  vm.runInNewContext(code, sandbox);
  const mock = JSON.parse(JSON.stringify(sandbox.window.FATHOM_SCENARIO));
  // engine.jobs is exempt: the demo seeds the scheduler's real jobs while mock-v2 stays
  // untouched and keeps its original mock job list.
  const { jobs: demoJobs, ...demoEngine } = demo.engine;
  const { jobs: mockJobs, ...mockEngine } = mock.engine;
  assert.ok(Array.isArray(mockJobs) && Array.isArray(demoJobs));
  assert.deepStrictEqual({ ...demo, engine: demoEngine }, { ...mock, engine: mockEngine });
});

test('demo engine.jobs are the scheduler jobs, by id, name, cadence and does', () => {
  assert.deepEqual(demo.engine.jobs.map(j => j.id), ['plan', 'brief-email', 'deadline-alerts', 'freshness', 'trash-purge', 'confirm-guess', 'simplefin-sync']);
  assert.deepEqual(demo.engine.jobs.map(j => j.id), JOBS.map(j => j.id));
  for (const job of demo.engine.jobs) {
    const real = JOBS.find(j => j.id === job.id);
    assert.equal(job.name, real.name, `${job.id}.name`);
    assert.equal(job.cadence, real.cadence, `${job.id}.cadence`);
    assert.equal(job.does, real.does, `${job.id}.does`);
  }
});

test('demo/ does not import from or reference mock-v2', () => {
  const files = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(join(ROOT, 'demo'));
  assert.ok(files.length >= 2, 'demo/ holds the scenario and the seed');
  for (const f of files) assert.ok(!readFileSync(f, 'utf8').includes('mock-v2'), `${f} mentions mock-v2`);
});

test('seed:demo populates its selected demo store at the November state', T, async () => {
  const dataDir = await seededDir();
  const served = servedStore(dataDir);
  assert.ok(served, 'the seed created an instance with a rooted household');
  assert.equal(served.mode, 'demo');
  assert.equal(served.root, join(dataDir, 'households', served.householdId));
  assert.ok(existsSync(served.file), 'the store is in the household root');
  assert.ok(!existsSync(join(dataDir, DB_FILE)), 'no store at the data root');
  await withStore(dataDir, db => {
    assert.equal(getSetting(db, 'mode', null), 'demo');
    assert.equal(getSetting(db, 'clock', null), demo.meta.clock);
    assert.equal(getSetting(db, 'onboarding', null).done, true);
    const seeded = getSetting(db, 'seeded', null);
    assert.ok(seeded && seeded.at && seeded.scenario_sha);

    const rows = new Map(db.prepare('SELECT id, status FROM recs').all().map(r => [r.id, r.status]));
    assert.equal(rows.size, demo.recs.length);
    for (const r of demo.recs) assert.equal(rows.get(r.id), novemberStatus(r), `rec ${r.id}`);
  });
});

test('seed:demo rebuilds a demo store, discarding actions taken since', T, async () => {
  const dataDir = await seededDir();
  let threadKey;
  await withServer({ dataDir }, async s => {
    const r = await postJson(s.baseUrl, '/api/recs/deferral/action', { action: 'complete' });
    assert.equal(r.status, 200);
    const a = await postJson(s.baseUrl, '/api/threads', { text: 'Can we push the fixed-fee invoices into January?' });
    assert.equal(a.status, 200);
    threadKey = a.json.thread.key;
  });
  // A demo store with no platform gets a synthetic one at startup.
  assert.ok(existsSync(join(dataDir, PLATFORM_FILE)), 'the demo server created its synthetic platform');
  const served = await withPlatform(join(dataDir, PLATFORM_FILE), (platform, store) => store.servedHousehold());
  assert.equal(served.mode, 'demo');
  await withStore(dataDir, db => {
    assert.equal(db.prepare("SELECT status FROM recs WHERE id = 'deferral'").get().status, 'done');
    assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE conversation_key = ?').get(threadKey).n, 2);
  });
  const again = await seed(dataDir);
  assert.equal(again.code, 0, again.stderr);
  await withStore(dataDir, db => {
    assert.equal(db.prepare("SELECT status FROM recs WHERE id = 'deferral'").get().status, 'proposed');
    assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE conversation_key = ?').get(threadKey).n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM conversations WHERE key LIKE 'ask:%'").get().n, 0, 'no threads survive the reseed');
    assert.equal(db.prepare("SELECT count(*) AS n FROM rec_events WHERE actor = 'ui'").get().n, 0);
  });
  // The reseeded store still belongs to the same platform household, so it restarts.
  await withServer({ dataDir }, async s => {
    const r = await postJson(s.baseUrl, '/api/recs/deferral/action', { action: 'complete' });
    assert.equal(r.status, 200);
  });
  assert.equal((await withPlatform(join(dataDir, PLATFORM_FILE), (platform, store) => store.servedHousehold())).id, served.id);
});

test('the synthetic ledger is deterministic and stamped with demo-seed provenance', T, async () => {
  const dataDir = await seededDir();
  const ledger = db => db.prepare('SELECT account_id, date, amount, description, category FROM transactions ORDER BY account_id, date, amount, description')
    .all().map(r => JSON.stringify({ ...r }));
  const first = await withStore(dataDir, db => {
    const file = db.prepare("SELECT * FROM files WHERE id = 'demo-seed'").get();
    assert.ok(file, 'files row demo-seed');
    assert.equal(file.source_kind, 'other');
    assert.equal(file.mime, 'application/json');
    assert.match(String(file.sha256), /^[0-9a-f]{64}$/);

    for (const table of ['accounts', 'transactions', 'balances', 'positions', 'pnl_lines', 'tax_payments', 'figures']) {
      const n = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
      assert.ok(n > 0, `${table} has rows`);
      const bad = db.prepare(`SELECT count(*) AS n FROM ${table}
        WHERE parser IS NOT 'demo-seed' OR file_id IS NOT 'demo-seed' OR locator IS NULL OR locator = ''`).get().n;
      assert.equal(bad, 0, `${table} rows carry demo-seed provenance and a locator`);
    }

    const n = db.prepare('SELECT count(*) AS n FROM transactions').get().n;
    assert.ok(n >= 150 && n <= 500, `about 200 to 400 transactions, got ${n}`);
    const kinds = db.prepare('SELECT DISTINCT a.kind FROM transactions t JOIN accounts a ON a.id = t.account_id').all().map(r => r.kind);
    for (const k of kinds) assert.ok(['checking', 'business'].includes(k), `transactions only on checking or business, saw ${k}`);
    for (const r of db.prepare('SELECT amount FROM transactions').all()) assert.ok(cents(r.amount), `amount ${r.amount} is in cents`);

    const year = demo.meta.clock.slice(0, 4);
    const pnl = db.prepare('SELECT DISTINCT entity, period, category FROM pnl_lines').all();
    assert.deepEqual([...new Set(pnl.map(r => r.entity))].sort(), [demo.names.biz, demo.names.spouseBiz].sort());
    for (const r of pnl) {
      assert.match(r.period, new RegExp(`^${year}-0[1-8]$`));
      assert.ok(['revenue', 'payroll', 'software', 'contractors', 'other'].includes(r.category), r.category);
    }

    const tax = db.prepare('SELECT DISTINCT jurisdiction, kind FROM tax_payments').all();
    assert.ok(tax.length >= 2);
    for (const r of tax) assert.equal(r.kind, 'estimate');
    return ledger(db);
  });
  const again = await seed(dataDir);
  assert.equal(again.code, 0, again.stderr);
  const second = await withStore(dataDir, ledger);
  assert.deepEqual(second, first, 'reseeding produces the same ledger');
});

test('account balances at data-through equal the account figure, and masks are 4 digits or null', T, async () => {
  const dataDir = await seededDir();
  await withStore(dataDir, db => {
    const ids = db.prepare('SELECT id FROM accounts ORDER BY id').all().map(r => r.id);
    assert.deepEqual(ids, demo.accounts.map(a => a.id).sort());
    for (const r of db.prepare('SELECT mask FROM accounts').all()) {
      assert.ok(r.mask === null || /^\d{4}$/.test(r.mask), `mask ${r.mask}`);
    }
    for (const a of demo.accounts.filter(x => x.fig)) {
      const b = db.prepare('SELECT date, amount FROM balances WHERE account_id = ? ORDER BY date DESC LIMIT 1').get(a.id);
      assert.ok(b, `balance for ${a.id}`);
      assert.equal(b.date, '2026-08-30');
      assert.equal(b.amount, demo.fig[a.fig].v, `balance for ${a.id}`);
    }
  });
});

test('seed:demo refuses a real store and leaves it untouched', T, async () => {
  const t = await tempInstance({ mode: 'real' });
  t.db.prepare(`INSERT INTO facts (key, value, src, as_of, confirmed, file_id, parser, locator, updated_at)
                VALUES ('household.dependents', '2', 'you', '2026-11-01', 1, NULL, NULL, NULL, '2026-11-01T09:00:00Z')`).run();
  t.close();
  const before = await dumpStore(t.file);
  const platformBefore = await dumpStore(t.platformFile);
  const r = await seed(t.dataDir);
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /real/i);
  assert.deepEqual(await dumpStore(t.file), before);
  assert.deepEqual(await dumpStore(t.platformFile), platformBefore);
});

// MT-03: a real single-store layout (fathom.sqlite at the data root, no platform) is refused with a
// fixed code before anything is opened for writing.
test('seed:demo refuses an unmigrated real store with a fixed code and leaves it untouched', T, async () => {
  const t = await tempDb();
  setSetting(t.db, 'mode', 'real');
  t.db.prepare(`INSERT INTO facts (key, value, src, as_of, confirmed, file_id, parser, locator, updated_at)
                VALUES ('household.dependents', '2', 'you', '2026-11-01', 1, NULL, NULL, NULL, '2026-11-01T09:00:00Z')`).run();
  t.close();
  const before = await dumpStore(t.file);
  const r = await seed(t.dataDir);
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /seed:demo: platform_migration_required/);
  assert.deepEqual(await dumpStore(t.file), before);
  assert.ok(!existsSync(join(t.dataDir, PLATFORM_FILE)), 'no platform is created');
});

test('seed:demo treats a store with no mode setting as real and refuses it', T, async () => {
  const t = await tempDb();
  t.db.prepare(`INSERT INTO facts (key, value, src, as_of, confirmed, file_id, parser, locator, updated_at)
                VALUES ('household.state', '"VA"', 'you', '2026-11-01', 1, NULL, NULL, NULL, '2026-11-01T09:00:00Z')`).run();
  t.close();
  const before = await dumpStore(t.file);
  const r = await seed(t.dataDir);
  assert.notEqual(r.code, 0);
  assert.deepEqual(await dumpStore(t.file), before);
});

test('seedDemo itself refuses a populated store with no mode and leaves it untouched', T, async () => {
  const { seedDemo } = await import('../demo/seed.mjs');
  const t = await tempDb();
  t.db.prepare(`INSERT INTO facts (key, value, src, as_of, confirmed, file_id, parser, locator, updated_at)
                VALUES ('household.state', '"VA"', 'you', '2026-11-01', 1, NULL, NULL, NULL, '2026-11-01T09:00:00Z')`).run();
  assert.throws(() => seedDemo(t.db), /refusing/);
  assert.equal(getSetting(t.db, 'mode', null), null);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM facts').get().n, 1);
  t.close();
});

test('seedDemo itself refuses a real store', T, async () => {
  const { seedDemo } = await import('../demo/seed.mjs');
  const t = await tempDb();
  setSetting(t.db, 'mode', 'real');
  assert.throws(() => seedDemo(t.db), /refusing/);
  assert.equal(getSetting(t.db, 'mode', null), 'real');
  t.close();
});

// The households singleton left fathom.sqlite in MT-01; the store now carries store_identity, which
// seeding and reset keep while they clear and reload every financial table.
test('demo seeding and reset keep store_identity without duplicating or erasing financial seed data', T, async () => {
  const { seedDemo } = await import('../demo/seed.mjs');
  const t = await tempInstance({ mode: 'demo', init: seedDemo });
  try {
    const identity = t.db.prepare('SELECT * FROM store_identity').all().map(r => ({ ...r }));
    assert.equal(identity.length, 1);
    assert.equal(identity[0].household_id, t.householdId);
    const accounts = t.db.prepare('SELECT id, mask, kind FROM accounts ORDER BY id').all();
    const transactions = t.db.prepare('SELECT count(*) AS n FROM transactions').get().n;
    assert.ok(accounts.length > 0 && transactions > 0);
    assert.equal(getSetting(t.db, 'mode', null), 'demo');
    seedDemo(t.db);
    assert.deepEqual(t.db.prepare('SELECT * FROM store_identity').all().map(r => ({ ...r })), identity, 'reset keeps the store identity');
    assert.equal(t.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'households'").get().n, 0, 'no households table in the store');
    assert.deepEqual(t.db.prepare('SELECT id, mask, kind FROM accounts ORDER BY id').all(), accounts);
    assert.equal(t.db.prepare('SELECT count(*) AS n FROM transactions').get().n, transactions);
    assert.equal(t.platform.prepare('SELECT count(*) AS n FROM households').get().n, 1, 'the platform keeps one demo household');
  } finally { t.close(); rmSync(t.dataDir, { recursive: true, force: true }); }
});

test('seedDemo seeds a fresh migrated store that has an empty store_identity table', T, async () => {
  const { seedDemo } = await import('../demo/seed.mjs');
  const t = await tempDb();
  try {
    assert.equal(t.db.prepare('SELECT count(*) AS n FROM store_identity').get().n, 0);
    seedDemo(t.db);
    assert.equal(getSetting(t.db, 'mode', null), 'demo');
    assert.ok(t.db.prepare('SELECT count(*) AS n FROM accounts').get().n > 0);
  } finally { t.close(); }
});
