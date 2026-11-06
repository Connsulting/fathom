// Recommendation status rules shared by the server and the browser (served at /shared/rules.mjs).
// Browser safe: no node imports. Implements the CONTRACT.md store and status rules.

export const ACTION_STATUS = Object.freeze({
  start: 'doing', // "Doing it": the owner has committed; the rec is in motion with its steps tracked
  complete: 'done',
  dismiss: 'dismissed',
  snooze: 'snoozed',
  reopen: 'proposed',
});

// Every status a rec can hold. 'hidden' means behind an inactive knowledge pack.
export const STATUSES = Object.freeze(['proposed', 'doing', 'waiting', 'snoozed', 'done', 'dismissed', 'hidden']);

// Window in whole days, or 9999 when the rec has none.
export function windowDays(rec) {
  return rec && rec.window && typeof rec.window.days === 'number' ? rec.window.days : 9999;
}

// CONTRACT needs-you rule: proposed, or doing with the window closing within 30 days.
export function needsRule(status, rec) {
  return status === 'proposed' || (status === 'doing' && windowDays(rec) <= 30);
}

// Recs needing the person now, sorted by window (stable, so ties keep scenario order).
export function needsYou(recs) {
  return (Array.isArray(recs) ? recs : [])
    .filter(r => r && r.status !== 'hidden' && needsRule(r.status, r))
    .map((r, i) => ({ r, i }))
    .sort((a, b) => windowDays(a.r) - windowDays(b.r) || a.i - b.i)
    .map(x => x.r);
}

export function verdictLevel(recs) {
  return needsYou(recs).length ? 'attention' : 'clear';
}

// Live status of a knowledge pack from its base status and the live overrides
// ({ active: boolean|null, exploring: boolean }), with the mock's semantics.
export function packStatus(baseStatus, live) {
  const l = live || {};
  const active = l.active != null ? !!l.active : baseStatus === 'active';
  if (active) return 'active';
  if (l.exploring) return 'exploring';
  return baseStatus === 'active' ? 'available' : baseStatus;
}
