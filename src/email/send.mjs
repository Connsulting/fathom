// Send through a transport and record the attempt in email_sends (subject, status, fixed error
// code, recipient count, provider message id; never a body or an address). An EmailError is
// recorded as failed and returned; any other error is recorded as `other` and rethrown.

import { EmailError } from './transport.mjs';

const KINDS = ['brief', 'alert', 'test'];

const rowOut = (r) => ({
  id: r.id, ts: r.ts, kind: r.kind, subject: r.subject, status: r.status, errorCode: r.error_code,
  transport: r.transport, recipients: r.recipients, messageId: r.message_id, jobRunId: r.job_run_id,
});

async function record(db, row) {
  const r = await db.prepare(`INSERT INTO email_sends (ts, kind, subject, status, error_code, transport, recipients, message_id, job_run_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .get(row.ts, row.kind, row.subject, row.status, row.errorCode, row.transport, row.recipients, row.messageId, row.jobRunId);
  return rowOut(r);
}

export async function sendEmail(db, { transport, kind, subject, text, html, to, now, jobRunId = null }) {
  if (!KINDS.includes(kind)) throw new TypeError(`email kind must be one of ${KINDS.join(', ')}`);
  const ts = now == null ? new Date().toISOString() : new Date(now).toISOString();
  const base = { ts, kind, subject: String(subject ?? ''), transport: transport.name, jobRunId: jobRunId ?? null };
  try {
    const r = await transport.send({ to, subject, text, html });
    const recipients = Number.isInteger(r && r.recipients) ? r.recipients : to == null ? 0 : [to].flat().length;
    return await record(db, { ...base, status: 'sent', errorCode: null, recipients, messageId: r && r.id != null ? String(r.id) : null });
  } catch (err) {
    const errorCode = err instanceof EmailError ? err.code : 'other';
    const row = await record(db, { ...base, status: 'failed', errorCode, recipients: 0, messageId: null });
    if (err instanceof EmailError) return row;
    throw err;
  }
}

// Send history, newest first.
export async function listSends(db, { limit = 50 } = {}) {
  const n = Math.max(1, Math.min(500, Number.isInteger(limit) ? limit : 50));
  return (await db.prepare('SELECT * FROM email_sends ORDER BY ts DESC, id DESC LIMIT ?').all(n)).map(rowOut);
}
