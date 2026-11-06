import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { fieldIllustration } from '../../src/campus/field-illustration.js';
import FieldIllustration from '../../src/campus/FieldIllustration.jsx';

const now = Date.parse('2026-10-25T10:00:00Z'), iso = offset => new Date(now + offset).toISOString();
const sensor = (extra = {}) => ({ source: 'sensor', dataset: 'field', protocol: 'campuspulse/3', node_id: 'node', boot_id: 'boot', placement_id: 'placement',
  policy_id: 'policy', assignment_generation: 1, seq: 1, uncertainty_ms: 0, reports_aggregated: 30, aggregation_drops: 0,
  unique_table_overflow: false, quality_flags: [], freshness: 'fresh',
  observed_at: iso(-1000), valid_until: iso(89000), duration_ms: 30000, scan_enabled_ms: 30000, visible_identifiers: 12, ...extra });
const parking = (extra = {}) => ({ id: 'manual', place_id: 'library', source: 'manual', status: 'active', kind: 'parking', parking_min: 2, parking_max: 5, observed_at: iso(-1000), valid_until: iso(89000), ...extra });
const vehicles = (extra = {}) => ({ status: 'candidate_estimate', source: 'ble_rule_inference', model_version: 'vehicle-rules/1', reason: null, quality_flags: [],
  evidence_kind: 'compact', sample_count: 8, candidate_count: 2, car_related_count: 1, ecosystem_count: 1, observed_at: iso(-1000), valid_until: iso(89000), ...extra });
const place = { id: 'library', kind: 'activity', observation_kinds: ['activity', 'parking', 'elevator'] };
const manualWait = (extra = {}) => ({ ...parking(), kind: 'elevator', wait_seconds: 27, ...extra });
const baseline = (extra = {}) => ({ status: 'historical_estimate', source: 'manual_historical_baseline', calibrated: false, wait_seconds: 55.5, sample_count: 5, day_count: 2, observed_at: iso(-2000), valid_until: iso(88000), ...extra });
const state = data => ({ data, error: '', loading: false });
const read = (data, extra = {}) => fieldIllustration({ now, mode: 'field', live: state(data), ...extra });
const render = illustration => renderToStaticMarkup(createElement(FieldIllustration, { illustration, point: { left: 150, top: 50 }, width: 300, height: 210, compact: true, placeName: '图书馆' }));
const reported = extra => sensor({ node_id: 'node', boot_id: 'boot', placement_id: 'placement', protocol: 'campuspulse/3', assignment_generation: 1, policy_id: 'config',
  seq: 1, observed_at: null, valid_until: null, uncertainty_ms: null, received_at: iso(-1000), time_status: 'unknown', freshness: 'unverified',
  reports_aggregated: 30, aggregation_drops: 0, quality_flags: [], unique_table_overflow: false, ...extra });

describe('observation-driven place diagrams', () => {
  test('retains unverified reported identifiers without inventing vehicle evidence', () => {
    const result = read({ place, sensor: null, last_reported_sensor: reported() });
    expect(result.groups).toMatchObject([
      { kind: 'people', source: 'sensor', quantity: '12 个 BLE 标识', figure_count: 3, actor_eligible: false, unverified: true, observed_at: null, valid_until: null },
    ]);
    const html = render(result);
    expect(html).not.toContain('车辆示意');
    expect(html).toContain('时间未知 · 上传');
    expect(html).toContain('17:59:59');
    expect(html).not.toContain('最后观测');
    expect(html).not.toContain('有效观察');
    expect(result.vehicle_status).toContain('车辆待观测');
    expect(read({ place, sensor: sensor({ visible_identifiers: 4 }), last_reported_sensor: reported({ visible_identifiers: 99 }) }).groups[0].quantity).toBe('4 个 BLE 标识');
  });

  test('sensor activity never creates vehicles regardless of parking purpose, layer switches or clock verification', () => {
    const data = { place, sensor: null, last_reported_sensor: reported() };
    for (const extra of [{ latest_observation: parking() }, { latest_observation: parking({ parking_min: 0, parking_max: 0 }) },
      { automatic_observations: { vehicles: vehicles() } }, { automatic_observations: { vehicles: vehicles({ candidate_count: 0, car_related_count: 0 }) } }]) {
      expect(read({ ...data, ...extra }).groups.some(group => group.source === 'illustrative')).toBe(false);
    }
    for (const patch of [{ visible_identifiers: 0 }, { scan_enabled_ms: 0 }, { received_at: iso(1) }, { dataset: 'demo' }]) {
      expect(read({ ...data, last_reported_sensor: reported(patch) }).groups.some(group => group.source === 'illustrative')).toBe(false);
    }
    expect(read({ ...data, last_reported_sensor: null }).groups).toEqual([]);
    expect(read({ ...data, place: { ...place, observation_kinds: ['activity'] } }).groups.map(group => group.kind)).toEqual(['people']);
    expect(read(data, { layers: { people: false } }).groups).toEqual([]);
    expect(read(data, { layers: { bikes: false } }).groups.map(group => group.kind)).toEqual(['people']);
    for (const record of [sensor(), sensor({ visible_identifiers: 10000 }), sensor({ visible_identifiers: 0 }), reported()]) {
      for (const layers of [{}, { people: false }, { bikes: false }]) {
        const result = read({ place, sensor: record }, { layers });
        expect(result.groups.every(group => group.kind === 'people')).toBe(true);
        expect(result.groups.some(group => group.source === 'illustrative')).toBe(false);
      }
    }
    const replay = read(data, { mode: 'replay', cursor: now - 1000, history: state({ records: [] }) });
    expect(replay).toBeNull();
  });

  test('binds the projection to its explicit place and admits only complete fresh V3 activity for actors', () => {
    expect(read({ place, sensor: sensor() })).toMatchObject({ place_id: 'library', groups: [{ actor_eligible: true, metric_value: 12 }] });
    expect(read({ sensor: sensor() }).place_id).toBeNull();
    expect(read({ place, sensor: sensor() }, { place: { ...place, id: 'canteen' } }).place_id).toBe('canteen');
    expect(read({ sensor: sensor({ uncertainty_ms: 250, quality_flags: ['uncertain_clock'] }) }).groups[0].actor_eligible).toBe(true);
    for (const patch of [
      { protocol: undefined }, { node_id: '' }, { boot_id: undefined }, { placement_id: undefined }, { policy_id: '' },
      { assignment_generation: 0 }, { seq: undefined }, { reports_aggregated: undefined }, { uncertainty_ms: undefined },
      { uncertainty_ms: 5001, quality_flags: ['uncertain_clock'] }, { scan_enabled_ms: 29000 }, { aggregation_drops: 1 },
      { unique_table_overflow: true }, { max_addresses: 12 }, { quality_flags: undefined },
      ...['partial_window', 'scan_gap', 'callback_loss', 'aggregation_loss', 'identifier_overflow', 'unknown'].map(flag => ({ quality_flags: [flag] })),
      { freshness: 'unverified' }, { freshness: 'stale' }, { time_status: 'unknown' }, { time_status: 'uncertain' },
      { valid_until: iso(-1) },
    ]) {
      const result = read({ sensor: sensor(patch) });
      expect(result.groups[0].actor_eligible, JSON.stringify(patch)).toBe(false);
      expect(result.groups[0].quantity).toBe('12 个 BLE 标识');
    }
    expect(read({ sensor: sensor({ observed_at: iso(1) }) })).toBeNull();
    expect(read({ sensor: sensor(), last_known: { sensor: 'source_unavailable' } }).groups[0].actor_eligible).toBe(false);
    const data = { sensor: sensor() };
    expect(read(data, { live: { data, error: 'read failed' } }).groups[0].actor_eligible).toBe(false);
  });

  test('keeps manual and limited candidate cards while requiring fresh complete candidate metadata for actors', () => {
    expect(read({ latest_observation: parking() }).groups[0].actor_eligible).toBe(false);
    const candidates = extra => read({ automatic_observations: { vehicles: vehicles(extra) } });
    expect(candidates().groups.every(group => group.actor_eligible)).toBe(true);
    expect(candidates({ candidate_count: 0, car_related_count: 0 }).groups[0]).toMatchObject({ actor_eligible: true, figure_count: 0, metric_value: 0 });
    for (const patch of [{ model_version: undefined }, { reason: 'limited' }, { quality_flags: undefined },
      { quality_flags: ['scan_gap'] }, { quality_flags: ['uncertain_clock'] }, { valid_until: iso(-1) },
      { freshness: 'unverified' }, { unverified: true }, { time_status: 'unknown' }]) {
      expect(candidates(patch).groups.every(group => group.actor_eligible === false)).toBe(true);
    }
    const data = { automatic_observations: { vehicles: vehicles() }, last_known: { vehicles: 'source_unavailable' } };
    expect(read(data).groups.every(group => !group.actor_eligible)).toBe(true);
    expect(read(data, { live: { data, error: 'read failed' } }).groups.every(group => !group.actor_eligible)).toBe(true);
    expect(candidates({ observed_at: iso(1) })).toBeNull();
  });

  test('projects uploaded candidates independently from manual parking card preference', () => {
    const data = { place, sensor: sensor(), latest_observation: parking(), automatic_observations: { vehicles: vehicles() } };
    const result = read(data);
    expect(result.groups.map(group => [group.kind, group.source])).toEqual([['people', 'sensor'], ['bikes', 'manual'], ['cars', 'candidate']]);
    expect(result.actor_groups.map(group => [group.kind, group.source, group.actor_eligible])).toEqual([
      ['people', 'sensor', true], ['bikes', 'candidate', true], ['cars', 'candidate', true],
    ]);
    expect(result.actor_groups[1]).toMatchObject({ metric_value: 2, quantity: '2 个候选标识' });
    for (const patch of [{ valid_until: iso(-1) }, { quality_flags: ['scan_gap'] }]) {
      const limited = read({ ...data, automatic_observations: { vehicles: vehicles(patch) } });
      expect(limited.groups.find(group => group.kind === 'bikes').source).toBe('manual');
      expect(limited.actor_groups.filter(group => group.source === 'candidate').every(group => !group.actor_eligible)).toBe(true);
    }
    expect(read({ ...data, automatic_observations: undefined }).actor_groups.map(group => group.kind)).toEqual(['people']);
    expect(read({ place, latest_observation: parking() }).actor_groups).toEqual([]);
    expect(read(data, { layers: { bikes: false } }).actor_groups.map(group => group.kind)).toEqual(['people']);
    expect(read({ ...data, automatic_observations: { vehicles: vehicles({ candidate_count: 0, car_related_count: 0 }) } }).actor_groups[1]).toMatchObject({ metric_value: 0, figure_count: 0 });
  });
  test('uses bounded schematic budgets, explicitly keeps physical people unknown, and never bands a saturated table', () => {
    const bands = [1, 12, 19, 20, 64, 99, 100, 10000].map(visible_identifiers => read({ sensor: sensor({ visible_identifiers }) }));
    expect(bands.map(result => result.figure_count)).toEqual([3, 3, 3, 5, 5, 5, 7, 7]);
    expect(bands[0].groups[0]).toMatchObject({ kind: 'people', band: 1, source: 'sensor' });
    expect(bands[0].groups[0].label).toContain('人数未知');
    const capped = read({ sensor: sensor({ visible_identifiers: 16, unique_table_overflow: true }) });
    expect(capped.groups[0]).toMatchObject({ band: null, saturated: true, figure_count: 5, quantity: '16 个 BLE 标识' });
    expect(capped.groups[0].label).toBe('16 个 BLE 标识 · 已达采集上限 · 人数未知');
    expect(capped.groups[0].label).not.toContain('1 档');
    expect(read({ sensor: sensor({ visible_identifiers: 16, max_addresses: 16 }) }).groups[0].saturated).toBe(true);
  });

  test.each([
    null, sensor({ dataset: 'demo' }), sensor({ visible_identifiers: -1 }), sensor({ visible_identifiers: '12' }),
    sensor({ observed_at: iso(1) }), sensor({ scan_enabled_ms: 0 }), sensor({ scan_enabled_ms: 31000 }),
    sensor({ valid_until: 'invalid' }), sensor({ observed_at: iso(-1000), valid_until: iso(-1000) }),
  ])('rejects missing, future and malformed sensor evidence %#', record => {
    expect(read({ sensor: record })).toBeNull();
  });

  test('retains expired sensor, parking and automatic observations without extending their expiry', () => {
    const expired = { observed_at: iso(-60000), valid_until: iso(-1) };
    const result = read({ sensor: sensor(expired), latest_observation: parking(expired), automatic_observations: { vehicles: vehicles(expired), elevator: baseline(expired) } }, { place });
    expect(result.groups).toHaveLength(3);
    expect(result.groups.every(group => group.stale && group.observed_at === expired.observed_at && group.valid_until === expired.valid_until)).toBe(true);
    expect(result.elevator).toMatchObject({ status: 'historical', wait_seconds: 55.5, stale: true, ...expired });
    const html = render(result);
    expect(html).toContain('最后观测');
    expect(html).toContain('已过期');
    expect(html).toContain('10/25 17:59:00');
    expect(html).toContain('people retained');
    expect(html).toContain('dateTime="2026-10-25T09:59:00.000Z"');
    expect(html).toContain('<strong class="field-illustration-quantity">12 个 BLE 标识</strong>');
    expect(html).toContain('<strong class="field-illustration-quantity">2–5 辆 · 人工</strong>');
  });

  test('retains live diagrams on read failure and marks source-specific last-known results', () => {
    const data = { sensor: sensor(), latest_observation: parking(), last_known: { sensor: 'source_unavailable' } };
    expect(read(data).groups[0]).toMatchObject({ stale: false, last_known: 'source_unavailable' });
    const result = read(data, { live: { data, error: 'unavailable' } });
    expect(result.update_failed).toBe(true);
    expect(result.figure_count).toBe(5);
    expect(render(result)).toContain('role="status">更新失败</p>');
    expect(render(result)).toContain('data-last-known="true"');
    expect(read(data, { live: { data: null, error: 'unavailable' } })).toBeNull();
  });

  test('respects mode, independent layers and explicit diagram toggle', () => {
    const data = { sensor: sensor(), latest_observation: parking(), automatic_observations: { vehicles: vehicles() } };
    expect(read(data, { enabled: false })).toBeNull();
    expect(read(data, { mode: 'demo' })).toBeNull();
    expect(read(data, { layers: { people: false, bikes: false } })).toBeNull();
    expect(read(data, { layers: { people: false } }).groups.map(item => item.kind)).toEqual(['bikes', 'cars']);
    expect(read(data, { layers: { bikes: false } }).groups.map(item => item.kind)).toEqual(['people']);
  });

  test('renders manual parking ranges as observed and rejects malformed ranges', () => {
    expect(read({ latest_observation: parking({ parking_min: 5, parking_max: 2 }) })).toBeNull();
    expect(read({ latest_observation: parking({ observed_at: iso(1000) }) })).toBeNull();
    expect(read({ latest_observation: parking({ parking_min: 0, parking_max: 20 }) }).groups[0]).toMatchObject({ figure_count: 0, label: '人工停车观察 0–20 辆' });
    expect(read({ latest_observation: parking({ parking_min: 100, parking_max: 200 }) }).figure_count).toBe(2);
  });

  test('valid new zero values replace positive glyphs without treating missing sources as zero', () => {
    const result = read({ sensor: sensor({ visible_identifiers: 0 }), latest_observation: parking({ parking_min: 0, parking_max: 0 }), automatic_observations: { vehicles: vehicles() } });
    expect(result.groups.map(group => [group.kind, group.figure_count, group.source])).toEqual([['people', 0, 'sensor'], ['bikes', 0, 'manual'], ['cars', 2, 'candidate']]);
    expect(result.groups[1].label).toBe('人工停车观察 0–0 辆');
    expect(result.groups[0].quantity).toBe('0 个 BLE 标识');
    expect(result.groups[1].quantity).toBe('0–0 辆 · 人工');
    expect(render(result)).toContain('<strong class="field-illustration-quantity">0 个 BLE 标识</strong>');
    const missing = read({ place, sensor: null });
    expect(missing.groups).toEqual([]);
    expect(missing.vehicle_status).toContain('车辆待观测');
    expect(missing.elevator).not.toHaveProperty('wait_seconds');
  });

  test('keeps candidates separate, requires valid evidence, and prioritizes source freshness before manual preference', () => {
    const readVehicles = extra => read({ automatic_observations: { vehicles: vehicles(extra) } });
    expect(readVehicles({ candidate_count: null, status: 'unavailable' })).toBeNull();
    expect(readVehicles({ evidence_kind: 'none' })).toBeNull();
    expect(readVehicles({ candidate_count: -1 })).toBeNull();
    expect(readVehicles({ observed_at: iso(1) })).toBeNull();
    expect(readVehicles({ candidate_count: 0, car_related_count: 0, ecosystem_count: 10 }).groups).toMatchObject([{ kind: 'bikes', figure_count: 0, source: 'candidate' }]);
    const fresh = read({ latest_observation: parking(), automatic_observations: { vehicles: vehicles({ valid_until: iso(-1) }) } });
    expect(fresh.groups[0].source).toBe('manual');
    const expired = read({ latest_observation: parking({ valid_until: iso(-1) }), automatic_observations: { vehicles: vehicles() } });
    expect(expired.groups[0].source).toBe('candidate');
    const retained = read({ latest_observation: parking(), automatic_observations: { vehicles: vehicles() }, last_known: { parking: 'source_unavailable' } });
    expect(retained.groups[0].source).toBe('candidate');
    expect(fresh.groups.map(group => group.kind)).toEqual(['bikes', 'cars']);
  });

  test('shows each real observed quantity prominently, without changing fixed schematic glyph budgets', () => {
    const result = read({ sensor: sensor({ visible_identifiers: 16, unique_table_overflow: true }), automatic_observations: { vehicles: vehicles({ candidate_count: 37, car_related_count: 9 }) } });
    expect(result.groups.map(group => [group.quantity, group.figure_count])).toEqual([['16 个 BLE 标识', 5], ['37 个候选标识', 2], ['9 个候选标识', 2]]);
    const html = render(result);
    for (const quantity of ['16 个 BLE 标识', '37 个候选标识', '9 个候选标识']) expect(html).toContain(`<strong class="field-illustration-quantity">${quantity}</strong>`);
    expect(html).toContain('<small>已达上限</small>');
    expect(html).not.toContain('16 人');
    const noCandidates = read({ automatic_observations: { vehicles: vehicles({ candidate_count: 0, car_related_count: 0 }) } });
    expect(noCandidates.groups[0]).toMatchObject({ quantity: '0 个候选标识', figure_count: 0 });
    expect(render(noCandidates)).toContain('<strong class="field-illustration-quantity">0 个候选标识</strong>');
  });

  test('selects elevator sources independently by freshness, then direct manual precedence, retaining expired last values', () => {
    const data = { latest_observations: { parking: null, elevator: manualWait() }, automatic_observations: { elevator: baseline() } };
    expect(read(data, { place }).elevator).toMatchObject({ status: 'manual', wait_seconds: 27 });
    const staleManual = { ...data, latest_observations: { elevator: manualWait({ valid_until: iso(-1) }) } };
    expect(read(staleManual, { place }).elevator).toMatchObject({ status: 'historical', wait_seconds: 55.5 });
    expect(read({ ...data, last_known: { elevator: 'source_unavailable' } }, { place }).elevator.status).toBe('historical');
    expect(read({ ...staleManual, automatic_observations: undefined }, { place }).elevator).toMatchObject({ status: 'manual', wait_seconds: 27, stale: true });
    expect(read({ ...data, latest_observations: { elevator: manualWait({ observed_at: iso(1000) }) } }, { place }).elevator.status).toBe('historical');
    expect(read({ place, automatic_observations: { elevator: baseline({ valid_until: iso(-1) }) } }).elevator).toMatchObject({ status: 'historical', wait_seconds: 55.5, stale: true });
  });

  test('shows purpose waiting states without fabricated wait seconds, and preserves real measured zero', () => {
    const result = read({ place });
    expect(result.elevator).toMatchObject({ status: 'waiting', label: '候梯样本不足 / 待观测' });
    expect(result.elevator).not.toHaveProperty('wait_seconds');
    expect(read({ place, automatic_observations: { elevator: baseline({ observed_at: iso(1000) }) } }).elevator.status).toBe('waiting');
    expect(read({ place, automatic_observations: { elevator: baseline({ wait_seconds: NaN }) } }).elevator.status).toBe('waiting');
    expect(read({ place }, { layers: { people: false, bikes: false, waits: false } })).toBeNull();
    expect(render(result)).not.toContain('0 秒');
    expect(read({ place, latest_observations: { elevator: manualWait({ wait_seconds: 0 }) } }).elevator.label).toBe('已完成候梯 0 秒 · 人工');
    expect(read({ place, automatic_observations: { elevator: baseline({ wait_seconds: 0 }) } }).elevator.label).toBe('候梯参考约 0 秒 · 历史样本');
  });

  test('replay only uses cursor-covering sensors and then-valid manual observations, excluding all live snapshots and inference', () => {
    const current = { sensor: sensor({ visible_identifiers: 100 }), latest_observations: { elevator: manualWait() }, automatic_observations: { vehicles: vehicles(), elevator: baseline() }, last_known: { sensor: 'read_failed' } };
    const records = [sensor({ observed_at: iso(-60000), valid_until: iso(-1), visible_identifiers: 12 }), parking({ observed_at: iso(-65000), valid_until: iso(-55000) }), manualWait({ observed_at: iso(-65000), valid_until: iso(-55000), wait_seconds: 19 })];
    const at = cursor => read(current, { place, mode: 'replay', cursor, history: state({ records }) });
    expect(at(now - 60000).groups.map(group => [group.kind, group.source, group.figure_count])).toEqual([['people', 'sensor', 3], ['bikes', 'manual', 2]]);
    expect(at(now - 60000).groups[0]).toMatchObject({ stale: false, last_known: undefined, actor_eligible: true });
    expect(at(now - 60000).groups.map(group => group.quantity)).toEqual(['12 个 BLE 标识', '2–5 辆 · 人工']);
    expect(render(at(now - 60000))).toContain('<strong class="field-illustration-quantity">12 个 BLE 标识</strong>');
    expect(at(now - 60000).elevator).toMatchObject({ status: 'manual', wait_seconds: 19 });
    expect(at(now - 30000).groups).toEqual([]);
    expect(at(now - 30000).elevator.status).toBe('waiting');
    expect(at(now - 30000).elevator).not.toHaveProperty('wait_seconds');
    expect(read(current, { mode: 'replay', cursor: now - 60000, history: { data: { records }, error: 'failure' } })).toBeNull();
  });

  test('replay actor eligibility requires captured complete windows even when their live expiry has passed', () => {
    const captured = sensor({ observed_at: iso(-60000), valid_until: iso(-1), freshness: 'stale' });
    const replay = (record, cursor = now - 60000) => read({}, { mode: 'replay', cursor, place, history: state({ records: [record] }) });
    expect(replay(captured).groups[0]).toMatchObject({ actor_eligible: true, stale: false });
    for (const patch of [{ scan_enabled_ms: 29000 }, { aggregation_drops: 1 }, { quality_flags: ['callback_loss'] },
      { unique_table_overflow: true }, { uncertainty_ms: undefined }, { freshness: 'unverified' }]) {
      expect(replay({ ...captured, ...patch }).groups[0].actor_eligible).toBe(false);
    }
    expect(replay(captured, now - 60001 - captured.duration_ms).groups).toEqual([]);
    expect(replay(captured, now - 59999).groups).toEqual([]);
  });

  test('renders a concise bounded card with quantities/times and keeps schematic explanation accessible', () => {
    const illustration = read({ sensor: sensor(), latest_observation: parking() });
    const html = render(illustration);
    expect(html).toContain('5 个示意图形，非实际人数或车辆数');
    expect(html).not.toContain('<p>');
    expect(html).not.toContain('<small>广播活动量级');
    expect(html).not.toContain('<small>人工停车观察');
    expect(html).toContain('最后观测');
    const bounds = html.match(/style="[^"]*top:([\d.]+)px;[^"]*max-height:([\d.]+)px/);
    expect(bounds).not.toBeNull();
    expect(Number(bounds[2])).toBeGreaterThan(0);
    expect(Number(bounds[1]) + Number(bounds[2])).toBeLessThanOrEqual(210);
    expect(html).toContain('data-source="manual"');
    expect(html).not.toContain('trajectory');
    expect(renderToStaticMarkup(createElement(FieldIllustration, { illustration, point: { left: -1, top: 50 }, width: 300, height: 190 }))).toBe('');
  });
});
