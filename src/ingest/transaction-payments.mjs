import { createHash } from 'node:crypto';
import { actionTx, parseJson } from '../store/db.mjs';
import { ask, archive, recordAutoAnswer, ConfirmError } from './confirm.mjs';
import { captureChanges } from './undo.mjs';

const PARSER = 'transaction-payment';
const cents = value => Math.round(Number(value) * 100);
const days = (a, b) => Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000;
const estimate = row => ['estimate', 'paid'].includes(row.kind);
const jurisdiction = value => /^(va|virginia|state)$/i.test(value) ? 'state' : String(value).toLowerCase();
const samePayment = (row, t, j) => estimate(row) && jurisdiction(row.jurisdiction) === jurisdiction(j)
  && cents(row.amount) === -cents(t.amount) && days(row.date, t.date) <= 3;
const snapshot = t => ({ id: t.id, dedupe_key: t.dedupe_key, account_id: t.account_id, date: t.date, amount: t.amount,
  description: t.description, external_id: t.external_id, file_id: t.file_id, parser: t.parser, locator: t.locator });
const current = async (db, t) => {
  const row = await db.prepare('SELECT * FROM transactions WHERE id=?').get(t.id);
  return row && Object.entries(t).every(([k, value]) => row[k] === value) ? row : null;
};

export function estimatedTaxYear(date, jurisdiction, quarter = null) {
  if (!/^(?:federal|va|virginia)$/i.test(jurisdiction ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return null;
  const year = Number(date.slice(0, 4));
  // Both jurisdictions' fourth installment falls in January of the following calendar year.
  return year - (date.slice(5, 7) === '01' && (quarter === null || quarter === 4) ? 1 : 0);
}

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
  const quarter = Number(/\bq([1-4])\b/i.exec(text)?.[1]) || null;
  const taxYear = years.length === 1 ? years[0] : years.length === 0 ? estimatedTaxYear(t.date, j, quarter) : null;
  return { jurisdiction: j, taxYear, quarter, years, sure: explicit && !!j && j !== 'state' && taxYear !== null
    && !/\b(?:extension|balance due|return balance|penalty|amended)\b/i.test(text) };
}

function choices(c, t) {
  const years = c.taxYear === null ? c.years.length > 1 ? c.years : [Number(t.date.slice(0, 4)) - 1, Number(t.date.slice(0, 4))] : [c.taxYear];
  const jurisdictions = c.jurisdiction ? [c.jurisdiction] : ['federal', 'state'];
  return jurisdictions.flatMap(j => years.map(year => ({
    id: `${j === c.jurisdiction ? 'estimate' : j}${c.taxYear === null ? ':' + year : ''}`,
    label: `${j === 'federal' ? 'Federal' : 'State'} estimate${c.taxYear === null ? ' for ' + year : ''}`,
  }))).concat({ id: 'not_estimate', label: 'Not an estimated tax payment' });
}

async function logsFor(db, t, j) {
  return (await db.prepare("SELECT * FROM tax_payments WHERE coalesce(parser,'')!=? AND round(amount*100)=? AND date BETWEEN date(?,'-3 days') AND date(?,'+3 days')")
    .all(PARSER, -cents(t.amount), t.date, t.date)).filter(r => samePayment(r, t, j));
}

export async function applyTransactionPayment(db, item, optionId) {
  const { transaction: prior } = item.context;
  const t = await current(db, prior);
  if (!t) throw new ConfirmError('stale');
  if (optionId === 'not_estimate') return {};
  const [choice, year] = optionId.split(':');
  const j = choice === 'estimate' || choice === 'separate' || choice === 'logged' ? item.context.jurisdiction : choice;
  const taxYear = choice === 'logged' ? item.context.taxYear : year ? Number(year) : item.context.taxYear;
  if (!j || !Number.isInteger(taxYear)) throw new ConfirmError('bad_option');
  const logs = await logsFor(db, t, j);
  if (choice === 'logged') {
    if (!logs.some(r => r.id === Number(year))) throw new ConfirmError('stale');
    return {};
  }
  if (choice !== 'separate' && logs.length > 1) throw new ConfirmError('stale');
  if (choice !== 'separate' && logs.length === 1) return {};
  const locator = { transaction: { id: t.id, dedupeKey: t.dedupe_key, accountId: t.account_id, fileId: t.file_id,
    parser: t.parser, locator: parseJson(t.locator, {}) }, confirmId: item.id, quarter: item.context.quarter };
  await db.prepare(`INSERT INTO tax_payments (jurisdiction,tax_year,date,amount,kind,file_id,parser,locator,dedupe_key,source_slot,payer,date_precision,tax_year_basis,recipient)
    VALUES (?,?,?,?,'estimate',?,?,?,?,?,?,'day',?,?)`).run(j, taxYear, t.date, -cents(t.amount) / 100, t.file_id, PARSER,
    JSON.stringify(locator), `transaction-payment:${t.dedupe_key}`, `transaction:${t.dedupe_key}`, item.context.payer ?? 'unknown',
    year ? 'confirmed_tax_year' : item.context.years?.length === 0 ? 'inferred_payment_date' : 'transaction', item.context.recipient ?? 'unknown');
  return {};
}

export async function reconcileTransactionPayments(db, { now = new Date().toISOString() } = {}) {
  return await actionTx(db, async (db) => {
    const rows = await db.prepare(`SELECT t.*, a.owner FROM transactions t JOIN accounts a ON a.id=t.account_id
      WHERE (t.parser='simplefin' OR a.mirror='connected') AND t.amount<0 ORDER BY t.date,t.id`).all();
    const contexts = new Map((await db.prepare("SELECT * FROM confirm_items WHERE kind='transaction_payment'").all()).map(i => [i.subject, i]));
    for (const payment of await db.prepare('SELECT * FROM tax_payments WHERE parser=?').all(PARSER)) {
      const loc = parseJson(payment.locator, {}), item = await db.prepare('SELECT context,answer FROM confirm_items WHERE id=?').get(loc.confirmId);
      const context = parseJson(item?.context, {}), t = context.transaction && await current(db, context.transaction);
      const log = t && (await logsFor(db, t, payment.jurisdiction))[0];
      if (t && (!log || item.answer === 'separate')) continue;
      await archive(db, 'tax_payments', { ...payment }, { by: log?.file_id ?? null, reason: log ? 'duplicate' : 'revised', now });
      await db.prepare('DELETE FROM tax_payments WHERE id=?').run(payment.id);
    }
    for (const row of contexts.values()) {
      if (row.status !== 'answered' || ['not_estimate', 'superseded'].includes(row.answer)) continue;
      const context = parseJson(row.context, {}), t = context.transaction && await current(db, context.transaction);
      if (!t || await db.prepare('SELECT 1 FROM tax_payments WHERE parser=? AND dedupe_key=?').get(PARSER, `transaction-payment:${t.dedupe_key}`)) continue;
      const choice = row.answer.split(':')[0];
      const j = ['estimate', 'logged', 'separate'].includes(choice) ? context.jurisdiction : choice;
      const undo = await db.prepare('SELECT changes FROM confirm_undo WHERE item_id=?').get(row.id);
      const retained = JSON.parse(undo.changes).filter(c => c.table !== 'tax_payments');
      if ((await logsFor(db, t, j)).length) {
        await db.prepare('UPDATE confirm_undo SET changes=? WHERE item_id=?').run(JSON.stringify(retained), row.id);
        continue;
      }
      const { changes } = await captureChanges(db, async (db) => await applyTransactionPayment(db, { ...row, context }, choice === 'logged' ? 'estimate' : row.answer));
      await db.prepare('UPDATE confirm_undo SET changes=? WHERE item_id=?')
        .run(JSON.stringify([...retained, ...changes]), row.id);
    }
    for (const t of rows) {
      const c = classify(t);
      if (!c) continue;
      const transaction = snapshot(t);
      const signature = createHash('sha256').update(JSON.stringify(transaction)).digest('hex').slice(0, 24);
      const subject = `${t.dedupe_key}:${signature}`;
      const existing = contexts.get(subject);
      if (existing && (existing.status !== 'pending' || await db.prepare('SELECT 1 FROM confirm_auto_declined WHERE item_id=?').get(existing.id))) continue;
      for (const prior of contexts.values()) {
        const old = parseJson(prior.context, {}).transaction;
        if (prior.id !== existing?.id && old?.id === t.id && prior.status === 'pending') await db.prepare("UPDATE confirm_items SET status='answered',answer='superseded',answered_at=? WHERE id=?").run(now, prior.id);
      }
      const logs = c.jurisdiction ? await logsFor(db, t, c.jurisdiction) : [];
      const overlapping = logs.length === 1 && rows.filter(other => {
        const classification = classify(other);
        return classification?.jurisdiction && samePayment(logs[0], other, classification.jurisdiction);
      }).length > 1;
      const ambiguousLog = c.sure && (logs.length > 1 || overlapping);
      const options = ambiguousLog ? logs.map(r => ({ id: `logged:${r.id}`, label: `Logged on ${r.date}` }))
        .concat({ id: 'separate', label: 'A separate estimated payment' }, { id: 'not_estimate', label: 'Not an estimated tax payment' }) : choices(c, t);
      const owner = /^(you|owner)$/i.test(t.owner ?? '') ? 'owner' : /^(your spouse|spouse)$/i.test(t.owner ?? '') ? 'spouse' : 'unknown';
      const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(-t.amount);
      const context = { ...c, transaction, payer: owner, recipient: owner, amount: -t.amount, date: t.date };
      if (existing) await db.prepare('UPDATE confirm_items SET options=?,context=? WHERE id=?').run(JSON.stringify(options), JSON.stringify(context), existing.id);
      const out = await ask(db, { kind: 'transaction_payment', subject,
        question: ambiguousLog ? `Is ${t.description}, ${amount} on ${t.date}, already in your estimated tax payment log?`
          : `Is ${t.description}, ${amount} on ${t.date}, an estimated tax payment?`, options,
        context, fileId: t.file_id, now });
      if (c.sure && !ambiguousLog && (out.queued || existing)) await recordAutoAnswer(db, existing?.id ?? out.id, 'estimate', { rule: 'transaction_payment', now,
        evidence: { text: 'A posted connected-account transaction identifies an estimated tax payment. Federal and Virginia fourth installments are due in January for the prior tax year; an explicit tax year takes precedence.', refs: [{ table: 'transactions', id: t.id }] } });
    }
  });
}

export async function observedPayments(db) {
  const out = [];
  for (const item of await db.prepare("SELECT * FROM confirm_items WHERE kind='transaction_payment' AND status='answered' AND answer NOT IN ('not_estimate','superseded')").all()) {
    const c = parseJson(item.context, {}), t = c.transaction && await current(db, c.transaction);
    if (!t) continue;
    const [choice, value] = item.answer.split(':');
    const j = ['estimate','logged','separate'].includes(choice) ? c.jurisdiction : choice;
    const taxYear = choice !== 'logged' && value ? Number(value) : c.taxYear;
    const own = await db.prepare('SELECT * FROM tax_payments WHERE parser=? AND dedupe_key=?').get(PARSER, `transaction-payment:${t.dedupe_key}`);
    const logs = await logsFor(db, t, j);
    const payment = own ?? (choice === 'logged' ? logs.find(r => r.id === Number(value)) : null) ?? (logs.length === 1 ? logs[0] : null);
    if (!payment) continue;
    const month = Number(t.date.slice(5, 7));
    const quarter = c.quarter ?? (Number(t.date.slice(0, 4)) > taxYear ? 4 : month <= 4 ? 1 : month <= 6 ? 2 : month <= 9 ? 3 : 4);
    out.push({ jurisdiction: payment.jurisdiction, taxYear: payment.tax_year, quarter, amount: payment.amount, date: t.date,
      evidence: { table: 'transactions', id: t.id, paymentId: payment.id, confirmId: item.id } });
  }
  return out;
}
