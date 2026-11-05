// Test helpers: run the real server as a child process, talk HTTP to it, and open temp stores.
// Source modules are imported lazily so a test file that only needs the HTTP side still loads.

import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import http from 'node:http';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DB_FILE = 'fathom.sqlite';
export const SERVER_TIMEOUT = 30000;

const running = new Set();
process.on('exit', () => { for (const c of running) killGroup(c, 'SIGKILL'); });

export function src(rel) {
  return import(pathToFileURL(join(ROOT, rel)).href);
}

export async function tempDir(prefix = 'fathom-test-') {
  return mkdtemp(join(tmpdir(), prefix));
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Child env: the parent env minus every FATHOM_* key, then `extra`. An undefined value unsets a key.
export function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('FATHOM_')) env[k] = v;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = String(v);
  }
  return env;
}

function killGroup(child, sig) {
  try { process.kill(-child.pid, sig); } catch { /* already gone */ }
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitExit(child, ms) {
  if (exited(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

function launch({ dataDir, port, env, npm }) {
  const cmd = npm ? 'npm' : process.execPath;
  const args = npm ? ['start'] : ['src/server.mjs'];
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: childEnv({ FATHOM_DATA: dataDir, FATHOM_PORT: port, ...env }),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.add(child);
  child.once('exit', () => running.delete(child));
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('error', e => { out += `\nspawn error: ${e.message}`; });
  return { child, output: () => out };
}

async function healthy(baseUrl) {
  try {
    const r = await request(baseUrl, { path: '/healthz' });
    return r.status === 200 && r.json && r.json.ok === true;
  } catch {
    return false;
  }
}

const pause = ms => new Promise(r => setTimeout(r, ms));

// Start `node src/server.mjs` (or `npm start` with npm: true) and wait for GET /healthz.
// Returns { baseUrl, port, dataDir, dbFile, child, output(), stop() }.
export async function spawnServer({ dataDir, env = {}, npm = false, timeoutMs = 20000 } = {}) {
  dataDir = dataDir || await tempDir();
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { child, output } = launch({ dataDir, port, env, npm });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited(child)) {
      throw new Error(`server exited early (code ${child.exitCode}):\n${output()}`);
    }
    if (await healthy(baseUrl)) break;
    if (Date.now() > deadline) {
      killGroup(child, 'SIGKILL');
      throw new Error(`server not healthy after ${timeoutMs} ms:\n${output()}`);
    }
    await pause(100);
  }
  const stop = async () => {
    if (exited(child)) return;
    killGroup(child, 'SIGTERM');
    if (!(await waitExit(child, 5000))) {
      killGroup(child, 'SIGKILL');
      await waitExit(child, 5000);
    }
  };
  return { baseUrl, port, dataDir, dbFile: join(dataDir, DB_FILE), child, output, stop };
}

// Run fn(server) against a fresh server and always stop it.
export async function withServer(opts, fn) {
  const s = await spawnServer(opts);
  try {
    return await fn(s);
  } finally {
    await s.stop();
  }
}

// Start the server expecting it to refuse. Resolves { code, started, output } where started is
// true when it became healthy instead of exiting (it is then killed).
export async function expectServerExit({ dataDir, env = {}, timeoutMs = 15000 } = {}) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { child, output } = launch({ dataDir, port, env, npm: false });
  const deadline = Date.now() + timeoutMs;
  while (!exited(child)) {
    if (await healthy(baseUrl) || Date.now() > deadline) {
      killGroup(child, 'SIGKILL');
      await waitExit(child, 5000);
      return { code: null, started: true, output: output() };
    }
    await pause(100);
  }
  return { code: child.exitCode, started: false, output: output() };
}

// Run a command in the repo root with a clean FATHOM_* env. Resolves { code, stdout, stderr }.
export function runCommand(cmd, args, { env = {}, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} timed out`)); }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

// Raw HTTP so tests control every header (no implicit Origin) and the exact request path.
export function request(baseUrl, { method = 'GET', path = '/', headers = {}, body } = {}) {
  const url = new URL(baseUrl);
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const h = { ...headers };
  if (payload) h['content-length'] = String(payload.length);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method, path, headers: h }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    let answered = false;
    req.on('response', () => { answered = true; });
    req.on('error', e => { if (!answered) reject(e); });
    if (payload) req.write(payload);
    req.end();
  });
}

export function postJson(baseUrl, path, body = {}, headers = {}) {
  return request(baseUrl, {
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export async function getScenario(baseUrl) {
  const r = await request(baseUrl, { path: '/api/scenario' });
  if (r.status !== 200 || !r.json) throw new Error(`GET /api/scenario -> ${r.status}: ${r.text.slice(0, 200)}`);
  return r.json;
}

// Open a migrated store in a fresh temp dir. Returns { db, dataDir, file, close() }.
export async function tempDb() {
  const { openDb, migrate } = await src('src/store/db.mjs');
  const dataDir = await tempDir();
  const file = join(dataDir, DB_FILE);
  const db = openDb(file);
  migrate(db);
  return { db, dataDir, file, close: () => db.close() };
}

// Open an existing store file without migrating it.
export async function openStore(file) {
  const { openDb } = await src('src/store/db.mjs');
  return openDb(file);
}

// Logical dump of every user table (rows as sorted JSON strings) to compare "unchanged".
export async function dumpStore(file) {
  const { openDb, listTables } = await src('src/store/db.mjs');
  const db = openDb(file);
  try {
    const out = {};
    for (const t of listTables(db)) {
      out[t] = db.prepare(`SELECT * FROM "${t}"`).all().map(r => JSON.stringify({ ...r })).sort();
    }
    return out;
  } finally {
    db.close();
  }
}

export const recOf = (scenario, id) => (scenario.recs || []).find(r => r.id === id);
export const paragraphs = list => list.map(p => `<p>${p}</p>`).join('');
