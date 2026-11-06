import { describe, expect, test, vi } from 'vitest';
import { createFieldMapReader, projectFieldMapScenes, selectFieldMapPlaces, MAX_FIELD_MAP_PLACES, FIELD_MAP_CONCURRENCY } from '../../src/campus/use-field-map-observations.js';
import { makeFieldSceneActors } from '../../src/campus/field-actors.js';

const now = Date.parse('2026-11-06T08:00:00Z');
const place = id => ({ id, name: id, gis_anchor: { x: .5, y: .5, verified: true } });
const library = place('library'), teaching = place('tianjiabing');
const sensor = extra => ({ source: 'sensor', dataset: 'field', protocol: 'campuspulse/3',
  node_id: 'test-node', boot_id: 'test-boot', placement_id: 'test-placement', policy_id: 'test-policy',
  assignment_generation: 1, seq: 1, uncertainty_ms: 0, reports_aggregated: 30, aggregation_drops: 0,
  unique_table_overflow: false, quality_flags: [], visible_identifiers: 12, duration_ms: 30000, scan_enabled_ms: 30000,
  observed_at: new Date(now - 1000).toISOString(), valid_until: new Date(now + 89000).toISOString(), ...extra });
const body = (sourcePlace, record = sensor()) => ({ place: sourcePlace, as_of: new Date(now).toISOString(), sensor: record, latest_observation: null });
const automatic = vehicles => ({ vehicles, elevator: { status: 'unavailable', source: 'manual_historical_baseline',
  model_version: 'historical-wait/1', sample_count: 0, reason: null, observed_at: null, valid_until: null,
  calibrated: false, day_count: 0, wait_seconds: null, range_seconds: null } });
const success = value => ({ ok: true, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const microtasks = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };

describe('independent live map observations', () => {
  test('admits only bounded unique verified in-map places', () => {
    expect(selectFieldMapPlaces([library, teaching, { ...place('unverified'), gis_anchor: { x: .5, y: .5 } },
      { ...place('outside'), gis_anchor: { x: 2, y: 2, verified: true } }, place('duplicate'), place('duplicate'), null]).map(item => item.id)).toEqual(['library', 'tianjiabing']);
    expect(selectFieldMapPlaces(Array.from({ length: 100 }, (_, index) => place(`place-${index}`)))).toHaveLength(MAX_FIELD_MAP_PLACES);
  });

  test('normalizes each source before exact-place projection and retains the other place when one fails', () => {
    const options = { places: [library, teaching], selectedId: 'library', selectedLive: { data: body(library) },
      reads: { tianjiabing: { data: body(teaching) } }, now };
    const actors = value => makeFieldSceneActors(projectFieldMapScenes({ ...options, ...value }));
    expect(actors()).toHaveLength(6);
    expect(new Set(actors().map(actor => actor.route.placeId))).toEqual(new Set(['library', 'tianjiabing']));
    for (const selectedLive of [{ data: null }, { data: body(library), error: 'failed' }, { data: body(teaching) },
      { data: body(library, sensor({ visible_identifiers: '12' })) },
      { data: body(library, sensor({ observed_at: new Date(now + 1000).toISOString() })) },
      { data: body(library, sensor({ valid_until: new Date(now - 1).toISOString() })) },
      { data: { ...body(library), as_of: new Date(now + 1000).toISOString() } }]) {
      expect(actors({ selectedLive })).toHaveLength(3);
      expect(new Set(actors({ selectedLive }).map(actor => actor.placeId))).toEqual(new Set(['tianjiabing']));
    }
    expect(actors({ reads: { tianjiabing: { data: body(teaching), error: 'failed' } } })).toHaveLength(3);
    expect(actors({ enabled: false })).toEqual([]);
    expect(actors({ now: now + 90000 })).toEqual([]);
    expect(actors({ layers: { people: false } })).toEqual([]);
    // Selecting a different place reuses its selected session; retained reads
    // for that place can never override it or leak from the old selected source.
    expect(actors({ selectedId: 'tianjiabing', selectedLive: { data: body(library) }, reads: {} })).toEqual([]);
  });

  test('uses only normal same-origin summary reads and clears a failed source independently', async () => {
    const states = new Map();
    const fetcher = vi.fn(async path => path.includes('library') ? success(body(library)) : { ok: false, status: 503 });
    const reader = createFieldMapReader((id, state) => states.set(id, state), fetcher);
    await reader.read([library, teaching]);
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/v1/places/library/summary', '/api/v1/places/tianjiabing/summary']);
    expect(fetcher.mock.calls.every(([, options]) => !options.method && options.signal instanceof AbortSignal)).toBe(true);
    expect(states.get('library').data.place.id).toBe('library');
    expect(states.get('tianjiabing')).toMatchObject({ data: null, loading: false, error: '现场读取失败（503）' });
    reader.cancel();
  });

  test('projects canonical device bike/car candidates separately and never substitutes unclassified BLE', () => {
    const vehicles = { status: 'candidate_estimate', source: 'ble_rule_inference', model_version: 'cp-v3-vehicle-candidates/1',
      reason: null, quality_flags: [], evidence_kind: 'compact', sample_count: 4,
      candidate_count: 2, car_related_count: 1, ecosystem_count: 0,
      observed_at: new Date(now - 1000).toISOString(), valid_until: new Date(now + 89000).toISOString() };
    const project = record => makeFieldSceneActors(projectFieldMapScenes({ places: [library, teaching],
      selectedId: 'library', selectedLive: { data: { ...body(library), automatic_observations: automatic(record) } },
      reads: { tianjiabing: { data: { ...body(teaching), automatic_observations: automatic(vehicles) } } }, now }));
    const candidates = project(vehicles);
    expect(candidates.filter(actor => actor.kind === 'car')).toHaveLength(2);
    expect(candidates.filter(actor => actor.kind === 'ride')).toHaveLength(4);
    const unclassified = { ...vehicles, status: 'unavailable', model_version: 'unclassified-v1',
      evidence_kind: 'none', candidate_count: null, car_related_count: null, ecosystem_count: null,
      reason: 'no classified evidence' };
    const unavailable = project(unclassified);
    expect(unavailable.filter(actor => actor.kind === 'car')).toHaveLength(1);
    expect(unavailable.filter(actor => actor.kind === 'ride')).toHaveLength(2);
    expect(unavailable.filter(actor => actor.kind !== 'walk').every(actor => actor.placeId === 'tianjiabing')).toBe(true);
  });

  test('bounds concurrency and total reads while respecting visibility', async () => {
    const pending = deferred();
    let visible = true;
    const fetcher = vi.fn(async path => { await pending.promise; return success(body(place(decodeURIComponent(path.split('/')[4])))); });
    const reader = createFieldMapReader(() => {}, fetcher, { visible: () => visible });
    const run = reader.read(Array.from({ length: 100 }, (_, index) => place(`p-${index}`)));
    expect(fetcher).toHaveBeenCalledTimes(FIELD_MAP_CONCURRENCY);
    pending.resolve(); await run;
    expect(fetcher).toHaveBeenCalledTimes(MAX_FIELD_MAP_PLACES);
    visible = false;
    await reader.read([library, teaching]);
    expect(fetcher).toHaveBeenCalledTimes(MAX_FIELD_MAP_PLACES);
    reader.cancel();
  });

  test('guards old scoped responses after place changes even when fetch ignores abort', async () => {
    const old = deferred();
    const published = [];
    const fetcher = vi.fn(path => path.includes('library') ? old.promise : Promise.resolve(success(body(teaching))));
    const reader = createFieldMapReader((id, state) => { if (!state.loading) published.push([id, state]); }, fetcher);
    const previous = reader.read([library]);
    await reader.read([teaching]);
    old.resolve(success(body(library))); await previous; await microtasks();
    expect(published.map(([id]) => id)).toEqual(['tianjiabing']);
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    reader.cancel();
  });

  test('invalid response clears a prior success and does not substitute another place', async () => {
    const states = new Map(); let wrong = false;
    const reader = createFieldMapReader((id, state) => states.set(id, state), async () => success(body(wrong ? teaching : library)));
    await reader.read([library]); expect(states.get('library').data).not.toBeNull();
    wrong = true; await reader.read([library]);
    expect(states.get('library')).toMatchObject({ data: null, loading: false });
    expect(states.get('library').error).toBeTruthy();
    reader.cancel();
  });
});
