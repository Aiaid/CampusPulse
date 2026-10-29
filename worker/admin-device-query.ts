// Probe each version's indexed history once per registry node. Joining UNION
// views first materializes all history and can re-sort it for every joined row.
const later = (v1: string, v2: string, status = false) => `${v1}.rowid IS NULL OR ${v2}.received_at>${v1}.received_at OR
  (${v2}.received_at=${v1}.received_at AND (${v2}.batch_id>${v1}.batch_id${status ? ` OR (${v2}.batch_id=${v1}.batch_id AND ${v2}.seq>${v1}.seq)` : ''}))`;
const batch = (field: string) => `(CASE WHEN ${later('b1', 'b2')} THEN b2.${field} ELSE b1.${field} END)`;
const status = (field: string) => `(CASE WHEN ${later('s1', 's2', true)} THEN s2.${field} ELSE s1.${field} END)`;
const received = batch('received_at');

export const DEVICE_SELECT = `SELECT n.id,n.name,n.board,n.enabled,
  m.state AS mqtt_state,m.verified_at AS mqtt_verified_at,m.namespace AS mqtt_namespace,
  CASE WHEN c.received_at IS NOT NULL AND (${received} IS NULL OR c.received_at>${received}) THEN c.received_at ELSE ${received} END AS last_seen_at,
  CASE WHEN c.received_at IS NOT NULL AND (${received} IS NULL OR c.received_at>${received}) THEN c.firmware_version ELSE ${batch('firmware_version')} END AS firmware_version,
  ${batch('capture_config_id')} AS reported_config_id,d.capture_config_id AS desired_config_id,
  ${received} AS ingestion_received_at,${batch('boot_id')} AS ingestion_boot_id,${batch('stream')} AS ingestion_stream,${batch('batch_id')} AS ingestion_batch_id,
  CASE WHEN json_extract(p.config_json,'$.protocol')='campuspulse/2' THEN
    CASE WHEN c.activation_config_id=d.capture_config_id THEN c.activation_state ELSE NULL END ELSE a.state END AS activation_state,
  CASE WHEN json_extract(p.config_json,'$.protocol')='campuspulse/2' THEN c.applied_config_id
    WHEN a.state='applied' THEN a.capture_config_id ELSE NULL END AS applied_config_id,
  json_extract(p.config_json,'$.protocol') AS desired_protocol,
  c.contact_json AS control_json,c.received_at AS control_received_at,
  ${status('item_json')} AS status_json,${status('received_at')} AS status_received_at,${status('boot_id')} AS status_boot_id,${status('capture_config_id')} AS status_config_id,${status('batch_id')} AS status_batch_id
  FROM device_nodes n
  LEFT JOIN mqtt_credentials m ON m.node_id=n.id
  LEFT JOIN ingestion_batches b1 ON b1.rowid=(SELECT x.rowid FROM ingestion_batches x WHERE x.node_id=n.id ORDER BY x.received_at DESC,x.batch_id DESC LIMIT 1)
  LEFT JOIN ingestion_batches_v2 b2 ON b2.rowid=(SELECT x.rowid FROM ingestion_batches_v2 x WHERE x.node_id=n.id ORDER BY x.received_at DESC,x.batch_id DESC LIMIT 1)
  LEFT JOIN device_desired_configs d ON d.node_id=n.id
  LEFT JOIN capture_configs p ON p.id=d.capture_config_id
  LEFT JOIN config_activation a ON a.node_id=n.id AND a.capture_config_id=d.capture_config_id
  LEFT JOIN device_control_v2 c ON c.node_id=n.id
  LEFT JOIN node_status s1 ON s1.rowid=(SELECT x.rowid FROM node_status x WHERE x.node_id=n.id ORDER BY x.received_at DESC,x.batch_id DESC,x.seq DESC LIMIT 1)
  LEFT JOIN ingestion_items_v2 s2 ON s2.rowid=(SELECT x.rowid FROM ingestion_items_v2 x WHERE x.node_id=n.id AND x.stream='node_status' ORDER BY x.received_at DESC,x.batch_id DESC,x.seq DESC LIMIT 1)`;

export const DEVICE_PLACEMENTS_SELECT = `SELECT p.*,COALESCE(c.valid_until_ms,p.valid_until_ms) AS effective_valid_until_ms,c.recorded_at AS closed_at,
  ((SELECT COUNT(*) FROM sensor_windows w WHERE w.placement_id=p.id AND w.utc_ms IS NOT NULL AND
    (w.utc_ms<p.valid_from_ms OR w.utc_ms+w.duration_ms>COALESCE(c.valid_until_ms,p.valid_until_ms,9223372036854775807))) +
   (SELECT COUNT(*) FROM ingestion_items_v2 w WHERE w.placement_id=p.id AND w.stream='ble_windows' AND w.utc_ms IS NOT NULL AND
    (w.utc_ms<p.valid_from_ms OR w.utc_ms+w.duration_ms>COALESCE(c.valid_until_ms,p.valid_until_ms,9223372036854775807)))) AS incompatible_window_count
  FROM placements p LEFT JOIN placement_closures c ON c.placement_id=p.id WHERE p.node_id=? ORDER BY p.valid_from_ms DESC,p.id LIMIT 201`;
