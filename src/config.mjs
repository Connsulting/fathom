// Runtime configuration from the environment. Paths only: secrets are read by the modules that
// need them, from the files named here, never from this module or from tracked files.

import { resolve } from 'node:path';

const ENGINES = ['live', 'fake', 'off'];
const TRANSPORTS = ['dev', 'smtp', 'resend', 'postmark', 'agentmail'];
const SMTP_PORTS = [465, 587];

export class ConfigError extends Error {}

function isoDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const blank = v => v == null || v === '';
const opt = v => (blank(v) ? null : v);

// A plain value and its *_FILE path are exclusive; the file is read later by its consumer.
function valueOrFile(env, name) {
  if (!blank(env[name]) && !blank(env[`${name}_FILE`])) throw new ConfigError(`Set ${name} or ${name}_FILE, not both`);
  return [opt(env[name]), opt(env[`${name}_FILE`])];
}

function smtpPort(v) {
  if (blank(v)) return 465;
  const n = /^\d+$/.test(v) ? Number(v) : NaN;
  if (!SMTP_PORTS.includes(n)) throw new ConfigError(`FATHOM_EMAIL_SMTP_PORT must be ${SMTP_PORTS.join(' or ')}`);
  return n;
}


export function loadConfig(env = process.env) {
  const demoRaw = env.FATHOM_DEMO;
  let demo;
  if (blank(demoRaw)) demo = 'auto';
  else if (demoRaw === '1') demo = true;
  else if (demoRaw === '0') demo = false;
  else throw new ConfigError(`FATHOM_DEMO must be 1 or 0, got ${demoRaw}`);

  let port = 8080;
  if (!blank(env.FATHOM_PORT)) {
    port = Number(env.FATHOM_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ConfigError(`FATHOM_PORT must be an integer from 1 to 65535, got ${env.FATHOM_PORT}`);
    }
  }

  let engine = demo === false ? 'off' : 'fake';
  if (!blank(env.FATHOM_ENGINE)) {
    if (!ENGINES.includes(env.FATHOM_ENGINE)) throw new ConfigError(`FATHOM_ENGINE must be one of ${ENGINES.join(', ')}`);
    engine = env.FATHOM_ENGINE;
  }

  // Fake engine only: milliseconds between streamed answer chunks, so the demo shows an answer
  // arriving the way a live one does. 0 streams at once.
  let fakeStreamMs = 25;
  if (!blank(env.FATHOM_FAKE_STREAM_MS)) {
    fakeStreamMs = Number(env.FATHOM_FAKE_STREAM_MS);
    if (!Number.isInteger(fakeStreamMs) || fakeStreamMs < 0 || fakeStreamMs > 1000) {
      throw new ConfigError(`FATHOM_FAKE_STREAM_MS must be an integer from 0 to 1000, got ${env.FATHOM_FAKE_STREAM_MS}`);
    }
  }

  let clock = null;
  if (!blank(env.FATHOM_CLOCK)) {
    if (!isoDate(env.FATHOM_CLOCK)) throw new ConfigError(`FATHOM_CLOCK must be an ISO date (YYYY-MM-DD), got ${env.FATHOM_CLOCK}`);
    clock = env.FATHOM_CLOCK;
  }

  let emailTransport = 'dev';
  if (!blank(env.FATHOM_EMAIL_TRANSPORT)) {
    if (!TRANSPORTS.includes(env.FATHOM_EMAIL_TRANSPORT)) {
      throw new ConfigError(`FATHOM_EMAIL_TRANSPORT must be one of ${TRANSPORTS.join(', ')}`);
    }
    emailTransport = env.FATHOM_EMAIL_TRANSPORT;
  }
  const [emailFrom, emailFromFile] = valueOrFile(env, 'FATHOM_EMAIL_FROM');
  const [emailTo, emailToFile] = valueOrFile(env, 'FATHOM_EMAIL_TO');

  // The URL MCP clients use to reach this server, when it sits behind a proxy or a name. The
  // value is not echoed in the error: it could carry credentials.
  let publicUrl = null;
  if (!blank(env.FATHOM_PUBLIC_URL)) {
    const raw = env.FATHOM_PUBLIC_URL;
    let u = null;
    try { u = new URL(raw); } catch { u = null; }
    if (!u || !['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash
      || raw.includes('?') || raw.includes('#')) {
      throw new ConfigError('FATHOM_PUBLIC_URL must be an absolute http or https URL with no credentials, query or fragment');
    }
    publicUrl = u.href;
  }

  const allowedHosts = blank(env.FATHOM_ALLOWED_HOSTS) ? []
    : env.FATHOM_ALLOWED_HOSTS.split(',').map(h => h.trim().toLowerCase()).filter(Boolean);

  return {
    dataDir: resolve(blank(env.FATHOM_DATA) ? 'data' : env.FATHOM_DATA),
    port,
    host: blank(env.FATHOM_HOST) ? '127.0.0.1' : env.FATHOM_HOST,
    demo,
    engine,
    fakeStreamMs,
    clock,
    claudeCredentialFile: blank(env.FATHOM_CLAUDE_CREDENTIAL_FILE) ? null : env.FATHOM_CLAUDE_CREDENTIAL_FILE,
    dataKeyFile: blank(env.FATHOM_DATA_KEY_FILE) ? null : env.FATHOM_DATA_KEY_FILE,
    emailTransport,
    emailFrom,
    emailFromFile,
    emailTo,
    emailToFile,
    emailCredentialFile: opt(env.FATHOM_EMAIL_CREDENTIAL_FILE),
    emailSmtpUser: opt(env.FATHOM_EMAIL_SMTP_USER),
    emailSmtpHost: blank(env.FATHOM_EMAIL_SMTP_HOST) ? 'smtp.gmail.com' : env.FATHOM_EMAIL_SMTP_HOST,
    emailSmtpPort: smtpPort(env.FATHOM_EMAIL_SMTP_PORT),
    publicUrl,
    allowedHosts,
    // Owner login list, raw: src/api/identity.mjs parses it and fails closed on a problem.
    ownerLogins: blank(env.FATHOM_OWNER_LOGINS) ? null : env.FATHOM_OWNER_LOGINS,
    ownerLoginsFile: blank(env.FATHOM_OWNER_LOGINS_FILE) ? null : env.FATHOM_OWNER_LOGINS_FILE,
  };
}
