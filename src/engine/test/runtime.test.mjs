// AC1: the runtime engine over the store, as the chat work uses it. One engine per process (R6)
// that re-reads settings.engine.on and settings.cap.usd before every call, a spend ledger over the
// spend_ledger table in the month of the `now` the server passes (D3, D4), per-call fake scripts
// (request.fake) and tool context (request.toolContext), and accounting poison that persists for
// the process. Credential reading is covered by test/engine-runtime.test.mjs.

import assert from 'node:assert/strict';
import test from 'node:test';
import { rm } from 'node:fs/promises';
import { createRuntimeEngine, createSpendLedger } from '../runtime.mjs';
import {
  createEngine, createMemoryLedger, EngineOffError, BudgetExceededError, ModelCallError, ModelAccountingError,
} from '../index.mjs';
import { loadConfig } from '../../config.mjs';
import { setSetting } from '../../store/db.mjs';
import { tempDb } from '../../../test/helpers/server.mjs';

const CLOCK = '2027-01-05';
const clockNow = () => new Date(`${CLOCK}T12:00:00.000Z`);
const ask = (extra = {}) => ({
  purpose: 'chat', system: 'Synthetic runtime test system.', messages: [{ role: 'user', content: 'Synthetic question' }],
  maxTokens: 64, ...extra,
});
const rowsSchema = { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'], additionalProperties: false };
const emptyArgs = { type: 'object', properties: {}, additionalProperties: false };

async function store(t) {
  const s = await tempDb();
  t.after(async () => { await s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  return s;
}

const configFor = (s, env = {}) => loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'fake', ...env });
const runtimeFor = async (s, env = {}) => await createRuntimeEngine({ db: s.db, config: configFor(s, env), now: clockNow });
const spendRows = async db => (await db.prepare('SELECT * FROM spend_ledger ORDER BY id').all()).map(r => ({ ...r }));

test('spend ledger maps a YYYYMM or YYYY-MM key to the stored YYYY-MM month and rejects other keys', async t => {
  const s = await store(t);
  const ledger = createSpendLedger(s.db);
  await ledger.record({ ts: '2026-12-31T23:59:00.000Z', purpose: 'job', costUsd: 1, model: 'fake', tokens: {} });
  await ledger.record({ ts: '2027-01-05T10:00:00.000Z', purpose: 'chat', costUsd: 0.25, model: 'fake', tokens: { input_tokens: 10 } });
  assert.equal(await ledger.monthSpendUsd('202701'), 0.25);
  assert.equal(await ledger.monthSpendUsd('2027-01'), 0.25);
  assert.equal(await ledger.monthSpendUsd('202612'), 1);
  assert.equal(await ledger.monthSpendUsd('202702'), 0);
  const rows = await spendRows(s.db);
  assert.deepEqual(rows.map(r => r.yyyymm), ['2026-12', '2027-01']);
  assert.deepEqual(JSON.parse(rows[1].tokens), { input_tokens: 10 });
  assert.equal(rows[1].purpose, 'chat');
  assert.equal(rows[1].cost_usd, 0.25);
  for (const bad of ['2027', '20270', '2027011', '202713', 'abcdef', '']) {
    assert.throws(async () => await ledger.monthSpendUsd(bad), TypeError, `month key ${JSON.stringify(bad)} is rejected`);
  }
});

test('runtime exposes the configured mode and the switch; off by configuration refuses', async t => {
  const s = await store(t);
  const rt = await runtimeFor(s);
  assert.equal(rt.mode, 'fake');
  assert.equal(rt.isOn(), true, 'no engine setting reads on');
  await setSetting(s.db, 'engine', { on: false });
  assert.equal(rt.isOn(), false, 'switch is re-read');
  await setSetting(s.db, 'engine', { on: true });
  assert.equal(rt.isOn(), true);

  const off = await runtimeFor(s, { FATHOM_ENGINE: 'off' });
  assert.equal(off.mode, 'off');
  assert.equal(off.isOn(), false, 'off by configuration even with the switch on');
  await assert.rejects(off.call(ask({ fake: [{ text: 'must not run' }] })), EngineOffError);
});

test('fake calls take request.fake and record spend in the month of the passed clock', async t => {
  const s = await store(t);
  const rt = await runtimeFor(s);
  // Spend in a different month does not count against the clock month's cap.
  createSpendLedger(s.db).record({ ts: '2026-11-05T09:00:00.000Z', purpose: 'chat', costUsd: 500, model: 'fake', tokens: {} });

  const first = await rt.call(ask({ systemDynamic: 'Synthetic dynamic context.', fake: [{ text: 'Scripted reply', costUsd: 0.02 }] }));
  assert.equal(first.text, 'Scripted reply');
  const rows = await spendRows(s.db);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].yyyymm, '2027-01');
  assert.ok(rows[1].ts.startsWith('2027-01-05T'), rows[1].ts);
  assert.equal(rows[1].purpose, 'chat');
  assert.equal(rows[1].model, 'fake');
  assert.equal(rows[1].cost_usd, 0.02);
  assert.equal(createSpendLedger(s.db).monthSpendUsd('202701'), 0.02);

  await assert.rejects(rt.call(ask()), ModelCallError, 'a fake call with no script fails');

  const scriptedRows = await rt.extract({ document: { type: 'text', text: 'Synthetic amount 75' }, schema: rowsSchema,
    fake: [{ text: '{"rows":[{"amount":75}]}' }] });
  assert.deepEqual(scriptedRows, [{ amount: 75 }]);
  assert.equal((await spendRows(s.db)).at(-1).purpose, 'extract');
});

test('the switch is re-read before every call: off refuses without a ledger row, on works again', async t => {
  const s = await store(t);
  const rt = await runtimeFor(s);
  assert.equal((await rt.call(ask({ fake: [{ text: 'first' }] }))).text, 'first');
  await setSetting(s.db, 'engine', { on: false });
  await assert.rejects(rt.call(ask({ fake: [{ text: 'second' }] })), EngineOffError);
  await assert.rejects(rt.extract({ document: { type: 'text', text: 'Synthetic' }, schema: rowsSchema }), EngineOffError);
  assert.equal((await spendRows(s.db)).length, 1, 'no spend while off');
  await setSetting(s.db, 'engine', { on: true });
  assert.equal((await rt.call(ask({ fake: [{ text: 'third' }] }))).text, 'third');
  assert.equal((await spendRows(s.db)).length, 2);
});

test('the cap is re-read before every call: a cap below month spend refuses, raising it works again', async t => {
  const s = await store(t);
  const rt = await runtimeFor(s);
  await rt.call(ask({ fake: [{ text: 'spent', costUsd: 0.05 }] }));
  await setSetting(s.db, 'cap', { usd: 0.01 });
  await assert.rejects(rt.call(ask({ fake: [{ text: 'must not run' }] })), BudgetExceededError);
  assert.equal((await spendRows(s.db)).length, 1);
  await setSetting(s.db, 'cap', { usd: 1 });
  assert.equal((await rt.call(ask({ fake: [{ text: 'allowed' }] }))).text, 'allowed');
});

test('the default cap is 200: spend just below it is allowed, spend at it is refused', async t => {
  const s = await store(t);
  const rt = await runtimeFor(s);
  createSpendLedger(s.db).record({ ts: `${CLOCK}T07:00:00.000Z`, purpose: 'job', costUsd: 199.5, model: 'fake', tokens: {} });
  assert.equal((await rt.call(ask({ fake: [{ text: 'under the cap', costUsd: 0.5 }] }))).text, 'under the cap');
  assert.equal(createSpendLedger(s.db).monthSpendUsd('202701'), 200);
  await assert.rejects(rt.call(ask({ fake: [{ text: 'must not run' }] })), BudgetExceededError);
});

test('createEngine: request.fake takes precedence over the queue and request.toolContext reaches the tools', async () => {
  const ledger = createMemoryLedger();
  const engine = createEngine({ mode: 'fake', ledger, now: clockNow, responses: [{ text: 'from the queue' }] });
  assert.equal((await engine.call(ask({ fake: [{ text: 'per call' }] }))).text, 'per call');
  assert.equal((await engine.call(ask())).text, 'from the queue', 'the constructor queue is untouched by a per-call script');

  const seen = [];
  const tool = { name: 'read_context', description: 'Synthetic tool that reads its context.', kind: 'read', operations: [{ name: 'read', scope: 'read' }], inputSchema: emptyArgs,
    handler: async (args, ctx) => { seen.push(ctx); return { value: 1 }; } };
  const db = { synthetic: true };
  await engine.call(ask({ tools: [tool], toolContext: { db, now: '2027-01-05T08:00:00.000Z' },
    fake: [{ toolCalls: [{ name: 'read_context', args: {} }] }, { text: 'done' }] }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].db, db);
  assert.equal(seen[0].now, '2027-01-05T08:00:00.000Z');
});

test('unknown accounting with is_error poisons the process engine: a later call below the cap is refused', async t => {
  const s = await store(t);
  const rt = await runtimeFor(s);
  assert.equal((await rt.call(ask({ fake: [{ text: 'healthy' }] }))).text, 'healthy', 'calls work before the poison');
  await assert.rejects(rt.call(ask({ fake: [{ costUsd: null, accountingUnknown: true, is_error: true }] })), ModelCallError);
  const rows = await spendRows(s.db);
  assert.equal(rows.length, 2, 'a conservative estimate is recorded');
  assert.equal(JSON.parse(rows[1].tokens).estimated, true);
  assert.ok(createSpendLedger(s.db).monthSpendUsd('202701') < 200, 'spend is still below the cap');
  await assert.rejects(rt.call(ask({ fake: [{ text: 'must not run' }] })), ModelAccountingError);
  await assert.rejects(rt.extract({ document: { type: 'text', text: 'Synthetic' }, schema: rowsSchema,
    fake: [{ text: '{"rows":[]}' }] }), ModelAccountingError);
  assert.equal(rt.isOn(), false, 'a poisoned runtime reads off');
  assert.equal((await spendRows(s.db)).length, 2, 'nothing further is spent');
});
