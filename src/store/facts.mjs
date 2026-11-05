// Household facts (frozen fact keys in docs/architecture.md). A confirmed fact is never
// overwritten by an unconfirmed one: the owner's word beats a parser's.
//
// upsertFact(db, { key, value, src, asOf, confirmed, provenance: { fileId, parser, locator } }) -> { changed }
// getFacts(db) -> { '<dotted.key>': value }

import { parseJson } from './db.mjs';

export function upsertFact(db, { key, value, src = null, asOf = null, confirmed = false, provenance = {} } = {}) {
  if (typeof key !== 'string' || !key) throw new TypeError('fact key is required');
  if (value === undefined) throw new TypeError('fact value is required');
  const json = JSON.stringify(value);
  const prior = db.prepare('SELECT value, confirmed FROM facts WHERE key = ?').get(key);
  if (prior && prior.confirmed && !confirmed) return { changed: false };
  if (prior && prior.value === json && !!prior.confirmed === !!confirmed) return { changed: false };
  const { fileId = null, parser = null, locator = null } = provenance || {};
  db.prepare(`INSERT INTO facts (key, value, src, as_of, confirmed, file_id, parser, locator, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, src = excluded.src, as_of = excluded.as_of,
                confirmed = excluded.confirmed, file_id = excluded.file_id, parser = excluded.parser,
                locator = excluded.locator, updated_at = excluded.updated_at`)
    .run(key, json, src, asOf, confirmed ? 1 : 0, fileId, parser, locator == null ? null : String(locator), new Date().toISOString());
  return { changed: true };
}

export function getFacts(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM facts ORDER BY key').all()) out[r.key] = parseJson(r.value, r.value);
  return out;
}
