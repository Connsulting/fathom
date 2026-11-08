// Demo server lifecycle shared by the docs recorders (scripts/screenshots.mjs, scripts/demo-gif.mjs).
//
// Starts the demo build through e2e/serve.mjs on a caller-chosen port with a wiped top-level
// .e2e-data-* directory (serve.mjs does the wipe), with the caller's FATHOM_ and E2E_ environment
// scrubbed so engine, clock, email and smoke targets take their demo defaults. The server runs in
// its own process group and is always stopped by group, never by name.

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function fail(msg) {
  throw new Error(msg);
}

// Splits argv into the port and any named options. `values` take an argument (--out <dir> or
// --out=<dir>), `flags` take none. Anything else fails with `usage`.
export function parseArgs(args, { portEnv, usage, values = [], flags = [] }) {
  const out = { port: process.env[portEnv] || '' };
  const valueNames = ['port', ...values];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const name = valueNames.find((n) => a === `--${n}` || a.startsWith(`--${n}=`));
    if (name) {
      out[name] = a === `--${name}` ? args[++i] ?? '' : a.slice(`--${name}=`.length);
      continue;
    }
    const flag = flags.find((n) => a === `--${n}`);
    if (flag) {
      out[flag] = true;
      continue;
    }
    fail(`unknown argument ${a}; usage: ${usage}`);
  }
  return out;
}

export function parsePort(raw, { portEnv, usage }) {
  if (!raw) fail(`a port is required: ${usage} (or ${portEnv}=<n>)`);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail(`port must be an integer from 1024 to 65535, got ${raw}`);
  return port;
}

export function portInUse(port) {
  return new Promise((res) => {
    const sock = createConnection({ host: '127.0.0.1', port });
    sock.once('connect', () => { sock.destroy(); res(true); });
    sock.once('error', () => res(false));
  });
}

let server = null;

export function startServer(port, data) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Nothing from the caller's Fathom or e2e setup leaks in: engine, clock, email and smoke
    // targets all take their demo defaults.
    if (/^(FATHOM_|E2E_)/.test(k) || k === 'BASE_URL') continue;
    env[k] = v;
  }
  Object.assign(env, { E2E_DATA: data, FATHOM_PORT: String(port), FATHOM_FAKE_STREAM_MS: '0' });
  server = spawn(process.execPath, [join(repo, 'e2e', 'serve.mjs')], {
    cwd: repo,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  const keep = (b) => { log = (log + b.toString()).slice(-4000); };
  server.stdout.on('data', keep);
  server.stderr.on('data', keep);
  server.log = () => log;
  return server;
}

function serverAlive() {
  return server && server.exitCode === null && server.signalCode === null;
}

function killGroup(sig) {
  try { process.kill(-server.pid, sig); } catch { /* already gone */ }
}

export async function stopServer() {
  if (!server) return;
  if (serverAlive()) {
    const exited = new Promise((res) => server.once('exit', res));
    killGroup('SIGTERM');
    const t = setTimeout(() => killGroup('SIGKILL'), 5000);
    await exited;
    clearTimeout(t);
  }
  // serve.mjs runs the real server as its own child; make sure nothing of the group survives.
  killGroup('SIGKILL');
  server = null;
}

export async function waitHealthy(base) {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    if (!serverAlive()) fail(`demo server exited early:\n${server ? server.log() : ''}`);
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`demo server did not answer /healthz within 120s:\n${server.log()}`);
}

export async function api(base, path, opts = {}) {
  const res = await fetch(`${base}${path}`, opts);
  if (!res.ok) fail(`${opts.method || 'GET'} ${path} returned ${res.status}`);
  return res.json();
}

export const postJson = (base, path, body = {}) => api(base, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const resetDemo = (base) => postJson(base, '/api/demo/reset');

// Starts the server on a free port, waits for it and checks it serves the finished November demo.
// Returns the base URL.
export async function startDemo(port, data) {
  if (await portInUse(port)) fail(`port ${port} is already in use; stop that server or pick another port`);
  const base = `http://127.0.0.1:${port}`;
  startServer(port, data);
  await waitHealthy(base);

  const { live } = await api(base, '/api/scenario');
  if (!live || live.mode !== 'demo') fail('the server is not in demo mode');
  // A fresh demo forces onboarding; e2e/serve.mjs seeds the finished November demo, so this
  // only trips if that changes.
  if (live.demo !== 'november') fail(`expected the November demo, got ${live.demo} (onboarding step ${live.onboardStep})`);
  return base;
}

// Signal and exit handlers that always stop the server. `name` prefixes the message.
export function installCleanup(name) {
  let exiting = false;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, async () => {
      if (exiting) return;
      exiting = true;
      console.error(`${name}: ${sig}, stopping the demo server`);
      await stopServer();
      process.exit(130);
    });
  }
  // Last resort if the process exits some other way: the group kill is synchronous.
  process.on('exit', () => { if (server) killGroup('SIGKILL'); });
}
