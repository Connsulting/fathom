import { ledgerKind, ledgerDisplayName, summaryPerson, personalIncomeCategory } from '../pnl/ledgers.mjs';
import { resolveCategories, spendingAccount, sourceBucket } from '../categories/resolve.mjs';
import { ownerOf, resolveEntities } from '../jobs/planner/data.mjs';
import { payrollRecords } from '../jobs/planner/payroll.mjs';
import { parseJson } from '../store/db.mjs';

export const SUMMARY_RULE = 'from the spreadsheet summary for months without bank data; connected transactions win for each person, month and category';
const categoryKey = category => String(category).trim().toLowerCase();
const incomeKey = category => /interest|dividend|other income/i.test(category) ? categoryKey(category) : 'income';
const monthEnd = month => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const inMonths = (month, range) => month >= range.from && month <= range.to;

export function personalSummaryInput(data, facts, categoryInput) {
  const categories = resolveCategories(categoryInput);
  const accounts = new Map(categoryInput.accounts.map(a => [a.id, a]));
  const connected = categoryInput.transactions.filter(t => accounts.has(t.account_id) && spendingAccount(accounts.get(t.account_id)) && t.date <= data.clock)
    .map(t => ({ ...t, ...categories.get(t.id), person: ownerOf(accounts.get(t.account_id).owner) }));
  const groups = Map.groupBy(data.pnlHistory || data.pnl, line => line.entity);
  const lines = [];
  for (const [name, rows] of groups) {
    if (ledgerKind(facts, name, rows) !== 'spending') continue;
    const attribution = summaryPerson({ name, displayName: ledgerDisplayName(rows[0]), lines: rows }, facts);
    if (!attribution) continue;
    for (const line of rows) {
      if (!Number.isFinite(line.amount) || line.period > data.clock.slice(0, 7)) continue;
      const income = personalIncomeCategory(line.category);
      const locator = typeof line.locator === 'string' ? parseJson(line.locator, {}) : line.locator;
      lines.push({ ...line, id: `summary:${line.id}`, sourceId: line.id, sourceTable: 'pnl_lines',
        person: attribution.person, date: monthEnd(line.period), bucket: income ? 'income' : sourceBucket('aggregator', line.category) || 'household',
        layer: 'summary', sheet: locator?.sheet || ledgerDisplayName(line), fileId: line.file_id, account_id: null,
        description: ledgerDisplayName(line), income });
    }
  }
  const people = new Set(lines.filter(l => l.income).map(l => l.person));
  if (!people.size) return { lines, connected, wages: [] };
  const entities = resolveEntities(data, facts);
  const years = [...new Set(lines.filter(l => l.income).map(l => Number(l.period.slice(0, 4))))];
  const payroll = years.flatMap(year => payrollRecords({ ...data, year, taxYear: year }, entities, facts).records.map(r => ({ ...r, year }))).filter(r => people.has(r.person));
  const wages = payroll.map(record => {
    const docs = data.documents.filter(d => record.docIds.includes(d.id));
    const to = record.kind === 'w2' ? `${record.year}-12` : docs.map(d => d.fields.payDate?.slice(0, 7)).filter(Boolean).sort().at(-1);
    return { person: record.person, from: `${record.year}-01`, to, amount: record.ytdWages,
      ids: record.docIds, fileId: record.fileId, household: record.household };
  }).filter(w => w.to && Number.isFinite(w.amount));
  return { lines, connected, wages };
}

export function selectPersonalSummaries(input, { window, payroll = true, bankIncome = true } = {}) {
  if (!input || !window) return { rows: [], evidence: [], payrollRows: [], gaps: [] };
  const rows = [], evidence = [], gaps = [];
  for (const line of input.lines.filter(l => inMonths(l.period, window))) {
    const payrollCovered = payroll && line.income && !/interest|dividend|other income/i.test(line.category)
      && input.wages.some(w => w.person === line.person && inMonths(line.period, w));
    const bankCovered = (!line.income || bankIncome) && input.connected.some(t => (t.person === line.person || t.person === 'joint')
      && t.date.slice(0, 7) === line.period && (line.income ? t.bucket === 'income' && incomeKey(t.category) === incomeKey(line.category) : t.bucket === line.bucket && categoryKey(t.category) === categoryKey(line.category)));
    if (payrollCovered || bankCovered) evidence.push({ ...line, reason: payrollCovered ? 'payroll' : 'connected' });
    else rows.push(line);
  }
  const payrollRows = payroll ? input.wages.filter(w => input.lines.some(l => l.person === w.person && l.income && inMonths(l.period, window) && inMonths(l.period, w)))
    .flatMap(w => {
      if (w.from < window.from || w.to > window.to) {
        gaps.push({ code: 'missing_fact', detail: 'payroll_period_unallocated', message: 'Payroll covers a wider period; its wages cannot be assigned to the requested months.', person: w.person });
        return [];
      }
      return [{ id: `payroll:${w.ids.join(':')}`, sourceId: w.ids[0], sourceIds: w.ids, sourceTable: 'documents', fileId: w.fileId,
        person: w.person, amount: w.amount, date: monthEnd(w.to), period: w.to, from: w.from, to: w.to,
        category: 'Income', bucket: 'income', layer: 'payroll', description: 'Recorded payroll', account_id: null, household: w.household }];
    }) : [];
  return { rows, evidence, payrollRows, gaps };
}

export function summarySources(rows) {
  return [...Map.groupBy(rows, r => r.sourceTable || 'transactions')].map(([table, list]) => ({ table,
    ids: list.flatMap(r => r.sourceIds || [r.sourceId ?? r.id]).slice(0, 50), count: list.reduce((n, r) => n + (r.sourceIds?.length || 1), 0),
    ...(table === 'pnl_lines' ? { files: [...new Set(list.map(r => r.fileId).filter(Boolean))], sheets: [...new Set(list.map(r => r.sheet))] } : {}),
  }));
}
