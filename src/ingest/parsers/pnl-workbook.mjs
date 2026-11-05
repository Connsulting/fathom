import { readWorkbook, ledgerHeader } from '../workbook.mjs';
import { header, isoDate, money, cents, warning, result, empty, LimitError } from '../format.mjs';

export const id = 'pnl-workbook';
export const label = 'Business profit and loss';
export const sourceKind = 'pnl_workbook';
export function sniff(file) {
  try { return readWorkbook(file).sheets.some((sheet) => ledgerHeader(sheet)) ? 0.98 : 0; } catch (e) { if (e instanceof LimitError) throw e; return 0; }
}

// The entity a ledger sheet belongs to: its name without a trailing Income or Expenses label
// (including Actual) and surrounding punctuation.
export function entityOf(sheetName) {
  return String(sheetName ?? '')
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '')
    .replace(/[\s\p{P}]+(?:actual[\s\p{P}]+)?(?:income|expenses?)$/iu, '')
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '');
}

export function parse(file) {
  try {
    const workbook = readWorkbook(file), monthly = new Map(), warnings = [];
    for (const sheet of workbook.sheets) {
      const found = ledgerHeader(sheet);
      if (!found) continue;
      const { columns } = found;
      const income = columns.has('payment date');
      const dateColumn = columns.get(income ? 'payment date' : 'date');
      const amountColumn = columns.get(income ? 'payment amount' : 'amount') ?? columns.get([...columns.keys()].find((key) => key.endsWith('actual income')));
      const entity = entityOf(sheet.name);
      for (const row of sheet.rows.slice(found.index + 1)) {
        const dateCell = row.cells.get(dateColumn), amountCell = row.cells.get(amountColumn);
        if (!dateCell?.value && !amountCell?.value && !amountCell?.missingCache) continue;
        const locator = { sheet: sheet.name, cell: amountCell?.address ?? `${amountColumn}${row.number}` };
        if (amountCell?.missingCache) { warning(warnings, 'formula_without_cache', locator); continue; }
        const date = isoDate(dateCell?.value, workbook.date1904), amount = money(amountCell?.value);
        const category = income ? 'Income' : String(row.cells.get(columns.get('category'))?.value ?? '').trim();
        if (!date || amount === null || !category || amountCell?.error || dateCell?.error) { warning(warnings, 'invalid_pnl_row', locator); continue; }
        if (!income && /^(income|transfer|credit card payment|loan payment)s?$/i.test(category)) continue;
        const ignored = header(row.cells.get(columns.get('ignored from'))?.value);
        if (/^(everything|all)$/.test(ignored)) continue;
        const period = date.slice(0, 7), key = JSON.stringify([entity, period, category]);
        if (!monthly.has(key)) monthly.set(key, { kind: 'pnl_line', entity, period, category, amount: 0, locator: { sheet: sheet.name, cells: [] } });
        const output = monthly.get(key);
        output.amount = cents(output.amount + (income ? amount : -amount));
        output.locator.cells.push(locator.cell);
      }
    }
    return monthly.size ? result([...monthly.values()], warnings) : { ...empty('no_pnl_rows'), warnings: [...warnings, ...empty('no_pnl_rows').warnings] };
  } catch (e) {
    if (e instanceof LimitError) throw e;
    return empty('malformed_workbook');
  }
}
