import test from 'node:test';
import assert from 'node:assert/strict';
import { summaryLine, filterMemories, FILTER_MIN, sourceOf, whenLabel, settingsRow } from '../web/horizon/screens/memories-model.js';

const mem = (id, text, extra = {}) => ({ id, text, actorId: 'person-a', origin: 'you', conversationKey: null, createdAt: '2026-11-06T12:00:00.000Z', updatedAt: '2026-11-06T12:00:00.000Z', ...extra });

test('summaryLine counts memories in plain words', () => {
  assert.equal(summaryLine(0), 'Fathom does not remember anything yet');
  assert.equal(summaryLine(1), 'Fathom remembers 1 thing');
  assert.equal(summaryLine(6), 'Fathom remembers 6 things');
});

test('settingsRow links the Memories page with the summary', () => {
  assert.deepEqual(settingsRow([mem('a', 'x'), mem('b', 'y')]), { route: 'memories', label: 'Memories', desc: 'Fathom remembers 2 things' });
  assert.deepEqual(settingsRow([]), { route: 'memories', label: 'Memories', desc: 'Fathom does not remember anything yet' });
  assert.equal(settingsRow(undefined).desc, 'Fathom does not remember anything yet');
});

test('filterMemories matches text case-insensitively and trims the query', () => {
  const list = [mem('a', 'Keep answers short'), mem('b', 'The budget means the plan'), mem('c', 'Short trips count as travel')];
  assert.deepEqual(filterMemories(list, '  SHORT ').map(m => m.id), ['a', 'c']);
  assert.deepEqual(filterMemories(list, '').map(m => m.id), ['a', 'b', 'c']);
  assert.deepEqual(filterMemories(list, '   ').map(m => m.id), ['a', 'b', 'c']);
  assert.deepEqual(filterMemories(list, 'nothing like this'), []);
  assert.deepEqual(filterMemories(null, 'x'), []);
});

test('the filter box appears only past five memories', () => {
  assert.equal(FILTER_MIN, 6);
});

test('sourceOf names the conversation, Ask, you, or earlier', () => {
  const threads = [{ id: '0123456789ab', key: 'ask:0123456789ab', title: 'Trip budget' }, { id: 'abcdefabcdef', key: 'ask:abcdefabcdef', title: null }];
  assert.deepEqual(sourceOf(mem('a', 'x', { origin: 'ask', conversationKey: 'ask:0123456789ab' }), threads),
    { kind: 'ask', threadId: '0123456789ab', label: 'Trip budget' });
  assert.deepEqual(sourceOf(mem('a', 'x', { origin: 'ask', conversationKey: 'ask:abcdefabcdef' }), threads),
    { kind: 'ask', threadId: 'abcdefabcdef', label: 'an Ask conversation' });
  assert.deepEqual(sourceOf(mem('a', 'x', { origin: 'ask', conversationKey: 'ask:999999999999' }), threads),
    { kind: 'ask', threadId: null, label: 'Ask' });
  assert.deepEqual(sourceOf(mem('a', 'x', { origin: 'ask', conversationKey: null }), threads), { kind: 'ask', threadId: null, label: 'Ask' });
  assert.deepEqual(sourceOf(mem('a', 'x', { origin: 'you' }), threads), { kind: 'you', label: 'Added by you' });
  assert.deepEqual(sourceOf(mem('a', 'x', { origin: null }), threads), { kind: 'earlier', label: 'Added earlier' });
  assert.deepEqual(sourceOf(mem('a', 'x', { origin: undefined }), undefined), { kind: 'earlier', label: 'Added earlier' });
});

test('sourceOf does not link a thread in the trash', () => {
  const threads = [{ id: '0123456789ab', key: 'ask:0123456789ab', title: 'Trip budget', trashedAt: '2026-11-07T00:00:00.000Z' }];
  assert.deepEqual(sourceOf(mem('a', 'x', { origin: 'ask', conversationKey: 'ask:0123456789ab' }), threads), { kind: 'ask', threadId: null, label: 'Ask' });
});

test('whenLabel is a UTC short month and day, with the year only outside the current one', () => {
  const now = '2026-11-08T09:00:00.000Z';
  assert.equal(whenLabel('2026-11-06T12:00:00.000Z', now), 'Nov 6');
  assert.equal(whenLabel('2026-01-01T00:30:00.000Z', now), 'Jan 1');
  assert.equal(whenLabel('2025-12-31T23:59:00.000Z', now), 'Dec 31, 2025');
  assert.equal(whenLabel('not a date', now), '');
  assert.equal(whenLabel('', now), '');
  assert.equal(whenLabel(null, now), '');
});
