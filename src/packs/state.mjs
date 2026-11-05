// Live pack state: loaded manifests plus the store's facts drive the packs_state rows.
//
// refreshPackState maps each loaded manifest to the packs_state row whose def.manifest names it
// (else a new row with the manifest id), rewrites that row's def from the manifest with the base
// status from activePacks(packs, facts), keeps every override column and the row's label, recIds
// and what-if extras, leaves rows that were never manifest-backed alone, and deletes rows whose
// manifest is gone. The repository packs/ must load (errors throw); a broken Your plans pack in
// the data volume is skipped with a warning that carries none of its contents.
//
// createPackRefresher(db, { dataDir }) recomputes the pack dirs on every refresh and fingerprints
// the facts plus settings['packs.generation'], so a fact written by anyone or a Your plans build
// (in this process or the CLI) is picked up by refreshIfFactsChanged().

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPacks, activePacks } from './index.mjs';
import { getFacts } from '../store/facts.mjs';
import { getSetting, tx, parseJson } from '../store/db.mjs';

export const REPO_PACKS_DIR = fileURLToPath(new URL('../../packs/', import.meta.url)).replace(/[\\/]$/, '');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const YOUR_PLANS_WARNING = 'The Your plans pack could not be loaded and was skipped. Rebuild it from the Packs screen.';

export function yourPlansDir(dataDir) {
  return join(dataDir, 'packs', 'your-plans');
}

export function defaultPackDirs(dataDir = process.env.FATHOM_DATA || 'data') {
  const yp = yourPlansDir(resolve(dataDir));
  return existsSync(yp) ? [REPO_PACKS_DIR, yp] : [REPO_PACKS_DIR];
}

const isYourPlansDir = dir => basename(dir) === 'your-plans' && basename(dirname(resolve(dir))) === 'packs';

// Load every dir; repository dirs throw on any error, a your-plans dir is skipped with a warning.
function loadAll(packDirs) {
  const packs = [];
  const warnings = [];
  for (const dir of packDirs) {
    const tolerant = isYourPlansDir(dir);
    let loaded;
    try {
      loaded = loadPacks([dir]);
    } catch (e) {
      if (!tolerant) throw e;
      warnings.push(YOUR_PLANS_WARNING);
      continue;
    }
    const clash = loaded.find(p => packs.some(q => q.id === p.id));
    if (clash) {
      if (!tolerant) throw new Error(`${dir}: duplicate pack ID ${clash.id}`);
      warnings.push(YOUR_PLANS_WARNING);
      continue;
    }
    packs.push(...loaded);
  }
  return { packs: packs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), warnings };
}

const monthLabel = iso => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

function packDef(pack, { rowId, prior, status, why, recIds }) {
  return {
    ...prior,
    id: rowId,
    manifest: pack.id,
    name: prior.label ?? pack.name,
    status,
    why,
    covers: [...pack.covers],
    entries: pack.entries.length,
    entryList: pack.entries.map(e => ({ id: e.id, title: e.title, cites: e.cites.map(c => ({ label: c.label, url: c.url })) })),
    curator: pack.curator,
    version: pack.version,
    taxYear: pack.taxYear,
    reviewed: pack.reviewed,
    updated: monthLabel(pack.reviewed),
    recIds: prior.recIds ?? recIds,
    whatIf: { prompt: pack.whatIf.prompt, a: prior.whatIf?.a ?? [], unlocks: prior.whatIf?.unlocks ?? [] },
  };
}

export function refreshPackState(db, { packDirs = defaultPackDirs() } = {}) {
  const { packs, warnings } = loadAll(packDirs);
  const activation = activePacks(packs, getFacts(db));
  const now = new Date().toISOString();
  tx(db, () => {
    const rows = db.prepare('SELECT id, def, sort FROM packs_state ORDER BY sort, id').all()
      .map(r => ({ id: r.id, raw: r.def, def: parseJson(r.def, null), sort: r.sort }));
    const byManifest = new Map(rows.filter(r => r.def && typeof r.def.manifest === 'string').map(r => [r.def.manifest, r]));
    const recsOf = db.prepare('SELECT id FROM recs WHERE pack_id = ? ORDER BY sort, id');
    const update = db.prepare('UPDATE packs_state SET def = ?, updated_at = ? WHERE id = ?');
    const insert = db.prepare(`INSERT INTO packs_state (id, def, active, exploring, what_if_asked, what_if_done, unhid, sort, updated_at)
                               VALUES (?, ?, NULL, 0, 0, 0, '[]', ?, ?)`);
    let nextSort = rows.reduce((m, r) => Math.max(m, Number(r.sort) || 0), -1) + 1;
    for (const { pack, status, why } of activation) {
      let row = byManifest.get(pack.id);
      if (!row) {
        // A row already holding this id that was never manifest-backed keeps it, unless it has no
        // usable def; the manifest then gets its own row id.
        const same = rows.find(r => r.id === pack.id);
        row = same && (!same.def || !Object.keys(same.def).length) ? same : null;
      }
      const rowId = row ? row.id : (rows.some(r => r.id === pack.id) ? `manifest-${pack.id}` : pack.id);
      const prior = row && row.def ? row.def : {};
      const def = packDef(pack, { rowId, prior, status, why, recIds: recsOf.all(rowId).map(r => r.id) });
      const json = JSON.stringify(def);
      if (row) {
        if (row.raw !== json) update.run(json, now, rowId);
      } else {
        insert.run(rowId, json, nextSort++, now);
      }
    }
    const loadedIds = new Set(packs.map(p => p.id));
    const remove = db.prepare('DELETE FROM packs_state WHERE id = ?');
    for (const r of rows) if (r.def && typeof r.def.manifest === 'string' && !loadedIds.has(r.def.manifest)) remove.run(r.id);
  });
  return { packs, activation, warnings };
}

function fingerprint(db) {
  const hash = createHash('sha256');
  for (const r of db.prepare('SELECT key, value, confirmed FROM facts ORDER BY key').all()) {
    hash.update(JSON.stringify([r.key, r.value, r.confirmed]));
  }
  hash.update(JSON.stringify(['packs.generation', getSetting(db, 'packs.generation', 0)]));
  return hash.digest('hex');
}

export function createPackRefresher(db, { dataDir } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('createPackRefresher needs a dataDir');
  let packs = [];
  let seen = null;
  const refresh = () => {
    const result = refreshPackState(db, { packDirs: defaultPackDirs(dataDir) });
    packs = result.packs;
    seen = fingerprint(db);
    for (const w of result.warnings) console.warn(`fathom: ${w}`);
    return result;
  };
  return {
    refresh,
    refreshIfFactsChanged() {
      if (seen !== null && fingerprint(db) === seen) return false;
      refresh();
      return true;
    },
    loaded: () => packs,
    entry(rowId, entryId) {
      const row = db.prepare('SELECT def FROM packs_state WHERE id = ?').get(rowId);
      const def = row ? parseJson(row.def, null) : null;
      if (!def || typeof def.manifest !== 'string') return null;
      const found = packs.find(p => p.id === def.manifest)?.entries.find(e => e.id === entryId);
      return found ? { id: found.id, title: found.title, body: found.body, cites: found.cites.map(c => ({ label: c.label, url: c.url })) } : null;
    },
  };
}
