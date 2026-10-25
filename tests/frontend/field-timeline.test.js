import { describe, expect, test } from 'vitest';
import { formatTimelineTime, recordsAtTime, timelineBounds, timelineMarks, timelineTicks, timePosition } from '../../src/campus/field-timeline.js';

const now = Date.parse('2026-10-25T10:00:00.000Z');
const iso = offset => new Date(now + offset).toISOString();
const sensor = overrides => ({ source: 'sensor', dataset: 'field', node_id: 'node-1', boot_id: 'boot-1', seq: 1, observed_at: iso(-30_000), duration_ms: 30_000, valid_until: iso(60_000), visible_identifiers: 4, ...overrides });
const manual = overrides => ({ source: 'manual', status: 'active', id: 'manual-1', kind: 'parking', observed_at: iso(-120_000), valid_until: iso(-90_000), parking_min: 1, parking_max: 3, ...overrides });
const bounds = { from: now - 120_000, to: now };

describe('actual recording coverage at a continuous cursor', () => {
  test('covers only the sensor capture window, with both capture endpoints included', () => {
    const record = sensor();
    expect(recordsAtTime([record], now - 60_000).sensors).toEqual([record]);
    expect(recordsAtTime([record], now - 30_000).sensors).toEqual([record]);
    expect(recordsAtTime([record], now - 60_001).hasRecording).toBe(false);
    // Valid-until freshness is not permission to extend a recorded window.
    expect(recordsAtTime([record], now - 29_999).hasRecording).toBe(false);
    expect(recordsAtTime([record], now).hasRecording).toBe(false);
  });

  test('never interpolates or chooses a nearby window across a recording gap', () => {
    const before = sensor({ observed_at: iso(-90_000), seq: 1 });
    const after = sensor({ observed_at: iso(-15_000), seq: 2 });
    expect(recordsAtTime([before, after], now - 75_000)).toEqual({ sensors: [], manual: [], hasRecording: false });
    expect(recordsAtTime([before, after], now - 105_000).sensors).toEqual([before]);
    expect(recordsAtTime([before, after], now - 30_000).sensors).toEqual([after]);
  });

  test('returns overlapping nodes separately without averaging their observations', () => {
    const first = sensor(), second = sensor({ node_id: 'node-2', visible_identifiers: 20 }), newer = sensor({ observed_at: iso(-25_000), seq: 2 });
    const result = recordsAtTime([first, second, newer], now - 40_000);
    expect(result.sensors).toHaveLength(3);
    expect(result.sensors[0]).toBe(newer);
    expect(result.sensors.map(record => record.visible_identifiers).sort((a, b) => a - b)).toEqual([4, 4, 20]);
    expect(result.manual).toEqual([]);
  });

  test('applies each manual validity interval independently, excluding exact expiry', () => {
    const record = manual();
    expect(recordsAtTime([record], now - 120_000).manual).toEqual([record]);
    expect(recordsAtTime([record], now - 90_001).manual).toEqual([record]);
    expect(recordsAtTime([record], now - 90_000).manual).toEqual([]);
    expect(recordsAtTime([record], now - 120_001).manual).toEqual([]);
  });

  test('keeps manual and sensor sources independent at the same cursor', () => {
    const sensorRecord = sensor(), older = manual({ valid_until: iso(30_000) });
    const newer = manual({ id: 'manual-2', observed_at: iso(-55_000), valid_until: iso(30_000), parking_min: 0, parking_max: 0 });
    const result = recordsAtTime([older, sensorRecord, newer], now - 45_000);
    expect(result.sensors).toEqual([sensorRecord]);
    expect(result.manual).toEqual([newer]);
    expect(result.hasRecording).toBe(true);
  });

  test('selects the latest valid result per manual purpose at the same place and leaves independent gaps', () => {
    const older = manual({ valid_until: iso(30_000) });
    const newer = manual({ id: 'parking-2', observed_at: iso(-55_000), valid_until: iso(-20_000), parking_min: 0, parking_max: 0 });
    const elevator = manual({ id: 'elevator-1', kind: 'elevator', wait_seconds: 25, observed_at: iso(-100_000), valid_until: iso(-40_000) });
    const records = [older, newer, elevator];
    expect(recordsAtTime(records, now - 45_000).manual).toEqual([newer, elevator]);
    expect(recordsAtTime(records, now - 40_000).manual).toEqual([newer]);
    expect(recordsAtTime(records, now - 20_000).manual).toEqual([older]);
    expect(recordsAtTime(records, now + 30_000).manual).toEqual([]);
    expect(recordsAtTime(records, now - 100_001).manual).toEqual([older]);
    // A later refresh never introduces future observations into a pinned cursor.
    const futureElevator = { ...elevator, id: 'elevator-2', observed_at: iso(-35_000), valid_until: iso(100_000) };
    expect(recordsAtTime([...records, futureElevator], now - 45_000).manual).toEqual([newer, elevator]);
  });

  test('matches the live summary id-descending tie-break for equal-time manual results', () => {
    const lower = manual({ id: '00000000-0000-4000-8000-000000000000', observed_at: iso(-60_000), valid_until: iso(30_000), parking_min: 1, parking_max: 1 });
    const higher = { ...lower, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', parking_min: 9, parking_max: 9 };
    const elevator = { ...lower, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', kind: 'elevator', wait_seconds: 25 };
    for (const records of [[lower, higher, elevator], [elevator, higher, lower]]) {
      expect(recordsAtTime(records, now - 45_000).manual).toEqual([higher, elevator]);
    }
  });

  test('does not mutate or fabricate records, including empty and invalid inputs', () => {
    const record = Object.freeze(sensor());
    const records = Object.freeze([record]);
    expect(recordsAtTime(records, now - 45_000).sensors[0]).toBe(record);
    expect(recordsAtTime([], now)).toEqual({ sensors: [], manual: [], hasRecording: false });
    expect(recordsAtTime(null, now).hasRecording).toBe(false);
    expect(recordsAtTime(records, NaN).hasRecording).toBe(false);
  });

  test('excludes non-field, cancelled and malformed records from coverage and marks', () => {
    const badRecords = [sensor({ dataset: 'demo' }), sensor({ dataset: 'controlled_test' }), sensor({ duration_ms: -30_000 }), sensor({ observed_at: 'invalid' }), manual({ dataset: 'demo' }), manual({ dataset: 'controlled_test' }), manual({ kind: 'activity' }), manual({ status: 'cancelled' }), manual({ valid_until: iso(-150_000) }), { source: 'demo' }, null];
    expect(recordsAtTime(badRecords, now - 45_000).hasRecording).toBe(false);
    expect(timelineMarks(badRecords, bounds)).toEqual([]);
  });
});

describe('continuous time-axis geometry', () => {
  test('keeps query bounds and advances the live right edge between reads', () => {
    const history = { from: iso(-3_600_000), to: iso(-15_000) };
    expect(timelineBounds(history, now)).toEqual({ from: now - 3_600_000, to: now });
    expect(timelineBounds(history, now + 1000).to).toBe(now + 1000);
    expect(timelineBounds({ ...history, to: iso(1000) }, now).to).toBe(now + 1000);
  });

  test('keeps an empty 24-hour axis without inventing historical records', () => {
    expect(timelineBounds(null, now)).toEqual({ from: now - 86_400_000, to: now });
    expect(timelineBounds({ from: 'invalid', to: 'invalid' }, now)).toEqual({ from: now - 86_400_000, to: now });
    expect(timelineBounds({ from: iso(1000), to: iso(0) }, now)).toEqual({ from: now - 86_400_000, to: now });
    expect(timelineMarks([], timelineBounds(null, now))).toEqual([]);
  });

  test('positions timestamps proportionally without filling gaps between marks', () => {
    expect(timePosition(bounds.from, bounds)).toBe(0);
    expect(timePosition(bounds.to, bounds)).toBe(100);
    expect(timePosition(now - 60_000, bounds)).toBe(50);
    expect(timePosition(now - 150_000, bounds)).toBe(0);
    expect(timePosition(now + 150_000, bounds)).toBe(100);
    expect(timePosition(NaN, bounds)).toBe(0);
    expect(timePosition(now, { from: now, to: now })).toBe(0);
    const marks = timelineMarks([sensor(), sensor({ seq: 2, observed_at: iso(-100_000), duration_ms: 10_000 })], bounds);
    expect(marks).toHaveLength(2);
    expect(marks[0].position).toBeCloseTo(100 / 12);
    expect(marks[0].width).toBeCloseTo(100 / 12);
    expect([marks[1].position, marks[1].width]).toEqual([50, 25]);
  });

  test('clips sensor bands to query boundaries while retaining actual source times', () => {
    const record = sensor({ observed_at: iso(-100_000), duration_ms: 60_000 });
    const [mark] = timelineMarks([record], bounds);
    expect(mark.from).toBe(bounds.from);
    expect(mark.to).toBe(now - 100_000);
    expect(mark.position).toBe(0);
    expect(mark.width).toBeCloseTo(100 / 6);
    expect(mark.record).toBe(record);
    expect(Date.parse(mark.record.observed_at) - mark.record.duration_ms).toBe(now - 160_000);
  });

  test('renders manual observations as discrete time markers, not duration bands', () => {
    const record = manual({ observed_at: iso(-60_000), valid_until: iso(60_000) });
    const [mark] = timelineMarks([record], bounds);
    expect(mark).toMatchObject({ source: 'manual', position: 50, width: 0, from: now - 60_000, to: now - 60_000 });
    expect(timelineMarks([manual({ observed_at: iso(-121_000) })], bounds)).toEqual([]);
  });

  test('does not mutate sort order or collapse sensor nodes and boots', () => {
    const records = Object.freeze([sensor(), sensor({ boot_id: 'boot-2' }), sensor({ node_id: 'node-2' })]);
    const marks = timelineMarks(records, bounds);
    expect(marks).toHaveLength(3);
    expect(new Set(marks.map(mark => mark.key)).size).toBe(3);
    expect(records[0].boot_id).toBe('boot-1');
  });

  test('emits continuous, evenly spaced ticks including both bounds', () => {
    expect(timelineTicks(bounds)).toEqual([now - 120_000, now - 90_000, now - 60_000, now - 30_000, now]);
    expect(timelineTicks(bounds, 3)).toEqual([now - 120_000, now - 60_000, now]);
    expect(timelineTicks(bounds, 1)).toEqual([now - 120_000, now]);
    expect(timelineTicks(bounds, 100)).toHaveLength(12);
    expect(timelineTicks({ from: now, to: now })).toEqual([]);
  });

  test('labels Beijing time explicitly independent of the runtime timezone', () => {
    expect(formatTimelineTime(now)).toBe('18:00');
    expect(formatTimelineTime(now + 1234, { seconds: true })).toBe('18:00:01');
    expect(formatTimelineTime(now, { date: true, seconds: true })).toContain('10/25');
    expect(formatTimelineTime(now, { date: true, seconds: true })).toContain('18:00:00');
    expect(formatTimelineTime(NaN)).toBe('时间不可用');
  });
});
