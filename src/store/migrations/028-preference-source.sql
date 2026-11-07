-- Where a remembered preference came from: 'ask' or 'you' (NULL for rows written before this
-- migration), and the Ask conversation that first remembered it.
ALTER TABLE preferences ADD COLUMN origin TEXT;
ALTER TABLE preferences ADD COLUMN conversation_key TEXT;
