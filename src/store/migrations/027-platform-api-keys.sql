-- MCP keys live in platform.sqlite (platform migration 003). The store's api_keys table is
-- dropped only once it is empty: the tenancy migration copies its rows to the platform and
-- deletes them first, and this guard makes the drop refuse on a store that still holds keys.
CREATE TEMP TABLE api_keys_moved (n INTEGER NOT NULL CHECK (n = 0));
INSERT INTO api_keys_moved SELECT count(*) FROM api_keys;
DROP TABLE temp.api_keys_moved;
DROP INDEX IF EXISTS api_keys_user;
DROP TABLE api_keys;
