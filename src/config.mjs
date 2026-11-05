// Runtime configuration from the environment. Paths only: secrets are read by the modules that
// need them, from the files named here, never from this module or from tracked files.

import { resolve } from 'node:path';

const ENGINES = ['live', 'fake', 'off'];
const TRANSPORTS = ['dev', 'gmail', 'resend', 'postmark'];

export class ConfigError extends Error {}

function isoDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const blank = v => v == null || v === '';

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

  return {
    dataDir: resolve(blank(env.FATHOM_DATA) ? 'data' : env.FATHOM_DATA),
    port,
    host: blank(env.FATHOM_HOST) ? '127.0.0.1' : env.FATHOM_HOST,
    demo,
    engine,
    clock,
    claudeCredentialFile: blank(env.FATHOM_CLAUDE_CREDENTIAL_FILE) ? null : env.FATHOM_CLAUDE_CREDENTIAL_FILE,
    dataKeyFile: blank(env.FATHOM_DATA_KEY_FILE) ? null : env.FATHOM_DATA_KEY_FILE,
    emailTransport,
  };
}
