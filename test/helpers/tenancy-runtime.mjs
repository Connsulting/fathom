// Fixtures for the MT-03 tests (test/tenancy-context.test.mjs, test/tenancy-migration.test.mjs,
// test/tenancy-outbound.test.mjs): synthetic instance secrets, an in-process server per data
// directory, a two-household instance built through the real operator route and auth store, and an
// MT-02-layout legacy instance with every store table populated and FTHM1 vault objects.
//
// Every value is synthetic. Modules MT-03 adds or changes (src/server.mjs startServer, the
// household vault, src/platform/legacy-vault.mjs, src/platform/migrate-tenancy.mjs) are imported
// lazily through src(), so a test file loads before they exist and fails on the missing module.
//
// Assumptions (the plan is silent):
// 1. Key files hold 64 hex characters plus a newline, mode 0600 (the formats loadKeyFile and the
//    legacy key parser accept). The MCP secret file holds the 64 hex characters of api-key-secret.
// 2. migrateLegacyStore (MT-01 migratePlatform) still produces the MT-02 layout after MT-03; it must
//    stop below store migration 025 because the legacy fixture still holds api_keys rows.
// 3. The legacy fixture's rows are inserted with raw SQL (the ingest pipeline writes FTHM2 under a
//    household root after the cutover, so it cannot build an FTHM1 legacy store). The answered
//    Confirm item goes through the real src/ingest/confirm.mjs ask and answer, so its undo log is
//    the one production writes.

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';
import { ROOT, src, tempDir, freePort, migrateLegacyStore, runCommand, sessionClient } from './server.mjs';
import { buildLegacyStore, fileHashes } from './tenancy.mjs';
import { aggregatorCsv } from './ingest.mjs';
import { writeSyntheticPack } from './packs.mjs';
import { openDb, listTables, setSetting } from '../../src/store/db.mjs';

export const CLOCK = '2026-11-05';
export const T0 = '2026-10-01T09:00:00.000Z';
export const T1 = '2026-10-15T09:00:00.000Z';
export const SIMPLEFIN_PASSWORD = 'canary-pass-4417';
export const SIMPLEFIN_URL = `https://synthetic-user:${SIMPLEFIN_PASSWORD}@sfin.example.invalid/simplefin`;
export const LEGACY_SIMPLEFIN_AAD = 'simplefin:access';
export const OUTBOUND_KINDS = Object.freeze(['jobs', 'email', 'simplefin', 'engine']);
export const PAUSED = Object.freeze({ enabled: false, effective: false, reason: 'paused' });
export const MEMBERSHIP_REQUIRED = Object.freeze({ error: 'household membership required' });
export const ADMIN_REQUIRED = Object.freeze({ error: 'administrator required' });
export const PLAN_ENTRY = 'household-plan';
// Tables a populated legacy store may leave empty: bookkeeping, not household data.
export const BOOKKEEPING_TABLES = Object.freeze(['schema_migrations', 'store_identity']);

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hex32 = () => randomBytes(32).toString('hex');

// ------------------------------------------------------------------------------ secrets

export function writePrivate(file, text) {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

// Synthetic instance secrets in `dir` (outside any data directory). secretHex: the MCP HMAC
// secret as 64 hex characters (a migrated instance passes its api-key-secret). Returns the file
// paths and the raw values.
export function writeInstanceKeys(dir, { secretHex = hex32() } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const platformKeyHex = hex32();
  const backupKeyHex = hex32();
  const legacyKeyHex = hex32();
  return {
    dir,
    platformKeyFile: writePrivate(join(dir, 'platform.key'), platformKeyHex + '\n'),
    backupKeyFile: writePrivate(join(dir, 'backup.key'), backupKeyHex + '\n'),
    legacyKeyFile: writePrivate(join(dir, 'data.key'), legacyKeyHex + '\n'),
    mcpSecretFile: writePrivate(join(dir, 'mcp.secret'), secretHex + '\n'),
    platformKey: Buffer.from(platformKeyHex, 'hex'),
    backupKey: Buffer.from(backupKeyHex, 'hex'),
    legacyKey: Buffer.from(legacyKeyHex, 'hex'),
    platformKeyHex, backupKeyHex, legacyKeyHex, secretHex,
  };
}

// ------------------------------------------------------------------------------ in-process server

// The env loadConfig reads for a real in-process server on `port`.
export function serverEnv({ dataDir, port, keys, engine = 'fake', extra = {} }) {
  const env = {
    FATHOM_DATA: dataDir, FATHOM_DEMO: '0', FATHOM_ENGINE: engine, FATHOM_PORT: String(port), FATHOM_HOST: 'localhost',
    FATHOM_PUBLIC_URL: `http://localhost:${port}`, FATHOM_CLOCK: CLOCK, FATHOM_FAKE_STREAM_MS: '0',
    FATHOM_EMAIL_TRANSPORT: 'dev', FATHOM_EMAIL_FROM: 'sender@example.test',
    ...(keys ? { FATHOM_PLATFORM_KEY_FILE: keys.platformKeyFile, FATHOM_MCP_SECRET_FILE: keys.mcpSecretFile } : {}),
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = String(v);
  }
  return env;
}

// startServer(loadConfig(env)) on a free port. Returns { app, baseUrl, port, env, close() }.
export async function startRuntime({ dataDir, keys, engine = 'fake', extra = {} }) {
  const { startServer } = await src('src/server.mjs');
  const { loadConfig } = await src('src/config.mjs');
  const port = await freePort();
  const env = serverEnv({ dataDir, port, keys, engine, extra });
  const app = await startServer(loadConfig(env));
  let closed = false;
  return {
    app, port, env, baseUrl: `http://localhost:${port}`,
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
    },
  };
}

// The startServer refusal for this env (null when it started; it is closed again).
export async function startRefusal({ dataDir, keys, engine = 'fake', extra = {} }) {
  try {
    const s = await startRuntime({ dataDir, keys, engine, extra });
    await s.close();
    return null;
  } catch (err) {
    return err;
  }
}

// ------------------------------------------------------------------------------ accounts

// An enrolled user with an active `role` membership in `householdId` and a live session, built
// only through the auth store (invite, consume, markEnrolled, createSession), the way
// createSessionFixture does for the served household. An existing active member is reused.
// Returns { user, householdId, role, token, cookie }.
export async function enrollSession(platform, householdId, email, role = 'member') {
  const { createAuthStore } = await src('src/auth/store.mjs');
  const store = createAuthStore(platform);
  let user = store.findUser(email);
  if (!user || store.membership(user.id, householdId)?.status !== 'active') {
    const invited = store.invite(householdId, email, { role });
    store.consumeInvitation(invited.token, invited.user.id);
    user = invited.user;
  }
  if (store.getUser(user.id).enrolledAt == null) store.markEnrolled(user.id);
  user = store.getUser(user.id);
  const { token } = store.createSession(user.id);
  return { user, householdId, role: store.membership(user.id, householdId).role, token, cookie: `__Host-fathom-session=${token}` };
}

export const sessionHash = token => sha256(token);

// ------------------------------------------------------------------------------ HTTP helpers

// Raw bytes of a GET (downloads and zips).
export async function getBytes(baseUrl, path, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, headers: res.headers, bytes: Buffer.from(await res.arrayBuffer()) };
}

// Multipart POST /api/files. files: [{ name, bytes, type }]. Returns { status, text, json }.
export async function uploadFiles(baseUrl, session, files) {
  const fd = new FormData();
  for (const f of files) fd.append('files', new Blob([f.bytes], { type: f.type || 'text/csv' }), f.name);
  const headers = session ? { cookie: session.cookie, origin: new URL(baseUrl).origin } : {};
  const res = await fetch(`${baseUrl}/api/files`, { method: 'POST', headers, body: fd });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json };
}

let rpcId = 1;
// One JSON-RPC request to POST /mcp with a bearer key (and any extra headers, such as a cookie).
export async function mcp(baseUrl, key, method, params = {}, headers = {}) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18',
      ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json };
}

// The text content of a tools/call result.
export const toolText = r => (r.json?.result?.content ?? []).map(c => c.text ?? '').join('\n');

// ------------------------------------------------------------------------------ two households

// One real in-process instance with two active synthetic households:
// A is the instance created on an empty data directory; B is provisioned through
// POST /api/operator/households by an operator (A's admin, granted through the auth store) after
// multi_household_enabled is seeded in this disposable platform DB, and becomes active when its
// admin consumes the first admin invitation (plan revision 8). Sessions: A admin, B admin, and a
// user with active memberships in both and no session household.
// Returns { root, dataDir, keys, server, app, baseUrl, platform, store, A, B, dual, rootOf(id), ctx(id), close() }
// where A and B are { id, admin (session), client }.
export async function twoHouseholds({ engine = 'fake', extra = {} } = {}) {
  const root = await tempDir('fathom-mt03-two-');
  const dataDir = join(root, 'data');
  const keys = writeInstanceKeys(join(root, 'keys'));
  let server;
  try {
    server = await startRuntime({ dataDir, keys, engine, extra: { FATHOM_EMAIL_TO: 'both-member@example.test', ...extra } });
    const { app, baseUrl } = server;
    const platform = app.platform;
    const { createAuthStore } = await src('src/auth/store.mjs');
    const store = createAuthStore(platform);
    const served = platform.prepare('SELECT id FROM households WHERE serves_store = 1').get();
    if (!served) throw new Error('fixture: the fresh instance has no household');
    const A = { id: served.id };
    A.admin = await enrollSession(platform, A.id, 'alpha-admin@example.test', 'admin');
    A.client = sessionClient(baseUrl, A.admin);
    store.grantOperator(A.admin.user.id);
    store.setPlatformSetting('multi_household_enabled', true);
    const made = await A.client.postJson('/api/operator/households', { displayName: 'Synthetic Bravo Household', adminEmail: 'bravo-admin@example.test' });
    if (made.status !== 200) throw new Error(`fixture: operator route -> ${made.status} ${made.text.slice(0, 200)}`);
    const B = { id: made.json.household.id };
    B.admin = await enrollSession(platform, B.id, 'bravo-admin@example.test', 'admin');
    B.client = sessionClient(baseUrl, B.admin);
    const dualA = await enrollSession(platform, A.id, 'both-member@example.test', 'member');
    await enrollSession(platform, B.id, 'both-member@example.test', 'member');
    const dualSession = store.createSession(dualA.user.id);
    platform.prepare('UPDATE auth_sessions SET household_id = NULL WHERE hash = ?').run(sessionHash(dualSession.token));
    const dual = { user: dualA.user, token: dualSession.token, cookie: `__Host-fathom-session=${dualSession.token}` };
    dual.client = sessionClient(baseUrl, dual);
    return {
      root, dataDir, keys, server, app, baseUrl, platform, store, A, B, dual,
      rootOf: id => join(dataDir, 'households', id),
      ctx: id => app.runtimes.get(id),
      async close() {
        await server.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await server?.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

// A private Your plans pack (id your-plans) in a household root with one entry PLAN_ENTRY whose
// title and body carry `canary`.
export function writePlansPack(rootPath, canary) {
  return writeSyntheticPack(rootPath, {
    id: 'your-plans', name: 'Your plans', curator: 'Synthetic test fixture', covers: ['synthetic plan coverage'],
    entries: [{ file: `${PLAN_ENTRY}.md`, title: `${canary} plan`, body: `# ${canary} plan\n\nSynthetic ${canary} entry body with no numbers.\n` }],
  });
}

// ------------------------------------------------------------------------------ sqlite digests

const plainValue = v => (v instanceof Uint8Array ? `blob:${Buffer.from(v).toString('hex')}` : typeof v === 'bigint' ? String(v) : v);
const canonical = row => JSON.stringify(Object.keys(row).sort().map(k => [k, plainValue(row[k])]));

export function withSqlite(file, fn) {
  if (!existsSync(file)) throw new Error(`no database at ${file}`);
  const db = new DatabaseSync(file);
  try { return fn(db); } finally { db.close(); }
}

const hasRowid = (db, table) => {
  try { db.prepare(`SELECT rowid FROM "${table}" LIMIT 1`).all(); return true; } catch { return false; }
};

// Rows of a table as canonical strings, rowid included (as __rowid) for rowid tables, in rowid
// order. `omit` drops columns; `where` filters rows.
export function tableRows(db, table, { omit = [], where = null } = {}) {
  const rowid = hasRowid(db, table);
  const sql = `SELECT ${rowid ? 'rowid AS __rowid, ' : ''}* FROM "${table}"${where ? ` WHERE ${where}` : ''}${rowid ? ' ORDER BY rowid' : ''}`;
  const rows = db.prepare(sql).all().map(r => {
    const out = { ...r };
    for (const c of omit) delete out[c];
    return canonical(out);
  });
  return rowid ? rows : rows.sort();
}

// table -> { count, digest } for every table of a store file. `rules` maps a table to
// { omit, where } for tableRows.
export function tableDigests(file, rules = {}) {
  return withSqlite(file, db => {
    const out = {};
    for (const t of listTables(db)) {
      const rows = tableRows(db, t, rules[t] ?? {});
      out[t] = { count: rows.length, digest: sha256(rows.join('\n')) };
    }
    return out;
  });
}

// ------------------------------------------------------------------------------ legacy fixture

const csvBytes = () => Buffer.from(aggregatorCsv([
  { date: '2026-10-02', amount: '42.17', description: 'Synthetic grocer', account: 'Synthetic checking', number: '5550001111' },
  { date: '2026-10-03', amount: '-2500.00', description: 'Synthetic client payment', account: 'Synthetic checking', number: '5550001111' },
]));
const noteBytes = () => Buffer.from('# Synthetic plan note\n\nKeep a synthetic reserve for the household.\n');
const PACKET_HTML = '<!doctype html><html><body><h1>Synthetic advisor packet</h1><p>Synthetic figures only.</p></body></html>\n';
const fileIdOf = bytes => 'f-' + sha256(bytes).slice(0, 24);

// Populates an MT-02-layout store at `dataDir` (closed by every other connection) with synthetic
// rows in every application table, FTHM1 vault objects under files/, a private pack and an outbox
// message. Returns the artifacts the tests compare.
async function populateLegacy(dataDir, legacyKey) {
  const { encrypt } = await src('src/platform/legacy-vault.mjs');
  const confirm = await src('src/ingest/confirm.mjs');
  const filesDir = join(dataDir, 'files');
  mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  chmodSync(filesDir, 0o700);
  const writeBlob = (id, bytes) => writeFileSync(join(filesDir, `${id}.bin`), encrypt(legacyKey, bytes, id), { mode: 0o600 });

  const uploads = [
    { id: null, name: 'synthetic-checking.csv', mime: 'text/csv', bytes: csvBytes(), kind: 'aggregator_csv', parser: 'aggregator', status: 'imported' },
    { id: null, name: 'synthetic-plan-note.md', mime: 'text/markdown', bytes: noteBytes(), kind: 'notes', parser: 'notes', status: 'needs_extraction' },
  ];
  for (const u of uploads) u.id = fileIdOf(u.bytes);
  const packet = { id: `advpkt-${randomBytes(8).toString('hex')}`, bytes: Buffer.from(PACKET_HTML) };
  const [f1, f2] = uploads.map(u => u.id);

  const db = openDb(join(dataDir, 'fathom.sqlite'));
  let confirmItemId;
  try {
    const run = (sql, ...args) => db.prepare(sql).run(...args);
    setSetting(db, 'clock', CLOCK);
    setSetting(db, 'onboarding', { done: true, step: 6 });
    run("INSERT INTO content (key, value, src, updated_at) VALUES ('synthetic.note', '\"Synthetic content\"', 'you', ?)", T0);
    run("INSERT INTO sources (id, label, as_of, kind, last_ingest_at, note) VALUES ('src-synthetic', 'Synthetic bank export', '2026-10-01', 'file', ?, 'Synthetic source')", T0);
    for (const u of uploads) {
      run(`INSERT INTO files (id, name, mime, size, sha256, source_kind, uploaded_at, stored_path, status, note, parser, counts, source_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, '{}', 'src-synthetic')`,
      u.id, u.name, u.mime, u.bytes.length, sha256(u.bytes), u.kind, T0, `files/${u.id}.bin`, u.status, u.parser);
      writeBlob(u.id, u.bytes);
    }
    // A files row deleted again: a rowid gap in a table whose rowid is not its key.
    run("INSERT INTO files (id, name, uploaded_at, status) VALUES ('f-synthetic-gap-00000001', 'gap.csv', ?, 'error')", T0);

    const account = (id, mask, name, kind, sort, inst = 'Example Bank') => run(
      `INSERT INTO accounts (id, inst, mask, name, owner, kind, file_id, parser, locator, sort, source_id)
       VALUES (?, ?, ?, ?, 'You', ?, ?, 'aggregator', ?, ?, 'src-synthetic')`, id, inst, mask, name, kind, f1, `row:${sort}`, sort);
    account('acct-syn-check', '1111', 'Synthetic checking', 'checking', 0);
    account('acct-syn-gap', '9999', 'Synthetic gap account', 'checking', 9);
    account('acct-syn-save', '2222', 'Synthetic savings', null, 1);
    account('acct-syn-broker', '3333', 'Synthetic brokerage', 'taxable', 2, 'Example Brokerage');
    run("INSERT INTO account_holders (account_id, holder, file_id, locator, created_at) VALUES ('acct-syn-check', 'Synthetic Holder', ?, 'row:1', ?)", f1, T0);
    run("INSERT INTO balances (account_id, date, amount, file_id, parser, locator, dedupe_key) VALUES ('acct-syn-check', '2026-10-31', 5400.25, ?, 'aggregator', 'row:1', 'bal:1')", f1);
    run("INSERT INTO balances (account_id, date, amount, file_id, parser, locator, dedupe_key) VALUES ('acct-syn-save', '2026-10-31', 12000, ?, 'aggregator', 'row:2', 'bal:2')", f1);
    const tx = (n, amount, description) => Number(run(
      `INSERT INTO transactions (account_id, date, amount, description, category, external_id, dedupe_key, file_id, parser, locator, occurrence)
       VALUES ('acct-syn-check', ?, ?, ?, 'Other', NULL, ?, ?, 'aggregator', ?, 1)`, `2026-10-0${n}`, amount, description, `tx:${n}`, f1, `row:${n}`).lastInsertRowid);
    const t1 = tx(1, -42.17, 'Synthetic grocer');
    const t2 = tx(2, -18.5, 'Synthetic gap row');
    const t3 = tx(3, -27.4, 'Synthetic diner');
    const t4 = tx(4, -15, 'Synthetic software');
    tx(5, 2500, 'Synthetic client payment');
    run("INSERT INTO transaction_category_corrections (transaction_id, category, bucket, updated_at) VALUES (?, 'Groceries', 'household', ?)", t1, T0);
    run("INSERT INTO transaction_category_guesses (transaction_id, category, model, updated_at) VALUES (?, 'Dining', 'fake', ?)", t3, T0);
    run(`INSERT INTO transaction_category_imports (transaction_id, dedupe_key, category, parser, file_id, locator, date, description, updated_at)
      VALUES (?, 'imp:4', 'Software', 'aggregator', ?, 'row:4', '2026-10-04', 'Synthetic software', ?)`, t4, f1, T0);
    run("INSERT INTO category_merchant_rules (merchant, category, bucket, updated_at) VALUES ('synthetic grocer', 'Groceries', 'household', ?)", T0);
    run("INSERT INTO category_source_rules (parser, category, bucket, updated_at) VALUES ('aggregator', 'Software', 'business', ?)", T0);
    run(`INSERT INTO positions (account_id, as_of, symbol, name, quantity, price, value, cost_basis, file_id, parser, locator, dedupe_key)
      VALUES ('acct-syn-broker', '2026-10-31', 'SYNX', 'Synthetic Index Fund', 10, 100, 1000, 800, ?, 'positions', 'row:1', 'pos:1')`, f1);
    run("INSERT INTO column_mappings (signature, mapping, src, created_at, uses) VALUES ('sig-synthetic', '{\"date\":0,\"amount\":1}', 'owner', ?, 2)", T0);
    run("INSERT INTO entity_aliases (alias, entity, created_at) VALUES ('Synthetic Studio LLC', 'Synthetic Studio', ?)", T0);
    run("INSERT INTO pnl_lines (entity, period, category, amount, file_id, parser, locator, dedupe_key) VALUES ('Synthetic Studio', '2026-09', 'Income', 4200, ?, 'pnl', 'r1', 'pnl:1')", f1);
    run(`INSERT INTO tax_payments (jurisdiction, tax_year, date, amount, kind, file_id, parser, locator, dedupe_key)
      VALUES ('federal', 2026, '2026-09-15', 1500, 'estimate', ?, 'aggregator', 'row:9', 'tax:1')`, f1);
    run("INSERT INTO documents (doc_type, tax_year, fields, file_id, parser, locator, dedupe_key) VALUES ('w2', 2025, '{\"employer\":\"Example Employer\"}', ?, 'notes', 'doc:1', 'doc:1')", f2);
    run("INSERT INTO held_facts (hold, key, value, file_id, parser, locator, confidence, created_at) VALUES ('hold-synthetic', 'synthetic.fact', '\"held\"', ?, 'notes', 'l1', 0.5, ?)", f2, T0);
    run("INSERT INTO facts (key, value, src, as_of, confirmed, updated_at) VALUES ('household.dependents', '2', 'you', '2026-10-01', 1, ?)", T0);
    run("INSERT INTO figures (key, v, src, kind, label, file_id, parser, locator, updated_at) VALUES ('synthetic.cash', 5400.25, 'src-synthetic', 'a', 'Synthetic cash', ?, 'aggregator', 'row:1', ?)", f1, T0);
    run("INSERT INTO superseded_rows (table_name, dedupe_key, row, file_id, superseded_by, reason, at, survivor_key) VALUES ('transactions', 'tx:old', '{\"amount\":1}', ?, ?, 'revised', ?, 'tx:1')", f1, f2, T0);
    run("INSERT INTO events (date, kind, title, body, sort, src) VALUES ('2026-10-02', 'note', 'Synthetic event', 'Synthetic body', 0, 'you')");

    const rec = (id, title, status, sort) => run(`INSERT INTO recs (id, def, status, tasks_done, sort, updated_at, owner)
      VALUES (?, ?, ?, '[]', ?, ?, 'you')`, id, JSON.stringify({ id, title, summary: `${title} summary`, domain: 'data' }), status, sort, T0);
    rec('syn-rec-alpha', 'Synthetic alpha review', 'proposed', 0);
    rec('syn-rec-gap', 'Synthetic gap rec', 'proposed', 5);
    rec('syn-rec-beta', 'Synthetic beta task', 'doing', 1);
    run("INSERT INTO rec_events (rec_id, ts, action, arg, from_status, to_status, actor) VALUES ('syn-rec-beta', ?, 'start', NULL, 'proposed', 'doing', 'you')", T0);
    run("INSERT INTO deadlines (date, label, title, rec_id, hard, src) VALUES ('2027-01-15', 'Q4', 'Synthetic Q4 estimate', 'syn-rec-alpha', 1, 'you')");
    run(`INSERT INTO decisions (id, title, status, rec_id, note, sort, src) VALUES ('dec-synthetic', 'Synthetic decision', 'open', 'syn-rec-alpha', 'Synthetic note', 0, 'you')`);
    run("INSERT INTO goals (id, def, sort, origin, created_at, updated_at) VALUES ('g000000000001', ?, 0, 'owner', ?, ?)",
      JSON.stringify({ id: 'g000000000001', title: 'Synthetic cushion', note: '', horizon: '1-3y' }), T0, T0);

    run("INSERT INTO jobs (id, name, cadence, does, cost, next_label, last_label, enabled, sort) VALUES ('plan', 'Plan', 'nightly', 'Synthetic planning', NULL, NULL, NULL, 1, 0)");
    const jobRun = (note, period) => Number(run(`INSERT INTO job_runs (job_id, started_at, finished_at, status, cost_usd, note, period_key, trigger, duration_ms)
      VALUES ('plan', ?, ?, 'ok', 0, ?, ?, 'schedule', 1000)`, T0, T0, note, period).lastInsertRowid);
    const run1 = jobRun('synthetic first', '2026-09-30');
    const runGap = jobRun('synthetic gap', '2026-10-01');
    const run2 = jobRun('synthetic second', '2026-10-02');
    run(`INSERT INTO planner_recs (rec_id, trigger_id, grounding_hash, prose_src, first_run, last_run)
      VALUES ('syn-rec-beta', 'trigger-synthetic', 'hash-synthetic', 'template', ?, ?)`, run1, run2);
    run("INSERT INTO job_lock (id, holder, expires_at) VALUES (1, 'synthetic-holder', '2026-10-01T09:05:00.000Z')");
    run("INSERT INTO spend_ledger (ts, yyyymm, purpose, cost_usd, model, tokens) VALUES (?, '2026-10', 'chat', 0.01, 'fake', '{}')", T0);
    const send = Number(run(`INSERT INTO email_sends (ts, kind, subject, status, error_code, transport, recipients, message_id, job_run_id)
      VALUES (?, 'test', 'Fathom test email', 'sent', NULL, 'dev', 1, 'msg-synthetic-1', NULL)`, T0).lastInsertRowid);
    run("INSERT INTO deadline_alerts (key, threshold, deadline_date, sent_at, send_id) VALUES ('syn-deadline', 7, '2027-01-15', ?, ?)", T0, send);

    run("INSERT INTO conversations (key, created_at, title, title_source, last_at) VALUES ('ask:0a1b2c3d4e5f', ?, 'Synthetic thread', 'auto', ?)", T0, T1);
    run("INSERT INTO messages (conversation_key, role, text, refs, notice, ts) VALUES ('ask:0a1b2c3d4e5f', 'me', 'Synthetic question', '[]', 0, ?)", T0);
    run("INSERT INTO messages (conversation_key, role, text, refs, notice, ts) VALUES ('ask:0a1b2c3d4e5f', 'fathom', '<p>Synthetic answer.</p>', '[]', 0, ?)", T0);
    run(`INSERT INTO packs_state (id, def, active, exploring, what_if_asked, what_if_done, unhid, sort, updated_at)
      VALUES ('syn-pack-row', ?, NULL, 0, 0, 0, '[]', 50, ?)`, JSON.stringify({ id: 'syn-pack-row', name: 'Synthetic pack row', status: 'available', recIds: [] }), T0);

    run("INSERT INTO advisor_checkin (id, date, time, length_min, updated_at) VALUES (1, '2026-12-01', '10:00', 30, ?)", T0);
    run("INSERT INTO advisor_reviews (rec_id, title, sent_at, note) VALUES ('syn-rec-alpha', 'Synthetic alpha review', ?, '')", T0);
    run(`INSERT INTO advisor_packets (id, created_at, clock, rec_ids, stored_path, bytes, sha256) VALUES (?, ?, ?, '["syn-rec-alpha"]', ?, ?, ?)`,
      packet.id, T0, CLOCK, `files/${packet.id}.bin`, packet.bytes.length, sha256(packet.bytes));
    writeBlob(packet.id, packet.bytes);
    run("INSERT INTO yearend_marks (tax_year, item_key, reason, marked_at) VALUES (2026, 'synthetic-item', 'not_applicable', ?)", T0);
    run("INSERT INTO yearend_packets (tax_year, generated_at, counts, bytes) VALUES (2025, ?, '{}', 1234)", T0);

    const access = encrypt(legacyKey, Buffer.from(SIMPLEFIN_URL, 'utf8'), LEGACY_SIMPLEFIN_AAD).toString('base64');
    run("INSERT INTO simplefin_connection (id, access_blob, connected_at, last_sync_at, status, accounts) VALUES (1, ?, ?, ?, 'ok', 1)", access, T0, T1);
    run("INSERT INTO simplefin_accounts (sf_key, account_id, status, name, backfilled, created_at) VALUES ('sf-synthetic-1', 'acct-syn-check', 'linked', 'Synthetic checking', 1, ?)", T0);
    run("INSERT INTO simplefin_snapshots (sf_key, snapshot, at) VALUES ('sf-synthetic-1', '{\"inst\":\"Example Bank\",\"name\":\"Synthetic checking\",\"mask\":\"1111\"}', ?)", T0);

    // Confirm: the epoch first (an answer records it), then a real ask and answer through
    // src/ingest/confirm.mjs, so the undo log references the savings account's rowid (after a gap).
    run('INSERT INTO ingest_epoch (id, n) VALUES (1, 3) ON CONFLICT(id) DO UPDATE SET n = 3');
    const KIND_OPTIONS = confirm.KIND_OPTIONS;
    const asked = confirm.ask(db, { kind: 'account_kind', subject: 'acct-syn-save', question: 'What kind of account is Synthetic savings?',
      options: KIND_OPTIONS, context: {}, fileId: f1, now: T0 });
    confirmItemId = asked.id;
    confirm.answer(db, confirmItemId, 'checking', { now: T1 });
    const pending = confirm.ask(db, { kind: 'account_owner', subject: 'acct-syn-broker', question: 'Whose account is Synthetic brokerage?',
      options: confirm.OWNER_OPTIONS, context: {}, fileId: f1, now: T0 });
    run("INSERT INTO confirm_guesses (item_id, option_id, reason, model, ts) VALUES (?, 'owner', 'Synthetic reason', 'fake', ?)", pending.id, T0);
    const rawItem = (subject) => Number(run(`INSERT INTO confirm_items (kind, subject, question, options, context, status, answer, file_id, created_at, answered_at)
      VALUES ('fact_check', ?, 'Is the synthetic fact right?', '[{"id":"yes","label":"Yes"},{"id":"no","label":"No"}]', '{}', 'answered', 'yes', ?, ?, ?)`,
    subject, f2, T0, T0).lastInsertRowid);
    run("INSERT INTO confirm_auto (item_id, rule, evidence, created_at) VALUES (?, 'holder_match', '{\"text\":\"Synthetic evidence\",\"basis\":[],\"ancestors\":[]}', ?)", rawItem('synthetic.auto'), T0);
    run('INSERT INTO confirm_auto_declined (item_id, at) VALUES (?, ?)', rawItem('synthetic.declined'), T0);

    // Rowid gaps.
    run("DELETE FROM files WHERE id = 'f-synthetic-gap-00000001'");
    run("DELETE FROM accounts WHERE id = 'acct-syn-gap'");
    run("DELETE FROM recs WHERE id = 'syn-rec-gap'");
    run('DELETE FROM transactions WHERE id = ?', t2);
    run('DELETE FROM job_runs WHERE id = ?', runGap);

    const empty = listTables(db).filter(t => !BOOKKEEPING_TABLES.includes(t) && db.prepare(`SELECT count(*) AS n FROM "${t}"`).get().n === 0);
    if (empty.length) throw new Error(`fixture: tables left empty: ${empty.join(', ')}`);
  } finally {
    db.close();
  }

  const packDir = writePlansPack(dataDir, 'Synthetic legacy');
  const outboxDir = join(dataDir, 'outbox');
  mkdirSync(outboxDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(outboxDir, '20261001T090000000Z-1.json'), JSON.stringify({
    from: 'sender@example.test', to: ['legacy-admin@example.test'], subject: 'Synthetic brief', text: 'Synthetic body.', date: T0,
  }, null, 2), { mode: 0o600 });
  return { uploads, packet, confirmItemId, confirmAccountId: 'acct-syn-save', packDir, outboxDir };
}

// An MT-02-layout real instance in `<root>/data`: platform.sqlite (MT-01 migrated, one served
// household), root fathom.sqlite with every application table populated, api-key-secret, files/
// with FTHM1 uploads and an advisor packet, a FTHM1 SimpleFIN secret, packs/your-plans and
// outbox/. Keys (platform, backup, legacy data key, MCP secret) live in `<root>/keys`.
// admins: 1 (the ownerless key binds to the admin) or 2 (the member is promoted; the ownerless key
// is revoked with migration_no_creator).
export async function buildMigrationFixture(root, { admins = 1 } = {}) {
  const dataDir = join(root, 'data');
  const legacy = await buildLegacyStore(dataDir, { users: true });
  await migrateLegacyStore(dataDir);
  const keys = writeInstanceKeys(join(root, 'keys'), { secretHex: legacy.secretHex });
  const artifacts = await populateLegacy(dataDir, keys.legacyKey);
  const householdId = withSqlite(join(dataDir, 'platform.sqlite'), p => {
    const rows = p.prepare('SELECT id FROM households').all();
    if (rows.length !== 1) throw new Error('fixture: expected exactly one household');
    if (admins === 2) p.prepare("UPDATE household_memberships SET role = 'admin' WHERE user_id = ?").run(legacy.member.id);
    return rows[0].id;
  });
  const secrets = [...legacy.secrets, SIMPLEFIN_URL, SIMPLEFIN_PASSWORD, keys.legacyKeyHex, keys.platformKeyHex, keys.backupKeyHex];
  return {
    root, dataDir, householdId, keys, legacy, artifacts, secrets, admins,
    admin: legacy.admin, member: legacy.member, ownedKey: legacy.ownedKey, ownerlessKey: legacy.ownerlessKey,
  };
}

// A copy of a built fixture's data directory under `root` (keys stay shared).
export function copyFixture(fx, root) {
  const dataDir = join(root, 'data');
  cpSync(fx.dataDir, dataDir, { recursive: true });
  return { ...fx, root, dataDir };
}

export const migrationOptions = (fx, over = {}) => ({
  dataDir: fx.dataDir, backupKeyFile: fx.keys.backupKeyFile, legacyKeyFile: fx.keys.legacyKeyFile,
  platformKeyFile: fx.keys.platformKeyFile, mcpSecretFile: fx.keys.mcpSecretFile, ...over,
});

export async function runMigration(fx, over = {}) {
  const { migrateTenancy } = await src('src/platform/migrate-tenancy.mjs');
  return migrateTenancy(migrationOptions(fx, over));
}

export const migrationEnv = fx => ({
  FATHOM_DATA: fx.dataDir, FATHOM_BACKUP_KEY_FILE: fx.keys.backupKeyFile, FATHOM_DATA_KEY_FILE: fx.keys.legacyKeyFile,
  FATHOM_PLATFORM_KEY_FILE: fx.keys.platformKeyFile, FATHOM_MCP_SECRET_FILE: fx.keys.mcpSecretFile,
});

export const migrateCli = (fx, env = migrationEnv(fx)) => runCommand(process.execPath, ['scripts/migrate-tenancy.mjs'], { env, timeoutMs: 120000 });

const EXIT_CHILD = `
const { migrateTenancy } = await import(process.env.MIGRATE_URL);
const at = process.env.EXIT_AT;
await migrateTenancy({
  dataDir: process.env.FATHOM_DATA, backupKeyFile: process.env.FATHOM_BACKUP_KEY_FILE, legacyKeyFile: process.env.FATHOM_DATA_KEY_FILE,
  platformKeyFile: process.env.FATHOM_PLATFORM_KEY_FILE, mcpSecretFile: process.env.FATHOM_MCP_SECRET_FILE,
  onPhase: async name => { if (name === at) process.exit(9); },
});
process.exit(0);
`;

// migrateTenancy in a child process that exits 9 inside onPhase(exitAt). Resolves { code, stdout, stderr }.
export function migrateExitingAt(fx, exitAt) {
  return runCommand(process.execPath, ['--input-type=module', '-e', EXIT_CHILD], {
    env: { ...migrationEnv(fx), EXIT_AT: exitAt, MIGRATE_URL: pathToFileURL(join(ROOT, 'src/platform/migrate-tenancy.mjs')).href },
    timeoutMs: 120000,
  });
}

// ------------------------------------------------------------------------------ expectations

// The digest rules shared by the before and after comparison: simplefin_connection without its
// access blob (the ciphertext changes envelope), schema_migrations only up to `throughId`.
export const digestRules = throughId => ({
  simplefin_connection: { omit: ['access_blob'] },
  schema_migrations: { where: `id <= ${Number(throughId)}` },
});

// The scenario GET /api/scenario would build for the legacy store: a rowid-preserving copy of the
// store, live packs over the legacy data directory refreshed as the server does at startup, then
// src/api/handlers.mjs scenarioOf. The copy keeps the source unchanged.
export async function legacyScenario(fx) {
  const { scenarioOf } = await src('src/api/handlers.mjs');
  const { createLivePacks } = await src('src/packs/live.mjs');
  const copy = join(fx.root, 'scenario-copy.sqlite');
  rmSync(copy, { force: true });
  const source = new DatabaseSync(join(fx.dataDir, 'fathom.sqlite'));
  try { await backup(source, copy); } finally { source.close(); }
  const db = openDb(copy);
  try {
    const packs = createLivePacks(db, { dataDir: fx.dataDir });
    packs.refresh();
    const config = { clock: CLOCK, engine: 'fake', dataDir: fx.dataDir };
    return structuredClone(scenarioOf({ db, config, packs, household: { db, root: fx.dataDir, packs, config } }));
  } finally {
    db.close();
    rmSync(copy, { force: true });
    rmSync(`${copy}-wal`, { force: true });
    rmSync(`${copy}-shm`, { force: true });
  }
}

// Everything the success case compares, recorded from the legacy layout before migration.
export async function recordExpectations(fx) {
  const storeFile = join(fx.dataDir, 'fathom.sqlite');
  const maxMigration = withSqlite(storeFile, db => db.prepare('SELECT max(id) AS m FROM schema_migrations').get().m);
  const plaintexts = {};
  for (const u of fx.artifacts.uploads) plaintexts[`upload:${u.id}`] = sha256(u.bytes);
  plaintexts[`advisor-packet:${fx.artifacts.packet.id}`] = sha256(fx.artifacts.packet.bytes);
  return {
    maxMigration,
    digests: tableDigests(storeFile, digestRules(maxMigration)),
    tables: withSqlite(storeFile, db => listTables(db)),
    scenario: await legacyScenario(fx),
    plaintexts,
    simplefinUrl: SIMPLEFIN_URL,
    packHashes: fileHashes(join(fx.dataDir, 'packs')),
    outboxHashes: fileHashes(join(fx.dataDir, 'outbox')),
    apiKeys: withSqlite(storeFile, db => db.prepare('SELECT * FROM api_keys ORDER BY id').all().map(r => ({ ...r }))),
  };
}

// Plaintext sha256 of every vault object in a migrated household, opened through the household
// vault with a handle unwrapped from the platform DB; plus the SimpleFIN access URL.
export async function migratedPlaintexts(dataDir, householdId, platformKey) {
  const HV = await src('src/platform/household-vault.mjs');
  const platform = new DatabaseSync(join(dataDir, 'platform.sqlite'));
  try {
    const handle = await HV.unwrapDataKey(platform, { householdId, platformKey });
    const root = await HV.householdRoot({ dataRoot: dataDir, householdId, relativeRoot: `households/${householdId}` });
    const store = join(dataDir, 'households', householdId, 'fathom.sqlite');
    const { files, packets, access } = withSqlite(store, db => ({
      files: db.prepare('SELECT id, stored_path FROM files WHERE stored_path IS NOT NULL ORDER BY id').all(),
      packets: db.prepare('SELECT id, stored_path FROM advisor_packets ORDER BY id').all(),
      access: db.prepare('SELECT access_blob FROM simplefin_connection WHERE id = 1').get()?.access_blob ?? null,
    }));
    const out = {};
    for (const r of files) out[`upload:${r.id}`] = sha256(Buffer.from(await HV.readObject({ root, handle, purpose: 'upload', objectId: r.id, storedPath: r.stored_path })));
    for (const r of packets) out[`advisor-packet:${r.id}`] = sha256(Buffer.from(await HV.readObject({ root, handle, purpose: 'advisor-packet', objectId: r.id, storedPath: r.stored_path })));
    return { plaintexts: out, simplefinUrl: access == null ? null : String(await HV.openConnectionSecret(handle, access)) };
  } finally {
    platform.close();
  }
}

const strip = (row, keys) => { const out = { ...row }; for (const k of keys) delete out[k]; return out; };
const dirEntries = dir => (existsSync(dir) ? readdirSync(dir).sort() : null);

// The end state of a completed migration with operation ids normalized to OP, comparable across
// runs of copies of one fixture: published store digests (schema_migrations without applied_at,
// simplefin_connection without its freshly sealed access_blob; the plaintext is in `vault`),
// platform rows, vault plaintexts, pack and outbox files, retired legacy entries and root entries.
export async function endState(fx) {
  const { dataDir, householdId } = fx;
  const op = withSqlite(join(dataDir, 'platform.sqlite'), p => p.prepare("SELECT id FROM platform_operations WHERE kind = 'tenancy-migration'").all().map(r => r.id));
  if (op.length !== 1) throw new Error(`expected one tenancy-migration operation, found ${op.length}`);
  const norm = name => name.split(op[0]).join('OP');
  const rootPath = join(dataDir, 'households', householdId);
  const legacyDir = join(dataDir, `legacy-${op[0]}`);
  const platform = withSqlite(join(dataDir, 'platform.sqlite'), p => ({
    households: p.prepare('SELECT * FROM households ORDER BY id').all().map(r => strip(r, ['updated_at'])),
    apiKeys: p.prepare('SELECT * FROM api_keys ORDER BY id').all().map(r => ({ ...r })),
    outbound: p.prepare('SELECT * FROM household_outbound ORDER BY household_id').all().map(r => strip(r, ['updated_at', 'updated_by'])),
    memberships: p.prepare('SELECT user_id, household_id, role, status FROM household_memberships ORDER BY user_id, household_id').all().map(r => ({ ...r })),
    dataKeys: p.prepare('SELECT household_id, key_version, status FROM household_data_keys ORDER BY household_id, key_version').all().map(r => ({ ...r })),
    sessions: p.prepare('SELECT count(*) AS n FROM auth_sessions').get().n,
    challenges: p.prepare('SELECT count(*) AS n FROM auth_challenges').get().n,
    tokens: p.prepare('SELECT count(*) AS n FROM auth_tokens').get().n,
    liveInvitations: p.prepare('SELECT count(*) AS n FROM household_invitations WHERE consumed_at IS NULL AND revoked_at IS NULL').get().n,
    operation: p.prepare("SELECT kind, status FROM platform_operations WHERE kind = 'tenancy-migration'").all().map(r => ({ ...r })),
  }));
  const vault = await migratedPlaintexts(dataDir, householdId, fx.keys.platformKey);
  return {
    rootEntries: readdirSync(dataDir).filter(n => !/-(wal|shm)$/.test(n)).map(norm).sort(),
    householdEntries: dirEntries(join(dataDir, 'households')),
    store: tableDigests(join(rootPath, 'fathom.sqlite'), { schema_migrations: { omit: ['applied_at'] }, simplefin_connection: { omit: ['access_blob'] } }),
    platform,
    vault,
    files: dirEntries(join(rootPath, 'files')),
    packs: fileHashes(join(rootPath, 'packs')),
    outbox: fileHashes(join(rootPath, 'outbox')),
    legacyEntries: dirEntries(legacyDir)?.filter(n => !/-(wal|shm)$/.test(n)),
    legacyStore: tableDigests(join(legacyDir, 'fathom.sqlite'), { schema_migrations: { omit: ['applied_at'] } }),
    legacyFiles: fileHashes(legacyDir, rel => rel.startsWith('fathom.sqlite')),
  };
}

// Every regular file under dataDir with its sha256, ignoring SQLite shared-memory files and empty
// WAL files a read-only open may leave.
export const stableHashes = dir => fileHashes(dir, rel => rel.endsWith('-shm') || (rel.endsWith('-wal') && statSync(join(dir, rel)).size === 0));

export const realpath = p => realpathSync(p);
export const readText = p => readFileSync(p, 'utf8');
