import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { fieldIllustration } from '../../src/campus/field-illustration.js';
import FieldIllustration from '../../src/campus/FieldIllustration.jsx';

const now = Date.parse('2026-10-25T10:00:00Z'), iso = offset => new Date(now + offset).toISOString();
const sensor = (extra = {}) => ({ source: 'sensor', dataset: 'field', observed_at: iso(-1000), valid_until: iso(89000), duration_ms: 30000, scan_enabled_ms: 30000, visible_identifiers: 12, ...extra });
const parking = (extra = {}) => ({ id: 'manual', place_id: 'library', source: 'manual', status: 'active', kind: 'parking', parking_min: 2, parking_max: 5, observed_at: iso(-1000), valid_until: iso(89000), ...extra });
const vehicles = (extra = {}) => ({ status: 'candidate_estimate', source: 'ble_rule_inference', evidence_kind: 'compact', sample_count: 8, candidate_count: 2, car_related_count: 1, ecosystem_count: 1, observed_at: iso(-1000), valid_until: iso(89000), ...extra });
const place = { id: 'library', kind: 'activity', observation_kinds: ['activity', 'parking', 'elevator'] };
const manualWait = (extra = {}) => ({ ...parking(), kind: 'elevator', wait_seconds: 27, ...extra });
const baseline = (extra = {}) => ({ status: 'historical_estimate', source: 'manual_historical_baseline', calibrated: false, wait_seconds: 55.5, sample_count: 5, day_count: 2, observed_at: iso(-2000), valid_until: iso(88000), ...extra });
const state = data => ({ data, error: '', loading: false });
const read = (data, extra = {}) => fieldIllustration({ now, mode: 'field', live: state(data), ...extra });

describe('observation-driven place diagrams', () => {
  test('uses a bounded drawing budget per radio band, never one person per identifier', () => {
    const bands = [1, 12, 19, 20, 64, 99, 100, 10000].map(visible_identifiers => read({ sensor: sensor({ visible_identifiers }) }));
    expect(bands.map(result => result.figure_count)).toEqual([3, 3, 3, 5, 5, 5, 7, 7]);
    expect(bands[0].groups[0]).toMatchObject({ kind: 'people', band: 1, source: 'sensor', label: '广播活动量级示意 1 档' });
  });

  test.each([
    null, sensor({ dataset: 'demo' }), sensor({ visible_identifiers: 0 }), sensor({ visible_identifiers: -1 }),
    sensor({ visible_identifiers: '12' }), sensor({ valid_until: iso(-1) }), sensor({ observed_at: iso(1) }),
    sensor({ scan_enabled_ms: 0 }), sensor({ scan_enabled_ms: 31000 }), sensor({ valid_until: 'invalid' }),
  ])('does not draw people for missing, zero, stale or malformed sensor evidence %#', record => {
    expect(read({ sensor: record })).toBeNull();
  });

  test('respects the explicit toggle, source mode, independent layers and failed reads', () => {
    const data = { sensor: sensor(), latest_observation: parking(), automatic_observations: { vehicles: vehicles() } };
    expect(read(data, { enabled: false })).toBeNull();
    expect(read(data, { mode: 'demo' })).toBeNull();
    expect(read(data, { live: { data, error: 'unavailable' } })).toBeNull();
    expect(read(data, { layers: { people: false, bikes: false } })).toBeNull();
    expect(read(data, { layers: { people: false } }).groups.map(item => item.kind)).toEqual(['bikes', 'cars']);
    expect(read(data, { layers: { bikes: false } }).groups.map(item => item.kind)).toEqual(['people']);
  });

  test('draws manual parked-bike diagrams only when the range confirms a positive minimum', () => {
    expect(read({ latest_observation: parking({ parking_min: 0, parking_max: 0 }) })).toBeNull();
    expect(read({ latest_observation: parking({ parking_min: 0, parking_max: 20 }) })).toBeNull();
    expect(read({ latest_observation: parking({ parking_min: 5, parking_max: 2 }) })).toBeNull();
    expect(read({ latest_observation: parking({ valid_until: iso(-1) }) })).toBeNull();
    const small = read({ latest_observation: parking({ parking_min: 1 }) });
    const large = read({ latest_observation: parking({ parking_min: 100, parking_max: 200 }) });
    expect(small.figure_count).toBe(2);
    expect(large.figure_count).toBe(2);
    expect(small.groups[0]).toMatchObject({ kind: 'bikes', source: 'manual', label: '人工停车观察 1–5 辆' });
  });

  test('keeps car/e-bike candidates separate and does not draw ecosystem modules as vehicles', () => {
    const readVehicles = extra => read({ automatic_observations: { vehicles: vehicles(extra) } });
    expect(readVehicles({ candidate_count: 0, car_related_count: 0, ecosystem_count: 10 })).toBeNull();
    expect(readVehicles({ candidate_count: null, status: 'unavailable' })).toBeNull();
    expect(readVehicles({ evidence_kind: 'none' })).toBeNull();
    expect(readVehicles({ valid_until: iso(-1) })).toBeNull();
    expect(readVehicles({ candidate_count: -1 })).toBeNull();
    const result = readVehicles({ candidate_count: 100, car_related_count: 1 });
    expect(result.groups).toMatchObject([{ kind: 'bikes', figure_count: 2, source: 'candidate' }, { kind: 'cars', figure_count: 2, source: 'candidate' }]);
    expect(result.figure_count).toBe(4);
  });

  test('does not add manual and automatic e-bike figures together', () => {
    const result = read({ latest_observation: parking(), automatic_observations: { vehicles: vehicles() } });
    expect(result.groups.map(group => [group.kind, group.source])).toEqual([['bikes', 'manual'], ['cars', 'candidate']]);
  });

  test('prefers independently fresh completed manual elevator waits over the historical baseline', () => {
    const data = { latest_observations: { parking: null, elevator: manualWait() }, automatic_observations: { elevator: baseline() } };
    expect(read(data, { place }).elevator).toMatchObject({ status: 'manual', wait_seconds: 27, label: '已完成候梯 27 秒 · 人工' });
    const staleManual = { ...data, latest_observations: { elevator: manualWait({ valid_until: iso(-1) }) } };
    expect(read(staleManual, { place }).elevator).toMatchObject({ status: 'historical', wait_seconds: 55.5 });
    const futureManual = { ...data, latest_observations: { elevator: manualWait({ observed_at: iso(1000) }) } };
    expect(read(futureManual, { place }).elevator.status).toBe('historical');
    expect(read({ ...data, automatic_observations: { elevator: baseline({ valid_until: iso(-1) }) } }, { place }).elevator.status).toBe('manual');
  });

  test('shows enabled-purpose waiting states without zero vehicle figures or fabricated wait seconds', () => {
    const result = read({ place, sensor: null });
    expect(result.groups).toEqual([]);
    expect(result.vehicle_status).toContain('车辆待观测');
    expect(result.elevator).toMatchObject({ status: 'waiting', label: '候梯样本不足 / 待观测' });
    expect(result.elevator).not.toHaveProperty('wait_seconds');
    const stale = read({ place, automatic_observations: { elevator: baseline({ valid_until: iso(-1) }) } });
    expect(stale.elevator.status).toBe('waiting');
    expect(read({ place, automatic_observations: { elevator: baseline({ observed_at: iso(1000) }) } }).elevator.status).toBe('waiting');
    expect(read({ place, automatic_observations: { elevator: baseline({ wait_seconds: NaN }) } }).elevator.status).toBe('waiting');
    expect(read({ place }, { layers: { people: false, bikes: false, waits: false } })).toBeNull();
    const html = renderToStaticMarkup(createElement(FieldIllustration, { illustration: result, point: { left: 150, top: 50 }, width: 300, height: 220, placeName: '图书馆' }));
    expect(html).toContain('观测状态');
    expect(html).toContain('候梯样本不足 / 待观测');
    expect(html).not.toContain('0 秒');
    expect(html).not.toContain('field-illustration-glyphs');
  });

  test('preserves a measured zero wait while keeping missing waits unknown', () => {
    expect(read({ place, latest_observations: { elevator: manualWait({ wait_seconds: 0 }) } }).elevator.label).toBe('已完成候梯 0 秒 · 人工');
    expect(read({ place, automatic_observations: { elevator: baseline({ wait_seconds: 0 }) } }).elevator.label).toBe('候梯参考约 0 秒 · 历史样本');
  });

  test('replays only then-valid manual elevator measurements and never injects the current historical baseline', () => {
    const records = [manualWait({ observed_at: iso(-65000), valid_until: iso(-55000), wait_seconds: 19 })];
    const data = { place, latest_observations: { elevator: manualWait() }, automatic_observations: { elevator: baseline() } };
    const at = cursor => read(data, { place, mode: 'replay', cursor, history: state({ records }) });
    expect(at(now - 60000).elevator).toMatchObject({ status: 'manual', wait_seconds: 19 });
    expect(at(now - 30000).elevator.status).toBe('waiting');
    expect(at(now - 30000).elevator).not.toHaveProperty('wait_seconds');
  });

  test('pins replay to captured sensor coverage and valid manual records, excluding current automatic results', () => {
    const current = { sensor: sensor({ visible_identifiers: 100 }), automatic_observations: { vehicles: vehicles() } };
    const records = [sensor({ observed_at: iso(-60000), valid_until: iso(30000), visible_identifiers: 12 }), parking({ observed_at: iso(-65000), valid_until: iso(-55000) })];
    const result = read(current, { mode: 'replay', cursor: now - 60000, history: state({ records }) });
    expect(result.replay).toBe(true);
    expect(result.groups.map(group => [group.kind, group.source, group.figure_count])).toEqual([['people', 'sensor', 3], ['bikes', 'manual', 2]]);
    expect(read(current, { mode: 'replay', cursor: now - 30000, history: state({ records }) })).toBeNull();
    expect(read(current, { mode: 'replay', cursor: now - 60000, history: { data: { records }, error: 'failure' } })).toBeNull();
  });

  test('renders labelled glyphs as one anchored diagram without fabricated individual coordinates', () => {
    const illustration = read({ sensor: sensor(), latest_observation: parking() });
    const html = renderToStaticMarkup(createElement(FieldIllustration, { illustration, point: { left: 150, top: 50 }, width: 300, height: 190, compact: true, placeName: '图书馆' }));
    expect(html).toContain('5 个示意图形，非实际人数或车辆数');
    expect(html).toContain('位置不代表个体定位');
    expect(html).toContain('广播活动量级示意 1 档');
    expect(html).toContain('data-source="manual"');
    expect(html).not.toContain('trajectory');
    expect(renderToStaticMarkup(createElement(FieldIllustration, { illustration, point: { left: -1, top: 50 }, width: 300, height: 190 }))).toBe('');
  });
});
