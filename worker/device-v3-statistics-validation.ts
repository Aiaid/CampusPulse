/** Strict compact statistics/1 validation. No authorization, persistence or radio-truth claim. */
import { IngestError, parseIngestJson } from './strict-json';

export const STATISTICS_V3_STREAMS = ['window_statistics', 'candidate_events', 'node_status'] as const;
export type StatisticsV3Stream = typeof STATISTICS_V3_STREAMS[number];
export interface StatisticsV3Limits {
  window_ms: number; bin_ms: number; max_addresses: number; max_bins?: number;
  extractor_version: string; ruleset_version: string;
  max_batch_items: number; max_body_bytes: number; streams: readonly StatisticsV3Stream[];
  local_raw_mode?: 'off' | 'tf_cpraw';
  /** Frozen boot medium's physical body capacity; policy stream reserves are minimums. */
  queue: { max_items: number; max_bytes: number; stream_reserves: readonly { stream: string; items: number; bytes: number }[] };
  temporal?: { slice_ms: number; gap_ms?: number; max_event_ms: number; report_mode: 'off' | 'terminal_only' | 'revisions'; min_update_ms: number };
}
export interface StatisticsV3Time { mono_ms: number; utc_ms: number | null; clock_epoch: number; uncertainty_ms: number | null }
export interface StatisticsV3Rssi { samples: number; sum_dbm: number; min_dbm: number | null; max_dbm: number | null }
export interface StatisticsV3Versions { extractor_version: string; ruleset_version: string }
export interface StatisticsV3Window {
  seq: number; window_seq: number; time: StatisticsV3Time; duration_ms: number; bin_ms: number;
  categories: Record<'phone_candidate' | 'e_bike_candidate' | 'car_candidate' | 'other' | 'unknown' | 'conflicting', number>;
  visible_identifiers: number; estimated_total: null;
  reports: { received: number; worker: number; adv: number; scan_response: number };
  bins: { worker_reports: number; visible_identifiers: number; rssi_samples: number; rssi_sum_dbm: number }[];
  rssi: StatisticsV3Rssi;
  losses: { scan_coverage_ms: number; callback_drops: number; aggregation_drops: number; address_overflow_reports: number };
  quality_mask: number; versions: StatisticsV3Versions;
}
export interface StatisticsV3Event {
  seq: number; event_id: string; revision: number; kind: 'visibility_segment'; state: 'open' | 'closed' | 'censored';
  start: StatisticsV3Time; last_seen: StatisticsV3Time; observed_until: StatisticsV3Time; end: StatisticsV3Time | null;
  totals: { reports: number; present_slices: number; absent_slices: number; coverage_ms: number };
  rssi: StatisticsV3Rssi;
  cause: 'snapshot' | 'observed_gap' | 'timeout' | 'capacity' | 'clock_change' | 'config_change' | 'placement_change' | 'reboot' | 'lease_expired' | 'scan_gap' | 'late_report';
  quality_mask: number; versions: StatisticsV3Versions;
}
export interface StatisticsV3Status {
  seq: number; time: StatisticsV3Time; uptime_ms: number; collection_state: 'running' | 'paused' | 'failed';
  memory: Record<'internal_free' | 'internal_min' | 'largest_internal_block' | 'psram_free' | 'stack_min', number | null>;
  queue: Record<StatisticsV3Stream, { pending_items: number; pending_bytes: number }>;
  losses: Record<'window_drops' | 'event_drops' | 'status_coalesced' | 'upload_failures' | 'ack_failures' | 'retries', number>;
  raw_recording: Record<'enqueued' | 'written' | 'synced' | 'queue_drops' | 'storage_failures' | 'space_stops', number> | null;
}
export interface StatisticsV3Envelope {
  protocol: 'campuspulse/3'; schema: 'statistics/1'; batch_id: string; node_id: string; boot_id: string;
  policy_id: string; policy_sha256: string; assignment_generation: number;
  dataset: 'field' | 'demo' | 'controlled_test'; stream: StatisticsV3Stream; items: unknown[];
}
export type StatisticsV3Batch = Omit<StatisticsV3Envelope, 'stream' | 'items'> & (
  { stream: 'window_statistics'; items: StatisticsV3Window[] } |
  { stream: 'candidate_events'; items: StatisticsV3Event[] } |
  { stream: 'node_status'; items: StatisticsV3Status[] });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[0-9a-f]{64}$/;
const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}$/;
function fail(code = 'invalid_v3_statistics'): never { throw new IngestError(422, code, 'Invalid compact statistics batch; preserve the frozen original.'); }
function object(value: unknown, keys: readonly string[], optional: readonly string[] = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k) && !optional.includes(k)) || keys.some(k => !Object.hasOwn(value, k))) fail();
  return value as Record<string, unknown>;
}
function tuple(value: unknown, length: number): unknown[] { return Array.isArray(value) && value.length === length ? value : fail(); }
function int(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : fail();
}
const seq = (value: unknown) => int(value, 1, 0xffffffff);
function string(value: unknown, re: RegExp): string { return typeof value === 'string' && re.test(value) ? value : fail(); }
function choice<const T extends string>(value: unknown, values: readonly T[]): T { return typeof value === 'string' && values.includes(value as T) ? value as T : fail(); }
function sum(values: number[]) { return int(values.reduce((a, b) => a + b, 0)); }
function requireFlag(mask: number, flag: number, condition: boolean) { if (condition && !(mask & flag)) fail(); }
function boundedRssiSum(value: unknown, count: number, min = -127, max = 20): number {
  const total = int(value, Number.MIN_SAFE_INTEGER), n = BigInt(count), s = BigInt(total);
  if (s < BigInt(min) * n || s > BigInt(max) * n) fail();
  return total;
}

/** Uses the shared duplicate-decoded-key/UTF-8 scanner, before object validation. */
export function parseStatisticsV3Json(bytes: Uint8Array, maxBodyBytes = 8192): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > Math.min(8192, int(maxBodyBytes, 1))) throw new IngestError(413, 'body_too_large', 'Statistics body exceeds its negotiated bound.');
  return parseIngestJson(bytes);
}
export function statisticsV3Time(value: unknown): StatisticsV3Time {
  const t = tuple(value, 4), mono_ms = int(t[0]), clock_epoch = int(t[2], 1);
  if ((t[1] === null) !== (t[3] === null)) fail();
  return { mono_ms, utc_ms: t[1] === null ? null : int(t[1], 0, 8640000000000000), clock_epoch,
    uncertainty_ms: t[3] === null ? null : int(t[3], 0, 8640000000000000) };
}
function rssi(value: unknown, maxSamples: number): StatisticsV3Rssi {
  const t = tuple(value, 4), samples = int(t[0], 0, maxSamples), sum_dbm = boundedRssiSum(t[1], samples);
  if (!samples) { if (t[2] !== null || t[3] !== null || sum_dbm !== 0) fail(); return { samples, sum_dbm, min_dbm: null, max_dbm: null }; }
  const min_dbm = int(t[2], -127, 20), max_dbm = int(t[3], min_dbm, 20);
  boundedRssiSum(sum_dbm, samples, min_dbm, max_dbm);
  if (samples === 1 && min_dbm !== max_dbm) fail();
  // Both extrema represent actual samples, so the sum must leave room for each.
  if (BigInt(sum_dbm) < BigInt(max_dbm) + BigInt(min_dbm) * BigInt(samples - 1) || BigInt(sum_dbm) > BigInt(min_dbm) + BigInt(max_dbm) * BigInt(samples - 1)) fail();
  return { samples, sum_dbm, min_dbm, max_dbm };
}
function versions(value: unknown, limits: StatisticsV3Limits): StatisticsV3Versions {
  const v = tuple(value, 2), extractor_version = string(v[0], LABEL), ruleset_version = string(v[1], LABEL);
  if (extractor_version !== limits.extractor_version || ruleset_version !== limits.ruleset_version) fail('v3_statistics_version_unavailable');
  return { extractor_version, ruleset_version };
}
export function validateStatisticsV3Envelope(value: unknown): StatisticsV3Envelope {
  const o = object(value, ['p', 'z', 'b', 'n', 'o', 'c', 'h', 'g', 'd', 'k', 'x']);
  if (o.p !== 3 || o.z !== 'statistics/1' || !Array.isArray(o.x) || o.x.length < 1 || o.x.length > 128) fail();
  const stream = choice(o.k, STATISTICS_V3_STREAMS);
  if (stream === 'node_status' && o.x.length !== 1) fail();
  return { protocol: 'campuspulse/3', schema: 'statistics/1', batch_id: string(o.b, UUID), node_id: string(o.n, ID), boot_id: string(o.o, UUID),
    policy_id: string(o.c, ID), policy_sha256: string(o.h, HASH), assignment_generation: int(o.g, 1), dataset: choice(o.d, ['field', 'demo', 'controlled_test']), stream, items: o.x };
}
export function validateStatisticsV3Window(value: unknown, limits: StatisticsV3Limits): StatisticsV3Window {
  const o = object(value, ['q', 'w', 't', 'd', 'b', 'c', 'r', 'x', 's', 'l', 'f', 'v']);
  const time = statisticsV3Time(o.t), duration_ms = int(o.d, 1, limits.window_ms), bin_ms = int(o.b, 1), quality_mask = int(o.f, 0, 63);
  if (bin_ms !== limits.bin_ms || duration_ms > time.mono_ms || !Array.isArray(o.x) || o.x.length !== Math.ceil(duration_ms / bin_ms) || o.x.length > Math.min(60, limits.max_bins ?? 60)) fail();
  requireFlag(quality_mask, 1, duration_ms !== limits.window_ms);
  requireFlag(quality_mask, 2, time.utc_ms === null || time.uncertainty_ms! > 0);
  const c = tuple(o.c, 6).map(v => int(v, 0, limits.max_addresses)), visible_identifiers = sum(c);
  if (visible_identifiers > limits.max_addresses || limits.max_addresses > 512) fail();
  const version = versions(o.v, limits);
  if (version.ruleset_version === 'unclassified-v1' && c.some((n, i) => i !== 4 && n !== 0)) fail();
  const r = tuple(o.r, 4).map(v => int(v)), [received, worker, adv, scan_response] = r;
  if (sum([adv, scan_response]) !== worker || received < worker || visible_identifiers > worker) fail();
  const aggregate = rssi(o.s, worker);
  const bins = o.x.map(v => {
    const b = tuple(v, 4), worker_reports = int(b[0], 0, worker), identifiers = int(b[1], 0, Math.min(visible_identifiers, worker_reports));
    const rssi_samples = int(b[2], 0, worker_reports), rssi_sum_dbm = boundedRssiSum(b[3], rssi_samples);
    if (rssi_samples) boundedRssiSum(rssi_sum_dbm, rssi_samples, aggregate.min_dbm ?? -127, aggregate.max_dbm ?? 20);
    return { worker_reports, visible_identifiers: identifiers, rssi_samples, rssi_sum_dbm };
  });
  if (sum(bins.map(b => b.worker_reports)) !== worker || sum(bins.map(b => b.visible_identifiers)) < visible_identifiers || sum(bins.map(b => b.rssi_samples)) !== aggregate.samples || bins.reduce((a, b) => a + BigInt(b.rssi_sum_dbm), 0n) !== BigInt(aggregate.sum_dbm)) fail();
  if (aggregate.samples) {
    // An advertised extremum must be achievable in at least one bin. For a
    // one-sample bin its sum determines that sample exactly.
    const canContain = (extremum: number) => bins.some(b => b.rssi_samples > 0 &&
      BigInt(b.rssi_sum_dbm) - BigInt(extremum) >= BigInt(aggregate.min_dbm!) * BigInt(b.rssi_samples - 1) &&
      BigInt(b.rssi_sum_dbm) - BigInt(extremum) <= BigInt(aggregate.max_dbm!) * BigInt(b.rssi_samples - 1));
    if (!canContain(aggregate.min_dbm!) || !canContain(aggregate.max_dbm!)) fail();
  }
  const l = tuple(o.l, 4), scan_coverage_ms = int(l[0], 0, duration_ms), callback_drops = int(l[1]), aggregation_drops = int(l[2]), address_overflow_reports = int(l[3]);
  if (BigInt(worker) + BigInt(callback_drops) + BigInt(aggregation_drops) > BigInt(received)) fail();
  requireFlag(quality_mask, 4, scan_coverage_ms < duration_ms); requireFlag(quality_mask, 8, address_overflow_reports > 0);
  requireFlag(quality_mask, 16, callback_drops > 0); requireFlag(quality_mask, 32, aggregation_drops > 0);
  return { seq: seq(o.q), window_seq: seq(o.w), time, duration_ms, bin_ms,
    categories: { phone_candidate: c[0], e_bike_candidate: c[1], car_candidate: c[2], other: c[3], unknown: c[4], conflicting: c[5] },
    visible_identifiers, estimated_total: null, reports: { received, worker, adv, scan_response }, bins, rssi: aggregate,
    losses: { scan_coverage_ms, callback_drops, aggregation_drops, address_overflow_reports }, quality_mask, versions: version };
}
function orderedTimes(a: StatisticsV3Time, b: StatisticsV3Time) {
  if (a.clock_epoch !== b.clock_epoch || b.mono_ms < a.mono_ms || (a.utc_ms === null) !== (b.utc_ms === null)) fail();
  if (a.utc_ms !== null && b.utc_ms !== null) {
    const discrepancy = BigInt(b.utc_ms) - BigInt(a.utc_ms) - (BigInt(b.mono_ms) - BigInt(a.mono_ms));
    const tolerance = BigInt(a.uncertainty_ms!) + BigInt(b.uncertainty_ms!);
    if (discrepancy < -tolerance || discrepancy > tolerance) fail();
  }
}
export function validateStatisticsV3Event(value: unknown, limits: StatisticsV3Limits): StatisticsV3Event {
  const o = object(value, ['q', 'i', 'v', 'k', 's', 'a', 'l', 'u', 'e', 'r', 'c', 'f', 'x']);
  const temporal = limits.temporal;
  if (!temporal || temporal.report_mode === 'off') fail('v3_statistics_events_unavailable');
  const state = choice(o.s, ['open', 'closed', 'censored']), cause = choice(o.c, ['snapshot', 'observed_gap', 'timeout', 'capacity', 'clock_change', 'config_change', 'placement_change', 'reboot', 'lease_expired', 'scan_gap', 'late_report']);
  const start = statisticsV3Time(o.a), last_seen = statisticsV3Time(o.l), observed_until = statisticsV3Time(o.u), end = o.e === null ? null : statisticsV3Time(o.e), quality_mask = int(o.f, 0, 31);
  const times = [start, last_seen, observed_until, ...(end ? [end] : [])];
  for (let i = 1; i < times.length; i++) orderedTimes(times[i - 1], times[i]);
  // Every tuple in one clock epoch must admit the same UTC-minus-monotonic
  // mapping, rather than using intermediate uncertainty to conceal a jump.
  if (start.utc_ms !== null) {
    const offsets = times.map(t => ({ low: BigInt(t.utc_ms!) - BigInt(t.mono_ms) - BigInt(t.uncertainty_ms!), high: BigInt(t.utc_ms!) - BigInt(t.mono_ms) + BigInt(t.uncertainty_ms!) }));
    const low = offsets.reduce((a, b) => a > b.low ? a : b.low, offsets[0].low), high = offsets.reduce((a, b) => a < b.high ? a : b.high, offsets[0].high);
    if (low > high) fail();
  }
  const observedElapsed = observed_until.mono_ms - start.mono_ms, lifetime = (end ?? observed_until).mono_ms - start.mono_ms;
  if (lifetime > temporal.max_event_ms || state === 'open' && (end !== null || cause !== 'snapshot' || temporal.report_mode !== 'revisions') ||
      state !== 'open' && end === null || state === 'closed' && cause !== 'observed_gap' || state === 'censored' && ['snapshot', 'observed_gap'].includes(cause)) fail();
  if (state === 'closed' && JSON.stringify(end) !== JSON.stringify(observed_until)) fail();
  requireFlag(quality_mask, 8, state === 'censored');
  if (state !== 'censored' && (quality_mask & (2 | 4 | 8))) fail();
  const r = tuple(o.r, 8), reports = int(r[0]), present_slices = int(r[1]), absent_slices = int(r[2]), coverage_ms = int(r[3], 0, observedElapsed);
  if (present_slices > reports || reports > 0 && present_slices === 0 || sum([present_slices, absent_slices]) > Math.floor(observedElapsed / temporal.slice_ms) + 1) fail();
  if (state === 'closed' && (absent_slices === 0 || observed_until.mono_ms - last_seen.mono_ms < (temporal.gap_ms ?? temporal.slice_ms))) fail();
  if ((quality_mask & (2 | 4)) && state === 'closed') fail();
  return { seq: seq(o.q), event_id: string(o.i, UUID), revision: int(o.v, 1), kind: choice(o.k, ['visibility_segment']), state, start, last_seen, observed_until, end,
    totals: { reports, present_slices, absent_slices, coverage_ms }, rssi: rssi(r.slice(4), reports), cause, quality_mask, versions: versions(o.x, limits) };
}
const MEMORY = ['internal_free', 'internal_min', 'largest_internal_block', 'psram_free', 'stack_min'] as const;
export const STATISTICS_V3_STATUS_LOSSES = ['window_drops', 'event_drops', 'status_coalesced', 'upload_failures', 'ack_failures', 'retries'] as const;
export const STATISTICS_V3_RAW_COUNTERS = ['enqueued', 'written', 'synced', 'queue_drops', 'storage_failures', 'space_stops'] as const;
export function validateStatisticsV3Status(value: unknown, limits: StatisticsV3Limits): StatisticsV3Status {
  const o = object(value, ['q', 't', 'u', 's', 'r', 'j', 'l'], ['a']), time = statisticsV3Time(o.t), uptime_ms = int(o.u);
  if (time.mono_ms !== uptime_ms) fail();
  const r = tuple(o.r, 5), j = tuple(o.j, 6), l = tuple(o.l, 6);
  const memory = Object.fromEntries(MEMORY.map((name, i) => [name, r[i] === null ? null : int(r[i])])) as StatisticsV3Status['memory'];
  if (memory.internal_free !== null && (memory.internal_min !== null && memory.internal_min > memory.internal_free || memory.largest_internal_block !== null && memory.largest_internal_block > memory.internal_free)) fail();
  const queue = {} as StatisticsV3Status['queue'];
  for (const [i, stream] of STATISTICS_V3_STREAMS.entries()) {
    // Reserves are minimum admission guarantees, not stream occupancy caps.
    // Boot-wide backlog can include an older policy's now-disabled stream.
    const pending_items = int(j[i * 2], 0, limits.queue.max_items), pending_bytes = int(j[i * 2 + 1], 0, limits.queue.max_bytes);
    if ((pending_items === 0) !== (pending_bytes === 0)) fail();
    queue[stream] = { pending_items, pending_bytes };
  }
  // j excludes control records; the client also enforces their actual occupancy.
  if (sum(Object.values(queue).map(q => q.pending_items)) > limits.queue.max_items || sum(Object.values(queue).map(q => q.pending_bytes)) > limits.queue.max_bytes) fail();
  const losses = Object.fromEntries(STATISTICS_V3_STATUS_LOSSES.map((name, i) => [name, int(l[i])])) as StatisticsV3Status['losses'];
  const rawMode = limits.local_raw_mode ?? 'off';
  if (rawMode === 'tf_cpraw' && !Object.hasOwn(o, 'a') || rawMode === 'off' && o.a !== undefined && o.a !== null) fail();
  let raw_recording: StatisticsV3Status['raw_recording'] = null;
  if (o.a !== undefined && o.a !== null) {
    const a = tuple(o.a, 6);
    raw_recording = Object.fromEntries(STATISTICS_V3_RAW_COUNTERS.map((name, i) => [name, int(a[i])])) as NonNullable<StatisticsV3Status['raw_recording']>;
    if (raw_recording.synced > raw_recording.written || raw_recording.written > raw_recording.enqueued) fail();
  }
  return { seq: seq(o.q), time, uptime_ms, collection_state: choice(o.s, ['running', 'paused', 'failed']), memory, queue, losses, raw_recording };
}
/** The store must compare both adjacent sequence anchors, including delayed inserts. */
export function assertStatisticsV3StatusOrder(earlier: StatisticsV3Status, later: StatisticsV3Status): void {
  if (later.seq <= earlier.seq || later.uptime_ms < earlier.uptime_ms || later.time.clock_epoch < earlier.time.clock_epoch || STATISTICS_V3_STATUS_LOSSES.some(k => later.losses[k] < earlier.losses[k]) ||
      earlier.raw_recording !== null && later.raw_recording !== null && STATISTICS_V3_RAW_COUNTERS.some(k => later.raw_recording![k] < earlier.raw_recording![k])) fail('v3_statistics_counter_regression');
}
/** Scoped by node+boot+policy+event_id in the caller. Never lets stale revisions replace latest state. */
export function assertStatisticsV3EventRevision(previous: StatisticsV3Event | null, next: StatisticsV3Event, limits: StatisticsV3Limits): void {
  if (!previous) { requireFlag(next.quality_mask, 16, next.revision !== 1); return; }
  if (next.event_id !== previous.event_id || next.revision <= previous.revision || next.seq <= previous.seq ||
      JSON.stringify(next.start) !== JSON.stringify(previous.start) || JSON.stringify(next.versions) !== JSON.stringify(previous.versions) ||
      previous.state !== 'open' && next.state !== previous.state || next.last_seen.mono_ms < previous.last_seen.mono_ms || next.observed_until.mono_ms < previous.observed_until.mono_ms ||
      previous.end !== null && (next.end === null || next.end.mono_ms < previous.end.mono_ms) ||
      (Object.keys(previous.totals) as (keyof StatisticsV3Event['totals'])[]).some(k => next.totals[k] < previous.totals[k]) ||
      next.rssi.samples < previous.rssi.samples) fail('v3_statistics_event_regression');
  const extraSamples = next.rssi.samples - previous.rssi.samples, extraSum = BigInt(next.rssi.sum_dbm) - BigInt(previous.rssi.sum_dbm);
  if (extraSum < -127n * BigInt(extraSamples) || extraSum > 20n * BigInt(extraSamples) || previous.rssi.samples > 0 &&
      (next.rssi.min_dbm! > previous.rssi.min_dbm! || next.rssi.max_dbm! < previous.rssi.max_dbm!)) fail('v3_statistics_event_regression');
  if (extraSamples === 0) {
    if (next.rssi.min_dbm !== previous.rssi.min_dbm || next.rssi.max_dbm !== previous.rssi.max_dbm) fail('v3_statistics_event_regression');
  } else if (previous.rssi.samples > 0) {
    // Newly expanded extrema must occur among the added samples. Reserve one
    // sample for each before checking the remaining integer sum/range bounds.
    const min = next.rssi.min_dbm!, max = next.rssi.max_dbm!;
    const required = [min < previous.rssi.min_dbm! ? min : null, max > previous.rssi.max_dbm! ? max : null]
      .filter((value): value is number => value !== null);
    const remaining = extraSamples - required.length;
    const remainder = extraSum - required.reduce((total, value) => total + BigInt(value), 0n);
    if (remaining < 0 || remainder < BigInt(min) * BigInt(remaining) || remainder > BigInt(max) * BigInt(remaining)) fail('v3_statistics_event_regression');
  }
  requireFlag(next.quality_mask, 16, next.revision !== previous.revision + 1);
}
export function normalizeStatisticsV3Batch(value: unknown, limits: StatisticsV3Limits): StatisticsV3Batch {
  const envelope = validateStatisticsV3Envelope(value);
  if (!limits.streams.includes(envelope.stream) || envelope.items.length > limits.max_batch_items) fail('v3_statistics_stream_unavailable');
  const validate = envelope.stream === 'window_statistics' ? validateStatisticsV3Window : envelope.stream === 'candidate_events' ? validateStatisticsV3Event : validateStatisticsV3Status;
  const items = envelope.items.map(item => validate(item, limits));
  for (let i = 1; i < items.length; i++) if (items[i].seq <= items[i - 1].seq) fail('v3_statistics_sequence_order');
  if (envelope.stream === 'window_statistics') {
    const identities = new Set<string>();
    for (const item of items as StatisticsV3Window[]) { const id = `${item.time.clock_epoch}:${item.window_seq}`; if (identities.has(id)) fail(); identities.add(id); }
  }
  if (envelope.stream === 'candidate_events') {
    const latest = new Map<string, StatisticsV3Event>();
    for (const item of items as StatisticsV3Event[]) { const previous = latest.get(item.event_id); if (previous) assertStatisticsV3EventRevision(previous, item, limits); latest.set(item.event_id, item); }
  }
  return { ...envelope, items } as StatisticsV3Batch;
}
