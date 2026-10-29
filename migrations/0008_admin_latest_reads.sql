-- Keep latest-history probes bounded, including batches with equal receive
-- timestamps. Additive indexes preserve every observation and prior index.
CREATE INDEX ingestion_v2_admin_latest ON ingestion_batches_v2(node_id,received_at DESC,batch_id DESC);
CREATE INDEX node_status_admin_latest ON node_status(node_id,received_at DESC,batch_id DESC,seq DESC);
CREATE INDEX ingestion_items_v2_admin_latest ON ingestion_items_v2(node_id,stream,received_at DESC,batch_id DESC,seq DESC);
