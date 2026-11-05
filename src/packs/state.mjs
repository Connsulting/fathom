// Pack state seam: packs_state rows carry the CONTRACT pack def computed from the loaded packs and
// the stored facts. Owner columns (active, exploring, what_if_*, unhid) and the previous what-if
// answers are kept; rows for packs that are no longer loaded are removed; updated_at moves only
// when the def changes.
//
// defaultPackDirs(dataDir)            -> [repo packs/, plus <dataDir>/packs/your-plans when present]
// refreshPackStateIn(db, {packDirs})  -> [{id, status, why}] (assumes the caller's transaction)
// refreshPackState(db, {packDirs})    -> the same, in its own transaction

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tx, parseJson } from '../store/db.mjs';
import { getFacts } from '../store/facts.mjs';
import { loadPacks, activePacks } from './index.mjs';

export const REPO_PACKS_DIR = fileURLToPath(new URL('../../packs/', import.meta.url));

function isDir(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export function defaultPackDirs(dataDir = process.env.FATHOM_DATA) {
  const dirs = [REPO_PACKS_DIR];
  if (dataDir) {
    const yours = join(dataDir, 'packs', 'your-plans');
    if (isDir(yours)) dirs.push(yours);
  }
  return dirs;
}

export function refreshPackStateIn(db, { packDirs = defaultPackDirs() } = {}) {
  const packs = loadPacks(packDirs);
  const activation = activePacks(packs, getFacts(db));
  const existing = new Map(db.prepare('SELECT * FROM packs_state').all().map(r => [r.id, r]));
  const recIdsOf = db.prepare('SELECT id FROM recs WHERE pack_id = ? ORDER BY id');
  const insert = db.prepare(`INSERT INTO packs_state (id, def, active, exploring, what_if_asked, what_if_done, unhid, sort, updated_at)
                             VALUES (?, ?, NULL, 0, 0, 0, '[]', ?, ?)`);
  const updateDef = db.prepare('UPDATE packs_state SET def = ?, sort = ?, updated_at = ? WHERE id = ?');
  const updateSort = db.prepare('UPDATE packs_state SET sort = ? WHERE id = ?');
  const now = new Date().toISOString();
  activation.forEach(({ pack, status, why }, sort) => {
    const row = existing.get(pack.id);
    const prev = row ? parseJson(row.def, {}) : {};
    const prevWhatIf = prev && prev.whatIf ? prev.whatIf : {};
    const def = {
      id: pack.id,
      name: pack.name,
      status,
      why,
      covers: pack.covers,
      entries: pack.entries.length,
      curator: pack.curator,
      updated: pack.reviewed,
      recIds: recIdsOf.all(pack.id).map(r => r.id),
      whatIf: {
        prompt: pack.whatIf.prompt,
        a: Array.isArray(prevWhatIf.a) ? prevWhatIf.a : [],
        unlocks: Array.isArray(prevWhatIf.unlocks) ? prevWhatIf.unlocks : [],
      },
    };
    const text = JSON.stringify(def);
    if (!row) insert.run(pack.id, text, sort, now);
    else if (row.def !== text) updateDef.run(text, sort, now, pack.id);
    else if (row.sort !== sort) updateSort.run(sort, pack.id);
    existing.delete(pack.id);
  });
  const remove = db.prepare('DELETE FROM packs_state WHERE id = ?');
  for (const id of existing.keys()) remove.run(id);
  return activation.map(({ pack, status, why }) => ({ id: pack.id, status, why }));
}

export function refreshPackState(db, opts = {}) {
  return tx(db, () => refreshPackStateIn(db, opts));
}
