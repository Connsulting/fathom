// The account dialog's two reads, both scoped to the one account in the path:
//   GET /api/accounts/:id               -> { account, fresh, asOf, trendKey, txn, feeds, syncable }
//   GET /api/accounts/:id/transactions  ?q&from&to&limit&cursor -> { items, next, total, figures, sources }
// Neither writes. Transactions come newest first in keyset pages; every amount names a figure and a
// source so the browser can show where it came from, like any other figure.

import { parseJson } from '../store/db.mjs';
import { accountLabel, accountSubtitle } from '../shared/account-label.mjs';
import { accountNaming } from '../accounts/naming.mjs';
import { accountFreshness, freshnessOf } from '../ingest/freshness.mjs';
import { howToFor } from '../ingest/howto.mjs';
import { seriesKey } from '../jobs/planner/series.mjs';
import { resolveClock } from '../scenario/build.mjs';
import { HttpError } from './http.mjs';

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 200;
export const QUERY_MAX = 100;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CURSOR = /^(\d{4}-\d{2}-\d{2})\|(\d{1,15})$/;
const SIMPLEFIN = 'simplefin';

function validDay(value) {
  const m = ISO_DAY.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

function accountRow(ctx) {
  const id = ctx.params?.id;
  if (typeof id !== 'string' || !id) throw new HttpError(400, 'missing account');
  const row = ctx.db.prepare('SELECT id FROM accounts WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'no such account');
  return id;
}

// A query value is one plain string; an array (a repeated key) or anything else is refused.
function one(query, key) {
  const v = query?.[key];
  if (v == null) return null;
  if (typeof v !== 'string') throw new HttpError(400, `${key} must be a single value`);
  return v;
}

// The date of the balance the account's figure shows, choosing as refreshFigures does: the newest
// balance row; else the newest positions date, unless an empty holdings snapshot (a stored 0 figure
// located at the holdings list) is dated later, which is then the balance of 0.
function balanceDate(db, id) {
  const row = db.prepare('SELECT max(date) AS d FROM balances WHERE account_id = ?').get(id);
  if (row.d) return row.d;
  const positions = db.prepare('SELECT max(as_of) AS d FROM positions WHERE account_id = ?').get(id).d || null;
  const fig = db.prepare(`SELECT g.v, g.locator, f.period_to AS asOf FROM accounts a JOIN figures g ON g.key = a.fig_key
                          LEFT JOIN files f ON f.id = g.file_id WHERE a.id = ?`).get(id);
  const empty = fig && fig.v === 0 && fig.asOf && parseJson(fig.locator, null)?.field === 'holdings' ? fig.asOf : null;
  return empty && (!positions || empty > positions) ? empty : positions;
}

export function accountDetail(ctx) {
  const id = accountRow(ctx);
  const { db } = ctx;
  const clock = resolveClock(db, ctx.config && ctx.config.clock);
  const named = accountNaming(db).byId.get(id);
  const acct = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  const live = accountFreshness(db, id, { clock });

  // The date of the balance actually shown: the newest balance row when there is one, else the
  // newest positions date (the same choice refreshFigures makes), never the newest transaction.
  const bal = { d: balanceDate(db, id) };

  const txn = db.prepare('SELECT count(*) AS n, min(date) AS a, max(date) AS b FROM transactions WHERE account_id = ?').get(id);

  // Per file: the newest row date this account has from it. Rows from the SimpleFIN parser are one
  // feed whatever file carried them; a file feed groups by its ingest source, else by the file.
  const perFile = db.prepare(`SELECT x.file_id, x.parser, max(x.d) AS last, f.name, f.source_kind, f.source_id, f.uploaded_at FROM (
      SELECT file_id, parser, date AS d FROM transactions WHERE account_id = ?1
      UNION ALL SELECT file_id, parser, date FROM balances WHERE account_id = ?1
      UNION ALL SELECT file_id, parser, as_of FROM positions WHERE account_id = ?1) x
    LEFT JOIN files f ON f.id = x.file_id GROUP BY x.file_id, x.parser`).all(id);
  const sourceOf = db.prepare('SELECT label, kind, as_of FROM sources WHERE id = ?');
  const feedsByKey = new Map();
  for (const r of perFile) {
    const sf = r.parser === SIMPLEFIN;
    const key = sf ? SIMPLEFIN : (r.source_id || r.file_id || 'unknown');
    const src = r.source_id ? sourceOf.get(r.source_id) : null;
    const kind = sf ? SIMPLEFIN : (src?.kind || r.source_kind || null);
    const prior = feedsByKey.get(key);
    const last = prior && prior.lastDataDate > r.last ? prior.lastDataDate : r.last;
    feedsByKey.set(key, {
      id: key,
      kind: sf ? 'simplefin' : 'file',
      sourceKind: kind,
      label: sf ? 'SimpleFIN Bridge' : (src?.label || r.name || 'Imported file'),
      lastDataDate: last,
    });
  }

  const conn = db.prepare('SELECT last_sync_at, status FROM simplefin_connection WHERE id = 1').get();
  const mapped = db.prepare("SELECT m.sf_key, s.snapshot FROM simplefin_accounts m LEFT JOIN simplefin_snapshots s ON s.sf_key = m.sf_key WHERE m.account_id = ? AND m.status = 'mapped' ORDER BY m.sf_key").all(id);
  let syncable = false;
  if (conn && mapped.length) {
    const snap = parseJson(mapped[0].snapshot, {}) || {};
    const balanceDate = typeof snap.balanceDate === 'string' && validDay(snap.balanceDate.slice(0, 10)) ? snap.balanceDate.slice(0, 10) : null;
    const f = feedsByKey.get(SIMPLEFIN) || { id: SIMPLEFIN, kind: 'simplefin', sourceKind: SIMPLEFIN, label: 'SimpleFIN Bridge', lastDataDate: balanceDate };
    feedsByKey.set(SIMPLEFIN, { ...f, lastSyncAt: conn.last_sync_at || null, balanceDate, status: conn.status });
    syncable = conn.status !== 'reconnect';
  }

  const feeds = [...feedsByKey.values()].map((f) => {
    const state = f.lastDataDate && f.sourceKind ? freshnessOf({ kind: f.sourceKind, asOf: f.lastDataDate }, clock) : null;
    const how = f.sourceKind ? howToFor(f.sourceKind) : null;
    return {
      ...f,
      state: state ? state.state : 'unknown',
      ageDays: state ? state.ageDays : null,
      cadence: state?.cadence ? state.cadence.label : null,
      howTo: how ? { id: how.id, title: how.title, steps: [...how.steps], cadence: how.cadence } : null,
    };
  }).sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === 'simplefin' ? -1 : 1));

  return {
    account: {
      id,
      label: accountLabel(named || acct),
      sourceName: acct.name,
      displayName: acct.display_name || null,
      subtitle: accountSubtitle(acct),
      inst: acct.inst,
      owner: acct.owner,
      kind: acct.kind,
      mirror: acct.mirror,
      mask: acct.mask,
    },
    fresh: live.fresh,
    asOf: live.asOf,
    balance: { asOf: bal.d ? String(bal.d).slice(0, 10) : null },
    trendKey: seriesKey(id),
    txn: { count: txn.n, from: txn.a, to: txn.b },
    feeds,
    syncable,
  };
}

const like = (s) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function accountTransactions(ctx) {
  const id = accountRow(ctx);
  const q = ctx.query || {};
  const limitRaw = one(q, 'limit');
  let limit = PAGE_DEFAULT;
  if (limitRaw != null) {
    if (!/^\d{1,4}$/.test(limitRaw)) throw new HttpError(400, 'limit must be a whole number');
    limit = Number(limitRaw);
    if (limit < 1 || limit > PAGE_MAX) throw new HttpError(400, `limit must be between 1 and ${PAGE_MAX}`);
  }
  const text = (one(q, 'q') ?? '').trim();
  if (text.length > QUERY_MAX) throw new HttpError(400, `search text is over ${QUERY_MAX} characters`);
  const from = one(q, 'from') || null;
  const to = one(q, 'to') || null;
  if (from && !validDay(from)) throw new HttpError(400, 'from must be a date as YYYY-MM-DD');
  if (to && !validDay(to)) throw new HttpError(400, 'to must be a date as YYYY-MM-DD');
  if (from && to && from > to) throw new HttpError(400, 'from is after to');
  const cursorRaw = one(q, 'cursor');
  let cursor = null;
  if (cursorRaw) {
    const m = CURSOR.exec(cursorRaw);
    if (!m || !validDay(m[1])) throw new HttpError(400, 'bad cursor');
    cursor = { date: m[1], id: Number(m[2]) };
  }

  const where = ['t.account_id = ?'];
  const args = [id];
  if (from) { where.push('t.date >= ?'); args.push(from); }
  if (to) { where.push('t.date <= ?'); args.push(to); }
  if (text) {
    where.push("(t.description LIKE ? ESCAPE '\\' OR t.category LIKE ? ESCAPE '\\')");
    args.push(like(text), like(text));
  }
  const total = ctx.db.prepare(`SELECT count(*) AS n FROM transactions t WHERE ${where.join(' AND ')}`).get(...args).n;
  const paged = [...where];
  const pagedArgs = [...args];
  if (cursor) { paged.push('(t.date < ? OR (t.date = ? AND t.id < ?))'); pagedArgs.push(cursor.date, cursor.date, cursor.id); }
  const rows = ctx.db.prepare(`SELECT t.id, t.date, t.amount, t.description, t.category, t.file_id, t.parser, f.name AS file_name, f.uploaded_at
      FROM transactions t LEFT JOIN files f ON f.id = t.file_id
      WHERE ${paged.join(' AND ')} ORDER BY t.date DESC, t.id DESC LIMIT ?`).all(...pagedArgs, limit + 1);
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;

  const figures = {};
  const sources = {};
  const items = page.map((r) => {
    const sf = r.parser === SIMPLEFIN;
    const srcId = sf ? 'txn-src:simplefin' : `txn-src:${r.file_id || 'unknown'}`;
    if (!sources[srcId]) {
      sources[srcId] = {
        label: sf ? 'SimpleFIN Bridge' : (r.file_name || 'Imported file'),
        asOf: typeof r.uploaded_at === 'string' ? r.uploaded_at.slice(0, 10) : '',
      };
    }
    const fig = `txn.${r.id}`;
    figures[fig] = { v: r.amount, src: srcId, kind: 'a', label: `Transaction on ${r.date}` };
    return { id: r.id, date: r.date, description: r.description ?? '', amount: r.amount, category: r.category ?? '', fig };
  });
  const last = page[page.length - 1];
  return { items, next: more && last ? `${last.date}|${last.id}` : null, total, figures, sources };
}
