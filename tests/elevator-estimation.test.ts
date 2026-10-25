import { describe, expect, it } from 'vitest';
import { DEFAULT_ELEVATOR_POLICY, estimateElevatorWait, extractElevatorCandidates,
  type ManualWaitObservation, type ScopedElevatorSummary, type ScopedElevatorWindow } from '../worker/elevator-estimation';

const DAY = 86_400_000;
// Thursday 10:30 in Shanghai. All measurements below are synthetic test fixtures.
const NOW = Date.parse('2026-10-22T02:30:00.000Z');
const manual = (id: number, wait = id * 10, age = (id % 2) * DAY): ManualWaitObservation => ({
  id: `synthetic-manual-${id}`, place_id: 'library', kind: 'elevator', source: 'manual', status: 'active',
  observed_at: new Date(NOW - age).toISOString(), received_at: new Date(NOW - age + 1000).toISOString(), wait_seconds: wait,
});
const sampleSet = () => [0, 1, 2, 3, 4].map(id => manual(id, id * 10, (id % 2 + 1) * DAY));
const estimate = (observations: ManualWaitObservation[], now_ms = NOW) => estimateElevatorWait({ place_id: 'library', observations, now_ms });

describe('manual elevator historical reference', () => {
  it('uses explicit unavailable states for empty, small and one-day evidence', () => {
    expect(estimate([])).toMatchObject({ status: 'unavailable', median_wait_seconds: null, reasons: ['no_manual_samples'] });
    expect(estimate(sampleSet().slice(0, 2))).toMatchObject({ status: 'unavailable', sample_count: 2, reasons: ['insufficient_samples'] });
    expect(estimate(sampleSet().map(row => ({ ...row, observed_at: new Date(NOW - DAY).toISOString() })))).toMatchObject({
      status: 'unavailable', sample_count: 5, distinct_local_days: 1, reasons: ['insufficient_days'],
    });
  });

  it('returns tested engineering defaults and empirical quantiles including zero waits', () => {
    expect(DEFAULT_ELEVATOR_POLICY).toMatchObject({ minimum_samples: 5, minimum_local_days: 2 });
    const result = estimate(sampleSet());
    expect(result).toMatchObject({ status: 'historical_estimate', source: 'manual_completed', median_wait_seconds: 20,
      interval_seconds: { lower: 8, upper: 32, lower_quantile: 0.2, upper_quantile: 0.8 }, sample_count: 5,
      distinct_local_days: 2, independent_sessions: null, calibration_id: null, reasons: [],
      interval_kind: 'empirical_quantiles_not_prediction_interval', scope: { direction: null, floor: null, elevator_group: null } });
    expect(estimate(sampleSet().map(row => ({ ...row, wait_seconds: 0 })))).toMatchObject({
      median_wait_seconds: 0, interval_seconds: { lower: 0, upper: 0 },
    });
    expect(result.as_of).toBe(new Date(NOW - DAY).toISOString());
    expect(result.valid_until).toBe(new Date(NOW + 300_000).toISOString());
  });

  it('does not count other places, predictions, cancelled, demo or malformed measurements', () => {
    const modifiers = [{ source: 'inferred_candidate' }, { place_id: 'other' }, { status: 'cancelled' },
      { dataset: 'demo' as const }, { dataset: 'controlled_test' as const }, { wait_seconds: NaN },
      { wait_seconds: -1 }, { wait_seconds: 7201 }, { wait_seconds: 1.5 }, { wait_seconds: null }, { kind: 'parking' }];
    for (const modifier of modifiers) expect(estimate(sampleSet().map(row => ({ ...row, ...modifier }))).status).toBe('unavailable');
  });

  it('deduplicates records and excludes conflicting repeated IDs without mutating input', () => {
    const rows = sampleSet(), original = structuredClone(rows);
    expect(estimate([...rows, ...rows]).sample_count).toBe(5);
    expect(estimate([...rows, { ...rows[0], wait_seconds: 90 }])).toMatchObject({ status: 'unavailable', sample_count: 4 });
    expect(rows).toEqual(original);
  });

  it('gates on latest evidence age, independently of display TTL or generation time', () => {
    const rows = sampleSet().map(row => ({ ...row, observed_at: new Date(Date.parse(row.observed_at) - 7 * DAY).toISOString() }));
    expect(estimate(rows)).toMatchObject({ status: 'unavailable', reasons: ['stale_manual_samples'] });
    expect(estimate(rows.map(row => ({ ...row, observed_at: new Date(Date.parse(row.observed_at) - 30 * DAY).toISOString() })))).toMatchObject({
      status: 'unavailable', reasons: ['stale_manual_samples'],
    });
    const expiring = sampleSet().map((row, i) => ({ ...row,
      observed_at: new Date(NOW - (7 + i % 2) * DAY + 30_000).toISOString() }));
    expect(estimate(expiring).valid_until).toBe(new Date(NOW + 30_000).toISOString());
    expect(estimate(expiring, NOW + 30_000)).toMatchObject({ status: 'unavailable', reasons: ['stale_manual_samples'] });
  });

  it('separates local hour and weekday/weekend cohorts', () => {
    const rows = sampleSet();
    expect(estimate(rows.map(row => ({ ...row, observed_at: new Date(Date.parse(row.observed_at) - 2 * 3_600_000).toISOString() })))).toMatchObject({
      status: 'unavailable', reasons: ['no_comparable_samples'],
    });
    expect(estimate(rows.map(row => ({ ...row, observed_at: '2026-10-18T02:30:00.000Z' })))).toMatchObject({
      status: 'unavailable', reasons: ['no_comparable_samples'],
    });
    expect(estimate(rows.map(row => ({ ...row, observed_at: new Date(Date.parse(row.observed_at) - 3_600_000).toISOString() })))).toMatchObject({ status: 'historical_estimate' });
  });

  it('uses circular local hours and expires at the next cohort boundary', () => {
    const now = Date.parse('2026-10-22T16:59:00.000Z'); // Friday 00:59 local
    const rows = sampleSet().map((row, i) => ({ ...row, observed_at: i % 2 ? '2026-10-21T15:30:00.000Z' : '2026-10-19T16:30:00.000Z' }));
    const result = estimate(rows, now);
    expect(result).toMatchObject({ status: 'historical_estimate', cohort: { local_hour: 0 } });
    expect(result.valid_until).toBe('2026-10-22T17:00:00.000Z');
  });

  it('never uses future observations, future receipts, or missing receipt times in retrospective evaluation', () => {
    expect(estimate(sampleSet().map(row => ({ ...row, observed_at: new Date(NOW + 1).toISOString() })))).toMatchObject({ reasons: ['no_manual_samples'] });
    expect(estimate(sampleSet().map(row => ({ ...row, received_at: new Date(NOW + 1).toISOString() })))).toMatchObject({ reasons: ['no_manual_samples'] });
    const rows = sampleSet().map(({ received_at: _received, ...row }) => row);
    expect(estimate(rows).status).toBe('historical_estimate');
    expect(estimateElevatorWait({ place_id: 'library', observations: rows, now_ms: NOW + 1000, as_of_ms: NOW })).toMatchObject({ reasons: ['no_manual_samples'] });
    expect(estimateElevatorWait({ place_id: 'library', observations: sampleSet(), now_ms: NOW + 1000, as_of_ms: NOW }).status).toBe('historical_estimate');
  });

  it('makes configuration explicit and fails closed on oversized input', () => {
    expect(estimateElevatorWait({ place_id: 'library', observations: sampleSet().slice(0, 2), now_ms: NOW }, { minimum_samples: 2 })).toMatchObject({ status: 'historical_estimate' });
    expect(estimateElevatorWait({ place_id: 'library', observations: sampleSet(), now_ms: NOW }, { maximum_records: 4, minimum_samples: 4 })).toMatchObject({ reasons: ['input_limit_exceeded'] });
    expect(() => estimateElevatorWait({ place_id: 'library', observations: [], now_ms: NOW }, { minimum_samples: 0 })).toThrow(RangeError);
  });

  it('exposes neither sample IDs nor unexpected source properties', () => {
    const serialized = JSON.stringify(estimate(sampleSet().map(row => ({ ...row, address: 'de:ad:be:ef:00:01' }))));
    expect(serialized).not.toContain('synthetic-manual');
    expect(serialized).not.toContain('de:ad:be:ef');
  });
});

const scope = { node_id: 'test-node', boot_id: 'test-boot', placement_id: 'test-elevator', capture_config_id: 'test-config', dataset: 'field' as const };
const baseUtc = NOW - 300_000;
function window(seq: number, reports = 6, end = seq * 30_000): ScopedElevatorWindow {
  return { ...scope, item: { seq, time: { mono_ms: end, utc_ms: baseUtc + end, clock_epoch: 1, uncertainty_ms: 100 },
    duration_ms: 30_000, scan_enabled_ms: 30_000, reports_seen: reports, reports_aggregated: reports, aggregation_drops: 0,
    adv_reports: reports, scan_response_reports: 0, visible_identifiers: reports ? 1 : 0,
    unique_table_capacity: 64, unique_table_overflow: false, rssi: { samples: reports, min_dbm: -75, max_dbm: -55, mean_dbm: -65 },
    raw_capture: { mode: 'off', selected_reports: 0, intentional_skips: 0, pressure_skips: 0, drops: 0 }, quality_flags: [] } };
}
function summary(seq: number, address = 'c0:00:00:00:00:01', end = seq * 30_000): ScopedElevatorSummary {
  return { ...scope, item: { seq, window_seq: seq, time: { mono_ms: end, utc_ms: baseUtc + end, clock_epoch: 1, uncertainty_ms: 100 },
    duration_ms: 30_000, bin_ms: 5000, address, address_type: 'random', reports: 6, adv_reports: 6, scan_response_reports: 0,
    first_offset_ms: 100, last_offset_ms: 29_000, bins: [1, 1, 1, 1, 1, 1], rssi: { samples: 6, min_dbm: -75, max_dbm: -55, mean_dbm: -65 } } };
}
const extract = (windows: ScopedElevatorWindow[], summaries: ScopedElevatorSummary[]) => extractElevatorCandidates({ windows, summaries, now_ms: NOW });

describe('private elevator address visibility evidence', () => {
  it('never turns an empty input into a zero wait', () => {
    expect(extract([], [])).toMatchObject({ status: 'unavailable', candidates: [], public_summary: { wait_estimate_status: 'unavailable', as_of: null } });
  });

  it('extracts observed spans with bounded absence evidence, never boarding or wait labels', () => {
    const result = extract([window(1, 0), window(2), window(3), window(4, 0)], [summary(2), summary(3)]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ status: 'inferred_candidate', evidence_kind: 'address_visibility_only',
      first_seen_mono_ms: 30_100, last_seen_mono_ms: 89_000, observed_span_ms: 58_900,
      start: 'observed_after_absent_window', end: 'not_observed_in_complete_window', wait_seconds: null, boarding_confirmed: false });
    expect(result.public_summary).toMatchObject({ coverage_status: 'complete', candidate_count: 1, wait_estimate_status: 'unavailable', count_unit: 'address_fragments_not_people' });
    expect(result.public_summary.reasons).toContain('uncalibrated_ble');
    expect(result.public_summary.reasons).toContain('count_bins_without_rssi_timeline');
  });

  it('splits the real-shaped 30s active / 90s pause pattern without a departure claim', () => {
    const result = extract([window(1), window(2, 6, 150_000)], [summary(1), summary(2, undefined, 150_000)]);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].end).toBe('coverage_interrupted');
    expect(result.candidates[1].start).toBe('left_censored');
    expect(result.public_summary).toMatchObject({ coverage_status: 'gaps', wait_estimate_status: 'unavailable' });
    expect(result.public_summary.reasons).toContain('scan_coverage_gaps');
  });

  it('preserves boot, placement, configuration and random-address boundaries', () => {
    for (const change of [{ boot_id: 'new-boot' }, { placement_id: 'new-placement' }, { capture_config_id: 'new-config' }]) {
      const result = extract([window(1), { ...window(2), ...change }], [summary(1), { ...summary(2), ...change }]);
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.every(candidate => candidate.observed_span_ms === 28_900)).toBe(true);
      expect(result.public_summary.reasons).toContain('scope_boundaries_preserved');
    }
    const rotated = extract([window(1), window(2)], [summary(1), summary(2, 'd0:00:00:00:00:02')]);
    expect(rotated.candidates).toHaveLength(2);
    expect(rotated.candidates.every(candidate => candidate.boarding_confirmed === false)).toBe(true);
  });

  it('does not treat missing summaries, losses, partial scan or table overflow as absence', () => {
    for (const change of [{ scan_enabled_ms: 20_000 }, { aggregation_drops: 1 }, { unique_table_overflow: true }, { quality_flags: ['scan_paused'] }]) {
      const middle = window(2, 0);
      const result = extract([window(1), { ...middle, item: { ...middle.item, ...change } }, window(3)], [summary(1), summary(3)]);
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0].end).toBe('coverage_interrupted');
      expect(result.public_summary.reasons).toContain('incomplete_window_evidence');
    }
    const missing = extract([window(1), window(2), window(3)], [summary(1), summary(3)]);
    expect(missing.candidates[0].end).toBe('coverage_interrupted');
  });

  it('cuts at missing sequence, clock-epoch changes and unknown clocks', () => {
    expect(extract([window(1), window(3, 6, 60_000)], [summary(1), summary(3, undefined, 60_000)]).public_summary.reasons).toContain('scan_coverage_gaps');
    const w = window(2), s = summary(2);
    w.item.time.clock_epoch = 2; s.item.time.clock_epoch = 2;
    expect(extract([window(1), w], [summary(1), s]).candidates).toHaveLength(2);
    w.item.time.utc_ms = null;
    expect(extract([w], [s]).public_summary.reasons).toContain('clock_unavailable');
  });

  it('excludes stale, future and non-field evidence', () => {
    const old = window(1), future = window(2), demo = window(3);
    old.item.time.utc_ms = NOW - 900_000; future.item.time.utc_ms = NOW + 1; demo.dataset = 'demo';
    expect(extract([old, future, demo], [summary(1), summary(2), summary(3)])).toMatchObject({ status: 'unavailable', candidates: [] });
  });

  it('keeps singleton/sparse bins and duplicates from manufacturing a duration', () => {
    const w = window(1, 1), s = summary(1);
    Object.assign(s.item, { reports: 1, adv_reports: 1, first_offset_ms: 100, last_offset_ms: 100, bins: [1, 0, 0, 0, 0, 0] });
    expect(extract([w], [s]).candidates).toEqual([]);
    expect(extract([window(1), window(1)], [summary(1)]).candidates).toEqual([]);
  });

  it('only exposes aggregate evidence and enforces input bounds', () => {
    const result = extract([window(1)], [summary(1)]);
    const publicText = JSON.stringify(result.public_summary);
    for (const hidden of ['c0:00', 'test-node', 'test-boot', 'test-elevator', 'test-config', 'mono_ms']) expect(publicText).not.toContain(hidden);
    expect(extract(Array.from({ length: 257 }, () => window(1)), []).public_summary.reasons).toContain('input_limit_exceeded');
  });
});
