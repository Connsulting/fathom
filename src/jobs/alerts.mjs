// Deadline alerts: one combined email per run for deadlines and rec windows closing within 14
// days. Rules:
// 1. Thresholds 14, 7 and 1 days. An item alerts at the tightest threshold that covers its days
//    left (0 to 14), once per (key, threshold); a missed day sends only the tightest, never a
//    looser one as well.
// 2. Identity (plan Revision r2 item 5): a deadline linked to a rec and that rec's window are both
//    `rec:<recId>:<date>`, so the two on one date are one alert and a planner refresh that
//    rewrites the row keeps its key; an unlinked deadline is `deadline:<date>:<16 hex sha256 of
//    the lowercased, whitespace collapsed title>`.
// 3. Recs that are done, dismissed or hidden, and deadlines linked to them, never alert.
// 4. deadline_alerts rows are written in one transaction, only after the send reports sent.
// 5. Deadline titles are plain text: never token-resolved, escaped in HTML. Rec titles resolve
//    their tokens through footnoted figures with provenance, as the brief does.

import { createHash } from 'node:crypto';
import { resolveClock, addDays, daysBetween, clockLabel, tokenScope, loadSources } from '../scenario/build.mjs';
import { parseJson, tx } from '../store/db.mjs';
import { esc } from '../shared/tokens.mjs';
import { sendEmail } from '../email/send.mjs';
import { C, FONT, darkDocument } from '../email/palette.mjs';
import { appLink, STYLE, figureRegistry, narrativeParts, partsRenderer, footnoteText, footnoteHtml } from '../email/brief.mjs';

export const THRESHOLDS = Object.freeze([14, 7, 1]);
const ASCENDING = [...THRESHOLDS].sort((a, b) => a - b);
const HORIZON = ASCENDING[ASCENDING.length - 1];
const SKIP = new Set(['done', 'dismissed', 'hidden']);

export const thresholdFor = (daysLeft) => (daysLeft < 0 ? null : ASCENDING.find((t) => t >= daysLeft) ?? null);

const titleHash = (title) => createHash('sha256').update(String(title ?? '').toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
export const deadlineKey = ({ date, title, recId }) => (recId ? `rec:${recId}:${date}` : `deadline:${date}:${titleHash(title)}`);

// Due alerts, soonest first: {key, threshold, date, daysLeft, kind: deadline|rec, recId, title,
// titleParts, windowLabel, figures}. titleParts are {t} or {f: key}; figures are the entries those
// parts cite (refs are assigned by renderAlerts).
export function dueAlerts(db, { clock } = {}) {
  const clk = resolveClock(db, clock);
  const end = addDays(clk, HORIZON);
  const recs = new Map(db.prepare('SELECT id, def, status, window_close, window_label FROM recs ORDER BY sort, id').all()
    .map((r) => [r.id, { id: r.id, def: parseJson(r.def, {}) || {}, status: r.status, close: r.window_close, label: r.window_label }]));
  const items = new Map();

  for (const d of db.prepare('SELECT date, title, rec_id FROM deadlines WHERE date >= ? AND date <= ? ORDER BY date, id').all(clk, end)) {
    const rec = d.rec_id ? recs.get(d.rec_id) : null;
    if (rec && SKIP.has(rec.status)) continue;
    const key = deadlineKey({ date: d.date, title: d.title, recId: d.rec_id });
    if (!items.has(key)) items.set(key, { key, date: d.date, kind: 'deadline', recId: d.rec_id || null, title: String(d.title ?? ''), windowLabel: null });
  }
  for (const r of recs.values()) {
    if (SKIP.has(r.status) || !r.close || r.close < clk || r.close > end) continue;
    const key = deadlineKey({ date: r.close, recId: r.id });
    const hit = items.get(key);
    if (hit) hit.windowLabel = r.label || null;
    else items.set(key, { key, date: r.close, kind: 'rec', recId: r.id, title: String(r.def.title ?? r.id), windowLabel: r.label || null });
  }

  const sent = db.prepare('SELECT 1 AS x FROM deadline_alerts WHERE key = ? AND threshold = ?');
  const due = [...items.values()]
    .map((a) => ({ ...a, daysLeft: daysBetween(clk, a.date) }))
    .map((a) => ({ ...a, threshold: thresholdFor(a.daysLeft) }))
    .filter((a) => a.threshold != null && !sent.get(a.key, a.threshold))
    .sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));

  let scope = null;
  for (const a of due) {
    if (a.kind === 'deadline') {
      a.titleParts = [{ t: a.title }];
      a.figures = [];
      continue;
    }
    scope ??= { ...tokenScope(db), src: loadSources(db, clk) };
    const reg = figureRegistry(scope);
    a.titleParts = narrativeParts(a.title, scope, reg);
    a.figures = reg.list;
  }
  return due;
}

function whenWords(daysLeft) {
  if (daysLeft === 0) return 'today';
  if (daysLeft === 1) return 'tomorrow';
  return `in ${daysLeft} days`;
}

// One combined email for a list of due alerts; figures renumbered across the whole email.
export function renderAlerts(alerts, { clock, publicUrl = null, householdId = null } = {}) {
  const figures = [];
  const seen = new Set();
  for (const a of alerts) {
    for (const f of a.figures || []) {
      if (seen.has(f.key)) continue;
      seen.add(f.key);
      figures.push({ ...f, ref: figures.length + 1 });
    }
  }
  const r = partsRenderer(figures);
  const base = typeof publicUrl === 'string' && publicUrl ? publicUrl.replace(/\/+$/, '') : null;
  const linkOf = a => appLink(base, a.recId ? 'rec' : 'plan', a.recId || undefined, householdId);
  const n = alerts.length;
  const subject = `Fathom: ${n} ${n === 1 ? 'deadline' : 'deadlines'} in the next ${HORIZON} days`;
  const intro = `Coming up in the next ${HORIZON} days, as of ${clockLabel(clock)}.`;
  const lead = (a) => `${clockLabel(a.date)}, ${whenWords(a.daysLeft)}`;
  const window = (a) => (a.windowLabel ? ` (${a.windowLabel})` : '');

  const T = [intro, ''];
  alerts.forEach((a, i) => {
    T.push(`${i + 1}. ${lead(a)}: ${r.text(a.titleParts)}${window(a)}`);
    if (linkOf(a)) T.push(`   ${linkOf(a)}`);
  });
  if (figures.length) T.push('', 'Figures', ...figures.flatMap(footnoteText));
  T.push('', 'Advisory only. Fathom never files, moves money or picks securities.');

  const items = alerts.map((a) => {
    const link = linkOf(a);
    const title = r.html(a.titleParts) + esc(window(a));
    return `<li style="${STYLE.li}"><span style="${STYLE.muted}">${esc(lead(a))}:</span> `
      + (link ? `<a href="${esc(link)}" style="${STYLE.link}">${title}</a>` : title) + '</li>';
  });
  const inner = [
    `<h1 style="${STYLE.h1}">${esc(subject.replace(/^Fathom: /, ''))}</h1>`,
    `<p style="${STYLE.date}">${esc(intro)}</p>`,
    `<ol style="${STYLE.ol}">${items.join('')}</ol>`,
  ];
  if (figures.length) inner.push(`<h2 style="${STYLE.h2}">Figures</h2>`, ...figures.map((f) => footnoteHtml(f)));
  inner.push(`<p style="${STYLE.date}">Advisory only. Fathom never files, moves money or picks securities.</p>`);
  // One dark card in the shared dark shell; the cell and table carry the surface twice.
  const card = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.card}" style="background-color:${C.card};border-collapse:separate;border-radius:14px"><tr>`
    + `<td bgcolor="${C.card}" style="background-color:${C.card};font-family:${FONT};color:${C.text};font-size:15px;line-height:1.5;padding:24px 22px">${inner.join('\n')}</td></tr></table>`;
  const html = darkDocument({ title: subject, rows: `<tr><td bgcolor="${C.page}" style="background-color:${C.page};padding:0">${card}</td></tr>` });

  return { subject, text: T.join('\n') + '\n', html };
}

// Sends one alert email when anything is due. Returns {alerts: count, send: email_sends row|null}.
export async function runDeadlineAlerts(db, { clock, transport, publicUrl = null, now, jobRunId = null, householdId = null } = {}) {
  const clk = resolveClock(db, clock);
  const alerts = dueAlerts(db, { clock: clk });
  if (!alerts.length) return { alerts: 0, send: null };
  const mail = renderAlerts(alerts, { clock: clk, publicUrl, householdId });
  const at = now == null ? new Date().toISOString() : new Date(now).toISOString();
  const send = await sendEmail(db, { transport, kind: 'alert', ...mail, now: at, jobRunId });
  if (send.status === 'sent') {
    const mark = db.prepare('INSERT OR IGNORE INTO deadline_alerts (key, threshold, deadline_date, sent_at, send_id) VALUES (?, ?, ?, ?, ?)');
    tx(db, () => { for (const a of alerts) mark.run(a.key, a.threshold, a.date, at, send.id); });
  }
  return { alerts: alerts.length, send };
}
