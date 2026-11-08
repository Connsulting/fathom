import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { twoHouseholds, enrollSession, writePrivate, sideHousehold } from './helpers/tenancy-runtime.mjs';
import { createHouseholdTransport, createEnrollmentTransport } from '../src/email/transport.mjs';
import { JOBS } from '../src/jobs/scheduler.mjs';
import { mapSeries } from '../src/shared/series.mjs';

const options = { timeout: 120000 };
const messages = async root => {
  const dir = join(root, 'outbox');
  const files = await readdir(dir).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  return Promise.all(await mapSeries(files.sort().filter(f => f.endsWith('.json')), async f => JSON.parse(await readFile(join(dir, f), 'utf8'))));
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
  const fx = await twoHouseholds();
  try {
    for (const hh of [fx.A, fx.B]) await fx.ctx(hh.id).scheduler.tick();
    await enable(fx.A); await enable(fx.B);
    await subscribe(fx.A, [row(fx.A.admin.user.id)]);
    await subscribe(fx.B, [row(fx.B.admin.user.id)]);
    for (const [hh, marker] of [[fx.A, 'Alpha private milestone'], [fx.B, 'Bravo private milestone']]) {
      await fx.ctx(hh.id).db.prepare(`INSERT INTO recs (id, pack_id, status, waiting_on, updated_at, def) VALUES ('colliding-rec', 'cash', 'proposed', 'owner', '2026-11-01', ?)`)
        .run(JSON.stringify({ id: 'colliding-rec', title: marker, domain: 'data', summary: marker }));
      const preview = await hh.client.request({ path: '/api/email' });
      assert.equal(preview.status, 200, preview.text);
      assert.match(preview.json.preview.text, new RegExp(marker));
      assert.ok(!preview.text.includes(hh === fx.A ? 'Bravo private milestone' : 'Alpha private milestone'));
      assert.match(preview.json.preview.text, new RegExp(`household=${hh.id}`));
      const manual = await hh.client.postJson('/api/email/brief', {});
      assert.equal(manual.json.send.status, 'sent', manual.text);
      await hh.client.postJson('/api/household/outbound', { jobs: true });
      const periodic = await fx.ctx(hh.id).scheduler.runNow('brief-email');
      assert.equal(periodic.status, 'ok', JSON.stringify(periodic));
      const mail = await messages(fx.rootOf(hh.id));
      assert.equal(mail.length, 2);
      assert.ok(mail.every(m => m.to.length === 1 && m.to[0] === hh.admin.user.email));
      assert.ok(mail.every(m => m.text.includes(marker) && m.text.includes(`household=${hh.id}`)));
      await fx.ctx(hh.id).db.prepare("UPDATE recs SET window_close = ? WHERE id = 'colliding-rec'").run(fx.ctx(hh.id).config.clock);
      assert.equal((await fx.ctx(hh.id).scheduler.runNow('deadline-alerts')).status, 'ok');
      const alerts = await messages(fx.rootOf(hh.id));
      assert.equal(alerts.length, 3);
      assert.ok(alerts[2].text.includes(marker) && alerts[2].text.includes(`household=${hh.id}`));
      assert.equal((await fx.ctx(hh.id).scheduler.runNow('deadline-alerts')).status, 'ok');
      assert.equal((await messages(fx.rootOf(hh.id))).length, 3, 'local alert dedupe');
      const history = await hh.client.request({ path: '/api/email' });
      assert.equal(history.json.history.filter(r => r.status === 'sent').length, 3);
    }
    assert.ok((await messages(fx.dataDir)).some(m => m.to.includes(fx.B.admin.user.email)), 'enrollment is platform-private');
    const dual = await enrollSession(fx.platform, fx.A.id, 'extra-member@example.test');
    await subscribe(fx.A, [row(fx.A.admin.user.id), row(dual.user.id)]);
    await fx.store.setRole(fx.A.id, dual.user.id, 'admin', { actorId: fx.A.admin.user.id });
    assert.equal((await fx.A.client.request({ path: '/api/email/subscriptions' })).json.subscriptions.find(r => r.userId === dual.user.id).subscribed, true);
    await fx.store.setRole(fx.A.id, dual.user.id, 'member', { actorId: fx.A.admin.user.id });
    assert.equal((await fx.A.client.postJson('/api/email/test', {})).json.send.recipients, 2);
    const mail = (await messages(fx.rootOf(fx.A.id))).slice(3);
    assert.equal(mail.length, 2);
    assert.ok(mail.every(m => m.to.length === 1));
    assert.deepEqual((await messages(fx.rootOf(fx.B.id))).length, 3);
    const pending = fx.store.invite(fx.A.id, 'pending@example.test');
    assert.equal((await fx.A.client.postJson('/api/email/subscriptions', { subscriptions: [row(pending.user.id)] })).status, 400);
    const foreign = await fx.A.client.postJson('/api/email/subscriptions', { subscriptions: [row(fx.B.admin.user.id)] });
    assert.equal(foreign.status, 400);
    assert.equal((await fx.A.client.request({ path: '/api/email/subscriptions' })).json.subscriptions.filter(r => r.subscribed).length, 2);
    const memberClient = (await import('./helpers/server.mjs')).sessionClient(fx.baseUrl, dual);
    assert.equal((await memberClient.postJson('/api/email/subscriptions', { subscriptions: [row(dual.user.id, false)] })).status, 403);
    await subscribe(fx.A, [row(fx.A.admin.user.id), row(dual.user.id, false)]);
    await fx.store.removeMember(fx.A.id, dual.user.id, { actorId: fx.A.admin.user.id });
    assert.equal((await fx.A.client.postJson('/api/email/test', {})).json.send.recipients, 1);
    for (const path of [`/households/${fx.A.id}/outbox/`, `/outbox/`]) {
      const response = await fx.A.client.request({ path });
      assert.ok(!response.text.includes('Alpha private milestone') && !response.text.includes('sender@example.test'));
      assert.equal(response.json, null, 'private outbox is never served as JSON');
    }
  } finally { await fx.close(); }
});

test('original verified recipients and cadence survive migration, global routing stops after enrollment', options, async () => {
  const fx = await twoHouseholds();
  try {
    await fx.ctx(fx.A.id).scheduler.tick();
    await enable(fx.A);
    const first = await fx.A.client.postJson('/api/email/test', {});
    assert.equal(first.json.send.status, 'sent', first.text);
    assert.deepEqual((await messages(fx.rootOf(fx.A.id)))[0].to, ['both-member@example.test']);
    await fx.store.removeMember(fx.A.id, fx.dual.user.id, { actorId: fx.A.admin.user.id });
    const rejoined = await enrollSession(fx.platform, fx.A.id, 'both-member@example.test');
    assert.equal(rejoined.user.id, fx.dual.user.id, 'membership in the other household retains the global user');
    assert.equal((await fx.A.client.postJson('/api/email/test', {})).json.send.errorCode, 'recipient_unverified');
    assert.equal((await messages(fx.rootOf(fx.A.id))).length, 1);
    await subscribe(fx.A, [row(rejoined.user.id)]);
    assert.equal((await fx.A.client.postJson('/api/email/test', {})).json.send.status, 'sent');
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
    received.push({ ...JSON.parse(body), idempotencyKey: req.headers['idempotency-key'] }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"synthetic-message"}');
  });
  await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
  try {
    const hh = fx.ctx(fx.A.id); await hh.scheduler.tick(); await enable(fx.A);
    const member = await enrollSession(fx.platform, fx.A.id, 'recipient@example.test');
    await subscribe(fx.A, [row(member.user.id)]);
    const credential = writePrivate(join(fx.root, 'mail-key'), 'synthetic-mail-key');
    const config = { ...hh.config, emailTransport: 'resend', emailFrom: 'sender@example.test', emailCredentialFile: credential };
    let remove = false;
    const transport = createHouseholdTransport(config, {
      outboxDir: join(hh.root, 'outbox'), outbound: hh.outbound,
      recipients: hh.emailRecipients,
      readFile: async file => {
        const contents = await readFile(file, 'utf8');
        if (remove) await fx.store.removeMember(fx.A.id, member.user.id, { actorId: fx.A.admin.user.id });
        return contents;
      },
      // Resend wire shape: https://resend.com/docs/api-reference/emails/send-email
      fetch: (_url, init) => fetch(`http://127.0.0.1:${sink.address().port}`, init),
    });
    const message = { subject: 'Synthetic private brief', text: 'Only Alpha', html: '<p>Only Alpha</p>' };
    assert.equal((await transport.send(message)).recipients, 1);
    assert.deepEqual(received[0].to, ['recipient@example.test']);
    assert.ok(received[0].idempotencyKey.includes(fx.A.id));
    const enrollment = createEnrollmentTransport({ ...config, emailTo: null, emailToFile: null }, {
      fetch: (_url, init) => fetch(`http://127.0.0.1:${sink.address().port}`, init),
    });
    await assert.rejects(async () => enrollment.send(message), e => e.code === 'missing_config');
    await enrollment.send({ ...message, to: 'pending@example.test' });
    assert.deepEqual(received[1].to, ['pending@example.test']);
    remove = true;
    await assert.rejects(transport.send(message), e => e.code === 'recipient_unverified');
    assert.equal(received.length, 2);
  } finally { await new Promise(resolve => sink.close(resolve)); await fx.close(); }
});

test('unverified legacy recipients pause delivery with an admin-visible code, then explicit subscriptions recover', options, async () => {
  const fx = await twoHouseholds({ extra: { FATHOM_EMAIL_TO: 'outsider@example.test' } });
  try {
    await fx.ctx(fx.A.id).scheduler.tick();
    await enable(fx.A);
    const status = await fx.A.client.request({ path: '/api/household/outbound' });
    assert.equal(status.json.outbound.email.reason, 'recipient_unverified');
    const email = await fx.A.client.request({ path: '/api/email' });
    assert.equal(email.json.status.state, 'recipient_unverified');
    assert.equal(email.json.status.skippedRecipients, 1);
    const refused = await fx.A.client.postJson('/api/email/brief', {});
    assert.equal(refused.json.send.errorCode, 'recipient_unverified');
    assert.equal((await messages(fx.rootOf(fx.A.id))).length, 0);
    await subscribe(fx.A, [row(fx.A.admin.user.id)]);
    assert.equal((await fx.A.client.postJson('/api/email/brief', {})).json.send.status, 'sent');
    assert.deepEqual((await messages(fx.rootOf(fx.A.id)))[0].to, [fx.A.admin.user.email]);
  } finally { await fx.close(); }
});

test('legacy import subscribes matching members, reports skipped recipients and runs once', options, async () => {
  const fx = await twoHouseholds({ extra: { FATHOM_EMAIL_TO: 'alpha-admin@example.test,outsider@example.test' } });
  let reopened;
  try {
    await fx.ctx(fx.A.id).scheduler.tick();
    await enable(fx.A);
    const before = (await messages(fx.rootOf(fx.A.id))).length;
    const sent = await fx.A.client.postJson('/api/email/brief', {});
    assert.equal(sent.json.send.status, 'sent', sent.text);
    assert.equal(sent.json.send.recipients, 1);
    const mail = await messages(fx.rootOf(fx.A.id));
    assert.equal(mail.length, before + 1);
    assert.ok(mail.every(m => m.to.length === 1 && m.to[0] === fx.A.admin.user.email));
    const email = await fx.A.client.request({ path: '/api/email' });
    assert.equal(email.json.status.state, 'dev');
    assert.equal(email.json.status.recipients, 1);
    assert.equal(email.json.status.skippedRecipients, 1);
    assert.ok(!JSON.stringify(email.json.status).includes('outsider@example.test'));
    const outsider = await enrollSession(fx.platform, fx.A.id, 'outsider@example.test');
    const subscriptions = await fx.A.client.request({ path: '/api/email/subscriptions' });
    assert.equal(subscriptions.json.subscriptions.find(r => r.userId === outsider.user.id).subscribed, false);
    reopened = await sideHousehold({ dataDir: fx.dataDir, env: { ...fx.server.env, FATHOM_EMAIL_TO: 'outsider@example.test' }, householdId: fx.A.id });
    const status = await reopened.household.emailRecipients.status();
    assert.equal(status.skippedRecipients, 1, 'the skipped count survives a fresh runtime');
    assert.equal(status.recipients, 1);
    assert.deepEqual((await reopened.household.emailRecipients.resolve()).map(r => r.email), [fx.A.admin.user.email]);
    assert.equal((await fx.A.client.postJson('/api/email/test', {})).json.send.recipients, 1);
    assert.ok((await messages(fx.rootOf(fx.A.id))).every(m => m.to[0] === fx.A.admin.user.email));
  } finally { await reopened?.close(); await fx.close(); }
});
