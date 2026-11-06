import { describe, expect, test } from 'vitest';
import { makeFieldActors, MAX_FIELD_ACTORS } from '../../src/campus/field-actors.js';
import { fieldIllustration } from '../../src/campus/field-illustration.js';

const library = { id: 'library', x: 640, y: 270 };
const people = extra => ({ kind: 'people', source: 'sensor', metric_value: 12,
  figure_count: 3, actor_eligible: true, ...extra });
const bikes = extra => ({ kind: 'bikes', source: 'candidate', metric_value: 4,
  figure_count: 2, actor_eligible: true, ...extra });
const illustration = (groups = [people()], extra = {}) => ({
  place_id: 'library', replay: false, groups, update_failed: false, ...extra,
});
const actors = (groups, extra = {}, place = library, layers = {}) =>
  makeFieldActors(illustration(groups, extra), place, layers);

describe('uploaded field map actors', () => {
  test('draws library sensor activity only at library, sharing one uploaded budget across paths', () => {
    const result = actors([people()]);
    expect(result).toHaveLength(3);
    expect(new Set(result.map(actor => actor.route.placeId))).toEqual(new Set(['library']));
    expect(new Set(result.map(actor => actor.route.id)).size).toBeGreaterThan(1);
    expect(new Set(result.map(actor => actor.id)).size).toBe(3);
    expect(result.every(actor => actor.kind === 'walk' && !actor.parked && actor.length > 0)).toBe(true);
    expect(result.some(actor => actor.route.placeId === 'teaching-9')).toBe(false);
  });

  test('never defaults vehicle sprites from sensor activity, illustrative groups, manual parking or cars', () => {
    const unsupported = [bikes({ source: 'manual' }), bikes({ source: 'illustrative' }),
      bikes({ kind: 'cars' }), people({ kind: 'bikes' }), bikes({ kind: 'unknown' })];
    const result = actors([people(), ...unsupported]);
    expect(result).toHaveLength(3);
    expect(result.every(actor => actor.kind === 'walk')).toBe(true);
    expect(actors(unsupported)).toEqual([]);
  });

  test('keeps device actor evidence independent of manual card precedence and honors explicit empty projection', () => {
    const manual = bikes({ source: 'manual', metric_value: 99 });
    const result = actors([manual], { actor_groups: [people(), bikes()] });
    expect(result).toHaveLength(5);
    expect(result.filter(actor => actor.kind === 'ride')).toHaveLength(2);
    expect(actors([people()], { actor_groups: [] })).toEqual([]);
    expect(actors([people()], { actor_groups: null })).toEqual([]);
    expect(actors([people()], { actor_groups: [manual] })).toEqual([]);
  });

  test('supports device vehicle candidates on their own place paths without interpreting them as parked', () => {
    const result = actors([bikes()]);
    expect(result).toHaveLength(2);
    expect(result.every(actor => actor.kind === 'ride' && !actor.parked && actor.route.placeId === 'library')).toBe(true);
    const teaching = actors([people(), bikes()], { place_id: 'teaching-9' }, { id: 'teaching-9' });
    expect(teaching).toHaveLength(5);
    expect(new Set(teaching.map(actor => actor.route.placeId))).toEqual(new Set(['teaching-9']));
  });

  test('requires matching place provenance and known geometry, never nearest-place reassignment', () => {
    expect(actors([people()], {}, { id: 'unknown', x: 640, y: 270 })).toEqual([]);
    expect(actors([people()], { place_id: 'unknown' }, { id: 'unknown', x: 640, y: 270 })).toEqual([]);
    expect(actors([people()], { place_id: null })).toEqual([]);
    expect(actors([people()], { place_id: 'teaching-9' })).toEqual([]);
    expect(actors([people({ place_id: 'teaching-9' })])).toEqual([]);
    expect(makeFieldActors(illustration(), null)).toEqual([]);
    expect(actors([people()], {}, { id: 'library', x: 1, y: 1 })).toEqual(actors([people()]));
  });

  test('clears all actors for missing observations and explicit zero instead of retaining defaults', () => {
    expect(makeFieldActors(null, library)).toEqual([]);
    expect(actors([])).toEqual([]);
    expect(actors([people({ metric_value: 0 }), bikes({ metric_value: 0 })])).toEqual([]);
    expect(actors([people({ metric_value: undefined, figure_count: undefined })])).toEqual([]);
    expect(makeFieldActors({ place_id: 'library' }, library)).toEqual([]);
  });

  test.each([NaN, Infinity, -1, '12', 1.5, null, undefined])('rejects invalid uploaded metric %s without glyph fallback', metric_value => {
    expect(actors([people({ metric_value })])).toEqual([]);
  });

  test('requires both the uploaded metric and schematic budget and never converts all BLE identifiers to people', () => {
    const group = people();
    delete group.metric_value;
    expect(actors([group])).toEqual([]);
    expect(actors([{ ...group, figure_count: 0 }])).toEqual([]);
    expect(actors([{ ...group, figure_count: NaN }])).toEqual([]);
    expect(actors([people({ metric_value: 16, figure_count: 3 })])).toHaveLength(3);
    expect(actors([people({ metric_value: 120, figure_count: 7 })])).toHaveLength(7);
    expect(actors([people({ metric_value: 2, figure_count: 3 })])).toHaveLength(2);
    expect(actors([people({ metric_value: 12, figure_count: 0 })])).toEqual([]);
  });

  test.each(['stale', 'unverified', 'last_known', 'update_failed'])('rejects %s at group and illustration level', flag => {
    expect(actors([people({ [flag]: true }), bikes({ [flag]: true })])).toEqual([]);
    expect(actors([people(), bikes()], { [flag]: true })).toEqual([]);
  });

  test('requires positively validated eligibility rather than unknown source quality', () => {
    for (const actor_eligible of [undefined, null, false, 'true', 1]) {
      expect(actors([people({ actor_eligible }), bikes({ actor_eligible })])).toEqual([]);
    }
    expect(actors([null, {}, people({ source: 'unknown' }), bikes({ source: 'sensor' })])).toEqual([]);
  });

  test('keeps people and vehicle layers independent', () => {
    const groups = [people(), bikes()];
    expect(actors(groups)).toHaveLength(5);
    expect(actors(groups, {}, library, { people: false })).toHaveLength(2);
    expect(actors(groups, {}, library, { bikes: false })).toHaveLength(3);
    expect(actors(groups, {}, library, { people: false, bikes: false })).toEqual([]);
    expect(actors(groups, {}, library, { waits: false })).toHaveLength(5);
  });

  test('bounds the whole field scene rather than multiplying each route by uploaded counts', () => {
    const result = actors([people({ metric_value: 150, figure_count: 150 }), bikes({ metric_value: 150, figure_count: 150 })]);
    expect(result).toHaveLength(MAX_FIELD_ACTORS);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(actors([people({ metric_value: 1 })])).toHaveLength(1);
    expect(actors([people({ metric_value: 2 })])).toHaveLength(2);
  });

  test('uses only supplied replay groups and ignores demo minute/scenario/time metadata', () => {
    const live = actors([people(), bikes()]);
    const replay = actors([people()], { replay: true, minute: 1, scenarioId: 'event', cursor: 1 });
    expect(replay).toEqual(live.filter(actor => actor.kind === 'walk'));
    expect(actors([], { replay: true, minute: 1200, scenarioId: 'weekday' })).toEqual([]);
    expect(actors([people()], { minute: 0, scenarioId: 'holiday', now: Date.now() + 1000000 })).toEqual(replay);
    expect(actors([people({ actor_eligible: false })], { replay: true })).toEqual([]);
  });

  test('projects real source eligibility through live refresh, expiry and selected replay coverage', () => {
    const now = Date.parse('2026-11-06T08:00:00Z');
    const sensor = { source: 'sensor', dataset: 'field', protocol: 'campuspulse/3',
      node_id: 'test-node', boot_id: 'test-boot', placement_id: 'test-placement',
      policy_id: 'test-policy', assignment_generation: 1, seq: 1,
      uncertainty_ms: 0, reports_aggregated: 30, aggregation_drops: 0,
      unique_table_overflow: false, quality_flags: [], visible_identifiers: 12,
      duration_ms: 30000, scan_enabled_ms: 30000,
      observed_at: new Date(now - 1000).toISOString(), valid_until: new Date(now + 89000).toISOString() };
    const live = { data: { place: library, sensor }, error: '' };
    const read = extra => fieldIllustration({ now, place: library, live, ...extra });
    expect(makeFieldActors(read(), library)).toHaveLength(3);
    expect(makeFieldActors(read({ now: now + 90000 }), library)).toEqual([]);
    expect(makeFieldActors(read({ live: { ...live, error: 'failed' } }), library)).toEqual([]);
    expect(makeFieldActors(read({ live: { data: { place: library, sensor: null } } }), library)).toEqual([]);
    const history = { data: { records: [sensor] }, error: '' };
    expect(makeFieldActors(read({ mode: 'replay', history, cursor: now - 15000 }), library)).toHaveLength(3);
    expect(makeFieldActors(read({ mode: 'replay', history, cursor: now + 1000 }), library)).toEqual([]);
    expect(makeFieldActors(read({ mode: 'replay', history: { data: { records: [] } }, cursor: now - 15000 }), library)).toEqual([]);
    const times = { observed_at: sensor.observed_at, valid_until: sensor.valid_until };
    const manual = { id: 'test-manual', place_id: 'library', source: 'manual', status: 'active',
      kind: 'parking', parking_min: 20, parking_max: 30, ...times };
    const vehicles = { status: 'candidate_estimate', source: 'ble_rule_inference', model_version: 'test-rules/1',
      reason: null, quality_flags: [], evidence_kind: 'compact', sample_count: 4,
      candidate_count: 4, car_related_count: 1, ecosystem_count: 0, ...times };
    const preferredCard = read({ live: { data: { ...live.data, latest_observation: manual,
      automatic_observations: { vehicles } } } });
    expect(preferredCard.groups.find(group => group.kind === 'bikes').source).toBe('manual');
    const deviceActors = makeFieldActors(preferredCard, library);
    expect(deviceActors).toHaveLength(5);
    expect(deviceActors.filter(actor => actor.kind === 'ride')).toHaveLength(2);
    expect(deviceActors.some(actor => actor.parked)).toBe(false);
  });
});
