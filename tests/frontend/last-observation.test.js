import { describe, expect, test } from 'vitest';
import { advanceLiveFieldRead, markLastFieldReadFailed, retainLastFieldSummary } from '../../src/campus/last-observation.js';

const now = Date.parse('2026-10-25T11:30:00Z'), iso = offset => new Date(now + offset).toISOString();
const place = { id: 'library', kind: 'activity', observation_kinds: ['activity', 'parking', 'elevator'] };
const sensor = extra => ({ source: 'sensor', dataset: 'field', seq: 1, visible_identifiers: 16,
  observed_at: iso(-120000), valid_until: iso(-30000), ...extra });
const parking = { id: 'parking', source: 'manual', kind: 'parking', status: 'active', place_id: 'library',
  parking_min: 2, parking_max: 5, observed_at: iso(-120000), valid_until: iso(-1000) };
const elevator = { ...parking, id: 'elevator', kind: 'elevator', wait_seconds: 27 };
const automatic = () => ({
  vehicles: { status: 'candidate_estimate', candidate_count: 2, car_related_count: 1, ecosystem_count: 0,
    observed_at: iso(-120000), valid_until: iso(-30000) },
  elevator: { status: 'historical_estimate', wait_seconds: 42, observed_at: iso(-120000), valid_until: iso(-30000) },
});
const summary = extra => ({ place, as_of: iso(-1000), sensor: sensor(), latest_observation: elevator,
  latest_observations: { parking, elevator }, automatic_observations: automatic(), ...extra });
const unavailable = (record, reason = 'summaries_pending') => ({ ...record, status: 'unavailable', reason,
  observed_at: null, valid_until: null, candidate_count: null, wait_seconds: null });

describe('last observation presentation cache', () => {
  test('retains reported windows only within a place and preserves upload/time uncertainty through failures', () => {
    const report = { ...sensor(), node_id: 'node', boot_id: 'boot', placement_id: 'placement', capture_config_id: 'config',
      duration_ms: 30000, scan_enabled_ms: 30000, reports_aggregated: 70, aggregation_drops: 0, quality_flags: [], unique_table_overflow: false,
      observed_at: null, valid_until: null, received_at: iso(-1000), uncertainty_ms: null, time_status: 'unknown', freshness: 'unverified' };
    const previous = summary({ sensor: null, last_reported_sensor: report });
    const result = retainLastFieldSummary(summary({ sensor: null, last_reported_sensor: null }), previous, now);
    expect(result.last_reported_sensor).toBe(report);
    expect(result.last_known.last_reported_sensor).toBe('source_unavailable');
    expect(markLastFieldReadFailed(result).last_known.last_reported_sensor).toBe('read_failed');
    expect(result.last_reported_sensor).toMatchObject({ observed_at: null, valid_until: null, freshness: 'unverified', received_at: iso(-1000) });
    expect(retainLastFieldSummary(summary({ place: { ...place, id: 'other' }, sensor: null, last_reported_sensor: null }), previous, now).last_reported_sensor).toBeNull();
    const zero = { ...report, seq: 2, received_at: iso(0), visible_identifiers: 0 };
    expect(retainLastFieldSummary(summary({ sensor: null, last_reported_sensor: zero }), previous, now).last_reported_sensor).toBe(zero);
    expect(retainLastFieldSummary(summary({ sensor: null, last_reported_sensor: { ...report, received_at: iso(1) } }), null, now).last_reported_sensor).toBeNull();
  });
  test('retains the original sensor timestamps when a successful read has no newer window', () => {
    const previous = summary(), next = summary({ as_of: iso(0), sensor: null });
    const result = retainLastFieldSummary(next, previous, now);
    expect(result.sensor).toBe(previous.sensor);
    expect(result.sensor.valid_until).toBe(iso(-30000));
    expect(result.as_of).toBe(iso(0));
    expect(result.last_known).toEqual({ sensor: 'source_unavailable' });
    expect(next.sensor).toBeNull();
    expect(previous.last_known).toBeUndefined();
  });

  test('a newer real zero replaces positive evidence rather than keeping old glyphs', () => {
    const next = summary({ sensor: sensor({ seq: 2, visible_identifiers: 0, observed_at: iso(-1000), valid_until: iso(89000) }) });
    next.automatic_observations.vehicles = { ...next.automatic_observations.vehicles, candidate_count: 0,
      observed_at: iso(-1000), valid_until: iso(89000) };
    const result = retainLastFieldSummary(next, summary(), now);
    expect(result.sensor.visible_identifiers).toBe(0);
    expect(result.automatic_observations.vehicles.candidate_count).toBe(0);
    expect(result.last_known).toEqual({});
  });

  test('keeps prior successful analysis during unavailable responses without changing evidence validity', () => {
    const previous = summary(), next = summary();
    next.automatic_observations.vehicles = unavailable(next.automatic_observations.vehicles);
    next.automatic_observations.elevator = unavailable(next.automatic_observations.elevator, 'stale_manual_samples');
    const result = retainLastFieldSummary(next, previous, now);
    expect(result.automatic_observations).toEqual(previous.automatic_observations);
    expect(result.last_known).toEqual({ vehicles: 'source_unavailable', elevator_reference: 'source_unavailable' });
  });

  test('purpose removal or explicit withdrawal clears previous automatic results', () => {
    const previous = summary(), next = summary({ place: { ...place, observation_kinds: ['activity'] } });
    next.automatic_observations.vehicles = unavailable(next.automatic_observations.vehicles, 'purpose_not_enabled');
    next.automatic_observations.elevator = unavailable(next.automatic_observations.elevator, 'unsupported_place_purpose');
    const result = retainLastFieldSummary(next, previous, now);
    expect(result.automatic_observations.vehicles.status).toBe('unavailable');
    expect(result.automatic_observations.elevator.status).toBe('unavailable');
    expect(result.last_known).toEqual({});
  });

  test('accepts a corrected authoritative elevator baseline after the newest sample was cancelled', () => {
    const previous = summary(), next = summary();
    next.automatic_observations.elevator = { ...next.automatic_observations.elevator, observed_at: iso(-240000),
      valid_until: iso(30000), wait_seconds: 23, sample_count: 5 };
    const result = retainLastFieldSummary(next, previous, now);
    expect(result.automatic_observations.elevator).toBe(next.automatic_observations.elevator);
    expect(result.last_known.elevator_reference).toBeUndefined();
    for (const reason of ['no_manual_samples', 'no_comparable_samples', 'insufficient_samples', 'insufficient_days', 'input_limit_exceeded']) {
      const missing = summary();
      missing.automatic_observations.elevator = unavailable(missing.automatic_observations.elevator, reason);
      expect(retainLastFieldSummary(missing, previous, now).automatic_observations.elevator.status).toBe('unavailable');
    }
  });

  test('successful manual nulls honor cancellation and never resurrect earlier reports', () => {
    const next = summary({ latest_observation: null, latest_observations: { parking: null, elevator: null } });
    const result = retainLastFieldSummary(next, summary(), now);
    expect(result.latest_observations).toEqual({ parking: null, elevator: null });
    expect(result.last_known).toEqual({});
  });

  test('never imports another place or creates evidence before the first successful observation', () => {
    const next = summary({ sensor: null, automatic_observations: undefined });
    expect(retainLastFieldSummary(next, summary({ place: { ...place, id: 'other' } }), now).sensor).toBeNull();
    expect(retainLastFieldSummary(next, null, now).last_known).toEqual({});
    expect(markLastFieldReadFailed(null)).toBeNull();
  });

  test('a future or older incoming sensor cannot displace the last actual observation', () => {
    const previous = summary();
    const future = summary({ sensor: sensor({ observed_at: iso(1000), valid_until: iso(91000) }) });
    expect(retainLastFieldSummary(future, previous, now).sensor).toBe(previous.sensor);
    expect(retainLastFieldSummary(future, null, now).sensor).toBeNull();
    const older = summary({ sensor: sensor({ observed_at: iso(-240000), valid_until: iso(-150000) }) });
    expect(retainLastFieldSummary(older, previous, now).last_known.sensor).toBe('older_response');
  });

  test('read failures mark each existing source while preserving original records and as_of', () => {
    const previous = summary(), result = markLastFieldReadFailed(previous);
    expect(result.sensor).toBe(previous.sensor);
    expect(result.as_of).toBe(previous.as_of);
    expect(result.last_known).toEqual({ sensor: 'read_failed', parking: 'read_failed', elevator: 'read_failed',
      vehicles: 'read_failed', elevator_reference: 'read_failed' });
    expect(previous.last_known).toBeUndefined();
    expect(retainLastFieldSummary(summary(), result, now).last_known).toEqual({});
  });

  test('keeps failure state through a pending retry until a successful response', () => {
    let value = advanceLiveFieldRead({ data: summary(), loading: false, error: '' }, null, place.id, now);
    value = advanceLiveFieldRead({ data: null, loading: false, error: 'Read failed' }, value.cache, place.id, now);
    expect(value.read.error).toBe('Read failed');
    expect(value.read.data.last_known.sensor).toBe('read_failed');
    value = advanceLiveFieldRead({ data: null, loading: true, error: '' }, value.cache, place.id, now);
    expect(value.read.loading).toBe(true);
    expect(value.read.error).toBe('Read failed');
    expect(value.read.data.last_known.sensor).toBe('read_failed');
    value = advanceLiveFieldRead({ data: null, loading: false, error: 'Still failed' }, value.cache, place.id, now);
    expect(value.read.error).toBe('Still failed');
    value = advanceLiveFieldRead({ data: summary(), loading: false, error: '' }, value.cache, place.id, now);
    expect(value.read.error).toBe('');
    expect(value.read.data.last_known).toEqual({});
    const other = advanceLiveFieldRead({ data: null, loading: true, error: '' }, value.cache, 'other-place', now);
    expect(other.cache).toBeNull();
    expect(other.read.data).toBeNull();
    expect(other.read.error).toBe('');
  });
});
