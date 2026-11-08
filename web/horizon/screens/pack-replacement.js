export const REPLACEMENT_MESSAGES = {
  upload_failed: 'The replacement upload failed. Try Replace document again.',
  failed: 'The replacement could not be read. Try another copy.',
  unsupported: 'That file type could not be read. Choose a text file or a PDF with readable text.',
  too_large: 'The replacement file is too large. Choose a smaller file.',
  missing: 'The upload did not return a saved copy. Try Replace document again.',
  same: 'That is the same document. Choose a different copy.',
  upload_threw: 'The replacement upload could not finish. Try Replace document again.',
  remove_failed: 'The new copy was saved, but the old document could not be removed.',
  cleanup_failed: 'The new copy was saved, but an earlier replacement could not be removed.',
  context_changed: 'The new copy was saved. Return to this household to finish removing the old document.',
};

export function uploadFailure(uploaded, oldId) {
  if (!uploaded) return 'upload_failed';
  const file = uploaded.files?.[0];
  if (['failed', 'unsupported', 'too_large'].includes(file?.status)) return file.status;
  if (!file?.fileId) return 'missing';
  return file.fileId === oldId ? 'same' : null;
}

export function replacementRemovalIds(oldId, savedId, pending) {
  return [...new Set([pending?.savedId, ...(pending?.removeIds || []), oldId])].filter(id => id && id !== savedId);
}

export function replacementFeedback(storage, key) {
  if (!key) storage = null;
  let entries = new Map();
  try {
    entries = new Map(Object.entries(JSON.parse(storage?.getItem(key) || '{}')).filter(([id, value]) =>
      id && value && Object.hasOwn(REPLACEMENT_MESSAGES, value.code)));
  } catch { /* browser storage may be unavailable */ }
  const save = () => {
    try { storage?.setItem(key, JSON.stringify(Object.fromEntries(entries))); } catch { /* retain feedback for this visit */ }
  };
  return {
    get: id => entries.get(id),
    set(id, value) { entries.set(id, value); save(); },
    clear(id) { entries.delete(id); save(); },
  };
}
