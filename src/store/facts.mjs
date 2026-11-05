// Household facts: flat dotted keys with JSON values and provenance (docs/architecture.md, Facts).
// A confirmed fact is never overwritten by an unconfirmed one and never deleted by an import.

export function upsertFact(db, { key, value, src = null, asOf = null, confirmed = false, provenance = {}, now } = {}) {
  if (typeof key !== 'string' || key.trim() === '') throw new TypeError('A fact key is required');
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('A fact value must be JSON');
  const existing = db.prepare('SELECT value, src, as_of, confirmed, file_id, parser, locator FROM facts WHERE key = ?').get(key);
  if (existing && existing.confirmed && !confirmed) return { written: false, reason: 'confirmed' };
  const { fileId = null, parser = null, locator = null } = provenance || {};
  const loc = locator == null || typeof locator === 'string' ? locator : JSON.stringify(locator);
  // An identical write (value and every provenance column) is a no-op: no statement, no
  // updated_at churn.
  if (existing && existing.value === json && existing.src === src && existing.as_of === asOf
    && existing.confirmed === (confirmed ? 1 : 0) && existing.file_id === fileId && existing.parser === parser
    && existing.locator === loc) {
    return { written: false, changed: false, reason: 'unchanged' };
  }
  db.prepare(`INSERT INTO facts (key, value, src, as_of, confirmed, file_id, parser, locator, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, src = excluded.src, as_of = excluded.as_of,
                confirmed = excluded.confirmed, file_id = excluded.file_id, parser = excluded.parser,
                locator = excluded.locator, updated_at = excluded.updated_at`)
    .run(key, json, src, asOf, confirmed ? 1 : 0, fileId, parser, loc, now || new Date().toISOString());
  return { written: true, changed: !existing || existing.value !== json };
}

// { 'household.state': 'VA', ... } with JSON-decoded values; malformed rows are skipped.
export function getFacts(db) {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM facts ORDER BY key').all()) {
    try { out[row.key] = JSON.parse(row.value); } catch { /* skip a malformed value */ }
  }
  return out;
}

// Deletes the fact only when it is unconfirmed and came from that file.
export function deleteFact(db, key, { fileId } = {}) {
  if (fileId == null) return { deleted: false };
  const r = db.prepare('DELETE FROM facts WHERE key = ? AND file_id = ? AND confirmed = 0').run(key, fileId);
  return { deleted: r.changes > 0 };
}
