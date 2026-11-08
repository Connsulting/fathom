import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDb, migrate, setSetting } from '../../src/store/db.mjs';
import { createRuntimeEngine } from '../../src/engine/runtime.mjs';
import { interpretFile, fileSpend } from '../../src/ingest/model-parse.mjs';

const file = { fileId: 'f-synthetic', format: 'text', bytes: Buffer.from('Synthetic note') };
const script = { text: JSON.stringify({ rows: [], coverage: [{ regionId: 'g0', disposition: 'unresolved', refs: ['r0'] }], completeness: 'incomplete' }), costUsd: 0.001, tokens: { input_tokens: 20, output_tokens: 30 } };
async function setup(db) {
  db ??= await openDb(':memory:');
  await migrate(db);
  await db.prepare('INSERT INTO files (id,name,sha256,size,mime,uploaded_at,status) VALUES (?,?,?,?,?,?,?)').run(file.fileId, 'synthetic.txt', createHash('sha256').update(file.bytes).digest('hex'), 14, 'text/plain', '2032-04-17', 'needs_extraction');
  let enabled = true, funded = true, current = true;
  const engine = await createRuntimeEngine({ db, config: { engine: 'fake' }, now: () => '2032-04-17', allowed: () => enabled });
  const ctx = { household: { db, engine, generation: 1, isCurrent: () => current, outbound: { enabled: () => enabled }, funded: () => funded }, now: () => new Date('2032-04-17') };
  return { db, ctx, engine, pause: () => enabled = false, unfund: () => funded = false, stale: () => current = false };
}
test('outbound pause, unfunded, stale generation, off and exhausted monthly budget dispatch nothing', async () => {
  for (const state of ['pause', 'unfund', 'stale', 'off', 'cap']) {
    const x = await setup();
    try {
      if (['pause', 'unfund', 'stale'].includes(state)) x[state]();
      if (state === 'off') await setSetting(x.db, 'engine', { on: false });
      if (state === 'cap') await setSetting(x.db, 'cap', { usd: 0 });
      const result = await interpretFile({ ctx: x.ctx, file, fake: [script] });
      assert.equal(result.status, state === 'cap' ? 'budget_exhausted' : 'waiting_for_engine');
      assert.equal((await fileSpend(x.db, file.fileId)).calls, 0);
      assert.equal((await x.db.prepare('SELECT count(*) n FROM spend_ledger').get()).n, 0);
    } finally { await x.db.close(); }
  }
});
test('four calls survive fresh service invocations and settle actual usage into household ledger', async () => {
  const x = await setup();
  try {
    for (let i = 0; i < 4; i++) assert.equal((await interpretFile({ ctx: x.ctx, file, fake: [script] })).status, 'needs_clarification');
    assert.equal((await interpretFile({ ctx: x.ctx, file, fake: [script] })).status, 'budget_exhausted');
    const spend = await fileSpend(x.db, file.fileId);
    assert.equal(spend.calls, 4); assert.equal(spend.costUsd, 0.004);
    assert.equal((await x.db.prepare('SELECT count(*) n FROM spend_ledger').get()).n, 4);
    assert.ok(spend.inputTokens <= 32768); assert.ok(spend.outputTokens <= 8192);
  } finally { await x.db.close(); }
});
test('unknown failed call retains conservative accounting across engine restart and only one retry', async () => {
  const x = await setup();
  try {
    const bad = { text: '', status: 'transport_error', is_error: true, accountingUnknown: true };
    await interpretFile({ ctx: x.ctx, file, fake: [bad] });
    const first = await fileSpend(x.db, file.fileId);
    assert.equal(first.calls, 1); assert.ok(first.costUsd > 0);
    x.ctx.household.engine = await createRuntimeEngine({ db: x.db, config: { engine: 'fake' }, now: () => '2032-04-17' });
    const retried = await interpretFile({ ctx: x.ctx, file, fake: [bad], retry: true });
    const second = await fileSpend(x.db, file.fileId);
    assert.equal(retried.status, 'budget_exhausted');
    assert.deepEqual(second, first, 'unknown input reservation still consumes the token ceiling after restart');
    assert.equal((await interpretFile({ ctx: x.ctx, file, fake: [script], retry: true })).status, 'budget_exhausted');
  } finally { await x.db.close(); }
});
test('no legal call fits a small file/monthly cap; oversized inputs never dispatch', async () => {
  for (const smallFile of [true, false]) {
    const x = await setup();
    try {
      if (!smallFile) await setSetting(x.db, 'cap', { usd: 0.000001 });
      assert.equal((await interpretFile({ ctx: x.ctx, file, fake: [script], limits: smallFile ? { costUsd: 0.000001 } : undefined })).status, 'budget_exhausted');
      assert.equal((await fileSpend(x.db, file.fileId)).calls, 0);
    } finally { await x.db.close(); }
  }
  const x = await setup();
  try {
    await x.db.prepare('UPDATE files SET sha256=?').run(createHash('sha256').update(Buffer.from('word '.repeat(15000))).digest('hex'));
    assert.equal((await interpretFile({ ctx: x.ctx, file: { ...file, bytes: Buffer.from('word '.repeat(15000)) }, fake: [script] })).status, 'budget_exhausted');
    assert.equal((await fileSpend(x.db, file.fileId)).calls, 0);
  } finally { await x.db.close(); }
});

test('one known failed round can retry but no further retry dispatches', async () => {
  const x = await setup();
  try {
    await interpretFile({ ctx: x.ctx, file, fake: [{ ...script, status: 'api_error', is_error: true }] });
    assert.equal((await fileSpend(x.db, file.fileId)).calls, 1);
    await interpretFile({ ctx: x.ctx, file, fake: [script], retry: true });
    assert.equal((await fileSpend(x.db, file.fileId)).calls, 2);
    assert.equal((await interpretFile({ ctx: x.ctx, file, fake: [script], retry: true })).status, 'budget_exhausted');
  } finally { await x.db.close(); }
});

test('context changes after an admitted round retain the local proposal and block subsequent dispatch', async () => {
  for (const change of ['pause', 'unfund', 'stale']) {
  const x = await setup();
  try {
    const call = x.engine.call;
    x.engine.call = async request => { const result = await call(request); x[change](); return result; };
    const retained = await interpretFile({ ctx: x.ctx, file, fake: [script] });
    assert.equal(retained.status, 'waiting_for_engine');
    assert.equal(retained.reasonCode, 'context_changed');
    assert.equal(retained.valid, true);
    assert.deepEqual(retained.proposal.rows, []);
    assert.equal(retained.proposal.fileId, file.fileId);
    assert.equal((await interpretFile({ ctx: x.ctx, file, fake: [script], retry: true })).status, 'waiting_for_engine');
    assert.equal((await fileSpend(x.db, file.fileId)).calls, 1);
    for (const table of ['transactions', 'balances', 'pnl_lines', 'tax_payments', 'import_proposals']) assert.equal((await x.db.prepare(`SELECT count(*) n FROM ${table}`).get()).n, 0);
  } finally { await x.db.close(); }
  }
});

test('household names are scrubbed at dispatch and the request carries only bounded reference inputs', async () => {
  const x = await setup();
  try {
    await x.db.prepare("INSERT INTO facts (key,value,updated_at) VALUES ('household.names',?,'2032-04-17')").run(JSON.stringify({ me: 'Syntheticperson' }));
    const named = { ...file, bytes: Buffer.from('Syntheticperson pays $23.45') };
    await x.db.prepare('UPDATE files SET sha256=?').run(createHash('sha256').update(named.bytes).digest('hex'));
    let observed;
    const call = x.engine.call;
    x.engine.call = request => { observed = request; return call(request); };
    await interpretFile({ ctx: x.ctx, file: named, fake: [script] });
    assert.ok(observed);
    assert.equal(observed.purpose, 'extract'); assert.deepEqual(observed.tools, []);
    assert.ok(!JSON.stringify(observed.messages).includes('Syntheticperson'));
    assert.ok(!JSON.stringify(observed.messages).includes('23.45'));
    assert.equal(observed.maxTokens, 4096);
    assert.ok(observed.budget.maxCostUsd <= 0.50);
    assert.ok(observed.budget.timeoutMs <= 120000);
    assert.match(observed.budget.correlationId, /^import:/);
  } finally { await x.db.close(); }
});

test('output token and USD limits retain spend and never admit the next call', async () => {
  for (const response of [{ ...script, tokens: { input_tokens: 25, output_tokens: 4096 } }, { ...script, costUsd: 0.45 }]) {
    const x = await setup();
    try {
      await interpretFile({ ctx: x.ctx, file, fake: [response] });
      const first = await fileSpend(x.db, file.fileId);
      if (response.costUsd === 0.45) {
        assert.equal((await interpretFile({ ctx: x.ctx, file, fake: [script] })).status, 'budget_exhausted');
        assert.equal((await fileSpend(x.db, file.fileId)).calls, 1);
      } else {
        await interpretFile({ ctx: x.ctx, file, fake: [response] });
        assert.equal((await fileSpend(x.db, file.fileId)).outputTokens, 8192);
        assert.equal((await interpretFile({ ctx: x.ctx, file, fake: [script] })).status, 'budget_exhausted');
      }
      assert.ok((await fileSpend(x.db, file.fileId)).costUsd >= first.costUsd);
    } finally { await x.db.close(); }
  }
});

test('file counters survive closing and reopening the household store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-budget-'));
  const path = join(dir, 'store.sqlite');
  const x = await setup(await openDb(path));
  try {
    await interpretFile({ ctx: x.ctx, file, fake: [script] });
    const before = await fileSpend(x.db, file.fileId);
    await x.db.close();
    x.db = await openDb(path); x.ctx.household.db = x.db;
    x.ctx.household.engine = await createRuntimeEngine({ db: x.db, config: { engine: 'fake' }, now: () => '2032-04-17' });
    assert.deepEqual(await fileSpend(x.db, file.fileId), before);
    await interpretFile({ ctx: x.ctx, file, fake: [script], retry: true });
    assert.equal((await fileSpend(x.db, file.fileId)).calls, 2);
  } finally { await x.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('equal file ids in two households have independent spend and populated demo reset clears children', async () => {
  const a = await setup(), b = await setup();
  try {
    await interpretFile({ ctx: a.ctx, file, fake: [script] });
    assert.equal((await fileSpend(a.db, file.fileId)).calls, 1);
    assert.equal((await fileSpend(b.db, file.fileId)).calls, 0);
    await setSetting(a.db, 'mode', 'demo');
    const { seedDemo } = await import('../../demo/seed.mjs');
    await seedDemo(a.db);
    assert.equal((await fileSpend(a.db, file.fileId)).calls, 0);
    assert.deepEqual(await a.db.foreignKeyCheck(), []);
  } finally { await a.db.close(); await b.db.close(); }
});
