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
  // Eligibility is incrementally maintained with canonical field windows. Time
  // and retention remain read-time decisions, including receipts from backfill.
  const row = await env.DB.prepare(`SELECT w.node_id,w.boot_id,w.placement_id,w.capture_config_id,w.item_json,w.utc_ms,w.received_at
    FROM public_sensor_projection_v2 w INDEXED BY public_sensor_projection_v2_receipt
    WHERE w.place_id = ? AND w.unverified_eligible = 1 AND w.expires_at_ms > ?
      AND w.received_at <= ? AND w.placement_valid_from_ms <= ?
    ORDER BY w.received_at DESC,w.seq DESC,w.node_id,w.boot_id,w.capture_config_id LIMIT 1`)
    .bind(place, now, new Date(now).toISOString(), now)
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
  // The projection's place-wide index applies the global limit directly; all
  // retained windows remain available to range/history and backfill queries.
  const rows = await env.DB.prepare(`SELECT w.node_id,w.boot_id,w.placement_id,w.capture_config_id,w.item_json,w.utc_ms
    FROM public_sensor_projection_v2 w INDEXED BY public_sensor_projection_v2_time
    WHERE w.place_id = ? AND w.timed_eligible = 1 AND w.utc_ms >= ? AND w.utc_ms <= ? AND w.expires_at_ms > ?
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
