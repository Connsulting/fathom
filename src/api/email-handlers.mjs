// Email and jobs API handlers: transport status, the brief preview and send history, a test send,
// a brief send, the job list and manual job runs (POST /api/jobs/plan/run is the manual plan run:
// planning runs only through the scheduler). Each takes the router ctx ({household, db, config,
// engine, scheduler, transport, params, body}, all of one household) and returns the JSON body or
// throws HttpError. A paused household's manual run is 409 and its sends are recorded failed with
// the transport's code (paused, recipient_unverified). Responses
// never carry an email body in history, the credential or a full address (the recipient is
// masked by emailStatus). The router logs errors on these routes as a code only.

import { emailStatus } from '../email/transport.mjs';
import { sendEmail, listSends } from '../email/send.mjs';
import { composeBrief } from '../email/brief.mjs';
import { simpleDarkEmail } from '../email/palette.mjs';
import { SchedulerError, ownerTimezone, runManualJob, SCHEDULER_STATUS, SCHEDULER_MESSAGE } from '../jobs/scheduler.mjs';
import { scenarioOf } from './handlers.mjs';
import { HttpError } from './http.mjs';

const HISTORY_LIMIT = 50;
const RUNS_LIMIT = 20;

const TEST_SUBJECT = 'Fathom test email';
const TEST_TEXT = 'This is a test email from Fathom. Email delivery is working.';
const TEST_HTML = simpleDarkEmail({ title: TEST_SUBJECT, paragraphs: [TEST_TEXT] });

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

// A manual run under the lease. Planning on a demo store is refused here, before the scheduler, so
// the store is left unchanged (scheduled and ingest plan runs on a demo store record skipped).
export async function runJob(ctx) {
  const { id } = ctx.params;
  const s = ctx.scheduler;
  let run;
  try {
    run = await runManualJob(ctx.db, s, id);
  } catch (err) {
    if (err instanceof SchedulerError && Object.hasOwn(SCHEDULER_STATUS, err.code)) {
      throw new HttpError(SCHEDULER_STATUS[err.code], SCHEDULER_MESSAGE[err.code]);
    }
    throw err;
  }
  return { scenario: scenarioOf(ctx), run: run ?? null, jobs: jobsBody(ctx).jobs };
}
