import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { controlledReplayBounds, controlledReplayId, controlledReplayPath, controlledWindowIndex, createControlledReplayReader, formatReplayTime, normalizeControlledReplay } from '../../src/campus/controlled-replay-data.js';
import { normalizeFieldResponse } from '../../src/campus/field-data.js';
import ControlledReplayPanel from '../../src/campus/ControlledReplayPanel.jsx';
import ControlledReplayTimeline from '../../src/campus/ControlledReplayTimeline.jsx';
import { App } from '../../src/campus/App.jsx';

const mocks = vi.hoisted(() => ({ session: null, fieldSession: vi.fn() }));
vi.mock('../../src/campus/use-controlled-replay.js', () => ({ useControlledReplay: () => mocks.session }));
vi.mock('../../src/campus/use-field-session.js', () => ({ useFieldSession: (...args) => { mocks.fieldSession(...args); return { now: 1, live: { data: null }, history: { data: null } }; } }));
vi.mock('../../src/campus/CampusMap.jsx', () => ({ default: props => createElement('div', { 'data-map': true, 'data-demo': props.demo, 'data-illustration': Boolean(props.fieldIllustration), 'data-places': props.mapPlaces.length }) }));
vi.mock('../../src/campus/Observations.jsx', () => ({ default: () => createElement('div', { 'data-observations': true }) }));

const epoch = Date.parse('2026-10-28T07:30:00.000Z');
function windowEntry(index, start, duration, reports, visible) {
  return { source_start_mono_us: start, source_end_mono_us: start + duration * 1000, item: {
    seq: index + 1, window_seq: index + 1, time: { mono_ms: start / 1000 + duration, utc_ms: epoch + start / 1000 + duration, clock_epoch: 1, uncertainty_ms: 10 }, duration_ms: duration, bin_ms: 1000,
    categories: { phone_candidate: 0, e_bike_candidate: 0, car_candidate: 0, other: 0, unknown: visible, conflicting: 0 }, visible_identifiers: visible, estimated_total: null,
    reports: { received: reports, worker: reports, adv: reports, scan_response: 0 },
    bins: Array.from({ length: Math.ceil(duration / 1000) }, (_, i) => ({ worker_reports: i === 0 ? reports : 0, visible_identifiers: i === 0 ? visible : 0, rssi_samples: i === 0 ? reports : 0, rssi_sum_dbm: i === 0 ? -60 * reports : 0 })),
    rssi: { samples: reports, sum_dbm: reports * -60, min_dbm: -60, max_dbm: -60 }, losses: { scan_coverage_ms: duration, callback_drops: 0, aggregation_drops: 0, address_overflow_reports: 0 }, quality_mask: 2 | (duration < 60000 ? 1 : 0),
    versions: { extractor_version: 'cp-v3-stats/1', ruleset_version: 'unclassified-v1' },
  } };
}
function fixture(id = 'capture-test') {
  return { schema: 'campuspulse-replay-view/1', dataset: 'controlled_test', source: 'historical_cpraw', id, label: '历史采集测试', place_id: null,
    imported_at: '2026-11-06T01:00:00.000Z', body_sha256: 'a'.repeat(64), window_ms: 60000, bin_ms: 1000,
    source_metadata: { sha256: ['b'.repeat(64)], total_reports: 10, replayed_reports: 10, time_semantics: 'historical_capture', clock_anchors: [{ mono_us: 1000000, utc_epoch_seconds: epoch / 1000 + 1, uncertainty_us: 10000, source: 'fixture' }] },
    windows: [windowEntry(0, 1000000, 60000, 7, 2), windowEntry(1, 61000000, 5000, 3, 1)] };
}
const session = (data = fixture(), index = 0) => ({ id: data.id, data, index, selectedWindow: data.windows[index], loading: false, error: '', unauthorized: false, seek() {}, togglePlaying() {}, playing: false });
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); mocks.fieldSession.mockClear(); });

describe('explicit historical controlled source', () => {
  test('only the explicit query selects a controlled source, including invalid values', () => {
    expect(controlledReplayId('?mode=replay&place=library')).toBeNull();
    expect(controlledReplayId('?capture_replay=capture-test&mode=demo')).toBe('capture-test');
    expect(controlledReplayId('?capture_replay=')).toBe('');
    expect(controlledReplayPath('capture-test')).toBe('/api/v1/admin/replays/capture-test');
    for (const id of ['', '../secret', 'https://elsewhere', 'x?token=secret']) expect(() => controlledReplayPath(id)).toThrow('无效');
  });
  test('normalizes full source without inventing UTC, estimates, or current extent', () => {
    const body = fixture();
    expect(normalizeControlledReplay(body, body.id)).toBe(body);
    expect(controlledReplayBounds(body)).toEqual({ from: 1000000, to: 66000000 });
    expect(formatReplayTime(body.windows[0], 'start', body)).toContain('2026/10/28');
    for (const entry of body.windows) { entry.item.time.utc_ms = null; entry.item.time.uncertainty_ms = null; }
    expect(normalizeControlledReplay(body, body.id)).toBe(body);
    expect(formatReplayTime(body.windows[0], 'start', body)).toBe('源起点 +0.000 秒（绝对时间未知）');
    expect(formatReplayTime(body.windows[1], 'end', body)).toBe('源起点 +65.000 秒（绝对时间未知）');
    expect(controlledWindowIndex(999, 2)).toBe(1);
    expect(controlledWindowIndex(-5, 2)).toBe(0);
    expect(controlledWindowIndex(NaN, 2)).toBe(0);
  });
  test.each([
    body => { body.dataset = 'field'; }, body => { body.dataset = 'demo'; }, body => { body.source = 'live'; }, body => { body.id = 'other'; },
    body => { body.source_metadata.total_reports = 11; }, body => { body.source_metadata.replayed_reports = 9; body.source_metadata.total_reports = 9; },
    body => { body.windows[1].source_start_mono_us += 1000; body.windows[1].source_end_mono_us += 1000; },
    body => { body.windows[1].source_end_mono_us += 1000; }, body => { body.windows[1].item.seq = 3; }, body => { body.windows[1].item.window_seq = 1; },
    body => { body.windows[1].item.quality_mask = 2; }, body => { body.windows[0].item.versions.ruleset_version = 'classified'; },
    body => { body.windows[0].item.estimated_total = 7; }, body => { body.windows = Array(121).fill(body.windows[0]); },
  ])('rejects source/count/sequence/partial-window confusion %s', mutate => {
    const body = fixture(); mutate(body);
    expect(() => normalizeControlledReplay(body, 'capture-test')).toThrow('历史回放数据无效');
  });
  test('the existing public field guard still rejects controlled statistics', () => {
    const data = fixture();
    expect(() => normalizeFieldResponse({ place: { id: 'library' }, as_of: '2026-11-06T00:00:00Z', sensor: { ...data.windows[0].item, dataset: 'controlled_test' }, latest_observation: null }, { placeId: 'library', mode: 'live' })).toThrow();
  });
});

describe('authenticated replay transport', () => {
  test('uses only the same-origin admin path and cookie credentials', async () => {
    const states = [], fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => fixture() }));
    const reader = createControlledReplayReader(state => states.push(state), fetcher);
    await reader.read('capture-test');
    expect(fetcher).toHaveBeenCalledWith('/api/v1/admin/replays/capture-test', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal) }));
    expect(states.at(-1).data.id).toBe('capture-test');
    expect(states.at(-1).loading).toBe(false);
    reader.cancel();
  });
  test('does not fetch an invalid ID and gives a clear same-site login state', async () => {
    const states = [], fetcher = vi.fn(async () => ({ ok: false, status: 401 }));
    const reader = createControlledReplayReader(state => states.push(state), fetcher);
    await reader.read('../bad');
    expect(fetcher).not.toHaveBeenCalled();
    await reader.read('capture-test');
    expect(states.at(-1)).toMatchObject({ data: null, unauthorized: true, error: '请先在同站点登录管理员，再返回此回放' });
    expect(render(ControlledReplayPanel, { session: { ...states.at(-1) } })).toContain('href="/admin"');
    reader.cancel();
  });
  test('ignores late JSON completion after a newer source is selected or cleanup', async () => {
    const pending = deferred(), states = [];
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: () => pending.promise }).mockResolvedValueOnce({ ok: true, status: 200, json: async () => fixture('second') });
    const reader = createControlledReplayReader(state => states.push(state), fetcher);
    const firstRead = reader.read('capture-test');
    await Promise.resolve();
    await reader.read('second');
    pending.resolve(fixture()); await firstRead;
    expect(states.at(-1).data.id).toBe('second');
    const stopped = deferred(), stoppedStates = [];
    const stoppedReader = createControlledReplayReader(state => stoppedStates.push(state), async () => ({ ok: true, status: 200, json: () => stopped.promise }));
    const stoppedRead = stoppedReader.read('capture-test');
    await Promise.resolve(); stoppedReader.cancel(); stopped.resolve(fixture()); await stoppedRead;
    expect(stoppedStates).toHaveLength(1);
    reader.cancel();
  });
  test('times out JSON parsing too, clears stale data and aborts transport', async () => {
    vi.useFakeTimers();
    const pending = deferred(), states = []; let signal;
    const reader = createControlledReplayReader(state => states.push(state), async (_path, options) => { signal = options.signal; return { ok: true, status: 200, json: () => pending.promise }; });
    const read = reader.read('capture-test');
    await vi.advanceTimersByTimeAsync(45_000); await read;
    expect(states.at(-1)).toMatchObject({ data: null, loading: false, error: '历史回放读取超时，请重试' });
    expect(signal.aborted).toBe(true);
    pending.resolve(fixture()); await Promise.resolve();
    expect(states).toHaveLength(2);
    reader.cancel();
  });
});

describe('historical source rendering', () => {
  test('renders source dates, partial tail, counts, losses and provenance without a location', () => {
    const active = session(fixture(), 1);
    const panel = render(ControlledReplayPanel, { session: active });
    expect(panel).toContain('原始采集地点未核验');
    expect(panel).toContain('1 个 BLE 可见标识');
    expect(panel).toContain('5.000 秒');
    expect(panel).toContain('非完整窗口');
    expect(panel).toContain('平均 RSSI');
    expect(panel).toContain('扫描覆盖');
    expect(panel).toContain('回调 / 聚合丢失');
    expect(panel).toContain('data-dataset="controlled_test"');
    expect(panel).not.toContain('a'.repeat(64));
    expect(panel).not.toContain('候梯估计</strong>');
    const timeline = render(ControlledReplayTimeline, { session: active });
    expect(timeline).toContain('min="0" max="1" step="1"');
    expect(timeline).toContain('2026/10/28');
    expect(timeline).not.toContain('2026/11/06');
    expect(timeline).toContain('全程 1.08 分钟');
  });
  test('main map keeps the panel and timeline with null place and disables all field/demo inputs', () => {
    mocks.session = session();
    vi.stubGlobal('window', { location: { search: '?capture_replay=capture-test&mode=demo' } });
    const html = render(App);
    expect(html).toContain('历史采集回放 · 管理员受控测试 · 非当前现场');
    expect(html).toContain('管理员历史采集回放');
    expect(html).toContain('历史采集固定时间轴');
    expect(html).toContain('data-places="0"');
    expect(html).toContain('data-demo="false"');
    expect(html).toContain('data-illustration="false"');
    expect(html).not.toContain('data-observations');
    expect(html).not.toContain('aria-label="观测地点"');
    expect(html).not.toContain('aria-label="现场数据连续时间轴"');
    expect(html).not.toContain('simulation-parking');
    expect(mocks.fieldSession).toHaveBeenCalledWith(undefined, false, 60);
  });
});
