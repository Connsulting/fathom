// The advisor review workflow (item 24). The owner runs it: there are no advisor accounts. A rec
// is sent for review, the owner records the advisor's verdict (confirmed or vetoed, with a note
// and the advisor's date) and sets the next check-in. Tables: advisor_reviews, advisor_checkin,
// advisor_packets (migration 011). The demo seed writes the same tables, so demo and real build
// the scenario's advisor section and each rec's `advisor` field from one code path.
//
// A veto dismisses the rec through the rec action path (src/api/handlers.mjs applyStatusAction)
// with the reason 'advisor vetoed'. The planner keeps the owner's status, so a vetoed rec stays
// dismissed and a confirmed one keeps its verdict across reruns; liftStaleVetoes (run inside the
// planner's write transaction) closes a veto and reopens the rec only when the planner's grounding
// hash for it (its figures, window and variables) changed since the verdict was recorded.
//
// Browser-facing text: titles are the rec's stored title (token text, rendered like any rec
// title); notes are owner text escaped with escapeUserText at write time.

import { escapeUserText } from '../shared/tokens.mjs';

export const MAX_NOTE = 1000;
export const MAX_LENGTH_MIN = 480;
export const VETO_REASON = 'advisor vetoed';
const VERDICTS = ['confirmed', 'vetoed'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export class AdvisorError extends Error {
  constructor(status, message) { super(message); this.name = 'AdvisorError'; this.status = status; }
}

const isIsoDate = v => typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'))
  && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

// 'Nov 5, 2026' from an ISO date or timestamp.
export function dayLabel(iso) {
  const d = String(iso || '').slice(0, 10);
  if (!isIsoDate(d)) return '';
  const [y, m, day] = d.split('-').map(Number);
  return `${MONTHS[m - 1]} ${day}, ${y}`;
}

function whenLabel(date, time) {
  const d = new Date(date + 'T00:00:00Z');
  let out = `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  if (time) {
    const [h24, mm] = time.split(':').map(Number);
    out += `, ${h24 % 12 === 0 ? 12 : h24 % 12}:${String(mm).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
  }
  return out;
}

export function lengthLabel(min) {
  const n = Number(min);
  if (!Number.isInteger(n) || n <= 0) return '';
  const h = Math.floor(n / 60), m = n % 60;
  return [h ? `${h} hr` : '', m ? `${m} min` : ''].filter(Boolean).join(' ');
}

const openRows = async db => await db.prepare('SELECT * FROM advisor_reviews WHERE closed_at IS NULL ORDER BY id').all();

// recId -> the rec's `advisor` field: { verdict: 'pending'|'confirmed'|'vetoed', note, date, reviewId }.
export async function recAdvisorMap(db) {
  const out = new Map();
  for (const r of await openRows(db)) {
    if (!r.rec_id) continue;
    out.set(r.rec_id, r.verdict
      ? { verdict: r.verdict, note: r.note, date: dayLabel(r.reviewed_on), reviewedOn: r.reviewed_on, reviewId: r.id }
      : { verdict: 'pending', note: '', date: dayLabel(r.sent_at), sentOn: r.sent_at.slice(0, 10), reviewId: r.id });
  }
  return out;
}

// Sets rec.advisor on each rec from the tables (null when it was never sent).
export async function withAdvisor(db, recs) {
  const map = await recAdvisorMap(db);
  for (const r of recs) r.advisor = map.get(r.id) || null;
  return recs;
}

export async function getCheckin(db) {
  const row = await db.prepare('SELECT * FROM advisor_checkin WHERE id = 1').get();
  if (!row) return { when: '', length: '', date: null, time: null, lengthMin: null };
  return { when: whenLabel(row.date, row.time), length: lengthLabel(row.length_min), date: row.date, time: row.time || null, lengthMin: row.length_min };
}

export async function listPackets(db) {
  return (await db.prepare('SELECT id, created_at, clock, rec_ids FROM advisor_packets ORDER BY created_at DESC, id').all()).map(p => {
    let ids = [];
    try { ids = JSON.parse(p.rec_ids); } catch { ids = []; }
    return { id: p.id, createdAt: p.created_at, date: dayLabel(p.clock), recIds: Array.isArray(ids) ? ids : [] };
  });
}

async function nextCheckin(db, fromContent) {
  const c = await getCheckin(db);
  if (c.date || !fromContent || typeof fromContent.when !== 'string' || !fromContent.when) return c;
  return { ...c, when: fromContent.when, length: typeof fromContent.length === 'string' ? fromContent.length : '' };
}

// The scenario's advisor section: narrative keys (name, role, agenda, notAsking, shared, experts)
// from the content row, review state from the tables. `recs` is the scenario's rec list; hidden
// recs never show. pending stays a list of rec ids (CONTRACT); waiting carries the send dates.
export async function advisorSection(db, base, recs) {
  const visible = new Map(recs.filter(r => r.status !== 'hidden').map(r => [r.id, r]));
  const rows = await openRows(db);
  const waiting = rows.filter(r => !r.verdict && visible.has(r.rec_id))
    .map(r => ({ reviewId: r.id, recId: r.rec_id, title: visible.get(r.rec_id).title, sent: dayLabel(r.sent_at), sentOn: r.sent_at.slice(0, 10) }));
  const reviewed = rows.filter(r => r.verdict && (!r.rec_id || visible.has(r.rec_id)))
    .sort((a, b) => String(b.reviewed_on).localeCompare(String(a.reviewed_on)) || b.id - a.id)
    .map(r => {
      const out = { reviewId: r.id, title: r.rec_id ? visible.get(r.rec_id).title : r.title, verdict: r.verdict, note: r.note, date: dayLabel(r.reviewed_on), reviewedOn: r.reviewed_on };
      if (r.rec_id) out.recId = r.rec_id;
      return out;
    });
  return {
    ...base,
    // The owner-set check-in; before one is set, a check-in label from the content row (a store
    // from before migration 011) still shows, without a date.
    next: await nextCheckin(db, base.next),
    reviewed,
    pending: waiting.map(w => w.recId),
    waiting,
    packets: await listPackets(db),
  };
}

// ---------------------------------------------------------------- writes (callers wrap in tx)

async function recRow(db, recId) {
  const row = typeof recId === 'string' ? await db.prepare('SELECT * FROM recs WHERE id = ?').get(recId) : null;
  if (!row || row.status === 'hidden') throw new AdvisorError(404, `no recommendation ${recId}`);
  return row;
}

// Marks a rec for review. Idempotent while a review is waiting; a reviewed rec sent again closes
// the old verdict and opens a new review. Returns the open review row id.
export async function sendToAdvisor(db, recId, { now }) {
  const row = await recRow(db, recId);
  const open = await db.prepare('SELECT * FROM advisor_reviews WHERE rec_id = ? AND closed_at IS NULL').get(recId);
  if (open && !open.verdict) return open.id;
  if (open) await db.prepare("UPDATE advisor_reviews SET closed_at = ?, closed_reason = 'sent again' WHERE id = ?").run(now, open.id);
  let title = '';
  try { title = String(JSON.parse(row.def).title || ''); } catch { title = ''; }
  return Number((await db.prepare('INSERT INTO advisor_reviews (rec_id, title, sent_at) VALUES (?, ?, ?) RETURNING id').get(recId, title, now)).id);
}

// Records the advisor's verdict on a waiting review. `dismiss(row)` moves a vetoed rec to
// dismissed through the rec action path. Returns the rec id.
export async function recordVerdict(db, reviewId, { verdict, note, date, now }, dismiss) {
  const id = Number(reviewId);
  const r = Number.isInteger(id) ? await db.prepare('SELECT * FROM advisor_reviews WHERE id = ?').get(id) : null;
  if (!r || r.closed_at || !r.rec_id) throw new AdvisorError(404, `no open review ${reviewId}`);
  if (r.verdict) throw new AdvisorError(409, 'that review already has a verdict');
  if (!VERDICTS.includes(verdict)) throw new AdvisorError(400, 'verdict must be confirmed or vetoed');
  if (note != null && typeof note !== 'string') throw new AdvisorError(400, 'note must be text');
  const text = (note || '').trim();
  if (text.length > MAX_NOTE) throw new AdvisorError(400, `note is longer than ${MAX_NOTE} characters`);
  if (!isIsoDate(date)) throw new AdvisorError(400, 'date must be YYYY-MM-DD');
  const row = await recRow(db, r.rec_id);
  const pr = await db.prepare('SELECT grounding_hash FROM planner_recs WHERE rec_id = ?').get(r.rec_id);
  await db.prepare('UPDATE advisor_reviews SET verdict = ?, note = ?, reviewed_on = ?, recorded_at = ?, grounding_hash = ? WHERE id = ?')
    .run(verdict, escapeUserText(text), date, now, pr ? pr.grounding_hash : null, id);
  if (verdict === 'vetoed' && row.status !== 'dismissed') dismiss(row);
  return r.rec_id;
}

export async function setCheckin(db, { date, time, lengthMin, now }) {
  if (!isIsoDate(date)) throw new AdvisorError(400, 'date must be YYYY-MM-DD');
  if (time != null && time !== '' && (typeof time !== 'string' || !TIME.test(time))) throw new AdvisorError(400, 'time must be HH:MM');
  if (!Number.isInteger(lengthMin) || lengthMin < 5 || lengthMin > MAX_LENGTH_MIN) throw new AdvisorError(400, `length must be 5 to ${MAX_LENGTH_MIN} minutes`);
  await db.prepare(`INSERT INTO advisor_checkin (id, date, time, length_min, updated_at) VALUES (1, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET date = excluded.date, time = excluded.time, length_min = excluded.length_min, updated_at = excluded.updated_at`)
    .run(date, time || null, lengthMin, now);
}

// Planner hook, inside its write transaction after applyRecs: a veto on a planner rec whose
// grounding hash changed since the verdict no longer holds. The review closes ('inputs changed')
// and the rec returns to proposed when the veto's dismiss is still its last status change.
export async function liftStaleVetoes(db, { now }) {
  const stale = await db.prepare(`SELECT ar.id, ar.rec_id, r.status FROM advisor_reviews ar
      JOIN planner_recs pr ON pr.rec_id = ar.rec_id JOIN recs r ON r.id = ar.rec_id
      WHERE ar.closed_at IS NULL AND ar.verdict = 'vetoed' AND ar.grounding_hash IS NOT NULL
        AND pr.retired_at IS NULL AND pr.grounding_hash IS NOT ar.grounding_hash`).all();
  const last = db.prepare('SELECT action, arg FROM rec_events WHERE rec_id = ? AND from_status IS NOT to_status ORDER BY id DESC LIMIT 1');
  for (const s of stale) {
    await db.prepare("UPDATE advisor_reviews SET closed_at = ?, closed_reason = 'inputs changed' WHERE id = ?").run(now, s.id);
    const ev = await last.get(s.rec_id);
    if (s.status === 'dismissed' && ev && ev.action === 'dismiss' && ev.arg === VETO_REASON) {
      await db.prepare("UPDATE recs SET status = 'proposed', updated_at = ? WHERE id = ?").run(now, s.rec_id);
      await db.prepare(`INSERT INTO rec_events (rec_id, ts, action, arg, from_status, to_status, actor)
                  VALUES (?, ?, 'advisor_veto_lifted', 'inputs changed', 'dismissed', 'proposed', 'planner')`).run(s.rec_id, now);
    }
  }
  return stale.length;
}

// Read-only status for Ask and MCP: who reviewed what, when. Titles stay token text; the tool
// resolves them.
export async function advisorStatus(db) {
  const recs = new Map((await db.prepare('SELECT id, def, status FROM recs').all()).map(r => {
    let def = {};
    try { def = JSON.parse(r.def); } catch { def = {}; }
    return [r.id, { title: def.title || '', status: r.status }];
  }));
  const rows = (await db.prepare('SELECT * FROM advisor_reviews ORDER BY id').all()).filter(r => !r.rec_id || (recs.get(r.rec_id) || {}).status !== 'hidden');
  const item = r => {
    const out = { recId: r.rec_id, title: r.rec_id ? recs.get(r.rec_id)?.title || r.title : r.title, sentOn: r.sent_at.slice(0, 10) };
    if (r.verdict) Object.assign(out, { verdict: r.verdict, note: r.note, reviewedOn: r.reviewed_on, recordedOn: String(r.recorded_at || '').slice(0, 10) });
    if (r.closed_at) Object.assign(out, { closedOn: r.closed_at.slice(0, 10), closedReason: r.closed_reason });
    return out;
  };
  const c = await getCheckin(db);
  return {
    nextCheckin: c.date ? { date: c.date, time: c.time, lengthMin: c.lengthMin, label: c.when } : null,
    waiting: rows.filter(r => !r.closed_at && !r.verdict).map(item),
    reviewed: rows.filter(r => !r.closed_at && r.verdict).map(item),
    history: rows.filter(r => r.closed_at).map(item),
    packets: (await listPackets(db)).map(p => ({ id: p.id, date: p.createdAt.slice(0, 10), recIds: p.recIds })),
  };
}
