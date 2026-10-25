/** Bounded public projections. Private address rows never leave this module. */
import type { Env, Place } from './types';
import type { PublicSensorWindow } from './sensors';
import { windowItem, type BleWindow } from './ingest-validation';
import { validateCaptureConfigV2, validateConfigBatchV2, validateEnvelopeV2,
  type AddressSummary, type CaptureConfigV2 } from './device-v2-validation';
import { classifyCompactVehicleEvidence, VEHICLE_RULESET_VERSION } from './vehicle-rules';
import { DEFAULT_ELEVATOR_POLICY, ELEVATOR_BASELINE_VERSION, estimateElevatorWait,
  type ManualWaitObservation } from './elevator-estimation';

export interface AutomaticVehicleObservation {
  status: 'candidate_estimate' | 'unavailable'; source: 'ble_rule_inference'; model_version: string;
  observed_at: string | null; valid_until: string | null;
  candidate_count: number | null; car_related_count: number | null; ecosystem_count: number | null;
  sample_count: number; reason: string | null; quality_flags: string[];
  evidence_kind: 'compact' | 'raw' | 'none';
}
export interface AutomaticElevatorObservation {
  status: 'historical_estimate' | 'unavailable'; source: 'manual_historical_baseline'; model_version: string;
  wait_seconds: number | null; range_seconds: { lower: number; upper: number } | null;
  sample_count: number; day_count: number; observed_at: string | null; valid_until: string | null;
  reason: string | null; calibrated: false;
}
export interface AutomaticObservations {
  vehicles: AutomaticVehicleObservation;
  elevator: AutomaticElevatorObservation;
}
const SAFE_QUALITY_FLAGS = new Set(['partial_window', 'unique_table_overflow', 'aggregation_drops', 'raw_drops', 'raw_pressure_pause']);
const unavailableVehicle = (reason: string): AutomaticVehicleObservation => ({
  status: 'unavailable', source: 'ble_rule_inference', model_version: VEHICLE_RULESET_VERSION,
  observed_at: null, valid_until: null, candidate_count: null, car_related_count: null, ecosystem_count: null,
  sample_count: 0, reason, quality_flags: [], evidence_kind: 'none',
});
const unavailableElevator = (reason: string): AutomaticElevatorObservation => ({
  status: 'unavailable', source: 'manual_historical_baseline', model_version: ELEVATOR_BASELINE_VERSION,
  wait_seconds: null, range_seconds: null, sample_count: 0, day_count: 0,
  observed_at: null, valid_until: null, reason, calibrated: false,
});
interface SummaryRow {
  item_json: string; seq: number; utc_ms: number; duration_ms: number; window_seq: number;
  address: string; address_type: string;
  node_id: string; boot_id: string; placement_id: string; capture_config_id: string; dataset: string;
  batch_id: string; firmware_version: string;
}
function samePublicWindow(window: PublicSensorWindow, item: BleWindow) {
  return item.seq === window.seq && item.time.utc_ms === Date.parse(window.observed_at) &&
    item.time.uncertainty_ms === window.uncertainty_ms && item.duration_ms === window.duration_ms &&
    item.scan_enabled_ms === window.scan_enabled_ms && item.reports_aggregated === window.reports_aggregated &&
    item.visible_identifiers === window.visible_identifiers && item.unique_table_overflow === window.unique_table_overflow &&
    item.aggregation_drops === window.aggregation_drops;
}

async function readVehicles(env: Env, place: Place, windows: PublicSensorWindow[], now: number): Promise<AutomaticVehicleObservation> {
  if (!place.observation_kinds.includes('parking')) return unavailableVehicle('purpose_not_enabled');
  if (windows.length > 201) return unavailableVehicle('input_limit_exceeded');
  const candidates = windows.filter(row => row.dataset === 'field' && row.source === 'sensor');
  if (!candidates.length) return unavailableVehicle('no_field_sensor_windows');
  const scopeKey = (row: { node_id: string; placement_id: string }) => JSON.stringify([row.node_id, row.placement_id]);
  const scopes = [...new Map(candidates.map(row => [scopeKey(row), { node_id: row.node_id, placement_id: row.placement_id }])).values()];
  // Resolve immutable purpose for all bounded public candidates in one indexed
  // membership lookup. An activity-only receiver must not hide a parking one.
  const placements = await env.DB.prepare(`SELECT p.node_id,p.id AS placement_id,
      EXISTS(SELECT 1 FROM json_each(p.observation_kinds_json) purpose WHERE purpose.value='parking') AS parking
    FROM json_each(?) requested CROSS JOIN placements p
      ON p.id=json_extract(requested.value,'$.placement_id') AND p.node_id=json_extract(requested.value,'$.node_id')
    WHERE p.place_id=? LIMIT 202`).bind(JSON.stringify(scopes), place.id)
    .all<{ node_id: string; placement_id: string; parking: number }>();
  if (placements.results.length > 201) return unavailableVehicle('input_limit_exceeded');
  const parkingScopes = new Set(placements.results.filter(row => row.parking === 1).map(scopeKey));
  // Select by purpose and time only, before examining classification. Still one
  // receiver, with no fallback to an older positive or more complete result.
  const window = candidates.filter(row => parkingScopes.has(scopeKey(row)))
    .sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at) || a.node_id.localeCompare(b.node_id) || b.seq - a.seq)[0];
  if (!window) return unavailableVehicle(windows.length === 201 ? 'input_limit_exceeded'
    : placements.results.length ? 'purpose_not_enabled' : 'no_field_sensor_windows');
  const observed = window ? Date.parse(window.observed_at) : NaN;
  const until = window ? Date.parse(window.valid_until) : NaN;
  if (!window || !Number.isFinite(observed) || observed > now || !Number.isFinite(until) ||
      !Number.isSafeInteger(window.uncertainty_ms) || window.uncertainty_ms < 0 || window.uncertainty_ms > 30_000 ||
      until !== observed - window.uncertainty_ms + 90_000 || window.quality_flags.some(flag => !SAFE_QUALITY_FLAGS.has(flag))) {
    return unavailableVehicle('no_field_sensor_windows');
  }
  const result = { ...unavailableVehicle('vehicle_features_not_reported'), observed_at: window.observed_at,
    valid_until: window.valid_until, quality_flags: [...new Set(window.quality_flags)] };
  if (window.freshness !== 'fresh' || until <= now) return { ...result, reason: 'stale_sensor_window' };

  // Re-read immutable placement scope and the actual window. The public DTO
  // intentionally omits mono/epoch and cannot establish cross-stream equality.
  const metadata = await env.DB.prepare(`SELECT w.item_json,c.config_json,p.observation_kinds_json
    FROM all_sensor_windows w
    JOIN placements p ON p.id=w.placement_id AND p.node_id=w.node_id
    JOIN capture_configs c ON c.id=w.capture_config_id AND c.node_id=w.node_id
    LEFT JOIN placement_closures pc ON pc.placement_id=p.id AND pc.node_id=p.node_id
    WHERE w.node_id=? AND w.boot_id=? AND w.placement_id=? AND w.capture_config_id=? AND w.seq=?
      AND p.place_id=? AND w.dataset='field' AND w.expires_at_ms>? AND w.received_at<=?
      AND w.utc_ms-w.duration_ms-? >= p.valid_from_ms
      AND w.utc_ms+? <= COALESCE(pc.valid_until_ms,p.valid_until_ms,9223372036854775807)
    LIMIT 2`).bind(window.node_id, window.boot_id, window.placement_id, window.capture_config_id, window.seq,
      place.id, now, new Date(now).toISOString(), window.uncertainty_ms, window.uncertainty_ms)
    .all<{ item_json: string; config_json: string; observation_kinds_json: string }>();
  if (metadata.results.length !== 1) return { ...result, reason: 'no_field_sensor_windows' };
  let source: BleWindow, config: CaptureConfigV2;
  try {
    const stored = metadata.results[0];
    const purposes: unknown = JSON.parse(stored.observation_kinds_json);
    if (!Array.isArray(purposes) || !purposes.includes('parking')) return { ...result, reason: 'purpose_not_enabled' };
    source = windowItem(JSON.parse(stored.item_json), 'window');
    if (!samePublicWindow(window, source)) return { ...result, reason: 'inconsistent_vehicle_evidence' };
    const policy = JSON.parse(stored.config_json);
    if (policy.protocol !== 'campuspulse/2') return result;
    config = validateCaptureConfigV2(policy);
  } catch { return { ...result, reason: 'invalid_vehicle_evidence' }; }
  if (source.visible_identifiers > 64 || source.visible_identifiers > config.summary.max_addresses) {
    return { ...result, reason: 'input_limit_exceeded' };
  }
  // Fix the outer lookup to the existing node/boot/stream/window index. Without
  // this join order SQLite may scan a node's retained receipt history first.
  const rows = await env.DB.prepare(`SELECT i.item_json,i.seq,i.utc_ms,i.duration_ms,i.window_seq,i.address,i.address_type,
      b.node_id,b.boot_id,b.placement_id,b.capture_config_id,b.dataset,b.batch_id,b.firmware_version
    FROM ingestion_items_v2 i INDEXED BY ingestion_items_v2_window CROSS JOIN ingestion_batches_v2 b
      ON b.node_id=i.node_id AND b.batch_id=i.batch_id AND b.boot_id=i.boot_id
      AND b.placement_id=i.placement_id AND b.capture_config_id=i.capture_config_id AND b.dataset=i.dataset
    WHERE i.node_id=? AND i.boot_id=? AND i.placement_id=? AND i.capture_config_id=? AND i.window_seq=?
      AND i.stream='address_summaries' AND b.stream='address_summaries'
      AND i.dataset='field' AND b.dataset='field' AND i.expires_at_ms>? AND b.expires_at_ms>?
      AND i.received_at<=? AND b.received_at<=?
    LIMIT 65`).bind(window.node_id, window.boot_id, window.placement_id, window.capture_config_id,
      window.seq, now, now, new Date(now).toISOString(), new Date(now).toISOString()).all<SummaryRow>();
  if (rows.results.length > 64) return { ...result, reason: 'input_limit_exceeded' };
  if (rows.results.length > source.visible_identifiers) return { ...result, reason: 'inconsistent_vehicle_evidence' };
  if (rows.results.length < source.visible_identifiers) return { ...result, reason: 'summaries_pending' };
  if (!rows.results.length) return { ...result, reason: 'no_usable_vehicle_features' };
  const summaries: AddressSummary[] = [];
  try {
    for (const row of rows.results) {
      const batch = validateEnvelopeV2({ protocol: 'campuspulse/2', batch_id: row.batch_id, node_id: row.node_id,
        boot_id: row.boot_id, placement_id: row.placement_id, capture_config_id: row.capture_config_id,
        dataset: row.dataset, stream: 'address_summaries', firmware_version: row.firmware_version, items: [JSON.parse(row.item_json)] });
      validateConfigBatchV2(batch, config);
      if (batch.stream !== 'address_summaries') return { ...result, reason: 'invalid_vehicle_evidence' };
      const item = batch.items[0];
      if (item.seq !== row.seq || item.window_seq !== window.seq || item.window_seq !== row.window_seq ||
          item.time.utc_ms !== row.utc_ms || item.time.utc_ms !== source.time.utc_ms ||
          item.time.mono_ms !== source.time.mono_ms || item.time.clock_epoch !== source.time.clock_epoch ||
          item.time.uncertainty_ms !== source.time.uncertainty_ms || item.duration_ms !== row.duration_ms ||
          item.duration_ms !== source.duration_ms || item.address !== row.address || item.address_type !== row.address_type) {
        return { ...result, reason: 'inconsistent_vehicle_evidence' };
      }
      summaries.push(item);
    }
  } catch { return { ...result, reason: 'invalid_vehicle_evidence' }; }
  const totalReports = summaries.reduce((sum, row) => sum + row.reports, 0);
  if (new Set(summaries.map(row => `${row.address_type}:${row.address}`)).size !== summaries.length ||
      totalReports > source.reports_aggregated || (!source.unique_table_overflow && totalReports !== source.reports_aggregated)) {
    return { ...result, reason: 'inconsistent_vehicle_evidence' };
  }
  if (summaries.some(row => row.vehicle_evidence === undefined)) return result;
  result.evidence_kind = 'compact';
  let usable = 0, ebikes = 0, cars = 0, ecosystems = 0;
  for (const row of summaries) {
    const evidence = row.vehicle_evidence!;
    result.sample_count += evidence.parsed_reports;
    // Schema-valid but impossible positive masks cannot be presented as a zero.
    if (!evidence.parsed_reports && (evidence.name_brand_mask || evidence.exclusion_mask || evidence.ecosystem_mask)) {
      return { ...result, reason: 'invalid_vehicle_evidence' };
    }
    const classification = classifyCompactVehicleEvidence(evidence);
    if (classification.limitations.includes('malformed_evidence') || classification.limitations.includes('no_parsed_reports') ||
        classification.limitations.includes('conflicting_vehicle_categories')) {
      if (!result.quality_flags.includes('unusable_vehicle_features')) result.quality_flags.push('unusable_vehicle_features');
      continue;
    }
    usable++;
    ebikes += Number(classification.category === 'e_bike_related');
    cars += Number(classification.category === 'car_related');
    ecosystems += Number(classification.category === 'vehicle_ecosystem');
  }
  if (!usable) return { ...result, reason: 'no_usable_vehicle_features' };
  if (source.unique_table_overflow || source.aggregation_drops || usable !== summaries.length) {
    // Missing reports may hide either positive clues or exclusions. The result
    // is an incomplete observation, not a mathematical lower bound.
    result.quality_flags.push('incomplete_vehicle_evidence');
  }
  return { ...result, status: 'candidate_estimate', candidate_count: ebikes, car_related_count: cars,
    ecosystem_count: ecosystems, reason: null };
}

async function readElevator(env: Env, place: Place, now: number): Promise<AutomaticElevatorObservation> {
  if (!place.observation_kinds.includes('elevator')) return unavailableElevator('purpose_not_enabled');
  const policy = DEFAULT_ELEVATOR_POLICY;
  const rows = await env.DB.prepare(`SELECT id,place_id,kind,source,status,observed_at,received_at,wait_seconds
    FROM observations WHERE place_id=? AND kind='elevator' AND status='active' AND source='manual'
      AND observed_at>=? AND observed_at<=? AND received_at<=?
    ORDER BY observed_at DESC,id DESC LIMIT ?`).bind(place.id,
      new Date(now - policy.lookback_days * 86_400_000).toISOString(), new Date(now).toISOString(),
      new Date(now).toISOString(), policy.maximum_records + 1).all<ManualWaitObservation>();
  const estimate = estimateElevatorWait({ place_id: place.id, observations: rows.results, now_ms: now });
  return { status: estimate.status, source: 'manual_historical_baseline', model_version: estimate.algorithm_version,
    wait_seconds: estimate.median_wait_seconds,
    range_seconds: estimate.interval_seconds ? { lower: estimate.interval_seconds.lower, upper: estimate.interval_seconds.upper } : null,
    sample_count: estimate.sample_count, day_count: estimate.distinct_local_days, observed_at: estimate.as_of,
    valid_until: estimate.valid_until, reason: estimate.reasons[0] ?? null, calibrated: false };
}

export async function readAutomaticObservations(env: Env, place: Place, windows: PublicSensorWindow[], now: number): Promise<AutomaticObservations> {
  const [vehicles, elevator] = await Promise.all([readVehicles(env, place, windows, now), readElevator(env, place, now)]);
  return { vehicles, elevator };
}
