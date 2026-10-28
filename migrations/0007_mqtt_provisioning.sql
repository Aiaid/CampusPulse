-- Independent broker identities are encrypted at rest and become allocatable
-- only after a real broker login/ACL verification. No device token is retained.
CREATE TABLE mqtt_credentials (
 id TEXT PRIMARY KEY,
 username TEXT NOT NULL UNIQUE CHECK(length(username) BETWEEN 1 AND 15 AND username NOT GLOB '*[^a-z0-9_-]*'),
 namespace TEXT NOT NULL UNIQUE CHECK(length(namespace) BETWEEN 1 AND 15 AND namespace NOT GLOB '*[^a-z0-9_-]*'),
 password_ciphertext TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending_broker','ready','assigned')),
 node_id TEXT UNIQUE REFERENCES device_nodes(id),
 created_at TEXT NOT NULL,
 verified_at TEXT,
 verification_error TEXT,
 CHECK(state!='ready' OR (node_id IS NULL AND verified_at IS NOT NULL)),
 CHECK(state!='assigned' OR (node_id IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX mqtt_credentials_ready ON mqtt_credentials(state,created_at,id);
