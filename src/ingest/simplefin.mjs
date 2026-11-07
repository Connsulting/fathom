import { queueAccountPairs } from './account-merge.mjs';
import { lastFour, accountMask, compatibleKind, compatibleInstitution, sameInstitution, accountKind } from './account-match.mjs';
export { lastFour } from './account-match.mjs';
// Read-only bank and brokerage connections through SimpleFIN Bridge (simplefin.org protocol).
// The owner pastes a one-time setup token; the server decodes it to a claim URL, refuses any URL
// that is not https on an allowed host (the token is user input: SSRF guard), claims it and gets
// the access URL, which embeds Basic credentials. The access URL is stored only encrypted with the
// data key (vault AES-256-GCM, bound to a fixed AAD), never logged, never returned to the client
// and never put in an error. A sync GETs <access>/accounts over a start-date window, maps accounts,
// balances and transactions into one synthetic ingest file (no credentials in it) and runs it
// through the ingest pipeline with the simplefin parser, so dedupe, provenance, sources and
// figures work as for uploads. Accounts it writes are mirror 'connected'. Every account a sync sees
// gets a snapshot (no account or connection ids) for the account_match card, and the sync ends with
// one auto-resolution pass.

import { createHash } from 'node:crypto';
import { getSetting } from '../store/db.mjs';
import { encrypt, decrypt, loadDataKey } from './vault.mjs';
import { ingestFile, accountIdOf } from './pipeline.mjs';
import { identifyAccountRows } from './dedupe.mjs';
import { ask, normalizeName, ACCOUNT_MATCH_OPTIONS } from './confirm.mjs';
import { autoResolve } from './auto.mjs';
import { institution, cents } from './format.mjs';
import { DEFAULT_HOSTS, parseAllowedHosts } from './simplefin-hosts.mjs';

export { DEFAULT_HOSTS, parseAllowedHosts };

const AAD = 'simplefin:access';
const MAX_BODY = 20 * 1024 * 1024;
const MAX_TOKEN = 4096;
const TIMEOUT_MS = 30000;
const FIRST_DAYS = 90;
const OVERLAP_DAYS = 14;
const DAY = 86400000;

const MESSAGES = {
  bad_token: 'That does not look like a SimpleFIN setup token. Copy the whole token from the SimpleFIN Bridge site.',
  host_not_allowed: 'That setup token points at a host Fathom is not allowed to call.',
  token_used: 'That setup token was already used or does not exist. Setup tokens work once: create a new one on the SimpleFIN Bridge site.',
  claim_failed: 'SimpleFIN did not accept the setup token. Try again or create a new token.',
  bad_access: 'SimpleFIN sent back an access address Fathom cannot use.',
  network: 'SimpleFIN could not be reached.',
  revoked: 'SimpleFIN refused access. Reconnect with a new setup token.',
  payment_required: 'SimpleFIN says the subscription needs payment. Renew it, then reconnect.',
  auth: 'SimpleFIN reports a sign-in problem with a connected institution. Fix it on the SimpleFIN Bridge site or reconnect.',
  bad_response: 'SimpleFIN sent a reply Fathom could not read.',
  not_connected: 'SimpleFIN is not connected.',
  already_connected: 'SimpleFIN is already connected. Disconnect first to use a new token.',
};
const STATUS = { not_connected: 409, already_connected: 409, network: 502, bad_response: 502, bad_access: 502, revoked: 502, payment_required: 502, claim_failed: 502 };
// Sync failures that need a new setup token from the owner.
const RECONNECT = new Set(['revoked', 'payment_required', 'auth', 'bad_access']);

export class SimplefinError extends Error {
  constructor(code) {
    super(MESSAGES[code] ?? 'SimpleFIN request failed');
    this.name = 'SimplefinError';
    this.code = code;
    this.status = STATUS[code] ?? 400;
  }
}

const sha = (text) => createHash('sha256').update(text).digest('hex');
const arr = (v) => (Array.isArray(v) ? v : []);
// Bridge text shown to the owner: no control characters, one line, capped.
const clean = (v, n = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const isoOf = (epoch) => {
  const n = Number(epoch);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const amountOf = (v) => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
  return cents(Number(s));
};

// The SSRF guard for every URL this module calls: https, default port, a host on the list exactly,
// no fragment. A claim URL must carry no credentials; an access URL must carry them.
export function guardUrl(raw, hosts, { credentials }) {
  const fail = credentials === 'require' ? 'bad_access' : 'bad_token';
  let u;
  try { u = new URL(String(raw)); } catch { throw new SimplefinError(fail); }
  if (u.protocol !== 'https:' || u.hash) throw new SimplefinError(fail);
  if ((u.port && u.port !== '443') || !(hosts ?? DEFAULT_HOSTS).includes(u.hostname.toLowerCase())) throw new SimplefinError('host_not_allowed');
  if (credentials === 'forbid' && (u.username || u.password)) throw new SimplefinError(fail);
  if (credentials === 'require' && !(u.username && u.password)) throw new SimplefinError(fail);
  return u;
}

// A setup token is base64 of the claim URL. Returns the decoded URL text (not yet guarded).
export function decodeSetupToken(token) {
  const t = String(token ?? '').replace(/\s+/g, '');
  if (!t || t.length > MAX_TOKEN || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) throw new SimplefinError('bad_token');
  const text = Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  if (!/^https?:\/\/[\x21-\x7e]+$/.test(text)) throw new SimplefinError('bad_token');
  return text;
}

async function call(fetchImpl, url, { method = 'GET', auth = null } = {}) {
  const headers = { accept: 'application/json, text/plain' };
  if (auth) headers.authorization = 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`, 'utf8').toString('base64');
  let res;
  try {
    res = await fetchImpl(url, { method, headers, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS), ...(method === 'POST' ? { body: '' } : {}) });
  } catch {
    throw new SimplefinError('network');
  }
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new SimplefinError('bad_response');
  let text;
  try { text = await res.text(); } catch { throw new SimplefinError('network'); }
  if (text.length > MAX_BODY) throw new SimplefinError('bad_response');
  return { status: res.status, ok: res.ok, text };
}

// Claim a setup token. Returns the access URL text; the caller encrypts it at once.
export async function claimToken(token, { hosts, fetch: fetchImpl }) {
  const claimUrl = guardUrl(decodeSetupToken(token), hosts, { credentials: 'forbid' });
  const res = await call(fetchImpl, claimUrl.href, { method: 'POST' });
  if (res.status === 403) throw new SimplefinError('token_used');
  if (!res.ok) throw new SimplefinError('claim_failed');
  return guardUrl(res.text.trim(), hosts, { credentials: 'require' }).href;
}

// GET <access>/accounts. Credentials go in the Authorization header, never in the request URL.
export async function fetchAccounts(access, { hosts, fetch: fetchImpl, startDate }) {
  const u = guardUrl(access, hosts, { credentials: 'require' });
  const auth = { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) };
  const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  const params = new URLSearchParams({ version: '2' });
  if (startDate) params.set('start-date', String(Math.floor(Date.parse(`${startDate}T00:00:00Z`) / 1000)));
  const res = await call(fetchImpl, `${base}/accounts?${params}`, { auth });
  if (res.status === 403) throw new SimplefinError('revoked');
  if (res.status === 402) throw new SimplefinError('payment_required');
  if (!res.ok) throw new SimplefinError('bad_response');
  try { return JSON.parse(res.text); } catch { throw new SimplefinError('bad_response'); }
}

// Last four digits from an account name ("Checking x1234", "Card (1234)", "Savings ...1234") or an
// id that is all digits; never more. Longer digit runs in a name are masked to their last four.
const maskName = (name) => clean(name, 120).replace(/\d{5,}/g, (run) => `...${run.slice(-4)}`);

// Bridge account set (protocol v2 connections/errlist, or v1 org/errors) to plain accounts.
export function normalizeAccountSet(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.accounts)) throw new SimplefinError('bad_response');
  const conns = new Map(arr(body.connections).map((c) => [String(c?.conn_id ?? ''), c]));
  const errors = Array.isArray(body.errlist)
    ? body.errlist.map((e) => ({ code: clean(e?.code, 40) || 'gen.', msg: clean(e?.msg) }))
    : arr(body.errors).map((m) => ({ code: 'gen.', msg: clean(m) }));
  const accounts = [];
  let skipped = 0;
  for (const a of body.accounts) {
    if (!a || typeof a !== 'object' || a.id == null) { skipped += 1; continue; }
    const conn = conns.get(String(a.conn_id ?? ''));
    const org = a.org && typeof a.org === 'object' ? a.org : {};
    const currency = String(a.currency ?? 'USD');
    if (currency.toUpperCase() !== 'USD') { skipped += 1; continue; }
    const connId = String(a.conn_id ?? org.id ?? org['sfin-url'] ?? org.domain ?? '');
    const inst = clean(conn?.name ?? a.conn_name ?? org.name ?? org.domain ?? '', 120) || 'SimpleFIN';
    const transactions = [];
    for (const t of arr(a.transactions)) {
      const date = isoOf(t?.posted);
      const amount = amountOf(t?.amount);
      if (!date || amount === null || t?.pending === true || t?.id == null) continue;
      transactions.push({ date, amount, description: clean(t.description ?? t.payee ?? '', 300), externalId: clean(t.id, 120) });
    }
    accounts.push({
      key: sha(`${connId}\u0000${String(a.id)}`).slice(0, 24),
      // A mask from the name ("x1234") can decide a match; one taken from an all-digit id is shown
      // but only ever asked about (an id is opaque to the protocol).
      inst, name: maskName(a.name) || 'Connected account', mask: lastFour(maskName(a.name), a.id), maskSure: Boolean(lastFour(maskName(a.name), null)),
      balance: amountOf(a.balance), balanceDate: isoOf(a['balance-date']), transactions,
    });
  }
  return { accounts, errors, skipped };
}

// ---------------------------------------------------------------- the simplefin parser

export const parser = Object.freeze({
  id: 'simplefin', label: 'SimpleFIN Bridge', sourceKind: 'simplefin', mirror: 'connected',
  sniff: () => 0,
  parse(file) {
    const doc = JSON.parse(new TextDecoder().decode(file.bytes));
    const rows = [];
    let from = null, to = null;
    const span = (d) => { if (!from || d < from) from = d; if (!to || d > to) to = d; };
    doc.accounts.forEach((a, i) => {
      const base = { account: a.account, accountId: a.accountId, identity: a.identity };
      a.transactions.forEach((t, j) => {
        span(t.date);
        // The bridge's transaction id is authoritative within its account: a resync with a changed
        // description is the same posting (externalAuthoritative), never a second one.
        rows.push({ ...base, kind: 'transaction', date: t.date, amount: t.amount, description: t.description, externalId: t.externalId, externalAuthoritative: true, locator: { account: i, transaction: j } });
      });
      if (a.balance) {
        span(a.balance.date);
        rows.push({ ...base, kind: 'balance', date: a.balance.date, amount: a.balance.amount, locator: { account: i, balance: true } });
      }
    });
    return identifyAccountRows({ rows, warnings: [], period: { from, to } }, file);
  },
});

// ---------------------------------------------------------------- store

const ownIdentity = (sfKey) => `simplefin:${sfKey}`;
export const connection = (db) => db.prepare('SELECT * FROM simplefin_connection WHERE id = 1').get() ?? null;

export async function dataKeyFor(db, config = {}) {
  return loadDataKey({ dataDir: config.dataDir, keyFile: config.dataKeyFile, mode: getSetting(db, 'mode', 'real') });
}

export async function connectSimplefin(db, token, { config = {}, hosts, fetch: fetchImpl, now, key } = {}) {
  if (connection(db)?.status === 'ok') throw new SimplefinError('already_connected');
  const k = key ?? await dataKeyFor(db, config);
  const access = await claimToken(token, { hosts, fetch: fetchImpl });
  const blob = encrypt(k, Buffer.from(access, 'utf8'), AAD).toString('base64');
  db.prepare(`INSERT INTO simplefin_connection (id, access_blob, connected_at, status) VALUES (1, ?, ?, 'ok')
              ON CONFLICT(id) DO UPDATE SET access_blob = excluded.access_blob, connected_at = excluded.connected_at,
                status = 'ok', error_code = NULL, messages = NULL`)
    .run(blob, now || new Date().toISOString());
  return { connected: true };
}

// Deletes the stored access URL. Accounts and their rows stay; they are no longer mirrored.
export function disconnectSimplefin(db) {
  const had = Boolean(connection(db));
  db.prepare('DELETE FROM simplefin_connection WHERE id = 1').run();
  db.prepare(`UPDATE accounts SET mirror = 'manual' WHERE mirror = 'connected'
              AND id IN (SELECT account_id FROM simplefin_accounts WHERE account_id IS NOT NULL)`).run();
  return { disconnected: had };
}

// ---------------------------------------------------------------- matching

// A connected account against existing accounts from files at the same institution: sure when one
// candidate shares the mask (or, with no mask, the name) and no stored balance on the bridge's
// balance date contradicts it. Otherwise the closest candidate by recent balance is asked about.
export function matchAccount(db, acct) {
  const pool = db.prepare(`SELECT id, inst, mask, name, kind FROM accounts WHERE coalesce(mirror, '') != 'connected'
                           AND id NOT IN (SELECT account_id FROM simplefin_accounts WHERE account_id IS NOT NULL)
                           AND id NOT IN (SELECT candidate_id FROM simplefin_accounts WHERE status = 'pending_match' AND candidate_id IS NOT NULL)
                           ORDER BY id`)
    .all().filter(a => compatibleInstitution(a.inst, acct.inst) && compatibleKind(a, acct));
  if (!pool.length) return {};
  const balOn = db.prepare('SELECT amount FROM balances WHERE account_id = ? AND date = ?');
  const latest = db.prepare('SELECT amount FROM balances WHERE account_id = ? ORDER BY date DESC LIMIT 1');
  const contradicts = (c) => {
    if (acct.balance == null || !acct.balanceDate) return false;
    const b = balOn.get(c.id, acct.balanceDate);
    return b != null && Math.round(b.amount * 100) !== Math.round(acct.balance * 100);
  };
  const distance = (c) => { const b = latest.get(c.id); return b && acct.balance != null ? Math.abs(b.amount - acct.balance) : Infinity; };
  const closest = (list) => [...list].sort((a, b) => distance(a) - distance(b))[0].id;
  if (acct.mask) {
    const same = pool.filter((c) => accountMask(c) === acct.mask);
    if (same.length === 1 && acct.maskSure && sameInstitution(same[0].inst, acct.inst) && accountKind(same[0]) && accountKind(acct) && !contradicts(same[0])) return { sure: same[0].id };
    if (same.length) return { candidate: closest(same) };
    const unmasked = pool.filter((c) => sameInstitution(c.inst, acct.inst) && !accountMask(c));
    return unmasked.length ? { candidate: closest(unmasked) } : {};
  }
  const known = pool.filter(c => sameInstitution(c.inst, acct.inst));
  if (!known.length) return {};
  const named = known.filter((c) => normalizeName(c.name) === normalizeName(acct.name));
  if (named.length === 1 && !named[0].mask && !contradicts(named[0])) return { sure: named[0].id };
  if (named.length) return { candidate: closest(named) };
  const near = known.filter((c) => distance(c) <= Math.max(1, Math.abs(acct.balance ?? 0) * 0.05));
  return { candidate: closest(near.length ? near : known) };
}

// The account a bridge account writes into, or null while a match question is pending.
function resolveAccount(db, acct, { now, counts }) {
  const get = db.prepare('SELECT * FROM simplefin_accounts WHERE sf_key = ?');
  let m = get.get(acct.key);
  if (!m) {
    const match = matchAccount(db, acct);
    const own = accountIdOf(ownIdentity(acct.key));
    if (match.candidate) {
      db.prepare("INSERT INTO simplefin_accounts (sf_key, account_id, candidate_id, status, name, created_at) VALUES (?, NULL, ?, 'pending_match', ?, ?)")
        .run(acct.key, match.candidate, acct.name, now);
      const cand = db.prepare('SELECT name, inst FROM accounts WHERE id = ?').get(match.candidate);
      const out = ask(db, {
        kind: 'account_match', subject: `sf:${acct.key}`,
        question: `Is ${acct.name} at ${acct.inst} from SimpleFIN the same account as ${cand?.name ?? 'an account'} you imported from a file?`,
        options: ACCOUNT_MATCH_OPTIONS, context: { sfKey: acct.key, candidateId: match.candidate, ownId: own }, now,
      });
      if (out.queued) counts.queued += 1;
    } else {
      db.prepare("INSERT INTO simplefin_accounts (sf_key, account_id, candidate_id, status, name, created_at) VALUES (?, ?, NULL, 'mapped', ?, ?)")
        .run(acct.key, match.sure ?? own, acct.name, now);
      if (match.sure) counts.matched += 1;
    }
    m = get.get(acct.key);
  }
  if (m.status !== 'mapped' || !m.account_id) { counts.pending += 1; return null; }
  return m.account_id;
}

function targetOf(db, accountId, acct) {
  const existing = db.prepare('SELECT id, inst, mask, name, identity FROM accounts WHERE id = ?').get(accountId);
  if (existing) {
    return {
      accountId, identity: existing.identity ?? ownIdentity(acct.key),
      account: { inst: existing.inst ?? acct.inst, mask: existing.mask ?? null, name: existing.name ?? acct.name, kind: existing.name ?? acct.name },
    };
  }
  return { accountId, identity: ownIdentity(acct.key), account: { inst: acct.inst, mask: acct.mask, name: acct.name, kind: acct.name } };
}

// What this sync saw of a bridge account: institution, name, mask, balance, the span and count of
// its postings and the three newest. Never its bridge or connection id.
function writeSnapshot(db, acct, now) {
  const dates = acct.transactions.map((t) => t.date).sort();
  const recent = [...acct.transactions].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 3)
    .map((t) => ({ date: t.date, amount: t.amount, description: t.description }));
  const snapshot = {
    inst: acct.inst, name: acct.name, mask: acct.mask ?? null, maskSure: Boolean(acct.maskSure), balance: acct.balance ?? null, balanceDate: acct.balanceDate ?? null,
    from: dates[0] ?? null, to: dates.at(-1) ?? null, count: dates.length, recent,
  };
  db.prepare(`INSERT INTO simplefin_snapshots (sf_key, snapshot, at) VALUES (?, ?, ?)
              ON CONFLICT(sf_key) DO UPDATE SET snapshot = excluded.snapshot, at = excluded.at`).run(acct.key, JSON.stringify(snapshot), now);
}

// The full first window until every known bridge account has imported once under it, so an
// account held by a match question or first seen on a short window still gets its history.
function startDate(db, row, clock) {
  const owed = db.prepare('SELECT count(*) AS n FROM simplefin_accounts WHERE backfilled = 0').get().n;
  if (!row.last_sync_at || owed) return addDays(clock, -FIRST_DAYS);
  const last = String(row.last_sync_at).slice(0, 10);
  const from = addDays(last < clock ? last : clock, -OVERLAP_DAYS);
  return from < addDays(clock, -FIRST_DAYS) ? addDays(clock, -FIRST_DAYS) : from;
}

function setStatus(db, status, code, messages) {
  db.prepare('UPDATE simplefin_connection SET status = ?, error_code = ?, messages = ? WHERE id = 1')
    .run(status, code ?? null, messages?.length ? JSON.stringify(messages) : null);
}

// One sync. Returns {status: 'skipped' | 'ok' | 'reconnect' | 'error', code?, changed, counts}.
// Counts only; nothing here logs account data or the access URL.
export async function syncSimplefin(db, { config = {}, hosts, fetch: fetchImpl, now, clock, key, engine = null } = {}) {
  const row = connection(db);
  const counts = { accounts: 0, transactions: 0, balances: 0, duplicates: 0, matched: 0, pending: 0, queued: 0, skipped: 0 };
  if (!row) return { status: 'skipped', changed: false, counts };
  const stamp = now || new Date().toISOString();
  const today = clock || stamp.slice(0, 10);
  const k = key ?? await dataKeyFor(db, config);
  const start = startDate(db, row, today);
  const full = start === addDays(today, -FIRST_DAYS);
  let set;
  try {
    const access = decrypt(k, Buffer.from(row.access_blob, 'base64'), AAD).toString('utf8');
    set = normalizeAccountSet(await fetchAccounts(access, { hosts, fetch: fetchImpl, startDate: start }));
  } catch (e) {
    const code = e instanceof SimplefinError ? e.code : 'bad_access';
    setStatus(db, RECONNECT.has(code) ? 'reconnect' : 'error', code, null);
    return { status: RECONNECT.has(code) ? 'reconnect' : 'error', code, changed: false, counts };
  }
  counts.accounts = set.accounts.length;
  counts.skipped = set.skipped;
  const docAccounts = [];
  for (const acct of set.accounts) {
    const accountId = resolveAccount(db, acct, { now: stamp, counts });
    writeSnapshot(db, acct, stamp);
    if (!accountId) continue;
    const target = targetOf(db, accountId, acct);
    // A bridge transaction with the same date and amount as a file-imported one on this account is
    // that posting, one for one; every other bridge transaction goes through ingest dedupe (and its
    // near-duplicate questions).
    const fileRows = new Map();
    for (const r of db.prepare("SELECT date, amount FROM transactions WHERE account_id = ? AND coalesce(parser, '') != 'simplefin'").all(accountId)) {
      const slot = `${r.date}|${Math.round(r.amount * 100)}`;
      fileRows.set(slot, (fileRows.get(slot) ?? 0) + 1);
    }
    const transactions = acct.transactions.filter((t) => {
      const slot = `${t.date}|${Math.round(t.amount * 100)}`;
      const n = fileRows.get(slot) ?? 0;
      if (n > 0) { fileRows.set(slot, n - 1); return false; }
      return true;
    });
    docAccounts.push({
      sfKey: acct.key,
      ...target,
      balance: acct.balance != null && acct.balanceDate ? { date: acct.balanceDate, amount: acct.balance } : null,
      transactions,
    });
  }
  let changed = false;
  if (docAccounts.length) {
    const bytes = Buffer.from(JSON.stringify({ format: 'fathom-simplefin-1', accounts: docAccounts }), 'utf8');
    const result = await ingestFile(db, { name: `SimpleFIN sync ${today}.json`, bytes, mime: 'application/json' }, { config, key: k, now: stamp, engine, parser });
    const c = result.counts ?? {};
    counts.transactions = c.rows?.transaction ?? 0;
    counts.balances = c.rows?.balance ?? 0;
    counts.duplicates = c.duplicates ?? 0;
    counts.queued += c.queued ?? 0;
    changed = result.status === 'imported' && (counts.transactions + counts.balances + (c.revised ?? 0)) > 0;
    if (result.status === 'imported') {
      db.prepare(`UPDATE accounts SET mirror = 'connected' WHERE id IN (${docAccounts.map(() => '?').join(', ')})`).run(...docAccounts.map((a) => a.accountId));
    }
    if (full && (result.status === 'imported' || result.status === 'duplicate')) {
      const mark = db.prepare('UPDATE simplefin_accounts SET backfilled = 1 WHERE sf_key = ?');
      for (const a of docAccounts) mark.run(a.sfKey);
    }
  }
  const authError = set.errors.find((e) => /^(gen|con)\.auth/.test(e.code));
  db.prepare('UPDATE simplefin_connection SET last_sync_at = ?, accounts = ? WHERE id = 1').run(stamp, set.accounts.length);
  setStatus(db, authError ? 'reconnect' : 'ok', authError ? 'auth' : null, set.errors.map((e) => e.msg).filter(Boolean).slice(0, 5));
  try {
    autoResolve(db, { now: stamp });
  } catch (e) {
    console.error('fathom: auto-resolve failed', e?.code ?? e?.name ?? 'error');
  }
  queueAccountPairs(db, { now: stamp });
  return { status: authError ? 'reconnect' : 'ok', code: authError ? 'auth' : undefined, changed, counts };
}

// ---------------------------------------------------------------- the fake bridge

// A synthetic SimpleFIN Bridge for the demo and tests: no network. Claim codes: 'demo-fathom'
// (reusable, like the real demo token) gives working access; 'demo-revoked' gives access the
// accounts call refuses with 403; any other code is 403 (used or unknown). Data is synthetic and
// dated relative to today(), with stable transaction ids, so a resync dedupes.
export const FAKE_HOST = 'bridge.simplefin.org';
export const fakeToken = (code = 'demo-fathom') => Buffer.from(`https://${FAKE_HOST}/simplefin/claim/${code}`, 'utf8').toString('base64');
const FAKE_USER = { 'demo-fathom': 'demo', 'demo-revoked': 'revoked' };
const FAKE_PASS = 'fake-demo-password';

export function createFakeSimplefin({ today = () => new Date().toISOString().slice(0, 10) } = {}) {
  const respond = (status, text) => new Response(text, { status, headers: { 'content-type': status === 200 && text.startsWith('{') ? 'application/json' : 'text/plain' } });
  return async function fakeFetch(url, init = {}) {
    const u = new URL(url);
    if (u.hostname !== FAKE_HOST) throw new TypeError('fetch failed');
    const claim = /^\/simplefin\/claim\/([A-Za-z0-9-]+)$/.exec(u.pathname);
    if (claim && init.method === 'POST') {
      const user = FAKE_USER[claim[1]];
      return user ? respond(200, `https://${user}:${FAKE_PASS}@${FAKE_HOST}/simplefin`) : respond(403, 'Forbidden');
    }
    if (u.pathname === '/simplefin/accounts' && (init.method ?? 'GET') === 'GET') {
      const auth = String(init.headers?.authorization ?? '');
      if (auth !== 'Basic ' + Buffer.from(`demo:${FAKE_PASS}`).toString('base64')) return respond(403, 'Forbidden');
      return respond(200, JSON.stringify(fakeAccountSet(today())));
    }
    return respond(404, 'Not found');
  };
}

const epoch = (iso) => Math.floor(Date.parse(`${iso}T12:00:00Z`) / 1000);
export function fakeAccountSet(today) {
  const tx = (prefix, list) => list.map(([days, amount, description]) => ({ id: `${prefix}-${addDays(today, -days)}-${days}`, posted: epoch(addDays(today, -days)), amount, description }));
  return {
    errlist: [],
    connections: [
      { conn_id: 'CON-demo-bank', name: 'Fathom Demo Bank', org_id: 'demo-bank', sfin_url: `https://${FAKE_HOST}/simplefin` },
      { conn_id: 'CON-demo-broker', name: 'Fathom Demo Brokerage', org_id: 'demo-broker', sfin_url: `https://${FAKE_HOST}/simplefin` },
      { conn_id: 'CON-other', name: 'Other bank', org_id: 'other', sfin_url: `https://${FAKE_HOST}/simplefin` },
    ],
    accounts: [
      {
        id: 'ACT-demo-checking', conn_id: 'CON-demo-bank', name: 'Everyday Checking x4821', currency: 'USD', balance: '8412.37', 'balance-date': epoch(today),
        transactions: tx('chk', [[1, '-64.20', 'Grocery market'], [3, '2450.00', 'Client payment'], [6, '-118.45', 'Electric utility'], [9, '-42.10', 'Pharmacy']]),
      },
      {
        id: 'ACT-demo-savings', conn_id: 'CON-demo-bank', name: 'Rainy Day Savings x7310', currency: 'USD', balance: '15250.00', 'balance-date': epoch(today),
        transactions: tx('sav', [[12, '500.00', 'Transfer from checking']]),
      },
      {
        id: 'ACT-demo-brokerage', conn_id: 'CON-demo-broker', name: 'Individual Brokerage x2290', currency: 'USD', balance: '48210.55', 'balance-date': epoch(today),
        transactions: tx('brk', [[5, '31.08', 'Dividend']]),
      },
      {
        id: 'ACT-other-checking', conn_id: 'CON-other', name: 'Checking', currency: 'USD', balance: '3120.00', 'balance-date': epoch(today),
        transactions: tx('oth', [[2, '-25.00', 'Coffee shop']]),
      },
    ],
  };
}
