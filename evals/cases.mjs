import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import { isoFromLabel } from '../demo/ledger.mjs';
import { classOf } from '../src/calc/classes.mjs';

const predicate = { type: 'object', additionalProperties: false, required: ['path', 'op'], properties: {
  path: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_.]*$' },
  op: { enum: ['eq', 'includes', 'includes_or_absent', 'gte', 'lte', 'exists', 'matches'] }, value: {},
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
    requires: { type: 'object', additionalProperties: false, properties: {
      operations: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$' } },
      script: { type: 'boolean' },
      capabilities: { type: 'array', uniqueItems: true, items: { enum: ['ownerStatements', 'definitions', 'businessPeriods'] } },
    } },
    expectedFail: { type: 'object', additionalProperties: false, required: ['missingOperations'], properties: {
      missingOperations: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 3 } },
      missingScript: { type: 'string' },
      missingCapabilities: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
    } },
    turns: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
      required: ['question', 'required', 'forbidden', 'expected', 'maxWords', 'rubric'], properties: {
        question: { type: 'string', minLength: 1, maxLength: 4000 },
        required: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'operation', 'predicates'], properties: {
          name: { type: 'string', pattern: '^[a-z][a-z0-9_]+$' }, operation: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' }, predicates: { type: 'array', items: predicate },
        } } },
        forbidden: { type: 'array', minItems: 2, maxItems: 3, uniqueItems: true, items: { enum: ['unsourced-figure', 'self-computed-figure', 'owner-assumption-not-in-messages'] } },
        expected: { type: 'array', items: expected }, maxWords: { type: 'integer', minimum: 1, maximum: 1000 },
        rubric: { type: 'string', minLength: 1 }, refusal: { type: 'boolean' },
        prohibit: { type: 'array', items: predicate },
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
        if (p.op === 'matches' && typeof p.value !== 'string') throw new TypeError('Match predicate needs a pattern');
      }
      const forbidden = new Set(turn.forbidden);
      if (!forbidden.has('unsourced-figure') || !forbidden.has('self-computed-figure')) throw new TypeError('Forbidden behavior is incomplete');
      for (const e of turn.expected) {
        if (e.kind === 'figure' && !e.key) throw new TypeError('Figure expectation needs a key');
        if (e.kind === 'transaction' && !e.category) throw new TypeError('Transaction expectation needs a category');
        if (['pnl-month', 'cash-flow'].includes(e.kind) && !e.month) throw new TypeError('Monthly expectation needs a month');
        if (e.kind === 'portfolio' && !e.rate) throw new TypeError('Portfolio expectation needs a rate');
      }
    }
    const req = caseRequirements(c);
    for (const pair of req.operations) {
      if (!c.turns.some(t => t.required.some(r => `${r.name}.${r.operation}` === pair))) throw new TypeError('Required operation must be a required call');
    }
    const missing = c.expectedFail;
    if (missing && !missing.missingOperations.length && !missing.missingCapabilities?.length && !missing.missingScript) throw new TypeError('Expected fail needs a missing requirement');
    for (const pair of missing?.missingOperations || []) if (!req.operations.includes(pair)) throw new TypeError('Missing operation must be a required call');
  }
  return true;
}
export function caseRequirements(c) {
  const fromTurns = [...new Set(c.turns.flatMap(t => t.required.map(r => `${r.name}.${r.operation}`)))];
  return { operations: c.requires?.operations ?? fromTurns, capabilities: c.requires?.capabilities ?? [], script: c.requires?.script === true };
}
export function applyAvailability(c, { hasOperation, capabilities, hasScript }) {
  const req = caseRequirements(c);
  const missingOperations = req.operations.filter(pair => !hasOperation(...pair.split('.')));
  const missingCapabilities = req.capabilities.filter(name => !capabilities.includes(name));
  const missingScript = req.script && !hasScript(c.id) ? `scripts/${c.id}.mjs` : null;
  const next = { ...c };
  delete next.expectedFail;
  if (missingOperations.length || missingCapabilities.length || missingScript) next.expectedFail = {
    missingOperations, ...(missingCapabilities.length ? { missingCapabilities } : {}), ...(missingScript ? { missingScript } : {}),
  };
  return next;
}
export async function loadCases(file = new URL('./catalog.json', import.meta.url), availability = null) {
  const data = JSON.parse(await readFile(file, 'utf8'));
  if (data.version !== 1) throw new TypeError('Unsupported eval case version');
  const { getTool, CAPABILITIES } = availability ? {} : await import('../src/tools/index.mjs');
  const probe = availability ?? { hasOperation: (name, operation) => Boolean(getTool(name)?.operations.some(o => o.name === operation)), capabilities: CAPABILITIES,
    hasScript: id => existsSync(new URL(`./scripts/${id}.mjs`, import.meta.url)) };
  const cases = data.cases.map(c => applyAvailability(c, probe));
  validateCases(cases);
  return cases;
}

const round = n => Math.round(n * 100) / 100;
function annualSpending(db) {
  const rows = db.prepare(`SELECT t.date,t.amount,t.category,t.description FROM transactions t
    JOIN accounts a ON a.id=t.account_id WHERE a.kind IN ('checking','credit','card') ORDER BY t.date`).all();
  const meta = JSON.parse(db.prepare("SELECT value FROM content WHERE key='meta'").get().value);
  const through = isoFromLabel(meta.dataThrough);
  if (!through) throw new TypeError('No spending coverage date');
  const date = new Date(through + 'T00:00:00Z');
  const days = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  const end = date.getUTCDate() === days ? through : through.slice(0, 7) + '-01';
  const covered = rows.filter(r => date.getUTCDate() === days ? r.date <= end : r.date < end);
  const months = new Set(covered.map(r => r.date.slice(0, 7))).size;
  if (!months) throw new TypeError('No spending coverage');
  const spend = covered.filter(r => r.amount < 0 && !['transfer', 'income'].includes(r.category)
    && classOf(r.category) !== 'taxes' && classOf(r.category) !== 'debt_service'
    ).reduce((s, r) => s - r.amount, 0);
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
    if (e.kind === 'portfolio') v = Math.ceil(annualSpending(db) / e.rate);
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
