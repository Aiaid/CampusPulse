-- Compact source custody. Public projection is a separate opt-in read contract.
CREATE TABLE statistics_batches_v3 (
  node_id TEXT NOT NULL REFERENCES device_nodes(id), batch_id TEXT NOT NULL,
  boot_id TEXT NOT NULL, stream TEXT NOT NULL CHECK(stream IN ('window_statistics','candidate_events','node_status')),
  generation INTEGER NOT NULL, policy_sha256 TEXT NOT NULL, body_sha256 TEXT NOT NULL CHECK(length(body_sha256)=64),
  seq_first INTEGER NOT NULL CHECK(seq_first BETWEEN 1 AND 4294967295),
  seq_last INTEGER NOT NULL CHECK(seq_last BETWEEN seq_first AND 4294967295),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  expires_at_ms INTEGER NOT NULL, retain_until_ms INTEGER NOT NULL CHECK(retain_until_ms>=expires_at_ms),
  PRIMARY KEY(node_id,batch_id), FOREIGN KEY(node_id,generation) REFERENCES device_assignments_v3(node_id,generation)
);
CREATE INDEX statistics_batches_v3_range ON statistics_batches_v3(node_id,boot_id,stream,seq_last,seq_first);
CREATE INDEX statistics_batches_v3_retention ON statistics_batches_v3(retain_until_ms);
CREATE TRIGGER statistics_batches_v3_immutable BEFORE UPDATE ON statistics_batches_v3
BEGIN SELECT RAISE(ABORT,'v3_statistics_receipt_immutable'); END;
CREATE TRIGGER statistics_batches_v3_capacity BEFORE INSERT ON statistics_batches_v3
WHEN (SELECT COUNT(*) FROM statistics_batches_v3 WHERE node_id=NEW.node_id)>=262144
BEGIN SELECT RAISE(ABORT,'v3_statistics_capacity'); END;

-- One bounded anchor per known boot and stream survives receipt cleanup.
CREATE TABLE statistics_sequence_floors_v3 (
  node_id TEXT NOT NULL, boot_id TEXT NOT NULL, stream TEXT NOT NULL CHECK(stream IN ('window_statistics','candidate_events','node_status')),
  seq_floor INTEGER NOT NULL CHECK(seq_floor BETWEEN 1 AND 4294967295),
  uptime_ms INTEGER, clock_epoch INTEGER, window_drops INTEGER, event_drops INTEGER, status_coalesced INTEGER,
  window_end_utc_ms INTEGER, window_uncertainty_ms INTEGER, window_seq_floor INTEGER,
  upload_failures INTEGER, ack_failures INTEGER, retries INTEGER,
  raw_enqueued INTEGER, raw_written INTEGER, raw_synced INTEGER, raw_queue_drops INTEGER, raw_storage_failures INTEGER, raw_space_stops INTEGER,
  PRIMARY KEY(node_id,boot_id,stream),
  FOREIGN KEY(node_id,boot_id) REFERENCES device_boots_v3(node_id,boot_id)
);
CREATE TRIGGER statistics_batches_v3_namespace BEFORE INSERT ON statistics_batches_v3
WHEN EXISTS(SELECT 1 FROM statistics_sequence_floors_v3 f WHERE f.node_id=NEW.node_id AND f.boot_id=NEW.boot_id AND f.stream=NEW.stream AND NEW.seq_first<=f.seq_floor)
 OR EXISTS(SELECT 1 FROM statistics_batches_v3 b WHERE b.node_id=NEW.node_id AND b.boot_id=NEW.boot_id AND b.stream=NEW.stream AND b.seq_first<=NEW.seq_last AND b.seq_last>=NEW.seq_first)
 OR EXISTS(SELECT 1 FROM ingestion_batches b WHERE b.node_id=NEW.node_id AND (b.batch_id=NEW.batch_id OR (b.boot_id=NEW.boot_id AND b.stream=NEW.stream AND b.seq_first<=NEW.seq_last AND b.seq_last>=NEW.seq_first)))
 OR EXISTS(SELECT 1 FROM ingestion_batches_v2 b WHERE b.node_id=NEW.node_id AND (b.batch_id=NEW.batch_id OR (b.boot_id=NEW.boot_id AND b.stream=NEW.stream AND b.seq_first<=NEW.seq_last AND b.seq_last>=NEW.seq_first)))
 OR EXISTS(SELECT 1 FROM ingestion_batches_v3 b WHERE b.node_id=NEW.node_id AND (b.batch_id=NEW.batch_id OR (b.boot_id=NEW.boot_id AND b.stream=NEW.stream AND b.seq_first<=NEW.seq_last AND b.seq_last>=NEW.seq_first)))
BEGIN SELECT RAISE(ABORT,'v3_statistics_namespace_conflict'); END;
CREATE TRIGGER ingestion_v1_statistics_namespace BEFORE INSERT ON ingestion_batches
WHEN EXISTS(SELECT 1 FROM statistics_batches_v3 b WHERE b.node_id=NEW.node_id AND (b.batch_id=NEW.batch_id OR (b.boot_id=NEW.boot_id AND b.stream=NEW.stream AND b.seq_first<=NEW.seq_last AND b.seq_last>=NEW.seq_first)))
 OR EXISTS(SELECT 1 FROM statistics_sequence_floors_v3 f WHERE f.node_id=NEW.node_id AND f.boot_id=NEW.boot_id AND f.stream=NEW.stream AND NEW.seq_first<=f.seq_floor)
BEGIN SELECT RAISE(ABORT,'v3_statistics_namespace_conflict'); END;
CREATE TRIGGER ingestion_v2_statistics_namespace BEFORE INSERT ON ingestion_batches_v2
WHEN EXISTS(SELECT 1 FROM statistics_batches_v3 b WHERE b.node_id=NEW.node_id AND (b.batch_id=NEW.batch_id OR (b.boot_id=NEW.boot_id AND b.stream=NEW.stream AND b.seq_first<=NEW.seq_last AND b.seq_last>=NEW.seq_first)))
 OR EXISTS(SELECT 1 FROM statistics_sequence_floors_v3 f WHERE f.node_id=NEW.node_id AND f.boot_id=NEW.boot_id AND f.stream=NEW.stream AND NEW.seq_first<=f.seq_floor)
BEGIN SELECT RAISE(ABORT,'v3_statistics_namespace_conflict'); END;
CREATE TRIGGER ingestion_v3_statistics_namespace BEFORE INSERT ON ingestion_batches_v3
WHEN EXISTS(SELECT 1 FROM statistics_batches_v3 b WHERE b.node_id=NEW.node_id AND (b.batch_id=NEW.batch_id OR (b.boot_id=NEW.boot_id AND b.stream=NEW.stream AND b.seq_first<=NEW.seq_last AND b.seq_last>=NEW.seq_first)))
 OR EXISTS(SELECT 1 FROM statistics_sequence_floors_v3 f WHERE f.node_id=NEW.node_id AND f.boot_id=NEW.boot_id AND f.stream=NEW.stream AND NEW.seq_first<=f.seq_floor)
BEGIN SELECT RAISE(ABORT,'v3_statistics_namespace_conflict'); END;

CREATE TABLE statistics_windows_v3 (
  node_id TEXT NOT NULL, boot_id TEXT NOT NULL, generation INTEGER NOT NULL,
  clock_epoch INTEGER NOT NULL, window_seq INTEGER NOT NULL, seq INTEGER NOT NULL, batch_id TEXT NOT NULL,
  placement_id TEXT NOT NULL, dataset TEXT NOT NULL, collection_mode TEXT NOT NULL,
  end_utc_ms INTEGER NOT NULL, end_mono_ms INTEGER NOT NULL, uncertainty_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL, received_at_ms INTEGER NOT NULL,
  quality_mask INTEGER NOT NULL, extractor_version TEXT NOT NULL, ruleset_version TEXT NOT NULL,
  item_json TEXT CHECK(item_json IS NULL OR json_valid(item_json)), expires_at_ms INTEGER NOT NULL, retain_until_ms INTEGER NOT NULL,
  PRIMARY KEY(node_id,boot_id,generation,clock_epoch,window_seq), UNIQUE(node_id,boot_id,seq),
  FOREIGN KEY(node_id,batch_id) REFERENCES statistics_batches_v3(node_id,batch_id)
);
CREATE INDEX statistics_windows_v3_projection ON statistics_windows_v3(placement_id,dataset,end_utc_ms DESC);
CREATE INDEX statistics_windows_v3_expiry ON statistics_windows_v3(expires_at_ms) WHERE item_json IS NOT NULL;
CREATE INDEX statistics_windows_v3_retention ON statistics_windows_v3(retain_until_ms);
CREATE INDEX statistics_windows_v3_clock_order ON statistics_windows_v3(node_id,boot_id,clock_epoch,seq);
-- Windows cannot overlap in monotonic time. Delayed inserts must fit both sides.
CREATE TRIGGER statistics_windows_v3_order BEFORE INSERT ON statistics_windows_v3
WHEN EXISTS(SELECT 1 FROM statistics_windows_v3 w WHERE w.node_id=NEW.node_id AND w.boot_id=NEW.boot_id
 AND w.seq=(SELECT MAX(seq) FROM statistics_windows_v3 WHERE node_id=NEW.node_id AND boot_id=NEW.boot_id AND seq<NEW.seq)
 AND (w.end_mono_ms>NEW.end_mono_ms-NEW.duration_ms OR w.clock_epoch>NEW.clock_epoch OR w.window_seq>=NEW.window_seq))
 OR EXISTS(SELECT 1 FROM statistics_windows_v3 w WHERE w.node_id=NEW.node_id AND w.boot_id=NEW.boot_id
 AND w.seq=(SELECT MIN(seq) FROM statistics_windows_v3 WHERE node_id=NEW.node_id AND boot_id=NEW.boot_id AND seq>NEW.seq)
 AND (w.end_mono_ms-w.duration_ms<NEW.end_mono_ms OR w.clock_epoch<NEW.clock_epoch OR w.window_seq<=NEW.window_seq))
 OR EXISTS(SELECT 1 FROM statistics_sequence_floors_v3 f WHERE f.node_id=NEW.node_id AND f.boot_id=NEW.boot_id AND f.stream='window_statistics'
 AND (f.uptime_ms>NEW.end_mono_ms-NEW.duration_ms OR f.clock_epoch>NEW.clock_epoch OR f.window_seq_floor>=NEW.window_seq
 OR f.clock_epoch=NEW.clock_epoch AND ABS((NEW.end_utc_ms-NEW.end_mono_ms)-(f.window_end_utc_ms-f.uptime_ms))>NEW.uncertainty_ms+f.window_uncertainty_ms))
BEGIN SELECT RAISE(ABORT,'v3_statistics_window_order'); END;
CREATE TRIGGER statistics_windows_v3_clock BEFORE INSERT ON statistics_windows_v3
WHEN EXISTS(SELECT 1 FROM statistics_windows_v3 w WHERE w.node_id=NEW.node_id AND w.boot_id=NEW.boot_id AND w.clock_epoch=NEW.clock_epoch
 AND w.seq IN ((SELECT MAX(seq) FROM statistics_windows_v3 WHERE node_id=NEW.node_id AND boot_id=NEW.boot_id AND clock_epoch=NEW.clock_epoch AND seq<NEW.seq),
 (SELECT MIN(seq) FROM statistics_windows_v3 WHERE node_id=NEW.node_id AND boot_id=NEW.boot_id AND clock_epoch=NEW.clock_epoch AND seq>NEW.seq))
 AND ABS((NEW.end_utc_ms-NEW.end_mono_ms)-(w.end_utc_ms-w.end_mono_ms))>NEW.uncertainty_ms+w.uncertainty_ms)
BEGIN SELECT RAISE(ABORT,'v3_statistics_window_order'); END;

CREATE TABLE statistics_events_v3 (
  node_id TEXT NOT NULL, boot_id TEXT NOT NULL, generation INTEGER NOT NULL, event_id TEXT NOT NULL,
  revision INTEGER NOT NULL, seq INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('open','closed','censored')),
  item_json TEXT CHECK(item_json IS NULL OR json_valid(item_json)), item_sha256 TEXT NOT NULL, received_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL, retain_until_ms INTEGER NOT NULL,
  PRIMARY KEY(node_id,boot_id,generation,event_id), FOREIGN KEY(node_id,generation) REFERENCES device_assignments_v3(node_id,generation)
);
CREATE INDEX statistics_events_v3_expiry ON statistics_events_v3(expires_at_ms) WHERE item_json IS NOT NULL;
CREATE INDEX statistics_events_v3_retention ON statistics_events_v3(retain_until_ms);
CREATE TRIGGER statistics_events_v3_capacity BEFORE INSERT ON statistics_events_v3
WHEN NOT EXISTS(SELECT 1 FROM statistics_events_v3 WHERE node_id=NEW.node_id AND boot_id=NEW.boot_id AND generation=NEW.generation AND event_id=NEW.event_id)
 AND (SELECT COUNT(*) FROM statistics_events_v3 WHERE node_id=NEW.node_id)>=16384
BEGIN SELECT RAISE(ABORT,'v3_statistics_capacity'); END;

CREATE TABLE statistics_status_v3 (
  node_id TEXT NOT NULL, boot_id TEXT NOT NULL, seq INTEGER NOT NULL, batch_id TEXT NOT NULL,
  uptime_ms INTEGER NOT NULL, clock_epoch INTEGER NOT NULL,
  window_drops INTEGER NOT NULL, event_drops INTEGER NOT NULL, status_coalesced INTEGER NOT NULL,
  upload_failures INTEGER NOT NULL, ack_failures INTEGER NOT NULL, retries INTEGER NOT NULL,
  raw_enqueued INTEGER, raw_written INTEGER, raw_synced INTEGER, raw_queue_drops INTEGER, raw_storage_failures INTEGER, raw_space_stops INTEGER,
  item_json TEXT CHECK(item_json IS NULL OR json_valid(item_json)), expires_at_ms INTEGER NOT NULL, retain_until_ms INTEGER NOT NULL,
  PRIMARY KEY(node_id,boot_id,seq), FOREIGN KEY(node_id,batch_id) REFERENCES statistics_batches_v3(node_id,batch_id)
);
CREATE INDEX statistics_status_v3_expiry ON statistics_status_v3(expires_at_ms) WHERE item_json IS NOT NULL;
CREATE INDEX statistics_status_v3_retention ON statistics_status_v3(retain_until_ms);
CREATE TRIGGER statistics_status_v3_order BEFORE INSERT ON statistics_status_v3
WHEN EXISTS(SELECT 1 FROM statistics_status_v3 s WHERE s.node_id=NEW.node_id AND s.boot_id=NEW.boot_id
 AND s.seq=(SELECT MAX(seq) FROM statistics_status_v3 WHERE node_id=NEW.node_id AND boot_id=NEW.boot_id AND seq<NEW.seq)
 AND (s.uptime_ms>NEW.uptime_ms OR s.clock_epoch>NEW.clock_epoch OR s.window_drops>NEW.window_drops OR s.event_drops>NEW.event_drops OR s.status_coalesced>NEW.status_coalesced OR s.upload_failures>NEW.upload_failures OR s.ack_failures>NEW.ack_failures OR s.retries>NEW.retries))
 OR EXISTS(SELECT 1 FROM statistics_status_v3 s WHERE s.node_id=NEW.node_id AND s.boot_id=NEW.boot_id
 AND s.seq=(SELECT MIN(seq) FROM statistics_status_v3 WHERE node_id=NEW.node_id AND boot_id=NEW.boot_id AND seq>NEW.seq)
 AND (s.uptime_ms<NEW.uptime_ms OR s.clock_epoch<NEW.clock_epoch OR s.window_drops<NEW.window_drops OR s.event_drops<NEW.event_drops OR s.status_coalesced<NEW.status_coalesced OR s.upload_failures<NEW.upload_failures OR s.ack_failures<NEW.ack_failures OR s.retries<NEW.retries))
BEGIN SELECT RAISE(ABORT,'v3_statistics_status_order'); END;
CREATE TRIGGER statistics_status_v3_floor_order BEFORE INSERT ON statistics_status_v3
WHEN EXISTS(SELECT 1 FROM statistics_sequence_floors_v3 f WHERE f.node_id=NEW.node_id AND f.boot_id=NEW.boot_id AND f.stream='node_status'
 AND (f.uptime_ms>NEW.uptime_ms OR f.clock_epoch>NEW.clock_epoch OR f.window_drops>NEW.window_drops OR f.event_drops>NEW.event_drops
 OR f.status_coalesced>NEW.status_coalesced OR f.upload_failures>NEW.upload_failures OR f.ack_failures>NEW.ack_failures OR f.retries>NEW.retries
 OR NEW.raw_enqueued IS NOT NULL AND (f.raw_enqueued>NEW.raw_enqueued OR f.raw_written>NEW.raw_written OR f.raw_synced>NEW.raw_synced
 OR f.raw_queue_drops>NEW.raw_queue_drops OR f.raw_storage_failures>NEW.raw_storage_failures OR f.raw_space_stops>NEW.raw_space_stops)))
BEGIN SELECT RAISE(ABORT,'v3_statistics_status_order'); END;
-- Unknown local-TF counters do not erase neighboring known anchors.
CREATE TRIGGER statistics_status_v3_raw_order BEFORE INSERT ON statistics_status_v3
WHEN NEW.raw_enqueued IS NOT NULL AND (
 EXISTS(SELECT 1 FROM statistics_status_v3 s WHERE s.node_id=NEW.node_id AND s.boot_id=NEW.boot_id
 AND s.seq=(SELECT MAX(seq) FROM statistics_status_v3 WHERE node_id=NEW.node_id AND boot_id=NEW.boot_id AND seq<NEW.seq AND raw_enqueued IS NOT NULL)
 AND (s.raw_enqueued>NEW.raw_enqueued OR s.raw_written>NEW.raw_written OR s.raw_synced>NEW.raw_synced OR s.raw_queue_drops>NEW.raw_queue_drops OR s.raw_storage_failures>NEW.raw_storage_failures OR s.raw_space_stops>NEW.raw_space_stops))
 OR EXISTS(SELECT 1 FROM statistics_status_v3 s WHERE s.node_id=NEW.node_id AND s.boot_id=NEW.boot_id
 AND s.seq=(SELECT MIN(seq) FROM statistics_status_v3 WHERE node_id=NEW.node_id AND boot_id=NEW.boot_id AND seq>NEW.seq AND raw_enqueued IS NOT NULL)
 AND (s.raw_enqueued<NEW.raw_enqueued OR s.raw_written<NEW.raw_written OR s.raw_synced<NEW.raw_synced OR s.raw_queue_drops<NEW.raw_queue_drops OR s.raw_storage_failures<NEW.raw_storage_failures OR s.raw_space_stops<NEW.raw_space_stops)))
BEGIN SELECT RAISE(ABORT,'v3_statistics_status_order'); END;
CREATE TABLE statistics_quota_v3 (
  node_id TEXT NOT NULL REFERENCES device_nodes(id), day_start_ms INTEGER NOT NULL,
  used_bytes INTEGER NOT NULL, limit_bytes INTEGER NOT NULL, retain_until_ms INTEGER NOT NULL,
  PRIMARY KEY(node_id,day_start_ms), CHECK(used_bytes<=limit_bytes)
);
CREATE INDEX statistics_quota_v3_retention ON statistics_quota_v3(retain_until_ms);
