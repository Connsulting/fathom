import { tx, parseJson } from '../store/db.mjs';
import { upsertFact } from '../store/facts.mjs';
import { answerShape } from '../jobs/triggers/common.mjs';
import { isoDate } from '../ingest/format.mjs';

export class FactAnswerError extends Error {}

const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = () => { throw new FactAnswerError('Check the answer type, required fields and units.'); };

function validate(value, shape) {
  if (shape.type === 'object') {
    if (!object(value) || Object.keys(value).some(k => !Object.hasOwn(shape.fields, k))) fail();
    for (const [key, field] of Object.entries(shape.fields)) {
      const needed = !field.when || Object.entries(field.when).every(([k, v]) => value[k] === v);
      if (needed || Object.hasOwn(value, key)) validate(value[key], field);
    }
  } else if (shape.type === 'boolean') {
    if (typeof value !== 'boolean') fail();
  } else if (shape.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < shape.min || (shape.max != null && value > shape.max)
      || (shape.exclusiveMin != null && value <= shape.exclusiveMin) || (shape.integer && !Number.isInteger(value))) fail();
  } else if (shape.type === 'date') {
    if (typeof value !== 'string' || isoDate(value) !== value) fail();
  } else if (shape.type === 'choice') {
    if (!shape.choices.some(c => c.value === value)) fail();
  } else fail();
}

export async function answerFacts(db, answers, { now = new Date().toISOString(), replan, recId = null } = {}) {
  if (!Array.isArray(answers) || !answers.length || answers.length > 30 || typeof replan !== 'function') fail();
  const date = now.slice(0, 10);
  if (isoDate(date) !== date) fail();
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
          const account = db.prepare('SELECT kind FROM accounts WHERE id = ?').get(id);
          if (!account || account.kind !== shape.accountKind) fail();
        } else if (!['owner', 'spouse'].includes(id)) fail();
        validate(entry, shape);
      }
      const prior = parseJson(db.prepare('SELECT value FROM facts WHERE key = ?').get(a.key)?.value, {});
      value = { ...(object(prior) ? prior : {}), ...value };
    } else validate(value, shape);
    if (a.key === 'business.salaryRange' && value.min > value.max) fail();
    return { key: a.key, value };
  });
  tx(db, () => {
    const src = `answer:${date}`;
    const label = `you answered on ${date}`;
    db.prepare('INSERT OR IGNORE INTO sources (id, label, as_of, kind, note) VALUES (?, ?, ?, ?, ?)').run(src, label, date, 'owner', '');
    for (const w of writes) upsertFact(db, { ...w, src, asOf: date, confirmed: true, now, provenance: { parser: 'answer', locator: { note: label, ...(recId ? { recId } : {}) } } });
    if (recId) {
      const row = db.prepare('SELECT status, def FROM recs WHERE id = ?').get(recId);
      if (row && parseJson(row.def, {}).question) {
        db.prepare("UPDATE recs SET status = 'proposed', waiting_on = NULL, wake = NULL, updated_at = ? WHERE id = ?").run(now, recId);
        db.prepare("INSERT INTO rec_events (rec_id, ts, action, arg, from_status, to_status, actor) VALUES (?, ?, 'answer', NULL, ?, 'proposed', 'ui')").run(recId, now, row.status);
      }
    }
  });
  try {
    await replan();
  } catch {
    throw new FactAnswerError('Your answers were saved, but planning could not finish. Save again to retry.');
  }
  return { keys: writes.map(w => w.key) };
}
