// Growth of a balance plus a monthly contribution, compounded monthly at a yearly rate (the
// monthly rate is annualRate / 12, as monthsToReach in src/calc/targets.mjs uses). Values stay
// unrounded; the figure that reports them rounds once (src/calc/figure.mjs).

const monthlyRate = annualRate => annualRate / 12;

// Future value after `months`: B (1 + r)^n + C ((1 + r)^n - 1) / r, or B + C n at a zero rate.
export function futureValue({ balance, monthly = 0, annualRate, months }) {
  const r = monthlyRate(annualRate);
  if (r === 0) return balance + monthly * months;
  const growth = (1 + r) ** months;
  return balance * growth + monthly * ((growth - 1) / r);
}

// The monthly contribution that grows `balance` to `target` in `months`:
// C = (T - B (1 + r)^n) r / ((1 + r)^n - 1), or (T - B) / n at a zero rate. Zero when the balance
// alone reaches the target.
export function requiredMonthly({ target, balance, annualRate, months }) {
  if (!(months > 0)) throw new RangeError('requiredMonthly needs at least one month');
  const r = monthlyRate(annualRate);
  const grown = r === 0 ? balance : balance * (1 + r) ** months;
  if (grown >= target) return 0;
  if (r === 0) return (target - balance) / months;
  return (target - grown) * r / ((1 + r) ** months - 1);
}
