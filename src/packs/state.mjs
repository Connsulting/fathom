// Refresh packs_state from the loaded pack manifests and the stored facts.
// Replaces each pack definition's base fields (id, name, status, why, covers, entries count,
// curator, updated) and keeps the definition fields a manifest lacks (recIds, whatIf.a,
// whatIf.unlocks) plus the override columns (active, exploring, what_if_*, unhid).
// Demo stores are left alone: their pack definitions are the seeded scenario.

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting, parseJson, tx } from '../store/db.mjs';
import { getFacts } from '../store/facts.mjs';
import { escapeUserText } from '../shared/tokens.mjs';
import { activePacks, loadPacks } from './index.mjs';

export const REPO_PACKS_DIR = fileURLToPath(new URL('../../packs/', import.meta.url)).replace(/[\\/]$/, '');

export function defaultPackDirs(dataDir) {
  const dirs = [REPO_PACKS_DIR];
  if (dataDir) {
    const plans = join(dataDir, 'packs', 'your-plans');
    if (existsSync(plans) && statSync(plans).isDirectory()) dirs.push(plans);
  }
  return dirs;
}

function definition(prev, { pack, status, why }) {
  const whatIf = prev.whatIf && typeof prev.whatIf === 'object' ? prev.whatIf : {};
  return {
    ...prev,
    id: pack.id,
    name: pack.name,
    status,
    why: escapeUserText(why),
    covers: [...pack.covers],
    entries: pack.entries.length,
    curator: pack.curator,
    updated: pack.reviewed,
    recIds: Array.isArray(prev.recIds) ? prev.recIds : [],
    whatIf: {
      ...whatIf,
      prompt: pack.whatIf.prompt,
      a: Array.isArray(whatIf.a) ? whatIf.a : [],
      unlocks: Array.isArray(whatIf.unlocks) ? whatIf.unlocks : [],
    },
  };
}

export function refreshPackState(db, { packDirs, dataDir, now } = {}) {
  if (getSetting(db, 'mode', null) === 'demo') return { updated: 0, inserted: 0 };
  const packs = loadPacks(packDirs ?? defaultPackDirs(dataDir));
  const activation = activePacks(packs, getFacts(db));
  const stamp = now || new Date().toISOString();
  const select = db.prepare('SELECT def FROM packs_state WHERE id = ?');
  const update = db.prepare('UPDATE packs_state SET def = ?, updated_at = ? WHERE id = ?');
  const insert = db.prepare(`INSERT INTO packs_state (id, def, active, exploring, what_if_asked, what_if_done, unhid, sort, updated_at)
                             VALUES (?, ?, NULL, 0, 0, 0, '[]', ?, ?)`);
  const nextSort = db.prepare('SELECT coalesce(max(sort) + 1, 0) AS n FROM packs_state');
  let updated = 0;
  let inserted = 0;
  const run = () => {
    for (const item of activation) {
      const row = select.get(item.pack.id);
      if (row) {
        const prev = parseJson(row.def, {});
        const def = JSON.stringify(definition(prev && typeof prev === 'object' ? prev : {}, item));
        if (def === row.def) continue;
        update.run(def, stamp, item.pack.id);
        updated += 1;
      } else {
        insert.run(item.pack.id, JSON.stringify(definition({}, item)), nextSort.get().n, stamp);
        inserted += 1;
      }
    }
  };
  if (db.isTransaction) run();
  else tx(db, run);
  return { updated, inserted };
}
