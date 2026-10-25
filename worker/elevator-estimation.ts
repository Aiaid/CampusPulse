/** Recomputable elevator evidence. No I/O, raw-identity public projection or learned labels. */
import type { AddressSummary } from './device-v2-validation';
import type { BleWindow, Dataset } from './ingest-validation';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
export const ELEVATOR_BASELINE_VERSION = 'elevator-manual-quantiles-v1';
export const ELEVATOR_CANDIDATE_VERSION = 'elevator-visibility-candidates-v1';

/** Engineering availability gates, not experimentally validated accuracy thresholds. */
export const DEFAULT_ELEVATOR_POLICY = Object.freeze({
  minimum_samples: 5, minimum_local_days: 2, lookback_days: 14,
  latest_sample_max_age_days: 7, refresh_ms: 300_000, utc_offset_minutes: 480,
  local_hour_radius: 1, lower_quantile: 0.2, upper_quantile: 0.8, maximum_records: 2000,
});
export type ElevatorPolicy = { [K in keyof typeof DEFAULT_ELEVATOR_POLICY]: number };
export interface ManualWaitObservation {
  id: string; place_id: string; kind: string; source: string; status: string;
  observed_at: string; wait_seconds: number | null;
  /** Required for retrospective evaluation; late receipts cannot leak into a past cutoff. */
  received_at?: string;
  dataset?: Dataset;
}
export interface ElevatorWaitEstimate {
  status: 'historical_estimate' | 'unavailable';
  algorithm_version: typeof ELEVATOR_BASELINE_VERSION;
  source: 'manual_completed'; target: 'completed_manual_wait_distribution';
  scope: { place_id: string; direction: null; floor: null; elevator_group: null };
  median_wait_seconds: number | null;
  interval_seconds: { lower: number; upper: number; lower_quantile: number; upper_quantile: number } | null;
  interval_kind: 'empirical_quantiles_not_prediction_interval';
  sample_count: number; distinct_local_days: number; independent_sessions: null;
  minimum_sample_count: number; minimum_local_days: number;
  as_of: string | null; generated_at: string; valid_until: string | null;
  calibration_id: null; reasons: string[]; lookback_days: number;
  cohort: { utc_offset_minutes: number; local_hour: number; hour_radius: number; day_type: 'weekday' | 'weekend' };
}

function localTime(ms: number, offset: number) {
  const date = new Date(ms + offset * 60_000), day = date.getUTCDay();
  return { hour: date.getUTCHours(), date: date.toISOString().slice(0, 10), day_type: day === 0 || day === 6 ? 'weekend' as const : 'weekday' as const };
}
function validatePolicy(p: ElevatorPolicy) {
  const positive = [p.minimum_samples, p.minimum_local_days, p.lookback_days, p.latest_sample_max_age_days, p.refresh_ms, p.maximum_records];
  if (positive.some(n => !Number.isSafeInteger(n) || n < 1) || p.minimum_samples > p.maximum_records ||
      p.minimum_local_days > p.minimum_samples || p.lookback_days > 90 || p.latest_sample_max_age_days > p.lookback_days ||
      !Number.isSafeInteger(p.utc_offset_minutes) || Math.abs(p.utc_offset_minutes) > 840 ||
      !Number.isSafeInteger(p.local_hour_radius) || p.local_hour_radius < 0 || p.local_hour_radius > 6 ||
      !(p.lower_quantile >= 0 && p.lower_quantile < 0.5 && p.upper_quantile > 0.5 && p.upper_quantile <= 1)) {
    throw new RangeError('Invalid elevator baseline policy.');
  }
}
function quantile(sorted: number[], p: number) {
  const index = (sorted.length - 1) * p, low = Math.floor(index), fraction = index - low;
  return sorted[low] + fraction * (sorted[Math.ceil(index)] - sorted[low]);
}

/**
 * Coarse place-level reference from completed manual measurements. Current API
 * has no floor, direction, session or start-event labels; none are inferred here.
 * Expired display TTLs do not erase historical samples. Cancelled records do.
 */
export function estimateElevatorWait(input: {
  place_id: string; observations: readonly ManualWaitObservation[]; now_ms: number; as_of_ms?: number;
}, overrides: Partial<ElevatorPolicy> = {}): ElevatorWaitEstimate {
  const p = { ...DEFAULT_ELEVATOR_POLICY, ...overrides };
  validatePolicy(p);
  const cutoff = input.as_of_ms ?? input.now_ms;
  if (!Number.isSafeInteger(input.now_ms) || !Number.isSafeInteger(cutoff) || cutoff < 0 || cutoff > input.now_ms) {
    throw new RangeError('Invalid elevator estimate cutoff.');
  }
  const current = localTime(cutoff, p.utc_offset_minutes);
  const result: ElevatorWaitEstimate = {
    status: 'unavailable', algorithm_version: ELEVATOR_BASELINE_VERSION, source: 'manual_completed',
    target: 'completed_manual_wait_distribution', scope: { place_id: input.place_id, direction: null, floor: null, elevator_group: null },
    median_wait_seconds: null, interval_seconds: null, interval_kind: 'empirical_quantiles_not_prediction_interval',
    sample_count: 0, distinct_local_days: 0, independent_sessions: null,
    minimum_sample_count: p.minimum_samples, minimum_local_days: p.minimum_local_days,
    as_of: null, generated_at: new Date(input.now_ms).toISOString(), valid_until: null, calibration_id: null,
    reasons: [], lookback_days: p.lookback_days,
    cohort: { utc_offset_minutes: p.utc_offset_minutes, local_hour: current.hour, hour_radius: p.local_hour_radius, day_type: current.day_type },
  };
  if (input.observations.length > p.maximum_records) return { ...result, reasons: ['input_limit_exceeded'] };
  // An identical repeat contributes once; conflicting copies contribute nothing.
  const byId = new Map<string, ManualWaitObservation | null>();
  for (const row of input.observations) {
    if (!row.id || row.place_id !== input.place_id) continue;
    const previous = byId.get(row.id);
    if (previous === undefined) byId.set(row.id, row);
    else if (previous && (previous.kind !== row.kind || previous.source !== row.source || previous.status !== row.status ||
      previous.observed_at !== row.observed_at || previous.wait_seconds !== row.wait_seconds || previous.received_at !== row.received_at ||
      previous.dataset !== row.dataset)) byId.set(row.id, null);
  }
  const completed: { observed: number; wait: number; local: ReturnType<typeof localTime> }[] = [];
  for (const row of byId.values()) {
    if (!row || row.kind !== 'elevator' || row.source !== 'manual' || row.status !== 'active' ||
        (row.dataset !== undefined && row.dataset !== 'field') || row.wait_seconds === null ||
        !Number.isInteger(row.wait_seconds) || row.wait_seconds < 0 || row.wait_seconds > 7200) continue;
    const observed = Date.parse(row.observed_at), received = row.received_at === undefined ? null : Date.parse(row.received_at);
    if (!Number.isFinite(observed) || observed > cutoff || observed < 0 ||
        (received !== null && (!Number.isFinite(received) || received > cutoff || received < 0)) ||
        (cutoff < input.now_ms && received === null)) continue;
    completed.push({ observed, wait: row.wait_seconds, local: localTime(observed, p.utc_offset_minutes) });
  }
  if (!completed.length) return { ...result, reasons: ['no_manual_samples'] };
  const comparable = completed.filter(row => {
    const delta = Math.abs(row.local.hour - current.hour);
    return row.local.day_type === current.day_type && Math.min(delta, 24 - delta) <= p.local_hour_radius;
  });
  if (!comparable.length) return { ...result, reasons: ['no_comparable_samples'] };
  const recent = comparable.filter(row => row.observed >= cutoff - p.lookback_days * DAY_MS);
  if (!recent.length) return { ...result, reasons: ['stale_manual_samples'] };
  const latest = Math.max(...recent.map(row => row.observed));
  result.sample_count = recent.length;
  result.distinct_local_days = new Set(recent.map(row => row.local.date)).size;
  result.as_of = new Date(latest).toISOString();
  if (latest + p.latest_sample_max_age_days * DAY_MS <= cutoff) result.reasons.push('stale_manual_samples');
  if (recent.length < p.minimum_samples) result.reasons.push('insufficient_samples');
  if (result.distinct_local_days < p.minimum_local_days) result.reasons.push('insufficient_days');
  if (result.reasons.length) return result;
  const sorted = recent.map(row => row.wait).sort((a, b) => a - b);
  const nextHour = (Math.floor((cutoff + p.utc_offset_minutes * 60_000) / HOUR_MS) + 1) * HOUR_MS - p.utc_offset_minutes * 60_000;
  // A new calculation cannot renew the evidence age limit or cross a cohort boundary.
  result.valid_until = new Date(Math.min(cutoff + p.refresh_ms, nextHour, latest + p.latest_sample_max_age_days * DAY_MS)).toISOString();
  result.status = 'historical_estimate';
  result.median_wait_seconds = quantile(sorted, 0.5);
  result.interval_seconds = { lower: quantile(sorted, p.lower_quantile), upper: quantile(sorted, p.upper_quantile),
    lower_quantile: p.lower_quantile, upper_quantile: p.upper_quantile };
  return result;
}

export interface ElevatorEvidenceScope {
  node_id: string; boot_id: string; placement_id: string; capture_config_id: string; dataset: Dataset;
}
export interface ScopedElevatorWindow extends ElevatorEvidenceScope { item: BleWindow }
export interface ScopedElevatorSummary extends ElevatorEvidenceScope { item: AddressSummary }
export interface ElevatorVisibilityCandidate extends ElevatorEvidenceScope {
  status: 'inferred_candidate'; evidence_kind: 'address_visibility_only';
  address: string; address_type: AddressSummary['address_type'];
  first_seen_mono_ms: number; last_seen_mono_ms: number; observed_span_ms: number;
  first_window_seq: number; last_window_seq: number; occupied_bins: number;
  start: 'left_censored' | 'observed_after_absent_window';
  end: 'right_censored' | 'not_observed_in_complete_window' | 'coverage_interrupted';
  wait_seconds: null; boarding_confirmed: false;
}
export interface ElevatorCandidateEvidence {
  algorithm_version: typeof ELEVATOR_CANDIDATE_VERSION;
  status: 'inferred_candidate' | 'unavailable';
  /** Private only: never serialize this array in a public API. */
  candidates: ElevatorVisibilityCandidate[];
  public_summary: {
    status: 'inferred_candidate' | 'unavailable'; algorithm_version: typeof ELEVATOR_CANDIDATE_VERSION;
    candidate_count: number; count_unit: 'address_fragments_not_people';
    as_of: string | null; coverage_status: 'complete' | 'gaps' | 'unavailable';
    wait_estimate_status: 'unavailable'; reasons: string[];
  };
}
const scopeKey = (scope: ElevatorEvidenceScope) => JSON.stringify([scope.node_id, scope.boot_id, scope.placement_id, scope.capture_config_id, scope.dataset]);
const windowKey = (scope: ElevatorEvidenceScope, seq: number) => `${scopeKey(scope)}:${seq}`;
const identityKey = (summary: AddressSummary) => `${summary.address_type}:${summary.address}`;

/**
 * Count bins can support bounded observed-visibility spans, never waiting/boarding.
 * Only complete matching windows with reconciled summaries support negative
 * evidence. Reboots, epochs, missing windows, pauses, losses and address rotations
 * break tracks. Whole-window RSSI cannot support within-window direction/trends.
 */
export function extractElevatorCandidates(input: {
  windows: readonly ScopedElevatorWindow[]; summaries: readonly ScopedElevatorSummary[];
  now_ms: number; as_of_ms?: number;
}): ElevatorCandidateEvidence {
  const cutoff = input.as_of_ms ?? input.now_ms;
  if (!Number.isSafeInteger(cutoff) || cutoff < 0 || cutoff > input.now_ms) throw new RangeError('Invalid candidate cutoff.');
  const reasons = new Set<string>(['uncalibrated_ble', 'count_bins_without_rssi_timeline']);
  const candidates: ElevatorVisibilityCandidate[] = [];
  let latestUtc: number | null = null, goodWindows = 0, gaps = false;
  const finish = (): ElevatorCandidateEvidence => {
    const status = candidates.length ? 'inferred_candidate' as const : 'unavailable' as const;
    return { algorithm_version: ELEVATOR_CANDIDATE_VERSION, status, candidates, public_summary: {
      status, algorithm_version: ELEVATOR_CANDIDATE_VERSION, candidate_count: candidates.length,
      count_unit: 'address_fragments_not_people', as_of: latestUtc === null ? null : new Date(latestUtc).toISOString(),
      coverage_status: gaps ? 'gaps' : goodWindows ? 'complete' : 'unavailable', wait_estimate_status: 'unavailable', reasons: [...reasons].sort(),
    } };
  };
  if (input.windows.length > 256 || input.summaries.length > 4096) { reasons.add('input_limit_exceeded'); return finish(); }
  const summaries = new Map<string, ScopedElevatorSummary[]>();
  for (const row of input.summaries) {
    const key = windowKey(row, row.item.window_seq), rows = summaries.get(key) ?? [];
    rows.push(row); summaries.set(key, rows);
  }
  const groups = new Map<string, ScopedElevatorWindow[]>(), seen = new Set<string>(), duplicates = new Set<string>();
  for (const row of input.windows) {
    if (row.dataset !== 'field') continue;
    const id = windowKey(row, row.item.seq);
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
    const key = scopeKey(row), rows = groups.get(key) ?? [];
    rows.push(row); groups.set(key, rows);
  }
  if (groups.size > 1) reasons.add('scope_boundaries_preserved');
  for (const rows of groups.values()) {
    rows.sort((a, b) => a.item.time.mono_ms - b.item.time.mono_ms);
    let previous: BleWindow | null = null;
    const active = new Map<string, ElevatorVisibilityCandidate>();
    const close = (end: ElevatorVisibilityCandidate['end']) => {
      for (const track of active.values()) {
        track.end = end;
        if (track.observed_span_ms >= 10_000 && track.occupied_bins >= 2) candidates.push(track);
      }
      active.clear();
    };
    for (const row of rows) {
      const window = row.item, id = windowKey(row, window.seq), addresses = summaries.get(id) ?? [];
      const utc = window.time.utc_ms;
      if (utc === null || window.time.uncertainty_ms === null || window.time.uncertainty_ms > 1000) {
        reasons.add('clock_unavailable'); gaps = true; close('coverage_interrupted'); previous = null; continue;
      }
      // Inputs are limited to 15 minutes of event time; stale backfill is not current evidence.
      if (utc > cutoff || utc <= cutoff - 900_000) { close('coverage_interrupted'); previous = null; continue; }
      const complete = !duplicates.has(id) && window.scan_enabled_ms === window.duration_ms && window.aggregation_drops === 0 &&
        window.reports_seen === window.reports_aggregated && !window.unique_table_overflow && window.quality_flags.length === 0 &&
        new Set(addresses.map(address => identityKey(address.item))).size === addresses.length &&
        addresses.every(address => address.item.duration_ms === window.duration_ms && address.item.time.mono_ms === window.time.mono_ms &&
          address.item.time.clock_epoch === window.time.clock_epoch && address.item.time.utc_ms === utc &&
          address.item.time.uncertainty_ms !== null && address.item.time.uncertainty_ms <= 1000 && address.item.bin_ms <= 5000) &&
        addresses.reduce((sum, address) => sum + address.item.reports, 0) === window.reports_aggregated;
      if (!complete) { reasons.add('incomplete_window_evidence'); gaps = true; close('coverage_interrupted'); previous = null; continue; }
      const continuous = previous !== null && previous.seq + 1 === window.seq &&
        previous.time.clock_epoch === window.time.clock_epoch && previous.time.mono_ms === window.time.mono_ms - window.duration_ms &&
        previous.time.utc_ms !== null && Math.abs((utc - previous.time.utc_ms) - window.duration_ms) <= 2000;
      if (previous && !continuous) { reasons.add('scan_coverage_gaps'); gaps = true; close('coverage_interrupted'); }
      goodWindows++;
      latestUtc = Math.max(latestUtc ?? utc, utc);
      const visible = new Set(addresses.map(address => identityKey(address.item)));
      for (const [key, track] of active) if (!visible.has(key)) {
        track.end = 'not_observed_in_complete_window';
        if (track.observed_span_ms >= 10_000 && track.occupied_bins >= 2) candidates.push(track);
        active.delete(key);
      }
      for (const scoped of addresses) {
        const address = scoped.item, key = identityKey(address), start = window.time.mono_ms - window.duration_ms;
        const first = start + address.first_offset_ms, last = start + address.last_offset_ms;
        let track = active.get(key), sparse = false;
        // Long gaps between received reports are not continuous dwell even if scan was enabled.
        if (track && first - track.last_seen_mono_ms > 15_000) {
          track.end = 'coverage_interrupted';
          if (track.observed_span_ms >= 10_000 && track.occupied_bins >= 2) candidates.push(track);
          active.delete(key); track = undefined; sparse = true; reasons.add('sparse_address_reports');
        }
        if (!track) {
          track = { node_id: row.node_id, boot_id: row.boot_id, placement_id: row.placement_id, capture_config_id: row.capture_config_id,
            dataset: row.dataset, status: 'inferred_candidate', evidence_kind: 'address_visibility_only', address: address.address,
            address_type: address.address_type, first_seen_mono_ms: first, last_seen_mono_ms: last, observed_span_ms: last - first,
            first_window_seq: window.seq, last_window_seq: window.seq, occupied_bins: 0,
            start: continuous && !sparse ? 'observed_after_absent_window' : 'left_censored', end: 'right_censored', wait_seconds: null, boarding_confirmed: false };
          active.set(key, track);
        }
        track.last_seen_mono_ms = last; track.last_window_seq = window.seq;
        track.observed_span_ms = last - track.first_seen_mono_ms;
        track.occupied_bins += address.bins.filter(count => count > 0).length;
      }
      previous = window;
    }
    close('right_censored');
  }
  if (!goodWindows) reasons.add('no_usable_windows');
  if (!candidates.length) reasons.add('insufficient_temporal_evidence');
  if (candidates.length > 128) { candidates.length = 0; reasons.add('candidate_limit_exceeded'); }
  return finish();
}
