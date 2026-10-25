import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import AutomaticObservations from '../../src/campus/AutomaticObservations.jsx';
import FieldDataPanel from '../../src/campus/FieldDataPanel.jsx';
import { normalizeFieldResponse } from '../../src/campus/field-data.js';

const now = Date.parse('2026-10-25T10:00:00Z');
const iso = offset => new Date(now + offset).toISOString();
const place = { id: 'library', name: '图书馆', kind: 'activity' };
const automatic = () => ({
  vehicles: { status: 'candidate_estimate', source: 'ble_rule_inference', model_version: 'vehicle-rules-v1', observed_at: iso(-30_000), valid_until: iso(30_000), candidate_count: 2, car_related_count: 1, ecosystem_count: 3, sample_count: 10, reason: null, quality_flags: [], evidence_kind: 'compact' },
  elevator: { status: 'historical_estimate', source: 'manual_historical_baseline', model_version: 'manual-quantiles-v1', wait_seconds: 42, range_seconds: { lower: 20, upper: 70 }, sample_count: 8, day_count: 3, observed_at: iso(-120_000), valid_until: iso(-1), reason: null, calibrated: false },
});
const normalize = value => normalizeFieldResponse({ place, as_of: iso(0), sensor: null, latest_observation: null, ...(value !== undefined ? { automatic_observations: value } : {}) }, { placeId: place.id, mode: 'live' });
const render = value => renderToStaticMarkup(createElement(AutomaticObservations, { observations: value, now }));
const state = data => ({ data, loading: false, error: '' });

describe('optional public automatic observations', () => {
  test('accepts older API summaries and never fabricates automatic results', () => {
    expect(normalize().automatic_observations).toBeUndefined();
    expect(render(undefined)).toBe('');
  });

  test('keeps candidates and historical waits separate with independent expiry and provenance', () => {
    const data = normalize(automatic());
    const html = render(data.automatic_observations);
    expect(html).toContain('2 个电动车相关候选标识');
    expect(html).toContain('汽车相关候选 1');
    expect(html).toContain('车辆生态相关候选 3');
    expect(html).toContain('不等于车辆数量、停车占用或人员数量');
    expect(html).toContain('约 42 秒候梯参考');
    expect(html).toContain('历史已完成的人工候梯样本中位数');
    expect(html).toContain('不是当前实测或实时剩余等待预测');
    expect(html).toContain('8 次样本 / 3 天');
    expect(html).toContain('vehicle-rules-v1');
    expect(html).toContain('manual-quantiles-v1');
    expect(html.match(/field-data-freshness fresh/g)).toHaveLength(1);
    expect(html.match(/field-data-freshness stale/g)).toHaveLength(1);
  });

  test('uses unavailable reasons and never converts missing evidence to zero', () => {
    const value = automatic();
    value.vehicles = { ...value.vehicles, status: 'unavailable', observed_at: null, valid_until: null, candidate_count: null, car_related_count: null, ecosystem_count: null, sample_count: 0, reason: 'vehicle_features_not_reported', evidence_kind: 'none' };
    value.elevator = { ...value.elevator, status: 'unavailable', observed_at: null, valid_until: null, wait_seconds: null, range_seconds: null, sample_count: 0, day_count: 0, reason: 'insufficient_samples' };
    const html = render(normalize(value).automatic_observations);
    expect(html).toContain('设备尚未上报识别所需的广播特征');
    expect(html).toContain('可比较的历史样本不足');
    expect(html.match(/缺失不表示零/g)).toHaveLength(2);
    expect(html).not.toContain('0 个电动车相关候选标识');
    expect(html).not.toContain('约 0 秒候梯参考');
    expect(html).not.toContain('field-data-value');
  });

  test('permits an actual zero candidate result only with evidence and keeps the other source visible', () => {
    const value = automatic();
    value.vehicles.candidate_count = 0;
    const html = render(normalize(value).automatic_observations);
    expect(html).toContain('0 个电动车相关候选标识');
    expect(html).toContain('10 个特征样本');
    expect(html).toContain('约 42 秒候梯参考');
    expect(html).toContain('最近一个节点采集窗口内');
  });

  test('retains fractional quantile precision and rounds only displayed seconds', () => {
    const value = automatic();
    value.elevator.wait_seconds = 42.567;
    value.elevator.range_seconds = { lower: 20.25, upper: 70.125 };
    const data = normalize(value);
    expect(data.automatic_observations.elevator.wait_seconds).toBe(42.567);
    const html = render(data.automatic_observations);
    expect(html).toContain('约 42.6 秒候梯参考');
    expect(html).toContain('20.3–70.1 秒');
  });

  test.each([
    ['summaries_pending', '仍在等待配套地址摘要'],
    ['stale_sensor_window', '最近的采集窗口已过期'],
    ['invalid_vehicle_evidence', '识别特征未通过完整性检查'],
    ['inconsistent_vehicle_evidence', '识别特征与采集窗口尚未对齐'],
    ['no_usable_vehicle_features', '暂无成功解析且可用于识别的广播特征'],
  ])('explains %s without implying zero candidates', (reason, label) => {
    const value = automatic();
    value.vehicles = { ...value.vehicles, status: 'unavailable', candidate_count: null, reason };
    const html = render(normalize(value).automatic_observations);
    expect(html).toContain(label);
    expect(html).not.toContain('0 个电动车相关候选标识');
  });

  test('explains that incomplete reception can hide clues and exclusions', () => {
    const value = automatic();
    value.vehicles.quality_flags = ['incomplete_vehicle_evidence', 'unusable_vehicle_features'];
    const html = render(normalize(value).automatic_observations);
    expect(html).toContain('广播证据不完整，正面线索和排除线索均可能遗漏');
    expect(html).toContain('部分广播特征不可用于识别');
  });

  test('does not put current automatic results into a selected historical instant', () => {
    const session = { now, live: state(normalize(automatic())), history: state({ records: [], from: iso(-60_000), to: iso(0) }), refresh() {} };
    const html = renderToStaticMarkup(createElement(FieldDataPanel, { place, session, mode: 'replay', cursor: now - 10_000 }));
    expect(html).toContain('自动分析尚未归档到此历史时间轴');
    expect(html).not.toContain('2 个电动车相关候选标识');
    expect(html).not.toContain('约 42 秒候梯参考');
  });

  test.each([
    value => { value.vehicles.source = 'demo'; },
    value => { value.vehicles.candidate_count = -1; },
    value => { value.vehicles.candidate_count = null; },
    value => { value.vehicles.evidence_kind = 'none'; },
    value => { value.vehicles.valid_until = value.vehicles.observed_at; },
    value => { value.vehicles.quality_flags = [1]; },
    value => { value.elevator.source = 'sensor'; },
    value => { value.elevator.calibrated = true; },
    value => { value.elevator.wait_seconds = 100; },
    value => { value.elevator.wait_seconds = NaN; },
    value => { value.elevator.range_seconds.upper = 7200.1; },
    value => { value.elevator.range_seconds = { lower: 70, upper: 20 }; },
    value => { value.elevator.status = 'unavailable'; },
  ])('rejects malformed or contradictory inference without publishing it %#', mutate => {
    const value = automatic(); mutate(value);
    expect(() => normalize(value)).toThrow('无效记录');
  });
});
