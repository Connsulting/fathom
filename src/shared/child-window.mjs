import { isoDate } from '../ingest/format.mjs';

export function expectedChildWindow(facts) {
  const due = facts['household.expectedDate'];
  if (typeof due !== 'string' || isoDate(due) !== due) return null;
  const date = new Date(due + 'T00:00:00Z');
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return { close: due, label: `${month} ${date.getUTCDate()}`, hard: false };
}
