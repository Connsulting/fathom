import { OBLIGATION_RULES } from './classes.mjs';

export function addMonths(date, months) {
  const d = new Date(`${date}T00:00:00Z`);
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(d.getUTCFullYear(), m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(d.getUTCFullYear(), m, Math.min(d.getUTCDate(), last))).toISOString().slice(0,10);
}

export function mortgagePayoff({ balance, rate, monthlyPayment, escrowMonthly }, clock, maxMonths) {
  const payment = monthlyPayment - escrowMonthly, r = rate / 12;
  if (![balance,rate,payment].every(Number.isFinite) || balance < 0 || r < 0 || payment <= balance * r) return null;
  const n = balance === 0 ? 0 : r === 0 ? balance / payment : -Math.log1p(-balance * r / payment) / Math.log1p(r);
  const months = Math.ceil(n - 1e-9);
  return Number.isFinite(months) && months <= maxMonths ? addMonths(clock,months) : null;
}

export function dependentChanges({ birthDates, ages, clock, kind }) {
  const rules = OBLIGATION_RULES[kind];
  return (birthDates ?? ages ?? []).flatMap((born,index) => {
    const precise = !!birthDates;
    const year = precise ? Number(born.slice(0,4)) : Number(clock.slice(0,4)) - born;
    if (kind === 'plan529') return [{ dependent:index,stage:'college',date:precise ? addMonths(born,rules.collegeAge*12) : `${year+rules.collegeAge}-12-31`,derivedFrom:precise ? 'birth_date' : 'pack_default',precise }];
    let school = year + rules.schoolEntryAge;
    if (precise && born.slice(5) > rules.schoolEntryMonthDay) school++;
    return [
      {dependent:index,stage:'school_age',date:`${school}-${precise ? rules.schoolEntryMonthDay : '12-31'}`,derivedFrom:precise ? 'birth_date' : 'pack_default',precise},
      {dependent:index,stage:'after_care_end',date:precise ? addMonths(born,rules.afterCareEndAge*12) : `${year+rules.afterCareEndAge}-12-31`,derivedFrom:precise ? 'birth_date' : 'pack_default',precise},
    ];
  }).sort((a,b)=>a.date.localeCompare(b.date) || a.dependent-b.dependent);
}
