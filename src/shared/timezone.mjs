import { getSetting } from '../store/db.mjs';

export const DEFAULT_TIMEZONE = 'America/New_York';

export function validTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export function ownerTimezone(db) {
  const tz = getSetting(db, 'timezone', null);
  return validTimezone(tz) ? tz : DEFAULT_TIMEZONE;
}

