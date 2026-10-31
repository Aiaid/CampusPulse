-- Statistics capture grants are distinct from frozen policy accept_until.
-- Counters and original identities survive span cleanup and boot changes.
CREATE TABLE device_statistics_authorizations_v3 (
  node_id TEXT NOT NULL, generation INTEGER NOT NULL, boot_id TEXT NOT NULL,
  policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256)=64), accept_until_ms INTEGER NOT NULL,
  lease_until_ms INTEGER NOT NULL, contact_seq INTEGER NOT NULL DEFAULT 0 CHECK(contact_seq>=0),
  uptime_ms INTEGER NOT NULL CHECK(uptime_ms>=0), state_version INTEGER NOT NULL DEFAULT 1 CHECK(state_version>0),
  span_count INTEGER NOT NULL CHECK(span_count BETWEEN 1 AND 4096), body_sha256 TEXT,
  receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  PRIMARY KEY(node_id,generation), FOREIGN KEY(node_id,generation) REFERENCES device_assignments_v3(node_id,generation),
  FOREIGN KEY(node_id,boot_id) REFERENCES device_boots_v3(node_id,boot_id)
);
CREATE TABLE device_statistics_lease_spans_v3 (
  node_id TEXT NOT NULL, generation INTEGER NOT NULL, span_seq INTEGER NOT NULL CHECK(span_seq>0),
  start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL CHECK(end_ms>=start_ms), accept_until_ms INTEGER NOT NULL,
  PRIMARY KEY(node_id,generation,span_seq), FOREIGN KEY(node_id,generation) REFERENCES device_statistics_authorizations_v3(node_id,generation)
);
CREATE INDEX device_statistics_lease_spans_v3_expiry ON device_statistics_lease_spans_v3(accept_until_ms);
CREATE TRIGGER device_statistics_authorizations_v3_capacity BEFORE INSERT ON device_statistics_authorizations_v3
WHEN COALESCE((SELECT SUM(span_count) FROM device_statistics_authorizations_v3 WHERE node_id=NEW.node_id),0)>=4096
BEGIN SELECT RAISE(ABORT,'v3_capacity'); END;
CREATE TRIGGER device_statistics_authorizations_v3_span_capacity BEFORE UPDATE OF span_count ON device_statistics_authorizations_v3
WHEN NEW.span_count<OLD.span_count OR
 (SELECT SUM(span_count) FROM device_statistics_authorizations_v3 WHERE node_id=NEW.node_id)-OLD.span_count+NEW.span_count>4096
BEGIN SELECT RAISE(ABORT,'v3_capacity'); END;
CREATE TRIGGER device_statistics_authorizations_v3_identity BEFORE UPDATE ON device_statistics_authorizations_v3
WHEN NEW.node_id<>OLD.node_id OR NEW.generation<>OLD.generation OR NEW.boot_id<>OLD.boot_id OR
 NEW.policy_sha256<>OLD.policy_sha256 OR NEW.accept_until_ms<>OLD.accept_until_ms OR
 NEW.contact_seq<OLD.contact_seq OR NEW.uptime_ms<OLD.uptime_ms OR NEW.state_version<=OLD.state_version
BEGIN SELECT RAISE(ABORT,'v3_immutable'); END;
CREATE TRIGGER device_statistics_authorizations_v3_preserve BEFORE DELETE ON device_statistics_authorizations_v3
BEGIN SELECT RAISE(ABORT,'v3_immutable'); END;
