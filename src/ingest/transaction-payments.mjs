import { createHash } from 'node:crypto';
import { actionTx, parseJson } from '../store/db.mjs';
import { ask, archive, recordAutoAnswer, ConfirmError } from './confirm.mjs';

const PARSER = 'transaction-payment';
const cents = value => Math.round(Number(value) * 100);
const days = (a, b) => Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000;
const estimate = row => ['estimate', 'paid'].includes(row.kind);
const jurisdiction = value => /^(va|virginia|state)$/i.test(value) ? 'state' : String(value).toLowerCase();
const samePayment = (row, t, j) => estimate(row) && jurisdiction(row.jurisdiction) === jurisdiction(j)
  && cents(row.amount) === -cents(t.amount) && days(row.date, t.date) <= 3;
const snapshot = t => ({ id: t.id, dedupe_key: t.dedupe_key, account_id: t.account_id, date: t.date, amount: t.amount,
  description: t.description, external_id: t.external_id, file_id: t.file_id, parser: t.parser, locator: t.locator });
const current = (db, t) => {
  const row = db.prepare('SELECT * FROM transactions WHERE id=?').get(t.id);
  return row && Object.entries(t).every(([k, value]) => row[k] === value) ? row : null;
};

function classify(t) {
  if (t.amount >= 0) return null;
  const text = String(t.description ?? '');
  const federal = /\b(?:irs|internal revenue(?: service)?|usataxpymt|us treasury)\b/i.test(text);
  const virginia = /\b(?:virginia tax|va (?:tax|dept\.? (?:of )?taxation)|virginia (?:department|dept\.?) (?:of )?taxation)\b/i.test(text);
  const state = virginia || /\bstate (?:tax|department of revenue)\b/i.test(text);
  if (!federal && !state || /\b(?:payroll|941|940|1120|sales tax|property tax)\b/i.test(text)) return null;
  const j = federal && !state ? 'federal' : !federal && state ? (virginia ? 'VA' : 'state') : null;
  const explicit = /\b(?:estimated?|1040\s*[- ]?es)\b/i.test(text);
  const years = [...new Set(text.match(/\b20\d{2}\b/g) ?? [])].map(Number);
  const year = Number(t.date.slice(0, 4));
  const taxYear = years.length === 1 ? years[0] : years.length === 0 && !t.date.slice(5).startsWith('01-') ? year : null;
  const quarter = Number(/\bq([1-4])\b/i.exec(text)?.[1]) || null;
  return { jurisdiction: j, taxYear, quarter, sure: explicit && !!j && j !== 'state' && taxYear !== null };
}

function choices(c, t) {
  const years = c.taxYear === null ? [Number(t.date.slice(0, 4)) - 1, Number(t.date.slice(0, 4))] : [c.taxYear];
  const jurisdictions = c.jurisdiction ? [c.jurisdiction] : ['federal', 'state'];
  return jurisdictions.flatMap(j => years.map(year => ({
    id: `${j === c.jurisdiction ? 'estimate' : j}${c.taxYear === null ? ':' + year : ''}`,
    label: `${j === 'federal' ? 'Federal' : 'State'} estimate${c.taxYear === null ? ' for ' + year : ''}`,
  }))).concat({ id: 'not_estimate', label: 'Not an estimated tax payment' });
}

function logsFor(db, t, j) {
  return db.prepare("SELECT * FROM tax_payments WHERE coalesce(parser,'')!=? AND round(amount*100)=? AND date BETWEEN date(?,'-3 days') AND date(?,'+3 days')")
    .all(PARSER, -cents(t.amount), t.date, t.date).filter(r => samePayment(r, t, j));
}

export function applyTransactionPayment(db, item, optionId) {
  const { transaction: prior } = item.context;
  const t = current(db, prior);
  if (!t) throw new ConfirmError('stale');
  if (optionId === 'not_estimate') return {};
  const [choice, year] = optionId.split(':');
  const j = choice === 'estimate' || choice === 'separate' || choice === 'logged' ? item.context.jurisdiction : choice;
  const taxYear = choice === 'logged' ? item.context.taxYear : year ? Number(year) : item.context.taxYear;
  if (!j || !Number.isInteger(taxYear)) throw new ConfirmError('bad_option');
  const logs = logsFor(db, t, j);
  if (choice === 'logged') {
    if (!logs.some(r => r.id === Number(year))) throw new ConfirmError('stale');
    return {};
  }
  if (choice !== 'separate' && logs.length > 1) throw new ConfirmError('stale');
  if (choice !== 'separate' && logs.length === 1) return {};
  const locator = { transaction: { id: t.id, dedupeKey: t.dedupe_key, accountId: t.account_id, fileId: t.file_id,
    parser: t.parser, locator: parseJson(t.locator, {}) }, confirmId: item.id, quarter: item.context.quarter };
  db.prepare(`INSERT INTO tax_payments (jurisdiction,tax_year,date,amount,kind,file_id,parser,locator,dedupe_key,source_slot,payer,date_precision,tax_year_basis,recipient)
    VALUES (?,?,?,?,'estimate',?,?,?,?,?,?,'day',?,?)`).run(j, taxYear, t.date, -cents(t.amount) / 100, t.file_id, PARSER,
    JSON.stringify(locator), `transaction-payment:${t.dedupe_key}`, `transaction:${t.dedupe_key}`, item.context.payer ?? 'unknown',
    year ? 'confirmed_tax_year' : 'transaction', item.context.recipient ?? 'unknown');
  return {};
}

export function reconcileTransactionPayments(db, { now = new Date().toISOString() } = {}) {
  return actionTx(db, () => {
    const rows = db.prepare(`SELECT t.*, a.owner FROM transactions t JOIN accounts a ON a.id=t.account_id
      WHERE (t.parser='simplefin' OR a.mirror='connected') AND t.amount<0 ORDER BY t.date,t.id`).all();
    const contexts = new Map(db.prepare("SELECT * FROM confirm_items WHERE kind='transaction_payment'").all().map(i => [i.subject, i]));
    for (const payment of db.prepare('SELECT * FROM tax_payments WHERE parser=?').all(PARSER)) {
      const loc = parseJson(payment.locator, {}), item = db.prepare('SELECT context,answer FROM confirm_items WHERE id=?').get(loc.confirmId);
      const context = parseJson(item?.context, {}), t = context.transaction && current(db, context.transaction);
      const log = t && logsFor(db, t, payment.jurisdiction)[0];
      if (t && (!log || item.answer === 'separate')) continue;
      archive(db, 'tax_payments', { ...payment }, { by: log?.file_id ?? null, reason: log ? 'duplicate' : 'revised', now });
      db.prepare('DELETE FROM tax_payments WHERE id=?').run(payment.id);
    }
    for (const t of rows) {
      const c = classify(t);
      if (!c) continue;
      const transaction = snapshot(t);
      const signature = createHash('sha256').update(JSON.stringify(transaction)).digest('hex').slice(0, 24);
      const subject = `${t.dedupe_key}:${signature}`;
      if (contexts.has(subject)) continue;
      for (const prior of contexts.values()) {
        const old = parseJson(prior.context, {}).transaction;
        if (old?.id === t.id && prior.status === 'pending') db.prepare("UPDATE confirm_items SET status='answered',answer='superseded',answered_at=? WHERE id=?").run(now, prior.id);
      }
      const logs = c.jurisdiction ? logsFor(db, t, c.jurisdiction) : [];
      const overlapping = logs.length === 1 && rows.filter(other => {
        const classification = classify(other);
        return classification?.jurisdiction && samePayment(logs[0], other, classification.jurisdiction);
      }).length > 1;
      const ambiguousLog = c.sure && (logs.length > 1 || overlapping);
      const options = ambiguousLog ? logs.map(r => ({ id: `logged:${r.id}`, label: `Logged on ${r.date}` }))
        .concat({ id: 'separate', label: 'A separate estimated payment' }, { id: 'not_estimate', label: 'Not an estimated tax payment' }) : choices(c, t);
      const owner = /^(you|owner)$/i.test(t.owner ?? '') ? 'owner' : /^(your spouse|spouse)$/i.test(t.owner ?? '') ? 'spouse' : 'unknown';
      const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(-t.amount);
      const out = ask(db, { kind: 'transaction_payment', subject,
        question: ambiguousLog ? `Is ${t.description}, ${amount} on ${t.date}, already in your estimated tax payment log?`
          : `Is ${t.description}, ${amount} on ${t.date}, an estimated tax payment?`, options,
        context: { ...c, transaction, payer: owner, recipient: owner, amount: -t.amount, date: t.date }, fileId: t.file_id, now });
      if (c.sure && !ambiguousLog && out.queued) recordAutoAnswer(db, out.id, 'estimate', { rule: 'transaction_payment', now,
        evidence: { text: 'A posted connected-account transaction identifies an estimated tax payment.', refs: [{ table: 'transactions', id: t.id }] } });
    }
  });
}

export function observedPayments(db) {
  const out = [];
  for (const item of db.prepare("SELECT * FROM confirm_items WHERE kind='transaction_payment' AND status='answered' AND answer NOT IN ('not_estimate','superseded')").all()) {
    const c = parseJson(item.context, {}), t = c.transaction && current(db, c.transaction);
    if (!t) continue;
    const [choice, value] = item.answer.split(':');
    const j = ['estimate','logged','separate'].includes(choice) ? c.jurisdiction : choice;
    const taxYear = choice !== 'logged' && value ? Number(value) : c.taxYear;
    const own = db.prepare('SELECT * FROM tax_payments WHERE parser=? AND dedupe_key=?').get(PARSER, `transaction-payment:${t.dedupe_key}`);
    const logs = logsFor(db, t, j);
    const payment = own ?? (choice === 'logged' ? logs.find(r => r.id === Number(value)) : logs.length === 1 ? logs[0] : null);
    if (!payment) continue;
    const month = Number(t.date.slice(5, 7));
    const quarter = c.quarter ?? (Number(t.date.slice(0, 4)) > taxYear ? 4 : month <= 4 ? 1 : month <= 6 ? 2 : month <= 9 ? 3 : 4);
    out.push({ jurisdiction: payment.jurisdiction, taxYear: payment.tax_year, quarter, amount: payment.amount, date: t.date,
      evidence: { table: 'transactions', id: t.id, paymentId: payment.id, confirmId: item.id } });
  }
  return out;
}
