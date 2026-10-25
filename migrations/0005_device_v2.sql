-- Additive v2 storage. Existing v1 receipts, foreign keys and policies stay intact.
CREATE TABLE ingestion_batches_v2 (
  node_id TEXT NOT NULL REFERENCES device_nodes(id), batch_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL UNIQUE, body_sha256 TEXT NOT NULL CHECK (length(body_sha256)=64 AND body_sha256 NOT GLOB '*[^0-9a-f]*'),
  boot_id TEXT NOT NULL, stream TEXT NOT NULL CHECK (stream IN ('ble_windows','address_summaries','node_status','ble_reports')),
  seq_first INTEGER NOT NULL CHECK (seq_first BETWEEN 1 AND 4294967295),
  seq_last INTEGER NOT NULL CHECK (seq_last >= seq_first AND seq_last <= 4294967295),
  accepted_count INTEGER NOT NULL CHECK (accepted_count BETWEEN 1 AND 128),
  placement_id TEXT NOT NULL, capture_config_id TEXT NOT NULL, dataset TEXT NOT NULL,
  firmware_version TEXT NOT NULL, raw_object_key TEXT UNIQUE,
  received_at TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, retain_until_ms INTEGER NOT NULL CHECK (retain_until_ms >= expires_at_ms),
  PRIMARY KEY (node_id,batch_id), UNIQUE (node_id,batch_id,boot_id,placement_id,capture_config_id,dataset),
  FOREIGN KEY (capture_config_id,node_id,placement_id,dataset) REFERENCES capture_configs(id,node_id,placement_id,dataset),
  CHECK (stream='ble_reports' OR raw_object_key IS NULL)
);
CREATE INDEX ingestion_v2_range ON ingestion_batches_v2(node_id,boot_id,stream,seq_first,seq_last);
CREATE INDEX ingestion_v2_received ON ingestion_batches_v2(node_id,received_at DESC);
CREATE INDEX ingestion_v2_expiry ON ingestion_batches_v2(expires_at_ms);
CREATE INDEX ingestion_v2_retention ON ingestion_batches_v2(retain_until_ms);
CREATE TRIGGER ingestion_v2_policy BEFORE INSERT ON ingestion_batches_v2
WHEN NOT EXISTS (SELECT 1 FROM capture_configs WHERE id=NEW.capture_config_id AND json_extract(config_json,'$.protocol')='campuspulse/2')
BEGIN SELECT RAISE(ABORT,'v2_policy_required'); END;
CREATE TRIGGER ingestion_v2_raw_key BEFORE INSERT ON ingestion_batches_v2
WHEN NEW.stream='ble_reports' AND NEW.raw_object_key IS NULL
BEGIN SELECT RAISE(ABORT,'raw_object_key_required'); END;
CREATE TRIGGER ingestion_v2_no_overlap BEFORE INSERT ON ingestion_batches_v2
WHEN EXISTS (SELECT 1 FROM ingestion_batches_v2 b WHERE b.node_id=NEW.node_id AND b.boot_id=NEW.boot_id AND b.stream=NEW.stream AND b.seq_first<=NEW.seq_last AND b.seq_last>=NEW.seq_first)
 OR EXISTS (SELECT 1 FROM ingestion_batches b WHERE b.node_id=NEW.node_id AND (b.batch_id=NEW.batch_id OR (b.boot_id=NEW.boot_id AND b.stream=NEW.stream AND b.seq_first<=NEW.seq_last AND b.seq_last>=NEW.seq_first)))
BEGIN SELECT RAISE(ABORT,'seq_or_batch_conflict'); END;
CREATE TRIGGER ingestion_v1_v2_namespace BEFORE INSERT ON ingestion_batches
WHEN EXISTS (SELECT 1 FROM ingestion_batches_v2 b WHERE b.node_id=NEW.node_id AND (b.batch_id=NEW.batch_id OR (b.boot_id=NEW.boot_id AND b.stream=NEW.stream AND b.seq_first<=NEW.seq_last AND b.seq_last>=NEW.seq_first)))
BEGIN SELECT RAISE(ABORT,'seq_or_batch_conflict'); END;

-- Non-identifier budget tombstones survive private-row deletion. Closing a
-- window at its first private expiry prevents retention from resetting its cap.
CREATE TABLE ingestion_window_budgets_v2 (
 node_id TEXT NOT NULL, boot_id TEXT NOT NULL, stream TEXT NOT NULL, window_seq INTEGER NOT NULL,
 capture_config_id TEXT NOT NULL REFERENCES capture_configs(id), accepted_count INTEGER NOT NULL,
 budget INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, retain_until_ms INTEGER NOT NULL,
 PRIMARY KEY(node_id,boot_id,stream,window_seq), CHECK(accepted_count<=budget)
);
CREATE INDEX ingestion_window_budgets_v2_expiry ON ingestion_window_budgets_v2(retain_until_ms);
CREATE TABLE ingestion_items_v2 (
  node_id TEXT NOT NULL, boot_id TEXT NOT NULL, stream TEXT NOT NULL,
  seq INTEGER NOT NULL, batch_id TEXT NOT NULL, placement_id TEXT NOT NULL, capture_config_id TEXT NOT NULL, dataset TEXT NOT NULL,
  utc_ms INTEGER, duration_ms INTEGER, window_seq INTEGER, address TEXT, address_type TEXT,
  item_json TEXT NOT NULL CHECK (json_valid(item_json)), received_at TEXT NOT NULL, expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (node_id,boot_id,stream,seq),
  UNIQUE (node_id,boot_id,stream,window_seq,address,address_type),
  FOREIGN KEY (node_id,batch_id,boot_id,placement_id,capture_config_id,dataset) REFERENCES ingestion_batches_v2(node_id,batch_id,boot_id,placement_id,capture_config_id,dataset)
);
CREATE INDEX ingestion_items_v2_window ON ingestion_items_v2(node_id,boot_id,stream,window_seq);
CREATE INDEX ingestion_items_v2_place ON ingestion_items_v2(placement_id,stream,utc_ms);
CREATE INDEX ingestion_items_v2_expiry ON ingestion_items_v2(expires_at_ms);
CREATE INDEX ingestion_items_v2_received ON ingestion_items_v2(node_id,stream,received_at DESC);
-- Preserve the per-window address/raw budget across separate batches and races.
CREATE TRIGGER ingestion_items_v2_budget BEFORE INSERT ON ingestion_items_v2
WHEN NEW.stream IN ('address_summaries','ble_reports')
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM ingestion_window_budgets_v2 b
  WHERE b.node_id=NEW.node_id AND b.boot_id=NEW.boot_id AND b.stream=NEW.stream AND b.window_seq=NEW.window_seq
  AND (b.capture_config_id!=NEW.capture_config_id OR b.expires_at_ms <= CAST((julianday(NEW.received_at)-2440587.5)*86400000 AS INTEGER)))
 THEN RAISE(ABORT,'private_window_closed') END;
 INSERT INTO ingestion_window_budgets_v2(node_id,boot_id,stream,window_seq,capture_config_id,accepted_count,budget,expires_at_ms,retain_until_ms)
 SELECT NEW.node_id,NEW.boot_id,NEW.stream,NEW.window_seq,NEW.capture_config_id,1,
 json_extract(c.config_json,CASE NEW.stream WHEN 'address_summaries' THEN '$.summary.max_addresses' ELSE '$.raw_capture.max_reports_per_window' END),
 NEW.expires_at_ms,MAX(NEW.expires_at_ms,c.accept_until_ms+604800000) FROM capture_configs c WHERE c.id=NEW.capture_config_id
 ON CONFLICT(node_id,boot_id,stream,window_seq) DO UPDATE SET accepted_count=accepted_count+1;
END;
CREATE TRIGGER ingestion_items_v2_summary_consistency BEFORE INSERT ON ingestion_items_v2
WHEN NEW.stream='address_summaries' AND EXISTS (
 SELECT 1 FROM ingestion_items_v2 old WHERE old.node_id=NEW.node_id AND old.boot_id=NEW.boot_id AND old.stream=NEW.stream AND old.window_seq=NEW.window_seq
 AND (old.capture_config_id!=NEW.capture_config_id OR old.duration_ms!=NEW.duration_ms
   OR json_extract(old.item_json,'$.time')!=json_extract(NEW.item_json,'$.time')
   OR json_extract(old.item_json,'$.bin_ms')!=json_extract(NEW.item_json,'$.bin_ms')))
BEGIN SELECT RAISE(ABORT,'summary_window_conflict'); END;

-- Only the current contact is retained. Retired boot IDs are compact replay
-- tombstones, bounded at 4096 per node; exhaustion fails closed for new boots.
CREATE TABLE device_boots_v2 (
 node_id TEXT NOT NULL REFERENCES device_nodes(id), boot_id TEXT NOT NULL,
 first_seen_at TEXT NOT NULL, PRIMARY KEY(node_id,boot_id)
);
CREATE TRIGGER device_boots_v2_bound BEFORE INSERT ON device_boots_v2
WHEN NOT EXISTS (SELECT 1 FROM device_boots_v2 WHERE node_id=NEW.node_id AND boot_id=NEW.boot_id)
 AND (SELECT COUNT(*) FROM device_boots_v2 WHERE node_id=NEW.node_id)>=4096
BEGIN SELECT RAISE(ABORT,'boot_history_full'); END;
CREATE TABLE device_control_v2 (
 node_id TEXT PRIMARY KEY REFERENCES device_nodes(id), boot_id TEXT NOT NULL,
 contact_seq INTEGER NOT NULL, contact_sha256 TEXT NOT NULL, contact_json TEXT NOT NULL CHECK(json_valid(contact_json)),
 firmware_version TEXT NOT NULL, received_at TEXT NOT NULL,
 apply_seq INTEGER NOT NULL DEFAULT 0, applied_config_id TEXT REFERENCES capture_configs(id),
 activation_config_id TEXT REFERENCES capture_configs(id), activation_state TEXT CHECK(activation_state IN ('applied','failed')),
 activation_message TEXT, activation_sha256 TEXT, activation_received_at TEXT,
 FOREIGN KEY(node_id,boot_id) REFERENCES device_boots_v2(node_id,boot_id)
);
CREATE TABLE config_activation_events_v2 (
 id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL, boot_id TEXT NOT NULL,
 capture_config_id TEXT NOT NULL, apply_seq INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('applied','failed')),
 message TEXT, received_at TEXT NOT NULL, expires_at_ms INTEGER NOT NULL,
 FOREIGN KEY(node_id,capture_config_id) REFERENCES config_assignments(node_id,capture_config_id)
);
CREATE INDEX activation_events_v2_node ON config_activation_events_v2(node_id,id DESC);
CREATE INDEX activation_events_v2_expiry ON config_activation_events_v2(expires_at_ms);

CREATE VIEW all_ingestion_batches AS SELECT node_id,batch_id,boot_id,stream,capture_config_id,firmware_version,received_at FROM ingestion_batches
 UNION ALL SELECT node_id,batch_id,boot_id,stream,capture_config_id,firmware_version,received_at FROM ingestion_batches_v2;
CREATE VIEW all_sensor_windows AS SELECT node_id,boot_id,seq,batch_id,placement_id,capture_config_id,dataset,utc_ms,duration_ms,item_json,received_at,expires_at_ms FROM sensor_windows
 UNION ALL SELECT node_id,boot_id,seq,batch_id,placement_id,capture_config_id,dataset,utc_ms,duration_ms,item_json,received_at,expires_at_ms FROM ingestion_items_v2 WHERE stream='ble_windows';
CREATE VIEW all_node_status AS SELECT node_id,boot_id,seq,batch_id,placement_id,capture_config_id,dataset,utc_ms,item_json,received_at,expires_at_ms FROM node_status
 UNION ALL SELECT node_id,boot_id,seq,batch_id,placement_id,capture_config_id,dataset,utc_ms,item_json,received_at,expires_at_ms FROM ingestion_items_v2 WHERE stream='node_status';
