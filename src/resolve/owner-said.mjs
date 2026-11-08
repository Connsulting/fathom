// What the owner already said, as quoted source rows for the resolver: each saved memory (the
// preferences table) and each sentence of an uploaded note file. Note text is read through the
// household vault on demand and never stored in plaintext.

import { listPreferences } from '../actions/preferences.mjs';
import { readStoredFile, PURPOSES } from '../ingest/vault.mjs';

const MAX_SENTENCES = 200;

const sentences = text => String(text ?? '').split(/(?<=[.!?])\s+|[\r\n]+/).map(s => s.trim()).filter(Boolean);

// [{ref: 'preferences:<id>', source: 'memory', quote}] then, per note {fileId, name, text}, one
// {ref: 'notes:<fileId>:<index>', source: 'note', name, quote} per sentence.
export function ownerSaidRows(db, { notes = [] } = {}) {
  const rows = listPreferences(db).map(p => ({ ref: `preferences:${p.id}`, source: 'memory', quote: p.text }));
  for (const note of Array.isArray(notes) ? notes : []) {
    if (!note || note.fileId == null || typeof note.text !== 'string') continue;
    sentences(note.text).slice(0, MAX_SENTENCES).forEach((quote, i) =>
      rows.push({ ref: `notes:${note.fileId}:${i}`, source: 'note', name: String(note.name ?? ''), quote }));
  }
  return rows;
}

export const isOwnerRef = ref => typeof ref === 'string' && (ref.startsWith('preferences:') || ref.startsWith('notes:'));

// The evidence sentence for one owner row. A note is not named by its file name, which can read
// like an internal key; the ref keeps which file it was.
export const ownerSaidSentence = row => row.source === 'note'
  ? `Your note says "${row.quote}".` : `Your memory says "${row.quote}".`;

// The text of every current note upload; a file that cannot be read or is not UTF-8 is skipped.
export async function readOwnerNotes(db, vault) {
  const files = db.prepare("SELECT id,name,stored_path FROM files WHERE source_kind='notes' AND removed_at IS NULL AND stored_path IS NOT NULL ORDER BY id").all();
  const out = [];
  for (const file of files) {
    try {
      const bytes = await readStoredFile({ vault, id: file.id, storedPath: file.stored_path, purpose: PURPOSES.upload });
      out.push({ fileId: file.id, name: file.name || `file ${file.id}`, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
    } catch { /* skipped */ }
  }
  return out;
}
