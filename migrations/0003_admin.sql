-- Additive administration. Published capture policy and historical receipts stay
-- immutable; editable drafts are separate from versions already used by nodes.
ALTER TABLE device_nodes ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE device_nodes ADD COLUMN board TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE device_nodes ADD COLUMN created_at TEXT;
ALTER TABLE device_nodes ADD COLUMN updated_at TEXT;

CREATE TABLE admin_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at TEXT NOT NULL
);
INSERT INTO admin_settings VALUES (1,
  '{"site_name":"CampusPulse","default_mode":"demo","stale_after_seconds":300,"observation_ttl_minutes":15,"default_raw_retention_hours":24,"default_aggregate_retention_days":7}',
  1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TABLE admin_sessions (
  token_sha256 TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at_ms);

CREATE TABLE config_drafts (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES device_nodes(id),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  raw_retention_hours INTEGER NOT NULL CHECK (raw_retention_hours BETWEEN 1 AND 8760),
  aggregate_retention_days INTEGER NOT NULL CHECK (aggregate_retention_days BETWEEN 1 AND 3650),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  CHECK (json_extract(config_json, '$.capture_config_id') IS id
    AND json_extract(config_json, '$.node_id') IS node_id)
);
CREATE INDEX config_drafts_node ON config_drafts(node_id, updated_at);

-- Assignment history lets queued batches retain their original policy while the
-- node fetches an explicit desired version. ACKs are allowed only for assigned
-- versions and never inferred from a batch's capture_config_id.
CREATE TABLE config_assignments (
  node_id TEXT NOT NULL REFERENCES device_nodes(id),
  capture_config_id TEXT NOT NULL REFERENCES capture_configs(id),
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (node_id, capture_config_id)
);
CREATE TRIGGER config_assignments_owner BEFORE INSERT ON config_assignments
WHEN NOT EXISTS (SELECT 1 FROM capture_configs WHERE id = NEW.capture_config_id AND node_id = NEW.node_id)
BEGIN SELECT RAISE(ABORT, 'config_assignment_owner'); END;
CREATE TABLE device_desired_configs (
  node_id TEXT PRIMARY KEY REFERENCES device_nodes(id),
  capture_config_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  FOREIGN KEY (node_id, capture_config_id) REFERENCES config_assignments(node_id, capture_config_id)
);
CREATE TABLE config_activation (
  node_id TEXT NOT NULL,
  capture_config_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('applied','failed')),
  message TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (node_id, capture_config_id),
  FOREIGN KEY (node_id, capture_config_id) REFERENCES config_assignments(node_id, capture_config_id)
);
CREATE TABLE config_activation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  capture_config_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('applied','failed')),
  message TEXT,
  received_at TEXT NOT NULL,
  FOREIGN KEY (node_id, capture_config_id) REFERENCES config_assignments(node_id, capture_config_id)
);
CREATE INDEX config_activation_events_node ON config_activation_events(node_id,id DESC);

CREATE TABLE admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX admin_audit_time ON admin_audit(created_at);
-- A failed assertion rolls back the entire D1.batch, including the mutation and
-- audit. Successful assertions are deleted within that same transaction.
CREATE TABLE admin_write_assertions (
  id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok = 1)
);

-- Kind must remain compatible with historical manual evidence. Guard both
-- directions so an overlapping manual write cannot race a place-kind change.
CREATE TRIGGER places_observation_kind BEFORE UPDATE OF kind ON places
WHEN EXISTS (SELECT 1 FROM observations WHERE place_id = OLD.id AND kind != NEW.kind)
BEGIN SELECT RAISE(ABORT, 'place_kind_conflict'); END;
CREATE TRIGGER observations_place_kind BEFORE INSERT ON observations
WHEN NOT EXISTS (SELECT 1 FROM places WHERE id = NEW.place_id AND kind = NEW.kind)
BEGIN SELECT RAISE(ABORT, 'place_kind_conflict'); END;

CREATE INDEX ingestion_batches_received ON ingestion_batches(node_id,received_at DESC,batch_id DESC);
CREATE INDEX node_status_received ON node_status(node_id,received_at DESC,batch_id DESC);
