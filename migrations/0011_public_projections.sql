-- Incremental public candidates, maintained in the same transaction as their
-- canonical source. Never use measurement time or a timestamp-only cursor as a
-- change watermark: late uploads and equal receipt timestamps are independent
-- rows. Canonical v2 receipts, items, budgets and retention are not rewritten.
CREATE TABLE public_sensor_projection_v2 (
  node_id TEXT NOT NULL, boot_id TEXT NOT NULL,
  stream TEXT NOT NULL CHECK (stream='ble_windows'), seq INTEGER NOT NULL,
  batch_id TEXT NOT NULL, placement_id TEXT NOT NULL, capture_config_id TEXT NOT NULL,
  dataset TEXT NOT NULL CHECK (dataset='field'), place_id TEXT NOT NULL,
  placement_valid_from_ms INTEGER NOT NULL,
  utc_ms INTEGER, duration_ms INTEGER, item_json TEXT NOT NULL CHECK (json_valid(item_json)),
  received_at TEXT NOT NULL, expires_at_ms INTEGER NOT NULL,
  timed_eligible INTEGER NOT NULL CHECK (timed_eligible IN (0,1)),
  unverified_eligible INTEGER NOT NULL CHECK (unverified_eligible IN (0,1)),
  PRIMARY KEY (node_id,boot_id,stream,seq),
  FOREIGN KEY (node_id,boot_id,stream,seq)
    REFERENCES ingestion_items_v2(node_id,boot_id,stream,seq) ON DELETE CASCADE
);

-- This view is used only to classify changed source rows and for the initial
-- bootstrap. Public reads use the materialized table. Config and placement scope
-- are immutable; append-only placement closures are handled by triggers below.
-- Keep unsafe/closed candidates with flags=0, so a closure change can reclassify
-- them. Expiry, query range, future receipts and freshness are evaluated at read.
CREATE VIEW public_sensor_projection_source_v2 AS
SELECT w.node_id,w.boot_id,w.stream,w.seq,w.batch_id,w.placement_id,w.capture_config_id,w.dataset,
  p.place_id,p.valid_from_ms AS placement_valid_from_ms,w.utc_ms,w.duration_ms,w.item_json,w.received_at,w.expires_at_ms,
  CASE WHEN w.utc_ms IS NOT NULL
    AND json_extract(w.item_json,'$.time.uncertainty_ms') BETWEEN 0 AND 30000
    AND json_type(w.item_json,'$.quality_flags')='array'
    AND NOT EXISTS (SELECT 1 FROM json_each(w.item_json,'$.quality_flags') flag
      WHERE flag.type!='text' OR flag.value NOT IN ('partial_window','unique_table_overflow','aggregation_drops','raw_drops','raw_pressure_pause'))
    AND w.utc_ms-w.duration_ms-json_extract(w.item_json,'$.time.uncertainty_ms') >= p.valid_from_ms
    AND w.utc_ms+json_extract(w.item_json,'$.time.uncertainty_ms') <= COALESCE(c.valid_until_ms,p.valid_until_ms,9223372036854775807)
    THEN 1 ELSE 0 END AS timed_eligible,
  CASE WHEN w.received_at >= strftime('%Y-%m-%dT%H:%M:%fZ',p.valid_from_ms/1000.0,'unixepoch')
    AND (COALESCE(c.valid_until_ms,p.valid_until_ms) IS NULL
      OR w.received_at < strftime('%Y-%m-%dT%H:%M:%fZ',COALESCE(c.valid_until_ms,p.valid_until_ms)/1000.0,'unixepoch'))
    AND (w.utc_ms IS NULL OR json_extract(w.item_json,'$.time.uncertainty_ms') IS NULL
      OR json_extract(w.item_json,'$.time.uncertainty_ms') > 30000
      OR EXISTS (SELECT 1 FROM json_each(w.item_json,'$.quality_flags') flag WHERE flag.value='utc_jump'))
    AND (w.utc_ms IS NULL OR w.utc_ms <= 8640000000000000)
    AND json_type(w.item_json,'$.quality_flags')='array'
    AND NOT EXISTS (SELECT 1 FROM json_each(w.item_json,'$.quality_flags') flag
      WHERE flag.type!='text' OR flag.value NOT IN ('partial_window','unique_table_overflow','aggregation_drops','raw_drops','raw_pressure_pause','utc_jump'))
    THEN 1 ELSE 0 END AS unverified_eligible
FROM ingestion_items_v2 w
JOIN placements p ON p.id=w.placement_id AND p.node_id=w.node_id
JOIN capture_configs config ON config.id=w.capture_config_id AND config.node_id=w.node_id
  AND config.placement_id=w.placement_id AND config.dataset=w.dataset
LEFT JOIN placement_closures c ON c.placement_id=p.id AND c.node_id=p.node_id
WHERE w.stream='ble_windows' AND w.dataset='field' AND p.place_id IS NOT NULL;

INSERT INTO public_sensor_projection_v2 SELECT * FROM public_sensor_projection_source_v2;
CREATE INDEX public_sensor_projection_v2_time
  ON public_sensor_projection_v2(place_id,utc_ms DESC,node_id,seq DESC)
  WHERE timed_eligible=1;
CREATE INDEX public_sensor_projection_v2_receipt
  ON public_sensor_projection_v2(place_id,received_at DESC,seq DESC,node_id,boot_id,capture_config_id)
  WHERE unverified_eligible=1;
CREATE INDEX public_sensor_projection_v2_expiry ON public_sensor_projection_v2(expires_at_ms);

CREATE TRIGGER public_sensor_projection_v2_insert AFTER INSERT ON ingestion_items_v2
WHEN NEW.stream='ble_windows' AND NEW.dataset='field'
BEGIN
  INSERT INTO public_sensor_projection_v2 SELECT * FROM public_sensor_projection_source_v2
    WHERE node_id=NEW.node_id AND boot_id=NEW.boot_id AND stream=NEW.stream AND seq=NEW.seq;
END;
CREATE TRIGGER public_sensor_projection_v2_update AFTER UPDATE ON ingestion_items_v2
WHEN ((OLD.stream='ble_windows' AND OLD.dataset='field') OR (NEW.stream='ble_windows' AND NEW.dataset='field'))
  AND (OLD.node_id IS NOT NEW.node_id OR OLD.boot_id IS NOT NEW.boot_id OR OLD.stream IS NOT NEW.stream
    OR OLD.seq IS NOT NEW.seq OR OLD.batch_id IS NOT NEW.batch_id OR OLD.placement_id IS NOT NEW.placement_id
    OR OLD.capture_config_id IS NOT NEW.capture_config_id OR OLD.dataset IS NOT NEW.dataset
    OR OLD.utc_ms IS NOT NEW.utc_ms OR OLD.duration_ms IS NOT NEW.duration_ms OR OLD.item_json IS NOT NEW.item_json
    OR OLD.received_at IS NOT NEW.received_at OR OLD.expires_at_ms IS NOT NEW.expires_at_ms)
BEGIN
  DELETE FROM public_sensor_projection_v2
    WHERE node_id=OLD.node_id AND boot_id=OLD.boot_id AND stream=OLD.stream AND seq=OLD.seq;
  INSERT INTO public_sensor_projection_v2 SELECT * FROM public_sensor_projection_source_v2
    WHERE node_id=NEW.node_id AND boot_id=NEW.boot_id AND stream=NEW.stream AND seq=NEW.seq;
END;
CREATE TRIGGER public_sensor_projection_v2_delete AFTER DELETE ON ingestion_items_v2
WHEN OLD.stream='ble_windows' AND OLD.dataset='field'
BEGIN
-- The FK normally performs this deletion. Keep the explicit cleanup for
-- maintenance connections as well; it never deletes canonical evidence.
  DELETE FROM public_sensor_projection_v2
    WHERE node_id=OLD.node_id AND boot_id=OLD.boot_id AND stream=OLD.stream AND seq=OLD.seq;
END;

-- Placement mutation guards remain intact. INSERT is the production closure
-- path; UPDATE/DELETE also maintain the projection if future policy permits
-- correcting a closure. The existing source placement index bounds this work.
-- Update existing cache rows only: closure changes must not resurrect expired
-- projections already pruned independently of canonical history retention.
CREATE TRIGGER public_sensor_projection_v2_closure_insert AFTER INSERT ON placement_closures
BEGIN
  UPDATE public_sensor_projection_v2
  SET timed_eligible=source.timed_eligible,unverified_eligible=source.unverified_eligible
  FROM public_sensor_projection_source_v2 AS source
  WHERE source.placement_id=NEW.placement_id AND source.node_id=NEW.node_id
    AND public_sensor_projection_v2.node_id=source.node_id AND public_sensor_projection_v2.boot_id=source.boot_id
    AND public_sensor_projection_v2.stream=source.stream AND public_sensor_projection_v2.seq=source.seq
    AND (public_sensor_projection_v2.timed_eligible!=source.timed_eligible
      OR public_sensor_projection_v2.unverified_eligible!=source.unverified_eligible);
END;
CREATE TRIGGER public_sensor_projection_v2_closure_update AFTER UPDATE ON placement_closures
WHEN OLD.placement_id IS NOT NEW.placement_id OR OLD.node_id IS NOT NEW.node_id OR OLD.valid_until_ms IS NOT NEW.valid_until_ms
BEGIN
  UPDATE public_sensor_projection_v2
  SET timed_eligible=source.timed_eligible,unverified_eligible=source.unverified_eligible
  FROM public_sensor_projection_source_v2 AS source
  WHERE source.placement_id=OLD.placement_id AND source.node_id=OLD.node_id
    AND public_sensor_projection_v2.node_id=source.node_id AND public_sensor_projection_v2.boot_id=source.boot_id
    AND public_sensor_projection_v2.stream=source.stream AND public_sensor_projection_v2.seq=source.seq
    AND (public_sensor_projection_v2.timed_eligible!=source.timed_eligible
      OR public_sensor_projection_v2.unverified_eligible!=source.unverified_eligible);
  UPDATE public_sensor_projection_v2
  SET timed_eligible=source.timed_eligible,unverified_eligible=source.unverified_eligible
  FROM public_sensor_projection_source_v2 AS source
  WHERE (OLD.placement_id IS NOT NEW.placement_id OR OLD.node_id IS NOT NEW.node_id)
    AND source.placement_id=NEW.placement_id AND source.node_id=NEW.node_id
    AND public_sensor_projection_v2.node_id=source.node_id AND public_sensor_projection_v2.boot_id=source.boot_id
    AND public_sensor_projection_v2.stream=source.stream AND public_sensor_projection_v2.seq=source.seq
    AND (public_sensor_projection_v2.timed_eligible!=source.timed_eligible
      OR public_sensor_projection_v2.unverified_eligible!=source.unverified_eligible);
END;
CREATE TRIGGER public_sensor_projection_v2_closure_delete AFTER DELETE ON placement_closures
BEGIN
  UPDATE public_sensor_projection_v2
  SET timed_eligible=source.timed_eligible,unverified_eligible=source.unverified_eligible
  FROM public_sensor_projection_source_v2 AS source
  WHERE source.placement_id=OLD.placement_id AND source.node_id=OLD.node_id
    AND public_sensor_projection_v2.node_id=source.node_id AND public_sensor_projection_v2.boot_id=source.boot_id
    AND public_sensor_projection_v2.stream=source.stream AND public_sensor_projection_v2.seq=source.seq
    AND (public_sensor_projection_v2.timed_eligible!=source.timed_eligible
      OR public_sensor_projection_v2.unverified_eligible!=source.unverified_eligible);
END;

-- Keep every active manual record, including stale records. valid_until is a
-- freshness boundary, not permission to discard historical elevator evidence.
CREATE TABLE public_observation_projection (
  id TEXT PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
  place_id TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status='active'), observed_at TEXT NOT NULL,
  valid_until TEXT NOT NULL, received_at TEXT NOT NULL, cancelled_at TEXT,
  parking_min INTEGER, parking_max INTEGER, wait_seconds INTEGER
);
INSERT INTO public_observation_projection
  SELECT id,place_id,kind,source,status,observed_at,valid_until,received_at,cancelled_at,parking_min,parking_max,wait_seconds
  FROM observations WHERE status='active';
CREATE INDEX public_observation_projection_purpose_time
  ON public_observation_projection(place_id,kind,observed_at DESC,id DESC);
CREATE INDEX public_observation_projection_time
  ON public_observation_projection(place_id,observed_at DESC,id DESC);
CREATE TRIGGER public_observation_projection_insert AFTER INSERT ON observations
WHEN NEW.status='active'
BEGIN
  INSERT INTO public_observation_projection
    SELECT id,place_id,kind,source,status,observed_at,valid_until,received_at,cancelled_at,parking_min,parking_max,wait_seconds
    FROM observations WHERE id=NEW.id;
END;
CREATE TRIGGER public_observation_projection_update AFTER UPDATE ON observations
WHEN OLD.id IS NOT NEW.id OR OLD.place_id IS NOT NEW.place_id OR OLD.kind IS NOT NEW.kind
  OR OLD.source IS NOT NEW.source OR OLD.status IS NOT NEW.status OR OLD.observed_at IS NOT NEW.observed_at
  OR OLD.valid_until IS NOT NEW.valid_until OR OLD.received_at IS NOT NEW.received_at OR OLD.cancelled_at IS NOT NEW.cancelled_at
  OR OLD.parking_min IS NOT NEW.parking_min OR OLD.parking_max IS NOT NEW.parking_max OR OLD.wait_seconds IS NOT NEW.wait_seconds
BEGIN
  DELETE FROM public_observation_projection WHERE id=OLD.id;
  INSERT INTO public_observation_projection
    SELECT id,place_id,kind,source,status,observed_at,valid_until,received_at,cancelled_at,parking_min,parking_max,wait_seconds
    FROM observations WHERE id=NEW.id AND status='active';
END;
CREATE TRIGGER public_observation_projection_delete AFTER DELETE ON observations
BEGIN DELETE FROM public_observation_projection WHERE id=OLD.id; END;

-- Keep ingestion_items_v2_public_time/public_receipt until the new Worker no
-- longer names them with INDEXED BY. Remove them in a post-deployment migration.
