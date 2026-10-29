// Read only pre-sanitized local aggregates. No serial, hardware, network or API IO.
import {readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const time = event => finite(event.device_log_ms) ? event.device_log_ms : event.at_ms;
const values = (events, keys) => events.flatMap(event => keys.filter(key => finite(event[key])).map(key => event[key]));
const minimum = items => items.length ? Math.min(...items) : null;
const maximum = items => items.length ? Math.max(...items) : null;
const numeric = (record, keys) => Object.fromEntries(keys.filter(key =>
  record && Object.hasOwn(record, key) && (record[key] === null || finite(record[key]))).map(key => [key, record[key]]));

export function rpcStats(events) {
  const rows = events.filter(event => event.kind === 'mqtt_rpc');
  const times = values(rows, ['total_ms']);
  const sorted = [...times].sort((a, b) => a - b);
  return {
    count: rows.length,
    successful: rows.filter(event => event.error === 0 && event.status >= 200 && event.status < 300).length,
    failed: rows.filter(event => event.error !== 0 || event.status < 200 || event.status >= 300).length,
    mean_ms: times.length ? times.reduce((sum, value) => sum + value, 0) / times.length : null,
    median_ms: sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null,
    worst_ms: maximum(times), max_body_bytes: maximum(values(rows, ['body_bytes'])),
    max_reply_bytes: maximum(values(rows, ['reply_bytes'])),
  };
}

export function queueTrend(rows) {
  const points = rows.filter(event => finite(event.pending) && finite(time(event)));
  if (points.length < 2) return {samples: points.length, span_seconds: null, endpoint_slots_per_minute: null, regression_slots_per_minute: null};
  const xs = points.map(event => time(event) / 60000), ys = points.map(event => event.pending);
  const meanX = xs.reduce((a, b) => a + b) / xs.length, meanY = ys.reduce((a, b) => a + b) / ys.length;
  const denominator = xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0);
  const spanMinutes = xs.at(-1) - xs[0];
  return {
    samples: points.length, span_seconds: spanMinutes * 60,
    first_pending: ys[0], last_pending: ys.at(-1), max_pending: Math.max(...ys),
    endpoint_slots_per_minute: spanMinutes > 0 ? (ys.at(-1) - ys[0]) / spanMinutes : null,
    regression_slots_per_minute: denominator > 0 ? xs.reduce((sum, x, i) => sum + (x - meanX) * (ys[i] - meanY), 0) / denominator : null,
  };
}

function allocationStats(events) {
  const rows = events.filter(event => event.kind === 'mqtt_alloc');
  const starts = values(rows, ['failures_before']), ends = values(rows, ['failures_after']);
  return {
    samples: rows.length,
    counter_first: starts[0] ?? null, counter_last: ends.at(-1) ?? null,
    counter_delta: starts.length && ends.length ? ends.at(-1) - starts[0] : null,
    during_rpc_delta: rows.reduce((sum, event) => sum + Math.max(0, (event.failures_after ?? 0) - (event.failures_before ?? 0)), 0),
    max_failed_request_bytes: maximum(rows.filter(event => event.failures_after > 0).map(event => event.last_bytes).filter(finite)),
  };
}

function heapStats(events) {
  return {
    min_free_bytes: minimum(values(events, ['free', 'internal_free', 'free_after', 'internal_after', 'internal_min'])),
    min_largest_block_bytes: minimum(values(events, ['largest', 'internal_largest', 'largest_after'])),
  };
}

export function analyze(device, cloud = null, options = {}) {
  if (device.raw_serial_or_identifiers_stored !== false || !Array.isArray(device.events))
    throw new Error('Expected a pre-sanitized performance-device-safe aggregate');
  const warmupMs = options.warmupMs ?? 0;
  if (!finite(warmupMs) || warmupMs < 0) throw new Error('Invalid warmupMs');
  const cutoff = device.discard_buffered_before_device_ms ?? 0;
  const events = device.events.filter(event => finite(time(event)) && time(event) >= cutoff).sort((a, b) => time(a) - time(b));
  const states = events.filter(event => event.kind === 'pipeline_state');
  const activeFrom = states.find(event => event.collecting === 1);
  const activeStart = activeFrom ? time(activeFrom) + warmupMs : null;
  const active = activeStart === null ? [] : events.filter(event => time(event) >= activeStart);
  // State samples are periodic. This is the observed active-state span, not a
  // claim that the first sample is the actual collection start instant.
  const activeStates = active.filter(event => event.kind === 'pipeline_state' && event.collecting === 1);
  const reportStates = activeStates.filter(event => finite(event.reports_seen));
  const reportSpan = reportStates.length > 1 ? (time(reportStates.at(-1)) - time(reportStates[0])) / 1000 : 0;
  const currentRpc = [], inheritedRpc = [];
  let previousRpc;
  for (const event of events) {
    if (event.kind === 'mqtt_rpc') previousRpc = event;
    if (event.upload_stream !== undefined && previousRpc && time(event) - time(previousRpc) <= 100 &&
        event.upload_body_bytes === previousRpc.body_bytes) {
      (event.current_boot === 1 ? currentRpc : inheritedRpc).push(previousRpc);
      previousRpc = undefined;
    }
  }
  const lossKeys = ['callbacks_dropped', 'observer_rejected', 'windows_dropped', 'storage_drops', 'summary_drops',
    'raw_drops', 'upload_failures', 'ack_failures', 'seal_overflows'];
  const lossMaxima = Object.fromEntries(lossKeys.map(key => [key, maximum(values(events, [key]))]));
  const pressureStopped = device.capacity_pressure_stop === true || events.some(event => event.memory_pause === true);
  const continuousTargetMet = finite(device.continuous_active_ms) && finite(device.target_active_ms) &&
    device.continuous_active_ms >= device.target_active_ms && device.target_active_ms > 0;
  const result = {
    evidence: 'Local pre-sanitized numeric observations; no capacity PASS is inferred',
    observation: pressureStopped ? 'incomplete-pressure-stop' : device.complete === true && continuousTargetMet ?
      'completed-observation-requires-review' : 'incomplete-observation',
    complete_flag: device.complete === true, continuous_target_met: continuousTargetMet,
    capture_active_target_flag: device.active_target_met ?? null,
    same_boot: device.same_boot === true, crash: device.crash === true,
    observed_seconds: device.observed_seconds ?? null, continuous_active_ms: device.continuous_active_ms ?? null,
    target_active_ms: device.target_active_ms ?? null,
    buffered_cutoff_device_ms: cutoff, warmup_ms: warmupMs,
    first_active_state_device_ms: activeFrom ? time(activeFrom) : null,
    rpc_all_observed: rpcStats(events),
    rpc_reused: rpcStats(events.filter(event => event.reused === 1)),
    rpc_successful_reused: rpcStats(events.filter(event => event.reused === 1 && event.error === 0 && event.status >= 200 && event.status < 300)),
    rpc_current_boot_ingest: rpcStats(currentRpc), rpc_inherited_boot_ingest: rpcStats(inheritedRpc),
    rpc_after_active_warmup: rpcStats(active),
    allocation_all_observed: allocationStats(events), allocation_after_active_warmup: allocationStats(active),
    heap_all_observed: heapStats(events), heap_after_active_warmup: heapStats(active),
    received_report_state_span: {
      samples: reportStates.length, span_seconds: reportSpan || null,
      reports_delta: reportSpan > 0 ? reportStates.at(-1).reports_seen - reportStates[0].reports_seen : null,
      reports_per_second: reportSpan > 0 ? (reportStates.at(-1).reports_seen - reportStates[0].reports_seen) / reportSpan : null,
    },
    active_state_queue: queueTrend(activeStates),
    active_queue_scope: 'Pipeline pending slot count after first active sample, buffered cutoff and optional warmup; not bytes or full-run capacity',
    software_counter_maxima: lossMaxima,
    max_seal_wait_ms: maximum(values(events, ['seal_wait_max_ms'])),
    max_persist_ms: maximum(values(events, ['persist_max_ms'])),
    cloud: null,
  };
  if (cloud) {
    const bound = cloud.same_observed_boot === true && device.version === cloud.firmware_version;
    const uptime = cloud.latest_status_numeric?.uptime_ms;
    result.cloud = {
      same_boot_and_version_bound: bound,
      time_aligned_to_serial_span: finite(uptime) && events.length > 0 && uptime >= time(events[0]) && uptime <= time(events.at(-1)),
      scope: 'Independent snapshot; totals may extend beyond serial capture and are not serial-cohort deltas',
      expected_policy_is_desired: cloud.expected_policy_is_desired === true,
      expected_policy_is_applied: cloud.expected_policy_is_applied === true,
      summary_policy: numeric(cloud.actual_policy?.summary, ['window_ms', 'bin_ms', 'max_addresses']),
      upload_policy: numeric(cloud.actual_policy?.upload_policy, ['max_items', 'max_body_bytes', 'flush_max_age_ms']),
      full_windows: bound ? numeric(cloud.full_windows, ['windows', 'min_addresses', 'max_addresses', 'mean_addresses', 'reports', 'aggregation_drops', 'overflowing_windows']) : null,
      latest_loss_totals: bound ? numeric(cloud.latest_status_loss_totals, ['aggregation_drops', 'raw_queue_drops', 'storage_drops', 'windows_dropped', 'upload_failures', 'ack_failures', 'address_summaries_dropped', 'address_table_overflow_reports', 'accounting_overrun_reports', 'unpersisted_window_reports']) : null,
      latest_pending_by_stream: bound ? numeric(cloud.latest_status_queue_pending, ['ble_windows', 'ble_reports', 'node_status', 'address_summaries']) : null,
      batches_by_stream: bound ? (cloud.current_boot_policy_batches ?? []).filter(row => ['address_summaries', 'ble_windows', 'node_status', 'ble_reports'].includes(row.stream)).map(row => ({stream: row.stream, ...numeric(row, ['batches', 'items'])})) : null,
    };
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [devicePath, cloudPath, outputPath, optionsJson] = process.argv.slice(2);
  if (!devicePath || !cloudPath || !outputPath)
    throw new Error('Usage: node analyze-device.mjs DEVICE_SAFE.json CLOUD_SAFE.json|- OUTPUT.json [OPTIONS_JSON]');
  const result = analyze(JSON.parse(readFileSync(devicePath, 'utf8')),
    cloudPath === '-' ? null : JSON.parse(readFileSync(cloudPath, 'utf8')), optionsJson ? JSON.parse(optionsJson) : {});
  const text = JSON.stringify(result, null, 2) + '\n';
  writeFileSync(outputPath, text);
  console.log(text);
}
