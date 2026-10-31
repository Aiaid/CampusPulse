import { describe, expect, it } from 'vitest';
import {
  assertStatisticsV3EventRevision, assertStatisticsV3StatusOrder, normalizeStatisticsV3Batch, parseStatisticsV3Json,
  statisticsV3Time, validateStatisticsV3Envelope, validateStatisticsV3Event, validateStatisticsV3Status, validateStatisticsV3Window,
} from '../worker/device-v3-statistics-validation';
import {
  statisticsEventFixture, statisticsFixtureBytes, statisticsLimitsFixture, statisticsStatusFixture, statisticsRawStatusFixture, statisticsWindowFixture,
  statisticsDenseWindowFixture, statisticsMaxWidthWindowFixture,
  statisticsCensoredEventFixture,
} from './helpers/v3-small-statistics-fixtures';

const limits = statisticsLimitsFixture();
const window = () => statisticsWindowFixture().x[0];
const event = () => statisticsEventFixture().x[0];
const status = () => statisticsStatusFixture().x[0];
const clone = <T>(value: T): T => structuredClone(value);

describe('compact statistics bytes and envelope', () => {
  it('measures dense 512-identifier full envelopes with 20000 reports and maximum-width scope', () => {
    for (const longScope of [false, true]) {
      const body = statisticsDenseWindowFixture(longScope), bytes = statisticsFixtureBytes(body);
      const parsed = normalizeStatisticsV3Batch(parseStatisticsV3Json(bytes, 1024), statisticsLimitsFixture(60000));
      expect(parsed.stream).toBe('window_statistics');
      if (parsed.stream !== 'window_statistics') throw new Error('wrong stream');
      expect(parsed.items[0]).toMatchObject({ visible_identifiers: 512, reports: { received: 20000, worker: 20000, adv: 16000, scan_response: 4000 }, quality_mask: 0 });
      expect(parsed.items[0].bins).toHaveLength(12);
      expect(parsed.items[0].bins.reduce((n, b) => n + b.worker_reports, 0)).toBe(20000);
      expect(parsed.items[0].rssi.sum_dbm).toBe(-1200000);
      expect(bytes.byteLength).toBe(longScope ? 878 : 798);
      expect(bytes.byteLength).toBeLessThanOrEqual(1024);
      if (longScope) { expect(body.n).toHaveLength(64); expect(body.c).toHaveLength(64); }
    }
  });
  it('keeps schema-valid numeric-width stress examples intact and rejects a smaller device body budget', () => {
    for (const [duration, maxBins] of [[60000, 12], [300000, 60]]) {
      const body = statisticsMaxWidthWindowFixture(duration), bytes = statisticsFixtureBytes(body);
      const stressLimits = { ...statisticsLimitsFixture(duration), max_bins: maxBins };
      const parsed = normalizeStatisticsV3Batch(parseStatisticsV3Json(bytes, 8192), stressLimits);
      expect(parsed.stream).toBe('window_statistics');
      if (parsed.stream !== 'window_statistics') throw new Error('wrong stream');
      const item = parsed.items[0];
      expect(body.n).toHaveLength(64); expect(body.c).toHaveLength(64); expect(item.bins).toHaveLength(maxBins);
      expect(item.reports.received).toBe(Number.MAX_SAFE_INTEGER);
      expect(BigInt(item.reports.worker) + BigInt(item.losses.callback_drops) + BigInt(item.losses.aggregation_drops)).toBe(BigInt(Number.MAX_SAFE_INTEGER));
      expect(item.bins.reduce((n, b) => n + BigInt(b.worker_reports), 0n)).toBe(BigInt(item.reports.worker));
      expect(item.quality_mask).toBe(63); expect(item.visible_identifiers).toBe(512);
      expect(bytes.byteLength).toBe(duration === 60000 ? 1442 : 3904);
      expect(bytes.byteLength).toBeGreaterThan(1024); expect(bytes.byteLength).toBeLessThanOrEqual(8192);
      expect(() => parseStatisticsV3Json(bytes, 1024)).toThrow(expect.objectContaining({ status: 413, code: 'body_too_large' }));
      expect(statisticsFixtureBytes(body)).toEqual(bytes); // No truncation or identity rewriting after rejection.
    }
  });
  it('measures complete frozen synthetic envelopes, including scope, and normalizes readable aggregates', () => {
    const mobile = statisticsFixtureBytes(statisticsWindowFixture()), fixed = statisticsFixtureBytes(statisticsWindowFixture(60000));
    expect(mobile.byteLength).toBe(585); expect(fixed.byteLength).toBe(678);
    expect(mobile.byteLength * 2).toBeGreaterThan(1024); // The target is not a measured guarantee.
    for (const duration of [30000, 60000]) {
      const body = statisticsWindowFixture(duration), result = normalizeStatisticsV3Batch(parseStatisticsV3Json(statisticsFixtureBytes(body)), statisticsLimitsFixture(duration));
      expect(result.stream).toBe('window_statistics');
      if (result.stream !== 'window_statistics') throw new Error('wrong stream');
      expect(result.items[0]).toMatchObject({ seq: 1, visible_identifiers: 2, estimated_total: null,
        categories: { unknown: 2, phone_candidate: 0 }, versions: { ruleset_version: 'unclassified-v1' } });
      expect(result.items[0].bins).toHaveLength(duration / 5000);
    }
  });
  it('rejects malformed UTF-8, decoded duplicate keys, unsafe integers, long bodies and obsolete/per-address fields', () => {
    expect(() => parseStatisticsV3Json(new Uint8Array([0xc0, 0x80]))).toThrow();
    expect(() => parseStatisticsV3Json(new TextEncoder().encode('{"q":1,"\\u0071":2}'))).toThrow();
    expect(() => parseStatisticsV3Json(new Uint8Array(8193))).toThrow();
    expect(() => parseStatisticsV3Json(statisticsFixtureBytes(statisticsWindowFixture()), 512)).toThrow();
    for (const field of ['mac', 'token', 'raw', 'payload', 'addresses', 'items', 'producer_version']) {
      expect(() => validateStatisticsV3Envelope({ ...statisticsWindowFixture(), [field]: [] })).toThrow();
    }
    for (const [key, value] of Object.entries({ p: 'campuspulse/3', z: 'device-ingest/3', k: 'feature_summaries', g: Number.MAX_SAFE_INTEGER + 1, b: 'not-random-uuid', d: 'research_unassigned', x: [] })) {
      expect(() => validateStatisticsV3Envelope({ ...statisticsWindowFixture(), [key]: value })).toThrow();
    }
    expect(() => normalizeStatisticsV3Batch(statisticsWindowFixture(), { ...limits, max_batch_items: 0 })).toThrow();
    expect(() => normalizeStatisticsV3Batch(statisticsWindowFixture(), { ...limits, streams: ['node_status'] })).toThrow();
  });
  it('requires ascending sequence identities independent from window sequence and policy changes', () => {
    const b = statisticsWindowFixture(); b.x.push({ ...window(), q: 2, w: 2 });
    expect(normalizeStatisticsV3Batch(b, limits).items).toHaveLength(2);
    b.x[1].q = 1; expect(() => normalizeStatisticsV3Batch(b, limits)).toThrow();
    b.x[1].q = 2; b.x[1].w = 1; expect(() => normalizeStatisticsV3Batch(b, limits)).toThrow();
    b.x[1].t[2] = 2; expect(normalizeStatisticsV3Batch(b, limits).items).toHaveLength(2);
  });
});

describe('time tuples preserve unknown values', () => {
  it('preserves explicit unknown UTC and uncertainty and requires epoch one or later', () => {
    expect(statisticsV3Time([100, null, 1, null])).toEqual({ mono_ms: 100, utc_ms: null, clock_epoch: 1, uncertainty_ms: null });
    expect(statisticsV3Time([100, 0, 1, 0]).utc_ms).toBe(0);
    for (const bad of [[0, null, 1, 0], [0, 0, 1, null], [0, null, 0, null], [0, 1.5, 1, 0], [Number.MAX_SAFE_INTEGER + 1, null, 1, null], [0, -1, 1, 0], [0, null, 1]]) {
      expect(() => statisticsV3Time(bad)).toThrow();
    }
    const unknown = statisticsWindowFixture(30000, false).x[0];
    expect(validateStatisticsV3Window(unknown, limits).time.utc_ms).toBeNull();
    unknown.f = 0; expect(() => validateStatisticsV3Window(unknown, limits)).toThrow();
    const uncertain = window(); uncertain.t[3] = 100;
    expect(() => validateStatisticsV3Window(uncertain, limits)).toThrow(); uncertain.f = 2;
    expect(validateStatisticsV3Window(uncertain, limits).time.uncertainty_ms).toBe(100);
  });
});

describe('normal window conservation', () => {
  it.each([
    ['category capacity', (w: ReturnType<typeof window>) => { w.c[4] = 513; }],
    ['unverified phone rule', (w: ReturnType<typeof window>) => { w.c[0] = 1; }],
    ['received reports', (w: ReturnType<typeof window>) => { w.r[0]--; }],
    ['adv plus scan response', (w: ReturnType<typeof window>) => { w.r[2]--; }],
    ['bin reports', (w: ReturnType<typeof window>) => { w.x[0][0]--; }],
    ['bin identifier capacity', (w: ReturnType<typeof window>) => { w.x[0][1] = 3; }],
    ['no bin accounts for window identifiers', (w: ReturnType<typeof window>) => { w.x = w.x.map((b: number[]) => [b[0], 0, b[2], b[3]]); }],
    ['bin RSSI sample total', (w: ReturnType<typeof window>) => { w.x[0][2]--; }],
    ['bin RSSI sum total', (w: ReturnType<typeof window>) => { w.x[0][3]--; }],
    ['RSSI extrema', (w: ReturnType<typeof window>) => { w.s[2] = -59; }],
    ['RSSI max', (w: ReturnType<typeof window>) => { w.s[3] = 21; }],
    ['RSSI missing extrema', (w: ReturnType<typeof window>) => { w.s[2] = null; }],
    ['unsafe count', (w: ReturnType<typeof window>) => { w.r[0] = Number.MAX_SAFE_INTEGER + 1; }],
    ['unknown flag', (w: ReturnType<typeof window>) => { w.f = 64; }],
    ['unnegotiated bin layout', (w: ReturnType<typeof window>) => { w.b = 1000; }],
    ['duration before boot', (w: ReturnType<typeof window>) => { w.t[0] = 100; }],
    ['version mismatch', (w: ReturnType<typeof window>) => { w.v[0] = 'other/1'; }],
    ['rules mismatch', (w: ReturnType<typeof window>) => { w.v[1] = 'phone-guess/1'; }],
  ])('rejects %s', (_name, mutate) => { const w = window(); mutate(w); expect(() => validateStatisticsV3Window(w, limits)).toThrow(); });
  it('accepts RSSI missing for some/all reports and real measured zero counts', () => {
    const w = window(); w.x = w.x.map((bin: number[]) => [bin[0], bin[1], 0, 0]); w.s = [0, 0, null, null];
    expect(validateStatisticsV3Window(w, limits).rssi).toEqual({ samples: 0, sum_dbm: 0, min_dbm: null, max_dbm: null });
    w.c[4] = 0; w.r = [0, 0, 0, 0]; w.x = w.x.map(() => [0, 0, 0, 0]);
    expect(validateStatisticsV3Window(w, limits).visible_identifiers).toBe(0);
  });
  it('requires partial/loss/gap/overflow flags while keeping their counts explicit', () => {
    const w = window(); w.d = 27500; w.l[0] = 27500;
    expect(() => validateStatisticsV3Window(w, limits)).toThrow(); w.f = 1;
    expect(validateStatisticsV3Window(w, limits).duration_ms).toBe(27500);
    for (const [index, flag] of [[0, 4], [1, 16], [2, 32], [3, 8]]) {
      const value = window(); value.l[index] = index === 0 ? 29999 : 1;
      if (index === 1 || index === 2) value.r[0] += 1;
      expect(() => validateStatisticsV3Window(value, limits)).toThrow(); value.f = flag;
      expect(validateStatisticsV3Window(value, limits).quality_mask).toBe(flag);
    }
  });
  it('rejects loss counters that account for more reports than the callback source received', () => {
    const value = window(); value.l[1] = 1; value.l[2] = 1; value.f = 48;
    expect(() => validateStatisticsV3Window(value, limits)).toThrow();
    value.r[0] += 2;
    expect(validateStatisticsV3Window(value, limits).losses).toMatchObject({ callback_drops: 1, aggregation_drops: 1 });
  });
  it('rejects RSSI extrema impossible for the bin counts and sums', () => {
    const w = window(); w.c[4] = 2; w.r = [2, 2, 2, 0];
    w.x = [[1, 1, 1, -50], [1, 1, 1, -50], ...Array.from({ length: 4 }, () => [0, 0, 0, 0])];
    w.s = [2, -100, -100, 0]; // Each nonempty bin has one -50 sample.
    expect(() => validateStatisticsV3Window(w, limits)).toThrow();
    w.s = [2, -100, -50, -50]; expect(validateStatisticsV3Window(w, limits).rssi.samples).toBe(2);
  });
});

describe('status physical queue capacities and monotonic boot counters', () => {
  it('preserves unmeasured memory as null and measures zero separately', () => {
    const s = status(); expect(validateStatisticsV3Status(s, limits).memory.psram_free).toBeNull();
    s.r = [1000, 500, 800, 0, 100]; expect(validateStatisticsV3Status(s, limits).memory.psram_free).toBe(0);
    s.r[1] = 1001; expect(() => validateStatisticsV3Status(s, limits)).toThrow();
  });
  it('rejects incorrect uptime, inconsistent empty queues and global queue capacity overflow', () => {
    const s = status(); s.u--; expect(() => validateStatisticsV3Status(s, limits)).toThrow();
    for (const queue of [
      [33, 700, 0, 0, 1, 500], [1, 65537, 0, 0, 1, 500],
      [16, 1000, 16, 1000, 1, 500], [1, 32768, 1, 32768, 1, 500],
      [0, 1, 0, 0, 1, 500], [1, 0, 0, 0, 1, 500],
    ]) {
      expect(() => validateStatisticsV3Status({ ...status(), j: queue }, limits)).toThrow();
    }
  });
  it('allows occupancy above a stream minimum reserve within the physical global capacity', () => {
    const normalized = validateStatisticsV3Status({ ...status(), j: [17, 32769, 0, 0, 1, 500] }, limits);
    expect(normalized.queue.window_statistics).toEqual({ pending_items: 17, pending_bytes: 32769 });
    expect(validateStatisticsV3Status(status(), { ...limits, queue: { ...limits.queue, stream_reserves: [] } }).queue.node_status.pending_items).toBe(1);
  });
  it('reports historical event backlog while the current policy disables event uploads', () => {
    const current = { ...limits, streams: ['window_statistics', 'node_status'] as const,
      temporal: { ...limits.temporal!, report_mode: 'off' as const },
      queue: { ...limits.queue, stream_reserves: limits.queue.stream_reserves.filter(r => r.stream !== 'candidate_events') } };
    const normalized = validateStatisticsV3Status({ ...status(), j: [17, 32769, 4, 2048, 1, 500] }, current);
    expect(normalized.queue.candidate_events).toEqual({ pending_items: 4, pending_bytes: 2048 });
    expect(() => normalizeStatisticsV3Batch(statisticsEventFixture(), current)).toThrow();
  });
  it('checks both sequence neighbors for delayed insertion counter regressions', () => {
    const a = validateStatisticsV3Status(status(), limits), b = clone(a), c = clone(a);
    b.seq = 2; b.uptime_ms++; b.time.mono_ms++; b.losses.retries = 1;
    c.seq = 3; c.uptime_ms += 2; c.time.mono_ms += 2; c.losses.retries = 2;
    expect(() => { assertStatisticsV3StatusOrder(a, b); assertStatisticsV3StatusOrder(b, c); }).not.toThrow();
    b.losses.retries = 3; expect(() => assertStatisticsV3StatusOrder(b, c)).toThrow();
    b.losses.retries = 0; a.losses.retries = 1; expect(() => assertStatisticsV3StatusOrder(a, b)).toThrow();
  });
  it('separates explicit unknown local TF counters from measured zero and validates frozen mode', () => {
    const rawLimits = { ...limits, local_raw_mode: 'tf_cpraw' as const }, raw = statisticsRawStatusFixture().x[0];
    expect(validateStatisticsV3Status(raw, rawLimits).raw_recording).toEqual({ enqueued: 100, written: 99, synced: 90, queue_drops: 1, storage_failures: 0, space_stops: 0 });
    expect(() => validateStatisticsV3Status(raw, limits)).toThrow();
    expect(() => validateStatisticsV3Status(status(), rawLimits)).toThrow();
    expect(validateStatisticsV3Status({ ...status(), a: null }, rawLimits).raw_recording).toBeNull();
    expect(validateStatisticsV3Status({ ...status(), a: null }, limits).raw_recording).toBeNull();
    expect(validateStatisticsV3Status({ ...status(), a: [0, 0, 0, 0, 0, 0] }, rawLimits).raw_recording?.synced).toBe(0);
    for (const bad of [[1, 2, 0, 0, 0, 0], [2, 1, 2, 0, 0, 0], [null, 0, 0, 0, 0, 0], [1, 1, 1, -1, 0, 0]]) {
      expect(() => validateStatisticsV3Status({ ...status(), a: bad }, rawLimits)).toThrow();
    }
    const earlier = validateStatisticsV3Status(raw, rawLimits), later = clone(earlier); later.seq++;
    later.raw_recording!.queue_drops = 0; expect(() => assertStatisticsV3StatusOrder(earlier, later)).toThrow();
    later.raw_recording = null; expect(() => assertStatisticsV3StatusOrder(earlier, later)).not.toThrow();
  });
});

describe('private visibility segment semantics and bounded latest revisions', () => {
  it('normalizes terminal events without per-address identity and gates snapshot mode', () => {
    const e = event(); expect(validateStatisticsV3Event(e, limits)).toMatchObject({ kind: 'visibility_segment', state: 'closed', revision: 1 });
    e.s = 'open'; e.c = 'snapshot'; e.e = null; e.u = [...e.l]; e.r[2] = 0; e.r[3] = 2000;
    expect(() => validateStatisticsV3Event(e, limits)).toThrow();
    const revisions = { ...limits, temporal: { ...limits.temporal!, report_mode: 'revisions' as const } };
    expect(validateStatisticsV3Event(e, revisions).end).toBeNull();
    expect(() => validateStatisticsV3Event(e, { ...limits, temporal: undefined })).toThrow();
  });
  it.each([
    ['ordinary timeout closure', (e: ReturnType<typeof event>) => { e.c = 'timeout'; }],
    ['terminal without end', (e: ReturnType<typeof event>) => { e.e = null; }],
    ['cross-epoch segment', (e: ReturnType<typeof event>) => { e.l[2] = 2; }],
    ['observation cutoff before last seen', (e: ReturnType<typeof event>) => { e.u = [...e.a]; }],
    ['observation cutoff after logical end', (e: ReturnType<typeof event>) => { e.u[0] += 1000; e.u[1]! += 1000; }],
    ['backwards last seen', (e: ReturnType<typeof event>) => { e.l[0] = 0; }],
    ['mixed clock reliability', (e: ReturnType<typeof event>) => { e.l[1] = null; e.l[3] = null; }],
    ['coverage beyond elapsed', (e: ReturnType<typeof event>) => { e.r[3] = 5001; }],
    ['too many slices', (e: ReturnType<typeof event>) => { e.r[2] = 5; }],
    ['closed after table loss', (e: ReturnType<typeof event>) => { e.f = 4; }],
    ['closed with scan gap', (e: ReturnType<typeof event>) => { e.f = 2; }],
    ['closed without absent slices', (e: ReturnType<typeof event>) => { e.r[2] = 0; }],
    ['closed without elapsed gap', (e: ReturnType<typeof event>) => { e.e = [...e.l]; e.r[3] = 2000; }],
    ['unknown flag', (e: ReturnType<typeof event>) => { e.f = 32; }],
  ])('rejects %s', (_name, mutate) => { const e = event(); mutate(e); expect(() => validateStatisticsV3Event(e, limits)).toThrow(); });
  it('requires explicit censorship for timeout and capacity', () => {
    const e = event(); e.s = 'censored'; e.c = 'timeout';
    expect(() => validateStatisticsV3Event(e, limits)).toThrow(); e.f = 8;
    expect(validateStatisticsV3Event(e, limits).state).toBe('censored');
    e.c = 'capacity'; e.f = 12; expect(validateStatisticsV3Event(e, limits).quality_mask).toBe(12);
    e.c = 'scan_gap'; e.f = 10; expect(validateStatisticsV3Event(e, limits).cause).toBe('scan_gap');
    e.c = 'late_report'; expect(validateStatisticsV3Event(e, limits).cause).toBe('late_report');
  });
  it('supports explicitly negotiated 5000 ms temporal slices and 12 bin capabilities', () => {
    const e = event(); e.e![0] += 2000; e.e![1]! += 2000; e.u = [...e.e!]; e.r = [2, 1, 1, 7000, 2, -120, -60, -60];
    expect(validateStatisticsV3Event(e, { ...limits, temporal: { ...limits.temporal!, slice_ms: 5000 } }).totals.present_slices).toBe(1);
    expect(() => validateStatisticsV3Window(window(), { ...limits, max_bins: 5 })).toThrow();
  });
  it('honors the negotiated observed-gap duration and requires censored loss closures', () => {
    const gapLimits = { ...limits, temporal: { ...limits.temporal!, gap_ms: 4000 } };
    const e = event(); expect(() => validateStatisticsV3Event(e, gapLimits)).toThrow();
    e.e![0] += 1000; e.e![1]! += 1000; e.u = [...e.e!];
    expect(validateStatisticsV3Event(e, gapLimits).state).toBe('closed');
    for (const flag of [2, 4]) {
      e.f = flag; expect(() => validateStatisticsV3Event(e, gapLimits)).toThrow();
      e.s = 'censored'; e.c = flag === 2 ? 'scan_gap' : 'capacity'; e.f |= 8;
      expect(validateStatisticsV3Event(e, gapLimits).state).toBe('censored');
      e.s = 'closed'; e.c = 'observed_gap';
    }
  });
  it('requires cumulative RSSI changes to be realizable by only the added samples', () => {
    const previous = validateStatisticsV3Event(event(), limits);
    const revision = (samples: number, sum: number, min: number, max: number) => {
      const wire = event(); wire.q++; wire.v++; wire.r[0] = Math.max(wire.r[0], samples);
      wire.r.splice(4, 4, samples, sum, min, max);
      return validateStatisticsV3Event(wire, limits);
    };
    for (const next of [
      revision(3, -180, -70, -50), // No new samples can introduce extrema.
      revision(4, -240, -70, -50), // One new sample cannot introduce both extrema.
      revision(4, -230, -70, -50), // Added -50 cannot also introduce the new -70 minimum.
      revision(5, -290, -70, -50), // Two new extrema require an added sum of -120.
    ]) expect(() => assertStatisticsV3EventRevision(previous, next, limits)).toThrow();
    for (const next of [revision(3, -180, -60, -60), revision(4, -250, -70, -60), revision(5, -300, -70, -50)]) {
      expect(() => assertStatisticsV3EventRevision(previous, next, limits)).not.toThrow();
    }
  });
  it('rejects stale revisions, immutable start/version changes, regressing totals and terminal reopening', () => {
    const previous = validateStatisticsV3Event(event(), limits), next = clone(previous);
    next.seq++; next.revision++;
    expect(() => assertStatisticsV3EventRevision(previous, next, limits)).not.toThrow();
    expect(() => assertStatisticsV3EventRevision(previous, previous, limits)).toThrow();
    for (const mutate of [
      (e: typeof next) => { e.start.mono_ms++; }, (e: typeof next) => { e.totals.reports--; },
      (e: typeof next) => { e.state = 'open'; }, (e: typeof next) => { e.rssi.sum_dbm--; },
      (e: typeof next) => { e.observed_until.mono_ms--; },
      (e: typeof next) => { e.versions.ruleset_version = 'other'; },
    ]) { const bad = clone(next); mutate(bad); expect(() => assertStatisticsV3EventRevision(previous, bad, limits)).toThrow(); }
    next.revision = 3; expect(() => assertStatisticsV3EventRevision(previous, next, limits)).toThrow(); next.quality_mask |= 16;
    expect(() => assertStatisticsV3EventRevision(previous, next, limits)).not.toThrow();
    expect(() => assertStatisticsV3EventRevision(null, { ...next, quality_mask: 0 }, limits)).toThrow();
  });
  it('requires an explicit observation cutoff and separates a censored absence tail from later logical closure', () => {
    const body = statisticsCensoredEventFixture(), e = body.x[0];
    expect(statisticsFixtureBytes(statisticsEventFixture()).byteLength).toBe(610);
    expect(statisticsFixtureBytes(body).byteLength).toBe(613);
    const parsed = validateStatisticsV3Event(e, limits);
    expect(parsed).toMatchObject({ state: 'censored', cause: 'lease_expired', last_seen: { mono_ms: 3000 }, observed_until: { mono_ms: 6000 }, end: { mono_ms: 9000 },
      totals: { present_slices: 3, absent_slices: 3, coverage_ms: 5000 } });
    expect(parsed.last_seen.mono_ms).toBeLessThan(parsed.observed_until.mono_ms);
    expect(parsed.observed_until.mono_ms).toBeLessThan(parsed.end!.mono_ms);
    const { u: _omitted, ...missingCutoff } = e;
    expect(() => validateStatisticsV3Event(missingCutoff, limits)).toThrow();
    expect(() => validateStatisticsV3Event({ ...e, u: null }, limits)).toThrow();
    expect(() => validateStatisticsV3Event({ ...e, r: [3, 3, 3, 5001, 3, -180, -60, -60] }, limits)).toThrow();
    expect(() => validateStatisticsV3Event({ ...e, r: [3, 3, 4, 5000, 3, -180, -60, -60] }, limits)).toThrow();
    expect(() => validateStatisticsV3Event(e, { ...limits, temporal: { ...limits.temporal!, max_event_ms: 7000 } })).toThrow();
    const closed = event(); closed.e![0] += 1000; closed.e![1]! += 1000;
    expect(() => validateStatisticsV3Event(closed, limits)).toThrow(); // Successful observed-gap closure cannot add a logical-only tail.
    const snapshots = { ...limits, temporal: { ...limits.temporal!, report_mode: 'revisions' as const } };
    expect(validateStatisticsV3Event({ ...e, s: 'open', c: 'snapshot', e: null, f: 0 }, snapshots).observed_until.mono_ms).toBe(6000);
  });
  it('requires one consistent epoch clock mapping across all event tuples', () => {
    const e = event(); e.l[1]! += 1000; e.l[3] = 1000;
    e.u[1]! += 2000; e.e![1]! += 2000;
    // Adjacent a/l and l/u uncertainty intervals touch, but a and u/e do not.
    expect(() => validateStatisticsV3Event(e, limits)).toThrow();
    const unknown = event();
    for (const time of [unknown.a, unknown.l, unknown.u, unknown.e!]) { time[1] = null; time[3] = null; }
    expect(validateStatisticsV3Event(unknown, limits).observed_until.utc_ms).toBeNull();
  });
});
