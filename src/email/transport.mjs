// Email settings and transports: dev (a private outbox in the data volume), smtp (nodemailer),
// and the HTTPS APIs of AgentMail, Resend and Postmark over an injected fetch. Addresses and the
// credential are read from their files at send and status time. Failures are EmailError with a
// fixed code and message: no key, body, address or provider response reaches an error or a log.

import { constants } from 'node:fs';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import nodemailer from 'nodemailer';

export const EMAIL_CODES = Object.freeze([
  'missing_config', 'missing_credential', 'auth', 'not_found', 'rate_limited', 'invalid', 'rejected', 'network', 'other',
]);

const MESSAGES = {
  missing_config: 'Email sender or recipient is not configured',
  missing_credential: 'Email credential is missing, unreadable, empty or not private',
  auth: 'Email provider rejected the credential',
  not_found: 'Email provider could not find the sender',
  rate_limited: 'Email provider rate limit reached',
  invalid: 'Email provider rejected the request as invalid',
  rejected: 'Email provider rejected the message',
  network: 'Email provider could not be reached',
  other: 'Email send failed',
};

export class EmailError extends Error {
  constructor(code) {
    const c = EMAIL_CODES.includes(code) ? code : 'other';
    super(MESSAGES[c]);
    this.name = 'EmailError';
    this.code = c;
  }
}

const DEV_FROM = 'fathom@example.invalid';
const DEV_TO = 'owner@example.invalid';
const FILE_LIMIT = 64 * 1024;
const TIMEOUT_MS = 20000;
const ADDRESS = /^[^\s@,<>"]+@[^\s@,<>"]+$/;

// Read a small regular file without following a final symlink; `private` also refuses a file
// that group or other can access. Errors carry no path or content.
async function readRegular(path, { private: priv = false } = {}) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > FILE_LIMIT) throw new Error('not a small regular file');
    if (priv && (stat.mode & 0o077) !== 0) throw new Error('not private');
    return await handle.readFile('utf8');
  } catch {
    throw new Error('file could not be read');
  } finally {
    await handle?.close().catch(() => {});
  }
}

const splitList = (text) => String(text).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

async function valueOf(value, file, readFile) {
  if (value != null) return value;
  if (file == null) return null;
  try { return String(await readFile(file, 'utf8')); } catch { throw new EmailError('missing_config'); }
}

// {from, to: []} from the plain values or their files; missing values are null and []. An
// unreadable file or a malformed address is missing_config.
async function readAddresses(config, readFile) {
  const fromText = await valueOf(config.emailFrom, config.emailFromFile, readFile);
  const toText = await valueOf(config.emailTo, config.emailToFile, readFile);
  const from = fromText == null ? null : fromText.trim() || null;
  const to = toText == null ? [] : splitList(toText);
  if ((from && !ADDRESS.test(from)) || to.some((a) => !ADDRESS.test(a))) throw new EmailError('missing_config');
  return { from, to };
}

async function readCredential(file, readFile) {
  if (file == null) throw new EmailError('missing_credential');
  let value;
  try { value = String(await readFile(file, { encoding: 'utf8', private: true })).trim(); } catch { throw new EmailError('missing_credential'); }
  if (!value || /\s/.test(value)) throw new EmailError('missing_credential');
  return value;
}

export async function loadEmailSettings(config, { readFile = readRegular } = {}) {
  const transport = config.emailTransport ?? 'dev';
  const smtp = { host: config.emailSmtpHost, port: config.emailSmtpPort, user: config.emailSmtpUser ?? null };
  const { from, to } = await readAddresses(config, readFile);
  if (transport === 'dev') {
    return { transport, from: from ?? DEV_FROM, to: to.length ? to : [DEV_TO], credential: null, smtp };
  }
  if (!from || !to.length) throw new EmailError('missing_config');
  const credential = await readCredential(config.emailCredentialFile, readFile);
  return { transport, from, to, credential, smtp };
}

export function maskAddress(address) {
  const m = /^([^@]+)@(.+)$/.exec(String(address ?? ''));
  if (!m) return '***';
  const labels = m[2].split('.');
  const tld = labels.length > 1 ? `.${labels.at(-1)}` : '';
  return `${m[1][0]}***@${m[2][0]}***${tld}`;
}

const DETAIL = {
  dev: 'Development transport: messages are written to the outbox in the data volume, nothing is sent.',
  configured: 'Sender, recipients and credential are configured.',
  missing_config: 'Set FATHOM_EMAIL_FROM and FATHOM_EMAIL_TO (or their _FILE paths) to valid addresses.',
  missing_credential: 'Mount a private, non-empty credential file and set FATHOM_EMAIL_CREDENTIAL_FILE.',
};

// Transport state for the Email screen. Never returns the credential or a full address.
export async function emailStatus(config, { readFile = readRegular } = {}) {
  let state;
  let to = [];
  try {
    const s = await loadEmailSettings(config, { readFile });
    state = s.transport === 'dev' ? 'dev' : 'configured';
    to = s.to;
  } catch (err) {
    if (!(err instanceof EmailError)) throw err;
    state = err.code;
    to = await readAddresses(config, readFile).then((a) => a.to, () => []);
  }
  return {
    transport: config.emailTransport ?? 'dev',
    state,
    recipient: to.length ? maskAddress(to[0]) : null,
    recipients: to.length,
    detail: DETAIL[state] ?? MESSAGES[state],
  };
}

// Dev: one JSON file per message in $dataDir/outbox (dir 0700, file 0600), written atomically.
let devSeq = 0;
async function devSend(config, settings, msg, log) {
  const dir = join(config.dataDir, 'outbox');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const date = new Date().toISOString();
  const stem = `${date.replace(/[-:.]/g, '')}-${++devSeq}`;
  const tmp = join(dir, `.${stem}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const body = JSON.stringify({ from: settings.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html, date }, null, 2);
  let handle;
  try {
    handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(body);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmp, join(dir, `${stem}.json`));
  } catch {
    await handle?.close().catch(() => {});
    await rm(tmp, { force: true });
    throw new EmailError('other');
  }
  log.info(`fathom: email (dev) ${msg.subject} to ${msg.to.length} recipient(s)`);
  return { id: stem };
}

async function postJson(fetch, url, headers, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new EmailError('network');
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, ok: res.ok, data: data && typeof data === 'object' ? data : {} };
}

const idOf = (v) => {
  if (typeof v === 'string' && v) return { id: v };
  throw new EmailError('other');
};

// AgentMail Send Message: https://docs.agentmail.to/api-reference/inboxes/messages/send
// 200 {message_id, thread_id}; 400 ValidationError, 403 MessageRejectedError, 404 NotFoundError.
const AGENTMAIL_CODES = { 400: 'invalid', 401: 'auth', 403: 'rejected', 404: 'not_found', 422: 'invalid', 429: 'rate_limited' };
async function agentmailSend(fetch, settings, msg) {
  const url = `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(settings.from)}/messages/send`;
  const r = await postJson(fetch, url, { Authorization: `Bearer ${settings.credential}` },
    { to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
  if (!r.ok) throw new EmailError(AGENTMAIL_CODES[r.status] ?? 'other');
  return idOf(r.data.message_id);
}

// Resend Send Email: https://resend.com/docs/api-reference/emails/send-email
// Errors: https://resend.com/docs/api-reference/errors (401 missing key, 403 invalid key,
// 422 validation, 429 rate limit).
const RESEND_CODES = { 400: 'invalid', 401: 'auth', 403: 'auth', 404: 'not_found', 422: 'invalid', 429: 'rate_limited' };
async function resendSend(fetch, settings, msg) {
  const r = await postJson(fetch, 'https://api.resend.com/emails', { Authorization: `Bearer ${settings.credential}` },
    { from: settings.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
  if (!r.ok) throw new EmailError(RESEND_CODES[r.status] ?? 'other');
  return idOf(r.data.id);
}

// Postmark Email API: https://postmarkapp.com/developer/api/email-api
// Error codes: https://postmarkapp.com/developer/api/overview#error-codes (422 ErrorCode 406 is
// an inactive recipient).
async function postmarkSend(fetch, settings, msg) {
  const r = await postJson(fetch, 'https://api.postmarkapp.com/email', { 'X-Postmark-Server-Token': settings.credential }, {
    From: settings.from, To: msg.to.join(','), Subject: msg.subject, TextBody: msg.text, HtmlBody: msg.html, MessageStream: 'outbound',
  });
  if (r.status === 401) throw new EmailError('auth');
  if (r.status === 422) throw new EmailError(r.data.ErrorCode === 406 ? 'rejected' : 'invalid');
  if (r.status === 429) throw new EmailError('rate_limited');
  if (!r.ok || (r.data.ErrorCode != null && r.data.ErrorCode !== 0)) throw new EmailError('other');
  return idOf(r.data.MessageID);
}

// SMTP through nodemailer: https://nodemailer.com/smtp/ (465 implicit TLS; 587 STARTTLS, required).
const SMTP_NETWORK = new Set(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ETLS', 'EPROXY', 'ECONNREFUSED', 'ECONNRESET']);
function smtpCode(err) {
  const code = err && err.code;
  if (code === 'EAUTH') return 'auth';
  if (SMTP_NETWORK.has(code)) return 'network';
  if (err && err.responseCode >= 550 && err.responseCode <= 554) return 'rejected';
  if (code === 'EENVELOPE' || code === 'EMESSAGE') return 'invalid';
  return 'other';
}

async function smtpSend(createSmtpTransport, settings, msg) {
  const { host, port, user } = settings.smtp;
  let smtp;
  try {
    smtp = createSmtpTransport({
      host, port, secure: port === 465, ...(port === 587 ? { requireTLS: true } : {}),
      auth: { user: user ?? settings.from, pass: settings.credential },
      connectionTimeout: TIMEOUT_MS, greetingTimeout: TIMEOUT_MS, socketTimeout: TIMEOUT_MS,
      logger: false, debug: false,
    });
    const info = await smtp.sendMail({ from: settings.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
    return idOf(info && info.messageId);
  } catch (err) {
    if (err instanceof EmailError) throw err;
    throw new EmailError(smtpCode(err));
  } finally {
    try { smtp?.close?.(); } catch { /* already closed */ }
  }
}

// {name, send({to?, subject, text, html}) -> {id, recipients}}; send throws EmailError.
export function createTransport(config, {
  fetch = globalThis.fetch, createSmtpTransport = nodemailer.createTransport.bind(nodemailer), log = console, readFile,
} = {}) {
  const name = config.emailTransport ?? 'dev';
  async function send({ to, subject, text, html }) {
    const settings = await loadEmailSettings(config, readFile ? { readFile } : {});
    const recipients = to == null ? settings.to : [to].flat();
    if (!recipients.length || recipients.some((a) => !ADDRESS.test(a))) throw new EmailError('missing_config');
    const msg = { to: recipients, subject: String(subject ?? ''), text: String(text ?? ''), html: String(html ?? '') };
    let result;
    if (name === 'dev') result = await devSend(config, settings, msg, log);
    else if (name === 'agentmail') result = await agentmailSend(fetch, settings, msg);
    else if (name === 'resend') result = await resendSend(fetch, settings, msg);
    else if (name === 'postmark') result = await postmarkSend(fetch, settings, msg);
    else if (name === 'smtp') result = await smtpSend(createSmtpTransport, settings, msg);
    else throw new EmailError('missing_config');
    return { ...result, recipients: recipients.length };
  }
  return { name, send };
}
