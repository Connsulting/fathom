// Job scheduler. Rules:
// 1. Period keys come from the owner's local time (settings.timezone, default America/New_York; an
//    invalid zone falls back). A period starts at its due time (plan daily 02:00, brief-email the
//    1st at 07:00, deadline-alerts daily 07:00, trash-purge daily 03:00, freshness Monday 06:00); the due key is the latest
//    period whose start is at or before now. config.clock fixes the local date at 12:00.
// 2. One attempt per (job_id, period_key): the job_runs insert claims it and the unique index
//    refuses a second claim, so a failed run is not retried that period. A tick runs only the
//    latest due period of each job, so catch-up after downtime is one run, never a backfill.
//    Manual and ingest runs use `manual:<iso ts>` and `ingest:<iso ts>` keys.
// 3. The single-row job_lock lease gates every run: taken when free or expired on every tick and
//    run, and while any handler runs an unref'd timer (every leaseMs / 3) extends it, only while
//    this holder still holds it. Without it a tick runs nothing and runNow is `locked`.
// 4. A job runs at most once at a time in this process (runNow of a running job is `running`; a
//    trigger during a run is remembered and coalesced into one rerun after it), and
//    ticks never overlap. A handler that throws never stops the scheduler.
// 5. job_runs rows record status (ok, skipped, error), duration, trigger, cost and a counts-only
//    note (numbers and booleans, top level or one object deep); error_class is an identifier (the
//    error's code, else its class name), never a message. Logs are only
//    `fathom: job <id> <status> [error_class]`.
// 6. stop() is graceful and never rejects: it clears the timers, then ticks run nothing, runNow is
//    `locked` and pending reruns are dropped; it waits for active runs up to drainMs (default 30 s)
//    and then releases the lease.
// 7. ensureJobs writes a jobs row for every JOBS entry, wired or not; only handled jobs are
//    scheduled and listed by jobs(). An unhandled job's row has no next label.
// 8. Planning runs only here: the default `plan` handler calls runPlanning with this run's id, so
//    nightly, manual (Run now, POST /api/jobs/plan/run, npm run plan) and ingest runs share the
//    lease and job_runs. On a demo store it records the run skipped and plans nothing.

import { getSetting } from '../store/db.mjs';
import { isIsoDate } from '../scenario/build.mjs';
import { ingestState } from '../ingest/freshness.mjs';
import { composeBrief } from '../email/brief.mjs';
import { sendEmail } from '../email/send.mjs';
import { runDeadlineAlerts } from './alerts.mjs';
import { runPlanning } from './planner.mjs';
import { purgeTrash } from '../api/threads.mjs';
import { defaultPackDirs } from '../packs/state.mjs';

export const DEFAULT_TIMEZONE = 'America/New_York';
const DAY = 86400000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TRIGGERS = new Set(['manual', 'ingest']);

export const JOBS = Object.freeze([
  { id: 'plan', name: 'Nightly plan refresh', cadence: 'Daily, 2:00 AM', does: 'Re-plan recommendations and deadlines from the latest data.', schedule: Object.freeze({ every: 'day', hour: 2 }) },
  { id: 'brief-email', name: 'Monthly brief email', cadence: 'Monthly, 1st at 7:00 AM', does: 'Compose the monthly brief and email it.', schedule: Object.freeze({ every: 'month', day: 1, hour: 7 }) },
  { id: 'deadline-alerts', name: 'Deadline alerts', cadence: 'Daily, 7:00 AM', does: 'Email one alert when a deadline or window is 14, 7 or 1 days away.', schedule: Object.freeze({ every: 'day', hour: 7 }) },
  { id: 'freshness', name: 'Data freshness check', cadence: 'Weekly, Monday 6:00 AM', does: 'Count stale and waiting uploads.', schedule: Object.freeze({ every: 'week', weekday: 1, hour: 6 }) },
  { id: 'trash-purge', name: 'Ask trash cleanup', cadence: 'Daily, 3:00 AM', does: 'Delete conversations that have been in Trash for 30 days.', schedule: Object.freeze({ every: 'day', hour: 3 }) },
].map(Object.freeze));
const JOB_SORT = 100;

export class SchedulerError extends Error {
  constructor(code) {
    super({ unknown_job: 'No such job', running: 'That job is already running', locked: 'Another scheduler holds the job lock' }[code] || 'Scheduler error');
    this.name = 'SchedulerError';
    this.code = code;
  }
}

// A job outcome that is not an exception from code: carries an identifier code only.
export class JobFailure extends Error {
  constructor(code) { super('Job failed'); this.name = 'JobFailure'; this.code = code; }
}

// ---------------------------------------------------------------- time

export function validTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export function ownerTimezone(db) {
  const tz = getSetting(db, 'timezone', null);
  return validTimezone(tz) ? tz : DEFAULT_TIMEZONE;
}

const formatters = new Map();
function partsFormatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
    }));
  }
  return formatters.get(tz);
}

// Wall-clock parts of an instant in a zone: {year, month, day, hour, minute, weekday (0 = Sunday)}.
export function localParts(date, tz = DEFAULT_TIMEZONE) {
  const p = Object.fromEntries(partsFormatter(tz).formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: WEEKDAYS.indexOf(p.weekday),
  };
}

// Parts for a fixed clock date: that date at 12:00.
export function clockParts(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { year: y, month: m, day: d, hour: 12, minute: 0, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

// Wall times are handled as UTC epoch ms of the local fields ("wall ms").
const wallOf = (p) => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
const wallDate = (ms) => new Date(ms).toISOString().slice(0, 10);

// Wall ms of the latest period start at or before the given parts.
function periodStart(schedule, parts) {
  const now = wallOf(parts);
  const hour = schedule.hour || 0;
  if (schedule.every === 'month') {
    const start = Date.UTC(parts.year, parts.month - 1, schedule.day || 1, hour);
    return start <= now ? start : Date.UTC(parts.year, parts.month - 2, schedule.day || 1, hour);
  }
  if (schedule.every === 'week') {
    const back = (parts.weekday - schedule.weekday + 7) % 7;
    const start = Date.UTC(parts.year, parts.month - 1, parts.day - back, hour);
    return start <= now ? start : start - 7 * DAY;
  }
  const start = Date.UTC(parts.year, parts.month - 1, parts.day, hour);
  return start <= now ? start : start - DAY;
}

function nextStart(schedule, start) {
  if (schedule.every === 'month') {
    const d = new Date(start);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours());
  }
  return start + (schedule.every === 'week' ? 7 : 1) * DAY;
}

export function periodKey(schedule, parts) {
  const start = periodStart(schedule, parts);
  return schedule.every === 'month' ? wallDate(start).slice(0, 7) : wallDate(start);
}

// The instant a wall time occurs in a zone (the later offset wins across a DST gap).
function instantOf(wall, tz) {
  let t = wall;
  for (let i = 0; i < 3; i++) {
    const offset = wallOf(localParts(t, tz)) - Math.floor(t / 60000) * 60000;
    const next = wall - offset;
    if (next === t) break;
    t = next;
  }
  return new Date(t);
}

// The instant the next period starts after `now` (or after the fixed clock date at 12:00).
export function nextRunAt(schedule, now, tz = DEFAULT_TIMEZONE, clock = null) {
  const parts = clock ? clockParts(clock) : localParts(now, tz);
  return instantOf(nextStart(schedule, periodStart(schedule, parts)), tz);
}

const labelFormatters = new Map();
function timeLabel(date, tz) {
  if (!labelFormatters.has(tz)) {
    labelFormatters.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
  }
  return labelFormatters.get(tz).format(new Date(date));
}

// ---------------------------------------------------------------- rows

const runOut = (r) => (r ? {
  id: r.id, jobId: r.job_id, status: r.status, trigger: r.trigger ?? null, periodKey: r.period_key ?? null,
  startedAt: r.started_at, finishedAt: r.finished_at ?? null, durationMs: r.duration_ms ?? null,
  errorClass: r.error_class ?? null, costUsd: r.cost_usd ?? null, note: noteOf(r.note),
} : null);

function noteOf(raw) {
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const isCount = (x) => (typeof x === 'number' && Number.isFinite(x)) || typeof x === 'boolean';
const isPlain = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

// Identifier keys whose values are counts, plus (when nested) objects of the same one level deep.
function countsOf(v, nested) {
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (!IDENT.test(k)) continue;
    if (isCount(x)) out[k] = x;
    else if (nested && isPlain(x)) {
      const inner = countsOf(x, false);
      if (Object.keys(inner).length) out[k] = inner;
    }
  }
  return out;
}

// A counts-only note from an object or JSON object text, else null: finite numbers and booleans,
// at the top level or in an object one level down (the planner's recs and prose counts). Strings,
// arrays and anything deeper are dropped.
function countsNote(note) {
  let v = note;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  if (!isPlain(v)) return null;
  const out = countsOf(v, true);
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

function errorClassOf(e) {
  if (e && typeof e.code === 'string' && IDENT.test(e.code)) return e.code;
  const name = e && e.constructor && e.constructor.name;
  return typeof name === 'string' && IDENT.test(name) ? name : 'Error';
}

const isUniqueViolation = (e) => e && (e.errcode === 2067 || e.errcode === 1555 || /UNIQUE constraint failed/.test(String(e.message)));

// ---------------------------------------------------------------- scheduler

export function createScheduler({
  db, config = {}, engine = null, handlers = {}, transport = null, now = () => new Date(),
  tickMs = 60000, leaseMs = 300000, drainMs = 30000, holder = `fathom-${process.pid}`, log = console,
} = {}) {
  if (!db) throw new TypeError('A store is required');
  const handled = JOBS.filter((j) => typeof handlers[j.id] === 'function');
  const byId = new Map(handled.map((j) => [j.id, j]));
  const fixed = config && isIsoDate(config.clock) ? config.clock : null;
  const running = new Set();
  // Triggers that arrived while their job was running: jobId -> reason, coalesced to one rerun.
  const pending = new Map();
  // Promises of executions in flight, awaited by stop().
  const active = new Set();
  let ticking = null;
  let timer = null;
  let first = null;
  let renewer = null;
  let stopping = false;

  const q = {
    ensure: db.prepare('INSERT OR IGNORE INTO jobs (id, name, cadence, does, cost, next_label, last_label, enabled, sort) VALUES (?, ?, ?, ?, NULL, ?, ?, 1, ?)'),
    labels: db.prepare('UPDATE jobs SET next_label = ?, last_label = ? WHERE id = ?'),
    define: db.prepare('UPDATE jobs SET name = ?, cadence = ?, does = ? WHERE id = ? AND (name IS NOT ? OR cadence IS NOT ? OR does IS NOT ?)'),
    take: db.prepare(`INSERT INTO job_lock (id, holder, expires_at) VALUES (1, ?, ?)
                      ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
                      WHERE job_lock.holder = excluded.holder OR job_lock.expires_at <= ? RETURNING holder`),
    renew: db.prepare('UPDATE job_lock SET expires_at = ? WHERE id = 1 AND holder = ?'),
    release: db.prepare('DELETE FROM job_lock WHERE id = 1 AND holder = ?'),
    claim: db.prepare("INSERT INTO job_runs (job_id, started_at, status, period_key, trigger) VALUES (?, ?, 'running', ?, ?) RETURNING id"),
    finish: db.prepare('UPDATE job_runs SET status = ?, finished_at = ?, duration_ms = ?, error_class = ?, cost_usd = ?, note = ? WHERE id = ?'),
    run: db.prepare('SELECT * FROM job_runs WHERE id = ?'),
    last: db.prepare('SELECT * FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT 1'),
    runs: db.prepare('SELECT * FROM job_runs ORDER BY id DESC LIMIT ?'),
  };

  const at = () => new Date(now());
  const tz = () => ownerTimezone(db);
  const partsAt = (t, zone) => (fixed ? clockParts(fixed) : localParts(t, zone));
  // The date handlers treat as today: the fixed clock, the stored clock, else the local date.
  function clockFor(t, zone) {
    if (fixed) return fixed;
    const stored = getSetting(db, 'clock', null);
    if (isIsoDate(stored)) return stored;
    const p = localParts(t, zone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  }

  function lease(t) {
    const iso = t.toISOString();
    return !!q.take.get(holder, new Date(t.getTime() + leaseMs).toISOString(), iso);
  }

  // Extends the lease only while this holder holds it; taking a lease is lease()'s job.
  function renew() {
    try { q.renew.run(new Date(at().getTime() + leaseMs).toISOString(), holder); } catch { /* store closed */ }
  }

  function stopRenewing() {
    if (renewer) clearInterval(renewer);
    renewer = null;
  }

  function ensureJobs(t = at()) {
    const zone = tz();
    JOBS.forEach((j, i) => {
      q.ensure.run(j.id, j.name, j.cadence, j.does, null, null, JOB_SORT + i);
      q.define.run(j.name, j.cadence, j.does, j.id, j.name, j.cadence, j.does);
      const last = q.last.get(j.id);
      const next = byId.has(j.id) ? timeLabel(nextRunAt(j.schedule, t, zone, fixed), zone) : null;
      q.labels.run(next, last ? timeLabel(last.started_at, zone) : null, j.id);
    });
  }

  function execute(job, opts) {
    const p = executeOnce(job, opts);
    active.add(p);
    p.then(() => active.delete(p), () => active.delete(p));
    return p;
  }

  // Claims (jobId, key) and runs the handler. Returns the finished run, or null when already claimed.
  async function executeOnce(job, { key, trigger, t, zone }) {
    let id;
    try {
      id = q.claim.get(job.id, t.toISOString(), key, trigger).id;
    } catch (e) {
      if (isUniqueViolation(e)) return null;
      throw e;
    }
    running.add(job.id);
    if (!renewer && !stopping) {
      renewer = setInterval(renew, Math.max(1, Math.floor(leaseMs / 3)));
      renewer.unref?.();
    }
    const started = performance.now();
    let status = 'ok';
    let errorClass = null;
    let cost = null;
    let note = null;
    try {
      const ctx = { db, config, engine, transport, now: t.toISOString(), clock: clockFor(t, zone), periodKey: key, trigger, jobRunId: id };
      const out = (await handlers[job.id](ctx)) || {};
      if (out.status === 'skipped') status = 'skipped';
      if (Number.isFinite(out.costUsd) && out.costUsd >= 0) cost = out.costUsd;
      note = countsNote(out.note);
    } catch (e) {
      status = 'error';
      errorClass = errorClassOf(e);
      if (Number.isFinite(e && e.costUsd) && e.costUsd >= 0) cost = e.costUsd;
    } finally {
      running.delete(job.id);
      if (!running.size) stopRenewing();
    }
    q.finish.run(status, at().toISOString(), Math.max(0, Math.round(performance.now() - started)), errorClass, cost, note, id);
    log.log(`fathom: job ${job.id} ${status}${errorClass ? ` ${errorClass}` : ''}`);
    try { ensureJobs(); } catch { /* labels refresh on the next tick */ }
    const result = runOut(q.run.get(id));
    const again = pending.get(job.id);
    if (again && !stopping) {
      pending.delete(job.id);
      // Not awaited: the finished run's caller must not wait on the rerun.
      runOff(job.id, again).catch(() => { log.log(`fathom: job ${job.id} error store`); });
    }
    return result;
  }

  async function tickOnce() {
    if (stopping) return;
    const t = at();
    ensureJobs(t);
    if (!lease(t)) return;
    const zone = tz();
    for (const job of handled) {
      if (stopping) break;
      if (running.has(job.id)) continue;
      try {
        await execute(job, { key: periodKey(job.schedule, partsAt(t, zone)), trigger: 'scheduled', t, zone });
      } catch {
        log.log(`fathom: job ${job.id} error store`);
      }
    }
  }

  function tick() {
    ticking ??= tickOnce().finally(() => { ticking = null; });
    return ticking;
  }

  // A manual or ingest run of a handled job, under the lease. Keys are unique per instant.
  async function runOff(jobId, reason) {
    const job = byId.get(jobId);
    if (!job) throw new SchedulerError('unknown_job');
    if (running.has(jobId)) throw new SchedulerError('running');
    const t = at();
    if (stopping || !lease(t)) throw new SchedulerError('locked');
    ensureJobs(t);
    const zone = tz();
    const base = `${reason}:${t.toISOString()}`;
    for (let n = 1; n <= 100; n++) {
      const run = await execute(job, { key: n === 1 ? base : `${base}+${n}`, trigger: reason, t, zone });
      if (run) return run;
    }
    throw new SchedulerError('running');
  }

  return {
    holder,
    tick,
    runNow: (jobId) => runOff(jobId, 'manual'),
    // Fire-and-forget friendly: resolves to the run, or null when there is no handler or it cannot run now.
    async trigger(jobId, reason = 'ingest') {
      if (!byId.has(jobId) || !TRIGGERS.has(reason)) return null;
      if (running.has(jobId)) { if (!stopping) pending.set(jobId, reason); return null; }
      try { return await runOff(jobId, reason); } catch { return null; }
    },
    start() {
      if (timer) return;
      first = setTimeout(() => { first = null; tick().catch(() => {}); }, 0);
      first.unref?.();
      timer = setInterval(() => { tick().catch(() => {}); }, tickMs);
      timer.unref?.();
    },
    // Resolves once active runs settle (or drainMs passes) and the lease is released. Never rejects.
    async stop() {
      stopping = true;
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
      first = null;
      timer = null;
      stopRenewing();
      pending.clear();
      let drain;
      await Promise.race([
        Promise.allSettled([...active]),
        new Promise((r) => { drain = setTimeout(r, drainMs); drain.unref?.(); }),
      ]);
      clearTimeout(drain);
      try { q.release.run(holder); } catch { /* store already closed */ }
    },
    jobs() {
      const t = at();
      const zone = tz();
      try { ensureJobs(t); } catch { /* listing does not depend on the rows */ }
      return handled.map((j) => {
        const nextAt = nextRunAt(j.schedule, t, zone, fixed);
        return { id: j.id, name: j.name, cadence: j.cadence, does: j.does, lastRun: runOut(q.last.get(j.id)), next: timeLabel(nextAt, zone), nextAt: nextAt.toISOString() };
      });
    },
    runs({ limit = 20 } = {}) {
      const n = Math.max(1, Math.min(200, Number.isInteger(limit) ? limit : 20));
      return q.runs.all(n).map(runOut);
    },
  };
}

// ---------------------------------------------------------------- default handlers

// The server's handlers. `plan` is the only path that plans: on a real store it runs the planner
// with this run's id and the run's clock, and returns the planner's counts as the note plus the
// whole planner result as `planning` (the scheduler ignores it; npm run plan prints its warning
// codes). On a demo store it plans nothing and the run is recorded skipped.
export function defaultHandlers({ publicUrl = null } = {}) {
  return {
    async plan(ctx) {
      if (getSetting(ctx.db, 'mode', null) === 'demo') return { status: 'skipped' };
      const planning = await runPlanning(ctx.db, ctx.engine || null, {
        now: ctx.clock, packDirs: defaultPackDirs(ctx.config && ctx.config.dataDir), runId: ctx.jobRunId,
      });
      return { costUsd: planning.costUsd, note: planning.counts, planning };
    },
    async 'brief-email'(ctx) {
      const brief = await composeBrief(ctx.db, { clock: ctx.clock, publicUrl, engine: ctx.engine });
      const send = await sendEmail(ctx.db, {
        transport: ctx.transport, kind: 'brief', subject: brief.subject, text: brief.text, html: brief.html, now: ctx.now, jobRunId: ctx.jobRunId,
      });
      if (send.status !== 'sent') { const e = new JobFailure(`email_${send.errorCode || 'other'}`); e.costUsd = brief.costUsd; throw e; }
      return { costUsd: brief.costUsd, note: { sent: 1, figures: brief.model.figures.length, modelSummary: brief.summarySrc === 'model' } };
    },
    async 'deadline-alerts'(ctx) {
      const out = await runDeadlineAlerts(ctx.db, { clock: ctx.clock, transport: ctx.transport, publicUrl, now: ctx.now, jobRunId: ctx.jobRunId });
      if (out.send && out.send.status !== 'sent') throw new JobFailure(`email_${out.send.errorCode || 'other'}`);
      return { costUsd: 0, note: { alerts: out.alerts, sent: out.send ? 1 : 0 } };
    },
    async 'trash-purge'(ctx) {
      const purged = purgeTrash(ctx.db, `${ctx.clock}T${ctx.now.slice(11)}`);
      return { costUsd: 0, note: { purged } };
    },
    async freshness(ctx) {
      const s = ingestState(ctx.db, { clock: ctx.clock });
      return {
        costUsd: 0,
        note: { sources: s.sources.length, stale: s.sources.filter((x) => x.state === 'stale').length, pending: s.pending, waiting: s.waiting.length },
      };
    },
  };
}
