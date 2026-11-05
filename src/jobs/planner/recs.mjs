// Recs upsert, blocking and retirement for planner-owned recs (base plan, R13, R14, S10, S12, T6).
// The owner's status, task flags and conversation always survive; the planner only changes status
// when its own retire or block event was the last word.
//
// applyRecs(db, results, ctx) -> {byTrigger, counts: {new, updated, retired, unchanged}, domains}

import { parseJson } from '../../store/db.mjs';
import { dayLabel } from './data.mjs';

const ACTIVE = ['proposed', 'accepted', 'doing', 'waiting', 'snoozed'];
const BLOCKABLE = ['proposed', 'accepted', 'doing'];

export function buildDef(hit, fields) {
  const r = hit.rec;
  const def = {
    id: r.id, title: r.title, summary: fields.summary, trigger: r.trigger, triggerText: r.triggerText, domain: r.domain,
    effort: r.effort, advisor: null, value: r.value, why: fields.why, mine: r.mine, kb: r.kb, cross: r.cross,
    tasks: r.tasks.map(t => ({ t: t.t })), qa: fields.qa,
  };
  if (r.scenario) def.scenario = r.scenario;
  return def;
}

// Status-changing event = from_status differs from to_status; most recent = highest id (T6).
function lastStatusEvent(db, recId) {
  return db.prepare('SELECT * FROM rec_events WHERE rec_id = ? AND from_status IS NOT to_status ORDER BY id DESC LIMIT 1').get(recId) || null;
}

// Hits ordered by window close (open-ended last), then catalog order.
export function sortOrder(results) {
  const hits = results.map((r, i) => ({ r, i })).filter(x => x.r.state === 'hit');
  hits.sort((a, b) => {
    const ca = a.r.hit.window ? a.r.hit.window.close : null;
    const cb = b.r.hit.window ? b.r.hit.window.close : null;
    if (ca !== cb) return ca == null ? 1 : cb == null ? -1 : ca < cb ? -1 : 1;
    return a.i - b.i;
  });
  return new Map(hits.map((x, sort) => [x.r.trigger.id, sort]));
}

export function applyRecs(db, results, ctx) {
  const { clock, now, runId, prose, packOverride, warn } = ctx;
  const stamp = `${clock}T${now.slice(11)}`;
  const recRows = new Map(db.prepare('SELECT * FROM recs').all().map(r => [r.id, r]));
  const prRows = new Map(db.prepare('SELECT * FROM planner_recs').all().map(r => [r.rec_id, r]));
  const sorts = sortOrder(results);
  const counts = { new: 0, updated: 0, retired: 0, unchanged: 0 };
  const byTrigger = {};
  const domains = new Set();
  const event = db.prepare('INSERT INTO rec_events (rec_id, ts, action, arg, from_status, to_status, actor) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const record = (id, action, arg, from, to) => event.run(id, now, action, arg == null ? null : String(arg), from, to, 'planner');
  const mark = (id, outcome, domain) => {
    byTrigger[id] = outcome;
    counts[outcome === 'new' ? 'new' : outcome] += 1;
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
      const close = hit.window ? hit.window.close : null;
      const label = hit.window ? hit.window.label : null;
      const sort = sorts.get(id);
      if (!rr) {
        const status = overridden(hit.packId) ? 'hidden' : 'proposed';
        db.prepare(`INSERT INTO recs (id, def, status, waiting_on, wake, tasks_done, window_close, window_label, pack_id, sort, updated_at, file_id, parser, locator)
                    VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, 'planner', ?)`)
          .run(id, defText, status, JSON.stringify(def.tasks.map(() => false)), close, label, hit.packId, sort, now, JSON.stringify({ trigger: id }));
        db.prepare(`INSERT INTO planner_recs (rec_id, trigger_id, grounding_hash, prose_src, first_run, last_run, retired_at, retired_reason, retired_from, held_from)
                    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`).run(id, id, p.hash, p.src, runId, runId);
        const conv = db.prepare('INSERT OR IGNORE INTO conversations (key, created_at) VALUES (?, ?)').run(id, stamp);
        if (Number(conv.changes) === 1) {
          db.prepare("INSERT INTO messages (conversation_key, role, text, refs, notice, ts) VALUES (?, 'fathom', ?, '[]', 0, ?)").run(id, `<p>${def.summary}</p>`, stamp);
        }
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
      const rowChanged = rr.def !== defText || rr.window_close !== close || rr.window_label !== label || rr.pack_id !== hit.packId
        || rr.status !== status || rr.waiting_on !== waitingOn || rr.tasks_done !== tasksDone;
      if (rowChanged) {
        db.prepare(`UPDATE recs SET def = ?, status = ?, waiting_on = ?, tasks_done = ?, window_close = ?, window_label = ?, pack_id = ?, sort = ?, updated_at = ?
                    WHERE id = ?`).run(defText, status, waitingOn, tasksDone, close, label, hit.packId, sort, now, id);
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
    }
    db.prepare('UPDATE planner_recs SET retired_at = ?, retired_reason = ?, retired_from = ?, held_from = NULL, last_run = ? WHERE rec_id = ?')
      .run(clock, reason, rr.status, runId, id);
    mark(id, 'retired', t.domain);
  }
  return { byTrigger, counts, domains };
}
