import { readWorkbook, taxHeader } from '../workbook.mjs';
import { money, monthEnd, header, warning, result, empty } from '../format.mjs';

export const id = 'tax-payments';
export const label = 'Estimated tax payments';
export const sourceKind = 'tax_payments';
export function sniff(file) {
  try { return readWorkbook(file).sheets.some((sheet) => taxHeader(sheet)) ? 0.99 : 0; } catch { return 0; }
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
        const month = months.indexOf(header(row.cells.get(monthCol)?.value)) + 1;
        if (!month) continue;
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
  } catch { return empty('malformed_workbook'); }
}

function columnOrder(column) {
  return [...column].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);
}
