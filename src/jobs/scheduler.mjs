import { sameStore } from '../storage/index.mjs';
import { DEFAULT_TIMEZONE, ownerTimezone } from '../shared/timezone.mjs';
import { createJev } from '../categories/jev.mjs';
import { selectionFor } from '../models/config.mjs';
import { createSpendLedger } from '../engine/runtime.mjs';
import { guessClosedOptions } from '../ingest/jev.mjs';
import { guessCategories } from '../categories/guess.mjs';
// Job scheduler. Rules:
// 1. Period keys come from the owner's local time (settings.timezone, default America/New_York; an
//    invalid zone falls back). A period starts at its due time (plan daily 02:00, brief-email the
//    1st at 07:00, deadline-alerts daily 07:00, trash-purge daily 03:00, freshness Monday 06:00, confirm-guess daily 03:00); the due key is the latest
//    period whose start is at or before now. config.clock fixes the local date at 12:00.
// 2. One attempt per (job_id, period_key): the job_runs insert claims it and the unique index
//    refuses a second claim. A period run that failed with a transient error class (isTransient) or
//    was interrupted gets one retry, its own claim under key `<period_key>+retry` with trigger
//    `retry`, on the first tick at or after finished_at + retryMs (default 15 minutes). A `+retry`
//    run, a skipped run and any other failure are not retried that period. A tick runs only the
//    latest due period of each job, so catch-up after downtime is one run, never a backfill.
//    Manual, ingest and confirm runs use `manual:<iso ts>`, `ingest:<iso ts>` and `confirm:<iso ts>` keys.
// 3. The single-row job_lock lease gates every run: taken when free or expired on every tick and
//    run, and while any handler runs an unref'd timer (every leaseMs / 3) extends it, only while
//    this holder still holds it. Without it a tick runs nothing and runNow is `locked`.
// 4. A job runs at most once at a time in this process (runNow of a running job is `running`; a
//    trigger during a run is remembered and coalesced into one rerun after it), and
//    ticks never overlap. A handler that throws never stops the scheduler.
// 5. job_runs rows record status (ok, skipped, error, interrupted), duration, trigger, cost and a counts-only
//    note (numbers and booleans, top level or one object deep); error_class is an identifier (the
//    error's code, else its class name), never a message. Logs are only
//    `fathom: job <id> <status> [error_class]`, plus one info-level lock refusal per job and household.
// 6. stop() is graceful and never rejects: it clears the timers, then ticks run nothing, runNow is
//    `locked` and pending reruns are dropped; it waits for active runs up to drainMs (default 30 s)
//    and then releases the lease.
// 7. ensureJobs writes a jobs row for every JOBS entry, wired or not; only handled jobs are
//    scheduled and listed by jobs(). An unhandled job's row has no next label.
// 8. Planning runs only here: the default `plan` handler calls runPlanning with this run's id, so
//    nightly, manual (Run now, POST /api/jobs/plan/run, npm run plan) and ingest runs share the
//    lease and job_runs. On a demo store it records the run skipped and plans nothing.
// 9. soon(jobId, reason, {immediate}) debounces triggers: each call restarts a debounceMs timer
//    (default 30 s) and the job is triggered once when it fires, or at once when immediate. stop()
//    drops a pending one. Confirm answers use it so a burst of answers plans once.
// 10. allowed() (the household's outbound jobs flag) is checked in the single claim path, before
//    the job_runs row is claimed, so ticks, triggers, debounced and pending reruns and runNow all
//    pass it: while it is false nothing is claimed or run, ticks and triggers do nothing and runNow
//    throws SchedulerError('paused'). Ticks skip before any write (job rows, labels, the lease),
//    and jobs() lists without refreshing job rows while paused.
// 11. Handlers get ctx.household, the household context (household() at run time), beside db,
//    config, engine and transport, all of that one household.
// 12. Registry schedulers share round-robin admission: one handler per household and two for the
//    instance. Queued runs recheck admission and the lease before claiming a local job_runs row.
// 13. Interrupted recovery: once a tick holds the lease, every `running` row that is not one of
//    this process's in-flight runs was left by a holder that died (holding the lease proves no
//    other holder is running), so it is marked `interrupted` (finished_at now, error_class
//    `interrupted`) and logged `fathom: job <id> interrupted`; rule 2 then retries it. A running
//    row under another holder's live lease is left alone: the lease take fails and nothing runs.
// 14. schedule() is read-only: [{ id, nextAt, retryMs }] for handled jobs, no store writes. SQLite
//    storage_busy errors are recorded as error_class `store_locked`.
// 15. Import resume: once a tick holds the lease and household() owns this db, it starts one
//    resumeImports pass (src/ingest/pipeline.mjs) unless one is running, as actor `fathom`. The
//    tick does not await it; it is tracked in the active set, so stop() and idle() wait for it.

import { getSetting } from '../store/db.mjs';
import { createJobDispatcher } from './dispatch.mjs';
import { isIsoDate } from '../scenario/build.mjs';
import { refreshFreshness } from '../ingest/freshness.mjs';
import { composeBrief } from '../email/brief.mjs';
import { sendEmail } from '../email/send.mjs';
import { runDeadlineAlerts } from './alerts.mjs';
import { runPlanning } from './planner.mjs';
import { purgeTrash } from '../api/threads.mjs';
import { resolvePending } from '../resolve/index.mjs';
import { readOwnerNotes } from '../resolve/owner-said.mjs';
import { defaultPackDirs } from '../packs/state.mjs';
import { syncSimplefin, createFakeSimplefin } from '../ingest/simplefin.mjs';
import { withoutPrincipal } from '../platform/model-budget.mjs';
import { isTransient } from './transient.mjs';
import { BACKGROUND_ACTOR } from '../ingest/file-status.mjs';
import { forEachSeries, mapSeries } from '../shared/series.mjs';

export { isTransient };

const DAY = 86400000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TRIGGERS = new Set(['manual', 'ingest', 'confirm', 'decide', 'resolve']);
const RETRY_MS = 15 * 60000;

// Resolver stop causes the confirm-guess note records under stoppedBy (src/resolve/index.mjs).
const STOP_CAUSES = new Set(['engine_paused', 'engine_off', 'funding_unavailable', 'budget']);

export const JOBS = Object.freeze([
  { id: 'plan', name: 'Nightly plan refresh', cadence: 'Daily, 2:00 AM', does: 'Re-plan recommendations and deadlines from the latest data.', schedule: Object.freeze({ every: 'day', hour: 2 }) },
  { id: 'brief-email', name: 'Monthly brief email', cadence: 'Monthly, 1st at 7:00 AM', does: 'Compose the monthly brief and email it.', schedule: Object.freeze({ every: 'month', day: 1, hour: 7 }) },
  { id: 'deadline-alerts', name: 'Deadline alerts', cadence: 'Daily, 7:00 AM', does: 'Email one alert when a deadline or window is 14, 7 or 1 days away.', schedule: Object.freeze({ every: 'day', hour: 7 }) },
  { id: 'freshness', name: 'Data freshness check', cadence: 'Weekly, Monday 6:00 AM', does: 'Count stale and waiting uploads.', schedule: Object.freeze({ every: 'week', weekday: 1, hour: 6 }) },
  { id: 'trash-purge', name: 'Ask trash cleanup', cadence: 'Daily, 3:00 AM', does: 'Delete conversations that have been in Trash for 30 days.', schedule: Object.freeze({ every: 'day', hour: 3 }) },
  { id: 'confirm-guess', name: 'Resolve open questions', cadence: 'Daily, 3:00 AM', does: 'Answer supported choices from stored evidence, with Undo.', schedule: Object.freeze({ every: 'day', hour: 3 }) },
  { id: 'simplefin-sync', name: 'Bank and brokerage sync', cadence: 'Daily, 5:00 AM', does: 'Read balances and transactions from SimpleFIN Bridge, read-only.', schedule: Object.freeze({ every: 'day', hour: 5 }) },
].map(Object.freeze));
const JOB_SORT = 100;

export class SchedulerError extends Error {
  constructor(code) {
    super({ unknown_job: 'No such job', running: 'That job is already running', locked: 'Another scheduler holds the job lock', paused: 'Outbound jobs are paused' }[code] || 'Scheduler error');
    this.name = 'SchedulerError';
    this.code = code;
  }
}

// A job outcome that is not an exception from code: carries an identifier code only.
export class JobFailure extends Error {
  constructor(code) { super('Job failed'); this.name = 'JobFailure'; this.code = code; }
}

// ---------------------------------------------------------------- time


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
  if (e?.code === 'storage_busy') return 'store_locked';
  if (e && typeof e.code === 'string' && IDENT.test(e.code)) return e.code;
  const name = e && e.constructor && e.constructor.name;
  return typeof name === 'string' && IDENT.test(name) ? name : 'Error';
}

const isUniqueViolation = (e) => e?.code === 'constraint_unique';

// ---------------------------------------------------------------- scheduler

export function createScheduler({
  db, config = {}, engine = null, handlers = {}, transport = null, dispatcher = createJobDispatcher(), now = () => new Date(), allowed = () => true, household = () => null,
  tickMs = 60000, leaseMs = 300000, drainMs = 30000, debounceMs = 30000, retryMs = RETRY_MS, holder = `fathom-${process.pid}`, log = console,
} = {}) {
  if (!db) throw new TypeError('A store is required');
  if (typeof allowed !== 'function' || typeof household !== 'function') throw new TypeError('Invalid scheduler admission');
  const handled = JOBS.filter((j) => typeof handlers[j.id] === 'function');
  const byId = new Map(handled.map((j) => [j.id, j]));
  const fixed = config && isIsoDate(config.clock) ? config.clock : null;
  const running = new Set();
  // job_runs ids this process claimed and has not finished (rule 13).
  const inFlight = new Set();
  const lockRefusals = new Map();
  // Triggers that arrived while their job was running: jobId -> reason, coalesced to one rerun.
  const pending = new Map();
  // Promises of executions in flight, awaited by stop().
  const active = new Set();
  let ticking = null;
  // The import resume pass in flight (rule 15), or null.
  let resuming = null;
  let timer = null;
  let first = null;
  let renewer = null;
  let executing = 0;
  let stopping = false;
  // Debounced triggers: jobId -> timer.
  const soonTimers = new Map();

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
    period: db.prepare('SELECT * FROM job_runs WHERE job_id = ? AND period_key = ?'),
    stale: db.prepare("SELECT id, job_id FROM job_runs WHERE status = 'running'"),
    interrupt: db.prepare("UPDATE job_runs SET status = 'interrupted', finished_at = ?, error_class = 'interrupted' WHERE id = ? AND status = 'running'"),
    runs: db.prepare('SELECT * FROM job_runs ORDER BY id DESC LIMIT ?'),
  };

  const at = () => new Date(now());
  const tz = async () => await ownerTimezone(db);
  const partsAt = (t, zone) => (fixed ? clockParts(fixed) : localParts(t, zone));
  // The date handlers treat as today: the fixed clock, the stored clock, else the local date.
  async function clockFor(t, zone) {
    if (fixed) return fixed;
    const stored = await getSetting(db, 'clock', null);
    if (isIsoDate(stored)) return stored;
    const p = localParts(t, zone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  }

  function lockRefused(jobId) {
    const id = household()?.householdId ?? holder;
    if (!lockRefusals.has(id)) lockRefusals.set(id, new Set());
    const jobs = lockRefusals.get(id);
    if (jobs.has(jobId)) return;
    jobs.add(jobId);
    log.info?.(`fathom: job ${jobId} locked`, { householdId: id });
  }

  async function lease(t) {
    const iso = t.toISOString();
    return !!await q.take.get(holder, new Date(t.getTime() + leaseMs).toISOString(), iso);
  }

  // Extends the lease only while this holder holds it; taking a lease is lease()'s job.
  async function renew() {
    try { await q.renew.run(new Date(at().getTime() + leaseMs).toISOString(), holder); } catch { /* store closed */ }
  }

  function stopRenewing() {
    if (renewer) clearInterval(renewer);
    renewer = null;
  }

  async function ensureJobs(t = at()) {
    const zone = await tz();
    await forEachSeries(JOBS, async (j, i) => {
      await q.ensure.run(j.id, j.name, j.cadence, j.does, null, null, JOB_SORT + i);
      await q.define.run(j.name, j.cadence, j.does, j.id, j.name, j.cadence, j.does);
      const last = await q.last.get(j.id);
      const next = byId.has(j.id) ? timeLabel(nextRunAt(j.schedule, t, zone, fixed), zone) : null;
      await q.labels.run(next, last ? timeLabel(last.started_at, zone) : null, j.id);
    });
  }

  function execute(job, opts) {
    const captured = household();
    running.add(job.id);
    const p = dispatcher.run(captured?.householdId ?? holder, async () => {
      if (stopping) throw new SchedulerError('locked');
      if (await allowed() !== true) throw new SchedulerError('paused');
      if (!await lease(at())) { lockRefused(job.id); throw new SchedulerError('locked'); }
      executing++;
      return executeOnce(job, { ...opts, household: captured }).finally(() => {
        if (--executing === 0) stopRenewing();
      });
    }).finally(async () => {
      running.delete(job.id);
      const again = pending.get(job.id);
      pending.delete(job.id);
      if (again && !stopping) trigger(job.id, again).catch(() => {});
    });
    active.add(p);
    p.then(() => active.delete(p), () => active.delete(p));
    return p;
  }

  // Claims (jobId, key) and runs the handler. Returns the finished run, or null when already claimed.
  async function executeOnce(job, { key, trigger, t, zone, household: captured }) {
    if (await allowed() !== true) throw new SchedulerError('paused');
    let id;
    try {
      id = (await q.claim.get(job.id, t.toISOString(), key, trigger)).id;
    } catch (e) {
      if (isUniqueViolation(e)) return null;
      throw e;
    }
    inFlight.add(id);
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
      const ctx = { db, config, engine, transport, household: captured, now: t.toISOString(), clock: await clockFor(t, zone), periodKey: key, trigger, jobRunId: id, triggerJob: (jobId, reason = 'ingest') => triggerJob(jobId, reason) };
      // A job is system-initiated even when a request triggered it: no request principal.
      const out = (await withoutPrincipal(() => handlers[job.id](ctx))) || {};
      if (out.status === 'skipped') status = 'skipped';
      if (Number.isFinite(out.costUsd) && out.costUsd >= 0) cost = out.costUsd;
      note = countsNote(out.note);
    } catch (e) {
      status = 'error';
      errorClass = errorClassOf(e);
      if (Number.isFinite(e && e.costUsd) && e.costUsd >= 0) cost = e.costUsd;
    }
    try {
      await q.finish.run(status, at().toISOString(), Math.max(0, Math.round(performance.now() - started)), errorClass, cost, note, id);
    } finally { inFlight.delete(id); }
    log.log(`fathom: job ${job.id} ${status}${errorClass ? ` ${errorClass}` : ''}`);
    try { await ensureJobs(); } catch { /* labels refresh on the next tick */ }
    const result = runOut(await q.run.get(id));
    return result;
  }

  async function tickOnce() {
    if (stopping) return;
    const t = at();
    if (await allowed() !== true) return;
    await ensureJobs(t);
    if (!await lease(t)) {
      for (const job of handled) if (!running.has(job.id)) lockRefused(job.id);
      return;
    }
    await recoverInterrupted(t);
    resumeImports(t);
    const zone = await tz();
    for (const job of handled) {
      if (stopping) break;
      if (running.has(job.id)) continue;
      try {
        const key = periodKey(job.schedule, partsAt(t, zone));
        const run = await execute(job, { key, trigger: 'scheduled', t, zone });
        if (run === null && await retryDue(job, key, t)) await execute(job, { key: `${key}+retry`, trigger: 'retry', t, zone });
      } catch (e) {
        if (e instanceof SchedulerError && e.code === 'paused') break;
        if (e instanceof SchedulerError && e.code === 'locked') continue;
        log.log(`fathom: job ${job.id} error store`);
      }
    }
  }

  // Rule 13: called only while this tick holds the lease.
  async function recoverInterrupted(t) {
    for (const r of await q.stale.all()) {
      if (inFlight.has(r.id)) continue;
      if ((await q.interrupt.run(t.toISOString(), r.id)).changes) log.log(`fathom: job ${r.job_id} interrupted`);
    }
  }

  // Rule 15: called only while this tick holds the lease. Not awaited: a model call must not delay jobs.
  function resumeImports(t) {
    const h = household();
    if (resuming || stopping || !h || !sameStore(h.db, db) || !(h.inFlight instanceof Set)) return;
    const p = withoutPrincipal(async () => {
      const { resumeImports: resume } = await import('../ingest/pipeline.mjs');
      await resume(h.db, { household: h, db: h.db, config, engine: h.engine, scheduler: h.scheduler, actorId: BACKGROUND_ACTOR, now: t.toISOString() });
    }).catch((e) => { log.log(`fathom: import resume error ${errorClassOf(e)}`); }).finally(() => { resuming = null; active.delete(p); });
    resuming = p;
    active.add(p);
  }

  // Rule 2: the period's claimed run failed transiently or was interrupted, has no retry yet and
  // finished at least retryMs ago.
  async function retryDue(job, key, t) {
    const row = await q.period.get(job.id, key);
    if (!row || !(row.status === 'interrupted' || (row.status === 'error' && isTransient(row.error_class)))) return false;
    if (await q.period.get(job.id, `${key}+retry`)) return false;
    const done = Date.parse(row.finished_at ?? '');
    return Number.isFinite(done) && done + retryMs <= t.getTime();
  }

  async function tick() {
    ticking ??= tickOnce().finally(() => { ticking = null; });
    return ticking;
  }

  // A manual or ingest run of a handled job, under the lease. Keys are unique per instant.
  async function runOff(jobId, reason) {
    const job = byId.get(jobId);
    if (!job) throw new SchedulerError('unknown_job');
    if (running.has(jobId)) throw new SchedulerError('running');
    const t = at();
    if (await allowed() !== true) throw new SchedulerError('paused');
    if (stopping) throw new SchedulerError('locked');
    if (!await lease(t)) { lockRefused(jobId); throw new SchedulerError('locked'); }
    await ensureJobs(t);
    const zone = await tz();
    const base = `${reason}:${t.toISOString()}`;
    for (let n = 1; n <= 100; n++) {
      const run = await execute(job, { key: n === 1 ? base : `${base}+${n}`, trigger: reason, t, zone });
      if (run) return run;
    }
    throw new SchedulerError('running');
  }

  // Fire-and-forget friendly: resolves to the run, or null when there is no handler or it cannot run now.
  async function trigger(jobId, reason = 'ingest') {
    if (!byId.has(jobId) || !TRIGGERS.has(reason)) return null;
    if (running.has(jobId)) { if (!stopping) pending.set(jobId, reason); return null; }
    try { return await runOff(jobId, reason); } catch { return null; }
  }

  // Handlers trigger other jobs through ctx.triggerJob (inside a run, `trigger` is the run's reason).
  const triggerJob = trigger;

  function clearSoon(jobId) {
    const h = soonTimers.get(jobId);
    if (h) clearTimeout(h);
    soonTimers.delete(jobId);
  }

  // Rule 9. Returns whether a trigger was scheduled (or fired).
  async function soon(jobId, reason, { immediate = false } = {}) {
    if (!byId.has(jobId) || !TRIGGERS.has(reason) || stopping) return false;
    clearSoon(jobId);
    const fire = async () => {
      soonTimers.delete(jobId);
      trigger(jobId, reason).catch(() => {});
    };
    if (immediate) await fire();
    else {
      const h = setTimeout(fire, debounceMs);
      h.unref?.();
      soonTimers.set(jobId, h);
    }
    return true;
  }

  return {
    holder,
    tick,
    runNow: async (jobId) => runOff(jobId, 'manual'),
    trigger,
    soon,
    start() {
      if (timer) return;
      first = setTimeout(async () => { first = null; tick().catch(() => {}); }, 0);
      first.unref?.();
      timer = setInterval(async () => { tick().catch(() => {}); }, tickMs);
      timer.unref?.();
    },
    // Resolves once active runs settle (or drainMs passes) and the lease is released. Never rejects.
    async stop() {
      stopping = true;
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
      first = null;
      timer = null;
      for (const id of [...soonTimers.keys()]) clearSoon(id);
      stopRenewing();
      pending.clear();
      let drain;
      await Promise.race([
        Promise.allSettled([...active]),
        new Promise((r) => { drain = setTimeout(r, drainMs); drain.unref?.(); }),
      ]);
      clearTimeout(drain);
      try { await q.release.run(holder); } catch { /* store already closed */ }
    },
    idle() { return Promise.allSettled([...active]); },
    // Rule 14: read-only.
    async schedule() {
      const t = at();
      const zone = await tz();
      return handled.map((j) => ({ id: j.id, nextAt: nextRunAt(j.schedule, t, zone, fixed).toISOString(), retryMs }));
    },
    async jobs() {
      const t = at();
      const zone = await tz();
      // A paused household's store is never written, not even job labels.
      if (await allowed() === true) { try { await ensureJobs(t); } catch { /* listing does not depend on the rows */ } }
      return await mapSeries(handled, async (j) => {
        const nextAt = nextRunAt(j.schedule, t, zone, fixed);
        return { id: j.id, name: j.name, cadence: j.cadence, does: j.does, lastRun: runOut(await q.last.get(j.id)), next: timeLabel(nextAt, zone), nextAt: nextAt.toISOString() };
      });
    },
    async runs({ limit = 20 } = {}) {
      const n = Math.max(1, Math.min(200, Number.isInteger(limit) ? limit : 20));
      return (await q.runs.all(n)).map(runOut);
    },
  };
}

// ---------------------------------------------------------------- default handlers

// The server's handlers; every one runs on ctx.household (its db, root and runtime). `plan` is the
// only path that plans: on a real store it runs the planner over the household's packs
// with this run's id and the run's clock, and returns the planner's counts as the note plus the
// whole planner result as `planning` (the scheduler ignores it; npm run plan prints its warning
// codes). On a demo store it plans nothing and the run is recorded skipped. `confirm-guess` runs
// the in-product resolver: local rules first, then categorization and grounded fixed-choice answers.
// The job id stays stable for stored runs, API, CLI and Engine screen callers.
// `simplefin-sync` is skipped with note { paused: true } while the household's outbound SimpleFIN
// flag is off; otherwise it reads the SimpleFIN connection (skipped when there is none); a demo store uses
// the synthetic fake bridge, a real one `simplefinFetch` (default global fetch). It returns counts
// only, fails with the bridge code when access needs a reconnect, and triggers the after-import
// planning run when it wrote rows.
export function defaultHandlers({ publicUrl = null, simplefinFetch = null } = {}) {
  return {
    async 'simplefin-sync'(ctx) {
      if (!ctx.household || !await ctx.household.outbound.enabled('simplefin')) return { status: 'skipped', note: { paused: true } };
      const demo = await getSetting(ctx.db, 'mode', null) === 'demo';
      const out = await syncSimplefin(ctx.db, {
        household: ctx.household, config: ctx.config, hosts: ctx.config?.simplefinHosts, now: ctx.now, clock: ctx.clock, engine: ctx.engine,
        fetch: demo ? createFakeSimplefin({ today: () => ctx.clock }) : (simplefinFetch ?? globalThis.fetch),
      });
      if (out.status === 'skipped') return { status: 'skipped', note: { connected: false } };
      if (out.status !== 'ok') throw new JobFailure(`simplefin_${out.code || 'error'}`);
      if (out.changed) ctx.triggerJob?.('plan');
      ctx.triggerJob?.('freshness');
      return { costUsd: 0, note: { ...out.counts, changed: out.changed } };
    },
    async plan(ctx) {
      if (await getSetting(ctx.db, 'mode', null) === 'demo') return { status: 'skipped' };
      const planning = await runPlanning(ctx.db, ctx.trigger === 'resolve' ? null : (ctx.engine || null), {
        now: ctx.clock, packDirs: defaultPackDirs(ctx.household.root), runId: ctx.jobRunId, household: ctx.household,
      });
      await ctx.db.prepare('UPDATE action_receipts SET planning_pending = 0 WHERE planning_pending = 1').run();
      const warned = [...new Set(Array.isArray(planning.warnings) ? planning.warnings : [])].filter((c) => typeof c === 'string' && IDENT.test(c));
      for (const c of warned) console.warn(`fathom: plan warning ${c}`);
      const note = warned.length ? { ...planning.counts, warned: Object.fromEntries(warned.map((c) => [c, true])) } : planning.counts;
      return { costUsd: planning.costUsd, note, planning };
    },
    async 'brief-email'(ctx) {
      const brief = await composeBrief(ctx.db, { clock: ctx.clock, publicUrl, engine: ctx.engine, householdId: ctx.household.householdId });
      const send = await sendEmail(ctx.db, {
        transport: ctx.transport, kind: 'brief', subject: brief.subject, text: brief.text, html: brief.html, now: ctx.now, jobRunId: ctx.jobRunId,
      });
      if (send.status !== 'sent') { const e = new JobFailure(`email_${send.errorCode || 'other'}`); e.costUsd = brief.costUsd; throw e; }
      return { costUsd: brief.costUsd, note: { sent: 1, figures: brief.model.figures.length, modelSummary: brief.summarySrc === 'model' } };
    },
    async 'deadline-alerts'(ctx) {
      const out = await runDeadlineAlerts(ctx.db, { clock: ctx.clock, transport: ctx.transport, publicUrl, householdId: ctx.household.householdId, now: ctx.now, jobRunId: ctx.jobRunId });
      if (out.send && out.send.status !== 'sent') throw new JobFailure(`email_${out.send.errorCode || 'other'}`);
      return { costUsd: 0, note: { alerts: out.alerts, sent: out.send ? 1 : 0 } };
    },
    async 'trash-purge'(ctx) {
      // Same basis as trash timestamps (clockNow): config clock, else the stored clock, else the
      // UTC date, never the owner-local date, so a far east zone cannot purge a day early.
      const stored = await getSetting(ctx.db, 'clock', null);
      const date = (ctx.config && ctx.config.clock) || (isIsoDate(stored) ? stored : ctx.now.slice(0, 10));
      const purged = await purgeTrash(ctx.db, `${date}T${ctx.now.slice(11)}`);
      return { costUsd: 0, note: { purged } };
    },
    async freshness(ctx) {
      const s = await refreshFreshness(ctx.db, { clock: ctx.clock });
      return {
        costUsd: 0,
        note: { sources: s.sources.length, stale: s.sources.filter((x) => x.state === 'stale').length, pending: s.pending, waiting: s.waiting.length },
      };
    },
    async 'confirm-guess'(ctx) {
      if (await getSetting(ctx.db, 'mode', null) === 'demo') return { status: 'skipped' };
      const packDirs = defaultPackDirs(ctx.household?.root);
      const allowed = async () => await ctx.household?.outbound?.enabled('engine') === true;
      const funded = async () => await ctx.household?.funded?.() === true;
      const out = await resolvePending(ctx.db, ctx.engine, {
        now: ctx.now, packDirs, allowed, funded,
        async readNotes() {
          const vault = ctx.household?.vault ? await ctx.household.vault() : null;
          return vault ? readOwnerNotes(ctx.db, vault) : [];
        },
        async categorize({ maxCostUsd, admit }) {
          const cap = (await getSetting(ctx.db, 'cap', { usd: 200 }))?.usd;
          const selection = selectionFor(ctx.config?.modelPorts, 'categorize');
          await ctx.engine?.init?.();
          const enabled = ctx.config?.engine === 'live' && ctx.engine?.credentialStateFor?.('categorize') !== 'failed'
            && (selection.adapter !== 'jev' || !!(selection.keyFile || ctx.config?.typesafeKeyFile));
          const categorizer = await createJev({ keyFile: selection.keyFile || ctx.config?.typesafeKeyFile, enabled,
            ledger: createSpendLedger(ctx.db), maxCostUsd: Math.min(.05, maxCostUsd),
            monthlyCapUsd: Number.isFinite(cap) && cap >= 0 ? cap : 0, admit, complete: ctx.engine?.complete });
          const categories = await guessCategories(ctx.db, categorizer, { now: ctx.now });
          const closed = categories.stopped ? { guessed: 0 } : await guessClosedOptions(ctx.db, categorizer, { now: ctx.now });
          return { applied: categories.applied, stopped: categories.stopped ?? closed.stopped };
        },
        replan: () => { ctx.triggerJob('plan', 'resolve'); },
      });
      if (!out.answered && !out.batches && !out.costUsd) return { status: 'skipped', note: { pending: out.pending } };
      return { costUsd: out.costUsd,
        note: { batches: out.batches, items: out.items, guessed: out.answered, stopped: Boolean(out.stopped),
          ...(STOP_CAUSES.has(out.stopped) ? { stoppedBy: { [out.stopped]: true } } : {}) } };
    },
  };
}

export const SCHEDULER_STATUS = { unknown_job: 404, running: 409, locked: 409, paused: 409, demo_store: 409, unavailable: 503 };
export const SCHEDULER_MESSAGE = { unknown_job: 'no such job', running: 'that job is already running', locked: 'another scheduler holds the job lock', paused: 'outbound jobs are paused', demo_store: 'planning runs on real stores only', unavailable: 'scheduler unavailable' };
export async function runManualJob(db, scheduler, id) {
  if (id === 'plan' && await getSetting(db, 'mode', null) === 'demo') throw new SchedulerError('demo_store');
  if (!scheduler) throw new SchedulerError('unavailable');
  return await scheduler.runNow(id) ?? null;
}
