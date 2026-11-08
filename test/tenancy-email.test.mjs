import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { twoHouseholds, enrollSession, writePrivate } from './helpers/tenancy-runtime.mjs';
import { createHouseholdTransport } from '../src/email/transport.mjs';
import { JOBS } from '../src/jobs/scheduler.mjs';

const options = { timeout: 120000 };
const messages = async root => {
  const dir = join(root, 'outbox');
  const files = await readdir(dir).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  return Promise.all(files.filter(f => f.endsWith('.json')).map(async f => JSON.parse(await readFile(join(dir, f), 'utf8'))));
};
async function subscribe(hh, rows) {
  const r = await hh.client.postJson('/api/email/subscriptions', { subscriptions: rows });
  assert.equal(r.status, 200, r.text);
  return r.json;
}
const row = (userId, subscribed = true) => ({ userId, subscribed });
async function enable(hh) {
  assert.equal((await hh.client.postJson('/api/household/outbound', { email: true })).status, 200);
}

test('manual and periodic mail, preview, history, subscriptions and outbox are household local', options, async () => {
  const fx = await twoHouseholds({ extra: { FATHOM_PUBLIC_URL: 'https://app.example.test' } });
  try {
    for (const hh of [fx.A, fx.B]) await fx.ctx(hh.id).scheduler.stop();
    await enable(fx.A); await enable(fx.B);
    await subscribe(fx.A, [row(fx.A.admin.user.id)]);
    await subscribe(fx.B, [row(fx.B.admin.user.id)]);
    for (const [hh, marker] of [[fx.A, 'Alpha private milestone'], [fx.B, 'Bravo private milestone']]) {
      fx.ctx(hh.id).db.prepare(`INSERT INTO recs (id, pack_id, status, title, raw) VALUES ('colliding-rec', 'cash', 'open', ?, ?)`)
        .run(marker, JSON.stringify({ id: 'colliding-rec', title: marker, status: 'open', waitingOn: 'owner' }));
      const preview = await hh.client.request({ path: '/api/email' });
      assert.equal(preview.status, 200, preview.text);
      assert.match(preview.json.preview.text, new RegExp(marker));
      assert.ok(!preview.text.includes(hh === fx.A ? 'Bravo private milestone' : 'Alpha private milestone'));
      assert.match(preview.json.preview.text, new RegExp(`household=${hh.id}`));
      const manual = await hh.client.postJson('/api/email/brief', {});
      assert.equal(manual.json.send.status, 'sent', manual.text);
      const periodic = await fx.ctx(hh.id).scheduler.runNow('brief-email');
      assert.equal(periodic.status, 'ok', JSON.stringify(periodic));
      const mail = await messages(fx.rootOf(hh.id));
      assert.equal(mail.length, 2);
      assert.ok(mail.every(m => m.to.length === 1 && m.to[0] === hh.admin.user.email));
      assert.ok(mail.every(m => m.text.includes(marker) && m.text.includes(`household=${hh.id}`)));
      const history = await hh.client.request({ path: '/api/email' });
      assert.equal(history.json.history.length, 2);
    }
    const dual = await enrollSession(fx.platform, fx.A.id, 'extra-member@example.test');
    await subscribe(fx.A, [row(dual.user.id)]);
    assert.equal((await fx.A.client.postJson('/api/email/test', {})).json.send.recipients, 2);
    const mail = (await messages(fx.rootOf(fx.A.id))).slice(2);
    assert.equal(mail.length, 2);
    assert.ok(mail.every(m => m.to.length === 1));
    assert.deepEqual((await messages(fx.rootOf(fx.B.id))).length, 2);
    const foreign = await fx.A.client.postJson('/api/email/subscriptions', { subscriptions: [row(fx.B.admin.user.id)] });
    assert.equal(foreign.status, 400);
    const memberClient = (await import('./helpers/server.mjs')).sessionClient(fx.baseUrl, dual);
    assert.equal((await memberClient.postJson('/api/email/subscriptions', { subscriptions: [row(dual.user.id, false)] })).status, 403);
    await subscribe(fx.A, [row(dual.user.id, false)]);
    fx.store.removeMember(fx.A.id, dual.user.id, { actorId: fx.A.admin.user.id });
    assert.equal((await fx.A.client.postJson('/api/email/test', {})).json.send.recipients, 1);
    for (const path of [`/households/${fx.A.id}/outbox/`, `/outbox/`]) {
      assert.notEqual((await fx.A.client.request({ path })).status, 200);
    }
  } finally { await fx.close(); }
});

test('original verified recipients and cadence survive migration, global routing stops after enrollment', options, async () => {
  const fx = await twoHouseholds();
  try {
    await fx.ctx(fx.A.id).scheduler.stop();
    await enable(fx.A);
    const first = await fx.A.client.postJson('/api/email/test', {});
    assert.equal(first.json.send.status, 'sent', first.text);
    assert.deepEqual((await messages(fx.rootOf(fx.A.id)))[0].to, ['both-member@example.test']);
    const monthly = JOBS.find(j => j.id === 'brief-email');
    assert.deepEqual(monthly.schedule, { every: 'month', day: 1, hour: 7 });
    const b = await fx.B.client.postJson('/api/email/test', {});
    assert.equal(b.json.send.status, 'failed');
    await subscribe(fx.B, [row(fx.B.admin.user.id)]); await enable(fx.B);
    assert.equal((await fx.B.client.postJson('/api/email/test', {})).json.send.status, 'sent');
    assert.deepEqual((await messages(fx.rootOf(fx.B.id)))[0].to, [fx.B.admin.user.email]);
  } finally { await fx.close(); }
});

test('removal during credential loading is blocked at the real HTTP mail transport boundary', options, async () => {
  const fx = await twoHouseholds();
  const received = [];
  const sink = createServer(async (req, res) => {
    let body = ''; for await (const bytes of req) body += bytes;
    received.push(JSON.parse(body)); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"synthetic-message"}');
  });
  await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
  try {
    const hh = fx.ctx(fx.A.id); await hh.scheduler.stop(); await enable(fx.A);
    const member = await enrollSession(fx.platform, fx.A.id, 'recipient@example.test');
    await subscribe(fx.A, [row(member.user.id)]);
    const credential = writePrivate(join(fx.root, 'mail-key'), 'synthetic-mail-key');
    const config = { ...hh.config, emailTransport: 'resend', emailFrom: 'sender@example.test', emailCredentialFile: credential };
    let remove = false;
    const transport = createHouseholdTransport(config, {
      household: hh, outboxDir: join(hh.root, 'outbox'), outbound: hh.outbound,
      recipients: hh.emailRecipients,
      readFile: async file => {
        const contents = await readFile(file, 'utf8');
        if (remove) fx.store.removeMember(fx.A.id, member.user.id, { actorId: fx.A.admin.user.id });
        return contents;
      },
      // Resend wire shape: https://resend.com/docs/api-reference/emails/send-email
      fetch: (_url, init) => fetch(`http://127.0.0.1:${sink.address().port}`, init),
    });
    const message = { subject: 'Synthetic private brief', text: 'Only Alpha', html: '<p>Only Alpha</p>' };
    assert.equal((await transport.send(message)).recipients, 1);
    assert.deepEqual(received[0].to, ['recipient@example.test']);
    remove = true;
    await assert.rejects(transport.send(message), e => e.code === 'recipient_unverified');
    assert.equal(received.length, 1);
  } finally { await new Promise(resolve => sink.close(resolve)); await fx.close(); }
});
