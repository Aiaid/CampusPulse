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

export interface LastReportedSensorWindow extends Omit<PublicSensorWindow, 'observed_at' | 'valid_until' | 'uncertainty_ms' | 'freshness'> {
  received_at: string;
  observed_at: string | null;
  valid_until: null;
  uncertainty_ms: number | null;
  time_status: 'unknown' | 'uncertain';
  freshness: 'unverified';
}

/** Receipt-ordered fallback, never a timed observation or an inference input. */
export async function readLastReportedSensor(env: Env, place: string, now = Date.now()): Promise<LastReportedSensorWindow | null> {
  // Bound each placement independently before the global winner. The partial
  // receipt index contains only field BLE windows, never private summaries.
  const row = await env.DB.prepare(`SELECT w.node_id,w.boot_id,w.placement_id,w.capture_config_id,w.item_json,w.utc_ms,w.received_at
    FROM placements p
    LEFT JOIN placement_closures c ON c.placement_id = p.id AND c.node_id = p.node_id
    CROSS JOIN ingestion_items_v2 w ON w.rowid IN (
      SELECT candidate.rowid FROM ingestion_items_v2 candidate INDEXED BY ingestion_items_v2_public_receipt
      JOIN capture_configs config ON config.id = candidate.capture_config_id AND config.node_id = candidate.node_id
        AND config.placement_id = candidate.placement_id AND config.dataset = candidate.dataset
      WHERE candidate.placement_id = p.id AND candidate.node_id = p.node_id
      AND candidate.stream = 'ble_windows' AND candidate.dataset = 'field' AND candidate.expires_at_ms > ?
      AND candidate.received_at >= strftime('%Y-%m-%dT%H:%M:%fZ',p.valid_from_ms / 1000.0,'unixepoch')
      AND (COALESCE(c.valid_until_ms,p.valid_until_ms) IS NULL
        OR candidate.received_at < strftime('%Y-%m-%dT%H:%M:%fZ',COALESCE(c.valid_until_ms,p.valid_until_ms) / 1000.0,'unixepoch'))
      AND candidate.received_at <= ?
      AND (candidate.utc_ms IS NULL OR json_extract(candidate.item_json,'$.time.uncertainty_ms') IS NULL
        OR json_extract(candidate.item_json,'$.time.uncertainty_ms') > 30000
        OR EXISTS (SELECT 1 FROM json_each(candidate.item_json,'$.quality_flags') flag WHERE flag.value = 'utc_jump'))
      AND (candidate.utc_ms IS NULL OR candidate.utc_ms <= 8640000000000000)
      AND NOT EXISTS (SELECT 1 FROM json_each(candidate.item_json,'$.quality_flags') flag
        WHERE flag.value NOT IN ('partial_window','unique_table_overflow','aggregation_drops','raw_drops','raw_pressure_pause','utc_jump'))
      ORDER BY candidate.received_at DESC,candidate.seq DESC,candidate.node_id,candidate.boot_id,candidate.capture_config_id LIMIT 1
    )
    WHERE p.place_id = ? AND p.valid_from_ms <= ?
    ORDER BY w.received_at DESC,w.seq DESC,w.node_id,w.boot_id,w.capture_config_id LIMIT 1`)
    .bind(now, new Date(now).toISOString(), place, now)
    .first<{ node_id: string; boot_id: string; placement_id: string; capture_config_id: string; item_json: string; utc_ms: number | null; received_at: string }>();
  if (!row) return null;
  const item = JSON.parse(row.item_json) as BleWindow;
  return {
    node_id: row.node_id, boot_id: row.boot_id, placement_id: row.placement_id, capture_config_id: row.capture_config_id,
    source: 'sensor', dataset: 'field', seq: item.seq, received_at: row.received_at,
    observed_at: row.utc_ms === null ? null : new Date(row.utc_ms).toISOString(), valid_until: null,
    uncertainty_ms: item.time.uncertainty_ms, time_status: row.utc_ms === null ? 'unknown' : 'uncertain', freshness: 'unverified',
    duration_ms: item.duration_ms, scan_enabled_ms: item.scan_enabled_ms,
    reports_aggregated: item.reports_aggregated, visible_identifiers: item.visible_identifiers,
    unique_table_overflow: item.unique_table_overflow, aggregation_drops: item.aggregation_drops,
    quality_flags: item.quality_flags,
  };
}
export async function readPublicWindows(env: Env, place: string, from: number, now = Date.now()): Promise<PublicSensorWindow[]> {
  // A global LIMIT alone lets SQLite visit every retained item before sorting.
  // Each indexed placement contributes at most 201 eligible rows; their global
  // top 201 is exactly the global top 201 of the full eligible set.
  const rows = await env.DB.prepare(`SELECT w.node_id,w.boot_id,w.placement_id,w.capture_config_id,w.item_json,w.utc_ms
    FROM placements p
    LEFT JOIN placement_closures c ON c.placement_id = p.id AND c.node_id = p.node_id
    CROSS JOIN ingestion_items_v2 w ON w.rowid IN (
      SELECT candidate.rowid FROM ingestion_items_v2 candidate INDEXED BY ingestion_items_v2_public_time
      WHERE candidate.placement_id = p.id AND candidate.node_id = p.node_id
      AND candidate.stream = 'ble_windows' AND candidate.dataset = 'field'
      AND candidate.utc_ms >= ? AND candidate.utc_ms <= ? AND candidate.expires_at_ms > ?
      AND json_extract(candidate.item_json, '$.time.uncertainty_ms') BETWEEN 0 AND 30000
      AND NOT EXISTS (SELECT 1 FROM json_each(candidate.item_json, '$.quality_flags') flag
        WHERE flag.value NOT IN ('partial_window','unique_table_overflow','aggregation_drops','raw_drops','raw_pressure_pause'))
      AND candidate.utc_ms - candidate.duration_ms - json_extract(candidate.item_json, '$.time.uncertainty_ms') >= p.valid_from_ms
      AND candidate.utc_ms + json_extract(candidate.item_json, '$.time.uncertainty_ms') <= COALESCE(c.valid_until_ms,p.valid_until_ms,9223372036854775807)
      ORDER BY candidate.utc_ms DESC,candidate.node_id,candidate.seq DESC LIMIT 201
    )
    WHERE p.place_id = ?
    ORDER BY w.utc_ms DESC,w.node_id,w.seq DESC LIMIT 201`).bind(from, now, now, place)
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
