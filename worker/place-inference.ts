/** Bounded public projections. Private address rows never leave this module. */
import type { Env, Place } from './types';
import type { PublicSensorWindow } from './sensors';
import { readPlaceStatistics } from './statistics-public';
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
const unavailableVehicle = (reason: string): AutomaticVehicleObservation => ({
  status: 'unavailable', source: 'ble_rule_inference', model_version: 'unclassified-v1',
  observed_at: null, valid_until: null, candidate_count: null, car_related_count: null, ecosystem_count: null,
  sample_count: 0, reason, quality_flags: [], evidence_kind: 'none',
});
const unavailableElevator = (reason: string): AutomaticElevatorObservation => ({
  status: 'unavailable', source: 'manual_historical_baseline', model_version: ELEVATOR_BASELINE_VERSION,
  wait_seconds: null, range_seconds: null, sample_count: 0, day_count: 0,
  observed_at: null, valid_until: null, reason, calibrated: false,
});
async function readVehicles(env: Env, place: Place, _windows: PublicSensorWindow[], now: number): Promise<AutomaticVehicleObservation> {
  if (!place.observation_kinds.includes('parking')) return unavailableVehicle('purpose_not_enabled');
  const statistics = await readPlaceStatistics(env, place.id, now);
  if (!('versions' in statistics)) return unavailableVehicle(statistics.reason ?? 'no_field_statistics');
  // The admitted unclassified-v1 producer deliberately reports unknown keys.
  // Zero positive categories is not evidence that no vehicles are present.
  return { ...unavailableVehicle('classification_unavailable'), model_version: statistics.versions.ruleset_version,
    observed_at: statistics.observed_at, valid_until: statistics.valid_until,
    quality_flags: statistics.quality.flags };
}

async function readElevator(env: Env, place: Place, now: number): Promise<AutomaticElevatorObservation> {
  if (!place.observation_kinds.includes('elevator')) return unavailableElevator('purpose_not_enabled');
  const policy = DEFAULT_ELEVATOR_POLICY;
  const rows = await env.DB.prepare(`SELECT id,place_id,kind,source,status,observed_at,received_at,wait_seconds
    FROM public_observation_projection WHERE place_id=? AND kind='elevator' AND status='active' AND source='manual'
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
