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
// takes the youngest known adult, so a missing owner never grants an older-owner rule. null when the
// person, or every adult, has no birth year.
export function accountOwnerAge(birthYears, person, year) {
  if (person === 'owner' || person === 'spouse') return ageAtYearEnd(birthYears, person, year);
  const ages = ['owner', 'spouse'].map(p => ageAtYearEnd(birthYears, p, year)).filter(a => a !== null);
  return ages.length ? Math.min(...ages) : null;
}
