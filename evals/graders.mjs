import { isDeepStrictEqual } from 'node:util';
import { buildSnapshot } from '../src/blocks/snapshot.mjs';
import { validTitle } from '../src/blocks/labels.mjs';
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

export function gradeBlocks(provenance = {}, transcript = [], required = []) {
  const blocks = provenance?.blocks ?? [];
  const violations = [];
  const add = (kind, id) => violations.push({ kind, ...(id ? { id } : {}) });
  const remaining = [...blocks];
  for (const need of required) {
    const i = remaining.findIndex(b => b.op === need.op && (!need.kind || b.snapshot?.kind === need.kind));
    if (i < 0) add('block_missing'); else remaining.splice(i, 1);
  }
  if (required.length && provenance?.blockNotes?.length) add('block_dropped');
  function literal(value, path = []) {
    if (path.at(-1) === 'args' && path.at(-2) === 'source') return false;
    if (typeof value === 'number') return true;
    return value && typeof value === 'object' && Object.entries(value).some(([k, v]) => literal(v, [...path, k]));
  }
  function figures(value, path = '', out = []) {
    if (!value || typeof value !== 'object') return out;
    if (Object.hasOwn(value, 'value') && typeof value.unit === 'string') out.push({ path, value: value.value, unit: value.unit });
    else for (const [key, v] of Object.entries(value)) figures(v, path + '.' + key, out);
    return out;
  }
  for (const block of blocks) {
    const calls = block.calls ?? [];
    if (!calls.length || calls.some(c => !transcript.some(t => !t.isError && t.name === c.tool && isDeepStrictEqual(t.args, c.args)))) add('block_unreferenced', block.id);
    if (literal(block.spec) || block.spec?.title !== undefined && !validTitle(block.spec.title)) add('block_literal', block.id);
    try {
      const expected = buildSnapshot(block.op, block.spec, transcript);
      if (!isDeepStrictEqual(figures(block.snapshot), figures(expected))) add('block_value_mismatch', block.id);
    } catch { add('block_unreferenced', block.id); }
  }
  return { ok: violations.length === 0, violations };
}
