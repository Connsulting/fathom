// Synthetic knowledge pack fixtures. A pack written to <dataDir>/packs/your-plans/ is loaded by
// createPackRefresher and by a server whose FATHOM_DATA is that dataDir (the data volume pack
// directory), so tests can exercise manifest-backed behavior without touching repository packs.
// Contents are synthetic: no real names, amounts tied to a household, hosts or paths.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DATA_PACK_DIR = dataDir => join(dataDir, 'packs', 'your-plans');

// Never matches: the fact is never set, so the pack is available (not active) and offers What if.
export const NEVER = { fact: 'synthetic.never', op: 'eq', value: true };
// Always matches: the pack is active with no facts at all.
export const ALWAYS = { all: [] };

// writeSyntheticPack(dataDir, { id, name, prompt, appliesWhen, covers, entries: [{ file, title, body }] }) -> dir
// Replaces any pack already in the data volume pack directory.
export function writeSyntheticPack(dataDir, {
  id = 'synthetic-pack',
  name = 'Synthetic pack',
  prompt = 'What would change for a synthetic household?',
  appliesWhen = NEVER,
  covers = ['synthetic coverage'],
  entries = [{ file: 'synthetic-entry.md', title: 'Synthetic entry', body: '# Synthetic entry\n\nA synthetic entry body with no numbers.\n' }],
} = {}) {
  const dir = DATA_PACK_DIR(dataDir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const e of entries) writeFileSync(join(dir, e.file), e.body);
  const manifest = {
    id, name, version: '1.0.0', taxYear: 2026, reviewed: '2026-11-05', curator: 'Synthetic test fixture',
    covers, appliesWhen, whatIf: { prompt },
    entries: entries.map(e => ({ file: e.file, title: e.title, cites: [{ label: 'Synthetic citation', url: 'https://example.invalid/synthetic' }] })),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return dir;
}

export function removeSyntheticPack(dataDir) {
  rmSync(DATA_PACK_DIR(dataDir), { recursive: true, force: true });
}
