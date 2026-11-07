// C3 calculate: the only arithmetic Ask gets. Every operation runs on refs to real household.figures
// and goals.pace figures over the demo store (plus named assumptions where the demo has no figure
// of that unit), and every expected value is recomputed here from the same figures.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../demo/seed.mjs';
import { callTool, getTool } from '../src/tools/index.mjs';
import { round, quoteFor } from '../src/calc/figure.mjs';
import { futureValue, requiredMonthly } from '../src/calc/growth.mjs';
import { groundAnswer } from '../src/api/answerer.mjs';
import { tempDb } from './helpers/server.mjs';
import { assertRefsResolve, envelopeEntries } from './helpers/figures.mjs';

const STATEMENTS = [
  'We spend about $1,330 a month on childcare and $15,900 a year on travel.',
  'Use a 4 percent return over 10 years.',
  'What investment balance would cover that at a 4 percent withdrawal rate?',
];

let t;
let ctx;
let value;
let pace;
before(async () => {
  t = await tempDb();
  seedDemo(t.db);
  t.db.prepare(`INSERT INTO figures (key, v, src, kind, label, locator, unavailable_reason, updated_at)
                VALUES ('test_stale', 0, NULL, 'a', 'Stale balance', NULL, 'stale_account', '2026-11-01T00:00:00Z')`).run();
  ctx = { db: t.db, dataDir: t.dataDir, now: new Date('2026-11-05T15:00:00Z'), ownerStatements: () => STATEMENTS };
  const figures = await callTool('household', { operation: 'figures' }, ctx);
  value = Object.fromEntries(figures.map(f => [f.key, f]));
  const paceResult = await callTool('goals', { operation: 'pace' }, ctx);
  pace = envelopeEntries(paceResult).map(({ path, figure }) => ({ path, figure }));
});
after(() => t && t.close());

const F = key => ({ ref: { tool: 'household', args: { operation: 'figures', keys: [key] }, path: '0' } });
const P = entry => ({ ref: { tool: 'goals', args: { operation: 'pace' }, path: entry.path } });
const owner = (name, v, unit, evidence) => ({ assumption: { name, value: v, unit, source: 'owner', evidence } });
const monthlyChildcare = () => owner('childcare', 1330, 'usd_per_month', '$1,330 a month');
const yearlyTravel = () => owner('travel', 15900, 'usd_per_year', '$15,900 a year');
const rate4 = () => owner('rate', 0.04, 'ratio', '4 percent');
const calc = (operation, operands, extra = {}, c = ctx) => callTool('calculate', { operation, operands, label: 'combined figure', ...extra }, c);
const v = key => value[key].value;
const paceUsd = sign => pace.find(e => e.figure.unit === 'usd' && Math.sign(e.figure.value) === sign && !Number.isInteger(e.figure.value));
const badInput = pattern => e => e.code === 'bad_input' && pattern.test(e.message);

describe('operations', () => {
  test('add, subtract, sum, min and max combine money figures in their unit', async () => {
    const pos = paceUsd(1);
    assert.ok(pos, 'the demo pace has a fractional positive money figure');
    const a = v('biz_cash'), b = v('personal_cash'), c = v('sp_cash');
    const checks = [
      ['add', [F('biz_cash'), F('personal_cash'), P(pos)], round(a + b + pos.figure.value)],
      ['subtract', [F('biz_cash'), F('personal_cash'), P(pos)], round(a - b - pos.figure.value)],
      ['sum', [F('biz_cash'), F('personal_cash'), F('sp_cash')], round(a + b + c)],
      ['sum', [{ ref: { tool: 'household', args: { operation: 'figures', keys: ['biz_cash', 'personal_cash', 'sp_cash'] }, path: '' } }], round(a + b + c)],
      ['min', [F('biz_cash'), F('personal_cash'), F('sp_cash')], Math.min(a, b, c)],
      ['max', [F('biz_cash'), F('personal_cash'), F('sp_cash')], Math.max(a, b, c)],
    ];
    for (const [operation, operands, expected] of checks) {
      const { figure } = await calc(operation, operands);
      assert.equal(figure.value, expected, operation);
      assert.equal(figure.unit, 'usd', operation);
      assert.equal(figure.quote, quoteFor(expected, 'usd'), operation);
    }
  });

  test('divide returns ratios unrounded, above 1 and below 0', async () => {
    const neg = paceUsd(-1);
    assert.ok(neg, 'the demo pace has a negative money figure');
    const above = (await calc('divide', [F('portfolio'), F('biz_cash')])).figure;
    assert.equal(above.unit, 'ratio');
    assert.equal(above.value, v('portfolio') / v('biz_cash'));
    assert.ok(above.value > 1);
    const below = (await calc('divide', [P(neg), F('biz_cash')])).figure;
    assert.equal(below.value, neg.figure.value / v('biz_cash'));
    assert.ok(below.value < 0);
    assert.equal(below.quote, quoteFor(below.value, 'ratio'));
  });

  test('multiply, divide and percent_of follow the unit algebra', async () => {
    const a = v('biz_cash'), b = v('personal_cash'), c = v('sp_cash');
    const share = { expr: { operation: 'divide', operands: [F('personal_cash'), F('biz_cash')] } };
    const cases = [
      ['multiply', [F('biz_cash'), share], round(a * (b / a)), 'usd'],
      ['divide', [F('biz_cash'), share], round(a / (b / a)), 'usd'],
      ['percent_of', [share, F('sp_cash')], round((b / a) * c), 'usd'],
      ['divide', [yearlyTravel(), rate4()], round(15900 / 0.04), 'usd'],
      ['divide', [F('biz_cash'), monthlyChildcare()], Math.ceil(a / 1330), 'months'],
      ['multiply', [{ expr: { operation: 'divide', operands: [F('biz_cash'), monthlyChildcare()] } }, monthlyChildcare()], round((a / 1330) * 1330), 'usd'],
    ];
    for (const [operation, operands, expected, unit] of cases) {
      const { figure } = await calc(operation, operands);
      assert.equal(figure.unit, unit, `${operation} unit`);
      assert.equal(figure.value, expected, `${operation} ${unit}`);
    }
  });

  test('negate quotes the result unsigned with direction out', async () => {
    const { figure } = await calc('negate', [F('biz_cash')]);
    assert.equal(figure.value, -v('biz_cash'));
    assert.equal(figure.quote, quoteFor(v('biz_cash'), 'usd'));
    assert.equal(figure.direction, 'out');
  });

  test('annualize and monthly convert per-month and per-year money, and chain through a ref', async () => {
    const yearly = await calc('annualize', [monthlyChildcare()]);
    assert.equal(yearly.figure.unit, 'usd_per_year');
    assert.equal(yearly.figure.value, round(1330 * 12));
    const back = await calc('monthly', [{ ref: yearly.figure.ref }]);
    assert.equal(back.figure.unit, 'usd_per_month');
    assert.equal(back.figure.value, round(yearly.figure.value / 12));
    assert.equal(back.figure.provenance.inputs[0].value, yearly.figure.value);
    const travel = await calc('monthly', [yearlyTravel()]);
    assert.equal(travel.figure.value, round(15900 / 12));
  });

  test('round_up rounds up to 1, 100 or 1000', async () => {
    const pos = paceUsd(1);
    for (const places of [1, 100, 1000]) {
      const { figure } = await calc('round_up', [P(pos)], { places });
      assert.equal(figure.value, Math.ceil(pos.figure.value / places) * places, `places ${places}`);
      assert.equal(figure.unit, 'usd');
    }
  });

  test('compound gives the future value at a yearly rate compounded monthly', async () => {
    const p = v('portfolio');
    const { figure } = await calc('compound', [F('portfolio')], { rate: rate4(), years: owner('years', 10, 'years', '10 years') });
    assert.equal(figure.unit, 'usd');
    assert.equal(figure.value, round(p * Math.pow(1 + 0.04 / 12, 120)));
    assert.deepEqual(figure.provenance.assumptions.map(x => [x.name, x.stated, x.source]), [['rate', '4%', 'owner'], ['years', '10 years', 'owner']]);
  });

  test('growth helpers solve the balance-plus-annuity future value both ways', () => {
    const r = 0.06 / 12;
    assert.equal(futureValue({ balance: 1000, monthly: 100, annualRate: 0.06, months: 12 }), 1000 * (1 + r) ** 12 + 100 * (((1 + r) ** 12 - 1) / r));
    assert.equal(futureValue({ balance: 1000, monthly: 100, annualRate: 0, months: 12 }), 2200);
    const needed = requiredMonthly({ target: 50000, balance: 1000, annualRate: 0.06, months: 60 });
    assert.ok(Math.abs(futureValue({ balance: 1000, monthly: needed, annualRate: 0.06, months: 60 }) - 50000) < 1e-6);
    assert.equal(requiredMonthly({ target: 2200, balance: 1000, annualRate: 0, months: 12 }), 100);
    assert.equal(requiredMonthly({ target: 500, balance: 1000, annualRate: 0.06, months: 12 }), 0, 'already reached');
  });
});

describe('figure contract', () => {
  test('kind is the weakest input, asOf the oldest, provenance chains every input', async () => {
    const { figure } = await calc('add', [F('biz_cash'), F('sp_cash')]);
    assert.equal(figure.kind, 'e');
    assert.equal(figure.asOf, value.biz_cash.asOf);
    assert.deepEqual(figure.provenance.inputs.map(i => i.ref), [F('biz_cash').ref, F('sp_cash').ref]);
    assert.deepEqual(figure.provenance.inputs.map(i => i.provenance), [value.biz_cash.provenance, value.sp_cash.provenance]);
    assert.equal(figure.provenance.calc, 'calculate');
    assert.match(figure.provenance.formula, /plus/);
    assert.deepEqual(figure.ref, { tool: 'calculate', args: { operation: 'add', operands: [F('biz_cash'), F('sp_cash')], label: 'combined figure' }, path: 'figure' });
    assert.equal(figure.label, 'combined figure');
    const target = pace.find(e => e.figure.kind === 't');
    assert.equal((await calc('add', [F('biz_cash'), P(target)])).figure.kind, 't');
    assert.equal((await calc('annualize', [monthlyChildcare()])).figure.kind, 'm', 'an assumption is a modeled input');
  });

  test('an unavailable input makes the result unavailable and carries its gap', async () => {
    const { figure } = await calc('add', [F('biz_cash'), F('test_stale')]);
    assert.equal(figure.value, null);
    assert.equal(figure.unavailable, 'stale_account');
    assert.ok(figure.gaps.some(g => g.code === 'stale_account'));
    assert.equal(figure.quote, null);
  });

  test('calculate results and chained refs resolve', async () => {
    const result = await calc('subtract', [{ expr: { operation: 'sum', operands: [F('biz_cash'), F('personal_cash')] } }, F('sp_cash')]);
    // The result and every input figure in its provenance resolve.
    assert.ok(await assertRefsResolve(result, ctx) >= 4);
    const chained = await calc('round_up', [{ ref: result.figure.ref }], { places: 100 });
    assert.ok(await assertRefsResolve(chained, ctx) >= 5);
    assert.equal(getTool('calculate').operations.every(o => o.referenceable), true);
  });
});

describe('refusals', () => {
  test('unit mismatches name both units', async () => {
    await assert.rejects(calc('add', [F('biz_cash'), rate4()]), badInput(/usd/));
    await assert.rejects(calc('add', [F('biz_cash'), rate4()]), badInput(/ratio/));
    await assert.rejects(calc('multiply', [F('biz_cash'), F('personal_cash')]), badInput(/usd.*usd/));
    await assert.rejects(calc('annualize', [F('biz_cash')]), badInput(/usd_per_month/));
    await assert.rejects(calc('compound', [F('portfolio')], { rate: F('biz_cash'), years: owner('years', 10, 'years', '10 years') }), badInput(/rate.*ratio/));
  });

  test('division by zero is refused', async () => {
    await assert.rejects(calc('divide', [F('biz_cash'), { expr: { operation: 'subtract', operands: [F('personal_cash'), F('personal_cash')] } }]), badInput(/zero/));
  });

  test('more than 20 operands and expression depth over 6 are refused', async () => {
    const many = Array.from({ length: 21 }, () => F('biz_cash'));
    await assert.rejects(calc('sum', many), badInput(/operands/));
    await assert.rejects(calc('sum', [{ expr: { operation: 'sum', operands: many } }]), badInput(/20 operands/));
    const nest = depth => depth === 1 ? F('biz_cash') : { expr: { operation: 'sum', operands: [nest(depth - 1)] } };
    // The top call is depth 1; five nested expressions make depth 6.
    assert.equal((await calc('sum', [nest(6)])).figure.value, v('biz_cash'));
    await assert.rejects(calc('sum', [nest(7)]), badInput(/depth/));
  });

  test('ref nesting deeper than 3 is refused', async () => {
    const wrap = (inner, n) => ({ ref: { tool: 'calculate', args: { operation: 'sum', operands: [inner], label: 'wrapped figure' }, path: 'figure' } });
    const chain = n => n === 0 ? F('biz_cash') : wrap(chain(n - 1), n);
    assert.equal((await calc('sum', [chain(2)])).figure.value, v('biz_cash'), 'three refs deep resolves');
    await assert.rejects(calc('sum', [chain(3)]), badInput(/ref depth|nesting/));
  });

  test('refs to write tools, non-referenceable operations, unknown tools and non-figure paths are refused', async () => {
    await assert.rejects(calc('sum', [{ ref: { tool: 'update_goal', args: { operation: 'create' }, path: '0' } }]), badInput(/write/));
    await assert.rejects(calc('sum', [{ ref: { tool: 'goals', args: { operation: 'list' }, path: '0' } }]), badInput(/referenceable/));
    await assert.rejects(calc('sum', [{ ref: { tool: 'nope', args: { operation: 'list' }, path: '0' } }]), badInput(/nope/));
    await assert.rejects(calc('sum', [{ ref: { tool: 'household', args: { operation: 'figures', keys: ['biz_cash'] }, path: '0.key' } }]), badInput(/not a figure/));
    await assert.rejects(calc('sum', [{ ref: { tool: 'household', args: { operation: 'figures', keys: ['biz_cash'] } } }]), badInput(/path/));
    await assert.rejects(calc('add', [{ ref: { tool: 'household', args: { operation: 'figures', keys: ['biz_cash', 'sp_cash'] }, path: '' } }, F('biz_cash')]), badInput(/list/));
  });

  test('bare numbers and malformed operands are refused naming the cause', async () => {
    await assert.rejects(calc('sum', [5, F('biz_cash')]), badInput(/operands\[0\] must be object/));
    await assert.rejects(calc('sum', [{ expr: { operation: 'sum', operands: [5] } }]), badInput(/bare number/));
    await assert.rejects(calc('sum', [{ value: 5 }]), badInput(/bare number/));
    await assert.rejects(calc('sum', [{ ...F('biz_cash'), ...rate4() }]), badInput(/exactly one/));
    await assert.rejects(calc('compound', [F('portfolio')], { rate: 0.04, years: owner('years', 10, 'years', '10 years') }), badInput(/rate/));
    await assert.rejects(calc('divide', [F('biz_cash')]), badInput(/divide/));
    await assert.rejects(calc('round_up', [F('biz_cash')], { places: 10 }), badInput(/places/));
    await assert.rejects(calc('add', [F('biz_cash'), F('sp_cash')], { label: 'total 2026' }), badInput(/label/));
    await assert.rejects(calc('add', [F('biz_cash'), F('sp_cash')], { places: 100 }), badInput(/places/));
  });

  test('fact, default and owner assumptions are checked', async () => {
    const agi = JSON.parse(t.db.prepare("SELECT value FROM facts WHERE key = 'income.agiEstimate'").get().value);
    const fact = x => ({ assumption: { name: 'income', value: x, unit: 'usd', source: 'fact', factKey: 'income.agiEstimate' } });
    assert.equal((await calc('add', [F('biz_cash'), fact(agi)])).figure.value, round(v('biz_cash') + agi));
    await assert.rejects(calc('add', [F('biz_cash'), fact(agi + 1)]), badInput(/income\.agiEstimate/));
    await assert.rejects(calc('add', [F('biz_cash'), { assumption: { name: 'income', value: 1, unit: 'usd', source: 'default' } }]), badInput(/default/));
    await assert.rejects(calc('add', [F('biz_cash'), { assumption: { name: 'income', value: 1330, unit: 'usd', source: 'owner' } }]), badInput(/evidence/));
    await assert.rejects(calc('divide', [yearlyTravel(), owner('rate', 0.05, 'ratio', '4 percent')]), badInput(/rate/));
    const noStatements = { ...ctx, ownerStatements: undefined };
    await assert.rejects(calc('divide', [yearlyTravel(), rate4()], {}, noStatements), badInput(/owner/));
    const mcp = { db: t.db, dataDir: t.dataDir, now: ctx.now, channel: 'mcp' };
    assert.equal((await calc('divide', [yearlyTravel(), rate4()], {}, mcp)).figure.value, round(15900 / 0.04));
  });
});

test('groundAnswer grounds the owner\'s "4 percent" and the calculate result\'s quote', async () => {
  const args = { operation: 'divide', operands: [yearlyTravel(), owner('withdrawalRate', 0.04, 'ratio', '4 percent withdrawal rate')], label: 'investment needed' };
  const result = await callTool('calculate', args, ctx);
  assert.equal(result.figure.provenance.assumptions[1].stated, '4%');
  const reply = `At a 4 percent withdrawal rate, the investment needed is ${result.figure.quote}.`;
  const grounded = groundAnswer(reply, { scenario: { fig: {} }, toolResults: [{ name: 'calculate', args, result }] });
  assert.deepEqual(grounded.violations, []);
  assert.deepEqual(grounded.literals.map(l => l.text), ['4 percent', result.figure.quote]);
  assert.ok(grounded.literals.every(l => l.source === getTool('calculate').source));
});


// Review round 1 regressions.
test('a chained ref feeds the referenced calculation unrounded', async () => {
  const mcp = { db: t.db, dataDir: t.dataDir, now: ctx.now, channel: 'mcp' };
  const dollar = owner('fee', 1, 'usd_per_year', '$1 a year');
  const monthly = await calc('monthly', [dollar], {}, mcp);
  assert.equal(monthly.figure.value, round(1 / 12));
  const back = await calc('annualize', [{ ref: monthly.figure.ref }], {}, mcp);
  const nested = await calc('annualize', [{ expr: { operation: 'monthly', operands: [dollar] } }], {}, mcp);
  assert.equal(nested.figure.value, 1);
  assert.equal(back.figure.value, 1, 'the ref matches the nested expression, not 0.08 times 12');
});

test('a result over 256 KB truncates its longest list and says so', async () => {
  const keys = Object.values(value).filter(f => f.unit === 'usd' && f.value !== null).map(f => f.key);
  assert.ok(keys.length >= 50);
  const list = { ref: { tool: 'household', args: { operation: 'figures', keys }, path: '' } };
  const operands = Array.from({ length: 20 }, () => list);
  const result = await calc('sum', operands);
  assert.equal(result.truncated, true);
  assert.ok(JSON.stringify(result).length <= 256 * 1024);
  const total = keys.reduce((s, k) => s + value[k].value, 0) * 20;
  assert.equal(result.figure.value, round(total), 'truncation never changes the figure');
  assert.ok(result.figure.provenance.inputs.length < keys.length * 20);
  const small = await calc('add', [F('biz_cash'), F('sp_cash')]);
  assert.equal(small.truncated, undefined);
});
