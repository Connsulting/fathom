// calculate: the only arithmetic the model gets (section 3, `calculate`). It combines figures from
// refs and named assumptions into one figure with chained provenance. The operation is the
// arithmetic operator; operands are Operands (exactly one of { ref }, { assumption }, { expr }),
// never bare numbers. Unit algebra is checked, inputs stay unrounded, and only the result rounds,
// once, in its envelope. Limits: at most 20 operands per expression, expression depth at most 6,
// refs nested at most 3 deep (src/tools/refs.mjs).
import { envelope, GAP_CODES } from '../../calc/figure.mjs';
import { futureValue } from '../../calc/growth.mjs';
import { ToolError } from '../errors.mjs';
import { resolveRef } from '../refs.mjs';
import { checkAssumption } from '../assumption-evidence.mjs';

export const MAX_OPERANDS = 20;
export const MAX_DEPTH = 6;
const MONEY = new Set(['usd', 'usd_per_month', 'usd_per_year']);
const KINDS = ['a', 'e', 'm', 'p', 't'];
// An assumption is a modeled input: it weakens a result as a model figure does.
const ASSUMPTION_KIND = 'm';

const bad = message => new ToolError('bad_input', message);
const isObject = v => v != null && typeof v === 'object' && !Array.isArray(v);

// [arity min, arity max, words for the formula]
const OPS = {
  add: [2, MAX_OPERANDS, xs => xs.join(' plus ')],
  subtract: [2, MAX_OPERANDS, xs => xs.join(' minus ')],
  multiply: [2, 2, xs => xs.join(' times ')],
  divide: [2, 2, xs => xs.join(' divided by ')],
  sum: [1, MAX_OPERANDS, xs => `the sum of ${xs.join(', ')}`],
  min: [2, MAX_OPERANDS, xs => `the smallest of ${xs.join(', ')}`],
  max: [2, MAX_OPERANDS, xs => `the largest of ${xs.join(', ')}`],
  negate: [1, 1, ([x]) => `the negative of ${x}`],
  annualize: [1, 1, ([x]) => `${x} times 12`],
  monthly: [1, 1, ([x]) => `${x} divided by 12`],
  percent_of: [2, 2, ([r, b]) => `${r} of ${b}`],
  round_up: [1, 1, ([x], node) => `${x} rounded up to the next ${node.places}`],
  compound: [1, 1, ([x], node, extra) => `${x} grown at ${extra.rate} a year for ${extra.years}, compounded monthly`],
};

const sameUnit = (operation, terms) => {
  const [first] = terms;
  for (const t of terms.slice(1)) if (t.unit !== first.unit) throw bad(`${operation} cannot combine ${first.unit} and ${t.unit}`);
  return first.unit;
};

// The unit algebra (section 3): the result unit, or bad_input naming both units.
function resultUnit(operation, terms) {
  const units = terms.map(t => t.unit);
  const date = terms.find(t => t.unit === 'date');
  if (date) throw bad(`${operation} cannot do arithmetic on a date figure`);
  const [a, b] = units;
  switch (operation) {
    case 'add': case 'subtract': case 'sum': case 'min': case 'max':
      return sameUnit(operation, terms);
    case 'negate':
      return a;
    case 'multiply':
      if (b === 'ratio') return a;
      if (a === 'ratio') return b;
      if ((a === 'months' && b === 'usd_per_month') || (a === 'usd_per_month' && b === 'months')) return 'usd';
      throw bad(`multiply cannot combine ${a} and ${b}`);
    case 'divide':
      if (a === b) return 'ratio';
      if (a === 'usd_per_year' && b === 'ratio') return 'usd';
      if (b === 'ratio') return a;
      if (a === 'usd' && b === 'usd_per_month') return 'months';
      throw bad(`divide cannot combine ${a} and ${b}`);
    case 'percent_of':
      if (a !== 'ratio') throw bad(`percent_of needs a ratio first and then a base; got ${a} and ${b}`);
      return b;
    case 'annualize':
      if (a !== 'usd_per_month') throw bad(`annualize needs usd_per_month, got ${a}`);
      return 'usd_per_year';
    case 'monthly':
      if (a !== 'usd_per_year') throw bad(`monthly needs usd_per_year, got ${a}`);
      return 'usd_per_month';
    case 'round_up':
      if (a === 'ratio' || a === 'age') throw bad(`round_up cannot round ${a}`);
      return a;
    case 'compound':
      if (!MONEY.has(a)) throw bad(`compound needs a money figure (usd, usd_per_month or usd_per_year), got ${a}`);
      return a;
    default:
      throw bad(`unknown operation ${operation}`);
  }
}

function compute(operation, values, node, extra) {
  const [a, b] = values;
  switch (operation) {
    case 'add': case 'sum': return values.reduce((s, v) => s + v, 0);
    case 'subtract': return values.slice(1).reduce((s, v) => s - v, a);
    case 'min': return Math.min(...values);
    case 'max': return Math.max(...values);
    case 'negate': return -a;
    case 'multiply': case 'percent_of': return a * b;
    case 'divide':
      if (b === 0) throw bad('divide: division by zero');
      return a / b;
    case 'annualize': return a * 12;
    case 'monthly': return a / 12;
    // A tolerance below a cent keeps float noise in an unrounded input from adding a whole step.
    case 'round_up': return Math.ceil(a / node.places - 1e-9) * node.places;
    case 'compound': return futureValue({ balance: a, annualRate: extra.rateValue, months: extra.yearsValue * 12 });
    default: throw bad(`unknown operation ${operation}`);
  }
}

// One evaluated term: { value (unrounded, or null when unavailable), unit, kind, asOf, gaps,
// unavailable?, words, inputs, assumptions, steps }.
function leafOfFigure(figure, ref) {
  return { value: figure.value, unit: figure.unit, kind: figure.kind, asOf: figure.asOf ?? null, gaps: figure.gaps || [],
    unavailable: figure.value === null ? (figure.unavailable || 'missing_fact') : undefined,
    words: figure.label || 'a figure', inputs: [{ ...figure, ref: figure.ref ?? ref }], assumptions: [], steps: [] };
}

async function operandTerms(operand, ctx, where, depth, { list = false } = {}) {
  if (typeof operand === 'number' || (isObject(operand) && !['ref', 'assumption', 'expr'].some(k => Object.hasOwn(operand, k)))) {
    throw bad(`${where}: a bare number is not an operand; pass { ref } to a returned figure, { assumption } with a source, or { expr }`);
  }
  if (!isObject(operand)) throw bad(`${where} must be an operand object`);
  const kinds = ['ref', 'assumption', 'expr'].filter(k => Object.hasOwn(operand, k));
  if (kinds.length !== 1) throw bad(`${where} must hold exactly one of ref, assumption or expr`);
  for (const key of Object.keys(operand)) if (!kinds.includes(key)) throw bad(`${where}.${key} is not a known operand field`);

  if (kinds[0] === 'ref') {
    const target = await resolveRef(operand.ref, ctx, `${where}.ref`);
    if (!Array.isArray(target)) return [leafOfFigure(target, operand.ref)];
    if (!list) throw bad(`${where}.ref names a list of figures; only sum takes a list`);
    const base = operand.ref.path;
    return target.map((figure, i) => leafOfFigure(figure, { ...operand.ref, path: base ? `${base}.${i}` : String(i) }));
  }
  if (kinds[0] === 'assumption') {
    if (!isObject(operand.assumption)) throw bad(`${where}.assumption must be an object`);
    const { name, unit, ...assumption } = operand.assumption;
    if (typeof name !== 'string' || !name.trim() || name.length > 60) throw bad(`${where}.assumption.name must be 1 to 60 characters`);
    if (typeof unit !== 'string') throw bad(`${where}.assumption.unit is required`);
    const record = checkAssumption(assumption, { name, unit, path: `${where}.assumption (${name})` }, ctx);
    return [{ value: record.value, unit, kind: ASSUMPTION_KIND, asOf: null, gaps: [], words: `${name} ${record.stated}`,
      inputs: [], assumptions: [record], steps: [] }];
  }
  if (depth + 1 > MAX_DEPTH) throw bad(`${where}.expr: expression depth over ${MAX_DEPTH}`);
  const term = await evaluate(operand.expr, ctx, `${where}.expr`, depth + 1);
  return [{ ...term, words: `(${term.words})` }];
}

const EXPR_KEYS = new Set(['operation', 'operands', 'places', 'rate', 'years']);
const ONLY = { places: 'round_up', rate: 'compound', years: 'compound' };

// Evaluate one expression node at `depth` (the call itself is depth 1).
export async function evaluate(node, ctx, where = 'args', depth = 1) {
  if (!isObject(node)) throw bad(`${where} must be { operation, operands }`);
  for (const key of Object.keys(node)) if (!EXPR_KEYS.has(key)) throw bad(`${where}.${key} is not a known expression field`);
  const { operation, operands } = node;
  if (!Object.hasOwn(OPS, operation)) throw bad(`${where}.operation must be one of ${Object.keys(OPS).join(', ')}`);
  for (const [key, op] of Object.entries(ONLY)) {
    if (node[key] !== undefined && operation !== op) throw bad(`${where}.${key} applies only to ${op}`);
  }
  if (!Array.isArray(operands) || !operands.length) throw bad(`${where}.operands must list at least one operand`);
  if (operands.length > MAX_OPERANDS) throw bad(`${where}.operands: at most ${MAX_OPERANDS} operands per expression`);
  const [min, max, words] = OPS[operation];
  if (operands.length < min || operands.length > max) {
    throw bad(`${where}.operands: ${operation} takes ${min === max ? `exactly ${min}` : `${min} to ${max}`} operands`);
  }
  if (operation === 'round_up' && ![1, 100, 1000].includes(node.places)) throw bad(`${where}.places must be 1, 100 or 1000`);

  const terms = [];
  for (const [i, operand] of operands.entries()) {
    terms.push(...await operandTerms(operand, ctx, `${where}.operands[${i}]`, depth, { list: operation === 'sum' }));
  }
  const extra = {};
  const extraTerms = [];
  if (operation === 'compound') {
    for (const [key, unit] of [['rate', 'ratio'], ['years', 'years']]) {
      if (node[key] === undefined) throw bad(`${where}.${key} is required for compound`);
      const [term] = await operandTerms(node[key], ctx, `${where}.${key}`, depth);
      if (term.unit !== unit) throw bad(`${where}.${key} must be a ${unit} figure, got ${term.unit}`);
      extra[key] = term.words;
      extra[`${key}Value`] = term.value;
      extraTerms.push(term);
    }
    if (extra.yearsValue !== null && extra.yearsValue < 0) throw bad(`${where}.years must not be negative`);
  }

  const unit = resultUnit(operation, terms);
  const all = [...terms, ...extraTerms];
  const formula = words(terms.map(t => t.words), node, extra);
  const missing = all.find(t => t.value === null);
  let value = null;
  if (!missing) {
    value = compute(operation, terms.map(t => t.value), node, extra);
    if (!Number.isFinite(value)) throw bad(`${operation}: the result is not a finite number`);
  }
  return {
    value, unit, formula, words: formula,
    projection: operation === 'divide' && unit === 'months',
    unavailable: missing ? missing.unavailable : undefined,
    kind: KINDS[Math.max(...all.map(t => Math.max(0, KINDS.indexOf(t.kind ?? 'e'))))],
    asOf: oldest(all.map(t => t.asOf)),
    gaps: unionGaps(all.flatMap(t => t.gaps)),
    inputs: all.flatMap(t => t.inputs),
    assumptions: all.flatMap(t => t.assumptions),
    steps: [...all.flatMap(t => t.steps), { label: operation, formula, value }],
  };
}

// The oldest parseable asOf, as written; null when none.
function oldest(dates) {
  let best = null;
  for (const d of dates) {
    const t = d == null ? NaN : Date.parse(d);
    if (Number.isFinite(t) && (best === null || t < best.t)) best = { d, t };
  }
  return best ? best.d : null;
}

function unionGaps(gaps) {
  const seen = new Set();
  return gaps.filter(g => {
    const key = `${g.code}\u0000${g.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The call: one expression whose result becomes the figure, with a ref that reproduces it.
async function handler(params, ctx, operation) {
  const { label, ...rest } = params;
  const result = await evaluate({ operation, ...rest }, ctx, 'args', 1);
  const steps = result.steps.map((s, i, all) => (i === all.length - 1 ? { ...s, label } : s));
  const unavailable = result.unavailable === undefined ? undefined
    : (result.gaps.find(g => GAP_CODES.includes(g.code))?.code ?? (GAP_CODES.includes(result.unavailable) ? result.unavailable : 'missing_fact'));
  const gaps = unavailable && !result.gaps.length ? [{ code: unavailable, message: 'An input figure is unavailable.' }] : result.gaps;
  const figure = envelope(result.value, {
    unit: result.unit, label, kind: result.kind, asOf: result.asOf, projection: result.projection,
    ref: { tool: 'calculate', args: structuredClone({ operation, ...params }), path: 'figure' },
    provenance: { calc: 'calculate', formula: result.formula, inputs: result.inputs, assumptions: result.assumptions, steps },
    gaps, ...(unavailable ? { unavailable } : {}),
  });
  return { figure };
}

const operand = { type: 'object', properties: { ref: { type: 'object' }, assumption: { type: 'object' }, expr: { type: 'object' } } };
const base = {
  operands: { type: 'array', items: operand, minItems: 1, maxItems: MAX_OPERANDS },
  label: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[^0-9]*$' },
};
const SUMMARIES = {
  add: ['Two or more figures in one unit added.', 'Add figures'],
  subtract: ['The first figure minus the rest.', 'Subtract figures'],
  multiply: ['Two figures; usd times ratio, months times usd_per_month.', 'Multiply figures'],
  divide: ['Two figures; equal units give a ratio.', 'Divide figures'],
  sum: ['Total of figures, or of one ref to a list of figures.', 'Total several figures'],
  min: ['The smallest figure.', 'Smallest of figures'],
  max: ['The largest figure.', 'Largest of figures'],
  negate: ['The figure with its sign flipped.', 'Flip a sign'],
  annualize: ['usd_per_month to usd_per_year.', 'A monthly figure as a year'],
  monthly: ['usd_per_year to usd_per_month.', 'A yearly figure as a month'],
  percent_of: ['A ratio of a base: the ratio first.', 'A share of a figure'],
  round_up: ['Up to the next 1, 100 or 1000.', 'Round a figure up'],
  compound: ['Future value at a yearly ratio over years, compounded monthly.', 'Grow a figure at a rate'],
};
const PARAMS = {
  round_up: { operands: base.operands, places: { type: 'integer', enum: [1, 100, 1000] }, label: base.label },
  compound: { operands: base.operands, rate: operand, years: operand, label: base.label },
};

export const operations = Object.keys(OPS).map(name => ({
  tool: 'calculate', name, scope: 'read', referenceable: true,
  summary: SUMMARIES[name][0], route: SUMMARIES[name][1], routes: [],
  params: PARAMS[name] || base,
  required: Object.keys(PARAMS[name] || base),
  handler: (params, ctx) => handler(params, ctx, name),
}));

// Section 4 rules 2 to 6.
export const rules = [
  'Never sum, scale, annualize, subtract, divide or round numbers yourself. When an answer needs a number no tool returned, call calculate with refs to the figures and named assumptions.',
  'Write each figure exactly as its quote field gives it (for a stored figure, its {f:key} token). Never restate a figure in other words, spell it out, change its sign, round it, or derive a second number from it (a remaining amount, a difference, a monthly figure). Money leaving the household is quoted unsigned with a word that says so ("spent", "paid"). When a different form is needed, call calculate (round_up, monthly, subtract).',
  "Copy a figure's ref field to reference it; do not compose refs by hand. Pass the same arguments when you re-run a call so the figure is the same.",
  "State every assumption with its name, value and source: the owner said it (owner, with the owner's words as evidence), a saved preference (preference, with its id), a stored fact (fact, with its key), or the operation's default (default). Pass defaults by omitting the argument, and name them in the answer. Never mark a value as the owner's when the owner did not say it; when a tool needs a value nobody stated (a cost basis, a tax rate), leave it out, report the unavailable figure, and ask.",
  'Report data gaps. For each gap in a result, say what is missing and its size when the gap gives an amount or count. Never fill a gap with an estimate. Offer the fix the gap implies (a Confirm item, an import, a fact to record).',
];
