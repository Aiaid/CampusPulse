-- Device ingestion registry and durable receipts. The registry is provisioned by
-- an operator, never by incoming device JSON. Epoch values are Unix milliseconds.
CREATE TABLE device_nodes (
  id TEXT PRIMARY KEY,
  credential_sha256 TEXT NOT NULL UNIQUE CHECK (length(credential_sha256) = 64 AND credential_sha256 NOT GLOB '*[^0-9a-f]*'),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);
CREATE TRIGGER device_nodes_id_immutable BEFORE UPDATE OF id ON device_nodes
BEGIN SELECT RAISE(ABORT, 'node_id_immutable'); END;

CREATE TABLE placements (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES device_nodes(id),
  place_id TEXT REFERENCES places(id),
  valid_from_ms INTEGER NOT NULL CHECK (valid_from_ms >= 0),
  valid_until_ms INTEGER CHECK (valid_until_ms IS NULL OR valid_until_ms > valid_from_ms),
  UNIQUE (id, node_id)
);
CREATE INDEX placements_node_time ON placements(node_id, valid_from_ms);
CREATE TRIGGER placements_immutable_update BEFORE UPDATE ON placements
BEGIN SELECT RAISE(ABORT, 'placement_immutable'); END;
CREATE TRIGGER placements_immutable_delete BEFORE DELETE ON placements
BEGIN SELECT RAISE(ABORT, 'placement_immutable'); END;

-- One physical node cannot occupy two registered places at once. Close an
-- open placement before inserting its successor.
CREATE TRIGGER placements_no_overlap BEFORE INSERT ON placements
WHEN EXISTS (
  SELECT 1 FROM placements old
  LEFT JOIN placement_closures c ON c.placement_id = old.id AND c.node_id = old.node_id
  WHERE old.node_id = NEW.node_id
    AND old.valid_from_ms < COALESCE(NEW.valid_until_ms, 9223372036854775807)
    AND NEW.valid_from_ms < COALESCE(c.valid_until_ms, old.valid_until_ms, 9223372036854775807)
)
BEGIN SELECT RAISE(ABORT, 'placement_interval_overlap'); END;

-- A placement row remains immutable. Relocation closes an open interval by
-- inserting one immutable end record, without changing queued batch provenance.
CREATE TABLE placement_closures (
  placement_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  valid_until_ms INTEGER NOT NULL CHECK (valid_until_ms >= 0),
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (placement_id, node_id) REFERENCES placements(id, node_id)
);
CREATE TRIGGER placement_closures_valid BEFORE INSERT ON placement_closures
WHEN NOT EXISTS (
  SELECT 1 FROM placements p WHERE p.id = NEW.placement_id AND p.node_id = NEW.node_id
    AND NEW.valid_until_ms > p.valid_from_ms
    AND (p.valid_until_ms IS NULL OR NEW.valid_until_ms <= p.valid_until_ms)
)
BEGIN SELECT RAISE(ABORT, 'placement_closure_invalid'); END;
CREATE TRIGGER placement_closures_immutable_update BEFORE UPDATE ON placement_closures
BEGIN SELECT RAISE(ABORT, 'placement_closure_immutable'); END;
CREATE TRIGGER placement_closures_immutable_delete BEFORE DELETE ON placement_closures
BEGIN SELECT RAISE(ABORT, 'placement_closure_immutable'); END;

CREATE TABLE capture_configs (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES device_nodes(id),
  placement_id TEXT NOT NULL,
  dataset TEXT NOT NULL CHECK (dataset IN ('field', 'controlled_test', 'demo')),
  config_json TEXT NOT NULL CHECK (
    json_valid(config_json)
    AND json_extract(config_json, '$.capture_config_id') IS id
    AND json_extract(config_json, '$.node_id') IS node_id
    AND json_extract(config_json, '$.placement_id') IS placement_id
    AND json_extract(config_json, '$.dataset') IS dataset
    AND json_extract(config_json, '$.accept_until') IS
      strftime('%Y-%m-%dT%H:%M:%fZ', accept_until_ms / 1000.0, 'unixepoch')
  ),
  accept_until_ms INTEGER NOT NULL CHECK (accept_until_ms >= 0),
  raw_retention_hours INTEGER NOT NULL DEFAULT 24 CHECK (raw_retention_hours BETWEEN 1 AND 8760),
  aggregate_retention_days INTEGER NOT NULL DEFAULT 7 CHECK (aggregate_retention_days BETWEEN 1 AND 3650),
  FOREIGN KEY (placement_id, node_id) REFERENCES placements(id, node_id),
  UNIQUE (id, node_id, placement_id, dataset)
);
CREATE INDEX capture_configs_node ON capture_configs(node_id, accept_until_ms);
CREATE TRIGGER capture_configs_immutable_update BEFORE UPDATE ON capture_configs
BEGIN SELECT RAISE(ABORT, 'capture_config_immutable'); END;
CREATE TRIGGER capture_configs_immutable_delete BEFORE DELETE ON capture_configs
BEGIN SELECT RAISE(ABORT, 'capture_config_immutable'); END;

CREATE TABLE ingestion_batches (
  node_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL UNIQUE,
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64 AND body_sha256 NOT GLOB '*[^0-9a-f]*'),
  boot_id TEXT NOT NULL,
  stream TEXT NOT NULL CHECK (stream IN ('ble_windows', 'ble_reports', 'node_status')),
  seq_first INTEGER NOT NULL CHECK (seq_first BETWEEN 1 AND 4294967295),
  seq_last INTEGER NOT NULL CHECK (seq_last >= seq_first AND seq_last <= 4294967295),
  accepted_count INTEGER NOT NULL CHECK (accepted_count BETWEEN 1 AND 128),
  placement_id TEXT NOT NULL,
  capture_config_id TEXT NOT NULL,
  dataset TEXT NOT NULL,
  firmware_version TEXT NOT NULL,
  raw_object_key TEXT UNIQUE,
  received_at TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  retain_until_ms INTEGER NOT NULL CHECK (retain_until_ms >= expires_at_ms),
  PRIMARY KEY (node_id, batch_id),
  UNIQUE (node_id, batch_id, boot_id, placement_id, capture_config_id, dataset),
  FOREIGN KEY (node_id) REFERENCES device_nodes(id),
  FOREIGN KEY (capture_config_id, node_id, placement_id, dataset)
    REFERENCES capture_configs(id, node_id, placement_id, dataset),
  CHECK (stream = 'ble_reports' OR raw_object_key IS NULL)
);
CREATE INDEX ingestion_batches_range ON ingestion_batches(node_id, boot_id, stream, seq_first, seq_last);
CREATE INDEX ingestion_batches_expiry ON ingestion_batches(expires_at_ms);
CREATE INDEX ingestion_batches_retention ON ingestion_batches(retain_until_ms);
-- The trigger runs inside the INSERT transaction, including concurrent D1
-- submissions. Intervals include skipped sequence numbers inside a batch.
CREATE TRIGGER ingestion_batches_no_overlap BEFORE INSERT ON ingestion_batches
WHEN EXISTS (
  SELECT 1 FROM ingestion_batches old
  WHERE old.node_id = NEW.node_id AND old.boot_id = NEW.boot_id
    AND old.stream = NEW.stream
    AND old.seq_first <= NEW.seq_last AND NEW.seq_first <= old.seq_last
)
BEGIN SELECT RAISE(ABORT, 'seq_range_overlap'); END;
CREATE TRIGGER ingestion_batches_raw_key BEFORE INSERT ON ingestion_batches
WHEN NEW.stream = 'ble_reports' AND NEW.raw_object_key IS NULL
BEGIN SELECT RAISE(ABORT, 'raw_object_key_required'); END;

CREATE TABLE sensor_windows (
  node_id TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  placement_id TEXT NOT NULL,
  capture_config_id TEXT NOT NULL,
  dataset TEXT NOT NULL,
  utc_ms INTEGER,
  duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 1000 AND 300000),
  item_json TEXT NOT NULL CHECK (json_valid(item_json)),
  received_at TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (node_id, boot_id, seq),
  FOREIGN KEY (node_id, batch_id, boot_id, placement_id, capture_config_id, dataset)
    REFERENCES ingestion_batches(node_id, batch_id, boot_id, placement_id, capture_config_id, dataset)
);
CREATE INDEX sensor_windows_place_time ON sensor_windows(placement_id, utc_ms);
CREATE INDEX sensor_windows_expiry ON sensor_windows(expires_at_ms);

CREATE TABLE node_status (
  node_id TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  batch_id TEXT NOT NULL,
  placement_id TEXT NOT NULL,
  capture_config_id TEXT NOT NULL,
  dataset TEXT NOT NULL,
  utc_ms INTEGER,
  item_json TEXT NOT NULL CHECK (json_valid(item_json)),
  received_at TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (node_id, boot_id, seq),
  FOREIGN KEY (node_id, batch_id, boot_id, placement_id, capture_config_id, dataset)
    REFERENCES ingestion_batches(node_id, batch_id, boot_id, placement_id, capture_config_id, dataset)
);
CREATE INDEX node_status_expiry ON node_status(expires_at_ms);
