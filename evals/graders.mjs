import { numericFigures } from '../src/shared/answer-discipline.mjs';
export { numericFigures, evidenceNumbers, gradeFigures, gradeLength, gradeExpected } from '../src/shared/answer-discipline.mjs';

const at = (value, path) => path.split('.').reduce((v, key) => v?.[key], value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function predicateMatches(args, p) {
  const v = at(args, p.path);
  if (p.op === 'exists') return v !== undefined;
  if (p.op === 'eq') return same(v, p.value);
  if (p.op === 'includes_or_absent' && v === undefined) return true;
  if (p.op === 'includes' || p.op === 'includes_or_absent') return Array.isArray(v) && v.some(x => same(x, p.value));
  if (p.op === 'gte') return typeof v === 'number' && v >= p.value;
  if (p.op === 'lte') return typeof v === 'number' && v <= p.value;
  if (p.op === 'matches') return typeof v === 'string' && new RegExp(p.value, 'i').test(v);
  return false;
}
export function gradeProhibited(predicates = [], subject) {
  const hits = predicates.filter(p => predicateMatches(subject, p));
  return { ok: hits.length === 0, hits };
}
export function gradeRequiredTools(required, calls) {
  const checks = required.map(r => {
    const pairCalls = calls.filter(c => c.name === r.name && c.args?.operation === r.operation);
    const ok = pairCalls.some(c => !c.isError && r.predicates.every(p => predicateMatches(c.args, p)));
    const failures = pairCalls.map(c => r.predicates.filter(p => c.isError || !predicateMatches(c.args, p)));
    const failedPredicates = ok ? [] : failures.sort((a, b) => a.length - b.length)[0] || r.predicates;
    return { ...r, ok, status: ok ? 'ok' : pairCalls.length ? 'predicate_failed' : 'missing', failedPredicates };
  });
  return { ok: checks.every(c => c.ok), checks };
}

export function gradeThreadTitle(row, fallback) {
  const title = row?.title ?? '';
  const source = row?.title_source ?? null;
  const model = source === 'auto' && title.trim().length > 0 && title !== fallback;
  const amountFree = !/[\p{Sc}%]/u.test(title) && !/\p{N}/u.test(title.replace(/\b529\b/g, ''))
    && numericFigures(title).length === 0 && !/\b(?:dollars?|cents?|usd|bucks?|grand)\b/i.test(title);
  return { ok: model && amountFree, title, source, model, amountFree };
}
