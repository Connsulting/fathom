import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { twoHouseholds, writePrivate } from './helpers/tenancy-runtime.mjs';
import { runCommand, tempInstance } from './helpers/server.mjs';
import { aggregatorCsv } from './helpers/ingest.mjs';
import { householdArg } from '../src/platform/cli.mjs';
import { seedDemo } from '../demo/seed.mjs';

const commands = ['src/jobs/plan-cli.mjs', 'src/jobs/guess-cli.mjs', 'scripts/build-your-plans.mjs', 'scripts/email-test.mjs', 'demo/seed.mjs'];
const envOf = fx => ({ ...fx.server.env, FATHOM_ENGINE: 'off', FATHOM_LIVE_EMAIL: '1' });
const run = (entry, argv, env) => runCommand(process.execPath, [entry, ...argv], { env });

test('selectors refuse duplicates and malformed values', () => {
  for (const argv of [[], ['--household'], ['--household', '../other'], ['--household', 'alpha', '--household', 'bravo']]) {
    assert.throws(() => householdArg(argv), e => /^household_/.test(e.code));
  }
  assert.deepEqual(householdArg(['--household', 'hh_synthetic', '--file', 'f-synthetic']), { householdId: 'hh_synthetic', rest: ['--file', 'f-synthetic'] });
});

test('operational CLIs require registered household selectors without touching another store', { timeout: 60000 }, async () => {
  const fx = await twoHouseholds();
  try {
    for (const entry of commands) {
      for (const args of [[], ['--household', 'hh_unknown'], ['--household', fx.B.id, '--household', fx.A.id]]) {
        const r = await run(entry, args, envOf(fx));
        assert.notEqual(r.code, 0, `${entry} refuses selector`);
        assert.match(r.stdout + r.stderr, /household_(required|invalid|unavailable)/, entry);
      }
    }
    const a = fx.ctx(fx.A.id); const b = fx.ctx(fx.B.id);
    await a.scheduler.stop(); await b.scheduler.stop();
    for (const entry of ['src/jobs/plan-cli.mjs', 'src/jobs/guess-cli.mjs', 'scripts/build-your-plans.mjs']) {
      const r = await run(entry, ['--household', fx.A.id], envOf(fx));
      assert.equal(r.code, 0, `${entry}: ${r.stderr}`);
    }
    assert.ok(a.db.prepare('SELECT count(*) AS n FROM job_runs').get().n > 0);
    assert.equal(b.db.prepare('SELECT count(*) AS n FROM job_runs').get().n, 0);
    const mail = await run('scripts/email-test.mjs', ['--household', fx.A.id], envOf(fx));
    assert.equal(mail.code, 0, mail.stderr);
    assert.equal(readdirSync(join(a.root, 'outbox')).filter(n => n.endsWith('.json')).length, 1);
    assert.equal(existsSync(join(b.root, 'outbox')), false);
    const paused = await run('scripts/email-test.mjs', ['--household', fx.B.id], envOf(fx));
    assert.notEqual(paused.code, 0);
    assert.match(paused.stderr, /paused/);
  } finally { await fx.close(); }
});

test('seed CLI resets only its explicit demo household and refuses missing or foreign selectors', { timeout: 30000 }, async () => {
  const fx = await tempInstance({ mode: 'demo', init: seedDemo });
  try {
    fx.db.prepare("UPDATE settings SET value = 'false' WHERE key = 'engine.on'").run();
    for (const args of [[], ['--household', 'hh_unknown']]) {
      const r = await run('demo/seed.mjs', args, { FATHOM_DATA: fx.dataDir });
      assert.notEqual(r.code, 0);
    }
    const r = await run('demo/seed.mjs', ['--household', fx.householdId], { FATHOM_DATA: fx.dataDir });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fx.db.prepare('SELECT count(*) AS n FROM accounts').get().n > 0);
  } finally { fx.close(); rmSync(fx.dataDir, { recursive: true, force: true }); }
});

test('dump uses a session with context assertions and refuses foreign, expired or absent authorization', { timeout: 30000 }, async () => {
  const fx = await twoHouseholds();
  try {
    const input = join(fx.root, 'synthetic.csv');
    writeFileSync(input, aggregatorCsv([{ date: '2026-11-01', amount: '14.25', description: 'Synthetic purchase', number: '5550012345' }]));
    const sessionFile = writePrivate(join(fx.root, 'session.json'), JSON.stringify({ cookie: fx.A.admin.cookie, householdId: fx.A.id, contextVersion: 1 }));
    const env = { FATHOM_SESSION_FILE: sessionFile };
    for (const [args, over] of [[[], env], [['--household', fx.B.id], env], [['--household', fx.A.id], { FATHOM_SESSION_FILE: undefined }]]) {
      const r = await run('scripts/dump.mjs', [...args, fx.baseUrl, input], over);
      assert.notEqual(r.code, 0, 'unauthorized upload refused');
    }
    const r = await run('scripts/dump.mjs', ['--household', fx.A.id, fx.baseUrl, input], env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fx.ctx(fx.A.id).db.prepare('SELECT count(*) AS n FROM files').get().n, 1);
    assert.equal(fx.ctx(fx.B.id).db.prepare('SELECT count(*) AS n FROM files').get().n, 0);
    fx.store.revokeSession(fx.A.admin.token);
    const expired = await run('scripts/dump.mjs', ['--household', fx.A.id, fx.baseUrl, input], env);
    assert.notEqual(expired.code, 0);
    for (const secret of [fx.A.admin.token, 'Synthetic purchase', '14.25']) assert.ok(!(r.stdout + r.stderr + expired.stdout + expired.stderr).includes(secret));
  } finally { await fx.close(); }
});
