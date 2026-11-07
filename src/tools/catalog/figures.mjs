import { getSetting, parseJson as parse } from '../../store/db.mjs';
import { loadContent, loadPacks, tokenScope, resolveClock, todayUtc, loadGoals, loadCurve, loadFigures, loadLinkedRecs, loadLinkedRec, housekeepingCount } from '../../scenario/build.mjs';
import { horizonLabel, personLabel } from '../../shared/goals.mjs';
import { accountLabel } from '../../shared/account-label.mjs';
import { accountNaming, relabelStoredFigure } from '../../accounts/naming.mjs';
import { OWNERS } from '../../shared/rec-links.mjs';
import { needsYou, verdictLevel, packStatus, STATUSES } from '../../shared/rules.mjs';
import { resolveTokens } from '../../shared/tokens.mjs';
import { ToolError } from '../errors.mjs';
import { packTools } from '../packs.mjs';
import { SETTABLE_REC_STATUSES } from '../../store/recs.mjs';
import { advisorStatus } from '../../advisor/index.mjs';
import { buildPace } from '../../pace/build.mjs';
import { actionTools } from '../actions.mjs';
import { changeRec } from '../../actions/index.mjs';
import { ANSWER_SHAPES, answerShape } from '../../jobs/triggers/common.mjs';
import { fromStored, fromPace } from '../../calc/figure.mjs';

const SETTABLE = SETTABLE_REC_STATUSES;
const DATE = '^\\d{4}-\\d{2}-\\d{2}$';

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

// A linked rec as the model sees it: rec text token-resolved, goal titles in serves resolved only
// for seed goals (owner text stays literal).
function recOut(scope, rec) {
  const { serves, ...rest } = rec;
  const out = plainDeep(scope, rest);
  out.serves = serves.map(g => ({ id: g.id, title: g.origin === 'owner' ? String(g.title ?? '') : resolveTokens(scope, String(g.title ?? ''), false), origin: g.origin }));
  return out;
}

// One visible rec, linked, for the model.
function recOutById(db, clock, id) {
  return recOut(tokenScope(db), loadLinkedRec(db, clock, recRow(db, id)));
}

// Goals as the model sees them: every goal not archived (done goals say so in status), owner text
// verbatim (seed text token-resolved), the kind, whose goal with its label, the priority, the
// amounts as typed (provenance 'you' for owner goals, 'plan' for the demo's seed goals; an entered
// contribution is always 'you') and the tracked current value when stored data gives one. status is
// canonical (open or done); a seed goal's display text is statusLabel. No number here is computed by
// the model; progress is get_pace's.
function goalsForModel(db) {
  const scope = tokenScope(db);
  const fig = loadFigures(db);
  const accounts = db.prepare('SELECT * FROM accounts').all();
  return loadGoals(db, { fig, accounts }).filter(g => !g.archived).map(g => {
    const owner = g.origin === 'owner';
    const source = owner ? 'you' : 'plan';
    const text = v => (owner ? String(v ?? '') : resolveTokens(scope, String(v ?? ''), false));
    const amount = v => (typeof v === 'number' && Number.isFinite(v) ? { amount: v, source } : null);
    const out = { id: g.id, title: text(g.title), horizon: horizonLabel(g.horizon) };
    const note = owner ? g.note : g.prose;
    if (note) out.note = text(note);
    if (g.status) out.status = g.status;
    if (!owner && g.statusLabel) out.statusLabel = g.statusLabel;
    out.kind = g.kind;
    if (g.owner) { out.owner = g.owner; out.ownerLabel = personLabel(g.owner, scope.names); }
    if (g.priority) out.priority = g.priority;
    if (owner && typeof g.target === 'number') out.target = { amount: g.target, source: 'you' };
    if (owner && g.targetDate) out.targetDate = g.targetDate;
    if (g.kind === 'range' && amount(g.targetLow) && amount(g.targetHigh)) out.range = { low: amount(g.targetLow), high: amount(g.targetHigh) };
    if (g.kind === 'floor' && amount(g.floor)) out.floor = amount(g.floor);
    if (g.kind === 'contribution') {
      if (!owner && amount(g.target)) out.target = amount(g.target);
      const e = g.entered && typeof g.entered === 'object' ? g.entered : null;
      out.contribution = {
        taxYear: Number.isInteger(g.taxYear) ? g.taxYear : null,
        deadline: g.targetDate || null,
        accounts: g.accountsLabel ? text(g.accountsLabel) : null,
        split: (Array.isArray(g.split) ? g.split : []).map(p => ({ person: p.person, label: personLabel(p.person, scope.names), amount: p.amount, source })),
        entered: e ? { asOf: e.asOf, ...(typeof e.total === 'number' ? { total: e.total } : {}),
          ...(Array.isArray(e.people) ? { people: e.people.map(p => ({ person: p.person, amount: p.amount })) } : {}), source: 'you' } : null,
      };
    }
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


export const tools = [
  {
    name: 'household_summary',
    description: 'Household overview: confirmed facts, the verdict (clear or attention), how many recommendations need the owner now, counts by status, how many open recommendations are housekeeping (serve no goal), the data-through date, today, the open goals (title, horizon, target the owner typed, tracked current value) and where the owner sits on each tradeoff curve.',
    inputSchema: obj(),
    scope: 'read',
    handler(args, ctx) {
      const clock = clockOf(ctx);
      const recs = visible(loadLinkedRecs(ctx.db, clock));
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
        housekeepingCount: housekeepingCount(recs),
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
      const naming = accountNaming(ctx.db);
      return ctx.db.prepare('SELECT * FROM accounts ORDER BY sort, id').all().map(a => {
        const b = latest.get(a.id);
        const out = {
          id: a.id, inst: a.inst, mask: a.mask,
          name: accountLabel(naming.byId.get(a.id) || a),
          importedName: a.name, owner: a.owner, kind: a.kind, mirror: a.mirror,
          note: a.note || '', balance: b ? b.amount : null, asOf: b ? b.date : null,
        };
        // Imported accounts carry text from uploaded files: verbatim, never token-resolved.
        return a.parser === 'demo-seed' ? plainDeep(scope, out) : out;
      });
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
    name: 'list_recommendations',
    description: 'Recommendations with live status, window, tasks, action owner (you, spouse, both, advisor, automatic) and the open goals each serves (housekeeping when none). Optionally only the given status or statuses. Hidden recommendations are never listed.',
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
      return visible(loadLinkedRecs(ctx.db, clockOf(ctx))).filter(r => !want || want.has(r.status)).map(r => recOut(scope, r));
    },
  },
  {
    name: 'get_recommendation',
    description: 'One recommendation by id, with live status, window, tasks, why-now, figures, knowledge-pack excerpts, action owner and the open goals it serves.',
    inputSchema: obj({ id: { type: 'string', minLength: 1 } }, ['id']),
    scope: 'read',
    handler(args, ctx) {
      return recOutById(ctx.db, clockOf(ctx), args.id);
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
    description: 'The household goals not archived, in plain language: title, horizon, note, kind, whose goal, priority, status (open or done), the kind\'s amounts as typed (target, range ends, floor, contribution tax year, deadline, accounts, split and entered amount) and the tracked current value from stored data; use get_pace for progress.',
    inputSchema: obj(),
    scope: 'read',
    handler(args, ctx) {
      return goalsForModel(ctx.db);
    },
  },
  {
    name: 'get_pace',
    description: 'Deterministic goal pace, household health, monthly deltas and available meters, with provenance and data-through dates. Unknown health requires fresh data or a plan baseline.',
    inputSchema: obj(),
    scope: 'read',
    handler(args, ctx) {
      return withEnvelopes(buildPace(ctx.db, { clock: clockOf(ctx) }));
    },
  },
  {
    name: 'get_figures',
    description: 'Stored figures (money values) with their kind (a actual, p projected, e estimate, m model), label and source with as-of date. A figure with unavailable is kept only for reference and is not current. Optionally only the given keys.',
    inputSchema: obj({ keys: { type: 'array', items: { type: 'string' }, maxItems: 500 } }),
    scope: 'read',
    handler(args, ctx) {
      const want = args.keys ? new Set(args.keys) : null;
      const naming = accountNaming(ctx.db);
      return ctx.db.prepare(`SELECT f.key, f.v, f.kind, f.label, f.src, f.locator, f.unavailable_reason, s.label AS src_label, s.as_of AS src_as_of
                             FROM figures f LEFT JOIN sources s ON s.id = f.src ORDER BY f.rowid`).all()
        .filter(f => !want || want.has(f.key))
        .map(f => {
          const named = relabelStoredFigure(naming, f);
          const out = { key: named.key, v: named.v, kind: named.kind, label: named.label, source: { id: named.src, label: named.src_label || '', asOf: named.src_as_of || '' } };
          if (f.unavailable_reason) out.unavailable = f.unavailable_reason;
          return { ...out, ...fromStored(named, { ref: { tool: 'get_figures', args: { keys: [named.key] }, path: '0' } }) };
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
    description: 'Set a recommendation status (doing, done, dismissed, snoozed, proposed). Snoozed takes an optional wake label. Recorded in the rec history as a tool change.',
    inputSchema: obj({
      id: { type: 'string', minLength: 1 },
      status: { type: 'string', enum: SETTABLE },
      wake: { type: 'string', maxLength: 200 },
    }, ['id', 'status']),
    scope: 'write:recs',
    handler(args, ctx) {
      const { receipt } = changeRec(args, ctx, 'status');
      return { ...recOutById(ctx.db, clockOf(ctx), args.id), receipt };
    },
  },
  {
    name: 'set_recommendation_owner',
    description: 'Set who acts on a recommendation: you, spouse, both, advisor or automatic. The planner keeps an owner set this way. Recorded in the rec history as a tool change.',
    inputSchema: obj({
      id: { type: 'string', minLength: 1 },
      owner: { type: 'string', enum: [...OWNERS] },
    }, ['id', 'owner']),
    scope: 'write:recs',
    handler(args, ctx) {
      const { receipt } = changeRec(args, ctx, 'owner');
      return { ...recOutById(ctx.db, clockOf(ctx), args.id), receipt };
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
  { name: 'get_fact_answer_shapes', scope: 'read', description: 'Accepted household fact keys and their typed answer shapes, units and choices for record_household_fact.',
    inputSchema: obj(), handler() { return Object.fromEntries(Object.keys(ANSWER_SHAPES).map(key => [key, answerShape(key)])); } },
  ...actionTools,
  ...packTools,
];

function withEnvelopes(value, path = '') {
  if (!value || typeof value !== 'object') return value;
  if (Object.hasOwn(value, 'v') && value.src === 'calc:pace' && value.locator) {
    return { ...value, envelope: fromPace(value, { ref: { tool: 'get_pace', args: {}, path: `${path}.envelope` } }) };
  }
  const visit = ([key, child]) => [key, withEnvelopes(child, path ? `${path}.${key}` : key)];
  return Array.isArray(value) ? value.map((child, i) => withEnvelopes(child, path ? `${path}.${i}` : String(i)))
    : Object.fromEntries(Object.entries(value).map(visit));
}

export const parity = {
  '/api/recs/:id/action': ['set_recommendation_status', 'set_recommendation_owner', 'set_recommendation_step'],
  '/api/goals': ['create_goal'],
  '/api/goals/:id': ['edit_goal'],
  '/api/preferences': ['remember_preference'],
  '/api/preferences/:id': ['remember_preference'],
  '/api/actions/:id/undo': ['undo_preference_action', 'undo_fact_action', 'undo_step_action', 'undo_goal_action', 'undo_recommendation_action'],
};
