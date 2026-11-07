// P&L and household spending reads, all GET, behind the same household gate as every /api read:
//   GET /api/pnl           ?entity&from&to                                    -> {entities, pnl, figures, sources}
//   GET /api/pnl/rows      ?entity&from&to&section&category&month             -> businessPnlRows result
//   GET /api/spending      ?from&to&include&exclude                           -> {spending, figures, sources}
//   GET /api/spending/rows ?from&to&include&exclude&bucket&category&month     -> householdSpendingRows result
// include and exclude are comma separated. PnlError maps to 400, or 404 for unknown_entity. No writes,
// no model calls.

import { HttpError } from './http.mjs';
import { resolveClock } from '../scenario/build.mjs';
import { PnlError, pnlEntities, businessPnl, businessPnlRows, householdSpending, householdSpendingRows } from '../pnl/index.mjs';

// A query value is one plain string (empty means absent); a repeated key is refused.
function one(query, key) {
  const v = query?.[key];
  if (v == null || v === '') return undefined;
  if (typeof v !== 'string') throw new HttpError(400, `${key} must be a single value`);
  return v;
}
const list = (query, key) => {
  const v = one(query, key);
  return v === undefined ? [] : v.split(',').map((s) => s.trim()).filter(Boolean);
};

function read(ctx, fn) {
  const clock = resolveClock(ctx.db, ctx.config && ctx.config.clock);
  try {
    return fn(ctx.query || {}, clock);
  } catch (e) {
    if (e instanceof PnlError) throw new HttpError(e.code === 'unknown_entity' ? 404 : 400, e.message, undefined, e.code);
    throw e;
  }
}

export function getPnl(ctx) {
  return read(ctx, (q, clock) => {
    const entities = pnlEntities({ db: ctx.db, clock });
    const entity = one(q, 'entity') ?? entities[0]?.key;
    if (entity === undefined) return { entities, pnl: null, figures: {}, sources: {} };
    const { figures, sources, ...pnl } = businessPnl({ db: ctx.db, entity, from: one(q, 'from'), to: one(q, 'to'), clock });
    return { entities, pnl, figures, sources };
  });
}

export function getPnlRows(ctx) {
  return read(ctx, (q, clock) => businessPnlRows({
    db: ctx.db, entity: one(q, 'entity'), from: one(q, 'from'), to: one(q, 'to'),
    section: one(q, 'section'), category: one(q, 'category'), month: one(q, 'month'), clock,
  }));
}

export function getSpending(ctx) {
  return read(ctx, (q, clock) => {
    const { figures, sources, ...spending } = householdSpending({
      db: ctx.db, from: one(q, 'from'), to: one(q, 'to'), include: list(q, 'include'), exclude: list(q, 'exclude'), clock,
    });
    return { spending, figures, sources };
  });
}

export function getSpendingRows(ctx) {
  return read(ctx, (q, clock) => householdSpendingRows({
    db: ctx.db, from: one(q, 'from'), to: one(q, 'to'), include: list(q, 'include'), exclude: list(q, 'exclude'),
    bucket: one(q, 'bucket'), category: one(q, 'category'), month: one(q, 'month'), clock,
  }));
}
