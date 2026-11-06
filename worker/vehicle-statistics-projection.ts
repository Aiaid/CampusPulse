import { V3_VEHICLE_CANDIDATE_RULESET } from './device-v3-statistics-validation';
import type { readPlaceStatistics } from './statistics-public';
import type { AutomaticVehicleObservation } from './place-inference';

/** Only accepts the authoritative aggregate read, which bounds clock error to 5s. */
export function projectVehicleStatistics(statistics: Awaited<ReturnType<typeof readPlaceStatistics>>, now: number): AutomaticVehicleObservation | null {
  if (!('versions' in statistics) || statistics.state !== 'observed' ||
    statistics.versions.extractor_version !== 'cp-v3-stats/1' || statistics.versions.ruleset_version !== V3_VEHICLE_CANDIDATE_RULESET ||
    statistics.estimated_total !== null || statistics.visible_identifiers === 0 ||
    statistics.quality.flags.some(flag => flag !== 'uncertain_clock') ||
    statistics.quality.scan_coverage_ms !== statistics.source.window_ms || statistics.quality.callback_drops !== 0 ||
    statistics.quality.aggregation_drops !== 0 || statistics.quality.address_overflow_reports !== 0) return null;
  const observed = Date.parse(statistics.observed_at), until = Date.parse(statistics.valid_until);
  if (!Number.isFinite(now) || !Number.isFinite(observed) || observed > now || !Number.isFinite(until) || until <= now) return null;
  return { status: 'candidate_estimate', source: 'ble_rule_inference', model_version: V3_VEHICLE_CANDIDATE_RULESET,
    observed_at: statistics.observed_at, valid_until: statistics.valid_until,
    candidate_count: statistics.candidates.e_bike_candidate, car_related_count: statistics.candidates.car_candidate,
    ecosystem_count: 0, sample_count: statistics.visible_identifiers, reason: null,
    quality_flags: [...statistics.quality.flags], evidence_kind: 'compact' };
}
