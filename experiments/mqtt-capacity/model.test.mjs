import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { calculate, defaults, webhookBytes, projectCollectorRam } from './model.mjs';

const fixture = {
  addresses: 64, window_seconds: 30, reception_hz_per_address: 1, raw: false,
  // Safe exact lengths from the production C fixture, not fabricated 8KiB bodies.
  body_sizes: [3692, 3692, 3692, 3692, 3692, 3692, 3692, 3692, 3692, 3692, 2584, 891, 1422],
};
test('Base64 webhook length counts UTF-8 and padding exactly', () => {
  for (const bytes of [1, 2, 3, 4096, 8192]) {
    const baseline = webhookBytes(bytes);
    const delta = webhookBytes(bytes + 3) - baseline;
    assert.equal(delta, 4);
  }
  assert.ok(webhookBytes(8192) <= 12288);
});
test('64/30s exceeds serial service including one-second firmware yield', () => {
  const result = calculate(fixture);
  assert.equal(result.rpcs_per_window, 13);
  assert.equal(result.collector_group_c3_bytes, 12044);
  assert.equal(result.mqtt_pre_body_free_admission_floor_bytes, 30170);
  assert.equal(result.mqtt_pre_body_largest_admission_floor_bytes, 17058);
  assert.ok(result.ideal_utilization > 1.28 && result.ideal_utilization < 1.29);
  assert.ok(result.estimated_unbounded_queue_growth_per_minute > 5);
  assert.equal(result.backend_sustained_fleet_capacity, null);
  assert.equal(result.broker_average_fleet_upper_from_new_connection_rate, 230);
});
test('one-shot return publisher dominates free session minutes', () => {
  const result = calculate(fixture);
  assert.equal(result.monthly_actions_per_node_floor, 1_123_200);
  assert.equal(result.monthly_session_minutes_per_node_floor, 1_166_400);
  assert.equal(result.free_fleet_upper_from_sessions, 0);
  assert.equal(result.free_fleet_upper_from_actions, 0);
  assert.equal(result.free_fleet_upper_bound, 0);
});
test('doubling window halves RPC pressure, while changes to RF Hz do not', () => {
  const base = calculate(fixture);
  const slower = calculate({...fixture, window_seconds: 60});
  const fasterRadio = calculate({...fixture, reception_hz_per_address: 10});
  assert.equal(slower.rpcs_per_minute, base.rpcs_per_minute / 2);
  assert.equal(fasterRadio.rpcs_per_minute, base.rpcs_per_minute);
  assert.equal(fasterRadio.received_reports_per_second, 640);
  assert.equal(slower.collector_group_c3_bytes, 15116);
});
test('controls and retries consume service and free quota instead of adding capacity', () => {
  const base = calculate(fixture);
  const stressed = calculate(fixture, {controlRpcsPerMinute: 2, retryMultiplier: 1.1});
  assert.ok(stressed.ideal_utilization > base.ideal_utilization);
  assert.ok(stressed.monthly_session_minutes_per_node_floor > base.monthly_session_minutes_per_node_floor);
  assert.ok(stressed.monthly_public_traffic_bytes_per_node_floor > base.monthly_public_traffic_bytes_per_node_floor);
});
test('shape and invalid options fail explicitly', () => {
  assert.throws(() => calculate({...fixture, addresses: 128}));
  assert.throws(() => calculate({...fixture, addresses: 129, compiled_address_limit: 128}));
  assert.throws(() => calculate({...fixture, addresses: 256, compiled_address_limit: 256}));
  assert.throws(() => calculate({...fixture, body_sizes: [8193]}));
  assert.throws(() => calculate(fixture, {rpcMs: 0}));
  assert.throws(() => calculate(fixture, {retryMultiplier: 0.5}));
  assert.throws(() => calculate(fixture, {days: Infinity}));
  assert.ok(Object.isFrozen(defaults));
});

test('RAM uses compiled ceiling separately from selected policy and 256 is projection only', () => {
  assert.equal(calculate(fixture).collector_static_core_c3_bytes, 8192);
  const current = calculate({...fixture, compiled_address_limit: 128});
  assert.equal(current.collector_static_core_c3_bytes, 16384);
  assert.equal(current.collector_group_c3_bytes, 20236);
  assert.equal(current.collector_memory_profile, 'explicit-codec-source-ceiling');
  assert.equal(projectCollectorRam(128, 3, 128).bytes, 20236);
  assert.deepEqual(projectCollectorRam(256, 3, 256), {bytes: 39692, native_supported_ceiling: false});
  assert.throws(() => calculate({...fixture, compiled_address_limit: 128, collector_static_core_c3_bytes: 8192}));
});

test('actual production 128/4KiB fixture preserves all streams at three-bin resolution', () => {
  const rows = readFileSync(new URL('./trial128-4096-codec.jsonl', import.meta.url), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 12);
  const combinations = new Set();
  for (const row of rows) {
    combinations.add([row.window_seconds, row.reception_hz_per_address].join('/'));
    const result = calculate(row);
    assert.equal(row.addresses, 128);
    assert.equal(row.bin_count, 3);
    assert.equal(row.bin_seconds * 3, row.window_seconds);
    assert.equal(row.compiled_address_limit, 128);
    assert.equal(row.raw, false);
    assert.deepEqual(row.stream_batches, [1, 22, 0, 1]);
    assert.deepEqual(row.stream_items, [1, 128, 0, 1]);
    assert.equal(result.collector_group_c3_bytes, 20236);
    assert.equal(row.reports, 128 * row.window_seconds * row.reception_hz_per_address);
    assert.ok(result.max_body_bytes <= 4096);
    assert.ok(result.json_requested_host_peak < 8192);
    assert.equal(result.rpcs_per_window, 24);
  }
  assert.equal(combinations.size, 12);
});

test('all frozen actual-codec workloads fit transport bounds and retain 6-address batching provenance', () => {
  const rows = readFileSync(new URL('./baseline-codec.jsonl', import.meta.url), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.length, 72);
  const combinations = new Set();
  for (const row of rows) {
    combinations.add([row.addresses, row.window_seconds, row.reception_hz_per_address, row.raw].join('/'));
    const result = calculate(row);
    assert.equal(result.rpcs_per_window, Math.ceil(row.addresses / 6) + 2 + Number(row.raw));
    assert.equal(row.reports, row.addresses * row.window_seconds * row.reception_hz_per_address);
    assert.ok(result.max_webhook_bytes <= 12288);
    assert.ok(result.gateway_attempt_limit_fraction < 1);
    assert.ok(result.gateway_byte_limit_fraction_floor < 1);
    // Even this floor exceeds the entire monthly 1GiB allowance in every case.
    assert.ok(result.monthly_public_traffic_bytes_per_node_floor > defaults.freeTrafficBytes);
    assert.equal(result.free_fleet_upper_bound, 0);
  }
  assert.equal(combinations.size, 72);
});

test('packed snapshots preserve workload totals and improve each matching old batch/JSON peak', () => {
  for (const suffix of ['', '-unknown']) {
    const load = name => readFileSync(new URL(`./${name}${suffix}-codec.jsonl`, import.meta.url), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    const before = load('baseline'), after = load('packed');
    assert.equal(after.length, 72);
    for (let i = 0; i < before.length; i++) {
      for (const field of ['addresses', 'window_seconds', 'reception_hz_per_address', 'raw', 'reports', 'clock_known'])
        assert.equal(after[i][field], before[i][field]);
      assert.ok(after[i].body_sizes.length < before[i].body_sizes.length);
      assert.ok(after[i].json_requested_host_peak < before[i].json_requested_host_peak);
      const result = calculate(after[i]);
      assert.ok(result.max_body_bytes <= 8192);
      assert.ok(result.max_webhook_bytes <= 12288);
      assert.equal(result.free_fleet_upper_bound, 0);
    }
  }
});
