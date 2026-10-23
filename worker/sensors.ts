import type { Env } from './types';
import type { BleWindow } from './ingest-validation';

export interface PublicSensorWindow {
  node_id: string;
  boot_id: string;
  placement_id: string;
  capture_config_id: string;
  source: 'sensor';
  dataset: 'field';
  seq: number;
  observed_at: string;
  valid_until: string;
  uncertainty_ms: number;
  duration_ms: number;
  scan_enabled_ms: number;
  reports_aggregated: number;
  visible_identifiers: number;
  unique_table_overflow: boolean;
  aggregation_drops: number;
  quality_flags: string[];
  freshness: 'fresh' | 'stale';
}
export async function readPublicWindows(env: Env, place: string, from: number, now = Date.now()): Promise<PublicSensorWindow[]> {
  const rows = await env.DB.prepare(`SELECT w.node_id,w.boot_id,w.placement_id,w.capture_config_id,w.item_json,w.utc_ms
    FROM sensor_windows w JOIN placements p ON p.id = w.placement_id AND p.node_id = w.node_id
    LEFT JOIN placement_closures c ON c.placement_id = p.id AND c.node_id = p.node_id
    WHERE p.place_id = ? AND w.dataset = 'field' AND w.utc_ms >= ? AND w.utc_ms <= ? AND w.expires_at_ms > ?
    AND json_extract(w.item_json, '$.time.uncertainty_ms') BETWEEN 0 AND 30000
    AND NOT EXISTS (SELECT 1 FROM json_each(w.item_json, '$.quality_flags') flag
      WHERE flag.value NOT IN ('partial_window','unique_table_overflow','aggregation_drops','raw_drops','raw_pressure_pause'))
    AND w.utc_ms - w.duration_ms - json_extract(w.item_json, '$.time.uncertainty_ms') >= p.valid_from_ms
    AND w.utc_ms + json_extract(w.item_json, '$.time.uncertainty_ms') <= COALESCE(c.valid_until_ms,p.valid_until_ms,9223372036854775807)
    ORDER BY w.utc_ms DESC,w.node_id,w.seq DESC LIMIT 201`).bind(place, from, now, now)
    .all<{ node_id: string; boot_id: string; placement_id: string; capture_config_id: string; item_json: string; utc_ms: number }>();
  return rows.results.map(row => {
    const item = JSON.parse(row.item_json) as BleWindow;
    const uncertainty = item.time.uncertainty_ms!;
    const validUntil = row.utc_ms - uncertainty + 90_000;
    return {
      node_id: row.node_id, boot_id: row.boot_id, placement_id: row.placement_id, capture_config_id: row.capture_config_id,
      source: 'sensor', dataset: 'field', seq: item.seq,
      observed_at: new Date(row.utc_ms).toISOString(), valid_until: new Date(validUntil).toISOString(),
      uncertainty_ms: uncertainty,
      duration_ms: item.duration_ms, scan_enabled_ms: item.scan_enabled_ms,
      reports_aggregated: item.reports_aggregated, visible_identifiers: item.visible_identifiers,
      unique_table_overflow: item.unique_table_overflow, aggregation_drops: item.aggregation_drops,
      quality_flags: item.quality_flags, freshness: validUntil > now ? 'fresh' : 'stale',
    };
  });
}
