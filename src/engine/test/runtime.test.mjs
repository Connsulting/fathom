// AC1: the runtime engine over the store. One engine per process (R6) whose controls hook re-reads
// settings.engine.on and settings.cap.usd before every model round, a spend ledger over the
// spend_ledger table keyed by the store clock month (D3, D4), per-call fake scripts
// (request.fake), accounting poison that persists for the process, and a live mode that fails
// closed without a credential and never logs it.

import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntimeEngine, createSpendLedger } from '../runtime.mjs';
import {
  createEngine, createMemoryLedger, EngineOffError, BudgetExceededError, ModelCallError, ModelAccountingError,
} from '../index.mjs';
import { loadConfig } from '../../config.mjs';
import { setSetting } from '../../store/db.mjs';
import { tempDb } from '../../../test/helpers/server.mjs';

const CLOCK = '2027-01-05';
const FALLBACK_TEXT = 'The fake engine has no scripted answer for this request.';
const ask = (extra = {}) => ({
  purpose: 'chat', system: 'Synthetic runtime test system.', messages: [{ role: 'user', content: 'Synthetic question' }],
  maxTokens: 64, ...extra,
});
const rowsSchema = { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'], additionalProperties: false };
const emptyArgs = { type: 'object', properties: {}, additionalProperties: false };

async function store(t, { clock = CLOCK } = {}) {
  const s = await tempDb();
  t.after(async () => { s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  if (clock) setSetting(s.db, 'clock', clock);
  return s;
}

const configFor = (s, env = {}) => loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'fake', ...env });
const spendRows = db => db.prepare('SELECT * FROM spend_ledger ORDER BY id').all().map(r => ({ ...r }));

// Replace every console method with a recorder for the duration of the test.
function recordConsole(t) {
  const lines = [];
  for (const name of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    t.mock.method(console, name, (...args) => { lines.push(args.map(a => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' ')); });
  }
  return lines;
}

test('spend ledger maps the engine YYYYMM key to the stored YYYY-MM month and rejects other keys', async t => {
  const s = await store(t);
  const ledger = createSpendLedger(s.db);
  ledger.record({ ts: '2026-12-31T23:59:00.000Z', purpose: 'job', costUsd: 1, model: 'fake', tokens: {} });
  ledger.record({ ts: '2027-01-05T10:00:00.000Z', purpose: 'chat', costUsd: 0.25, model: 'fake', tokens: { input_tokens: 10 } });
  assert.equal(ledger.monthSpendUsd('202701'), 0.25);
  assert.equal(ledger.monthSpendUsd('202612'), 1);
  assert.equal(ledger.monthSpendUsd('202702'), 0);
  const rows = spendRows(s.db);
  assert.deepEqual(rows.map(r => r.yyyymm), ['2026-12', '2027-01']);
  assert.deepEqual(JSON.parse(rows[1].tokens), { input_tokens: 10 });
  assert.equal(rows[1].purpose, 'chat');
  assert.equal(rows[1].cost_usd, 0.25);
  for (const bad of ['2027-01', '2027', '20270', '2027011', 'abcdef', '']) {
    assert.throws(() => ledger.monthSpendUsd(bad), TypeError, `month key ${JSON.stringify(bad)} is rejected`);
  }
});

test('spend ledger recent() lists the newest rows first without token or prompt fields', async t => {
  const s = await store(t);
  const ledger = createSpendLedger(s.db);
  ledger.record({ ts: '2027-01-04T09:00:00.000Z', purpose: 'job', costUsd: 0.5, model: 'fake', tokens: { input_tokens: 3 } });
  ledger.record({ ts: '2027-01-05T09:00:00.000Z', purpose: 'chat', costUsd: 0.75, model: 'fake', tokens: { input_tokens: 4 } });
  const recent = ledger.recent();
  assert.equal(recent.length, 2);
  assert.deepEqual(Object.keys(recent[0]).sort(), ['costUsd', 'id', 'model', 'purpose', 'ts']);
  assert.equal(recent[0].purpose, 'chat');
  assert.equal(recent[0].costUsd, 0.75);
  assert.equal(recent[1].purpose, 'job');
  assert.equal(ledger.recent(1).length, 1);
  assert.equal(ledger.recent(1)[0].purpose, 'chat');
});

test('runtime exposes the configured mode, the switch, the cap with a 200 default, and the store clock', async t => {
  const s = await store(t);
  const rt = createRuntimeEngine({ db: s.db, config: configFor(s) });
  assert.equal(rt.mode, 'fake');
  assert.equal(typeof rt.ledger.monthSpendUsd, 'function');
  assert.equal(typeof rt.ledger.record, 'function');
  assert.equal(rt.isOn(), true, 'no engine setting reads on');
  assert.equal(rt.capUsd(), 200, 'no cap setting reads the 200 default');
  assert.match(rt.now(), /^2027-01-05T\d{2}:\d{2}:\d{2}/);

  setSetting(s.db, 'cap', { usd: 12.5 });
  assert.equal(rt.capUsd(), 12.5, 'cap is re-read');
  setSetting(s.db, 'cap', { usd: 'lots' });
  assert.equal(rt.capUsd(), 200, 'a non-numeric cap falls back to 200');
  setSetting(s.db, 'engine', { on: false });
  assert.equal(rt.isOn(), false, 'switch is re-read');
  setSetting(s.db, 'engine', { on: true });
  assert.equal(rt.isOn(), true);

  const off = createRuntimeEngine({ db: s.db, config: configFor(s, { FATHOM_ENGINE: 'off' }) });
  assert.equal(off.mode, 'off');
  assert.equal(off.isOn(), false, 'off by configuration even with the switch on');
  await assert.rejects(off.call(ask({ fake: [{ text: 'must not run' }] })), EngineOffError);

  const overridden = createRuntimeEngine({ db: s.db, config: configFor(s, { FATHOM_CLOCK: '2027-02-10' }) });
  assert.match(overridden.now(), /^2027-02-10T\d{2}:\d{2}/, 'FATHOM_CLOCK overrides settings.clock');
});

test('runtime now() is the current time when no clock is set', async t => {
  const s = await store(t, { clock: null });
  const rt = createRuntimeEngine({ db: s.db, config: configFor(s) });
  const now = Date.parse(rt.now());
  assert.ok(Number.isFinite(now));
  assert.ok(Math.abs(now - Date.now()) < 60000);
});

test('fake calls take request.fake, record spend in the clock month, and fall back to a default script', async t => {
  const s = await store(t);
  const rt = createRuntimeEngine({ db: s.db, config: configFor(s) });
  // Spend in a different real-world month does not count against the clock month's cap.
  rt.ledger.record({ ts: '2026-11-05T09:00:00.000Z', purpose: 'chat', costUsd: 500, model: 'fake', tokens: {} });

  const first = await rt.call(ask({ systemDynamic: 'Synthetic dynamic context.', fake: [{ text: 'Scripted reply', costUsd: 0.02 }] }));
  assert.equal(first.text, 'Scripted reply');
  const rows = spendRows(s.db);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].yyyymm, '2027-01');
  assert.ok(rows[1].ts.startsWith('2027-01-05T'), rows[1].ts);
  assert.equal(rows[1].purpose, 'chat');
  assert.equal(rows[1].model, 'fake');
  assert.equal(rows[1].cost_usd, 0.02);
  assert.equal(rt.ledger.monthSpendUsd('202701'), 0.02);

  const fallback = await rt.call(ask());
  assert.equal(fallback.text, FALLBACK_TEXT);

  const scriptedRows = await rt.extract({ document: { type: 'text', text: 'Synthetic amount 75' }, schema: rowsSchema,
    fake: [{ text: '{"rows":[{"amount":75}]}' }] });
  assert.deepEqual(scriptedRows, [{ amount: 75 }]);
  assert.deepEqual(await rt.extract({ document: { type: 'text', text: 'Synthetic' }, schema: rowsSchema }), []);
  const purposes = spendRows(s.db).map(r => r.purpose);
  assert.deepEqual(purposes.slice(-2), ['extract', 'extract']);
});

test('the switch is re-read before every call: off refuses without a ledger row, on works again', async t => {
  const s = await store(t);
  const rt = createRuntimeEngine({ db: s.db, config: configFor(s) });
  assert.equal((await rt.call(ask({ fake: [{ text: 'first' }] }))).text, 'first');
  setSetting(s.db, 'engine', { on: false });
  await assert.rejects(rt.call(ask({ fake: [{ text: 'second' }] })), EngineOffError);
  await assert.rejects(rt.extract({ document: { type: 'text', text: 'Synthetic' }, schema: rowsSchema }), EngineOffError);
  assert.equal(spendRows(s.db).length, 1, 'no spend while off');
  setSetting(s.db, 'engine', { on: true });
  assert.equal((await rt.call(ask({ fake: [{ text: 'third' }] }))).text, 'third');
  assert.equal(spendRows(s.db).length, 2);
});

test('the cap is re-read before every call: a cap below month spend refuses, raising it works again', async t => {
  const s = await store(t);
  const rt = createRuntimeEngine({ db: s.db, config: configFor(s) });
  await rt.call(ask({ fake: [{ text: 'spent', costUsd: 0.05 }] }));
  setSetting(s.db, 'cap', { usd: 0.01 });
  await assert.rejects(rt.call(ask({ fake: [{ text: 'must not run' }] })), BudgetExceededError);
  assert.equal(spendRows(s.db).length, 1);
  setSetting(s.db, 'cap', { usd: 1 });
  assert.equal((await rt.call(ask({ fake: [{ text: 'allowed' }] }))).text, 'allowed');
});

test('the default cap is 200: spend just below it is allowed, spend at it is refused', async t => {
  const s = await store(t);
  const rt = createRuntimeEngine({ db: s.db, config: configFor(s) });
  rt.ledger.record({ ts: `${CLOCK}T07:00:00.000Z`, purpose: 'job', costUsd: 199.5, model: 'fake', tokens: {} });
  assert.equal((await rt.call(ask({ fake: [{ text: 'under the cap', costUsd: 0.5 }] }))).text, 'under the cap');
  assert.equal(rt.ledger.monthSpendUsd('202701'), 200);
  await assert.rejects(rt.call(ask({ fake: [{ text: 'must not run' }] })), BudgetExceededError);
});

test('a tool round that switches the engine off stops the next round', async t => {
  const s = await store(t);
  const rt = createRuntimeEngine({ db: s.db, config: configFor(s) });
  let calls = 0;
  const tool = { name: 'flip_switch', description: 'Synthetic tool that turns the engine off.', scope: 'read', inputSchema: emptyArgs,
    handler: async () => { calls++; setSetting(s.db, 'engine', { on: false }); return { value: 1 }; } };
  await assert.rejects(rt.call(ask({ tools: [tool], fake: [
    { toolCalls: [{ name: 'flip_switch', args: {} }], costUsd: 0.01 },
    { text: 'must not run', costUsd: 0.01 },
  ] })), EngineOffError);
  assert.equal(calls, 1);
  assert.equal(spendRows(s.db).length, 1, 'only the tool round is recorded');
});

test('a tool round that lowers the cap below spend stops the next round', async t => {
  const s = await store(t);
  const rt = createRuntimeEngine({ db: s.db, config: configFor(s) });
  let calls = 0;
  const tool = { name: 'lower_cap', description: 'Synthetic tool that lowers the cap.', scope: 'read', inputSchema: emptyArgs,
    handler: async () => { calls++; setSetting(s.db, 'cap', { usd: 0.001 }); return { value: 1 }; } };
  await assert.rejects(rt.call(ask({ tools: [tool], fake: [
    { toolCalls: [{ name: 'lower_cap', args: {} }], costUsd: 0.01 },
    { text: 'must not run', costUsd: 0.01 },
  ] })), BudgetExceededError);
  assert.equal(calls, 1);
  assert.equal(spendRows(s.db).length, 1);
});

test('createEngine controls hook gates each round and request.fake takes precedence over the queue', async () => {
  const now = () => new Date('2027-01-05T12:00:00Z');
  const ledger = createMemoryLedger();
  let state = { on: true, capUsd: 200 };
  const engine = createEngine({ mode: 'fake', ledger, now, controls: () => state, responses: [{ text: 'from the queue' }] });
  assert.equal((await engine.call(ask({ fake: [{ text: 'per call' }] }))).text, 'per call');
  assert.equal((await engine.call(ask())).text, 'from the queue', 'the constructor queue is untouched by a per-call script');
  state = { on: false, capUsd: 200 };
  await assert.rejects(engine.call(ask({ fake: [{ text: 'must not run' }] })), EngineOffError);
  state = { on: true, capUsd: 0 };
  await assert.rejects(engine.call(ask({ fake: [{ text: 'must not run' }] })), BudgetExceededError);
  assert.equal(ledger.entries.length, 2);
  state = { on: true, capUsd: 200 };
  assert.equal((await engine.call(ask({ fake: [{ text: 'back on' }] }))).text, 'back on');
});

test('unknown accounting with is_error poisons the process engine: a later call below the cap is refused', async t => {
  const s = await store(t);
  const rt = createRuntimeEngine({ db: s.db, config: configFor(s) });
  assert.equal((await rt.call(ask({ fake: [{ text: 'healthy' }] }))).text, 'healthy', 'calls work before the poison');
  await assert.rejects(rt.call(ask({ fake: [{ costUsd: null, accountingUnknown: true, is_error: true }] })), ModelCallError);
  const rows = spendRows(s.db);
  assert.equal(rows.length, 2, 'a conservative estimate is recorded');
  assert.equal(JSON.parse(rows[1].tokens).estimated, true);
  assert.ok(rt.ledger.monthSpendUsd('202701') < rt.capUsd(), 'spend is still below the cap');
  await assert.rejects(rt.call(ask({ fake: [{ text: 'must not run' }] })), ModelAccountingError);
  await assert.rejects(rt.extract({ document: { type: 'text', text: 'Synthetic' }, schema: rowsSchema,
    fake: [{ text: '{"rows":[]}' }] }), ModelAccountingError);
  assert.equal(spendRows(s.db).length, 2, 'nothing further is spent');
});

test('live mode without a credential file fails closed with ModelCallError and logs nothing', async t => {
  const s = await store(t);
  const lines = recordConsole(t);
  const rt = createRuntimeEngine({ db: s.db, config: configFor(s, { FATHOM_ENGINE: 'live' }) });
  assert.equal(rt.mode, 'live');
  assert.equal(rt.isOn(), true);
  await assert.rejects(rt.call(ask()), err => err instanceof ModelCallError && /no credential/i.test(err.message));
  await assert.rejects(rt.extract({ document: { type: 'text', text: 'Synthetic' }, schema: rowsSchema }), ModelCallError);
  assert.equal(spendRows(s.db).length, 0);
  assert.deepEqual(lines, []);
});

test('live mode with an unreadable credential file fails closed and never echoes its contents', async t => {
  const s = await store(t);
  const secret = 'synthetic-credential-value-not-real';
  const file = join(s.dataDir, 'credential');
  await writeFile(file, secret);
  await chmod(file, 0o644);
  const lines = recordConsole(t);
  const rt = createRuntimeEngine({ db: s.db, config: configFor(s, { FATHOM_ENGINE: 'live', FATHOM_CLAUDE_CREDENTIAL_FILE: file }) });
  await assert.rejects(rt.call(ask()), err => err instanceof ModelCallError && !String(err.message).includes(secret));
  assert.equal(spendRows(s.db).length, 0);
  assert.ok(lines.every(line => !line.includes(secret)), 'no console output carries the credential');
});
