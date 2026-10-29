import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// These are source/documentation bounds, not measured throughput. All options
// are inputs to offline arithmetic; nothing changes firmware or cloud policy.
export const defaults = Object.freeze({
  rpcMs: 1958.5, yieldMs: 1000, controlRpcsPerMinute: 0, retryMultiplier: 1,
  days: 30, journalSlots: 341, criticalPct: 95,
  freeSessionMinutes: 1_000_000, freeTrafficBytes: 1024 ** 3,
  freeRuleActions: 1_000_000, brokerConnections: 1000,
  brokerNewConnectionsPerSecond: 100, brokerTotalTps: 1000,
});

// Exactly the six-field production rule envelope, using only synthetic data.
// The Base64 alphabet never needs JSON escaping, so its actual content cannot
// change UTF-8 length. This avoids writing full synthetic observations to disk.
export function webhookBytes(bodyBytes) {
  return Buffer.byteLength(JSON.stringify({
    username: 'synthetic_user',
    topic: 'cp/v1/synthetic_user/11111111-1111-4111-8111-111111111111/req/ingest/1000000',
    qos: 1, retain: false, payload_b64: 'A'.repeat(4 * Math.ceil(bodyBytes / 3)),
    published_at_ms: 1793232000000,
  }));
}

export function calculate(input, options = {}) {
  const o = {...defaults, ...options};
  for (const [key, value] of Object.entries(o)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${key}`);
  }
  if (!o.days || !o.rpcMs || o.retryMultiplier < 1 || o.criticalPct > 100)
    throw new Error('Invalid service or retention input');
  const {addresses, window_seconds: seconds, body_sizes: sizes} = input;
  if (![16, 32, 64].includes(addresses) || ![10, 30, 60].includes(seconds) ||
      !Array.isArray(sizes) || !sizes.length ||
      sizes.some(size => !Number.isInteger(size) || size < 1 || size > 8192))
    throw new Error('Invalid codec input');
  const batches = sizes.length;
  const bodyBytes = sizes.reduce((sum, size) => sum + size, 0);
  const events = sizes.map(webhookBytes);
  if (Math.max(...events) > 12288) throw new Error('Webhook envelope exceeds gateway limit');
  const dataRpcsPerSecond = batches / seconds;
  const attemptsPerSecond = (dataRpcsPerSecond + o.controlRpcsPerMinute / 60) * o.retryMultiplier;
  const cycleSeconds = (o.rpcMs + o.yieldMs) / 1000;
  const utilization = attemptsPerSecond * cycleSeconds;
  const netQueuePerMinute = Math.max(0, dataRpcsPerSecond -
    Math.max(0, 1 / cycleSeconds / o.retryMultiplier - o.controlRpcsPerMinute / 60)) * 60;
  const monthSeconds = o.days * 86400;
  const monthMinutes = o.days * 1440;
  const monthlyRpcs = attemptsPerSecond * monthSeconds;
  // Every successful reply uses a fresh clean-session MQTT connection and is
  // rounded up to >=1 billed minute. Persistent device session adds monthMinutes.
  const sessionMinutesPerNode = monthMinutes + monthlyRpcs;
  // Strictly optimistic traffic floor: request body into broker, exact Base64
  // webhook body out, and the 2-byte reply application status twice. Excludes
  // reply JSON, MQTT/HTTP/TLS framing, credentials, handshakes, control bodies,
  // probes, keepalives and all pre-existing consumption. Never a bill forecast.
  const trafficFloorPerWindow = bodyBytes + events.reduce((sum, size) => sum + size, 0) + 4 * batches;
  const monthlyTrafficFloor = trafficFloorPerWindow / seconds * monthSeconds * o.retryMultiplier;
  const upperFromTraffic = Math.floor(o.freeTrafficBytes / monthlyTrafficFloor);
  const upperFromSessions = Math.floor(o.freeSessionMinutes / sessionMinutesPerNode);
  const upperFromActions = Math.floor(o.freeRuleActions / monthlyRpcs);
  const maxBody = Math.max(...sizes);
  return {
    ...input,
    collector_group_c3_bytes: 8192 + 2 * addresses * (seconds / 5) * 4 + 780,
    json_body_bytes_per_window: bodyBytes,
    max_body_bytes: maxBody, max_webhook_bytes: Math.max(...events),
    // Exact admission arithmetic in mqtt_rpc.h, not a measured heap peak.
    // The immutable body and separate QoS1 outbox copy coexist at publish.
    mqtt_pre_body_free_admission_floor_bytes: maxBody + 1 + 20 * 1024 + maxBody + 256 + 2048 + 1,
    mqtt_pre_body_largest_admission_floor_bytes: Math.max(17058, maxBody + 256, maxBody + 1),
    rpcs_per_window: batches, rpcs_per_minute: attemptsPerSecond * 60,
    json_body_bytes_per_second: bodyBytes / seconds,
    received_reports_per_second: addresses * input.reception_hz_per_address,
    ideal_service_cycle_seconds: cycleSeconds,
    ideal_utilization: utilization, estimated_unbounded_queue_growth_per_minute: netQueuePerMinute,
    no_upload_seconds_to_critical_from_empty: Math.floor(o.journalSlots * o.criticalPct / 100) / dataRpcsPerSecond,
    gateway_attempt_limit_fraction: attemptsPerSecond * 60 / 600,
    // Retry scales all data; unknown control sizes are omitted, hence a floor.
    gateway_byte_limit_fraction_floor: bodyBytes / seconds * 60 * o.retryMultiplier / (4 * 1024 * 1024),
    monthly_session_minutes_per_node_floor: sessionMinutesPerNode,
    monthly_public_traffic_bytes_per_node_floor: monthlyTrafficFloor,
    monthly_actions_per_node_floor: monthlyRpcs,
    free_fleet_upper_from_traffic: upperFromTraffic,
    free_fleet_upper_from_sessions: upperFromSessions,
    free_fleet_upper_from_actions: upperFromActions,
    free_fleet_upper_bound: Math.min(upperFromTraffic, upperFromSessions, upperFromActions),
    full_free_quota_hours_for_one_node_upper_bound: monthSeconds / 3600 * Math.min(
      o.freeTrafficBytes / monthlyTrafficFloor,
      o.freeSessionMinutes / sessionMinutesPerNode,
      o.freeRuleActions / monthlyRpcs),
    broker_average_fleet_upper_from_connections: o.brokerConnections,
    broker_average_fleet_upper_from_new_connection_rate: Math.floor(o.brokerNewConnectionsPerSecond / attemptsPerSecond),
    // Per data RPC: device publish + reply publisher publish + delivery to device.
    broker_average_fleet_upper_from_tps: Math.floor(o.brokerTotalTps / (3 * attemptsPerSecond)),
    backend_sustained_fleet_capacity: null,
  };
}

export function csv(rows) {
  const keys = Object.keys(rows[0]).filter(key => !Array.isArray(rows[0][key]));
  return [keys.join(','), ...rows.map(row => keys.map(key =>
    typeof row[key] === 'number' ? Number(row[key].toFixed(6)) : row[key] ?? '').join(','))].join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [inputPath, outputPrefix, optionsJson] = process.argv.slice(2);
  if (!inputPath || !outputPrefix) throw new Error('Usage: node model.mjs MATRIX.jsonl OUTPUT_PREFIX [OPTIONS_JSON]');
  const options = optionsJson ? JSON.parse(optionsJson) : {};
  const inputs = readFileSync(inputPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const rows = inputs.map(input => calculate(input, options));
  writeFileSync(`${outputPrefix}.json`, JSON.stringify({
    evidence: 'Offline synthetic workload encoded by actual production collector/codec; derived estimates only',
    options: {...defaults, ...options}, rows,
  }, null, 2) + '\n');
  writeFileSync(`${outputPrefix}.csv`, csv(rows));
  console.log(`Calculated ${rows.length} offline cases: ${outputPrefix}.{json,csv}`);
}
