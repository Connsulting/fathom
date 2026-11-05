-- Item 13: Ask becomes many conversations (threads). A thread is a conversation whose key is
-- 'ask:<12 lowercase hex>'. title is NULL until named; title_source is 'auto' (model or fallback)
-- or 'manual' (an owner rename). archived_at and trashed_at are independent: trash keeps
-- archived_at so restore returns a thread to where it was. last_at is the newest message time,
-- or created_at for an empty conversation. All times are app clock ISO strings.

ALTER TABLE conversations ADD COLUMN title TEXT;
ALTER TABLE conversations ADD COLUMN title_source TEXT;
ALTER TABLE conversations ADD COLUMN archived_at TEXT;
ALTER TABLE conversations ADD COLUMN trashed_at TEXT;
ALTER TABLE conversations ADD COLUMN last_at TEXT;

-- The single 'ask' conversation becomes one thread with the same messages; an empty one goes.
DELETE FROM conversations
WHERE key = 'ask' AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_key = 'ask');

CREATE TEMP TABLE ask_move AS
SELECT 'ask:' || lower(hex(randomblob(6))) AS key, created_at FROM conversations WHERE key = 'ask';

INSERT INTO conversations (key, created_at) SELECT key, created_at FROM ask_move;
UPDATE messages SET conversation_key = (SELECT key FROM ask_move) WHERE conversation_key = 'ask';
DELETE FROM conversations WHERE key = 'ask';
DROP TABLE ask_move;

UPDATE conversations
SET last_at = coalesce((SELECT max(ts) FROM messages WHERE conversation_key = conversations.key), created_at);
