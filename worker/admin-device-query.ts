// Latest V3 state only. Retired protocol tables remain immutable historical data.
export const DEVICE_SELECT = `SELECT n.id,n.name,n.board,n.enabled,
 m.state AS mqtt_state,m.verified_at AS mqtt_verified_at,m.namespace AS mqtt_namespace,
 NULLIF(max(COALESCE(c.registered_at,''),COALESCE(json_extract(b.receipt_json,'$.received_at'),''),COALESCE(k.received_at,''),COALESCE(json_extract(l.receipt_json,'$.server_time'),'')),'') AS last_seen_at,
 json_extract(cap.capability_json,'$.producer_version') AS firmware_version,
 a.policy_id AS desired_policy_id,ap.policy_id AS applied_policy_id,ba.policy_id AS reported_policy_id,
 c.desired_generation,c.applied_generation,c.boot_id AS control_boot_id,k.state AS activation_state,
 json_extract(b.receipt_json,'$.received_at') AS ingestion_received_at,b.boot_id AS ingestion_boot_id,b.stream AS ingestion_stream,b.batch_id AS ingestion_batch_id,
 s.item_json AS status_json,json_extract(sb.receipt_json,'$.received_at') AS status_received_at,s.boot_id AS status_boot_id,sa.policy_id AS status_policy_id,s.batch_id AS status_batch_id
 FROM device_nodes n LEFT JOIN mqtt_credentials m ON m.node_id=n.id
 LEFT JOIN device_control_v3 c ON c.node_id=n.id
 LEFT JOIN device_capabilities_v3 cap ON cap.node_id=c.node_id AND cap.capability_sha256=c.capability_sha256
 LEFT JOIN device_assignments_v3 a ON a.node_id=c.node_id AND a.generation=c.desired_generation
 LEFT JOIN device_assignments_v3 ap ON ap.node_id=c.node_id AND ap.generation=c.applied_generation
 LEFT JOIN device_acknowledgements_v3 k ON k.node_id=c.node_id AND k.generation=c.desired_generation AND k.boot_id=c.boot_id
 LEFT JOIN device_statistics_authorizations_v3 l ON l.node_id=c.node_id AND l.generation=c.applied_generation
 LEFT JOIN statistics_batches_v3 b ON b.rowid=(SELECT x.rowid FROM statistics_batches_v3 x WHERE x.node_id=n.id ORDER BY json_extract(x.receipt_json,'$.received_at') DESC,x.batch_id DESC LIMIT 1)
 LEFT JOIN device_assignments_v3 ba ON ba.node_id=b.node_id AND ba.generation=b.generation
 LEFT JOIN statistics_batches_v3 sb ON sb.rowid=(SELECT x.rowid FROM statistics_batches_v3 x WHERE x.node_id=n.id AND x.stream='node_status' ORDER BY json_extract(x.receipt_json,'$.received_at') DESC,x.batch_id DESC LIMIT 1)
 LEFT JOIN statistics_status_v3 s ON s.rowid=(SELECT x.rowid FROM statistics_status_v3 x WHERE x.node_id=sb.node_id AND x.batch_id=sb.batch_id ORDER BY x.seq DESC LIMIT 1)
 LEFT JOIN device_assignments_v3 sa ON sa.node_id=sb.node_id AND sa.generation=sb.generation`;

export const DEVICE_PLACEMENTS_SELECT = `SELECT p.*,places.name AS place_name,COALESCE(c.valid_until_ms,p.valid_until_ms) AS effective_valid_until_ms,c.recorded_at AS closed_at,
 (SELECT COUNT(*) FROM statistics_windows_v3 w WHERE w.placement_id=p.id AND
  (w.end_utc_ms-w.duration_ms-w.uncertainty_ms<p.valid_from_ms OR w.end_utc_ms+w.uncertainty_ms>COALESCE(c.valid_until_ms,p.valid_until_ms,9223372036854775807))) AS incompatible_window_count
 FROM placements p LEFT JOIN placement_closures c ON c.placement_id=p.id LEFT JOIN places ON places.id=p.place_id WHERE p.node_id=? ORDER BY p.valid_from_ms DESC,p.id LIMIT 201`;
