-- Public queries index only publishable streams; address/raw evidence must not
-- amplify every polling read. Existing v2 evidence and constraints are intact.
CREATE INDEX ingestion_items_v2_public_time
  ON ingestion_items_v2(placement_id,node_id,utc_ms DESC,seq DESC)
  WHERE stream='ble_windows' AND dataset='field';
CREATE INDEX ingestion_items_v2_public_receipt
  ON ingestion_items_v2(placement_id,node_id,received_at DESC,seq DESC,boot_id,capture_config_id)
  WHERE stream='ble_windows' AND dataset='field';

-- Cover private-batch reads and the child probe used by retention / foreign-key
-- deletion. A batch contains at most 128 items, independent of retained history.
CREATE INDEX ingestion_items_v2_batch ON ingestion_items_v2(node_id,batch_id,seq);

-- Latest-status lookups do not need an index entry for every address summary.
DROP INDEX ingestion_items_v2_admin_latest;
CREATE INDEX ingestion_items_v2_admin_latest
  ON ingestion_items_v2(node_id,received_at DESC,batch_id DESC,seq DESC)
  WHERE stream='node_status';
DROP INDEX ingestion_items_v2_received;

-- The old Worker names ingestion_items_v2_window explicitly. Keep it until the
-- new Worker has been deployed; migration 0010 removes it in a separate stage.

-- Administrative placement counts concern windows only, including non-field
-- datasets. Keep their existing query prefix without indexing private streams.
DROP INDEX ingestion_items_v2_place;
CREATE INDEX ingestion_items_v2_place ON ingestion_items_v2(placement_id,utc_ms)
  WHERE stream='ble_windows';

-- The newer latest index subsumes this receive-time prefix.
DROP INDEX ingestion_v2_received;

-- Non-raw receipt expiry does not drive any range query. Keep the cleanup
-- index only for receipts that own a private R2 object.
DROP INDEX ingestion_v2_expiry;
CREATE INDEX ingestion_v2_expiry ON ingestion_batches_v2(expires_at_ms)
  WHERE raw_object_key IS NOT NULL;

-- Forward arrivals should probe interval ends instead of walking all older
-- sequence starts. This preserves arbitrary backfill and overlap rejection.
DROP INDEX ingestion_v2_range;
CREATE INDEX ingestion_v2_range
  ON ingestion_batches_v2(node_id,boot_id,stream,seq_last,seq_first);
