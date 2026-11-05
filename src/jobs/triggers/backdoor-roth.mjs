// Backdoor Roth: income above the Roth phase-out, with the pro-rata status per person (R9, S9).

import { isTrue, mineOf, padTasks } from './common.mjs';

export const id = 'backdoor-roth';
export const domain = 'retirement';
export const trigger = 'goal';
export const packs = ['advanced-retirement'];
export const gate = isTrue('retirement.backdoorRothCandidate');
export const calcs = [];
export const needsYear = true;
export const kb = [{ pack: 'advanced-retirement', entry: 'backdoor-roth' }, { pack: 'advanced-retirement', entry: 'form-8606-pro-rata' }];

// In the tax year the window is the Dec 31 pro-rata snapshot; from Jan 1 to Apr 15 of the next
// year it is the IRA contribution deadline.
export function window(ctx) {
  if (Number(ctx.clock.slice(0, 4)) === ctx.year) return { close: `${ctx.year}-12-31`, label: 'Pro-rata snapshot Dec 31', hard: false };
  return { close: `${ctx.year + 1}-04-15`, label: 'IRA contribution deadline', hard: false };
}

export function evaluate(ctx) {
  if (ctx.info.blocked.length) return { blocked: ctx.info.blocked[0] };
  const ira = ctx.info.ira || {};
  const persons = ctx.info.persons || ['owner'];
  const noBalance = ira.noBalance || {};
  const people = persons.map(person => ({
    person,
    proRata: ira.unknownOwner ? 'unknown' : ira[person] ? 'blocked' : noBalance[person] ? 'noBalance' : 'clear',
  }));
  return {
    grounding: ['agi.est', 'ira.pretax.owner', 'ira.pretax.spouse', 'room.ira.household'],
    people,
    afterYear: Number(ctx.clock.slice(0, 4)) !== ctx.year,
  };
}

// Person phrasing that reads correctly for each person (verb agreement, possessives).
const PERSON = {
  owner: { clear: 'You can', have: 'You have', your: 'your', obj: 'you' },
  spouse: { clear: 'Your spouse can', have: 'Your spouse has', your: "your spouse's", obj: 'your spouse' },
};

export function build(ctx, hit) {
  const unknown = hit.people.some(p => p.proRata === 'unknown');
  const blocked = hit.people.filter(p => p.proRata === 'blocked');
  const noBalance = hit.people.filter(p => p.proRata === 'noBalance');
  return {
    title: 'Use a backdoor Roth contribution',
    effort: 'An afternoon',
    value: [{ cls: 'retire', text: 'Adds tax-free Roth savings above the income limit' }],
    mine: mineOf(ctx, hit.grounding),
    cross: blocked.length ? ['A pre-tax IRA balance makes part of any conversion taxable, so roll it into a workplace plan first if you can.'] : [],
    tasks: padTasks([
      ...(unknown ? ['Tell us whose IRA each traditional IRA account is'] : []),
      ...noBalance.map(p => `Confirm the current balance of ${PERSON[p.person].your} traditional, SEP and SIMPLE IRA accounts`),
      ...blocked.map(p => `Move ${PERSON[p.person].your} pre-tax IRA balance into a workplace plan before converting`),
      'Make a nondeductible traditional IRA contribution',
      'Convert it to Roth once it settles',
      'File Form 8606 with the return',
    ]),
  };
}

export function template(ctx, hit) {
  const status = hit.people.map(p => {
    const w = PERSON[p.person];
    if (p.proRata === 'clear') return `${w.clear} convert without a pro-rata tax.`;
    if (p.proRata === 'blocked') return `${w.have} a pre-tax IRA balance, so a conversion would be partly taxable.`;
    if (p.proRata === 'noBalance') return `We do not have a current balance for ${w.your} pre-tax IRA, so we cannot check the pro-rata rule for ${w.obj} yet.`;
    return `We need to know whose IRA accounts are whose before we can check the pro-rata rule for ${w.obj}.`;
  });
  return {
    summary: ctx.fig['agi.est']
      ? 'Your estimated income of {f:agi.est} is above the Roth IRA limit, so direct Roth contributions are out, but a backdoor contribution still works.'
      : 'Your estimated income is above the Roth IRA limit, so direct Roth contributions are out, but a backdoor contribution still works.',
    why: [status.join(' '), hit.afterYear
      ? 'A conversion made now is measured against the IRA balances on Dec 31 of the year you convert, not last year.'
      : 'The pro-rata rule looks at every pre-tax IRA balance on Dec 31, so clear those first.'],
    qa: [{ q: 'What is the pro-rata rule?', a: ['When you convert, the taxable share is the pre-tax part of all your traditional, SEP and SIMPLE IRA balances at year end, not just the account you converted.'] }],
  };
}
