import { fromStored } from '../../calc/figure.mjs';
import { buildScenario, tokenScope } from '../../scenario/build.mjs';
import { notBuiltReason } from '../../jobs/planner/wargame.mjs';
import { clockOf, plainDeep } from './figures.mjs';

const SALARY = { salary: 'salary', payroll: 'payroll', distributions: 'dist', tax: 'tax', room: 'x', taxChange: 'y' };
const DEFERRAL = { amount: 'amount', net: 'net', decemberCash: 'decCash', payrollNeed: 'need', gap: 'gap' };

export const operations = [{
  tool: 'recommendations', name: 'wargame',
  summary: 'Stored salary or invoice-deferral options, with model figures and decision status.',
  route: 'Compare salary or invoice-deferral options', routes: [],
  params: { name: { type: 'string', enum: ['salary', 'deferral'] } }, required: ['name'],
  scope: 'read', referenceable: true,
  handler({ name }, ctx) {
    const scenario = buildScenario(ctx.db, { clock: clockOf(ctx) });
    const scope = tokenScope(ctx.db);
    const game = scenario.wargame[name];
    const decision = scenario.decisions.find(d => d.wargame === name && d.status === game?.status) || scenario.decisions.find(d => d.wargame === name);
    const rows = ctx.db.prepare(`SELECT f.*, s.as_of AS src_as_of FROM figures f
      LEFT JOIN sources s ON s.id = f.src WHERE f.key LIKE ?`).all(`wg.${name}.%`);
    const stored = new Map(rows.map(row => [row.key, row]));
    const args = { operation: 'wargame', name };
    const figure = (key, path) => {
      const row = stored.get(key) || { key, v: null, kind: 'm', src: 'wargame-model',
        label: path.split('.').at(-1), unavailable_reason: 'The stored figure is missing. Run planning to build it.' };
      return fromStored({ ...row, label: plainDeep(scope, row.label) },
        { ref: { tool: 'recommendations', args, path } });
    };
    const out = { name, title: plainDeep(scope, game?.title || (name === 'salary' ? 'Salary war game' : 'Invoice deferral war game')),
      question: plainDeep(scope, game?.question || ''), status: game?.status || 'not_built',
      decision: decision ? { id: decision.id, status: decision.status,
        ...(decision.line ? { decidedLine: plainDeep(scope, decision.line) } : {}) } : null,
      picked: null, asOf: null };
    if (!game) {
      out.notBuilt = scenario.wargame.notBuilt?.[name] || notBuiltReason(name, 'inputs_changed');
      return out;
    }
    const items = name === 'salary' ? game.points : game.options;
    out.picked = items?.[scenario.live.picks[name]]?.id || null;
    const fieldsFor = item => {
      if (name === 'salary') return { ...SALARY, ...(stored.has(`wg.salary.${item.id}.roth`) ? { rothRoom: 'roth' } : {}) };
      const years = [...new Set([
        ...rows.map(r => r.key.split('.').at(-1)),
        ...(items || []).flatMap(option => Object.keys(option)),
      ].filter(key => /^tax\d{4}$/.test(key)))].sort();
      return { ...DEFERRAL, taxThisYear: years[0] || 'taxThisYear', taxNextYear: years[1] || 'taxNextYear' };
    };
    const listKey = name === 'salary' ? 'points' : 'options';
    const mapped = (items || []).map((item, i) => {
      const result = { id: item.id, label: plainDeep(scope, item.label), note: plainDeep(scope, item.note || '') };
      if (name === 'salary') Object.assign(result, { current: !!item.current, frontier: !!item.frontier,
        ...(item.warn ? { warn: plainDeep(scope, item.warn) } : {}) });
      result.figures = Object.fromEntries(Object.entries(fieldsFor(item)).map(([field, suffix]) =>
        [field, figure(`wg.${name}.${item.id}.${suffix}`, `${name}.${listKey}.${i}.figures.${field}`)]));
      return result;
    });
    out[name] = name === 'salary'
      ? { xLabel: plainDeep(scope, game.xLabel), yLabel: plainDeep(scope, game.yLabel), points: mapped }
      : { monthlyInvoices: figure('wg.deferral.base.income', 'deferral.monthlyInvoices'), options: mapped };
    const dated = mapped.flatMap(item => Object.values(item.figures)).find(f => f.asOf);
    out.asOf = dated?.asOf || (name === 'deferral' ? out.deferral.monthlyInvoices.asOf : null);
    return out;
  },
}];
