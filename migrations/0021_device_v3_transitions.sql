-- An administrator intent grants only this exact, bounded same-boot cutover.
-- Neither the intent nor its immutable readiness evidence authorizes collection.
CREATE TABLE device_scope_transitions_v3 (
  id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES device_nodes(id),
  request_sha256 TEXT NOT NULL, boot_id TEXT NOT NULL, capability_sha256 TEXT NOT NULL,
  from_generation INTEGER NOT NULL, source_policy_sha256 TEXT NOT NULL,
  expected_startup_revision INTEGER NOT NULL, old_placement_id TEXT NOT NULL,
  target_place_id TEXT NOT NULL REFERENCES places(id), target_dataset TEXT NOT NULL CHECK(target_dataset IN ('field','controlled_test','demo')),
  target_ruleset TEXT NOT NULL, target_kinds_json TEXT NOT NULL CHECK(json_valid(target_kinds_json)),
  grant_expires_at_ms INTEGER NOT NULL, policy_ttl_ms INTEGER NOT NULL, accept_grace_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>created_at_ms AND expires_at_ms-created_at_ms<=300000),
  FOREIGN KEY(node_id,from_generation) REFERENCES device_assignments_v3(node_id,generation),
  FOREIGN KEY(node_id,expected_startup_revision) REFERENCES device_startup_grants_v3(node_id,revision),
  FOREIGN KEY(old_placement_id,node_id) REFERENCES placements(id,node_id)
);
CREATE INDEX device_scope_transitions_v3_node ON device_scope_transitions_v3(node_id,created_at_ms DESC);
CREATE TABLE device_scope_transition_state_v3 (
  id TEXT PRIMARY KEY REFERENCES device_scope_transitions_v3(id), node_id TEXT NOT NULL REFERENCES device_nodes(id),
  phase TEXT NOT NULL CHECK(phase IN ('pending','assigned','applied','failed','cancelled','expired','conflicted')),
  state_version INTEGER NOT NULL DEFAULT 1, cutover_ms INTEGER, assignment_generation INTEGER,
  FOREIGN KEY(node_id,assignment_generation) REFERENCES device_assignments_v3(node_id,generation) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX device_scope_transitions_v3_one_active ON device_scope_transition_state_v3(node_id) WHERE phase IN ('pending','assigned');
CREATE TABLE device_scope_transition_receipts_v3 (
  id TEXT PRIMARY KEY REFERENCES device_scope_transitions_v3(id), node_id TEXT NOT NULL REFERENCES device_nodes(id),
  body_sha256 TEXT NOT NULL, body_json TEXT NOT NULL CHECK(json_valid(body_json)), receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json))
);
CREATE TRIGGER device_scope_transitions_v3_bound BEFORE INSERT ON device_scope_transitions_v3
WHEN (SELECT COUNT(*) FROM device_scope_transitions_v3 WHERE node_id=NEW.node_id)>=4096
BEGIN SELECT RAISE(ABORT,'v3_capacity'); END;
CREATE TRIGGER device_scope_transitions_v3_immutable_update BEFORE UPDATE ON device_scope_transitions_v3
BEGIN SELECT RAISE(ABORT,'v3_immutable'); END;
CREATE TRIGGER device_scope_transitions_v3_immutable_delete BEFORE DELETE ON device_scope_transitions_v3
BEGIN SELECT RAISE(ABORT,'v3_immutable'); END;
CREATE TRIGGER device_scope_transition_receipts_v3_immutable_update BEFORE UPDATE ON device_scope_transition_receipts_v3
BEGIN SELECT RAISE(ABORT,'v3_immutable'); END;
CREATE TRIGGER device_scope_transition_receipts_v3_immutable_delete BEFORE DELETE ON device_scope_transition_receipts_v3
BEGIN SELECT RAISE(ABORT,'v3_immutable'); END;
CREATE TRIGGER device_scope_transition_state_v3_preserve BEFORE DELETE ON device_scope_transition_state_v3
BEGIN SELECT RAISE(ABORT,'v3_immutable'); END;
