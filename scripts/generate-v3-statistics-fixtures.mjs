import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Synthetic protocol examples only. No receiver, observation, credential or applied-policy claim. */
export const STATISTICS_FIXTURE_UTC_MS = 1898553600000;
export function statisticsFixtureLimits(windowMs = 30000) {
  return { window_ms: windowMs, bin_ms: 5000, max_addresses: 512, max_bins: 12,
    extractor_version: 'cp-v3-stats/1', ruleset_version: 'unclassified-v1', max_batch_items: 16, max_body_bytes: 8192,
    streams: ['window_statistics', 'candidate_events', 'node_status'],
    queue: { max_items: 32, max_bytes: 65536, stream_reserves: [
      { stream: 'window_statistics', items: 16, bytes: 32768 },
      { stream: 'candidate_events', items: 8, bytes: 16384 }, { stream: 'node_status', items: 4, bytes: 8192 }] },
    temporal: { slice_ms: 1000, max_event_ms: 600000, report_mode: 'terminal_only', min_update_ms: 30000 } };
}
export function statisticsFixtureEnvelope(stream, items) {
  return { p: 3, z: 'statistics/1', b: '00000000-0000-4000-8000-000000000001', n: 'synthetic-template-only',
    o: '00000000-0000-4000-8000-000000000002', c: 'synthetic-template-policy', h: '0'.repeat(64), g: 1,
    d: 'controlled_test', k: stream, x: items };
}
export function statisticsWindowFixture(windowMs = 30000, knownUtc = true) {
  const binCount = windowMs / 5000;
  return statisticsFixtureEnvelope('window_statistics', [{ q: 1, w: 1,
    t: [windowMs, knownUtc ? STATISTICS_FIXTURE_UTC_MS + windowMs : null, 1, knownUtc ? 0 : null], d: windowMs, b: 5000,
    c: [0, 0, 0, 0, 2, 0], r: [binCount * 10, binCount * 10, binCount * 8, binCount * 2],
    x: Array.from({ length: binCount }, () => [10, 2, 10, -600]), s: [binCount * 10, binCount * -600, -60, -60],
    l: [windowMs, 0, 0, 0], f: knownUtc ? 0 : 2, v: ['cp-v3-stats/1', 'unclassified-v1'] }]);
}
function splitInteger(total, parts) {
  const n = BigInt(total), count = BigInt(parts), quotient = n / count, remainder = n % count;
  return Array.from({ length: parts }, (_, i) => Number(quotient + (BigInt(i) < remainder ? 1n : 0n)));
}
function longSyntheticScope(body) {
  // IDs have their maximum permitted width, while keeping their synthetic origin explicit.
  return { ...body, n: 'synthetic-node-'.padEnd(64, 'n'), c: 'synthetic-policy-'.padEnd(64, 'p') };
}
/** Dense input is invented, not a board measurement or a radio-capacity claim. */
export function statisticsDenseWindowFixture(longScope = false) {
  const body = statisticsWindowFixture(60000), item = body.x[0], reports = 20000;
  item.c = [0, 0, 0, 0, 512, 0]; item.r = [reports, reports, 16000, 4000];
  item.x = splitInteger(reports, 12).map(n => [n, 512, n, -60 * n]);
  item.s = [reports, -60 * reports, -60, -60];
  return longScope ? longSyntheticScope(body) : body;
}
/** One-window schema-width stress. These magnitudes are not physical throughput. */
export function statisticsMaxWidthWindowFixture(windowMs = 60000) {
  const body = longSyntheticScope(statisticsWindowFixture(windowMs)), item = body.x[0];
  const maximum = Number.MAX_SAFE_INTEGER, worker = Number(BigInt(maximum) / 3n), callback = worker;
  const aggregation = Number(BigInt(maximum) - BigInt(worker) - BigInt(callback));
  body.g = maximum;
  item.q = 0xffffffff; item.w = 0xffffffff;
  item.t = [maximum, 8640000000000000, maximum, 8640000000000000];
  item.d = windowMs - 1;
  item.c = [0, 0, 0, 0, 512, 0];
  const adv = Number(BigInt(worker) / 2n), scanResponse = Number(BigInt(worker) - BigInt(adv));
  item.r = [maximum, worker, adv, scanResponse];
  item.x = splitInteger(worker, windowMs / 5000).map(n => [n, 512, n, -n]);
  // Mean -1 is compatible with the stated sampled extrema; every sum stays safe.
  item.s = [worker, -worker, -127, 20];
  item.l = [item.d - 1, callback, aggregation, worker - 512]; item.f = 63;
  return body;
}
export function statisticsEventFixture() {
  const time = ms => [ms, STATISTICS_FIXTURE_UTC_MS + ms, 1, 0];
  return statisticsFixtureEnvelope('candidate_events', [{ q: 1, i: '00000000-0000-4000-8000-000000000003', v: 1,
    k: 'visibility_segment', s: 'closed', a: time(1000), l: time(3000), u: time(6000), e: time(6000),
    r: [3, 3, 3, 5000, 3, -180, -60, -60], c: 'observed_gap', f: 0, x: ['cp-v3-stats/1', 'unclassified-v1'] }]);
}
export function statisticsCensoredEventFixture() {
  const body = statisticsEventFixture(), item = body.x[0];
  item.s = 'censored'; item.c = 'lease_expired'; item.f = 8;
  // Actual observations include an absence tail. The later logical closure
  // contributes no extra report, slice or measured scan coverage.
  item.e = [9000, STATISTICS_FIXTURE_UTC_MS + 9000, 1, 0];
  return body;
}
export function statisticsStatusFixture() {
  return statisticsFixtureEnvelope('node_status', [{ q: 1, t: [60000, STATISTICS_FIXTURE_UTC_MS + 60000, 1, 0], u: 60000,
    s: 'running', r: [null, null, null, null, null], j: [1, 700, 0, 0, 1, 500], l: [0, 0, 0, 0, 0, 0] }]);
}
export function statisticsRawStatusFixture() {
  const body = statisticsStatusFixture();
  return { ...body, x: body.x.map(item => ({ ...item, a: [100, 99, 90, 1, 0, 0] })) };
}
export function statisticsFixtureBytes(value) { return new TextEncoder().encode(JSON.stringify(value)); }

export async function generateStatisticsFixtures(output = 'captures/v3-statistics-trial/templates') {
  const folder = resolve(output);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  const fixtures = { 'window-30s-5s.json': statisticsWindowFixture(30000), 'window-60s-5s.json': statisticsWindowFixture(60000),
    'window-30s-5s-unknown-clock.json': statisticsWindowFixture(30000, false),
    'window-dense-synthetic512-60s-5s.json': statisticsDenseWindowFixture(),
    'window-dense-synthetic512-long-scope-60s-5s.json': statisticsDenseWindowFixture(true),
    'window-max-width-valid-schema-60s-5s.json': statisticsMaxWidthWindowFixture(60000),
    'window-max-width-valid-schema-300s-5s.json': statisticsMaxWidthWindowFixture(300000),
    'candidate-event-terminal.json': statisticsEventFixture(), 'candidate-event-censored-absence-tail.json': statisticsCensoredEventFixture(), 'node-status.json': statisticsStatusFixture(),
    'node-status-tf-raw.json': statisticsRawStatusFixture() };
  const measurements = [];
  for (const [filename, body] of Object.entries(fixtures)) {
    const bytes = statisticsFixtureBytes(body), path = resolve(folder, filename);
    // These exact bytes (no newline) are the frozen body whose digest is sent.
    await writeFile(path, bytes, { mode: 0o600 }); await chmod(path, 0o600);
    measurements.push({ filename, body_bytes: bytes.byteLength,
      normal_window_bytes_per_minute: body.k === 'window_statistics' && !filename.includes('max-width') ? bytes.byteLength * 60000 / body.x[0].d : null,
      body_budget_1024: bytes.byteLength <= 1024 ? 'fits' : 'reject_without_truncation',
      record_budget_2048: bytes.byteLength > 2048 ? 'body_alone_exceeds_record_reject' : 'requires_actual_record_overhead_measurement',
      synthetic_scenario: filename.includes('max-width') ? 'schema_numeric_width_stress_not_physical_peak' : filename.includes('dense') ? 'invented_512_identifiers_20000_reports' : 'illustrative_only' });
  }
  const note = { synthetic_only: true, usable_as_real_ingest: false,
    description: 'Invented controlled_test examples. Replace synthetic scope and policy digest only after actual registration, applied ACK and lease. Counts are not hardware observations. No credential is included.',
    byte_scope: 'Exact uncompressed JSON envelope body; excludes HTTP/TLS, status, control, flash-record headers and retries. 1 KB/minute is a target, not a guarantee.',
    event_time_scope: 'Event u is the actual observation cutoff, which includes measured absence after last_seen l. Coverage and slices stop at u. A censored event may have a later logical end e without additional observations; an ordinary closed event requires e equal to u.',
    stress_scope: 'Max-width fixtures exercise maximum node/policy ID width, safe numeric width and the initial unclassified versions in one window: 12 bins for 60s and the schema limit of 60 bins for 300s. These are schema worst-case width examples, not measured physical peaks, a bound on every permitted batch, or a guarantee that a 1024-byte device body budget can accept every schema-valid item.',
    budget_behavior: 'Reject an over-budget frozen body; never truncate, omit bins, reduce counters, or alter identity scope to force acceptance. A 2048-byte flash record must fit the complete body plus actual record metadata. Any change from 2 to 3 slots requires device persistence and power-loss acceptance; these JSON measurements do not validate slots.', measurements };
  const manifest = resolve(folder, 'synthetic-measurements.json');
  await writeFile(manifest, JSON.stringify(note, null, 2) + '\n', { mode: 0o600 }); await chmod(manifest, 0o600);
  return { folder, ...note };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await generateStatisticsFixtures(process.argv[2]), null, 2));
}
