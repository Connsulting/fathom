import { getSetting } from '../../store/db.mjs';
import { loadContent, tokenScope, resolveClock, todayUtc, loadGoals, loadCurve, loadFigures, loadLinkedRec } from '../../scenario/build.mjs';
import { horizonLabel, personLabel } from '../../shared/goals.mjs';
import { accountNaming, relabelStoredFigure, withLabelHints } from '../../accounts/naming.mjs';
import { resolveTokens } from '../../shared/tokens.mjs';
import { ToolError } from '../errors.mjs';
import { fromStored, fromPace } from '../../calc/figure.mjs';



// ctx.now as a Date: anything `new Date` accepts (Date, ISO string, epoch ms); the current time
// when it is absent or invalid.
function nowOf(ctx) {
  const d = ctx.now == null ? null : new Date(ctx.now);
  return d && !Number.isNaN(d.getTime()) ? d : new Date();
}

// "Today": ctx.clock (FATHOM_CLOCK) when given, else the store clock when set, else ctx.now's UTC date.
export function clockOf(ctx) {
  return resolveClock(ctx.db, ctx.clock || getSetting(ctx.db, 'clock', null) || todayUtc(nowOf(ctx)));
}

// ' WHERE a AND b' and its params from [sql, value] pairs, skipping undefined values.
function where(conds) {
  const used = conds.filter(c => c[1] !== undefined);
  return { clause: used.length ? ' WHERE ' + used.map(c => c[0]).join(' AND ') : '', params: used.map(c => c[1]) };
}

// Resolve tokens to plain text in every string of a value.
export function plainDeep(scope, v) {
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
export function recOut(scope, rec) {
  const { serves, ...rest } = rec;
  const out = plainDeep(scope, rest);
  out.serves = serves.map(g => ({ id: g.id, title: g.origin === 'owner' ? String(g.title ?? '') : resolveTokens(scope, String(g.title ?? ''), false), origin: g.origin }));
  return out;
}

// One visible rec, linked, for the model.
export function recOutById(db, clock, id) {
  return recOut(tokenScope(db), loadLinkedRec(db, clock, recRow(db, id)));
}

// Goals as the model sees them: every goal not archived (done goals say so in status), owner text
// verbatim (seed text token-resolved), the kind, whose goal with its label, the priority, the
// amounts as typed (provenance 'you' for owner goals, 'plan' for the demo's seed goals; an entered
// contribution is always 'you') and the tracked current value when stored data gives one. status is
// canonical (open or done); a seed goal's display text is statusLabel. No number here is computed by
// the model; progress is goals.pace's.
export function goalsForModel(db) {
  const scope = tokenScope(db);
  const fig = loadFigures(db);
  const accounts = withLabelHints(db, db.prepare('SELECT * FROM accounts WHERE archived_at IS NULL').all());
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
export function curveForModel(db) {
  const scope = tokenScope(db);
  return loadCurve(db, loadContent(db)).map(c => {
    const left = resolveTokens(scope, String(c.left ?? ''), false);
    const right = resolveTokens(scope, String(c.right ?? ''), false);
    const lean = c.value < 0.45 ? left : c.value > 0.55 ? right : 'no lean';
    return { between: `${left} or ${right}`, leansToward: lean };
  });
}


export function withEnvelopes(value, path = '') {
  if (!value || typeof value !== 'object') return value;
  if (Object.hasOwn(value, 'v') && value.src === 'calc:pace' && value.locator) {
    return { ...value, envelope: fromPace(value, { ref: { tool: 'goals', args: { operation: 'pace' }, path: `${path}.envelope` } }) };
  }
  const visit = ([key, child]) => [key, withEnvelopes(child, path ? `${path}.${key}` : key)];
  return Array.isArray(value) ? value.map((child, i) => withEnvelopes(child, path ? `${path}.${i}` : String(i)))
    : Object.fromEntries(Object.entries(value).map(visit));
}


export const operations = [
  {
    tool: 'household', name: 'figures',
    summary: 'Stored figures and provenance; quote their figure tokens.', route: 'Stored cash, taxes, room or net worth', routes: [],
    params: {"keys":{"type":"array","items":{"type":"string"},"maxItems":500}},
    required: [],
    scope: 'read', referenceable: true,
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
          return { ...out, ...fromStored(named, { ref: { tool: 'household', args: { operation: 'figures', keys: [named.key] }, path: '0' } }) };
        });
    },
  },
];
