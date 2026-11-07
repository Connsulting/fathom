// Synthetic knowledge pack fixtures. A pack written to <root>/packs/your-plans/ of a household root
// (households/<id> under the data directory) is loaded by createLivePacks(db, { dataDir: root })
// and by that household's runtime in a server, so tests can exercise manifest-backed behavior
// without touching repository packs. The functions take the household root.
// Contents are synthetic: no real names, amounts tied to a household, hosts or paths.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DATA_PACK_DIR = root => join(root, 'packs', 'your-plans');

// Never matches: the fact is never set, so the pack is available (not active) and offers What if.
export const NEVER = { fact: 'synthetic.never', op: 'eq', value: true };
// Always matches: the pack is active with no facts at all.
export const ALWAYS = { all: [] };

// writeSyntheticPack(root, { id, name, version, curator, prompt, appliesWhen, covers, entries: [{ file, title, body }] }) -> dir
// Replaces any pack already in the data volume pack directory.
export function writeSyntheticPack(root, {
  id = 'synthetic-pack',
  name = 'Synthetic pack',
  version = '1.0.0',
  curator = 'Synthetic test fixture',
  prompt = 'What would change for a synthetic household?',
  appliesWhen = NEVER,
  covers = ['synthetic coverage'],
  entries = [{ file: 'synthetic-entry.md', title: 'Synthetic entry', body: '# Synthetic entry\n\nA synthetic entry body with no numbers.\n' }],
} = {}) {
  const dir = DATA_PACK_DIR(root);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const e of entries) writeFileSync(join(dir, e.file), e.body);
  const manifest = {
    id, name, version, taxYear: 2026, reviewed: '2026-11-05', curator,
    covers, appliesWhen, whatIf: { prompt },
    entries: entries.map(e => ({ file: e.file, title: e.title, cites: [{ label: 'Synthetic citation', url: 'https://example.invalid/synthetic' }] })),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return dir;
}

export function removeSyntheticPack(root) {
  rmSync(DATA_PACK_DIR(root), { recursive: true, force: true });
}
