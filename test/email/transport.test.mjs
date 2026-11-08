// Email config and transports (src/config.mjs, src/email/transport.mjs, src/email/send.mjs):
// FATHOM_EMAIL_* validation, loadEmailSettings and emailStatus for each state, address masking,
// the dev outbox (file modes, log hygiene), the AgentMail, Resend and Postmark HTTPS transports
// over an injected fetch (request shape and status mapping, key never leaked), SMTP over an
// injected nodemailer-style factory, and the email_sends history (no bodies, newest first).
// No network: every HTTPS call goes to a recording fake fetch.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir, tempDb } from '../helpers/server.mjs';
import { loadConfig, ConfigError } from '../../src/config.mjs';
import {
  EmailError, EMAIL_CODES, loadEmailSettings, emailStatus, maskAddress, createTransport,
} from '../../src/email/transport.mjs';
import { sendEmail, listSends } from '../../src/email/send.mjs';

// Synthetic secrets and markers: none may appear in an error, a thrown message or a log line.
const KEY = 'synthetic-email-credential';
const BODY_TEXT = 'SYNTHETIC-BODY-TEXT-90210';
const BODY_HTML = '<p style="margin:0">SYNTHETIC-BODY-HTML-31337</p>';
const FROM = 'fathom+inbox@example.invalid';
const TO = 'owner@example.invalid';
const MSG = { subject: 'Synthetic subject line', text: BODY_TEXT, html: BODY_HTML };

function captureLog() {
  const lines = [];
  const rec = (...a) => { lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  return { lines, text: () => lines.join('\n'), log: rec, info: rec, warn: rec, error: rec, debug: rec };
}

// A fetch that records each request and answers from a queue of [status, body] pairs,
// or throws when the queue holds an Error.
function fakeFetch(...answers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: new Headers(init.headers), body: init.body == null ? null : JSON.parse(init.body) });
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next instanceof Error) throw next;
    const [status, body] = next;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

async function secretsDir() {
  const dir = await tempDir('fathom-email-');
  const file = (name, text) => { const p = join(dir, name); writeFileSync(p, text, { mode: 0o600 }); return p; };
  return { dir, file, done: () => rmSync(dir, { recursive: true, force: true }) };
}

async function configFor(env, s) {
  return loadConfig({ FATHOM_DATA: s.dir, ...env });
}

// Asserts err is an EmailError with `code` whose message, stack and string form never carry `KEY`.
function emailErr(code) {
  return (err) => {
    assert.ok(err instanceof EmailError, `EmailError, got ${err && err.name}`);
    assert.equal(err.code, code);
    const codes = Array.isArray(EMAIL_CODES) ? EMAIL_CODES : [...Object.keys(EMAIL_CODES), ...Object.values(EMAIL_CODES)];
    assert.ok(codes.includes(code), `EMAIL_CODES lists ${code}`);
    for (const s of [err.message, err.stack, String(err), JSON.stringify(err)]) {
      assert.ok(!String(s).includes(KEY), 'no key in the error');
      assert.ok(!String(s).includes(BODY_TEXT), 'no body in the error');
    }
    return true;
  };
}

describe('config', () => {
  test('TRANSPORTS: dev, smtp, resend, postmark and agentmail are accepted; gmail is rejected', () => {
    for (const t of ['dev', 'smtp', 'resend', 'postmark', 'agentmail']) {
      assert.equal(loadConfig({ FATHOM_EMAIL_TRANSPORT: t }).emailTransport, t);
    }
    assert.throws(() => loadConfig({ FATHOM_EMAIL_TRANSPORT: 'gmail' }), ConfigError);
    assert.throws(() => loadConfig({ FATHOM_EMAIL_TRANSPORT: 'carrier-pigeon' }), ConfigError);
  });

  test('defaults: no addresses, smtp.gmail.com on 465, no public URL', () => {
    const c = loadConfig({});
    assert.equal(c.emailTransport, 'dev');
    assert.equal(c.emailFrom, null);
    assert.equal(c.emailSmtpHost, 'smtp.gmail.com');
    assert.equal(c.emailSmtpPort, 465);
    assert.equal(c.publicUrl, null);
  });

  test('plain values and *_FILE paths map to config keys', () => {
    const c = loadConfig({
      FATHOM_EMAIL_FROM: FROM, FATHOM_EMAIL_TO_FILE: '/run/secrets/to', FATHOM_EMAIL_CREDENTIAL_FILE: '/run/secrets/email',
      FATHOM_EMAIL_SMTP_USER: 'relay@example.invalid', FATHOM_EMAIL_SMTP_HOST: 'smtp.example.invalid', FATHOM_EMAIL_SMTP_PORT: '587',
    });
    assert.equal(c.emailFrom, FROM);
    assert.equal(c.emailToFile, '/run/secrets/to');
    assert.equal(c.emailCredentialFile, '/run/secrets/email');
    assert.equal(c.emailSmtpUser, 'relay@example.invalid');
    assert.equal(c.emailSmtpHost, 'smtp.example.invalid');
    assert.equal(c.emailSmtpPort, 587);
    assert.equal(loadConfig({ FATHOM_EMAIL_FROM_FILE: '/run/secrets/from', FATHOM_EMAIL_TO: TO }).emailFromFile, '/run/secrets/from');
  });

  test('setting both X and X_FILE is a ConfigError', () => {
    assert.throws(() => loadConfig({ FATHOM_EMAIL_FROM: FROM, FATHOM_EMAIL_FROM_FILE: '/run/secrets/from' }), ConfigError);
    assert.throws(() => loadConfig({ FATHOM_EMAIL_TO: TO, FATHOM_EMAIL_TO_FILE: '/run/secrets/to' }), ConfigError);
  });

  test('SMTP port is 465 or 587 only', () => {
    assert.equal(loadConfig({ FATHOM_EMAIL_SMTP_PORT: '465' }).emailSmtpPort, 465);
    assert.equal(loadConfig({ FATHOM_EMAIL_SMTP_PORT: '587' }).emailSmtpPort, 587);
    for (const p of ['25', '2525', 'abc', '465.5']) assert.throws(() => loadConfig({ FATHOM_EMAIL_SMTP_PORT: p }), ConfigError, p);
  });

  test('FATHOM_PUBLIC_URL is a secure public origin or explicit HTTP localhost origin', () => {
    assert.equal(loadConfig({ FATHOM_PUBLIC_URL: 'https://fathom.example.invalid' }).publicUrl, 'https://fathom.example.invalid');
    assert.equal(loadConfig({ FATHOM_PUBLIC_URL: 'http://localhost:8080' }).publicUrl, 'http://localhost:8080');
    for (const u of ['https://fathom.example.invalid/', 'https://fathom.example.invalid:8443/']) {
      assert.equal(loadConfig({ FATHOM_PUBLIC_URL: u }).publicUrl, new URL(u).origin, `a trailing slash is accepted: ${u}`);
    }
    for (const u of [
      'https://user:pass@fathom.example.invalid', 'https://user@fathom.example.invalid',
      'https://fathom.example.invalid/?a=1', 'https://fathom.example.invalid/#frag',
      'https://fathom.example.invalid/app/', 'http://fathom.example.invalid:8080', 'http://localhost', 'http://127.0.0.1:8080', 'https://127.0.0.1', 'ftp://fathom.example.invalid', 'javascript:alert(1)', 'not a url', 'fathom.example.invalid',
    ]) {
      assert.throws(() => loadConfig({ FATHOM_PUBLIC_URL: u }), ConfigError, u);
    }
  });
});

describe('credential file mode', () => {
  // Group access is allowed (a Kubernetes secret mounted with fsGroup is 0440); other access is not.
  const ACCEPTED = [0o600, 0o400, 0o640, 0o440];
  const REJECTED = [0o644, 0o604, 0o444];

  async function envWithMode(s, mode) {
    const file = s.file(`key-${mode.toString(8)}`, `${KEY}\n`);
    chmodSync(file, mode);
    return { FATHOM_EMAIL_TRANSPORT: 'resend', FATHOM_EMAIL_FROM: FROM, FATHOM_EMAIL_TO: TO, FATHOM_EMAIL_CREDENTIAL_FILE: file };
  }

  test('modes 0600, 0400, 0640 and 0440 are accepted by status and send', async () => {
    const s = await secretsDir();
    try {
      for (const mode of ACCEPTED) {
        const config = await configFor(await envWithMode(s, mode), s);
        assert.equal((await emailStatus(config)).state, 'configured', mode.toString(8));
        const fetch = fakeFetch([200, { id: 'x' }]);
        const t = await createTransport(config, { fetch, log: captureLog() });
        await t.send(MSG);
        assert.equal(fetch.calls.length, 1, `send reached the provider with mode ${mode.toString(8)}`);
      }
    } finally { s.done(); }
  });

  test('modes 0644, 0604 and 0444 are missing_credential for status and send', async () => {
    const s = await secretsDir();
    try {
      for (const mode of REJECTED) {
        const config = await configFor(await envWithMode(s, mode), s);
        assert.equal((await emailStatus(config)).state, 'missing_credential', mode.toString(8));
        const fetch = fakeFetch([200, { id: 'x' }]);
        await assert.rejects(async () => { const t = await createTransport(config, { fetch, log: captureLog() }); await t.send(MSG); }, emailErr('missing_credential'), mode.toString(8));
        assert.equal(fetch.calls.length, 0, `no request with mode ${mode.toString(8)}`);
      }
    } finally { s.done(); }
  });
});

describe('loadEmailSettings and emailStatus', () => {
  test('maskAddress keeps the first letters and the top-level domain', () => {
    assert.equal(maskAddress('owner@example.invalid'), 'o***@e***.invalid');
    assert.equal(maskAddress('spouse@mail.example.invalid'), 's***@m***.invalid');
  });

  test('dev: default addresses, no credential read', async () => {
    const s = await secretsDir();
    try {
      const reads = [];
      const readFile = (p, ...a) => { reads.push(String(p)); return fsReadFile(p, ...a); };
      const settings = await loadEmailSettings(await configFor({}, s), { readFile });
      assert.equal(settings.transport, 'dev');
      assert.equal(settings.from, 'fathom@example.invalid');
      assert.deepEqual(settings.to, ['owner@example.invalid']);
      assert.ok(!settings.credential);
      assert.deepEqual(reads, []);
      const st = await emailStatus(await configFor({}, s));
      assert.equal(st.state, 'dev');
      assert.equal(st.transport, 'dev');
      assert.equal(st.recipient, 'o***@e***.invalid');
      assert.equal(st.recipients, 1);
      assert.equal(typeof st.detail, 'string');
    } finally { s.done(); }
  });

  test('configured: addresses from files (TO comma or newline separated), credential from its file', async () => {
    const s = await secretsDir();
    try {
      const env = {
        FATHOM_EMAIL_TRANSPORT: 'agentmail',
        FATHOM_EMAIL_FROM_FILE: s.file('from', `${FROM}\n`),
        FATHOM_EMAIL_TO_FILE: s.file('to', `${TO},\nspouse@example.invalid\n`),
        FATHOM_EMAIL_CREDENTIAL_FILE: s.file('key', `${KEY}\n`),
      };
      const settings = await loadEmailSettings(await configFor(env, s));
      assert.equal(settings.transport, 'agentmail');
      assert.equal(settings.from, FROM);
      assert.deepEqual(settings.to, [TO, 'spouse@example.invalid']);
      assert.equal(settings.credential, KEY);
      const st = await emailStatus(await configFor(env, s));
      assert.equal(st.state, 'configured');
      assert.equal(st.recipients, 2);
      assert.equal(st.recipient, 'o***@e***.invalid');
      assert.ok(!JSON.stringify(st).includes(KEY), 'status never carries the key');
      assert.ok(!JSON.stringify(st).includes(TO), 'status masks the recipient');
    } finally { s.done(); }
  });

  test('missing_config: a non-dev transport with no from or no to', async () => {
    const s = await secretsDir();
    try {
      const cred = s.file('key', KEY);
      for (const env of [
        { FATHOM_EMAIL_TRANSPORT: 'resend', FATHOM_EMAIL_TO: TO, FATHOM_EMAIL_CREDENTIAL_FILE: cred },
        { FATHOM_EMAIL_TRANSPORT: 'resend', FATHOM_EMAIL_FROM: FROM, FATHOM_EMAIL_CREDENTIAL_FILE: cred },
      ]) {
        const config = await configFor(env, s);
        await assert.rejects(() => loadEmailSettings(config), emailErr('missing_config'));
        assert.equal((await emailStatus(config)).state, 'missing_config');
      }
    } finally { s.done(); }
  });

  test('missing_credential: unset, absent, unreadable or empty credential file', async () => {
    const s = await secretsDir();
    try {
      const base = { FATHOM_EMAIL_TRANSPORT: 'postmark', FATHOM_EMAIL_FROM: FROM, FATHOM_EMAIL_TO: TO };
      const empty = s.file('empty', '  \n');
      const cases = [
        {},
        { FATHOM_EMAIL_CREDENTIAL_FILE: join(s.dir, 'does-not-exist') },
        { FATHOM_EMAIL_CREDENTIAL_FILE: empty },
        { FATHOM_EMAIL_CREDENTIAL_FILE: s.dir },
      ];
      for (const extra of cases) {
        const config = await configFor({ ...base, ...extra }, s);
        await assert.rejects(() => loadEmailSettings(config), emailErr('missing_credential'), JSON.stringify(extra));
        const st = await emailStatus(config);
        assert.equal(st.state, 'missing_credential');
        assert.equal(st.recipient, 'o***@e***.invalid');
      }
    } finally { s.done(); }
  });
});

describe('dev transport', () => {
  // MT-03: the outbox directory is the caller's (a household root's outbox/, or the instance's).
  test('writes one 0600 JSON file per message under the given outboxDir and logs only the recipient count', async () => {
    const s = await secretsDir();
    try {
      const log = captureLog();
      const transport = await createTransport(await configFor({}, s), { outboxDir: join(s.dir, 'outbox'), log });
      assert.equal(transport.name, 'dev');
      const r1 = await transport.send(MSG);
      const r2 = await transport.send({ ...MSG, subject: 'Second synthetic subject' });
      assert.ok(r1.id && r2.id && r1.id !== r2.id);
      const outbox = join(s.dir, 'outbox');
      assert.equal(statSync(outbox).mode & 0o777, 0o700);
      const files = readdirSync(outbox).filter((f) => f.endsWith('.json')).sort();
      assert.equal(files.length, 2);
      for (const f of files) assert.equal(statSync(join(outbox, f)).mode & 0o777, 0o600, f);
      const msgs = files.map((f) => JSON.parse(readFileSync(join(outbox, f), 'utf8')));
      const first = msgs.find((m) => m.subject === MSG.subject);
      assert.ok(first);
      assert.equal(first.text, BODY_TEXT);
      assert.equal(first.html, BODY_HTML);
      assert.equal(first.from, 'fathom@example.invalid');
      assert.deepEqual([first.to].flat(), ['owner@example.invalid']);
      assert.ok(!Number.isNaN(Date.parse(first.date)));

      const logged = log.text();
      assert.ok(!logged.includes(MSG.subject), 'subject stays private');
      assert.match(logged, /recipients=1/);
      for (const secret of [BODY_TEXT, 'SYNTHETIC-BODY-HTML', 'owner@example.invalid', 'fathom@example.invalid']) {
        assert.ok(!logged.includes(secret), `log carries no ${secret}`);
      }
    } finally { s.done(); }
  });

  test('the dev transport needs an outboxDir and has no default location', async () => {
    const s = await secretsDir();
    try {
      const config = await configFor({}, s);
      assert.throws(() => createTransport(config, { log: captureLog() }), TypeError);
      assert.ok(!existsSync(join(s.dir, 'outbox')), 'no outbox in the data directory');
    } finally { s.done(); }
  });
});

// AgentMail Send Message: https://docs.agentmail.to/api-reference/inboxes/messages/send
// POST /v0/inboxes/{inbox_id}/messages/send, Bearer auth, 200 {message_id, thread_id};
// errors {name, message} (400 ValidationError, 403 MessageRejectedError, 404 NotFoundError).
// Resend Send Email: https://resend.com/docs/api-reference/emails/send-email
// Resend errors: https://resend.com/docs/api-reference/errors
// Postmark Email API: https://postmarkapp.com/developer/api/email-api
// Postmark error codes (406 inactive recipient): https://postmarkapp.com/developer/api/overview#error-codes
describe('HTTPS transports', () => {
  async function httpsTransport(kind, fetch, log = captureLog()) {
    const s = await secretsDir();
    const config = await configFor({
      FATHOM_EMAIL_TRANSPORT: kind, FATHOM_EMAIL_FROM: FROM, FATHOM_EMAIL_TO: TO, FATHOM_EMAIL_CREDENTIAL_FILE: s.file('key', KEY),
    }, s);
    const transport = await createTransport(config, { fetch, log });
    return { transport, log, done: s.done };
  }

  test('agentmail: exact URL with the URL-encoded inbox id, Bearer key, JSON body; returns message_id', async () => {
    const fetch = fakeFetch([200, { message_id: '<synthetic-1@agentmail.invalid>', thread_id: 'thread-synthetic' }]);
    const h = await httpsTransport('agentmail', fetch);
    try {
      assert.equal(h.transport.name, 'agentmail');
      const r = await h.transport.send(MSG);
      assert.equal(r.id, '<synthetic-1@agentmail.invalid>');
      assert.equal(fetch.calls.length, 1);
      const c = fetch.calls[0];
      assert.equal(c.url, `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(FROM)}/messages/send`);
      assert.ok(c.url.includes('fathom%2Binbox%40example.invalid'));
      assert.equal(c.method, 'POST');
      assert.equal(c.headers.get('authorization'), `Bearer ${KEY}`);
      assert.match(c.headers.get('content-type'), /application\/json/);
      assert.deepEqual([c.body.to].flat(), [TO]);
      assert.equal(c.body.subject, MSG.subject);
      assert.equal(c.body.text, BODY_TEXT);
      assert.equal(c.body.html, BODY_HTML);
      assert.ok(!h.log.text().includes(KEY));
    } finally { h.done(); }
  });

  test('resend: URL, Bearer key and {from, to[], subject, text, html}; returns id', async () => {
    const fetch = fakeFetch([200, { id: 'synthetic-resend-id' }]);
    const h = await httpsTransport('resend', fetch);
    try {
      const r = await h.transport.send(MSG);
      assert.equal(r.id, 'synthetic-resend-id');
      const c = fetch.calls[0];
      assert.equal(c.url, 'https://api.resend.com/emails');
      assert.equal(c.method, 'POST');
      assert.equal(c.headers.get('authorization'), `Bearer ${KEY}`);
      assert.deepEqual(c.body, { from: FROM, to: [TO], subject: MSG.subject, text: BODY_TEXT, html: BODY_HTML });
    } finally { h.done(); }
  });

  test('postmark: URL, server token header, Accept json, PascalCase body with MessageStream outbound', async () => {
    const fetch = fakeFetch([200, { To: TO, SubmittedAt: '2032-06-01T11:00:00Z', MessageID: 'synthetic-pm-id', ErrorCode: 0, Message: 'OK' }]);
    const h = await httpsTransport('postmark', fetch);
    try {
      const r = await h.transport.send({ ...MSG, to: [TO, 'spouse@example.invalid'] });
      assert.equal(r.id, 'synthetic-pm-id');
      const c = fetch.calls[0];
      assert.equal(c.url, 'https://api.postmarkapp.com/email');
      assert.equal(c.method, 'POST');
      assert.equal(c.headers.get('x-postmark-server-token'), KEY);
      assert.match(c.headers.get('accept'), /application\/json/);
      const { To, ...rest } = c.body;
      assert.deepEqual(To.split(/,\s*/), [TO, 'spouse@example.invalid'], 'To is one comma-joined string');
      assert.deepEqual(rest, { From: FROM, Subject: MSG.subject, TextBody: BODY_TEXT, HtmlBody: BODY_HTML, MessageStream: 'outbound' });
    } finally { h.done(); }
  });

  const MAPS = {
    agentmail: [
      [401, { name: 'UnauthorizedError', message: 'Unauthorized' }, 'auth'],
      [403, { name: 'MessageRejectedError', message: 'Message rejected' }, 'rejected'],
      [404, { name: 'NotFoundError', message: 'Inbox not found' }, 'not_found'],
      [429, { name: 'TooManyRequestsError', message: 'Slow down' }, 'rate_limited'],
      [400, { name: 'ValidationError', errors: [{ path: ['to'], message: 'Invalid' }] }, 'invalid'],
      [422, { name: 'ValidationError', message: 'Invalid' }, 'invalid'],
      [500, { name: 'InternalServerError', message: 'Oops' }, 'other'],
      [409, { name: 'ConflictError', message: 'Conflict' }, 'other'],
    ],
    resend: [
      [401, { statusCode: 401, name: 'missing_api_key', message: 'Missing API key' }, 'auth'],
      [403, { statusCode: 403, name: 'invalid_api_key', message: 'API key is invalid' }, 'auth'],
      [404, { statusCode: 404, name: 'not_found', message: 'Not found' }, 'not_found'],
      [422, { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field' }, 'invalid'],
      [429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests' }, 'rate_limited'],
      [500, { statusCode: 500, name: 'internal_server_error', message: 'Oops' }, 'other'],
    ],
    postmark: [
      [401, { ErrorCode: 10, Message: 'No Account or Server API tokens were supplied' }, 'auth'],
      [422, { ErrorCode: 300, Message: 'Invalid email request' }, 'invalid'],
      [422, { ErrorCode: 406, Message: 'You tried to send to recipient(s) that have been marked as inactive.' }, 'rejected'],
      [429, { ErrorCode: 0, Message: 'Rate limit exceeded' }, 'rate_limited'],
      [500, { ErrorCode: 0, Message: 'Internal Server Error' }, 'other'],
    ],
  };

  for (const [kind, rows] of Object.entries(MAPS)) {
    test(`${kind}: HTTP status maps to a fixed code; the key never leaks; fetch throwing is network`, async () => {
      for (const [status, body, code] of rows) {
        const fetch = fakeFetch([status, { ...body, echo: `Bearer ${KEY}` }]);
        const h = await httpsTransport(kind, fetch);
        try {
          await assert.rejects(() => h.transport.send(MSG), emailErr(code), `${kind} ${status}`);
          assert.ok(!h.log.text().includes(KEY), `${kind} ${status}: log has no key`);
          assert.ok(!h.log.text().includes(BODY_TEXT));
        } finally { h.done(); }
      }
      const thrown = new TypeError(`fetch failed for Bearer ${KEY}`);
      const h = await httpsTransport(kind, fakeFetch(thrown));
      try {
        await assert.rejects(() => h.transport.send(MSG), emailErr('network'));
        assert.ok(!h.log.text().includes(KEY));
      } finally { h.done(); }
    });
  }
});

describe('smtp transport', () => {
  function fakeSmtp({ fail } = {}) {
    const made = [];
    const sent = [];
    const create = (options) => {
      made.push(options);
      return {
        async sendMail(m) {
          if (fail) { const e = new Error(`Invalid login: 535 ${KEY}`); e.code = fail; throw e; }
          sent.push(m);
          return { messageId: '<synthetic-smtp@example.invalid>' };
        },
        close() {},
      };
    };
    return { create, made, sent };
  }

  async function smtpTransport(env, smtp) {
    const s = await secretsDir();
    const config = await configFor({
      FATHOM_EMAIL_TRANSPORT: 'smtp', FATHOM_EMAIL_FROM: FROM, FATHOM_EMAIL_TO: TO, FATHOM_EMAIL_CREDENTIAL_FILE: s.file('key', `${KEY}\n`), ...env,
    }, s);
    const log = captureLog();
    const transport = await createTransport(config, { createSmtpTransport: smtp.create, log });
    return { transport, log, done: s.done };
  }

  test('465 is implicit TLS; user is FATHOM_EMAIL_FROM; password from the credential file', async () => {
    const smtp = fakeSmtp();
    const h = await smtpTransport({}, smtp);
    try {
      assert.equal(h.transport.name, 'smtp');
      const r = await h.transport.send(MSG);
      assert.equal(r.id, '<synthetic-smtp@example.invalid>');
      const o = smtp.made.at(-1);
      assert.equal(o.host, 'smtp.gmail.com');
      assert.equal(o.port, 465);
      assert.equal(o.secure, true);
      assert.deepEqual(o.auth, { user: FROM, pass: KEY });
      const m = smtp.sent[0];
      assert.equal(m.from, FROM);
      assert.deepEqual([m.to].flat().join(',').split(','), [TO]);
      assert.equal(m.subject, MSG.subject);
      assert.equal(m.text, BODY_TEXT);
      assert.equal(m.html, BODY_HTML);
    } finally { h.done(); }
  });

  test('587 is STARTTLS with requireTLS; FATHOM_EMAIL_SMTP_USER overrides the user', async () => {
    const smtp = fakeSmtp();
    const h = await smtpTransport({ FATHOM_EMAIL_SMTP_PORT: '587', FATHOM_EMAIL_SMTP_HOST: 'smtp.example.invalid', FATHOM_EMAIL_SMTP_USER: 'relay@example.invalid' }, smtp);
    try {
      await h.transport.send(MSG);
      const o = smtp.made.at(-1);
      assert.equal(o.host, 'smtp.example.invalid');
      assert.equal(o.port, 587);
      assert.equal(o.secure, false);
      assert.equal(o.requireTLS, true);
      assert.deepEqual(o.auth, { user: 'relay@example.invalid', pass: KEY });
    } finally { h.done(); }
  });

  test('a nodemailer EAUTH error maps to auth and never carries the password', async () => {
    const h = await smtpTransport({}, fakeSmtp({ fail: 'EAUTH' }));
    try {
      await assert.rejects(() => h.transport.send(MSG), emailErr('auth'));
      assert.ok(!h.log.text().includes(KEY));
    } finally { h.done(); }
  });
});

describe('sendEmail and listSends', () => {
  const okTransport = { name: 'capture', async send() { return { id: 'synthetic-id-1' }; } };

  test('success and failure both record an email_sends row with no body column', async () => {
    const t = await tempDb();
    try {
      const ok = await sendEmail(t.db, { transport: okTransport, kind: 'test', ...MSG, now: '2032-06-01T11:00:00.000Z', jobRunId: null });
      assert.equal(ok.status, 'sent');
      assert.equal(ok.kind, 'test');
      assert.equal(ok.subject, MSG.subject);
      assert.equal(ok.transport, 'capture');
      assert.equal(ok.messageId, 'synthetic-id-1');
      assert.equal(ok.errorCode ?? null, null);
      assert.ok(ok.id);

      const failing = { name: 'failing', async send() { throw new EmailError('rate_limited'); } };
      const bad = await sendEmail(t.db, { transport: failing, kind: 'brief', ...MSG, now: '2032-06-01T11:05:00.000Z', jobRunId: null });
      assert.equal(bad.status, 'failed');
      assert.equal(bad.errorCode, 'rate_limited');

      const rows = (await t.db.prepare('SELECT * FROM email_sends ORDER BY id').all()).map((r) => ({ ...r }));
      assert.equal(rows.length, 2);
      for (const r of rows) {
        for (const [col, v] of Object.entries(r)) {
          assert.ok(!String(v ?? '').includes('SYNTHETIC-BODY'), `email_sends.${col} holds no body`);
          assert.ok(!String(v ?? '').includes(TO), `email_sends.${col} holds no address`);
        }
      }
    } finally { t.close(); rmSync(t.dataDir, { recursive: true, force: true }); }
  });

  test('a non-EmailError is recorded as other and rethrown', async () => {
    const t = await tempDb();
    try {
      const broken = { name: 'broken', async send() { throw new RangeError('synthetic bug'); } };
      await assert.rejects(async () => sendEmail(t.db, { transport: broken, kind: 'test', ...MSG, now: '2032-06-01T11:00:00.000Z' }), RangeError);
      const row = await t.db.prepare('SELECT * FROM email_sends').get();
      assert.equal(row.status, 'failed');
      assert.ok(Object.values(row).includes('other'), 'error code other recorded');
    } finally { t.close(); rmSync(t.dataDir, { recursive: true, force: true }); }
  });

  test('listSends returns newest first and honours the limit', async () => {
    const t = await tempDb();
    try {
      for (let i = 1; i <= 3; i++) {
        await sendEmail(t.db, { transport: okTransport, kind: 'test', ...MSG, subject: `Synthetic ${i}`, now: `2032-06-0${i}T11:00:00.000Z` });
      }
      assert.deepEqual((await listSends(t.db)).map((s) => s.subject), ['Synthetic 3', 'Synthetic 2', 'Synthetic 1']);
      assert.deepEqual((await listSends(t.db, { limit: 2 })).map((s) => s.subject), ['Synthetic 3', 'Synthetic 2']);
      for (const s of await listSends(t.db)) for (const k of ['text', 'html', 'body']) assert.ok(!(k in s), `no ${k} in history`);
    } finally { t.close(); rmSync(t.dataDir, { recursive: true, force: true }); }
  });
});

test('EMAIL_CODES holds exactly the fixed failure codes', () => {
  const codes = Array.isArray(EMAIL_CODES) ? EMAIL_CODES : Object.values(EMAIL_CODES);
  assert.deepEqual([...codes].sort(), ['auth', 'invalid', 'missing_config', 'missing_credential', 'network', 'not_found', 'other', 'paused', 'rate_limited', 'recipient_unverified', 'rejected']);
});

test('no outbox appears for a non-dev transport', async () => {
  const s = await secretsDir();
  try {
    const config = await configFor({ FATHOM_EMAIL_TRANSPORT: 'resend', FATHOM_EMAIL_FROM: FROM, FATHOM_EMAIL_TO: TO, FATHOM_EMAIL_CREDENTIAL_FILE: s.file('key', KEY) }, s);
    const t = await createTransport(config, { fetch: fakeFetch([200, { id: 'x' }]), log: captureLog() });
    await t.send(MSG);
    assert.ok(!existsSync(join(s.dir, 'outbox')));
  } finally { s.done(); }
});
