// Live email check (scripts/email-test.mjs, `npm run email:test`): refuses unless
// FATHOM_LIVE_EMAIL=1 and then sends nothing; with it and the dev transport it sends exactly one
// test email (one outbox file) and prints a status line that carries no body or address.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runCommand, tempDir, tempInstance, SERVER_TIMEOUT } from '../helpers/server.mjs';

const T = { timeout: SERVER_TIMEOUT };
const outboxFiles = (dir) => (existsSync(join(dir, 'outbox')) ? readdirSync(join(dir, 'outbox')).filter((f) => f.endsWith('.json')) : []);

test('without FATHOM_LIVE_EMAIL=1 it exits nonzero and sends nothing', T, async () => {
  const dir = await tempDir('fathom-live-');
  try {
    for (const live of [undefined, '0', 'yes']) {
      const r = await runCommand(process.execPath, ['scripts/email-test.mjs'], {
        env: { FATHOM_DATA: dir, FATHOM_EMAIL_TRANSPORT: 'dev', FATHOM_LIVE_EMAIL: live },
      });
      assert.notEqual(r.code, 0, `FATHOM_LIVE_EMAIL=${live}`);
      assert.equal(r.code, 2, 'refusal exit code is 2');
      assert.match(r.stderr + r.stdout, /FATHOM_LIVE_EMAIL/, 'says how to opt in');
      assert.deepEqual(outboxFiles(dir), []);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('with FATHOM_LIVE_EMAIL=1 and the dev transport it writes one outbox file and prints only a status line', T, async () => {
  const instance = await tempInstance({ mode: 'demo' });
  const dir = instance.dataDir;
  try {
    const r = await runCommand(process.execPath, ['scripts/email-test.mjs', '--household', instance.householdId], {
      env: { FATHOM_DATA: dir, FATHOM_EMAIL_TRANSPORT: 'dev', FATHOM_LIVE_EMAIL: '1' },
    });
    assert.equal(r.code, 0, r.stderr);
    const files = outboxFiles(instance.root);
    assert.equal(files.length, 1);
    const msg = JSON.parse(readFileSync(join(instance.root, 'outbox', files[0]), 'utf8'));
    const out = r.stdout + r.stderr;
    assert.match(out, /sent/i, 'prints a status');
    // No body text or html, and no address, reaches the output.
    const bodyLines = String(msg.text).split('\n').map((l) => l.trim()).filter((l) => l.length >= 12);
    for (const line of bodyLines) assert.ok(!out.includes(line), `body line not printed: ${line.slice(0, 40)}`);
    assert.ok(!out.includes('<'), 'no html printed');
    for (const addr of [msg.from, ...[msg.to].flat()]) assert.ok(!out.includes(addr), 'no address printed');
  } finally { instance.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a non-dev transport with no configuration fails with a fixed code and no stack', T, async () => {
  const instance = await tempInstance({ mode: 'demo' });
  const dir = instance.dataDir;
  try {
    const r = await runCommand(process.execPath, ['scripts/email-test.mjs', '--household', instance.householdId], {
      env: { FATHOM_DATA: dir, FATHOM_EMAIL_TRANSPORT: 'agentmail', FATHOM_LIVE_EMAIL: '1' },
    });
    assert.notEqual(r.code, 0);
    assert.match(r.stdout + r.stderr, /missing_config/);
    assert.ok(!/\n\s+at /.test(r.stdout + r.stderr), 'no stack trace');
    assert.deepEqual(outboxFiles(dir), []);
  } finally { instance.close(); rmSync(dir, { recursive: true, force: true }); }
});
