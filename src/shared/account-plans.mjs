export const PLAN_LABELS = Object.freeze({
  traditional_ira: 'Traditional IRA', roth_ira: 'Roth IRA', sep_ira: 'SEP IRA',
  '401k': 'Workplace 401(k)', roth_401k: 'Roth 401(k)', solo_401k: 'Solo 401(k)',
  '403b': 'Workplace 403(b)', '457b': 'Workplace 457(b)', hsa: 'Health savings account',
  '529': 'College savings plan', taxable: 'Taxable investments',
});

export function inferPlanType(account) {
  if (!['retirement', 'roth', 'ira', 'taxable', 'brokerage'].includes(account.kind)) return null;
  const name = `${account.name || ''} ${account.inst || ''}`.toLowerCase();
  const k = /\b401\s*\(?k\)?/.test(name);
  if (k) return /\broth\b/.test(name) ? 'roth_401k' : /\b(solo|individual|self[- ]employed)\b/.test(name) ? 'solo_401k' : '401k';
  if (/\bsep[ -]*ira\b/.test(name)) return 'sep_ira';
  if (/\broth[ -]*ira\b/.test(name)) return 'roth_ira';
  if (/\b(traditional|rollover)[ -]*ira\b/.test(name)) return 'traditional_ira';
  if (/\b403\s*\(?b\)?/.test(name)) return '403b';
  if (/\b457\s*\(?b\)?/.test(name)) return '457b';
  return null;
}

