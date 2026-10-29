/** Frozen pre-projection v2 source queries for unit/runtime parity checks.
 * These intentionally retain read-time joins and JSON guards; do not optimize
 * them alongside the derived cache or they stop being an independent oracle.
 */
/** Bind order: place_id, from_ms, now_ms, now_ms (retention cutoff). */
export const WINDOW_SOURCE_SQL = `SELECT w.* FROM ingestion_items_v2 w
    JOIN placements p ON p.id=w.placement_id AND p.node_id=w.node_id
    LEFT JOIN placement_closures c ON c.placement_id=p.id AND c.node_id=p.node_id
    WHERE p.place_id=? AND w.stream='ble_windows' AND w.dataset='field'
      AND w.utc_ms>=? AND w.utc_ms<=? AND w.expires_at_ms>?
      AND json_extract(w.item_json,'$.time.uncertainty_ms') BETWEEN 0 AND 30000
      AND NOT EXISTS(SELECT 1 FROM json_each(w.item_json,'$.quality_flags') flag
        WHERE flag.value NOT IN ('partial_window','unique_table_overflow','aggregation_drops','raw_drops','raw_pressure_pause'))
      AND w.utc_ms-w.duration_ms-json_extract(w.item_json,'$.time.uncertainty_ms')>=p.valid_from_ms
      AND w.utc_ms+json_extract(w.item_json,'$.time.uncertainty_ms')<=COALESCE(c.valid_until_ms,p.valid_until_ms,9223372036854775807)
    ORDER BY w.utc_ms DESC,w.node_id,w.seq DESC LIMIT 201`;

/** Bind order: place_id, now_ms (retention), now_ms (placement start), now_iso. */
export const FALLBACK_SOURCE_SQL = `SELECT w.* FROM ingestion_items_v2 w
    JOIN placements p ON p.id=w.placement_id AND p.node_id=w.node_id
    JOIN capture_configs config ON config.id=w.capture_config_id AND config.node_id=w.node_id
      AND config.placement_id=w.placement_id AND config.dataset=w.dataset
    LEFT JOIN placement_closures c ON c.placement_id=p.id AND c.node_id=p.node_id
    WHERE p.place_id=? AND w.stream='ble_windows' AND w.dataset='field' AND w.expires_at_ms>?
      AND p.valid_from_ms<=?
      AND w.received_at>=strftime('%Y-%m-%dT%H:%M:%fZ',p.valid_from_ms/1000.0,'unixepoch')
      AND (COALESCE(c.valid_until_ms,p.valid_until_ms) IS NULL
        OR w.received_at<strftime('%Y-%m-%dT%H:%M:%fZ',COALESCE(c.valid_until_ms,p.valid_until_ms)/1000.0,'unixepoch'))
      AND w.received_at<=?
      AND (w.utc_ms IS NULL OR json_extract(w.item_json,'$.time.uncertainty_ms') IS NULL
        OR json_extract(w.item_json,'$.time.uncertainty_ms')>30000
        OR EXISTS(SELECT 1 FROM json_each(w.item_json,'$.quality_flags') flag WHERE flag.value='utc_jump'))
      AND (w.utc_ms IS NULL OR w.utc_ms<=8640000000000000)
      AND NOT EXISTS(SELECT 1 FROM json_each(w.item_json,'$.quality_flags') flag
        WHERE flag.value NOT IN ('partial_window','unique_table_overflow','aggregation_drops','raw_drops','raw_pressure_pause','utc_jump'))
    ORDER BY w.received_at DESC,w.seq DESC,w.node_id,w.boot_id,w.capture_config_id LIMIT 1`;
