-- Additive experimental control plane. No v1/v2 tables or desired pointers change.
CREATE TABLE device_boots_v3 (
  node_id TEXT NOT NULL REFERENCES device_nodes(id), boot_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL, PRIMARY KEY(node_id,boot_id)
);
CREATE TABLE device_capabilities_v3 (
  node_id TEXT NOT NULL, capability_id TEXT NOT NULL, boot_id TEXT NOT NULL,
  capability_sha256 TEXT NOT NULL CHECK(length(capability_sha256)=64),
  capability_json TEXT NOT NULL CHECK(json_valid(capability_json)),
  issued_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>issued_at_ms),
  registered_at TEXT NOT NULL, PRIMARY KEY(node_id,capability_id),
  UNIQUE(node_id,capability_sha256),
  FOREIGN KEY(node_id,boot_id) REFERENCES device_boots_v3(node_id,boot_id)
);
CREATE TABLE device_assignments_v3 (
  node_id TEXT NOT NULL REFERENCES device_nodes(id), generation INTEGER NOT NULL CHECK(generation>0),
  policy_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), boot_id TEXT NOT NULL,
  capability_sha256 TEXT NOT NULL, policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256)=64),
  envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)),
  placement_id TEXT, not_before_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>not_before_ms),
  assigned_at TEXT NOT NULL, PRIMARY KEY(node_id,generation), UNIQUE(node_id,policy_id,revision),
  FOREIGN KEY(node_id,capability_sha256) REFERENCES device_capabilities_v3(node_id,capability_sha256),
  FOREIGN KEY(placement_id,node_id) REFERENCES placements(id,node_id)
);
CREATE TABLE device_control_v3 (
  node_id TEXT PRIMARY KEY REFERENCES device_nodes(id), boot_id TEXT NOT NULL,
  registration_seq INTEGER NOT NULL CHECK(registration_seq>0), uptime_ms INTEGER NOT NULL CHECK(uptime_ms>=0),
  registration_sha256 TEXT NOT NULL, capability_sha256 TEXT NOT NULL, registered_at TEXT NOT NULL,
  state_version INTEGER NOT NULL CHECK(state_version>0), desired_generation INTEGER,
  applied_generation INTEGER, apply_seq INTEGER NOT NULL DEFAULT 0 CHECK(apply_seq>=0),
  FOREIGN KEY(node_id,boot_id) REFERENCES device_boots_v3(node_id,boot_id),
  FOREIGN KEY(node_id,capability_sha256) REFERENCES device_capabilities_v3(node_id,capability_sha256),
  FOREIGN KEY(node_id,desired_generation) REFERENCES device_assignments_v3(node_id,generation),
  FOREIGN KEY(node_id,applied_generation) REFERENCES device_assignments_v3(node_id,generation)
);
CREATE TABLE device_acknowledgements_v3 (
  node_id TEXT NOT NULL, generation INTEGER NOT NULL, boot_id TEXT NOT NULL,
  apply_seq INTEGER NOT NULL CHECK(apply_seq>0), state TEXT NOT NULL CHECK(state IN ('applied','failed')),
  body_sha256 TEXT NOT NULL CHECK(length(body_sha256)=64),
  acknowledgement_json TEXT NOT NULL CHECK(json_valid(acknowledgement_json)), received_at TEXT NOT NULL,
  PRIMARY KEY(node_id,generation), UNIQUE(node_id,boot_id,apply_seq),
  FOREIGN KEY(node_id,generation) REFERENCES device_assignments_v3(node_id,generation)
);

-- Immutable evidence and compact replay tombstones. Exhaustion requires explicit
-- operator recovery; automatic deletion must not reopen old boots/generations.
CREATE TRIGGER device_boots_v3_bound BEFORE INSERT ON device_boots_v3
WHEN NOT EXISTS(SELECT 1 FROM device_boots_v3 WHERE node_id=NEW.node_id AND boot_id=NEW.boot_id)
 AND (SELECT COUNT(*) FROM device_boots_v3 WHERE node_id=NEW.node_id)>=4096
BEGIN SELECT RAISE(ABORT,'v3_capacity'); END;
CREATE TRIGGER device_capabilities_v3_bound BEFORE INSERT ON device_capabilities_v3
WHEN NOT EXISTS(SELECT 1 FROM device_capabilities_v3 WHERE node_id=NEW.node_id AND capability_id=NEW.capability_id)
 AND (SELECT COUNT(*) FROM device_capabilities_v3 WHERE node_id=NEW.node_id)>=4096
BEGIN SELECT RAISE(ABORT,'v3_capacity'); END;
CREATE TRIGGER device_assignments_v3_bound BEFORE INSERT ON device_assignments_v3
WHEN (SELECT COUNT(*) FROM device_assignments_v3 WHERE node_id=NEW.node_id)>=4096
BEGIN SELECT RAISE(ABORT,'v3_capacity'); END;
CREATE TRIGGER device_capabilities_v3_immutable_update BEFORE UPDATE ON device_capabilities_v3
BEGIN SELECT RAISE(ABORT,'v3_immutable'); END;
CREATE TRIGGER device_capabilities_v3_immutable_delete BEFORE DELETE ON device_capabilities_v3
BEGIN SELECT RAISE(ABORT,'v3_immutable'); END;
CREATE TRIGGER device_assignments_v3_immutable_update BEFORE UPDATE ON device_assignments_v3
BEGIN SELECT RAISE(ABORT,'v3_immutable'); END;
CREATE TRIGGER device_assignments_v3_immutable_delete BEFORE DELETE ON device_assignments_v3
BEGIN SELECT RAISE(ABORT,'v3_immutable'); END;
CREATE TRIGGER device_acknowledgements_v3_immutable_update BEFORE UPDATE ON device_acknowledgements_v3
BEGIN SELECT RAISE(ABORT,'v3_immutable'); END;
CREATE TRIGGER device_acknowledgements_v3_immutable_delete BEFORE DELETE ON device_acknowledgements_v3
BEGIN SELECT RAISE(ABORT,'v3_immutable'); END;
