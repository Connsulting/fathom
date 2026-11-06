// Tool registry shared by the chat engine and the MCP server (frozen architecture, tool interface).
// Each tool: { name, description, inputSchema (JSON Schema subset), scope: 'read'|'write:recs',
// handler(args, ctx) } with ctx = { db, now } (pack tools also read optional packDirs, dataDir;
// see ./packs.mjs). callTool validates args against inputSchema and
// throws ToolError ('bad_input' | 'not_found'). The only write is recommendation status.
//
// Outputs resolve scenario tokens to plain text, carry masks only (never account numbers), and
// never include hidden recs.

import { getSetting, tx, cents, parseJson as parse } from '../store/db.mjs';
import { loadRecs, loadContent, loadPacks, tokenScope, recFromRow, resolveClock, todayUtc, loadGoals, loadCurve, loadFigures } from '../scenario/build.mjs';
import { horizonLabel } from '../shared/goals.mjs';
import { needsYou, verdictLevel, packStatus, STATUSES } from '../shared/rules.mjs';
import { resolveTokens } from '../shared/tokens.mjs';
import { ToolError } from './errors.mjs';
import { packTools } from './packs.mjs';
import { withAdvisor, advisorStatus } from '../advisor/index.mjs';

export { ToolError };
export { packDirsFor } from './packs.mjs';

const SETTABLE = ['accepted', 'doing', 'done', 'dismissed', 'snoozed', 'proposed'];
const DATE = '^\\d{4}-\\d{2}-\\d{2}$';
const MONTH = '^\\d{4}-\\d{2}$';

// ---------------------------------------------------------------- validation (JSON Schema subset)

function typeOk(type, v) {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return v != null && typeof v === 'object' && !Array.isArray(v);
    case 'null': return v === null;
    default: return false;
  }
}

function check(schema, v, path) {
  if (schema.anyOf) {
    let first = null;
    const ok = schema.anyOf.some(branch => {
      try { check(branch, v, path); return true; } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        first = first || e;
        return false;
      }
    });
    if (!ok) throw first || new ToolError('bad_input', `${path} does not match any allowed shape`);
  }
  const types = schema.type == null ? null : [].concat(schema.type);
  if (types && !types.some(t => typeOk(t, v))) throw new ToolError('bad_input', `${path} must be ${types.join(' or ')}`);
  if (schema.enum && !schema.enum.includes(v)) throw new ToolError('bad_input', `${path} must be one of ${schema.enum.join(', ')}`);
  if (typeof v === 'number') {
    if (schema.minimum != null && v < schema.minimum) throw new ToolError('bad_input', `${path} must be at least ${schema.minimum}`);
    if (schema.maximum != null && v > schema.maximum) throw new ToolError('bad_input', `${path} must be at most ${schema.maximum}`);
  }
  if (typeof v === 'string') {
    if (schema.minLength != null && v.length < schema.minLength) throw new ToolError('bad_input', `${path} is too short`);
    if (schema.maxLength != null && v.length > schema.maxLength) throw new ToolError('bad_input', `${path} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) throw new ToolError('bad_input', `${path} has the wrong format`);
  }
  if (Array.isArray(v)) {
    if (schema.maxItems != null && v.length > schema.maxItems) throw new ToolError('bad_input', `${path} has too many items`);
    if (schema.items) v.forEach((x, i) => check(schema.items, x, `${path}[${i}]`));
  }
  if (typeOk('object', v) && (schema.properties || schema.required)) {
    for (const k of schema.required || []) if (v[k] === undefined) throw new ToolError('bad_input', `${path}.${k} is required`);
    for (const [k, x] of Object.entries(v)) {
      const sub = schema.properties && schema.properties[k];
      if (!sub) {
        if (schema.additionalProperties === false) throw new ToolError('bad_input', `${path}.${k} is not a known argument`);
        continue;
      }
      if (x !== undefined) check(sub, x, `${path}.${k}`);
    }
  }
}

export function validate(schema, args) {
  check(schema, args, 'args');
  return args;
}

// ---------------------------------------------------------------- helpers

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

// ctx.now as a Date: anything `new Date` accepts (Date, ISO string, epoch ms); the current time
// when it is absent or invalid.
function nowOf(ctx) {
  const d = ctx.now == null ? null : new Date(ctx.now);
  return d && !Number.isNaN(d.getTime()) ? d : new Date();
}

// "Today": ctx.clock (FATHOM_CLOCK) when given, else the store clock when set, else ctx.now's UTC date.
function clockOf(ctx) {
  return resolveClock(ctx.db, ctx.clock || getSetting(ctx.db, 'clock', null) || todayUtc(nowOf(ctx)));
}

// ' WHERE a AND b' and its params from [sql, value] pairs, skipping undefined values.
function where(conds) {
  const used = conds.filter(c => c[1] !== undefined);
  return { clause: used.length ? ' WHERE ' + used.map(c => c[0]).join(' AND ') : '', params: used.map(c => c[1]) };
}

// Resolve tokens to plain text in every string of a value.
function plainDeep(scope, v) {
  if (typeof v === 'string') return resolveTokens(scope, v, false);
  if (Array.isArray(v)) return v.map(x => plainDeep(scope, x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plainDeep(scope, x)]));
  return v;
}

const visible = recs => recs.filter(r => r.status !== 'hidden');

function recRow(db, id) {
  const row = db.prepare('SELECT * FROM recs WHERE id = ?').get(id);
  if (!row || row.status === 'hidden') throw new ToolError('not_found', `no recommendation ${id}`);
  return row;
}

// Goals as the model sees them: open goals only, owner text verbatim (seed text token-resolved),
// the target the owner typed (provenance 'you') and the tracked current value when stored data
// gives one. No number here is computed by the model.
function goalsForModel(db) {
  const scope = tokenScope(db);
  const fig = loadFigures(db);
  const accounts = db.prepare('SELECT * FROM accounts').all();
  return loadGoals(db, { fig, accounts }).filter(g => !g.archived).map(g => {
    const owner = g.origin === 'owner';
    const text = v => (owner ? String(v ?? '') : resolveTokens(scope, String(v ?? ''), false));
    const out = { id: g.id, title: text(g.title), horizon: horizonLabel(g.horizon) };
    const note = owner ? g.note : g.prose;
    if (note) out.note = text(note);
    if (!owner && g.status) out.status = g.status;
    if (owner && typeof g.target === 'number') out.target = { amount: g.target, source: 'you' };
    if (owner && g.targetDate) out.targetDate = g.targetDate;
    if (g.trackLabel) out.tracking = g.trackLabel;
    const cur = g.progress ? fig[g.progress.cur] : (g.current ? fig[g.current] : null);
    if (cur && typeof cur.v === 'number' && !cur.unavailable) out.current = { amount: cur.v, kind: cur.kind };
    if (!owner && g.progress && fig[g.progress.target]) out.target = { amount: fig[g.progress.target].v, source: 'plan' };
    return out;
  });
}

// Curve positions as words: which end the owner leans to, or no lean.
function curveForModel(db) {
  const scope = tokenScope(db);
  return loadCurve(db, loadContent(db)).map(c => {
    const left = resolveTokens(scope, String(c.left ?? ''), false);
    const right = resolveTokens(scope, String(c.right ?? ''), false);
    const lean = c.value < 0.45 ? left : c.value > 0.55 ? right : 'no lean';
    return { between: `${left} or ${right}`, leansToward: lean };
  });
}

// ---------------------------------------------------------------- tools

export const tools = [
  {
    name: 'household_summary',
    description: 'Household overview: confirmed facts, the verdict (clear or attention), how many recommendations need the owner now, counts by status, the data-through date, today, the open goals (title, horizon, target the owner typed, tracked current value) and where the owner sits on each tradeoff curve.',
    inputSchema: obj(),
    scope: 'read',
    handler(args, ctx) {
      const clock = clockOf(ctx);
      const recs = visible(loadRecs(ctx.db, clock));
      const statusCounts = {};
      for (const r of recs) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
      const facts = {};
      for (const f of ctx.db.prepare('SELECT key, value FROM facts ORDER BY key').all()) facts[f.key] = parse(f.value, f.value);
      const meta = loadContent(ctx.db).meta || {};
      return {
        facts,
        verdictLevel: verdictLevel(recs),
        needsYouCount: needsYou(recs).length,
        statusCounts,
        dataThrough: meta.dataThrough || '',
        clock,
        goals: goalsForModel(ctx.db),
        curve: curveForModel(ctx.db),
      };
    },
  },
  {
    name: 'get_facts',
    description: 'Household facts with their source, as-of date and whether the owner confirmed them. Optionally only the given keys.',
    inputSchema: obj({ keys: { type: 'array', items: { type: 'string' }, maxItems: 200 } }),
    scope: 'read',
    handler(args, ctx) {
      const rows = ctx.db.prepare('SELECT key, value, src, as_of, confirmed FROM facts ORDER BY key').all();
      const want = args.keys ? new Set(args.keys) : null;
      return rows.filter(r => !want || want.has(r.key))
        .map(r => ({ key: r.key, value: parse(r.value, r.value), src: r.src, asOf: r.as_of, confirmed: !!r.confirmed }));
    },
  },
  {
    name: 'list_accounts',
    description: 'Mirrored accounts (read-only) with their latest balance and its date. Account identifiers are masks of the last four digits at most.',
    inputSchema: obj(),
    scope: 'read',
    handler(args, ctx) {
      const scope = tokenScope(ctx.db);
      const latest = ctx.db.prepare('SELECT date, amount FROM balances WHERE account_id = ? ORDER BY date DESC LIMIT 1');
      return ctx.db.prepare('SELECT * FROM accounts ORDER BY sort, id').all().map(a => {
        const b = latest.get(a.id);
        const out = {
          id: a.id, inst: a.inst, mask: a.mask, name: a.name, owner: a.owner, kind: a.kind, mirror: a.mirror,
          note: a.note || '', balance: b ? b.amount : null, asOf: b ? b.date : null,
        };
        // Imported accounts carry text from uploaded files: verbatim, never token-resolved.
        return a.parser === 'demo-seed' ? plainDeep(scope, out) : out;
      });
    },
  },
  {
    name: 'query_transactions',
    description: 'Search transactions by account, date range (inclusive, YYYY-MM-DD), amount range, category or description text. Returns at most `limit` rows (default 50, max 200), newest first, with the total match count.',
    inputSchema: obj({
      accountId: { type: 'string' },
      from: { type: 'string', pattern: DATE },
      to: { type: 'string', pattern: DATE },
      minAmount: { type: 'number' },
      maxAmount: { type: 'number' },
      category: { type: 'string' },
      text: { type: 'string', minLength: 1, maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    }),
    scope: 'read',
    handler(args, ctx) {
      const { clause, params } = where([
        ['account_id = ?', args.accountId],
        ['date >= ?', args.from],
        ['date <= ?', args.to],
        ['amount >= ?', args.minAmount],
        ['amount <= ?', args.maxAmount],
        ['category = ?', args.category],
        ["lower(description) LIKE ? ESCAPE '\\'",
          args.text === undefined ? undefined : '%' + args.text.toLowerCase().replace(/[\\%_]/g, c => '\\' + c) + '%'],
      ]);
      const limit = args.limit === undefined ? 50 : args.limit;
      const total = ctx.db.prepare('SELECT count(*) AS n FROM transactions' + clause).get(...params).n;
      const rows = ctx.db.prepare('SELECT id, account_id, date, amount, description, category FROM transactions' + clause +
        ' ORDER BY date DESC, id DESC LIMIT ?').all(...params, limit)
        .map(r => ({ id: r.id, accountId: r.account_id, date: r.date, amount: r.amount, description: r.description, category: r.category }));
      return { rows, truncated: total > rows.length, total };
    },
  },
  {
    name: 'list_positions',
    description: 'Investment positions (symbol, name, quantity, price, value, cost basis) by account.',
    inputSchema: obj({ accountId: { type: 'string' } }),
    scope: 'read',
    handler(args, ctx) {
      const { clause, params } = where([['account_id = ?', args.accountId]]);
      return ctx.db.prepare('SELECT * FROM positions' + clause + ' ORDER BY account_id, id').all(...params).map(p => ({
        accountId: p.account_id, symbol: p.symbol, name: p.name, quantity: p.quantity, price: p.price, value: p.value,
        costBasis: p.cost_basis, asOf: p.as_of,
      }));
    },
  },
  {
    name: 'pnl_by_month',
    description: 'Business profit and loss by month (YYYY-MM) and category, with a total per month. Optionally one entity and a month range.',
    inputSchema: obj({ entity: { type: 'string' }, from: { type: 'string', pattern: MONTH }, to: { type: 'string', pattern: MONTH } }),
    scope: 'read',
    handler(args, ctx) {
      const { clause, params } = where([['entity = ?', args.entity], ['period >= ?', args.from], ['period <= ?', args.to]]);
      const rows = ctx.db.prepare('SELECT period, category, sum(amount) AS amount FROM pnl_lines' + clause +
        ' GROUP BY period, category ORDER BY period, category').all(...params)
        .map(r => ({ period: r.period, category: r.category, amount: cents(r.amount) }));
      const totals = {};
      for (const r of rows) totals[r.period] = cents((totals[r.period] || 0) + r.amount);
      return { rows, totals };
    },
  },
  {
    name: 'list_recommendations',
    description: 'Recommendations with live status, window and tasks. Optionally only the given status or statuses. Hidden recommendations are never listed.',
    inputSchema: obj({
      status: {
        anyOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string', enum: STATUSES.filter(s => s !== 'hidden') } },
        ],
      },
    }),
    scope: 'read',
    handler(args, ctx) {
      if (typeof args.status === 'string' && !STATUSES.includes(args.status)) throw new ToolError('bad_input', 'args.status is not a status');
      const want = args.status === undefined ? null : new Set([].concat(args.status));
      const scope = tokenScope(ctx.db);
      return visible(loadRecs(ctx.db, clockOf(ctx))).filter(r => !want || want.has(r.status)).map(r => plainDeep(scope, r));
    },
  },
  {
    name: 'get_recommendation',
    description: 'One recommendation by id, with live status, window, tasks, why-now, figures and knowledge-pack excerpts.',
    inputSchema: obj({ id: { type: 'string', minLength: 1 } }, ['id']),
    scope: 'read',
    handler(args, ctx) {
      const row = recRow(ctx.db, args.id);
      return plainDeep(tokenScope(ctx.db), withAdvisor(ctx.db, [recFromRow(row, clockOf(ctx))])[0]);
    },
  },
  {
    name: 'list_deadlines',
    description: 'Calendar deadlines sorted by date, optionally within an inclusive date range (YYYY-MM-DD).',
    inputSchema: obj({ from: { type: 'string', pattern: DATE }, to: { type: 'string', pattern: DATE } }),
    scope: 'read',
    handler(args, ctx) {
      const { clause, params } = where([['date >= ?', args.from], ['date <= ?', args.to]]);
      const scope = tokenScope(ctx.db);
      return ctx.db.prepare('SELECT * FROM deadlines' + clause + ' ORDER BY date, id').all(...params)
        .map(d => plainDeep(scope, { date: d.date, label: d.label, title: d.title, recId: d.rec_id, hard: !!d.hard }));
    },
  },
  {
    name: 'list_goals',
    description: 'The open household goals in plain language: title, horizon, note, the target the owner typed and the tracked current value from stored data.',
    inputSchema: obj(),
    scope: 'read',
    handler(args, ctx) {
      return goalsForModel(ctx.db);
    },
  },
  {
    name: 'get_figures',
    description: 'Stored figures (money values) with their kind (a actual, p projected, e estimate, m model), label and source with as-of date. A figure with unavailable is kept only for reference and is not current. Optionally only the given keys.',
    inputSchema: obj({ keys: { type: 'array', items: { type: 'string' }, maxItems: 500 } }),
    scope: 'read',
    handler(args, ctx) {
      const want = args.keys ? new Set(args.keys) : null;
      return ctx.db.prepare(`SELECT f.key, f.v, f.kind, f.label, f.src, f.unavailable_reason, s.label AS src_label, s.as_of AS src_as_of
                             FROM figures f LEFT JOIN sources s ON s.id = f.src ORDER BY f.rowid`).all()
        .filter(f => !want || want.has(f.key))
        .map(f => {
          const out = { key: f.key, v: f.v, kind: f.kind, label: f.label, source: { id: f.src, label: f.src_label || '', asOf: f.src_as_of || '' } };
          if (f.unavailable_reason) out.unavailable = f.unavailable_reason;
          return out;
        });
    },
  },
  {
    name: 'packs_status',
    description: 'Knowledge packs with their live status (active, exploring, suggested, available) and why they apply or might.',
    inputSchema: obj(),
    scope: 'read',
    handler(args, ctx) {
      const scope = tokenScope(ctx.db);
      return loadPacks(ctx.db).map(({ id, def, live }) => ({
        id, name: resolveTokens(scope, def.name || id, false), status: packStatus(def.status, live), why: resolveTokens(scope, def.why || '', false),
      }));
    },
  },
  {
    name: 'set_recommendation_status',
    description: 'Set a recommendation status (accepted, doing, done, dismissed, snoozed, proposed). Snoozed takes an optional wake label. Recorded in the rec history as a tool change.',
    inputSchema: obj({
      id: { type: 'string', minLength: 1 },
      status: { type: 'string', enum: SETTABLE },
      wake: { type: 'string', maxLength: 200 },
    }, ['id', 'status']),
    scope: 'write:recs',
    handler(args, ctx) {
      const db = ctx.db;
      const row = recRow(db, args.id);
      const def = parse(row.def, {});
      const wake = args.status === 'snoozed' ? (args.wake ? args.wake : 'Next month') : (def.wake != null ? def.wake : null);
      const ts = nowOf(ctx).toISOString();
      tx(db, () => {
        db.prepare('UPDATE recs SET status = ?, wake = ?, updated_at = ? WHERE id = ?').run(args.status, wake, ts, args.id);
        db.prepare(`INSERT INTO rec_events (rec_id, ts, action, arg, from_status, to_status, actor)
                    VALUES (?, ?, 'set_status', ?, ?, ?, 'tool')`).run(args.id, ts, args.wake == null ? null : args.wake, row.status, args.status);
      });
      return plainDeep(tokenScope(db), withAdvisor(db, [recFromRow(recRow(db, args.id), clockOf(ctx))])[0]);
    },
  },
  {
    name: 'advisor_status',
    description: 'The advisor review workflow: the next check-in, recommendations waiting on the advisor (with the date sent), verdicts recorded (confirmed or vetoed, with the advisor note, the advisor date and the date it was recorded), closed reviews, and generated review packets. Read only. The household records verdicts; there are no advisor accounts.',
    inputSchema: obj(),
    scope: 'read',
    handler(args, ctx) {
      const scope = tokenScope(ctx.db);
      const names = scope.names || {};
      return plainDeep(scope, { advisor: names.advisor || 'Your advisor', ...advisorStatus(ctx.db) });
    },
  },
  ...packTools,
];

const byName = new Map(tools.map(t => [t.name, t]));

export function getTool(name) {
  return byName.get(name) || null;
}

export async function callTool(name, args, ctx) {
  const tool = getTool(name);
  if (!tool) throw new ToolError('not_found', `no tool ${name}`);
  const a = args == null ? {} : args;
  validate(tool.inputSchema, a);
  return tool.handler(a, ctx);
}
