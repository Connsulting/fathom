import { readWorkbook, taxHeader } from '../workbook.mjs';
import { money, monthEnd, header, warning, result, empty, LimitError } from '../format.mjs';

export const id = 'tax-payments';
export const label = 'Estimated tax payments';
export const sourceKind = 'tax_payments';
const SUMMARY = /total|sum|required|safe harbor|ytd|year to date|annual/i;
export function sniff(file) {
  try { return readWorkbook(file).sheets.some((sheet) => taxHeader(sheet)) ? 0.99 : 0; } catch (e) { if (e instanceof LimitError) throw e; return 0; }
}

export function parse(file) {
  try {
    const { sheets } = readWorkbook(file), rows = [], warnings = [];
    const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    for (const sheet of sheets) {
      const found = taxHeader(sheet);
      if (!found) continue;
      const monthCol = found.columns.get('month');
      const paidCols = [...sheet.rows[found.index].cells].filter(([, cell]) => /\bpaid$/.test(header(cell.value)));
      for (const row of sheet.rows.slice(found.index + 1)) {
        const monthCell = row.cells.get(monthCol);
        const populated = () => paidCols.some(([column]) => { const cell = row.cells.get(column); return cell && (cell.value !== '' || cell.missingCache); });
        const unreadable = monthCell && (monthCell.missingCache || monthCell.error);
        const month = unreadable ? 0 : months.indexOf(header(monthCell?.value)) + 1;
        if (!month) {
          // A populated row whose month cannot be read hides payments; warn so callers treat the
          // sheet as incomplete. Summary rows (totals, required amounts) stay silent.
          if (populated() && (unreadable || !SUMMARY.test(String(monthCell?.value ?? '')))) {
            warning(warnings, 'invalid_tax_month', { sheet: sheet.name, cell: monthCell?.address ?? `${monthCol}${row.number}` });
          }
          continue;
        }
        for (const [column] of paidCols) {
          const cell = row.cells.get(column);
          if (!cell || cell.value === '' && !cell.missingCache) continue;
          const locator = { sheet: sheet.name, cell: cell.address };
          if (cell.missingCache) { warning(warnings, 'formula_without_cache', locator); continue; }
          const amount = money(cell.value);
          if (amount === null || cell.error) { warning(warnings, 'invalid_tax_payment', locator); continue; }
          if (amount === 0) continue;
          const group = found.groups.filter((item) => columnOrder(item.column) <= columnOrder(column)).at(-1);
          if (!group) { warning(warnings, 'missing_jurisdiction', locator); continue; }
          const date = monthEnd(`${sheet.name}-${String(month).padStart(2, '0')}`);
          if (!date) { warning(warnings, 'invalid_tax_payment', locator); continue; }
          const payer = String(sheet.rows[found.index].cells.get(column).value).trim().replace(/\s+paid$/i, '');
          rows.push({ kind: 'tax_payment', jurisdiction: group.jurisdiction, sheetYear: Number(sheet.name), taxYear: Number(sheet.name), taxYearBasis: 'sheet_label', date, datePrecision: 'month', dateBasis: 'sheet_label', amount, paymentKind: 'paid', payer, locator });
          warning(warnings, 'month_precision', locator);
          warning(warnings, 'tax_year_assumed', locator);
        }
      }
    }
    return result(rows, warnings);
  } catch (e) {
    if (e instanceof LimitError) throw e;
    return empty('malformed_workbook');
  }
}

function columnOrder(column) {
  return [...column].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);
}
