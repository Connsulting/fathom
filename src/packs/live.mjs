// Live packs over main's pack state (src/packs/state.mjs): the loaded manifests, the manifest
// backing each packs_state row, and the manifest fields the Packs screen and the answerer read.
//
// `dataDir` below is always a household root (households/<id> under FATHOM_DATA).
//
// yourPlansDir(dataDir) -> <dataDir>/packs/your-plans
// loadLivePacks(dataDir) -> { packs, dirs, warnings }: the repository packs (any error throws) plus
//   the Your plans pack when it loads; a broken one is skipped with a warning carrying none of its
//   contents.
// refreshLivePacks(db, { dataDir, now? }) -> { packs, warnings }: refreshPackState over the
//   loadable dirs (real stores), then, in a demo store, one row for each loaded pack no row backs
//   when it is outside the repository (the Your plans pack) or active for every household. The seed
//   already holds the other repository packs, and those rows are left as seeded.
// createLivePacks(db, { dataDir }) -> { loaded(), backing(rowId, def), view(rowId, def), entry(rowId, entryId), refresh() }
//   loaded() reloads when settings['packs.generation'] or the Your plans directory changes, so a
//   build in this process or the CLI is picked up without a restart.
//   backing() is the loaded pack whose id is manifestIdOf(rowId, def): def.manifest (demo rows)
//   or else the row id, the same link the MCP pack tools use.
//   view() is the row def plus the backing manifest's covers, entry count and list, curator,
//   version, tax year, reviewed date and What if prompt, `manifest` set to its id, and `why` from
//   activePacks over the stored facts (escaped, as refreshPackState stores it), since the UI renders
//   manifest-backed text literally. The row's name, base status, recIds and what-if answers stay.

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadPacks, activePacks, evaluate, getEntry, manifestIdOf } from './index.mjs';
import { REPO_PACKS_DIR, refreshPackState } from './state.mjs';
import { getFacts } from '../store/facts.mjs';
import { getSetting, parseJson, tx } from '../store/db.mjs';
import { escapeUserText } from '../shared/tokens.mjs';
import { planCoverage, saveLoadFailure, coveredPacks } from './coverage.mjs';

const YOUR_PLANS_WARNING = 'The Your plans pack could not be loaded and was skipped. Rebuild it from the Packs screen.';

export function yourPlansDir(dataDir) {
  return join(dataDir, 'packs', 'your-plans');
}

export function loadLivePacks(dataDir) {
  const packs = loadPacks([REPO_PACKS_DIR]);
  const dirs = [REPO_PACKS_DIR];
  const warnings = [];
  const dir = yourPlansDir(resolve(dataDir));
  if (existsSync(dir)) {
    try {
      const plans = loadPacks([dir]);
      if (!plans.length) throw new Error('empty pack');
      if (plans.some(p => packs.some(q => q.id === p.id))) throw new Error('duplicate pack id');
      packs.push(...plans);
      dirs.push(dir);
    } catch {
      warnings.push(YOUR_PLANS_WARNING);
    }
  }
  return { packs: packs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), dirs, warnings };
}

export function refreshLivePacks(db, { dataDir, now } = {}) {
  const { packs, dirs, warnings } = loadLivePacks(dataDir);
  saveLoadFailure(db, warnings.length > 0 || (!!getSetting(db, 'yourPlans', null) && !packs.some(p => p.id === 'your-plans')));
  const stamp = now || new Date().toISOString();
  tx(db, () => {
    refreshPackState(db, { packDirs: dirs, now: stamp });
    if (getSetting(db, 'mode', null) !== 'demo') return;
    const rows = db.prepare('SELECT id, def FROM packs_state').all();
    const backed = new Set(rows.map(r => manifestIdOf(r.id, parseJson(r.def, null))));
    const repoRoot = resolve(REPO_PACKS_DIR);
    const repositoryPack = pack => {
      const dir = resolve(pack.directory);
      return dir === repoRoot || dir.startsWith(`${repoRoot}/`);
    };
    const alwaysActive = pack => {
      try { return evaluate(pack.appliesWhen, {}) === true; }
      catch { return false; }
    };
    const missing = packs.filter(p => !backed.has(p.id) && !rows.some(r => r.id === p.id)
      && (!repositoryPack(p) || alwaysActive(p)));
    const insert = db.prepare(`INSERT INTO packs_state (id, def, active, exploring, what_if_asked, what_if_done, unhid, sort, updated_at)
                               VALUES (?, ?, NULL, 0, 0, 0, '[]', (SELECT coalesce(max(sort) + 1, 0) FROM packs_state), ?)`);
    for (const { pack, status, why } of activePacks(missing, getFacts(db))) {
      insert.run(pack.id, JSON.stringify({
        id: pack.id, name: pack.name, status, why: escapeUserText(why), covers: [...pack.covers], entries: pack.entries.length,
        curator: pack.curator, updated: pack.reviewed, recIds: [], whatIf: { prompt: pack.whatIf.prompt, a: [], unlocks: [] },
      }), stamp);
    }
  });
  for (const w of warnings) console.warn(`fathom: ${w}`);
  return { packs, warnings };
}

const cites = entry => entry.cites.map(c => ({ label: c.label, url: c.url }));

export function createLivePacks(db, { dataDir } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('createLivePacks needs a dataDir');
  const dir = yourPlansDir(resolve(dataDir));
  let packs = [];
  let seen = null;

  const fingerprint = () => {
    const generation = getSetting(db, 'packs.generation', 0);
    let plans = 'none';
    try {
      const st = statSync(dir);
      const files = ['manifest.json', ...packs.filter(p => resolve(p.directory) === dir).flatMap(p => p.entries.map(e => e.file))];
      plans = JSON.stringify([st.ino, st.mtimeMs, ...files.map(file => {
        try { const s = statSync(join(dir, file)); return [file, s.ino, s.mtimeMs, s.size]; }
        catch { return [file, 'missing']; }
      })]);
    } catch { /* no Your plans pack */ }
    return JSON.stringify([generation, plans]);
  };

  function loaded() {
    const now = fingerprint();
    if (now !== seen) {
      const result = loadLivePacks(dataDir);
      for (const w of result.warnings) console.warn(`fathom: ${w}`);
      packs = result.packs;
      saveLoadFailure(db, result.warnings.length > 0 || (!!getSetting(db, 'yourPlans', null) && !packs.some(p => p.id === 'your-plans')));
      seen = fingerprint();
    }
    return coveredPacks(db, packs);
  }

  function backing(rowId, def) {
    const id = manifestIdOf(rowId, def);
    return loaded().find(p => p.id === id) || null;
  }

  function view(rowId, def) {
    const pack = backing(rowId, def);
    const coverage = rowId === 'your-plans' || manifestIdOf(rowId, def) === 'your-plans' ? planCoverage(db) : [];
    if (!pack) return coverage.length ? { ...def, coverage, entries: 0, entryList: [] } : def;
    const whatIf = def.whatIf && typeof def.whatIf === 'object' ? def.whatIf : {};
    const [{ why }] = activePacks([pack], getFacts(db));
    return {
      ...def,
      ...(coverage.length ? { coverage } : {}),
      manifest: pack.id,
      why: escapeUserText(why),
      covers: [...pack.covers],
      entries: pack.entries.length,
      entryList: pack.entries.map(e => ({ id: e.id, title: e.title, cites: cites(e) })),
      curator: pack.curator,
      version: pack.version,
      taxYear: pack.taxYear,
      reviewed: pack.reviewed,
      whatIf: { ...whatIf, prompt: pack.whatIf.prompt },
    };
  }

  function entry(rowId, entryId) {
    const row = db.prepare('SELECT def FROM packs_state WHERE id = ?').get(rowId);
    const pack = row ? backing(rowId, parseJson(row.def, null)) : null;
    const found = pack ? getEntry([pack], pack.id, entryId) : null;
    return found ? { id: found.id, title: found.title, body: found.body, cites: cites(found) } : null;
  }

  function refresh() {
    const result = refreshLivePacks(db, { dataDir });
    packs = result.packs;
    seen = fingerprint();
    return result;
  }

  return { loaded, backing, view, entry, refresh };
}
