// Ages from birth years, shared by the server and the browser (served at /shared/ages.mjs). The
// household fact household.birthYears ({owner, spouse, dependents: [year, ...]}) is the one source
// of every age: the age 70 Virginia 529 rule, catch-up at 50, HSA catch-up at 55 and the required
// minimum distribution age. An age is the age reached by the end of the tax year. Pure: no store.

export const MIN_BIRTH_YEAR = 1900;
export const MAX_DEPENDENTS = 10;

const isYear = v => Number.isInteger(v) && v >= MIN_BIRTH_YEAR;

// who: 'owner', 'spouse' or {dependent: index}. null when the birth year is unknown.
export function ageAtYearEnd(birthYears, who, year) {
  if (!birthYears || typeof birthYears !== 'object' || !Number.isInteger(year)) return null;
  const born = typeof who === 'object' && who !== null
    ? (Array.isArray(birthYears.dependents) ? birthYears.dependents[who.dependent] : undefined)
    : birthYears[who];
  return isYear(born) && born <= year ? year - born : null;
}

// The age of the person who owns an account. An account with no known person ('owner' or 'spouse')
// takes the youngest adult, so a missing owner never grants an older-owner rule; every adult in the
// household (the spouse too when `married`) must have a birth year, else the age is unknown (null).
export function accountOwnerAge(birthYears, person, year, { married = false } = {}) {
  if (person === 'owner' || person === 'spouse') return ageAtYearEnd(birthYears, person, year);
  const ages = ['owner', ...(married ? ['spouse'] : [])].map(p => ageAtYearEnd(birthYears, p, year));
  return ages.length && ages.every(a => a !== null) ? Math.min(...ages) : null;
}
