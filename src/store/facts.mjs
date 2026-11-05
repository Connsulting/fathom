// Facts seam: one writer for the facts table. Owner answers (confirmed) are never replaced by an
// unconfirmed write, and an identical write changes nothing, so jobs can rerun idempotently.
//
// upsertFact(db, {key, value, src, asOf, confirmed, provenance: {fileId, parser, locator}})
//   -> {written: true} | {written: false, reason: 'confirmed' | 'unchanged'}
// getFacts(db) -> {'dotted.key': parsedValue} for every row

import { parseJson } from './db.mjs';

const locatorText = locator => (locator == null ? null : typeof locator === 'string' ? locator : JSON.stringify(locator));

export function upsertFact(db, { key, value, src, asOf = null, confirmed = false, provenance = {} }) {
  if (typeof key !== 'string' || !key) throw new TypeError('fact key is required');
  const row = db.prepare('SELECT * FROM facts WHERE key = ?').get(key);
  const conf = confirmed ? 1 : 0;
  if (row && row.confirmed && !conf) return { written: false, reason: 'confirmed' };
  const next = {
    value: JSON.stringify(value === undefined ? null : value),
    src: src ?? null,
    as_of: asOf ?? null,
    confirmed: conf,
    file_id: provenance.fileId ?? null,
    parser: provenance.parser ?? null,
    locator: locatorText(provenance.locator),
  };
  if (row && Object.keys(next).every(k => row[k] === next[k])) return { written: false, reason: 'unchanged' };
  db.prepare(`INSERT INTO facts (key, value, src, as_of, confirmed, file_id, parser, locator, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, src = excluded.src, as_of = excluded.as_of,
                confirmed = excluded.confirmed, file_id = excluded.file_id, parser = excluded.parser,
                locator = excluded.locator, updated_at = excluded.updated_at`)
    .run(key, next.value, next.src, next.as_of, next.confirmed, next.file_id, next.parser, next.locator, new Date().toISOString());
  return { written: true };
}

export function getFacts(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM facts ORDER BY key').all()) out[r.key] = parseJson(r.value, null);
  return out;
}
