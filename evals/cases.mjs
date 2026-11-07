import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';

const predicate = { type: 'object', additionalProperties: false, required: ['path', 'op'], properties: {
  path: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_.]*$' },
  op: { enum: ['eq', 'includes', 'gte', 'lte', 'exists'] }, value: {},
} };
const expected = { type: 'object', additionalProperties: false, required: ['kind'], properties: {
  kind: { enum: ['figure', 'transaction', 'pnl-month', 'annual-spending', 'portfolio', 'net-worth', 'net-worth-change', 'cash-flow'] },
  key: { type: 'string', minLength: 1 }, category: { type: 'string', minLength: 1 },
  month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' }, rate: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
} };
export const caseSchema = {
  type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['id', 'family', 'turns'], properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9-]+$' },
    family: { enum: ['spending', 'cash-flow', 'business', 'net-worth', 'retirement', 'taxes', 'goals', 'freshness', 'unavailable'] },
    expectedFail: { type: 'object', additionalProperties: false, required: ['missingTools'], properties: {
      missingTools: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', pattern: '^[a-z][a-z0-9_]+$' } },
    } },
    turns: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
      required: ['question', 'required', 'forbidden', 'expected', 'maxWords', 'rubric'], properties: {
        question: { type: 'string', minLength: 1, maxLength: 4000 },
        required: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'predicates'], properties: {
          name: { type: 'string', pattern: '^[a-z][a-z0-9_]+$' }, predicates: { type: 'array', items: predicate },
        } } },
        forbidden: { const: ['unsourced-figure', 'self-computed-figure'] },
        expected: { type: 'array', items: expected }, maxWords: { type: 'integer', minimum: 1, maximum: 1000 },
        rubric: { type: 'string', minLength: 1 }, refusal: { type: 'boolean' },
      } } },
  } },
};
const validate = new Ajv({ strict: true, allErrors: true }).compile(caseSchema);
export function validateCases(cases) {
  if (!validate(cases)) throw new TypeError(`Invalid eval cases: ${JSON.stringify(validate.errors)}`);
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw new TypeError('Duplicate eval case id');
  for (const c of cases) {
    for (const turn of c.turns) {
      for (const requirement of turn.required) for (const p of requirement.predicates) {
        if (p.op !== 'exists' && !Object.hasOwn(p, 'value')) throw new TypeError('Predicate needs a value');
        if (['gte', 'lte'].includes(p.op) && !Number.isFinite(p.value)) throw new TypeError('Numeric predicate needs a number');
      }
      for (const e of turn.expected) {
        if (e.kind === 'figure' && !e.key) throw new TypeError('Figure expectation needs a key');
        if (e.kind === 'transaction' && !e.category) throw new TypeError('Transaction expectation needs a category');
        if (['pnl-month', 'cash-flow'].includes(e.kind) && !e.month) throw new TypeError('Monthly expectation needs a month');
        if (e.kind === 'portfolio' && !e.rate) throw new TypeError('Portfolio expectation needs a rate');
      }
    }
    for (const name of c.expectedFail?.missingTools ?? []) {
      if (!c.turns.some(t => t.required.some(r => r.name === name))) throw new TypeError('Missing tool must be a required call');
    }
  }
  return true;
}
export async function loadCases(file = new URL('./catalog.json', import.meta.url)) {
  const data = JSON.parse(await readFile(file, 'utf8'));
  if (data.version !== 1) throw new TypeError('Unsupported eval case version');
  validateCases(data.cases);
  return data.cases;
}

const round = n => Math.round(n * 100) / 100;
function annualSpending(db) {
  const rows = db.prepare(`SELECT t.date,t.amount,t.category,t.description FROM transactions t
    JOIN accounts a ON a.id=t.account_id WHERE a.kind='checking' ORDER BY t.date`).all();
  const months = new Set(rows.map(r => r.date.slice(0, 7))).size;
  if (!months) throw new TypeError('No spending coverage');
  const spend = rows.filter(r => r.amount < 0 && !['transfer', 'income', 'income_tax'].includes(r.category)
    && !/mortgage|income tax/i.test(r.description)).reduce((s, r) => s - r.amount, 0);
  return round(spend * 12 / months);
}
function netWorth(db, date) {
  return db.prepare(`SELECT coalesce(sum(b.amount),0) AS v FROM balances b WHERE b.date=(
    SELECT max(b2.date) FROM balances b2 WHERE b2.account_id=b.account_id AND b2.date<=?)`).get(date).v;
}
export function expectedFigures(db, descriptors) {
  return descriptors.map(e => {
    let v;
    if (e.kind === 'figure') v = db.prepare('SELECT v FROM figures WHERE key=? AND unavailable_reason IS NULL').get(e.key)?.v;
    if (e.kind === 'transaction') v = db.prepare('SELECT amount FROM transactions WHERE category=? ORDER BY date DESC,id DESC LIMIT 1').get(e.category)?.amount;
    if (e.kind === 'pnl-month') v = db.prepare('SELECT sum(amount) AS v FROM pnl_lines WHERE period=?').get(e.month).v;
    if (e.kind === 'annual-spending') v = annualSpending(db);
    if (e.kind === 'portfolio') v = round(annualSpending(db) / e.rate);
    if (e.kind === 'net-worth') v = netWorth(db, '9999-12-31');
    if (e.kind === 'net-worth-change') {
      const date = db.prepare('SELECT min(date) AS d FROM balances').get().d;
      v = netWorth(db, '9999-12-31') - netWorth(db, date);
    }
    if (e.kind === 'cash-flow') v = db.prepare(`SELECT coalesce(sum(t.amount),0) AS v FROM transactions t JOIN accounts a ON a.id=t.account_id
      WHERE a.kind='checking' AND substr(t.date,1,7)=? AND t.category!='transfer'`).get(e.month).v;
    if (!Number.isFinite(v)) throw new TypeError(`No deterministic expectation for ${e.kind}:${e.key ?? e.month ?? ''}`);
    return round(v);
  });
}
