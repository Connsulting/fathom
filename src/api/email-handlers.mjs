// Email and jobs API handlers: transport status, the brief preview and send history, a test send,
// a brief send, the job list and manual job runs. Each takes the router ctx ({db, config, engine,
// scheduler, transport, params, body}) and returns the JSON body or throws HttpError. Responses
// never carry an email body in history, the credential or a full address (the recipient is
// masked by emailStatus). The router logs errors on these routes as a code only.

import { emailStatus } from '../email/transport.mjs';
import { sendEmail, listSends } from '../email/send.mjs';
import { composeBrief } from '../email/brief.mjs';
import { SchedulerError, ownerTimezone } from '../jobs/scheduler.mjs';
import { HttpError } from './http.mjs';

const HISTORY_LIMIT = 50;
const RUNS_LIMIT = 20;

const TEST_SUBJECT = 'Fathom test email';
const TEST_TEXT = 'This is a test email from Fathom. Email delivery is working.';
const TEST_HTML = '<p style="font-family:sans-serif;font-size:14px">This is a test email from Fathom. Email delivery is working.</p>';

const SCHEDULER_STATUS = { unknown_job: 404, running: 409, locked: 409 };
const SCHEDULER_MESSAGE = {
  unknown_job: 'no such job',
  running: 'that job is already running',
  locked: 'another scheduler holds the job lock',
};

const brief = (ctx, engine = ctx.engine) => composeBrief(ctx.db, { clock: (ctx.config && ctx.config.clock) || null, publicUrl: (ctx.config && ctx.config.publicUrl) || null, engine });

function transportOf(ctx) {
  if (!ctx.transport) throw new HttpError(503, 'email transport unavailable');
  return ctx.transport;
}

const history = ctx => listSends(ctx.db, { limit: HISTORY_LIMIT });

export async function getEmail(ctx) {
  const status = await emailStatus(ctx.config);
  // The preview uses the template summary only (engine: null): opening the Email screen must never
  // make a model call. Sends keep the runtime engine.
  const b = await brief(ctx, null);
  return {
    status,
    preview: { subject: b.subject, text: b.text, html: b.html, summarySrc: b.summarySrc },
    history: history(ctx),
  };
}

export async function sendTestEmail(ctx) {
  const send = await sendEmail(ctx.db, { transport: transportOf(ctx), kind: 'test', subject: TEST_SUBJECT, text: TEST_TEXT, html: TEST_HTML });
  return { send, history: history(ctx) };
}

export async function sendBriefEmail(ctx) {
  const transport = transportOf(ctx);
  const b = await brief(ctx);
  const send = await sendEmail(ctx.db, { transport, kind: 'brief', subject: b.subject, text: b.text, html: b.html });
  return { send, history: history(ctx) };
}

const jobOut = j => ({ id: j.id, name: j.name, cadence: j.cadence, does: j.does, lastRun: j.lastRun ?? null, next: j.next, nextAt: j.nextAt });

function jobsBody(ctx) {
  const s = ctx.scheduler;
  return {
    jobs: s ? s.jobs().map(jobOut) : [],
    runs: s ? s.runs({ limit: RUNS_LIMIT }) : [],
    timezone: ownerTimezone(ctx.db),
  };
}

export function listJobs(ctx) {
  return jobsBody(ctx);
}

export async function runJob(ctx) {
  const s = ctx.scheduler;
  if (!s) throw new HttpError(503, 'scheduler unavailable');
  const { id } = ctx.params;
  let run;
  try {
    run = await s.runNow(id);
  } catch (err) {
    if (err instanceof SchedulerError && Object.hasOwn(SCHEDULER_STATUS, err.code)) {
      throw new HttpError(SCHEDULER_STATUS[err.code], SCHEDULER_MESSAGE[err.code]);
    }
    throw err;
  }
  const body = jobsBody(ctx);
  return { run: run ?? null, jobs: body.jobs };
}
