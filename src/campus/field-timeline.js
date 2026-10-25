import { fieldRecordKey } from './field-data.js';

const DAY_MS = 86_400_000;
const parsedTime = value => typeof value === 'string' ? Date.parse(value) : NaN;

/** Continuous axis; the right edge advances with now even between API reads. */
export function timelineBounds(history, now = Date.now()) {
  const current = Number.isFinite(now) ? now : Date.now();
  const end = parsedTime(history?.to);
  const to = Number.isFinite(end) ? Math.max(end, current) : current;
  const start = parsedTime(history?.from);
  return { from: Number.isFinite(start) && start < to ? start : to - DAY_MS, to };
}

export function timePosition(time, { from, to }) {
  if (!Number.isFinite(time) || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  return Math.min(100, Math.max(0, (time - from) / (to - from) * 100));
}

function recordInterval(record) {
  if (!record || typeof record !== 'object') return null;
  const observed = parsedTime(record.observed_at);
  if (!Number.isFinite(observed)) return null;
  if (record.source === 'sensor' && record.dataset === 'field' && Number.isFinite(record.duration_ms) && record.duration_ms > 0) {
    return { from: observed - record.duration_ms, to: observed, source: 'sensor' };
  }
  const until = parsedTime(record.valid_until);
  if (record.source === 'manual' && record.status === 'active' && (record.kind === 'parking' || record.kind === 'elevator')
    && (record.dataset === undefined || record.dataset === 'field') && Number.isFinite(until) && until > observed) {
    return { from: observed, to: until, source: 'manual' };
  }
  return null;
}

/**
 * Find recorded coverage, never nearest-neighbour or interpolated values.
 * Sensor windows include both captured endpoints. Manual observations apply
 * from observed_at up to (but excluding) valid_until; return each source apart.
 * Multiple nodes/windows remain distinct. Select the latest valid manual
 * result of each purpose independently; newer parking cannot replace elevator.
 */
export function recordsAtTime(records, time) {
  const sensors = [], manual = [];
  if (!Number.isFinite(time)) return { sensors, manual, hasRecording: false };
  for (const record of Array.isArray(records) ? records : []) {
    const interval = recordInterval(record);
    if (!interval || time < interval.from || (interval.source === 'sensor' ? time > interval.to : time >= interval.to)) continue;
    (interval.source === 'sensor' ? sensors : manual).push(record);
  }
  const newestFirst = (a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at) || fieldRecordKey(a).localeCompare(fieldRecordKey(b));
  sensors.sort(newestFirst);
  // Match the public summary's observed_at DESC, id DESC ordering so a
  // same-time correction selects the same result in live and replay views.
  manual.sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at) || b.id.localeCompare(a.id));
  const latestKinds = new Set();
  const latestManual = manual.filter(record => {
    if (latestKinds.has(record.kind)) return false;
    latestKinds.add(record.kind);
    return true;
  });
  return { sensors, manual: latestManual, hasRecording: sensors.length + latestManual.length > 0 };
}

/** Sensor intervals are clipped to the axis; manual records remain points. */
export function timelineMarks(records, bounds) {
  const marks = [];
  if (!bounds || !Number.isFinite(bounds.from) || !Number.isFinite(bounds.to) || bounds.to <= bounds.from) return marks;
  for (const record of Array.isArray(records) ? records : []) {
    const interval = recordInterval(record);
    if (!interval) continue;
    const markerEnd = interval.source === 'manual' ? interval.from : interval.to;
    if (markerEnd < bounds.from || interval.from > bounds.to) continue;
    const from = Math.max(bounds.from, interval.from);
    const to = Math.min(bounds.to, markerEnd);
    marks.push({ key: fieldRecordKey(record), source: interval.source, from, to, position: timePosition(from, bounds), width: interval.source === 'sensor' ? timePosition(to, bounds) - timePosition(from, bounds) : 0, record });
  }
  return marks.sort((a, b) => a.from - b.from || a.key.localeCompare(b.key));
}

export function timelineTicks(bounds, count = 5) {
  if (!bounds || !Number.isFinite(bounds.from) || !Number.isFinite(bounds.to) || bounds.to <= bounds.from) return [];
  const length = Math.min(12, Math.max(2, Math.floor(Number.isFinite(count) ? count : 5)));
  return Array.from({ length }, (_, index) => Math.round(bounds.from + (bounds.to - bounds.from) * index / (length - 1)));
}

export function formatTimelineTime(time, { date = false, seconds = false } = {}) {
  if (!Number.isFinite(time)) return '时间不可用';
  return new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', ...(date ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false });
}
