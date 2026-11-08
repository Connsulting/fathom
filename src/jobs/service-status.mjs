// The shared service status model: one object per background service (each scheduled job, email,
// the model engine and the SimpleFIN connection) in one of four states, with a plain cause and one
// existing control that can act on it. Read-only: it never writes the store.
//
// serviceStatus({ db, outbound, engine, scheduler, now }) ->
//   { jobs: { <jobId>: svc }, email: svc, engine: svc, simplefin: svc, attention: svc | null }
// svc = { key, label, state, code, cause, lastSuccessAt, nextAttemptAt, since, control, go, running?, warnings? }
//   state: healthy | retrying | paused | needs_you. code: the reason or error code (null when
//   healthy). cause: a plain sentence (null when healthy). since: start of the non-healthy streak.
//   control: { id, label, arg? } or null, id one of run_job, resume, engine_on, cap, reconnect,
//   sync_now, test_email, refresh. go: the screen route that owns the service.
// outbound: { jobs, email, simplefin, engine } booleans; an absent kind counts as enabled.
// engine: the household engine or null (status() in try/catch). scheduler: anything with a
//   read-only schedule() -> [{ id, nextAt, retryMs }]; jobs are omitted when it is null.
// attention: the first service (engine, simplefin, email, then jobs in JOBS order) that needs the
//   owner now, or has been retrying for more than a day; else null.

import { JOBS, isTransient } from './scheduler.mjs';

export { isTransient };

const DAY = 86400000;
const RETRY_MS = 15 * 60000;
const STREAK_ROWS = 50;

const SF_RECONNECT = new Set(['simplefin_revoked', 'simplefin_payment_required', 'simplefin_auth', 'simplefin_bad_access']);
const EMAIL_CONFIG = new Set(['email_missing_config', 'email_missing_credential', 'email_auth', 'email_not_found', 'email_invalid', 'email_rejected', 'email_recipient_unverified', 'email_other']);

const JOB_GO = { plan: 'engine', freshness: 'engine', 'trash-purge': 'engine', 'confirm-guess': 'engine', 'brief-email': 'email', 'deadline-alerts': 'email', 'simplefin-sync': 'money' };

const RESUME_LABEL = { jobs: 'Resume jobs', email: 'Resume email', simplefin: 'Resume SimpleFIN', engine: 'Resume engine calls' };
const C = {
  runJob: (id) => ({ id: 'run_job', label: 'Run now', arg: id }),
  resume: (kind) => ({ id: 'resume', label: RESUME_LABEL[kind], arg: kind }),
  engineOn: () => ({ id: 'engine_on', label: 'Turn the engine on' }),
  cap: () => ({ id: 'cap', label: 'Raise the cap' }),
  reconnect: () => ({ id: 'reconnect', label: 'Reconnect' }),
  syncNow: () => ({ id: 'sync_now', label: 'Sync now' }),
  testEmail: () => ({ id: 'test_email', label: 'Send a test email' }),
  refresh: () => ({ id: 'refresh', label: 'Check again' }),
};

// Plain sentences per code. A transient or unknown class falls back to the generic lines below.
export const CAUSES = Object.freeze({
  interrupted: 'The last run was interrupted before it finished. It runs again automatically.',
  simplefin_network: 'The SimpleFIN bridge did not answer in time. It tries again automatically.',
  simplefin_bad_response: 'SimpleFIN sent a reply Fathom could not read. It tries again automatically.',
  email_network: 'The email provider could not be reached. It tries again automatically.',
  email_rate_limited: 'The email provider asked Fathom to slow down. It tries again automatically.',
  store_locked: 'The data store was busy when the job ran. It tries again automatically.',
  simplefin_revoked: 'SimpleFIN refused access. Reconnect with a new setup token.',
  simplefin_payment_required: 'SimpleFIN says the subscription needs payment. Renew it, then reconnect.',
  simplefin_auth: 'SimpleFIN reports a sign-in problem with a connected institution. Fix it on the SimpleFIN Bridge site, or reconnect.',
  simplefin_bad_access: 'The stored SimpleFIN connection cannot be used. Reconnect with a new setup token.',
  email_missing_config: 'Email sender or recipient is not configured. Check the email settings, then send a test email.',
  email_missing_credential: 'The email credential is missing. Add it, then send a test email.',
  email_auth: 'The email provider rejected the credential. Fix it, then send a test email.',
  email_not_found: 'The email provider does not know the sender. Fix it, then send a test email.',
  email_invalid: 'The email provider rejected the request as invalid. Send a test email to check.',
  email_rejected: 'The email provider rejected the message. Send a test email to check.',
  email_recipient_unverified: 'No household member has a verified email address to receive it.',
  email_other: 'The last email could not be sent. Send a test email to check.',
  email_paused: 'Email is paused for this household.',
  jobs_paused: 'Background jobs are paused for this household.',
  email_flag_paused: 'Email is paused for this household, so nothing is sent.',
  simplefin_flag_paused: 'SimpleFIN sync is paused for this household, so Fathom will not sync until it is resumed.',
  sync_skipped_paused: 'SimpleFIN sync is paused for this household, so the last sync was skipped.',
  engine_flag_paused: 'Engine calls are paused for this household.',
  engine_off: 'The engine is turned off, so proactive jobs and answers wait.',
  not_configured: "The engine is off in this deployment's configuration. An administrator turns it on there.",
  credential_unavailable: 'The model key file could not be read. An administrator must fix it.',
  funding_unavailable: 'The instance has no model funding. An administrator must fund it.',
  funding_exhausted: "This month's spend reached the cap, so engine work waits until next month or a higher cap.",
  status_unavailable: 'Fathom could not read the engine status.',
  stop_engine_paused: 'Engine calls are paused for this household, so open questions wait.',
  stop_engine_off: 'The engine is turned off, so open questions wait.',
  stop_funding_unavailable: 'The instance has no model funding, so open questions wait. An administrator must fund it.',
  stop_budget: "This month's spend reached the cap, so open questions wait.",
  stop_run_budget: 'The last run used its spending allowance, so the rest of the open questions wait for the next run.',
  sync_network: 'The SimpleFIN bridge did not answer in time. Fathom tries again on the next sync.',
  sync_bad_response: 'SimpleFIN sent a reply Fathom could not read. Fathom tries again on the next sync.',
  sync_paused: 'The last sync failed and sync is paused, so Fathom will not retry until it is resumed.',
  sync_failed: 'The last SimpleFIN sync failed. Sync again to check.',
});

const transientCause = 'The last run hit a temporary problem. It runs again automatically.';
const failedCause = (cls) => `The last run failed (${cls}).`;

const iso = (v) => {
  const t = Date.parse(v ?? '');
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const minIso = (...xs) => {
  const ts = xs.map((x) => Date.parse(x ?? '')).filter(Number.isFinite);
  return ts.length ? new Date(Math.min(...ts)).toISOString() : null;
};

function noteOf(raw) {
  if (raw == null) return null;
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

const healthy = (base) => ({ ...base, state: 'healthy', code: null, cause: null, since: null, control: null });

// A failure class, classified by the job rules: { state, code, cause, control } or null for none.
function classifyFailure(cls, jobId) {
  const code = cls || 'Error';
  if (code === 'interrupted') return { state: 'retrying', code, cause: CAUSES.interrupted, control: C.runJob(jobId) };
  if (SF_RECONNECT.has(code)) return { state: 'needs_you', code, cause: CAUSES[code], control: C.reconnect() };
  if (code === 'email_paused') return { state: 'paused', code, cause: CAUSES.email_paused, control: C.resume('email') };
  if (EMAIL_CONFIG.has(code)) return { state: 'needs_you', code, cause: CAUSES[code], control: C.testEmail() };
  if (isTransient(code)) return { state: 'retrying', code, cause: CAUSES[code] || transientCause, control: C.runJob(jobId) };
  return { state: 'needs_you', code, cause: failedCause(code), control: C.runJob(jobId) };
}

// The resolver stop cause on an ok confirm-guess run. `ctx` = { flags, engine: the engine service }.
// A stop caused by a pause that has since been lifted is not current, so it reads as fine (null).
// The budget stop fires on the monthly cap and on the per-run allowance (resolver.maxCostUsd); only
// a reached cap points at the cap.
function classifyStop(code, jobId, ctx) {
  if (code === 'engine_paused') return ctx.flags.engine ? null : { state: 'paused', code, cause: CAUSES.stop_engine_paused, control: C.resume('engine') };
  if (code === 'engine_off') return ctx.engine?.code !== 'engine_off' ? null : { state: 'paused', code, cause: CAUSES.stop_engine_off, control: C.engineOn() };
  if (code === 'funding_unavailable') return { state: 'needs_you', code, cause: CAUSES.stop_funding_unavailable, control: C.refresh() };
  if (code === 'budget') {
    if (ctx.engine?.code === 'funding_exhausted') return { state: 'paused', code, cause: CAUSES.stop_budget, control: C.cap() };
    return { state: 'paused', code, cause: CAUSES.stop_run_budget, control: C.runJob(jobId) };
  }
  return classifyFailure(code, jobId);
}

// One finished run row -> a non-healthy classification, or null when the run was fine. A failure
// or skip caused by a pause that has since been lifted is fine.
function classifyRun(r, jobId, ctx) {
  if (r.status === 'error' || r.status === 'interrupted') {
    if (r.status === 'error' && r.error_class === 'email_paused' && ctx.flags.email) return null;
    return classifyFailure(r.status === 'interrupted' ? 'interrupted' : r.error_class, jobId);
  }
  const note = noteOf(r.note);
  if (r.status === 'skipped') {
    if (note?.paused === true && !ctx.flags.simplefin) return { state: 'paused', code: 'paused', cause: CAUSES.sync_skipped_paused, control: C.resume('simplefin') };
    return null;
  }
  if (r.status === 'ok' && note?.stoppedBy && typeof note.stoppedBy === 'object') {
    const code = Object.keys(note.stoppedBy).find((k) => note.stoppedBy[k] === true);
    if (code) return classifyStop(code, jobId, ctx);
  }
  return null;
}

function jobService(db, job, sched, ctx) {
  const { flags } = ctx;
  const base = { key: `job:${job.id}`, label: job.name, go: JOB_GO[job.id] ?? 'engine', lastSuccessAt: null, nextAttemptAt: null, running: false };
  const rows = db.prepare('SELECT * FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?').all(job.id, STREAK_ROWS);
  base.running = rows[0]?.status === 'running';
  const lastOk = db.prepare("SELECT started_at, finished_at, note FROM job_runs WHERE job_id = ? AND status = 'ok' ORDER BY id DESC LIMIT 1").get(job.id);
  base.lastSuccessAt = lastOk ? iso(lastOk.finished_at ?? lastOk.started_at) : null;
  if (job.id === 'plan') {
    const warned = noteOf(lastOk?.note)?.warned;
    base.warnings = warned && typeof warned === 'object' ? Object.keys(warned).filter((k) => warned[k] === true) : [];
  }
  if (!flags.jobs) return { ...base, state: 'paused', code: 'paused', cause: CAUSES.jobs_paused, since: null, control: C.resume('jobs') };
  const finished = rows.filter((r) => r.status !== 'running');
  const latest = finished[0];
  const verdict = latest ? classifyRun(latest, job.id, ctx) : null;
  if (!verdict) return { ...healthy(base), nextAttemptAt: iso(sched.nextAt) };
  let since = latest.started_at;
  for (const r of finished.slice(1)) {
    if (!classifyRun(r, job.id, ctx)) break;
    since = r.started_at;
  }
  let nextAttemptAt = null;
  if (verdict.state === 'retrying') {
    // A scheduled period run that has not been retried yet retries after retryMs; otherwise the
    // next attempt is the next scheduled run.
    const key = String(latest.period_key ?? '');
    const firstTry = key !== '' && !key.includes(':') && !key.endsWith('+retry');
    const retryMs = Number.isFinite(sched.retryMs) ? sched.retryMs : RETRY_MS;
    const retryAt = firstTry ? new Date(Date.parse(latest.finished_at ?? latest.started_at) + retryMs).toISOString() : null;
    nextAttemptAt = minIso(retryAt, sched.nextAt);
  } else if (verdict.state === 'needs_you') nextAttemptAt = iso(sched.nextAt);
  return { ...base, ...verdict, since: iso(since), nextAttemptAt };
}

function engineService(engine, db, flags) {
  const base = { key: 'engine', label: 'Engine', go: 'engine', lastSuccessAt: null, nextAttemptAt: null };
  const out = (state, code, control) => ({ ...base, state, code, cause: CAUSES[code], since: null, control });
  if (!flags.engine) return { ...out('paused', 'paused', C.resume('engine')), cause: CAUSES.engine_flag_paused };
  if (!engine) return out('paused', 'not_configured', C.refresh());
  let s;
  try { s = typeof engine.status === 'function' ? engine.status() : null; } catch { s = null; }
  if (!s || typeof s !== 'object') return out('needs_you', 'status_unavailable', C.refresh());
  if (s.mode === 'off') return out('paused', 'not_configured', C.refresh());
  if (!s.on) return out('paused', 'engine_off', C.engineOn());
  if (s.mode === 'live' && s.credentialState !== 'loaded') return out('needs_you', 'credential_unavailable', C.refresh());
  if (!s.funded) return out('needs_you', 'funding_unavailable', C.refresh());
  if (!(Number(s.spentUsd) < Number(s.capUsd))) return out('paused', 'funding_exhausted', C.cap());
  return healthy(base);
}

function simplefinService(db, flags, syncJob) {
  const base = { key: 'simplefin', label: 'SimpleFIN connection', go: 'money', lastSuccessAt: null, nextAttemptAt: null };
  const row = db.prepare('SELECT last_sync_at, status, error_code FROM simplefin_connection WHERE id = 1').get();
  if (!row) return healthy(base);
  base.lastSuccessAt = iso(row.last_sync_at);
  const since = syncJob && syncJob.state !== 'healthy' ? syncJob.since : null;
  const out = (state, code, cause, control, extra = {}) => ({ ...base, state, code, cause, since, control, ...extra });
  if (!flags.simplefin) return out('paused', 'paused', CAUSES.simplefin_flag_paused, C.resume('simplefin'));
  const code = row.error_code || null;
  if (row.status === 'ok' || (!code && row.status !== 'reconnect')) return healthy(base);
  if (row.status === 'reconnect' || SF_RECONNECT.has(`simplefin_${code}`)) {
    return out('needs_you', code || 'reconnect', CAUSES[`simplefin_${code}`] || CAUSES.simplefin_revoked, C.reconnect());
  }
  if (code === 'network' || code === 'bad_response') {
    if (!flags.jobs) return out('paused', code, CAUSES.sync_paused, C.resume('jobs'));
    const nextAttemptAt = syncJob?.nextAttemptAt ?? null;
    return out('retrying', code, CAUSES[`sync_${code}`], C.syncNow(), { nextAttemptAt });
  }
  return out('needs_you', code, CAUSES.sync_failed, C.syncNow());
}

function emailService(db, flags, jobs) {
  const base = { key: 'email', label: 'Email', go: 'email', lastSuccessAt: null, nextAttemptAt: null };
  const sent = db.prepare("SELECT ts FROM email_sends WHERE status = 'sent' ORDER BY id DESC LIMIT 1").get();
  base.lastSuccessAt = sent ? iso(sent.ts) : null;
  if (!flags.email) return { ...base, state: 'paused', code: 'paused', cause: CAUSES.email_flag_paused, since: null, control: C.resume('email') };
  const rows = db.prepare('SELECT ts, status, error_code FROM email_sends ORDER BY id DESC LIMIT ?').all(STREAK_ROWS);
  // Email is on here, so a send that failed because email was paused is not current.
  const failed = (r) => r?.status === 'failed' && r.error_code !== 'paused';
  if (!failed(rows[0])) return healthy(base);
  const code = `email_${rows[0].error_code || 'other'}`;
  let since = rows[0].ts;
  for (const r of rows.slice(1)) {
    if (!failed(r)) break;
    since = r.ts;
  }
  const v = classifyFailure(code, null);
  const control = v.state === 'paused' ? v.control : C.testEmail();
  const nextAttemptAt = v.state === 'paused' ? null : minIso(jobs['brief-email']?.nextAttemptAt, jobs['deadline-alerts']?.nextAttemptAt);
  return { ...base, state: v.state, code, cause: CAUSES[code] || v.cause, since: iso(since), control, nextAttemptAt };
}

function needsAttention(svc, now) {
  if (!svc) return false;
  if (svc.state === 'needs_you') return true;
  if (svc.state !== 'retrying') return false;
  const since = Date.parse(svc.since ?? '');
  return Number.isFinite(since) && now.getTime() - since > DAY;
}

export function serviceStatus({ db, outbound = {}, engine = null, scheduler = null, now = new Date() } = {}) {
  const at = new Date(now);
  const flags = Object.fromEntries(['jobs', 'email', 'simplefin', 'engine'].map((k) => [k, outbound?.[k] !== false]));
  // The engine service first: whether an engine stop on a job is still current depends on it.
  const engineSvc = engineService(engine, db, flags);
  const ctx = { flags, engine: engineSvc };
  const jobs = {};
  if (scheduler && typeof scheduler.schedule === 'function') {
    const byId = new Map(scheduler.schedule().map((x) => [x.id, x]));
    for (const job of JOBS) if (byId.has(job.id)) jobs[job.id] = jobService(db, job, byId.get(job.id), ctx);
  }
  const out = {
    jobs,
    email: emailService(db, flags, jobs),
    engine: engineSvc,
    simplefin: simplefinService(db, flags, jobs['simplefin-sync']),
  };
  const order = [out.engine, out.simplefin, out.email, ...JOBS.map((j) => jobs[j.id])];
  out.attention = order.find((s) => needsAttention(s, at)) ?? null;
  return out;
}
