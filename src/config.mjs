// Runtime configuration from the environment. Paths only: secrets are read by the modules that
// need them, from the files named here, never from this module or from tracked files.

import { resolve } from 'node:path';
import { loadModelConfig } from './models/config.mjs';
import { isIP } from 'node:net';
import { parseAllowedHosts } from './ingest/simplefin-hosts.mjs';
import { publicDemoConfig } from './public-demo/config.mjs';

const ENGINES = ['live', 'fake', 'off'];
const TRANSPORTS = ['dev', 'smtp', 'resend', 'postmark', 'agentmail'];
const SMTP_PORTS = [465, 587];

export class ConfigError extends Error {}

export function validatePublicUrl(value, { required = false } = {}) {
  const fail = () => { throw new ConfigError('FATHOM_PUBLIC_URL must be an HTTPS DNS origin or an explicit HTTP localhost port, with no credentials, path, query or fragment'); };
  if (value == null || value === '') {
    if (required) fail();
    return null;
  }
  if (typeof value !== 'string') fail();
  const match = /^(https?):\/\/([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?\/?$/i.exec(value);
  if (!match) fail();
  let url;
  try { url = new URL(value); } catch { fail(); }
  if (isIP(url.hostname) || url.hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || url.hostname.length > 253 || (match[3] !== undefined && Number(match[3]) < 1)
    || (url.protocol === 'http:' && (url.hostname !== 'localhost' || !match[3]))) fail();
  return url.protocol === 'http:' && !url.port ? `${url.origin}:80` : url.origin;
}

function trustedProxyCidrs(value) {
  if (value == null || value === '') return [];
  const fail = () => { throw new ConfigError('FATHOM_TRUSTED_PROXIES must contain comma-separated explicit IPv4 or IPv6 CIDRs'); };
  if (typeof value !== 'string') fail();
  const cidrs = value.split(',').map(cidr => cidr.trim());
  for (const cidr of cidrs) {
    const parts = cidr.split('/');
    const family = isIP(parts[0]);
    if (parts.length !== 2 || !family || !/^(0|[1-9]\d{0,2})$/.test(parts[1])
      || Number(parts[1]) > (family === 4 ? 32 : 128)) fail();
  }
  return cidrs;
}

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
  const publicMode = publicDemoConfig(env);
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

  const publicUrl = validatePublicUrl(opt(env.FATHOM_PUBLIC_URL), { required: publicMode.publicDemo });
  const trustedProxies = trustedProxyCidrs(env.FATHOM_TRUSTED_PROXIES);

  const allowedHosts = blank(env.FATHOM_ALLOWED_HOSTS) ? []
    : env.FATHOM_ALLOWED_HOSTS.split(',').map(h => h.trim().toLowerCase()).filter(Boolean);

  const simplefinHosts = parseAllowedHosts(env.FATHOM_SIMPLEFIN_ALLOWED_HOSTS);
  if (!simplefinHosts) throw new ConfigError('FATHOM_SIMPLEFIN_ALLOWED_HOSTS must be comma separated host names with no scheme, port or path');

  const backupRetentionDays = blank(env.FATHOM_BACKUP_RETENTION_DAYS) ? 7 : Number(env.FATHOM_BACKUP_RETENTION_DAYS);
  if (!Number.isInteger(backupRetentionDays) || backupRetentionDays < 1 || backupRetentionDays > 3650) {
    throw new ConfigError('FATHOM_BACKUP_RETENTION_DAYS must be an integer from 1 to 3650');
  }
  return {
    ...publicMode,
    dataDir: publicMode.publicDemo ? publicMode.demoDataDir : resolve(blank(env.FATHOM_DATA) ? 'data' : env.FATHOM_DATA),
    port,
    host: blank(env.FATHOM_HOST) ? '127.0.0.1' : env.FATHOM_HOST,
    demo: publicMode.publicDemo ? true : demo,
    engine,
    modelPorts: loadModelConfig(env),
    fakeStreamMs,
    clock,
    claudeCredentialFile: blank(env.FATHOM_CLAUDE_CREDENTIAL_FILE) ? null : env.FATHOM_CLAUDE_CREDENTIAL_FILE,
    // Instance secrets (src/platform/secrets.mjs): the platform key that wraps household data keys,
    // the MCP key HMAC secret, and the backup key for source snapshots. Paths only.
    platformKeyFile: opt(env.FATHOM_PLATFORM_KEY_FILE),
    mcpSecretFile: opt(env.FATHOM_MCP_SECRET_FILE),
    backupKeyFile: opt(env.FATHOM_BACKUP_KEY_FILE),
    backupDestination: opt(env.FATHOM_BACKUP_DESTINATION),
    backupRetentionDays,
    typesafeKeyFile: opt(env.FATHOM_TYPESAFE_KEY_FILE),
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
    trustedProxies,
    allowedHosts,
    simplefinHosts,
  };
}
