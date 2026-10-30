-- Default-off private feature/status custody, separate from all public views.
CREATE TABLE ingestion_batches_v3 (
  node_id TEXT NOT NULL REFERENCES device_nodes(id), batch_id TEXT NOT NULL,
  boot_id TEXT NOT NULL, stream TEXT NOT NULL CHECK(stream IN ('feature_summaries','node_status')),
  generation INTEGER NOT NULL, policy_sha256 TEXT NOT NULL, body_sha256 TEXT NOT NULL CHECK(length(body_sha256)=64),
  seq_first INTEGER NOT NULL CHECK(seq_first BETWEEN 1 AND 4294967295),
  seq_last INTEGER NOT NULL CHECK(seq_last>=seq_first AND seq_last<=4294967295),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  expires_at_ms INTEGER NOT NULL, retain_until_ms INTEGER NOT NULL CHECK(retain_until_ms>=expires_at_ms),
  PRIMARY KEY(node_id,batch_id), FOREIGN KEY(node_id,generation) REFERENCES device_assignments_v3(node_id,generation)
);
CREATE INDEX ingestion_v3_range ON ingestion_batches_v3(node_id,boot_id,stream,seq_last,seq_first);
CREATE INDEX ingestion_v3_retention ON ingestion_batches_v3(retain_until_ms);
CREATE TRIGGER ingestion_v3_immutable BEFORE UPDATE ON ingestion_batches_v3
BEGIN SELECT RAISE(ABORT,'v3_receipt_immutable'); END;
CREATE TRIGGER ingestion_v3_namespace BEFORE INSERT ON ingestion_batches_v3
WHEN EXISTS(SELECT 1 FROM ingestion_batches_v3 b WHERE b.node_id=NEW.node_id AND b.boot_id=NEW.boot_id AND b.stream=NEW.stream AND b.seq_first<=NEW.seq_last AND b.seq_last>=NEW.seq_first)
 OR EXISTS(SELECT 1 FROM ingestion_batches b WHERE b.node_id=NEW.node_id AND (b.batch_id=NEW.batch_id OR (b.boot_id=NEW.boot_id AND b.stream=NEW.stream AND b.seq_first<=NEW.seq_last AND b.seq_last>=NEW.seq_first)))
 OR EXISTS(SELECT 1 FROM ingestion_batches_v2 b WHERE b.node_id=NEW.node_id AND (b.batch_id=NEW.batch_id OR (b.boot_id=NEW.boot_id AND b.stream=NEW.stream AND b.seq_first<=NEW.seq_last AND b.seq_last>=NEW.seq_first)))
BEGIN SELECT RAISE(ABORT,'v3_namespace_conflict'); END;
CREATE TRIGGER ingestion_v1_v3_namespace BEFORE INSERT ON ingestion_batches
WHEN EXISTS(SELECT 1 FROM ingestion_batches_v3 b WHERE b.node_id=NEW.node_id AND (b.batch_id=NEW.batch_id OR (b.boot_id=NEW.boot_id AND b.stream=NEW.stream AND b.seq_first<=NEW.seq_last AND b.seq_last>=NEW.seq_first)))
BEGIN SELECT RAISE(ABORT,'v3_namespace_conflict'); END;
CREATE TRIGGER ingestion_v2_v3_namespace BEFORE INSERT ON ingestion_batches_v2
WHEN EXISTS(SELECT 1 FROM ingestion_batches_v3 b WHERE b.node_id=NEW.node_id AND (b.batch_id=NEW.batch_id OR (b.boot_id=NEW.boot_id AND b.stream=NEW.stream AND b.seq_first<=NEW.seq_last AND b.seq_last>=NEW.seq_first)))
BEGIN SELECT RAISE(ABORT,'v3_namespace_conflict'); END;

CREATE TABLE ingestion_items_v3 (
  node_id TEXT NOT NULL, boot_id TEXT NOT NULL, stream TEXT NOT NULL, seq INTEGER NOT NULL,
  batch_id TEXT NOT NULL, window_seq INTEGER, token TEXT, address_type TEXT,
  item_json TEXT NOT NULL CHECK(json_valid(item_json)), expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY(node_id,boot_id,stream,seq),
  UNIQUE(node_id,boot_id,window_seq,token,address_type),
  FOREIGN KEY(node_id,batch_id) REFERENCES ingestion_batches_v3(node_id,batch_id)
);
CREATE INDEX ingestion_items_v3_expiry ON ingestion_items_v3(expires_at_ms);
CREATE INDEX ingestion_items_v3_batch ON ingestion_items_v3(node_id,batch_id);

-- No per-identifier fields; accounting survives private-row deletion.
CREATE TABLE ingestion_windows_v3 (
  node_id TEXT NOT NULL, boot_id TEXT NOT NULL, window_seq INTEGER NOT NULL,
  signature_sha256 TEXT NOT NULL, accepted_count INTEGER NOT NULL,
  examined_reports INTEGER NOT NULL, available_reports INTEGER NOT NULL,
  worker_reports INTEGER NOT NULL, unknown_worker_counts INTEGER NOT NULL,
  evidence_bytes INTEGER NOT NULL, seen_reports INTEGER,
  max_identifiers INTEGER NOT NULL, max_reports INTEGER NOT NULL, max_bytes INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL, retain_until_ms INTEGER NOT NULL,
  PRIMARY KEY(node_id,boot_id,window_seq),
  CHECK(accepted_count<=max_identifiers), CHECK(examined_reports<=max_reports),
  CHECK(2+evidence_bytes+MAX(0,accepted_count-1)<=max_bytes),
  CHECK(seen_reports IS NULL OR available_reports<=seen_reports),
  CHECK(seen_reports IS NULL OR unknown_worker_counts>0 OR worker_reports<=seen_reports)
);
CREATE INDEX ingestion_windows_v3_retention ON ingestion_windows_v3(retain_until_ms);

CREATE TABLE ingestion_quota_v3 (
  node_id TEXT NOT NULL, day_start_ms INTEGER NOT NULL, used_bytes INTEGER NOT NULL,
  limit_bytes INTEGER NOT NULL, retain_until_ms INTEGER NOT NULL,
  PRIMARY KEY(node_id,day_start_ms), CHECK(used_bytes<=limit_bytes)
);
CREATE INDEX ingestion_quota_v3_retention ON ingestion_quota_v3(retain_until_ms);

CREATE TABLE ingestion_status_order_v3 (
  node_id TEXT NOT NULL, boot_id TEXT NOT NULL, seq INTEGER NOT NULL,
  uptime_ms INTEGER NOT NULL, clock_epoch INTEGER NOT NULL,
  feature_items_dropped INTEGER NOT NULL, feature_bytes_dropped INTEGER NOT NULL,
  status_samples_coalesced INTEGER NOT NULL, upload_failures INTEGER NOT NULL, ack_failures INTEGER NOT NULL,
  retain_until_ms INTEGER NOT NULL, PRIMARY KEY(node_id,boot_id,seq)
);
CREATE INDEX ingestion_status_v3_retention ON ingestion_status_order_v3(retain_until_ms);
CREATE TRIGGER ingestion_status_v3_order BEFORE INSERT ON ingestion_status_order_v3
WHEN EXISTS(SELECT 1 FROM ingestion_status_order_v3 s WHERE s.node_id=NEW.node_id AND s.boot_id=NEW.boot_id
 AND s.seq=(SELECT MAX(seq) FROM ingestion_status_order_v3 WHERE node_id=NEW.node_id AND boot_id=NEW.boot_id AND seq<NEW.seq)
 AND (s.uptime_ms>NEW.uptime_ms OR s.clock_epoch>NEW.clock_epoch OR s.feature_items_dropped>NEW.feature_items_dropped OR s.feature_bytes_dropped>NEW.feature_bytes_dropped OR s.status_samples_coalesced>NEW.status_samples_coalesced OR s.upload_failures>NEW.upload_failures OR s.ack_failures>NEW.ack_failures))
 OR EXISTS(SELECT 1 FROM ingestion_status_order_v3 s WHERE s.node_id=NEW.node_id AND s.boot_id=NEW.boot_id
 AND s.seq=(SELECT MIN(seq) FROM ingestion_status_order_v3 WHERE node_id=NEW.node_id AND boot_id=NEW.boot_id AND seq>NEW.seq)
 AND (s.uptime_ms<NEW.uptime_ms OR s.clock_epoch<NEW.clock_epoch OR s.feature_items_dropped<NEW.feature_items_dropped OR s.feature_bytes_dropped<NEW.feature_bytes_dropped OR s.status_samples_coalesced<NEW.status_samples_coalesced OR s.upload_failures<NEW.upload_failures OR s.ack_failures<NEW.ack_failures))
BEGIN SELECT RAISE(ABORT,'v3_status_order'); END;
