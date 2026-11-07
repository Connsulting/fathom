-- Per-household data keys (MT-02). Each household's random 256-bit data key is stored only wrapped
-- under the operator platform key (FATHOM_PLATFORM_KEY_FILE): 'FTHMK1', a 12 byte nonce, the
-- 32 byte ciphertext and the 16 byte GCM tag, with the household id and key version
-- authenticated (src/platform/household-vault.mjs). Never a raw key. At most one active version per
-- household; retired versions stay readable for older objects. Empty until provisioned; the server
-- does not read it before MT-03. Times are epoch milliseconds.

CREATE TABLE household_data_keys (
  household_id TEXT NOT NULL REFERENCES households(id),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  wrapped_key BLOB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (household_id, key_version)
);
CREATE UNIQUE INDEX household_data_keys_active ON household_data_keys(household_id) WHERE status = 'active';
