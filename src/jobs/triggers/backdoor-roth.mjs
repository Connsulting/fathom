// Backdoor Roth: income above the Roth phase-out, with the pro-rata status per person (R9, S9).

import { isTrue, mineOf, padTasks } from './common.mjs';
import { blockedFor } from '../../shared/rec-inputs.mjs';

export const id = 'backdoor-roth';
export const domain = 'retirement';
// Inputs the action reads (src/shared/rec-inputs.mjs): IRA room from the household tax run's AGI.
export const inputs = Object.freeze(['income', 'retirement', 'filing']);
// Goal kinds this rec serves (resolved to open goals at read time) and its default action owner.
export const goalKinds = Object.freeze(['retirement']);
export const owner = 'you';
// Whoever acts (room or after-tax basis): both people is Both, only the spouse is Spouse, else You.
export function ownerFor(ctx, hit) {
  const acting = new Set((hit && Array.isArray(hit.people) ? hit.people : []).filter(p => p.room || p.basis).map(p => p.person));
  if (acting.has('spouse')) return acting.has('owner') ? 'both' : 'spouse';
  return 'you';
}
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
  const held = blockedFor(ctx, { inputs });
  if (held) return { blocked: held };
  const ira = ctx.info.ira || {};
  const persons = ctx.info.persons || ['owner'];
  const noBalance = ira.noBalance || {};
  // MG8: one contribution limit per person, shared by traditional and Roth (IRC 219(b), 408A(c)(2)).
  // Contribution advice needs that person's room left; after-tax basis (Form 8606) converts apart.
  if (persons.some(p => !ctx.fig[`room.ira.${p}`])) return { blocked: 'ira_room_missing' };
  const basisFact = ctx.facts['retirement.iraBasis'];
  const basisOf = p => {
    const v = basisFact && typeof basisFact === 'object' ? basisFact[p] : null;
    return typeof v === 'number' && Number.isFinite(v) && v > 0;
  };
  const people = persons.map(person => ({
    person,
    proRata: ira.unknownOwner ? 'unknown' : ira[person] ? 'blocked' : noBalance[person] ? 'noBalance' : 'clear',
    room: ctx.fig[`room.ira.${person}`].v > 0,
    basis: basisOf(person),
  }));
  if (!people.some(p => p.room || p.basis)) return null;
  return {
    grounding: ['agi.est', 'room.ira.owner', 'room.ira.spouse', 'ira.pretax.owner', 'ira.pretax.spouse', 'room.ira.household'],
    people,
    afterYear: Number(ctx.clock.slice(0, 4)) !== ctx.year,
  };
}

// Person phrasing that reads correctly for each person (verb agreement, possessives).
const PERSON = {
  owner: { clear: 'You can', have: 'You have', your: 'your', obj: 'you', Your: 'Your' },
  spouse: { clear: 'Your spouse can', have: 'Your spouse has', your: "your spouse's", obj: 'your spouse', Your: "Your spouse's" },
};

const anyRoom = hit => hit.people.some(p => p.room);
// Pro-rata status matters only for someone who will convert: room to contribute, or basis.
const acting = hit => hit.people.filter(p => p.room || p.basis);

export function build(ctx, hit) {
  const people = acting(hit);
  const unknown = people.some(p => p.proRata === 'unknown');
  const blocked = people.filter(p => p.proRata === 'blocked');
  const noBalance = people.filter(p => p.proRata === 'noBalance');
  const withRoom = people.filter(p => p.room);
  const basisOnly = people.filter(p => !p.room && p.basis);
  return {
    title: anyRoom(hit) ? 'Use a backdoor Roth contribution' : 'Convert your after-tax IRA basis to Roth',
    effort: 'An afternoon',
    value: [{ cls: 'retire', text: anyRoom(hit) ? 'Adds tax-free Roth savings above the income limit' : 'Moves after-tax IRA savings into Roth' }],
    mine: mineOf(ctx, hit.grounding),
    cross: blocked.length ? ['A pre-tax IRA balance makes part of any conversion taxable, so roll it into a workplace plan first if you can.'] : [],
    tasks: padTasks([
      ...withRoom.map(p => `Make a nondeductible traditional IRA contribution for ${PERSON[p.person].obj}`),
      ...basisOnly.map(p => `Convert ${PERSON[p.person].your} existing after-tax IRA basis to Roth, with the pro-rata rule in mind`),
      // Verifiable: each clears once the planner no longer finds the gap (rec-steps.mjs).
      ...(unknown ? [{ t: 'Tell us whose IRA each traditional IRA account is', kind: 'answer', code: 'ira_owner_unknown', link: 'accounts' }] : []),
      ...noBalance.map(p => ({ t: `Confirm the current balance of ${PERSON[p.person].your} traditional, SEP and SIMPLE IRA accounts`, kind: 'upload', code: `ira_balance_missing:${p.person}`, noun: 'a current IRA balance', link: 'upload' })),
      ...blocked.map(p => `Move ${PERSON[p.person].your} pre-tax IRA balance into a workplace plan before converting`),
      ...(withRoom.length ? ['Convert it to Roth once it settles'] : []),
      'File Form 8606 with the return',
    ]),
  };
}

export function template(ctx, hit) {
  const status = acting(hit).map(p => {
    const w = PERSON[p.person];
    if (p.proRata === 'clear') return `${w.clear} convert without a pro-rata tax.`;
    if (p.proRata === 'blocked') return `${w.have} a pre-tax IRA balance, so a conversion would be partly taxable.`;
    if (p.proRata === 'noBalance') return `We do not have a current balance for ${w.your} pre-tax IRA, so we cannot check the pro-rata rule for ${w.obj} yet.`;
    return `We need to know whose IRA accounts are whose before we can check the pro-rata rule for ${w.obj}.`;
  });
  const income = ctx.fig['agi.est'] ? 'Your estimated income of {f:agi.est}' : 'Your estimated income';
  const summary = anyRoom(hit)
    ? `${income} is above the Roth IRA limit, so direct Roth contributions are out, but a backdoor contribution still works.`
    : `${income} is above the Roth IRA limit. You have no IRA contribution room left this year, but after-tax basis already in a traditional IRA can still be converted.`;
  // Room is cited per person, and only where it is positive.
  const room = hit.people.filter(p => p.room).map(p => `${PERSON[p.person].Your} IRA contribution room left this year is {f:room.ira.${p.person}}.`);
  return {
    summary,
    why: [status.join(' '), ...room, hit.afterYear
      ? 'A conversion made now is measured against the IRA balances on Dec 31 of the year you convert, not last year.'
      : 'The pro-rata rule looks at every pre-tax IRA balance on Dec 31, so clear those first.'],
    qa: [{ q: 'What is the pro-rata rule?', a: ['When you convert, the taxable share is the pre-tax part of all your traditional, SEP and SIMPLE IRA balances at year end, not just the account you converted.'] }],
  };
}
