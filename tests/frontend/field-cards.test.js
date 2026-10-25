import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import FieldDataPanel from '../../src/campus/FieldDataPanel.jsx';
import FieldTimeline from '../../src/campus/FieldTimeline.jsx';
import { normalizeFieldResponse } from '../../src/campus/field-data.js';

const now = Date.parse('2026-10-25T10:00:00.000Z');
const iso = offset => new Date(now + offset).toISOString();
const place = { id: 'mixed', name: '综合观察点', kind: 'activity', observation_kinds: ['activity', 'parking', 'elevator'] };
const parking = { id: 'parking-1', place_id: place.id, source: 'manual', status: 'active', kind: 'parking', parking_min: 3, parking_max: 5, observed_at: iso(-120_000), valid_until: iso(-10_000) };
const elevator = { id: 'elevator-1', place_id: place.id, source: 'manual', status: 'active', kind: 'elevator', wait_seconds: 42, observed_at: iso(-30_000), valid_until: iso(10_000) };
const sensor = { source: 'sensor', dataset: 'field', node_id: 'node-1', boot_id: 'boot-1', seq: 1, observed_at: iso(-20_000), valid_until: iso(30_000), duration_ms: 30_000, scan_enabled_ms: 30_000, reports_aggregated: 7, visible_identifiers: 2, uncertainty_ms: 0, aggregation_drops: 0, quality_flags: [], unique_table_overflow: false };
const state = data => ({ data, error: '', loading: false });
const summary = () => normalizeFieldResponse({ place, as_of: iso(0), sensor, latest_observation: elevator, latest_observations: { parking, elevator } }, { placeId: place.id, mode: 'live' });
const history = observations => normalizeFieldResponse({ place_id: place.id, from: iso(-120_000), to: iso(0), observations, sensor_windows: [sensor], truncated: false, sensor_truncated: false }, { placeId: place.id, mode: 'replay' });
const renderPanel = (session, props = {}) => renderToStaticMarkup(createElement(FieldDataPanel, { place, session, ...props }));

describe('independent public observation cards', () => {
  test('renders all three purposes with independent expiry at the same place', () => {
    const session = { now, live: state(summary()), history: state(null), refresh() {} };
    const html = renderPanel(session);
    expect(html).toContain('3–5 辆');
    expect(html).toContain('42 秒已完成候梯');
    expect(html).toContain('2 个 BLE 可见标识');
    expect(html.match(/field-data-freshness fresh/g)).toHaveLength(2);
    expect(html.match(/field-data-freshness stale/g)).toHaveLength(1);
    expect(html).toContain('电动车监控 · 人工记录');
    expect(html).toContain('电梯观测 · 人工记录');
    expect(html).toContain('不等于人数、车辆数、精确占用或自动候梯预测');
    const later = renderPanel({ ...session, now: now + 10_000 });
    expect(later.match(/field-data-freshness fresh/g)).toHaveLength(1);
    expect(later.match(/field-data-freshness stale/g)).toHaveLength(2);
  });

  test('keeps an unreported purpose empty instead of reusing another purpose or legacy singleton', () => {
    const data = summary();
    data.latest_observations = { parking: null, elevator };
    const html = renderPanel({ now, live: state(data), history: state(null), refresh() {} });
    expect(html).toContain('电动车监控：暂无人工现场记录');
    expect(html).not.toContain('3–5 辆');
    expect(html.match(/42 秒已完成候梯/g)).toHaveLength(1);
  });

  test('retains legacy field summary cards', () => {
    const data = { place: { ...place, kind: 'parking', observation_kinds: undefined }, as_of: iso(0), sensor: null, latest_observation: parking };
    const html = renderPanel({ now, live: state(data), history: state(null), refresh() {} });
    expect(html).toContain('3–5 辆');
    expect(html).not.toContain('42 秒已完成候梯');
  });

  test('explains why an online device can have no public sensor window', () => {
    const data = { ...summary(), sensor: null };
    const html = renderPanel({ now, live: state(data), history: state(null), refresh() {} });
    expect(html).toContain('设备联网后，仍需上传符合此地点与现场数据要求的采集窗口');
    expect(html).toContain('地图标记地点，不单独标记设备');
    expect(html).not.toContain('0 个 BLE 可见标识');
  });

  test('selects both purposes at a pinned instant while later refreshed history remains in its own time', () => {
    const cursor = now - 25_000;
    const session = { now, live: state(summary()), history: state(history([parking, elevator])), refresh() {} };
    const html = renderPanel(session, { mode: 'replay', cursor });
    expect(html).toContain('3–5 辆');
    expect(html).toContain('42 秒已完成候梯');
    expect(html.match(/field-data-freshness historical/g)).toHaveLength(3);
    const refreshed = { ...session, now: now + 1000, history: state(history([parking, elevator, { ...elevator, id: 'elevator-2', observed_at: iso(-5000), valid_until: iso(5000), wait_seconds: 99 }])) };
    const later = renderPanel(refreshed, { mode: 'replay', cursor });
    expect(later).toContain('42 秒已完成候梯');
    expect(later).not.toContain('99 秒已完成候梯');
    expect(later).toContain(new Date(cursor).toISOString());
    const gap = renderPanel(session, { mode: 'replay', cursor: now - 120_001 });
    expect(gap).toContain('该时刻没有已载入的观测记录');
    expect(gap).not.toContain('field-data-value');
  });

  test('counts the latest valid result per purpose in timeline status and labels discrete marks', () => {
    const data = history([parking, elevator, { ...parking, id: 'parking-2', observed_at: iso(-40_000), valid_until: iso(-10_000), parking_min: 6, parking_max: 7 }]);
    const html = renderToStaticMarkup(createElement(FieldTimeline, { history: data, now, cursor: now - 25_000 }));
    expect(html).toContain('2 类有效人工结果');
    expect(html).toContain('电动车监控');
    expect(html).toContain('电梯观测');
    expect(html).toContain('42 秒已完成候梯');
    // All actual records keep their timeline marks even when a newer valid
    // record of that purpose supplies the detail card at the selected cursor.
    expect(html.match(/class="field-timeline-mark manual"/g)).toHaveLength(3);
  });
});
