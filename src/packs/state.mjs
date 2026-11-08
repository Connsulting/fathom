// Refresh packs_state from the loaded pack manifests and the stored facts.
// Replaces each pack definition's base fields (id, name, status, why, covers, entries count,
// curator, updated) and keeps the definition fields a manifest lacks (recIds, whatIf.a,
// whatIf.unlocks) plus the override columns (active, exploring, what_if_*, unhid).
// Demo stores are left alone: their pack definitions are the seeded scenario.

import { ToolError } from '../tools/errors.mjs';
import { packStatus } from '../shared/rules.mjs';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting, parseJson, actionTx } from '../store/db.mjs';
import { getFacts } from '../store/facts.mjs';
import { escapeUserText } from '../shared/tokens.mjs';
import { activePacks, loadPacks } from './index.mjs';
import { mapSeries } from '../shared/series.mjs';

export const REPO_PACKS_DIR = fileURLToPath(new URL('../../packs/', import.meta.url)).replace(/[\\/]$/, '');

// The repository packs plus the Your plans pack under `dataDir`, the household root, when present.
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

export async function refreshPackState(db, { packDirs, dataDir, now } = {}) {
  if (await getSetting(db, 'mode', null) === 'demo') return { updated: 0, inserted: 0 };
  const packs = loadPacks(packDirs ?? defaultPackDirs(dataDir));
  const activation = activePacks(packs, await getFacts(db));
  const stamp = now || new Date().toISOString();
  let updated = 0;
  let inserted = 0;
  const run = async db => {
    const select = db.prepare('SELECT def FROM packs_state WHERE id = ?');
    const update = db.prepare('UPDATE packs_state SET def = ?, updated_at = ? WHERE id = ?');
    const insert = db.prepare(`INSERT INTO packs_state (id, def, active, exploring, what_if_asked, what_if_done, unhid, sort, updated_at)
                               VALUES (?, ?, NULL, 0, 0, 0, '[]', ?, ?)`);
    const nextSort = db.prepare('SELECT coalesce(max(sort) + 1, 0) AS n FROM packs_state');
    for (const item of activation) {
      const row = await select.get(item.pack.id);
      if (row) {
        const prev = parseJson(row.def, {});
        const def = JSON.stringify(definition(prev && typeof prev === 'object' ? prev : {}, item));
        if (def === row.def) continue;
        await update.run(def, stamp, item.pack.id);
        updated += 1;
      } else {
        await insert.run(item.pack.id, JSON.stringify(definition({}, item)), (await nextSort.get()).n, stamp);
        inserted += 1;
      }
    }
  };
  await actionTx(db, run);
  return { updated, inserted };
}

export const packIsActive = row => row.active == null ? parseJson(row.def, {}).status === 'active' : !!row.active;

export async function packActivationState(db, id) {
  const pack = await db.prepare('SELECT * FROM packs_state WHERE id = ?').get(id);
  if (!pack) throw new ToolError('not_found', 'No such pack.');
  const recs = await mapSeries((parseJson(pack.def, {}).recIds ?? []), async rid => await db.prepare('SELECT id, status, updated_at FROM recs WHERE id = ?').get(rid) ?? null);
  return { pack: { ...pack }, recs: recs.map(r => r ? { ...r } : null) };
}

export async function setPackActive(db, id, active, { now = new Date().toISOString(), actorId = 'ui' } = {}) {
  if (typeof active !== 'boolean') throw new ToolError('bad_input', 'active must be a boolean.');
  const run = async db => {
    const before = await packActivationState(db, id), row = before.pack, def = parseJson(row.def, {});
    const wasActive = packIsActive(row);
    if (active !== wasActive) {
      const unhid = [];
      const powered = new Set((await db.prepare('SELECT * FROM packs_state WHERE id <> ?').all(id)).filter(packIsActive)
        .flatMap(p => parseJson(p.def, {}).recIds ?? []));
      for (const rid of active ? def.recIds ?? [] : parseJson(row.unhid, [])) {
        const rec = await db.prepare('SELECT status FROM recs WHERE id = ?').get(rid);
        const from = active ? 'hidden' : 'proposed', to = active ? 'proposed' : 'hidden';
        if (rec?.status !== from || (!active && powered.has(rid))) continue;
        await db.prepare('UPDATE recs SET status = ?, updated_at = ? WHERE id = ?').run(to, now, rid);
        await db.prepare('INSERT INTO rec_events(rec_id,ts,action,arg,from_status,to_status,actor) VALUES (?,?,?,?,?,?,?)')
          .run(rid, now, active ? 'pack_on' : 'pack_off', id, from, to, actorId);
        if (active) unhid.push(rid);
      }
      await db.prepare('UPDATE packs_state SET active = ?, unhid = ?, updated_at = ? WHERE id = ?')
        .run(active ? 1 : 0, JSON.stringify(unhid), now, id);
    }
    const after = await packActivationState(db, id);
    return { pack: { id, status: packStatus(def.status, { active, exploring: !!after.pack.exploring }) }, wasActive, before, after };
  };
  return await actionTx(db, run);
}
