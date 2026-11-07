export const UNITS = Object.freeze(['usd', 'usd_per_month', 'usd_per_year', 'ratio', 'days', 'months', 'years', 'age', 'date', 'count']);
export const GAP_CODES = Object.freeze(['uncategorized_rows', 'guessed_rows', 'account_no_history', 'incomplete_month',
  'stale_account', 'outside_household_ledger', 'missing_fact', 'carried_balance', 'unclassified_category',
  'no_cost_basis', 'unequal_periods']);

export const round = v => Math.round((v + Number.EPSILON) * 100) / 100;
const SRC = 'calc:targets';

export function roundForUnit(value, unit, { projection = false } = {}) {
  if (!UNITS.includes(unit)) throw new TypeError(`Unknown figure unit ${unit}`);
  switch (unit) {
    case 'ratio':
    case 'date': return value;
    case 'count': return Math.round(value);
    case 'months': return projection ? Math.ceil(value) : Math.round(value);
    case 'age': {
      const rounded = Math.round(value * 2) / 2;
      return Number.isFinite(rounded) ? rounded : value;
    }
    default: {
      const rounded = round(value);
      return Number.isFinite(rounded) ? rounded : value;
    }
  }
}

const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
  && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;

export function envelope(value, { unit, label, kind = 'e', asOf, window, ref, provenance = {}, gaps = [], unavailable, projection = false }) {
  if (!UNITS.includes(unit)) throw new TypeError(`Unknown figure unit ${unit}`);
  for (const gap of gaps) {
    if (!GAP_CODES.includes(gap.code)) throw new TypeError(`Unknown figure gap code ${gap.code}`);
  }
  if (value === null) {
    if (typeof unavailable !== 'string' || !unavailable.trim()) throw new TypeError('A null figure requires an unavailable reason');
  } else if (unit === 'date' ? !isoDate(value) : typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Invalid figure value for ${unit}`);
  }
  return { value: value === null ? null : roundForUnit(value, unit, { projection }), unit, label, kind, asOf, ref,
    ...(window === undefined ? {} : { window }), provenance, gaps,
    ...(unavailable === undefined ? {} : { unavailable }) };
}

function locatorOf(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function provenanceOf(locator, src) {
  const provenance = { calc: locator?.calc ?? src };
  for (const key of ['formula', 'inputs', 'sources', 'steps']) {
    if (locator?.[key] !== undefined) provenance[key] = locator[key];
  }
  return provenance;
}

export function fromStored(row, { ref }) {
  const locator = locatorOf(row.locator);
  const unavailable = row.unavailable_reason || undefined;
  return envelope(unavailable ? null : row.v, { unit: locator?.unit ?? 'usd', label: row.label, kind: row.kind,
    asOf: locator?.computedOn || row.src_as_of || null, window: locator?.window, ref,
    provenance: { ...provenanceOf(locator, row.src), stored: { src: row.src, locator } },
    ...(unavailable ? { unavailable, gaps: [{ code: GAP_CODES.includes(unavailable) ? unavailable : 'missing_fact',
      message: `The stored figure is unavailable: ${unavailable}` }] } : {}) });
}

export function fromPace(fig, { ref }) {
  const locator = locatorOf(fig.locator);
  return envelope(fig.v, { unit: locator?.unit, label: fig.label, kind: fig.kind,
    asOf: locator?.dataThrough ?? null, window: locator?.window, ref, provenance: provenanceOf(locator, fig.src) });
}

export const rowsSource = (table, ids) => ({ rows: { table, ids: ids.slice(0, 50), count: ids.length } });
export function mergeSources(list) {
  const by = new Map();
  for (const s of list) {
    if (!s?.rows || !Array.isArray(s.rows.ids)) continue;
    by.set(s.rows.table, [...(by.get(s.rows.table) || []), ...s.rows.ids]);
  }
  return [...by].map(([table, ids]) => rowsSource(table, [...new Set(ids)]));
}

export function figure(v, { label, kind = 'e', calc, clock, inputs = {}, parameters = {}, window = null, sources, formula, notes }) {
  const value = round(v);
  return { v: value, src: SRC, kind, label, notes: notes.filter(n => typeof n === 'string' && n.trim()).slice(0, 5),
    locator: { calc, inputs: structuredClone(inputs), parameters: { ...parameters }, window: window && { ...window },
      sources: structuredClone(sources), steps: [{ label, formula, value }], computedOn: clock } };
}

