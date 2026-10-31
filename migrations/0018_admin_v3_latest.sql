-- Indexed V3 administrator reads; no historical records are rewritten/deleted.
CREATE INDEX statistics_batches_v3_admin_latest ON statistics_batches_v3(node_id,json_extract(receipt_json,'$.received_at') DESC,batch_id DESC);
CREATE INDEX statistics_batches_v3_admin_stream_latest ON statistics_batches_v3(node_id,stream,json_extract(receipt_json,'$.received_at') DESC,batch_id DESC);
CREATE INDEX statistics_status_v3_admin_batch ON statistics_status_v3(node_id,batch_id,seq DESC);
CREATE INDEX statistics_windows_v3_placement ON statistics_windows_v3(placement_id,end_utc_ms);
