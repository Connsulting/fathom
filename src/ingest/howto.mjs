// Generic export instructions per supported format. No institution or product names: the steps
// describe what to look for in any provider's site.

const entry = (id, title, cadence, sourceKinds, steps) => Object.freeze({
  id, title, steps: Object.freeze(steps), cadence, sourceKinds: Object.freeze(sourceKinds),
});

export const HOWTO = Object.freeze({
  aggregator: entry('aggregator', 'Aggregator transactions export', 'monthly', ['aggregator_csv'], [
    'Open the budgeting or account aggregation app that already links your accounts.',
    'Go to the transactions view and choose all accounts and the full date range you want.',
    'Use the export or download option and pick CSV.',
    'Add the downloaded file here. Overlapping exports are fine; repeated rows are skipped.',
  ]),
  bank: entry('bank', 'Bank activity CSV', 'monthly', ['bank_csv', 'card_csv', 'balances'], [
    'Sign in to your bank or card website and open the account.',
    'Find the activity or statements area and choose download or export.',
    'Pick CSV as the format and a date range that reaches back to your last export.',
    'Keep the last four digits of the account in the file name if the site offers it, then add the file here.',
  ]),
  brokerage: entry('brokerage', 'Brokerage positions CSV', 'monthly', ['brokerage_positions', 'statement'], [
    'Sign in to your brokerage or retirement plan website.',
    'Open the positions or holdings page for the account.',
    'Use the download or export option and pick CSV, or save the latest monthly statement as a PDF.',
    'Add the file here. The as-of date in the file decides how fresh it is.',
  ]),
  pnl: entry('pnl', 'Profit and loss workbook', 'monthly', ['pnl_workbook'], [
    'Open the spreadsheet where you track business income and expenses.',
    'Keep one income sheet and one expense sheet per business, with dates and amounts in their own columns.',
    'Save or download it as an Excel workbook (.xlsx).',
    'Add the workbook here. A later copy replaces the months it covers.',
  ]),
  estimates: entry('estimates', 'Estimated tax workbook', 'quarterly', ['tax_payments'], [
    'Open the spreadsheet where you record estimated tax payments.',
    'Keep one sheet per year with federal and state columns for each payer.',
    'Save or download it as an Excel workbook (.xlsx) after each quarterly payment.',
    'Add the workbook here. A later copy replaces the payments it covers.',
  ]),
  paystub: entry('paystub', 'Paystub PDF', 'per pay period', ['paystub'], [
    'Sign in to your payroll or employee self-service portal.',
    'Open pay statements and pick the most recent pay date.',
    'Download it as a PDF.',
    'Add the PDF here. Identifiers are never asked for or stored.',
  ]),
  taxforms: entry('taxforms', 'Tax forms', 'annual', ['tax_doc'], [
    'Collect this year\'s tax forms from your employers, banks and brokerages as they arrive.',
    'Download each form as a PDF from the issuer\'s website or scan the paper copy.',
    'Add last year\'s filed return too, so the household facts start from it.',
    'Add the PDFs here. Identifiers are never asked for or stored.',
  ]),
});

const LIST = Object.freeze(Object.values(HOWTO));
const BY_KIND = new Map(LIST.flatMap((h) => h.sourceKinds.map((k) => [k, h])));

export function listHowTo() {
  return LIST;
}

export function howToFor(sourceKind) {
  return BY_KIND.get(sourceKind) ?? null;
}
