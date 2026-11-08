import { undoDefault } from './derive.mjs';
import { tx, parseJson } from '../store/db.mjs';
import { upsertFact, getFacts } from '../store/facts.mjs';
import { answerShape, acceptsAnswerAccount, questionAnswered } from '../jobs/triggers/common.mjs';
import { inferMortgage } from '../calc/mortgage-inference.mjs';
import { normalizeName } from '../ingest/confirm.mjs';
import { isoDate } from '../ingest/format.mjs';

export class FactAnswerError extends Error {}

const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = () => { throw new FactAnswerError('Check the answer type, required fields and units.'); };

function validate(value, shape, year) {
  if (shape.type === 'array') {
    if (!Array.isArray(value) || value.length < shape.minItems || value.length > shape.maxItems) fail();
    for (const entry of value) validate(entry, shape.items, year);
    if (shape.items.fields.name && new Set(value.map(e => normalizeName(e.name))).size !== value.length) fail();
  } else if (shape.type === 'string') {
    if (typeof value !== 'string' || !normalizeName(value) || value.length > shape.maxLength) fail();
  } else if (shape.type === 'map') {
    if (!object(value) || !Object.keys(value).length || Object.keys(value).some(k => !normalizeName(k)) || new Set(Object.keys(value).map(normalizeName)).size !== Object.keys(value).length) fail();
    for (const entry of Object.values(value)) validate(entry, shape.values, year);
  } else if (shape.type === 'object') {
    if (!object(value) || Object.keys(value).some(k => !Object.hasOwn(shape.fields, k))) fail();
    for (const [key, field] of Object.entries(shape.fields)) {
      const needed = !field.optional && (!field.when || Object.entries(field.when).every(([k, v]) => value[k] === v));
      if (needed || Object.hasOwn(value, key)) validate(value[key], field, year);
    }
  } else if (shape.type === 'dates') {
    if (!Array.isArray(value) || !value.length || value.length > shape.maxItems
      || value.some(d => typeof d !== 'string' || isoDate(d) !== d || d > `${year}-12-31`)) fail();
  } else if (shape.type === 'years') {
    if (!Array.isArray(value) || !value.length || value.length > shape.maxItems
      || value.some(y => !Number.isInteger(y) || y < shape.min || y > shape.max)) fail();
  } else if (shape.type === 'boolean') {
    if (typeof value !== 'boolean') fail();
  } else if (shape.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < shape.min || (shape.max != null && value > shape.max)
      || (shape.exclusiveMin != null && value <= shape.exclusiveMin) || (shape.integer && !Number.isInteger(value)) || (shape.half && !Number.isInteger(value * 2)) || (shape.currentYear && value > year)) fail();
  } else if (shape.type === 'date') {
    if (typeof value !== 'string' || isoDate(value) !== value) fail();
  } else if (shape.type === 'choice') {
    if (!shape.choices.some(c => c.value === value)) fail();
  } else fail();
}

export function recordFactAnswers(db, answers, { now = new Date().toISOString(), recId = null, channel = null, actorId = null, sourceEvidence = null, onWrite } = {}) {
  if (!Array.isArray(answers) || !answers.length || answers.length > 50) fail();
  const date = now.slice(0, 10);
  if (isoDate(date) !== date) fail();
  const priorPlans = parseJson(db.prepare("SELECT value FROM facts WHERE key='accounts.planType'").get()?.value, {});
  const planAnswer = answers.find(a => a?.key === 'accounts.planType');
  const facts = { 'accounts.planType': { ...priorPlans, ...(object(planAnswer?.value) ? planAnswer.value : {}) } };
  const year = Number(date.slice(0,4));
  const keys = new Set();
  const writes = answers.map(a => {
    if (!object(a) || typeof a.key !== 'string' || keys.has(a.key)) fail();
    keys.add(a.key);
    let shape;
    try { shape = answerShape(a.key); } catch { fail(); }
    let value = a.value;
    if (shape.scope !== 'household') {
      if (!object(value) || !Object.keys(value).length) fail();
      for (const [id, entry] of Object.entries(value)) {
        if (shape.scope === 'account') {
          const account = db.prepare('SELECT id, kind, name FROM accounts WHERE id = ?').get(id);
          if (!account || !acceptsAnswerAccount(shape, account, facts)) fail();
        } else if (!['owner', 'spouse'].includes(id)) fail();
        validate(entry, shape, year);
      }
      const prior = parseJson(db.prepare('SELECT value FROM facts WHERE key = ?').get(a.key)?.value, {});
      value = { ...(object(prior) ? prior : {}), ...value };
    } else {
      // Birth years are told a person at a time: a later answer keeps the years it does not name.
      if (['household.birthYears', 'obligations.mortgage'].includes(a.key) && object(value)) {
        const prior = parseJson(db.prepare('SELECT value FROM facts WHERE key = ?').get(a.key)?.value, {});
        value = { ...(object(prior) ? prior : {}), ...value };
      }
      validate(value, shape, year);
      if (a.key === 'business.entities') {
        const links = value.map(e => e.accountId).filter(Boolean);
        if (new Set(links).size !== links.length) fail();
        for (const entry of value) {
          if ((entry.status === 'final_year') !== (entry.finalYear !== undefined)) fail();
          if (entry.accountId && (!['s_corp', 'sole_prop', 'llc_single', 'partnership', 'c_corp'].includes(entry.type)
            || !db.prepare("SELECT id FROM accounts WHERE id=? AND kind='business' AND archived_at IS NULL").get(entry.accountId))) fail();
        }
        const prior = parseJson(db.prepare('SELECT value FROM facts WHERE key = ?').get(a.key)?.value, []);
        const names = new Set(value.map(e => normalizeName(e.name)));
        value = [...(Array.isArray(prior) ? prior : []).filter(e => !names.has(normalizeName(e?.name))
          && !(e?.inferred && (links.includes(e.accountId) || e.accountIds?.some(id => links.includes(id)))))
          .map(e => {
            if (!links.includes(e?.accountId)) return e;
            const { accountId, ...unlinked } = e;
            return unlinked;
          }), ...value];
      }
      if (shape.type === 'map') {
        const prior = parseJson(db.prepare('SELECT value FROM facts WHERE key = ?').get(a.key)?.value, {});
        const changed = new Set(Object.keys(value).map(normalizeName));
        const keep = Object.entries(object(prior) ? prior : {}).filter(([k]) => !changed.has(normalizeName(k)));
        value = { ...Object.fromEntries(keep), ...value };
      }
    }
    if (a.key === 'income.payrollYtd' && Object.values(value).some(v => v.asOf > date)) fail();
    if (a.key === 'obligations.mortgage' && (!Object.keys(value).length || value.escrowMonthly >= value.monthlyPayment)) fail();
    if (/^household\.(owner|spouse)BirthDate$/.test(a.key) && value > date) fail();
    if (a.key === 'business.salaryRange' && value.min > value.max) fail();
    // A birth year in the future is a typo, not an answer.
    if (a.key === 'household.birthYears' && [value.owner, value.spouse, ...(value.dependents || [])].some(y => y > Number(date.slice(0, 4)))) fail();
    return { key: a.key, value };
  });
  const receipts = [];
  const write = () => {
    const src = channel === 'resolver' ? `resolver:${date}:${writes.map(w => w.key).join(',')}`
      : channel ? `${channel}:${date}` : `answer:${date}`;
    const label = channel === 'resolver' ? `Fathom resolved this from stored evidence on ${date}` : channel ? `you told Fathom ${channel === 'ask' ? 'in Ask' : 'through MCP'} on ${date}` : `you answered on ${date}`;
    db.prepare('INSERT OR IGNORE INTO sources (id, label, as_of, kind, note) VALUES (?, ?, ?, ?, ?)').run(src, label, date, channel === 'resolver' ? 'derived' : 'owner', '');
    for (const w of writes) {
      undoDefault(db, w.key, w.value);
      const before = db.prepare('SELECT * FROM facts WHERE key = ?').get(w.key) || null;
      if (!channel || !before || before.value !== JSON.stringify(w.value)) {
        upsertFact(db, { ...w, src, asOf: date, confirmed: true, now, provenance: { parser: channel || 'answer', locator: { note: label,
          ...(actorId ? { actorId } : {}), ...(recId ? { recId } : {}), ...(sourceEvidence ? { sourceSpan: sourceEvidence.span } : {}) } } });
      }
      const receipt = onWrite?.(before, db.prepare('SELECT * FROM facts WHERE key = ?').get(w.key));
      if (receipt?.id) receipts.push(receipt.id);
    }
    if (recId) {
      const row = db.prepare('SELECT status, def FROM recs WHERE id = ?').get(recId);
      const question = row ? parseJson(row.def, {}).question : null;
      if (question?.primary) {
        // An answered question rec is done (RQ2); a partial answer leaves it open. The event keeps
        // the receipts this answer wrote, which are its Undo.
        const to = answeredNow(db, question, date) ? 'done' : 'proposed';
        db.prepare('UPDATE recs SET status = ?, waiting_on = NULL, wake = NULL, updated_at = ? WHERE id = ?').run(to, now, recId);
        db.prepare("INSERT INTO rec_events (rec_id, ts, action, arg, from_status, to_status, actor) VALUES (?, ?, 'answer', ?, ?, ?, 'ui')")
          .run(recId, now, receipts.length ? JSON.stringify(receipts) : null, row.status, to);
      }
    }
  };
  if (db.isTransaction) write();
  else tx(db, write);
  return { keys: writes.map(w => w.key) };
}

// The stored question over the facts on file now, as the scenario rebuilds it.
function answeredNow(db, question, date) {
  const facts = getFacts(db);
  const mortgage = question.keys?.includes('obligations.mortgage') ? inferMortgage(db, date, facts['obligations.mortgage']) : undefined;
  if (mortgage?.present) facts['obligations.mortgage'] = mortgage.values;
  return questionAnswered(question, { facts, accounts: db.prepare('SELECT * FROM accounts').all(), mortgage });
}

export async function answerFacts(db, answers, { replan, ...options } = {}) {
  if (typeof replan !== 'function') fail();
  const result = recordFactAnswers(db, answers, options);
  try {
    await replan();
  } catch {
    throw new FactAnswerError('Your answers were saved, but planning could not finish. Save again to retry.');
  }
  return result;
}
