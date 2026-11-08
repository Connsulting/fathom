import { at } from './paths.mjs';

export function drillQuery(ref, item, field) {
  const a = ref?.args;
  const figure = at(item, field);
  const window = figure?.window;
  if (!a || typeof item?.key !== 'string' || !window?.from || !window?.to || figure.value === null) return null;
  const period = { from: window.from, to: window.to };
  if (ref.tool === 'spending' && a.operation === 'total' && a.groupBy === 'category' && field === 'figure' &&
      (a.measure ?? 'spending') === 'spending' && (a.scope ?? 'household') === 'household' && !a.definition && !a.annualize) {
    for (const side of ['include', 'exclude']) {
      const selector = a[side] ?? {};
      if (Object.keys(selector).some(key => key !== 'categories')) return null;
      if (selector.categories && (side === 'include' ? !selector.categories.includes(item.key) : selector.categories.includes(item.key))) return null;
    }
    return { route: 'spending', query: { ...period, bucket: 'household', category: item.key } };
  }
  if (ref.tool === 'business' && a.operation === 'pnl' && a.groupBy === 'category' &&
      typeof a.entity === 'string' && ['revenue', 'expenses'].includes(field)) {
    return { route: 'pnl', query: { ...period, entity: a.entity, section: field === 'revenue' ? 'income' : 'expenses', category: item.key } };
  }
  return null;
}
