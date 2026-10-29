import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyze, queueTrend} from './analyze-device.mjs';

const rpc = (at, total, reused, body = 100) => ({kind: 'mqtt_rpc', device_log_ms: at, total_ms: total,
  reused, error: 0, status: 200, body_bytes: body, reply_bytes: 20});
const state = (at, pending, collecting = 1) => ({kind: 'pipeline_state', device_log_ms: at, pending, collecting,
  callbacks_dropped: 0, windows_dropped: 0, free: 30000, largest: 10000});
const input = {
  raw_serial_or_identifiers_stored: false, version: 'test-only', same_boot: true,
  complete: false, continuous_active_ms: 0, target_active_ms: 600000,
  active_target_met: true, capacity_pressure_stop: true, observed_seconds: 90,
  events: [state(0, 100, 0), rpc(1000, 6000, 0), state(30000, 10), rpc(31000, 2000, 1),
    {device_log_ms: 31010, upload_stream: 2, current_boot: 0, upload_body_bytes: 100},
    {kind: 'mqtt_alloc', device_log_ms: 31020, failures_before: 2, failures_after: 3, last_bytes: 1600},
    state(60000, 12), rpc(61000, 3000, 1),
    {device_log_ms: 61010, upload_stream: 2, current_boot: 1, upload_body_bytes: 100},
    {kind: 'mqtt_alloc', device_log_ms: 61020, failures_before: 3, failures_after: 3, last_bytes: 1600},
    state(90000, 14)],
};

test('failed/incomplete trials cannot pass via the capture active-target flag', () => {
  const result = analyze(input);
  assert.equal(result.observation, 'incomplete-pressure-stop');
  assert.equal(result.continuous_target_met, false);
  assert.equal(result.rpc_all_observed.mean_ms, 11000 / 3);
  assert.equal(result.rpc_successful_reused.mean_ms, 2500);
  assert.equal(result.rpc_current_boot_ingest.count, 1);
  assert.equal(result.rpc_inherited_boot_ingest.count, 1);
  assert.equal(result.active_state_queue.endpoint_slots_per_minute, 4);
  assert.equal(result.active_state_queue.regression_slots_per_minute, 4);
  assert.equal(result.allocation_all_observed.counter_delta, 1);
  assert.equal(result.allocation_all_observed.during_rpc_delta, 1);
});

test('buffered data and warmup are excluded and short cohorts have null slopes', () => {
  const result = analyze({...input, discard_buffered_before_device_ms: 50000}, null, {warmupMs: 10000});
  assert.equal(result.rpc_all_observed.count, 1);
  assert.equal(result.first_active_state_device_ms, 60000);
  assert.equal(result.active_state_queue.samples, 1);
  assert.equal(result.active_state_queue.regression_slots_per_minute, null);
  assert.equal(queueTrend([state(1, 1), state(1, 2)]).regression_slots_per_minute, null);
  assert.throws(() => analyze({...input, raw_serial_or_identifiers_stored: true}));
});

test('cloud snapshot is bound but cannot become a later serial-cohort measurement', () => {
  const cloud = {same_observed_boot: true, firmware_version: 'test-only', latest_status_numeric: {uptime_ms: 300000},
    full_windows: {windows: 0}, actual_policy: {summary: {max_addresses: 128, secret: 'discard'}},
    current_boot_policy_batches: [{stream: 'address_summaries', batches: 2, items: 12, node_id: 'discard'}]};
  const result = analyze(input, cloud);
  assert.equal(result.cloud.same_boot_and_version_bound, true);
  assert.equal(result.cloud.time_aligned_to_serial_span, false);
  assert.equal(result.cloud.full_windows.windows, 0);
  assert.ok(!JSON.stringify(result).includes('discard'));
  assert.equal(analyze(input, {...cloud, firmware_version: 'other'}).cloud.full_windows, null);
});
