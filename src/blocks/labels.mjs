import { headers } from '../tools/tools.mjs';
import { at, isFigure } from './paths.mjs';

export const NUMBER_WORDS = Object.freeze(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty',
  'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand', 'million', 'billion', 'half', 'quarter', 'dozen', 'percent', 'double', 'triple']);
const NUMBER = new RegExp(`(?<!\\p{L})(?:${NUMBER_WORDS.join('|')})(?!\\p{L})`, 'iu');
export const validTitle = title => typeof title === 'string' && title.trim().length > 0 && title.length <= 80 &&
  !/[\p{N}\p{Sc}%<>]/u.test(title) && !NUMBER.test(title);
export const FIELD_LABEL = Object.freeze({ total: 'Total', net: 'Net', inflow: 'Money in', outflow: 'Money out', annualCost: 'Per year',
  typicalAmount: 'Typical charge', figure: 'Amount', amount: 'Amount', date: 'Date', description: 'Description', category: 'Category', merchant: 'Merchant', cadence: 'How often' });
export const sourceLabel = ref => headers.find(t => t.name === ref.tool)?.source || 'Tool results';
export const fieldLabel = (ref, field) => FIELD_LABEL[field.split('.').at(-1)] || sourceLabel(ref);
function strings(value) {
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}
export function figureLabel(fig, ref, field) {
  const label = fig.label;
  return typeof label === 'string' && label.trim() && !strings(ref.args).some(s => label.toLowerCase().includes(s.toLowerCase())) ? label : fieldLabel(ref, field);
}
export function columnLabel(items, ref, field) {
  const figures = items.map(item => at(item, field));
  if (figures.length && figures.every(isFigure)) {
    const labels = figures.map(f => figureLabel(f, ref, field));
    if (labels.every(label => label === labels[0])) return labels[0];
  }
  return fieldLabel(ref, field);
}
export function dateText(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}$/.test(value)) {
    const d = new Date(`${value}-01T00:00:00Z`);
    if (Number.isFinite(d.getTime())) return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  return String(value);
}
export function itemLabel(item, ref) {
  for (const key of ['label', 'key', 'month', 'year', 'merchant']) {
    if (typeof item?.[key] === 'string') return key === 'month' || key === 'year' ? dateText(item[key]) : item[key];
  }
  return sourceLabel(ref);
}
