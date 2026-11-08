import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadFailure, replacementFeedback } from '../web/horizon/screens/pack-replacement.js';

test('replacement upload failures name the actual cause and allow a valid neighboring result', () => {
  for (const status of ['failed', 'unsupported', 'too_large']) {
    assert.equal(uploadFailure({ files: [{ fileId: 'new', status }] }, 'old'), status);
  }
  assert.equal(uploadFailure(null, 'old'), 'upload_failed');
  assert.equal(uploadFailure({ files: [{}] }, 'old'), 'missing');
  assert.equal(uploadFailure({ files: [{ fileId: 'old', status: 'duplicate' }] }, 'old'), 'same');
  assert.equal(uploadFailure({ files: [{ fileId: 'new', status: 'needs_clarification' }] }, 'old'), null);
});

test('feedback survives reload, keeps the saved copy and retry state, and is isolated by scope', () => {
  const memory = new Map();
  const storage = { getItem: k => memory.get(k), setItem: (k, v) => memory.set(k, v) };
  const first = replacementFeedback(storage, 'owner:household');
  first.set('old', { code: 'remove_failed', savedId: 'new', retried: false });
  const reloaded = replacementFeedback(storage, 'owner:household');
  assert.deepEqual(reloaded.get('old'), { code: 'remove_failed', savedId: 'new', retried: false });
  reloaded.set('old', { ...reloaded.get('old'), code: 'remove_failed', retried: true });
  assert.equal(replacementFeedback(storage, 'owner:household').get('old').retried, true);
  assert.equal(replacementFeedback(storage, 'owner:other-household').get('old'), undefined);
  reloaded.retain([]);
  assert.equal(replacementFeedback(storage, 'owner:household').get('old'), undefined);
});
