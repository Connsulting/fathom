-- Rec conversations become Ask threads. A thread asked from a recommendation carries rec_id, a
-- context reference to that rec (never a foreign key: a rec can be retired and the thread must
-- survive). rec_detached_at is set by Start over (POST /api/recs/:id/start-over): the rec dialog
-- no longer shows the thread; Ask is unaffected. Both are NULL for every other conversation.

ALTER TABLE conversations ADD COLUMN rec_id TEXT;
ALTER TABLE conversations ADD COLUMN rec_detached_at TEXT;

-- Every conversation keyed by a rec id (not 'ask:%', not 'pack:%') moves to a new thread with the
-- same messages, unchanged. One with an owner message stays active and untitled until its next
-- answer names it. One with only the opening summary copy is archived and detached, titled
-- 'Opening summary' (auto, never sent for naming). An empty one goes, as in migration 010.
DELETE FROM conversations
WHERE key NOT LIKE 'ask:%' AND key NOT LIKE 'pack:%'
  AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_key = conversations.key);

CREATE TEMP TABLE rec_move AS
SELECT c.key AS old_key,
  'ask:' || lower(hex(randomblob(6))) AS new_key,
  c.created_at AS created_at,
  coalesce(c.last_at, (SELECT max(ts) FROM messages WHERE conversation_key = c.key), c.created_at) AS last_at,
  EXISTS (SELECT 1 FROM messages WHERE conversation_key = c.key AND role = 'me') AS has_owner
FROM conversations c
WHERE c.key NOT LIKE 'ask:%' AND c.key NOT LIKE 'pack:%';

INSERT INTO conversations (key, created_at, last_at, rec_id, title, title_source, archived_at, rec_detached_at)
SELECT new_key, created_at, last_at, old_key,
  CASE WHEN has_owner THEN NULL ELSE 'Opening summary' END,
  CASE WHEN has_owner THEN NULL ELSE 'auto' END,
  CASE WHEN has_owner THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END,
  CASE WHEN has_owner THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END
FROM rec_move;

UPDATE messages
SET conversation_key = (SELECT new_key FROM rec_move WHERE old_key = messages.conversation_key)
WHERE conversation_key IN (SELECT old_key FROM rec_move);

DELETE FROM conversations WHERE key IN (SELECT old_key FROM rec_move);
DROP TABLE rec_move;
