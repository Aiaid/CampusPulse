-- Explicit, revocable startup authority. No existing assignment is extended.
CREATE TABLE device_startup_grants_v3 (
  node_id TEXT NOT NULL REFERENCES device_nodes(id), revision INTEGER NOT NULL CHECK(revision>0),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), source_generation INTEGER,
  source_policy_sha256 TEXT, grant_expires_at_ms INTEGER,
  policy_ttl_ms INTEGER, accept_grace_ms INTEGER, created_at TEXT NOT NULL,
  PRIMARY KEY(node_id,revision),
  FOREIGN KEY(node_id,source_generation) REFERENCES device_assignments_v3(node_id,generation),
  CHECK(enabled=0 OR (source_generation IS NOT NULL AND length(source_policy_sha256)=64
    AND grant_expires_at_ms IS NOT NULL AND policy_ttl_ms BETWEEN 60000 AND 1800000
    AND accept_grace_ms BETWEEN 0 AND 86400000))
);
CREATE TABLE device_startup_state_v3 (
  node_id TEXT PRIMARY KEY REFERENCES device_nodes(id), revision INTEGER NOT NULL,
  FOREIGN KEY(node_id,revision) REFERENCES device_startup_grants_v3(node_id,revision)
);
CREATE TABLE device_startup_assignments_v3 (
  node_id TEXT NOT NULL, generation INTEGER NOT NULL, grant_revision INTEGER NOT NULL,
  PRIMARY KEY(node_id,generation),
  FOREIGN KEY(node_id,generation) REFERENCES device_assignments_v3(node_id,generation),
  FOREIGN KEY(node_id,grant_revision) REFERENCES device_startup_grants_v3(node_id,revision)
);
CREATE TRIGGER device_startup_grants_v3_immutable_update BEFORE UPDATE ON device_startup_grants_v3
BEGIN SELECT RAISE(ABORT,'v3_immutable'); END;
CREATE TRIGGER device_startup_grants_v3_immutable_delete BEFORE DELETE ON device_startup_grants_v3
BEGIN SELECT RAISE(ABORT,'v3_immutable'); END;
CREATE TRIGGER device_startup_assignments_v3_immutable_update BEFORE UPDATE ON device_startup_assignments_v3
BEGIN SELECT RAISE(ABORT,'v3_immutable'); END;
CREATE TRIGGER device_startup_assignments_v3_immutable_delete BEFORE DELETE ON device_startup_assignments_v3
BEGIN SELECT RAISE(ABORT,'v3_immutable'); END;
CREATE TRIGGER device_startup_grants_v3_bound BEFORE INSERT ON device_startup_grants_v3
WHEN (SELECT COUNT(*) FROM device_startup_grants_v3 WHERE node_id=NEW.node_id)>=4096
BEGIN SELECT RAISE(ABORT,'v3_capacity'); END;
