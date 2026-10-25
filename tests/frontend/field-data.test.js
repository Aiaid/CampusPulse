import { describe, expect, test, vi } from 'vitest';
import { createFieldReader, fieldReadPath, fieldRecordKey, latestManualObservations, normalizeFieldResponse, recordFreshness } from '../../src/campus/field-data.js';

const now = Date.parse('2026-10-25T10:00:00.000Z');
const iso = offset => new Date(now + offset).toISOString();
const sensor = overrides => ({
  source: 'sensor', dataset: 'field', node_id: 'node-1', boot_id: 'boot-1', placement_id: 'placement-1', capture_config_id: 'config-1', seq: 3,
  observed_at: iso(-30_000), valid_until: iso(30_000), uncertainty_ms: 0, duration_ms: 30_000,
  scan_enabled_ms: 29_000, reports_aggregated: 17, visible_identifiers: 5, unique_table_overflow: false,
  aggregation_drops: 0, quality_flags: [], freshness: 'fresh', ...overrides,
});
const manual = overrides => ({
  id: 'manual-1', place_id: 'parking', source: 'manual', status: 'active', kind: 'parking',
  observed_at: iso(-90_000), valid_until: iso(-30_000), parking_min: 0, parking_max: 4, wait_seconds: null, ...overrides,
});
const summary = overrides => ({ place: { id: 'parking' }, as_of: iso(0), freshness: 'fresh', sensor: sensor(), latest_observation: manual(), ...overrides });
const history = overrides => ({ place_id: 'parking', from: iso(-86_400_000), to: iso(0), observations: [manual()], sensor_windows: [sensor()], truncated: false, sensor_truncated: false, ...overrides });
const options = { placeId: 'parking', mode: 'live' };
const reply = body => ({ ok: true, json: async () => body });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

describe('public field response semantics', () => {
  test('reads the public summary/history contracts without any scene fallback', () => {
    expect(fieldReadPath('parking', 'live')).toBe('/api/v1/places/parking/summary');
    expect(fieldReadPath('parking', 'replay')).toBe('/api/v1/places/parking/history?minutes=1440');
    expect(fieldReadPath('parking', 'replay', 15)).toBe('/api/v1/places/parking/history?minutes=15');
    expect(() => fieldReadPath('parking', 'demo')).toThrow();
    expect(() => fieldReadPath('parking', 'replay', 30)).toThrow();
    expect(normalizeFieldResponse(summary(), options).latest_observation.parking_min).toBe(0);
  });

  test('expires each source independently of the combined summary or cached freshness', () => {
    const data = normalizeFieldResponse(summary(), options);
    expect(data.freshness).toBe('fresh');
    expect(recordFreshness(data.sensor, now)).toBe('fresh');
    expect(recordFreshness(data.latest_observation, now)).toBe('stale');
    expect(recordFreshness(data.sensor, now + 30_000)).toBe('stale');
    expect(recordFreshness(sensor({ observed_at: iso(10_000) }), now)).toBe('stale');
    expect(recordFreshness({ valid_until: 'invalid', observed_at: iso(-1) }, now)).toBe('stale');
    expect(recordFreshness(null, now)).toBe('no_data');
  });

  test('keeps both manual purposes and expires them independently of the sensor and each other', () => {
    const parking = manual(), elevator = manual({ id: 'elevator-1', kind: 'elevator', wait_seconds: 70, observed_at: iso(-10_000), valid_until: iso(10_000) });
    const data = normalizeFieldResponse(summary({ latest_observation: elevator, latest_observations: { parking, elevator } }), options);
    expect(latestManualObservations(data)).toEqual({ parking, elevator });
    expect(recordFreshness(data.latest_observations.parking, now)).toBe('stale');
    expect(recordFreshness(data.latest_observations.elevator, now)).toBe('fresh');
    expect(recordFreshness(data.latest_observations.elevator, now + 10_000)).toBe('stale');
    expect(recordFreshness(data.sensor, now + 10_000)).toBe('fresh');
  });

  test('normalizes a legacy singleton only to its actual purpose and respects explicit empty cards', () => {
    expect(normalizeFieldResponse(summary(), options).latest_observations).toEqual({ parking: manual(), elevator: null });
    expect(normalizeFieldResponse(summary({ latest_observation: null }), options).latest_observations).toEqual({ parking: null, elevator: null });
    const data = normalizeFieldResponse(summary({ latest_observations: { parking: null, elevator: null } }), options);
    expect(latestManualObservations(data)).toEqual({ parking: null, elevator: null });
  });

  test('keeps missing sources empty and merges only actual retained historical records', () => {
    const empty = normalizeFieldResponse(summary({ sensor: null, latest_observation: null, freshness: 'no_data' }), options);
    expect(empty.sensor).toBeNull();
    expect(empty.latest_observation).toBeNull();
    const data = normalizeFieldResponse(history({ truncated: true, sensor_truncated: true }), { ...options, mode: 'replay' });
    expect(data.records.map(record => [record.source, record.observed_at])).toEqual([['sensor', iso(-30_000)], ['manual', iso(-90_000)]]);
    expect(data.records).toHaveLength(2);
    expect(data.truncated).toBe(true);
    expect(data.sensor_truncated).toBe(true);
    expect(normalizeFieldResponse(history({ observations: [], sensor_windows: [] }), { ...options, mode: 'replay' }).records).toEqual([]);
  });

  test('keeps records from different boots/nodes and manual source distinct at an identical timestamp', () => {
    const sameTime = iso(-30_000);
    const records = normalizeFieldResponse(history({
      sensor_windows: [sensor(), sensor({ boot_id: 'boot-2' }), sensor({ node_id: 'node-2' })],
      observations: [manual({ observed_at: sameTime, valid_until: iso(30_000) })],
    }), { ...options, mode: 'replay' }).records;
    expect(new Set(records.map(fieldRecordKey)).size).toBe(4);
    expect(records).toHaveLength(4);
  });

  test.each([
    summary({ place: { id: 'different' } }),
    summary({ sensor: sensor({ dataset: 'demo' }) }),
    summary({ sensor: sensor({ boot_id: undefined }) }),
    summary({ sensor: sensor({ unique_table_overflow: 'false' }) }),
    summary({ sensor: sensor({ visible_identifiers: -1 }) }),
    summary({ sensor: sensor({ observed_at: iso(60_000) }) }),
    summary({ sensor: sensor({ quality_flags: [3] }) }),
    summary({ latest_observation: manual({ place_id: 'different' }) }),
    summary({ latest_observation: manual({ source: 'demo' }) }),
    summary({ latest_observation: manual({ status: 'cancelled' }) }),
    summary({ latest_observation: manual({ parking_min: 8, parking_max: 2 }) }),
    summary({ latest_observations: null }),
    summary({ latest_observations: [] }),
    summary({ latest_observations: { parking: manual() } }),
    summary({ latest_observations: { parking: manual(), elevator: manual() } }),
    summary({ latest_observations: { parking: manual({ dataset: 'controlled_test' }), elevator: null } }),
    summary({ latest_observations: { parking: manual({ dataset: 'demo' }), elevator: null } }),
    summary({ latest_observations: { parking: manual({ place_id: 'other' }), elevator: null } }),
    summary({ as_of: 'invalid' }),
    { place: { id: 'parking' }, as_of: iso(0) },
  ])('rejects malformed or non-field summaries without inventing replacements %#', body => {
    expect(() => normalizeFieldResponse(body, options)).toThrow('无效记录');
  });

  test.each([
    history({ sensor_truncated: 'false' }),
    history({ truncated: undefined }),
    history({ from: iso(1) }),
    history({ sensor_windows: [sensor({ observed_at: iso(-86_400_001) })] }),
    history({ observations: [manual({ observed_at: iso(1000), valid_until: iso(2000) })] }),
    history({ place_id: 'different' }),
    history({ observations: [manual({ dataset: 'demo' })] }),
    history({ observations: [manual({ dataset: 'controlled_test' })] }),
  ])('rejects malformed or out-of-range history %#', body => {
    expect(() => normalizeFieldResponse(body, { ...options, mode: 'replay' })).toThrow('无效记录');
  });
});

describe('field read ownership and failures', () => {
  test('publishes real server data and sends no-store with an abort signal', async () => {
    const states = [], fetcher = vi.fn(async () => reply(summary()));
    const reader = createFieldReader(state => states.push(state), fetcher);
    await reader.read(options);
    expect(fetcher).toHaveBeenCalledWith('/api/v1/places/parking/summary', { cache: 'no-store', signal: expect.any(AbortSignal) });
    expect(states.map(state => state.loading)).toEqual([true, false]);
    expect(states.at(-1).data.sensor.visible_identifiers).toBe(5);
    reader.cancel();
  });

  test('superseded reads cannot replace the new selection even when transport ignores abort', async () => {
    const older = deferred(), newer = deferred(), states = [], signals = [];
    const fetcher = vi.fn((path, init) => { signals.push(init.signal); return signals.length === 1 ? older.promise : newer.promise; });
    const reader = createFieldReader(state => states.push(state), fetcher);
    const first = reader.read(options);
    const second = reader.read({ placeId: 'library', mode: 'live' });
    expect(signals[0].aborted).toBe(true);
    newer.resolve(reply(summary({ place: { id: 'library' }, latest_observation: null })));
    await second;
    older.resolve(reply(summary()));
    await first;
    expect(states.filter(state => state.data).map(state => state.data.place.id)).toEqual(['library']);
    reader.cancel();
  });

  test('unmounted reads cannot publish a late error or body', async () => {
    const body = deferred(), states = [];
    const reader = createFieldReader(state => states.push(state), async () => ({ ok: true, json: () => body.promise }));
    const pending = reader.read(options);
    await Promise.resolve();
    reader.cancel();
    body.resolve(summary());
    await pending;
    expect(states).toEqual([{ loading: true, data: null, error: '' }]);
  });

  test.each([
    async () => ({ ok: false, status: 503 }),
    async () => { throw new TypeError('Network unavailable'); },
    async () => ({ ok: true, json: async () => { throw new SyntaxError('Invalid JSON'); } }),
    async () => reply(summary({ sensor: sensor({ dataset: 'demo' }) })),
  ])('clears data and exposes failed reads rather than using a simulated fallback %#', async fetcher => {
    const states = [];
    const reader = createFieldReader(state => states.push(state), fetcher);
    await reader.read(options);
    expect(states.at(-1)).toMatchObject({ loading: false, data: null });
    expect(states.at(-1).error).toBeTruthy();
    reader.cancel();
  });
});
