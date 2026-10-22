-- The server holds ciphertext, consent grants and an audit trail. No plaintext context,
-- no names, no emails: a vault is known only by a random id the patient's browser keeps.
CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  kdf TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Field names only; released values travel with each agent step and are never stored.
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  fields TEXT NOT NULL,
  recipient TEXT NOT NULL,
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS grants_vault ON grants(vault_id);

-- Every action taken for the patient. `detail` holds field names, hosts and counts, never values.
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS audit_vault ON audit(vault_id, id);
