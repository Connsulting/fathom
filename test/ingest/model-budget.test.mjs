import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, setSetting } from '../../src/store/db.mjs';
import { createRuntimeEngine } from '../../src/engine/runtime.mjs';
import { interpretFile, fileSpend } from '../../src/ingest/model-parse.mjs';

const file = { fileId: 'f-synthetic', format: 'text', bytes: Buffer.from('Synthetic note') };
const script = { text: JSON.stringify({ rows: [], coverage: [{ regionId: 'g0', disposition: 'unresolved', refs: ['r0'] }], completeness: 'incomplete' }), costUsd: 0.001, tokens: { input_tokens: 20, output_tokens: 30 } };
function setup() {
  const db = openDb(':memory:'); migrate(db);
  db.prepare('INSERT INTO files (id,name,sha256,size,mime,uploaded_at,status) VALUES (?,?,?,?,?,?,?)').run(file.fileId, 'synthetic.txt', 'a'.repeat(64), 14, 'text/plain', '2032-04-17', 'needs_extraction');
  let enabled = true, funded = true, current = true;
  const engine = createRuntimeEngine({ db, config: { engine: 'fake' }, now: () => '2032-04-17', allowed: () => enabled });
  const ctx = { household: { db, engine, generation: 1, isCurrent: () => current, outbound: { enabled: () => enabled }, funded: () => funded }, now: () => new Date('2032-04-17') };
  return { db, ctx, engine, pause: () => enabled = false, unfund: () => funded = false, stale: () => current = false };
}
test('outbound pause, unfunded, stale generation, off and exhausted monthly budget dispatch nothing', async () => {
  for (const state of ['pause', 'unfund', 'stale', 'off', 'cap']) {
    const x = setup();
    try {
      if (['pause', 'unfund', 'stale'].includes(state)) x[state]();
      if (state === 'off') setSetting(x.db, 'engine', { on: false });
      if (state === 'cap') setSetting(x.db, 'cap', { usd: 0 });
      const result = await interpretFile({ ctx: x.ctx, file, fake: [script] });
      assert.equal(result.status, state === 'cap' ? 'budget_exhausted' : 'waiting_for_engine');
      assert.equal(fileSpend(x.db, file.fileId).calls, 0);
      assert.equal(x.db.prepare('SELECT count(*) n FROM spend_ledger').get().n, 0);
    } finally { x.db.close(); }
  }
});
test('four calls survive fresh service invocations and settle actual usage into household ledger', async () => {
  const x = setup();
  try {
    for (let i = 0; i < 4; i++) assert.equal((await interpretFile({ ctx: x.ctx, file, fake: [script] })).status, 'needs_clarification');
    assert.equal((await interpretFile({ ctx: x.ctx, file, fake: [script] })).status, 'budget_exhausted');
    const spend = fileSpend(x.db, file.fileId);
    assert.equal(spend.calls, 4); assert.equal(spend.costUsd, 0.004);
    assert.equal(x.db.prepare('SELECT count(*) n FROM spend_ledger').get().n, 4);
    assert.ok(spend.inputTokens <= 32768); assert.ok(spend.outputTokens <= 8192);
  } finally { x.db.close(); }
});
test('unknown failed call retains conservative accounting across engine restart and only one retry', async () => {
  const x = setup();
  try {
    const bad = { text: '', status: 'transport_error', is_error: true, accountingUnknown: true };
    await interpretFile({ ctx: x.ctx, file, fake: [bad] });
    const first = fileSpend(x.db, file.fileId);
    assert.equal(first.calls, 1); assert.ok(first.costUsd > 0);
    x.ctx.household.engine = createRuntimeEngine({ db: x.db, config: { engine: 'fake' }, now: () => '2032-04-17' });
    await interpretFile({ ctx: x.ctx, file, fake: [bad], retry: true });
    const second = fileSpend(x.db, file.fileId);
    assert.equal(second.calls, 2); assert.ok(second.costUsd >= first.costUsd);
    assert.equal((await interpretFile({ ctx: x.ctx, file, fake: [script], retry: true })).status, 'budget_exhausted');
  } finally { x.db.close(); }
});
test('no legal call fits a small file/monthly cap; oversized inputs never dispatch', async () => {
  for (const smallFile of [true, false]) {
    const x = setup();
    try {
      if (!smallFile) setSetting(x.db, 'cap', { usd: 0.000001 });
      assert.equal((await interpretFile({ ctx: x.ctx, file, fake: [script], limits: smallFile ? { costUsd: 0.000001 } : undefined })).status, 'budget_exhausted');
      assert.equal(fileSpend(x.db, file.fileId).calls, 0);
    } finally { x.db.close(); }
  }
  const x = setup();
  try {
    assert.equal((await interpretFile({ ctx: x.ctx, file: { ...file, bytes: Buffer.from('word '.repeat(15000)) }, fake: [script] })).status, 'budget_exhausted');
    assert.equal(fileSpend(x.db, file.fileId).calls, 0);
  } finally { x.db.close(); }
});
