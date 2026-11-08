import { HttpError } from './http.mjs';

export async function requestBackup({ backups, body, query, identity }) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new HttpError(400, 'body must be an empty object');
  if (Object.keys(query ?? {}).length) throw new HttpError(400, 'backup requests take no query parameters');
  if (!backups) throw new HttpError(409, 'backup_unavailable');
  try { return await backups.queue(identity.householdId); }
  catch (err) { throw new HttpError(409, backups.code(err)); }
}

export function backupStatus({ backups, identity, params }) {
  const result = backups?.status(identity.householdId, params.id);
  if (!result) throw new HttpError(404, 'not found');
  return result;
}
