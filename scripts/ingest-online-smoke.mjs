import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const allowedHosts = new Set(['pulse.anend.net', 'campuspulse.anend.workers.dev']);
const idPattern = /^[a-z0-9_-]{1,64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ackKeys = ['accepted_count', 'batch_id', 'body_sha256', 'boot_id', 'durability', 'node_id', 'receipt_id', 'received_at', 'stream'];
const fixture = name => JSON.parse(readFileSync(new URL(`../docs/specs/examples/${name}`, import.meta.url), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const copy = value => structuredClone(value);

class SmokeFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new SmokeFailure(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateTarget(value) {
  if (typeof value !== 'string') fail('invalid_target');
  let url;
  try { url = new URL(value); } catch { fail('invalid_target'); }
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname) || url.port || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) fail('invalid_target');
  return url.origin;
}

function validateOps(value) {
  const required = ['node_id', 'capture_config_id', 'placement_id', 'place_id', 'device_token', 'research_token'];
  if (!object(value) || Object.keys(value).sort().join(',') !== required.sort().join(',')) fail('invalid_ops_config');
  for (const key of ['node_id', 'capture_config_id', 'placement_id', 'place_id'])
    if (typeof value[key] !== 'string' || !idPattern.test(value[key])) fail('invalid_ops_config');
  for (const key of ['device_token', 'research_token'])
    if (typeof value[key] !== 'string' || !/^[!-~]{16,256}$/.test(value[key])) fail('invalid_ops_config');
  if (value.device_token === value.research_token) fail('invalid_ops_config');
  return value;
}

export function verifyAck(ack, batch, hash) {
  if (!object(ack) || Object.keys(ack).sort().join(',') !== ackKeys.join(',') ||
      ack.node_id !== batch.node_id || ack.boot_id !== batch.boot_id || ack.stream !== batch.stream ||
      ack.batch_id !== batch.batch_id || ack.body_sha256 !== hash ||
      ack.accepted_count !== batch.items.length || ack.durability !== 'committed' ||
      typeof ack.receipt_id !== 'string' || !uuidPattern.test(ack.receipt_id) ||
      typeof ack.received_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(ack.received_at) ||
      Number.isNaN(Date.parse(ack.received_at)) || new Date(ack.received_at).toISOString() !== ack.received_at) fail('false_ack');
  return ack;
}

/** Compare public field data, ignoring changing response timestamps/freshness. */
export function verifyDemoIsolation(before, after) {
  if (!object(before) || !object(after) || !object(before.summary) || !object(after.summary) ||
      !object(before.history) || !object(after.history)) fail('public_snapshot_invalid');
  const stable = snapshot => ({ sensor: snapshot.summary.sensor ?? null,
    latest_observation: snapshot.summary.latest_observation ?? null,
    observations: snapshot.history.observations,
    sensor_windows: snapshot.history.sensor_windows });
  if (!Array.isArray(before.history.observations) || !Array.isArray(after.history.observations) ||
      !Array.isArray(before.history.sensor_windows) || !Array.isArray(after.history.sensor_windows) ||
      !isDeepStrictEqual(stable(before), stable(after))) fail('demo_isolation_failed');
  return { sensor_windows: after.history.sensor_windows.length, observations: after.history.observations.length };
}

function assertResponse(response, status, code) {
  if (response.status !== status) fail(code);
}
async function readJson(response, code) {
  try { return await response.json(); } catch { fail(code); }
}
async function expectError(response, status, code, label) {
  assertResponse(response, status, `${label}_status`);
  const body = await readJson(response, `${label}_json`);
  if (!object(body) || !object(body.error) || body.error.code !== code) fail(`${label}_code`);
  return body.error.code;
}

function makeBatches(ops, config, uuid, now) {
  const boot_id = uuid();
  const sources = ['ble-windows.request.json', 'ble-reports.request.json', 'node-status.request.json'];
  return sources.map(name => {
    const batch = fixture(name);
    Object.assign(batch, { node_id: ops.node_id, capture_config_id: ops.capture_config_id,
      placement_id: ops.placement_id, boot_id, batch_id: uuid(), dataset: 'demo', firmware_version: 'online-smoke-v1' });
    if (batch.stream === 'ble_windows') Object.assign(batch.items[0].time, { utc_ms: now, uncertainty_ms: 20 });
    if (batch.stream === 'ble_reports' && config.raw_capture.mode === 'sampled')
      batch.items[0].seq = config.raw_capture.sample_every_n;
    return batch;
  });
}

/** Requires an explicit run guard even when called programmatically. */
export async function runOnlineSmoke({ target, ops, enabled = process.env.RUN_INGEST_ONLINE_SMOKE },
  { fetchImpl = fetch, uuid = randomUUID, now = () => Date.now() } = {}) {
  if (enabled !== '1') fail('run_guard_required');
  const origin = validateTarget(target);
  ops = validateOps(ops);
  const report = { ok: false, target: origin, batch_ids: [], checks: [], error_codes: [],
    expected_unreferenced_raw_object_possible: false };
  const request = (path, init) => fetchImpl(`${origin}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) });
  const auth = { Authorization: `Bearer ${ops.device_token}` };
  const read = async path => {
    const response = await request(path);
    assertResponse(response, 200, 'public_read_status');
    return readJson(response, 'public_read_json');
  };
  const publicSnapshot = async () => ({
    summary: await read(`/api/v1/places/${ops.place_id}/summary`),
    history: await read(`/api/v1/places/${ops.place_id}/history?minutes=15`),
  });
  const send = (batch, headers = auth, hashOverride) => {
    const bytes = Buffer.from(JSON.stringify(batch), 'utf8');
    const hash = sha(bytes);
    return { bytes, hash, response: request('/api/v1/ingest', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Body-SHA256': hashOverride ?? hash, ...headers }, body: bytes }) };
  };
  const healthResponse = await request('/api/v1/health');
  assertResponse(healthResponse, 200, 'health_status');
  const health = await readJson(healthResponse, 'health_json');
  if (health.status !== 'ok' || health.ingestion !== 'implemented' || health.raw_storage !== 'configured') fail('health_capability');
  report.checks.push('health');
  const configResponse = await request(`/api/v1/device/config?capture_config_id=${ops.capture_config_id}`, { headers: auth });
  assertResponse(configResponse, 200, 'config_status');
  const remote = await readJson(configResponse, 'config_json');
  const config = remote.config;
  if (remote.expired !== false || !object(config) || config.dataset !== 'demo' ||
      config.node_id !== ops.node_id || config.capture_config_id !== ops.capture_config_id ||
      config.placement_id !== ops.placement_id || config.capture_profile !== 'research_raw' ||
      !config.allowed_streams?.includes('ble_reports') || config.raw_capture?.mode !== 'sampled' ||
      !Number.isInteger(config.raw_capture.sample_every_n) || config.raw_capture.sample_every_n < 1) fail('config_policy');
  report.checks.push('config');
  const before = await publicSnapshot();
  const batches = makeBatches(ops, config, uuid, now());
  const saved = [];
  for (const batch of batches) {
    const first = send(batch);
    const response = await first.response;
    assertResponse(response, 200, `${batch.stream}_upload_status`);
    const ack = verifyAck(await readJson(response, `${batch.stream}_ack_json`), batch, first.hash);
    const retry = send(batch);
    assertResponse(await retry.response, 200, `${batch.stream}_retry_status`);
    const retryAck = verifyAck(await readJson(await retry.response, `${batch.stream}_retry_ack_json`), batch, first.hash);
    if (!isDeepStrictEqual(ack, retryAck) || !first.bytes.equals(retry.bytes)) fail(`${batch.stream}_retry_changed`);
    report.batch_ids.push(batch.batch_id);
    saved.push({ batch, hash: first.hash });
    report.checks.push(`${batch.stream}_committed_retry`);
  }
  const raw = saved.find(entry => entry.batch.stream === 'ble_reports');
  const changed = { ...raw.batch, firmware_version: 'online-smoke-conflict' };
  report.error_codes.push(await expectError(await send(changed).response, 409, 'batch_conflict', 'changed_batch'));
  const overlap = { ...raw.batch, batch_id: uuid() };
  report.expected_unreferenced_raw_object_possible = true;
  report.error_codes.push(await expectError(await send(overlap).response, 409, 'seq_range_overlap', 'overlap'));
  const negative = (change, headers = auth, hashOverride) => {
    const batch = copy(raw.batch); batch.batch_id = uuid(); change(batch);
    return send(batch, headers, hashOverride).response;
  };
  report.error_codes.push(await expectError(await negative(() => {}, {}), 401, 'unauthorized', 'no_credential'));
  report.error_codes.push(await expectError(await negative(batch => { batch.node_id = 'other-node'; }), 403, 'node_not_allowed', 'wrong_node'));
  report.error_codes.push(await expectError(await negative(batch => { batch.dataset = 'field'; }), 422, 'invalid_ingest', 'wrong_dataset'));
  report.error_codes.push(await expectError(await negative(() => {}, auth, '0'.repeat(64)), 400, 'body_hash_mismatch', 'wrong_hash'));
  report.error_codes.push(await expectError(await negative(batch => { batch.items[0].payload_length += 1; }), 422, 'invalid_ingest', 'hex_length'));
  report.checks.push('negative_ingest');
  const researchPath = `/api/v1/research/batches/${raw.batch.batch_id}?node_id=${ops.node_id}`;
  report.error_codes.push(await expectError(await request(researchPath), 401, 'unauthorized', 'research_no_auth'));
  const researchResponse = await request(researchPath, { headers: { Authorization: `Bearer ${ops.research_token}` } });
  assertResponse(researchResponse, 200, 'research_status');
  const research = await readJson(researchResponse, 'research_json');
  if (!object(research) || research.body_sha256 !== raw.hash || !isDeepStrictEqual(research.batch, raw.batch) ||
      !Array.isArray(research.derived) || research.derived.length !== 1 ||
      research.derived[0].seq !== raw.batch.items[0].seq ||
      research.derived[0].parse_status !== 'ok' || research.derived[0].classification?.category !== 'unknown') fail('research_evidence');
  report.checks.push('private_research');
  const after = await publicSnapshot();
  report.public_isolation = verifyDemoIsolation(before, after);
  report.checks.push('demo_isolation');
  report.ok = true;
  return report;
}

function privateReport(path, report) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`, 'utf8'); }
  finally { closeSync(fd); }
  renameSync(temp, path);
}

export async function main(env = process.env, fetchImpl = fetch) {
  if (env.RUN_INGEST_ONLINE_SMOKE !== '1') fail('run_guard_required');
  const target = validateTarget(env.SMOKE_URL);
  const configPath = resolve(env.SMOKE_CONFIG_FILE ?? '.wrangler/ops/ingestion-smoke.json');
  const output = resolve('.wrangler/ops/ingestion-smoke-result.json');
  const stat = lstatSync(configPath);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) fail('ops_config_permissions');
  const ops = validateOps(JSON.parse(readFileSync(configPath, 'utf8')));
  try {
    const report = await runOnlineSmoke({ target, ops, enabled: env.RUN_INGEST_ONLINE_SMOKE }, { fetchImpl });
    privateReport(output, report);
    console.log(`Ingestion online smoke passed: ${report.checks.length} checks, ${report.batch_ids.length} committed batches, ${report.error_codes.length} expected errors.`);
    return report;
  } catch (error) {
    privateReport(output, { ok: false, target, error_code: error instanceof SmokeFailure ? error.code : 'unexpected_error' });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    console.error(`Ingestion online smoke failed: ${error instanceof SmokeFailure ? error.code : 'unexpected_error'}. No credential or payload was logged.`);
    process.exitCode = 1;
  }
}
