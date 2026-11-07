// Canonical row digests: rows as JSON with sorted keys, BLOBs as tagged hex, sorted, then
// sha256. Equal digests mean equal row sets whatever the row order. Only counts and hex digests
// leave this module.

import { createHash } from 'node:crypto';
import { listTables } from '../store/db.mjs';

const sha256 = text => createHash('sha256').update(text).digest('hex');

function canonicalValue(v) {
  if (v instanceof Uint8Array) return { blob: Buffer.from(v).toString('hex') };
  if (typeof v === 'bigint') return { int: v.toString() };
  return v;
}

export function canonicalRow(row) {
  const out = {};
  for (const k of Object.keys(row).sort()) out[k] = canonicalValue(row[k]);
  return JSON.stringify(out);
}

// { count, sha256 } of a row list.
export function rowsDigest(rows) {
  const lines = rows.map(canonicalRow).sort();
  return { count: lines.length, sha256: sha256(lines.join('\n')) };
}

export const quoteIdent = name => `"${String(name).replace(/"/g, '""')}"`;

export function tableRows(db, table, columns = null) {
  const cols = columns ? columns.map(quoteIdent).join(', ') : '*';
  return db.prepare(`SELECT ${cols} FROM ${quoteIdent(table)}`).all();
}

// One digest over every user table of a database (names and rows).
export function logicalDigest(db) {
  const h = createHash('sha256');
  for (const t of listTables(db)) {
    const d = rowsDigest(tableRows(db, t));
    h.update(`${t}\u0000${d.count}\u0000${d.sha256}\n`);
  }
  return h.digest('hex');
}
