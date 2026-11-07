import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand } from './helpers/server.mjs';
import { twoHouseholds } from './helpers/tenancy-runtime.mjs';
import { householdArg } from '../src/platform/cli.mjs';
import { aggregatorCsv } from './helpers/ingest.mjs';

const T = { timeout: 180_000 };
const commands = ['src/jobs/plan-cli.mjs', 'src/jobs/guess-cli.mjs', 'scripts/build-your-plans.mjs', 'scripts/email-test.mjs', 'demo/seed.mjs'];

test('selectors are mandatory and ambiguous duplicate selectors are refused', () => {
  assert.throws(() => householdArg([]), { code: 'household_required' });
  assert.throws(() => householdArg(['--household', 'synthetic-a', '--household', 'synthetic-b']), { code: 'household_selector_invalid' });
  assert.deepEqual(householdArg(['--household', 'synthetic-a', '--file', 'synthetic-file']), { householdId: 'synthetic-a', rest: ['--file', 'synthetic-file'] });
});

test('operational CLIs reject missing and foreign selectors and use the selected runtime', T, async t => {
  const f = await twoHouseholds({ engine: 'off' });
  t.after(() => f.close());
  const env = { ...f.server.env, FATHOM_LIVE_EMAIL: '1', FATHOM_EMAIL_TO: f.B.admin.user.email };
  for (const cmd of commands) {
    for (const args of [[], ['--household', 'foreign-household']]) {
      const r = await runCommand(process.execPath, [cmd, ...args], { env });
      assert.equal(r.code, 1, `${cmd}: ${r.stderr}`);
      assert.match(r.stderr, args.length ? /household_unavailable/ : /household_required/);
    }
  }
  const before = f.ctx(f.A.id).db.prepare('SELECT count(*) AS n FROM job_runs').get().n;
  const plan = await runCommand(process.execPath, ['src/jobs/plan-cli.mjs', '--household', f.B.id], { env });
  assert.equal(plan.code, 3, plan.stderr);
  assert.match(plan.stderr, /paused/);
  await f.B.client.postJson('/api/household/outbound', { email: true });
  const email = await runCommand(process.execPath, ['scripts/email-test.mjs', '--household', f.B.id], { env });
  assert.equal(email.code, 0, email.stderr);
  assert.equal(readdirSync(join(f.rootOf(f.B.id), 'outbox')).length, 1);
  assert.equal(existsSync(join(f.rootOf(f.A.id), 'outbox')), false);
  assert.equal(f.ctx(f.A.id).db.prepare('SELECT count(*) AS n FROM job_runs').get().n, before);
  const seed = await runCommand(process.execPath, ['demo/seed.mjs', '--household', f.B.id], { env });
  assert.equal(seed.code, 1);
  assert.match(seed.stderr, /real/);
});

test('dump requires a session, rejects foreign context, and uploads only to its authorized household', T, async t => {
  const f = await twoHouseholds({ engine: 'off' });
  t.after(() => f.close());
  const cookieFile = join(f.root, 'session.cookie');
  const file = join(f.root, 'synthetic.csv');
  writeFileSync(cookieFile, f.A.admin.cookie, { mode: 0o600 });
  writeFileSync(file, aggregatorCsv([{ date: '2026-11-01', amount: '12.34', description: 'Synthetic groceries', number: '5550001234' }]));
  const run = (id, extra = {}) => runCommand(process.execPath, ['scripts/dump.mjs', '--household', id, f.baseUrl, file], {
    env: { FATHOM_SESSION_FILE: cookieFile, ...extra },
  });
  const foreign = await run(f.B.id);
  assert.equal(foreign.code, 1);
  assert.match(foreign.stderr, /household_context_mismatch/);
  const missing = await run(f.A.id, { FATHOM_SESSION_FILE: undefined });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /session_required/);
  const valid = await run(f.A.id);
  assert.equal(valid.code, 0, valid.stderr);
  assert.match(valid.stdout, /imported/);
  assert.equal(f.ctx(f.A.id).db.prepare('SELECT count(*) AS n FROM files').get().n, 1);
  assert.equal(f.ctx(f.B.id).db.prepare('SELECT count(*) AS n FROM files').get().n, 0);
  const mismatch = await fetch(`${f.baseUrl}/api/files`, { headers: { cookie: f.A.admin.cookie, 'x-fathom-household-id': f.B.id } });
  assert.equal(mismatch.status, 409);
});
