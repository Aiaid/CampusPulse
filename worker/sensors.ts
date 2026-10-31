import { IngestError } from './strict-json';
import { statisticsLimits } from './device-v3-statistics';
import { loadStatisticsAuthority, v3StatisticsEnabled, type DeviceV3StatisticsEnv, type StatisticsAuthority } from './device-v3-statistics-policy';
import { decodeStatisticsPublicWindow, STATISTICS_QUALITY_FLAGS, type StatisticsPublicRow } from './statistics-public';

/** Public aggregate metadata preserves the original V3 policy identity. */
export interface PublicSensorWindow {
  node_id: string; boot_id: string; placement_id: string;
  protocol: 'campuspulse/3'; policy_id: string; assignment_generation: number;
  source: 'sensor'; dataset: 'field'; seq: number; observed_at: string; valid_until: string;
  uncertainty_ms: number; duration_ms: number; scan_enabled_ms: number;
  reports_aggregated: number; visible_identifiers: number; unique_table_overflow: boolean;
  aggregation_drops: number; quality_flags: string[]; freshness: 'fresh' | 'stale';
}

/** V3 rejects unprovable source times at ingest. A receipt is never a substitute
 * measurement timestamp, and retired-protocol rows are not a fallback. */
export async function readLastReportedSensor(_env: DeviceV3StatisticsEnv, _place: string, _now = Date.now()): Promise<null> {
  return null;
}

export async function readPublicWindows(env: DeviceV3StatisticsEnv, place: string, from: number, now = Date.now()): Promise<PublicSensorWindow[]> {
  if (!v3StatisticsEnabled(env)) return [];
  const rows = await env.DB.prepare(`SELECT w.*,a.policy_id,a.policy_sha256 FROM placements p
    JOIN device_nodes n ON n.id=p.node_id AND n.enabled=1
    LEFT JOIN placement_closures pc ON pc.placement_id=p.id AND pc.node_id=p.node_id
    JOIN statistics_windows_v3 w INDEXED BY statistics_windows_v3_projection ON w.placement_id=p.id AND w.node_id=p.node_id
    JOIN device_assignments_v3 a ON a.node_id=w.node_id AND a.generation=w.generation AND a.boot_id=w.boot_id
    JOIN device_capabilities_v3 c ON c.node_id=a.node_id AND c.capability_sha256=a.capability_sha256
    JOIN device_acknowledgements_v3 k ON k.node_id=a.node_id AND k.generation=a.generation AND k.boot_id=a.boot_id AND k.state='applied'
    JOIN device_statistics_authorizations_v3 z ON z.node_id=a.node_id AND z.generation=a.generation AND z.boot_id=a.boot_id AND z.policy_sha256=a.policy_sha256
    WHERE p.place_id=? AND w.dataset='field' AND w.collection_mode='fixed_point' AND w.item_json IS NOT NULL
      AND w.end_utc_ms>=? AND w.end_utc_ms<=? AND w.received_at_ms<=? AND w.expires_at_ms>?
      AND w.uncertainty_ms BETWEEN 0 AND 5000 AND z.accept_until_ms>?
      AND w.end_utc_ms-w.uncertainty_ms-w.duration_ms>=p.valid_from_ms
      AND w.end_utc_ms+w.uncertainty_ms<=COALESCE(pc.valid_until_ms,p.valid_until_ms,9223372036854775807)
      AND w.end_utc_ms-w.uncertainty_ms-w.duration_ms>=MAX(a.not_before_ms,c.issued_at_ms)
      AND w.end_utc_ms+w.uncertainty_ms<=MIN(a.expires_at_ms,c.expires_at_ms,?)
      AND EXISTS(SELECT 1 FROM device_statistics_lease_spans_v3 s WHERE s.node_id=w.node_id AND s.generation=w.generation
        AND s.start_ms<=w.end_utc_ms-w.uncertainty_ms-w.duration_ms AND s.end_ms>=w.end_utc_ms+w.uncertainty_ms
        AND s.end_ms>w.end_utc_ms-w.uncertainty_ms-w.duration_ms)
    ORDER BY w.end_utc_ms DESC,w.node_id,w.seq DESC LIMIT 201`)
    .bind(place, from, now, now, now, now, now).all<StatisticsPublicRow>();
  const authorities = new Map<string, StatisticsAuthority>();
  const result: PublicSensorWindow[] = [];
  for (const row of rows.results) {
    const key = JSON.stringify([row.node_id, row.boot_id, row.generation]);
    let authority = authorities.get(key);
    if (!authority) {
      // Fail closed instead of returning a deceptively complete partial history.
      if (authorities.size >= 32) throw new IngestError(503, 'public_scope_limit', 'Too many source authorities for one public read.');
      authority = await loadStatisticsAuthority(env, { node_id: row.node_id, boot_id: row.boot_id,
        assignment_generation: row.generation, policy_id: row.policy_id, policy_sha256: row.policy_sha256 });
      authorities.set(key, authority);
    }
    const p = authority.policy;
    if (p.custody.dataset !== 'field' || p.collection.mode !== 'fixed_point' || p.custody.placement_id !== row.placement_id) {
      throw new IngestError(503, 'invalid_statistics_source', 'The source scope failed verification.');
    }
    const w = decodeStatisticsPublicWindow(row, { ...statisticsLimits(p), max_bins: authority.capabilities.summary?.max_bins });
    const expiry = w.time.utc_ms! + p.custody.source_retention_hours * 3600000;
    if (expiry <= now) continue;
    const validUntil = Math.min(row.expires_at_ms, expiry, row.end_utc_ms - row.uncertainty_ms + Math.max(90000, 2 * row.duration_ms));
    result.push({ node_id: row.node_id, boot_id: row.boot_id, placement_id: row.placement_id,
      protocol: 'campuspulse/3', policy_id: row.policy_id, assignment_generation: row.generation,
      source: 'sensor', dataset: 'field', seq: w.seq, observed_at: new Date(row.end_utc_ms).toISOString(), valid_until: new Date(validUntil).toISOString(),
      uncertainty_ms: row.uncertainty_ms, duration_ms: w.duration_ms, scan_enabled_ms: w.losses.scan_coverage_ms,
      reports_aggregated: w.reports.worker, visible_identifiers: w.visible_identifiers,
      unique_table_overflow: w.losses.address_overflow_reports > 0, aggregation_drops: w.losses.aggregation_drops,
      quality_flags: STATISTICS_QUALITY_FLAGS.filter((_, i) => w.quality_mask & (1 << i)), freshness: validUntil > now ? 'fresh' : 'stale' });
  }
  return result;
}
