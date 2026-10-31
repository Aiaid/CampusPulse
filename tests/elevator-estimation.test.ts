import { describe, expect, it } from 'vitest';
import { DEFAULT_ELEVATOR_POLICY, estimateElevatorWait,
  type ManualWaitObservation } from '../worker/elevator-estimation';

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
