ALTER TABLE api_keys ADD COLUMN household_generation INTEGER NOT NULL DEFAULT 1 CHECK (household_generation >= 1);
ALTER TABLE api_keys ADD COLUMN membership_version INTEGER CHECK (membership_version >= 1);

UPDATE api_keys SET household_generation = (SELECT generation FROM households WHERE id = household_id),
  membership_version = (SELECT version FROM household_memberships WHERE user_id = api_keys.user_id AND household_id = api_keys.household_id);

UPDATE api_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revoked_code = 'binding_unavailable'
WHERE revoked_at IS NULL AND (
  (user_id IS NULL AND (SELECT mode FROM households WHERE id = household_id) != 'demo')
  OR (user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM household_memberships WHERE user_id = api_keys.user_id AND household_id = api_keys.household_id AND status = 'active'
  ))
);

CREATE TRIGGER api_keys_binding_immutable BEFORE UPDATE OF household_id, user_id, household_generation, membership_version, key_hash ON api_keys
WHEN NEW.household_id IS NOT OLD.household_id OR NEW.user_id IS NOT OLD.user_id
  OR NEW.household_generation IS NOT OLD.household_generation OR NEW.membership_version IS NOT OLD.membership_version
  OR NEW.key_hash IS NOT OLD.key_hash
BEGIN
  SELECT RAISE(ABORT, 'immutable_key_binding');
END;

CREATE TRIGGER api_keys_creator_required BEFORE INSERT ON api_keys
WHEN NEW.revoked_at IS NULL AND (
  (NEW.user_id IS NULL AND (SELECT mode FROM households WHERE id = NEW.household_id) != 'demo')
  OR (NEW.user_id IS NOT NULL AND NEW.membership_version IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'key_creator_required');
END;
