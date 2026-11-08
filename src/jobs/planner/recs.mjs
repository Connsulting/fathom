// Recs upsert, blocking and retirement for planner-owned recs (base plan, R13, R14, S10, S12, T6).
// The owner's status and task flags always survive; the planner only changes status when its own
// retire or block event was the last word. Goal kinds follow the trigger on every run; the action
// owner follows the trigger default only while the owner has not set it (owner_override = 0). The
// planner writes no conversation: a question asked from a rec is an Ask thread carrying the rec id,
// and it outlives the rec.
//
// applyRecs(db, results, ctx) -> {byTrigger, counts: {new, updated, retired, unchanged}, domains}

import { parseJson } from '../../store/db.mjs';
import { dayLabel } from './data.mjs';
import { servesGoals, recTopics } from '../../shared/goals.mjs';

const ACTIVE = ['proposed', 'doing', 'waiting', 'snoozed'];
const BLOCKABLE = ['proposed', 'doing'];

export function buildDef(hit, fields) {
  const r = hit.rec;
  const def = {
    id: r.id, title: r.title, summary: fields.summary, trigger: r.trigger, triggerText: r.triggerText, domain: r.domain,
    effort: r.effort, advisor: null, value: r.value, why: fields.why, mine: r.mine, kb: r.kb, cross: r.cross,
    tasks: r.tasks, qa: fields.qa,
  };
  if (r.assumptions) def.assumptions = r.assumptions;
  if (r.advisorQuestions) def.advisorQuestions = r.advisorQuestions;
  if (r.scenario) def.scenario = r.scenario;
  if (r.question) def.question = r.question;
  return def;
}

// Status-changing event = from_status differs from to_status; most recent = highest id (T6).
function lastStatusEvent(db, recId) {
  return db.prepare('SELECT * FROM rec_events WHERE rec_id = ? AND from_status IS NOT to_status ORDER BY id DESC LIMIT 1').get(recId) || null;
}

// The owner's lean for a rec, from the tradeoff curve (0 left end, 1 right end): a retirement rec
// gains when the owner leans to max retirement room (ret_life below 0.5), a tax rec when they lean
// to paying less tax now (tax_cash below 0.5), a cash rec when they lean to flexible cash.
export function curveLean(rec, curve = {}) {
  const t = recTopics(rec);
  const pos = id => (typeof curve[id] === 'number' ? curve[id] : 0.5);
  let lean = 0;
  if (t.has('retirement')) lean += 0.5 - pos('ret_life');
  if (t.has('tax')) lean += 0.5 - pos('tax_cash');
  if (t.has('cash')) lean += pos('tax_cash') - 0.5;
  return lean;
}

// Hits ordered by window close (open-ended last), then recs that serve an open goal, then the
// owner's curve lean, then catalog order. prefs: {goals, accounts, curve} (curve: {axisId: 0..1}).
export function sortOrder(results, prefs = {}) {
  const { goals = [], accounts = [], curve = {} } = prefs || {};
  const hits = results.map((r, i) => ({ r, i })).filter(x => x.r.state === 'hit').map(x => {
    const rec = x.r.hit.rec || {};
    return { ...x, serves: servesGoals(rec, goals, accounts).length ? 1 : 0, lean: curveLean(rec, curve) };
  });
  hits.sort((a, b) => {
    const ca = a.r.hit.window ? a.r.hit.window.close : null;
    const cb = b.r.hit.window ? b.r.hit.window.close : null;
    if (ca !== cb) return ca == null ? 1 : cb == null ? -1 : ca < cb ? -1 : 1;
    if (a.serves !== b.serves) return b.serves - a.serves;
    if (a.lean !== b.lean) return b.lean - a.lean;
    return a.i - b.i;
  });
  return new Map(hits.map((x, sort) => [x.r.trigger.id, sort]));
}

export function applyRecs(db, results, ctx) {
  const { clock, now, runId, prose, packOverride, warn, prefs } = ctx;
  const recRows = new Map(db.prepare('SELECT * FROM recs').all().map(r => [r.id, r]));
  const prRows = new Map(db.prepare('SELECT * FROM planner_recs').all().map(r => [r.rec_id, r]));
  const sorts = sortOrder(results, prefs);
  const counts = { new: 0, updated: 0, retired: 0, unchanged: 0 };
  const byTrigger = {};
  const domains = new Set();
  const event = db.prepare('INSERT INTO rec_events (rec_id, ts, action, arg, from_status, to_status, actor) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const record = (id, action, arg, from, to) => event.run(id, now, action, arg == null ? null : String(arg), from, to, 'planner');
  const mark = (id, outcome, domain) => {
    byTrigger[id] = outcome;
    counts[outcome] += 1;
    if (outcome !== 'unchanged') domains.add(domain);
  };
  const overridden = packId => packId != null && packOverride(packId) === 0;

  for (const res of results) {
    const t = res.trigger;
    const id = t.id;
    const rr = recRows.get(id);
    const pr = prRows.get(id);
    if (rr && !pr) {
      if (res.state === 'hit') warn('rec_id_taken');
      continue;
    }
    if (res.state === 'hit') {
      const hit = res.hit;
      const p = prose[id];
      const def = buildDef(hit, p.fields);
      const defText = JSON.stringify(def);
      const goalKinds = JSON.stringify(hit.rec.goalKinds);
      const recOwner = hit.rec.owner;
      const close = hit.window ? hit.window.close : null;
      const label = hit.window ? hit.window.label : null;
      const sort = sorts.get(id);
      if (!rr) {
        const status = overridden(hit.packId) ? 'hidden' : 'proposed';
        db.prepare(`INSERT INTO recs (id, def, status, waiting_on, wake, tasks_done, window_close, window_label, pack_id, sort, updated_at, file_id, parser, locator,
                      owner, owner_override, goal_kinds)
                    VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, 'planner', ?, ?, 0, ?)`)
          .run(id, defText, status, JSON.stringify(def.tasks.map(() => false)), close, label, hit.packId, sort, now, JSON.stringify({ trigger: id }),
            recOwner, goalKinds);
        db.prepare(`INSERT INTO planner_recs (rec_id, trigger_id, grounding_hash, prose_src, first_run, last_run, retired_at, retired_reason, retired_from, held_from)
                    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`).run(id, id, p.hash, p.src, runId, runId);
        mark(id, 'new', t.domain);
        continue;
      }
      let status = rr.status;
      let waitingOn = rr.waiting_on;
      let revived = false;
      const events = [];
      if (pr.retired_at) {
        const last = lastStatusEvent(db, id);
        if (last && last.actor === 'planner' && last.action === 'retire') {
          const to = overridden(hit.packId) ? 'hidden' : 'proposed';
          events.push(['revive', null, status, to]);
          status = to;
          waitingOn = null;
        }
        revived = true;
      }
      if (pr.held_from) {
        const last = lastStatusEvent(db, id);
        if (status === 'waiting' && last && last.actor === 'planner' && last.action === 'block') {
          events.push(['unblock', null, status, pr.held_from]);
          status = pr.held_from;
          waitingOn = null;
        }
      }
      const oldDef = parseJson(rr.def, {});
      const oldDone = parseJson(rr.tasks_done, []);
      const doneByText = new Map((Array.isArray(oldDef.tasks) ? oldDef.tasks : []).map((x, i) => [x && x.t, !!oldDone[i]]));
      const tasksDone = JSON.stringify(def.tasks.map(x => doneByText.get(x.t) ?? false));
      // An owner-set owner is never touched by the planner (through update, revive and unblock).
      const owner = rr.owner_override ? rr.owner : recOwner;
      const rowChanged = rr.def !== defText || rr.window_close !== close || rr.window_label !== label || rr.pack_id !== hit.packId
        || rr.status !== status || rr.waiting_on !== waitingOn || rr.tasks_done !== tasksDone || rr.goal_kinds !== goalKinds || rr.owner !== owner;
      if (rowChanged) {
        db.prepare(`UPDATE recs SET def = ?, status = ?, waiting_on = ?, tasks_done = ?, window_close = ?, window_label = ?, pack_id = ?, sort = ?, updated_at = ?,
                      goal_kinds = ?, owner = ? WHERE id = ?`).run(defText, status, waitingOn, tasksDone, close, label, hit.packId, sort, now, goalKinds, owner, id);
      } else if (rr.sort !== sort) {
        db.prepare('UPDATE recs SET sort = ? WHERE id = ?').run(sort, id);
      }
      for (const [action, arg, from, to] of events) record(id, action, arg, from, to);
      const prChanged = revived || pr.held_from != null || pr.grounding_hash !== p.hash || pr.prose_src !== p.src;
      if (rowChanged || prChanged) {
        db.prepare(`UPDATE planner_recs SET trigger_id = ?, grounding_hash = ?, prose_src = ?, last_run = ?, retired_at = NULL, retired_reason = NULL,
                      retired_from = NULL, held_from = NULL WHERE rec_id = ?`).run(id, p.hash, p.src, runId, id);
      }
      mark(id, revived ? 'new' : rowChanged || prChanged ? 'updated' : 'unchanged', t.domain);
      continue;
    }
    if (!pr || pr.retired_at) continue;
    if (res.state === 'blocked') {
      if (BLOCKABLE.includes(rr.status)) {
        db.prepare("UPDATE recs SET status = 'waiting', waiting_on = 'data', updated_at = ? WHERE id = ?").run(now, id);
        record(id, 'block', res.reason, rr.status, 'waiting');
        db.prepare('UPDATE planner_recs SET held_from = ?, last_run = ? WHERE rec_id = ?').run(rr.status, runId, id);
        mark(id, 'updated', t.domain);
      } else {
        mark(id, 'unchanged', t.domain);
      }
      continue;
    }
    const reason = rr.window_close && rr.window_close < clock
      ? `Its window closed on ${dayLabel(rr.window_close)}.`
      : 'The condition behind it no longer holds in your data.';
    if (ACTIVE.includes(rr.status)) {
      db.prepare("UPDATE recs SET status = 'dismissed', waiting_on = NULL, updated_at = ? WHERE id = ?").run(now, id);
      record(id, 'retire', reason, rr.status, 'dismissed');
    } else {
      // MGN2: a done, dismissed or hidden rec keeps the owner's status; the event records the
      // retirement without a status change, so it is never the planner's last word.
      record(id, 'retire', reason, rr.status, rr.status);
    }
    db.prepare('UPDATE planner_recs SET retired_at = ?, retired_reason = ?, retired_from = ?, held_from = NULL, last_run = ? WHERE rec_id = ?')
      .run(clock, reason, rr.status, runId, id);
    mark(id, 'retired', t.domain);
  }
  return { byTrigger, counts, domains };
}
