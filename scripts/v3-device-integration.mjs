#!/usr/bin/env node
/** Isolated v3 acceptance client. All generated observations are synthetic controlled_test.
 * Usage: node scripts/v3-device-integration.mjs --config /private/config.json --phase prepare|exercise|verify
 * Config (0600, owned regular file): {isolation:'synthetic-controlled-test',
 * operator_confirmed_isolated:true, endpoint:'https://...', allowedOrigin:'https://...',
 * nodeId:'synthetic-...', placementId:'synthetic-...', deviceBearer:'...', adminCookie:'...',
 * outputDir:'/private/run', actor:'synthetic_client'|'existing_device', caFile?:'/private/ca.pem',
 * expectedGeneration?:0, policyTemplateFile?:'/private/policy.json', policyOptions?:{windowMs,leaseDurationMs,queueMedium,queueMaxBytes,
 * queueMaxItems,workingBytes,storageWriteBytesPerDay,afterWindowSeq,afterSegmentSeq}}
 * prepare registers synthetic claims OR reads an existing device claim, then assigns a policy.
 * exercise explicitly simulates device application and uploads synthetic feature/status bodies.
 * verify only inspects an existing device ACK; it NEVER creates one or uploads observations.
 * Private state/frozen fixtures contain no credentials; report.json contains hashes/counts only.
 * No deployment, provisioning, production, historical data or radio-completeness claims.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };
let fixtureModule;
export async function fixtureTools() {
  if (!fixtureModule) {
    const bundle = await build({ stdin: { contents: `export * from './tests/helpers/v3-ingest-fixtures'; export * from './tests/helpers/device-v3-fixtures'; export {freezeDeviceConfigV3,capabilityDigestV3,validateDeviceCapabilitiesV3,validateFrozenDeviceConfigV3,negotiateDeviceConfigV3} from './worker/device-v3-config';`, resolveDir: ROOT, loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent' });
    fixtureModule = import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  }
  return fixtureModule;
}
export async function readPrivateJson(filename) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    check(stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.uid === process.getuid(), 'Private JSON must be an owned regular file with mode 0600.');
    check(stat.size < 262144, 'Private JSON exceeds the harness bound.');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}
function privateHost(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname.endsWith('.local') || hostname.endsWith('.test')) return true;
  const octets = hostname.split('.').map(Number);
  return octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n < 256) &&
    (octets[0] === 127 || octets[0] === 10 || octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
}
export function validateConfig(value) {
  check(value && value.isolation === 'synthetic-controlled-test' && value.operator_confirmed_isolated === true, 'Explicit isolated controlled-test confirmation is required.');
  const url = new URL(value.endpoint);
  check(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' && url.origin === value.allowedOrigin, 'Endpoint must be a pinned HTTPS origin.');
  check(privateHost(url.hostname) || /^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname) || /^campuspulse-v3-(?:integration|interop)-[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname), 'Endpoint is outside the isolated test host allowlist.');
  check(['synthetic_client', 'existing_device'].includes(value.actor), 'Choose an explicit actor.');
  check(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.nodeId) && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.placementId), 'Invalid test identity.');
  check(value.actor !== 'synthetic_client' || /^(?:synthetic-|v3-synthetic-)/.test(value.nodeId), 'Synthetic clients require a separate synthetic test node.');
  check(typeof value.deviceBearer === 'string' && value.deviceBearer.length >= 8 && !/[\r\n]/.test(value.deviceBearer), 'Missing private device credential.');
  check(typeof value.adminCookie === 'string' && value.adminCookie.length >= 8 && !/[\r\n]/.test(value.adminCookie), 'Missing private administrator session.');
  check(path.isAbsolute(value.outputDir), 'An absolute private output directory is required.');
  const options = value.policyOptions ?? {};
  check(Object.keys(options).every(key => ['windowMs', 'leaseDurationMs', 'queueMedium', 'queueMaxBytes', 'queueMaxItems', 'workingBytes', 'storageWriteBytesPerDay', 'afterWindowSeq', 'afterSegmentSeq'].includes(key)), 'Unknown policy option.');
  return { ...value, endpoint: url.origin, policyOptions: options };
}
async function writePrivate(dir, filename, value) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077), 'Output directory must be owned and private (0700).');
  const temporary = path.join(dir, `.${filename}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'); } finally { await handle.close(); }
  await rename(temporary, path.join(dir, filename));
}
/** Strict HTTPS transport: validates test CA, refuses redirects, bounds response bytes. */
export function httpsTransport(ca) {
  return (url, options) => new Promise((resolve, reject) => {
    const request = https.request(url, { method: options.method, headers: options.headers, ca, rejectUnauthorized: true }, response => {
      const chunks = []; let length = 0;
      response.on('data', chunk => { length += chunk.length; if (length > 131072) response.destroy(new Error('Response bound exceeded.')); else chunks.push(chunk); });
      response.on('error', () => reject(new Error('HTTPS response failed.')));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    request.setTimeout(15000, () => request.destroy(new Error('HTTPS timeout.')));
    request.on('error', () => reject(new Error('HTTPS request failed; check private endpoint and CA configuration.')));
    request.end(options.body);
  });
}
function expectedReceipt(receipt, body) {
  const p = JSON.parse(body), items = p.items;
  const values = { protocol: 'campuspulse/3', schema: 'device-ingest-receipt/3', node_id: p.node_id, boot_id: p.boot_id,
    stream: p.stream, batch_id: p.batch_id, body_sha256: hash(body), policy_id: p.policy_id, policy_sha256: p.policy_sha256,
    assignment_generation: p.assignment_generation, seq_first: items[0].seq, seq_last: items.at(-1).seq, accepted_count: items.length,
    durability: 'committed', custody: 'private_source', inference: 'not_performed', window_completeness: 'not_established' };
  check(Object.entries(values).every(([key, value]) => receipt[key] === value), 'Receipt does not exactly authorize the frozen batch.');
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(receipt.receipt_id), 'Invalid committed receipt identity.');
  for (const key of ['received_at', 'expires_at', 'retain_until']) check(typeof receipt[key] === 'string' && new Date(receipt[key]).toISOString() === receipt[key], 'Invalid receipt time.');
  check(Object.keys(receipt).length === Object.keys(values).length + 4, 'Unexpected receipt fields.');
  check(Date.parse(receipt.retain_until) >= Date.parse(receipt.expires_at), 'Invalid receipt retention.');
}
async function prepareFixture(config, inspection, tools) {
  const now = Date.now(), generation = (config.expectedGeneration ?? 0) + 1;
  check((inspection.desired?.policy?.assignment_generation ?? 0) === generation - 1, 'Unexpected desired generation; set expectedGeneration explicitly.');
  const f = await tools.ingestV3Fixture(config.nodeId, config.placementId, now, generation);
  f.policy.policy_id = `synthetic-policy-${randomUUID()}`;
  if (config.actor === 'synthetic_client') {
    f.caps.boot_id = randomUUID(); f.caps.capability_id = `synthetic-caps-${randomUUID()}`;
  } else {
    check(inspection.capabilities, 'Device must register its own capability before preparation.');
    f.caps = tools.validateDeviceCapabilitiesV3(inspection.capabilities);
    check(f.caps.node_id === config.nodeId && f.caps.producer_version === 'cp-v3-producer/1' && f.caps.features?.extractor_versions.includes('cp-v3-ad/1'), 'Unsupported actual-device producer/extractor claim.');
    check(!inspection.desired || config.expectedGeneration !== undefined, 'Replacing a desired policy needs an explicit expectedGeneration.');
    if (config.policyTemplateFile) {
      f.policy = await readPrivateJson(config.policyTemplateFile);
      f.policy.node_id = config.nodeId; f.policy.custody.placement_id = config.placementId;
      f.policy.assignment_generation = generation;
      f.policy.control.activation.not_before = new Date(now - 30000).toISOString();
      f.policy.custody.accept_until = new Date(now + 7200000).toISOString();
    } else {
    const c = f.caps, p = f.policy, opts = config.policyOptions;
    const medium = c.queue?.media.find(m => m.medium === (opts.queueMedium ?? 'tf_journal') && m.power_loss_recovery);
    check(medium && c.resources && c.summary && c.features && c.uplink, 'Device has not declared the required durable upload capabilities.');
    p.collection.scan = { mode: 'passive', interval_units: Math.max(160, c.scanner.min_interval_units), window_units: Math.max(160, c.scanner.min_interval_units), duplicate_filter: false, phys: ['1m'] };
    p.collection.summary = { enabled: true, window_ms: opts.windowMs ?? 1000, bin_ms: opts.windowMs ?? 1000, max_addresses: Math.min(2, c.summary.max_addresses) };
    p.evidence.extractor_version = 'cp-v3-ad/1';
    p.evidence.fields = ['company_ids', 'appearance'].filter(kind => c.features.fields.includes(kind)).map(kind => ({ kind, max_values_per_identifier: 16 }));
    p.evidence.max_reports_per_window = Math.min(100, c.features.max_reports_per_window);
    p.evidence.max_bytes_per_window = Math.min(16384, c.features.max_bytes_per_window);
    p.uplink.max_batch_items = Math.min(16, c.uplink.max_batch_items); p.uplink.max_body_bytes = Math.min(16384, c.uplink.max_body_bytes);
    p.local_queue.medium = medium.medium; p.local_queue.max_bytes = opts.queueMaxBytes ?? Math.min(262144, medium.usable_bytes);
    p.local_queue.max_items = opts.queueMaxItems ?? Math.min(128, medium.max_items);
    const reserveBytes = Math.floor((p.local_queue.max_bytes - 4096) / 4), reserveItems = Math.floor((p.local_queue.max_items - 4) / 4);
    p.local_queue.stream_reserves = ['feature_summaries', 'node_status'].map(stream => ({ stream, bytes: reserveBytes, items: reserveItems }));
    p.resources.working_bytes = opts.workingBytes ?? Math.min(65536, c.resources.max_working_bytes);
    p.resources.storage_write_bytes_per_day = opts.storageWriteBytesPerDay ?? Math.min(1048576, c.resources.max_storage_write_bytes_per_day);
    p.control.activation.after_window_seq = opts.afterWindowSeq ?? 0; p.control.activation.after_segment_seq = opts.afterSegmentSeq ?? 0;
    }
  }
  f.policy.policy_id = `synthetic-policy-${randomUUID()}`;
  f.policy.control.lease.duration_ms = config.policyOptions.leaseDurationMs ?? f.policy.control.lease.duration_ms;
  f.policy.control.activation.boot_id = f.caps.boot_id;
  f.policy.control.capability_sha256 = await tools.capabilityDigestV3(f.caps);
  f.policy.control.activation.expires_at = new Date(Math.min(now + 1800000, Date.parse(f.caps.expires_at))).toISOString();
  const frozen = await tools.freezeDeviceConfigV3(f.policy);
  const negotiation = await tools.negotiateDeviceConfigV3(frozen, f.caps, { node_id: config.nodeId, boot_id: f.caps.boot_id, now: new Date(now).toISOString(), last_assignment_generation: generation - 1,
    closed_window_seq: f.policy.control.activation.after_window_seq, closed_segment_seq: f.policy.control.activation.after_segment_seq, window_open: false, segment_open: false });
  check(negotiation.state === 'compatible', 'Policy exceeds the registered capability or activation bounds.');
  return { fixture: f, frozen };
}
export async function runIntegration(rawConfig, phase = 'exercise', dependencies = {}) {
  const config = validateConfig(rawConfig);
  check(['prepare', 'exercise', 'verify'].includes(phase), 'Unknown phase.');
  check(phase !== 'exercise' || config.actor === 'synthetic_client', 'Exercise is reserved for a separate synthetic client. Use verify for an actual device.');
  const tools = await fixtureTools();
  const transport = dependencies.transport ?? httpsTransport(config.caFile ? await readFile(config.caFile) : undefined);
  const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const report = { schema: 'v3-integration-report/1', dataset: 'controlled_test', actor: config.actor, phase, outcome: 'running', observation_acceptance: 'not_tested_by_phase', started_at: new Date().toISOString(), node_sha256: hash(config.nodeId), checks: [], physical_validation: 'not_established' };
  async function call(label, pathname, body, admin = false, expectedStatus = 200, ingest = false) {
    const bytes = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const response = await transport(config.endpoint + pathname, { method: bytes === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { ...(admin ? { Cookie: config.adminCookie, Origin: config.endpoint } : { Authorization: `Bearer ${config.deviceBearer}` }), ...(bytes === undefined ? {} : { 'Content-Type': 'application/json' }), ...(ingest ? { 'X-Body-SHA256': hash(bytes) } : {}) }, body: bytes });
    report.checks.push({ check: label, status: response.status, expected_status: expectedStatus, ...(bytes === undefined ? {} : { request_sha256: hash(bytes), request_bytes: Buffer.byteLength(bytes) }) });
    check(response.status === expectedStatus, `Check ${label} failed (HTTP ${response.status}, expected ${expectedStatus}).`);
    if (expectedStatus !== 200) return null;
    check(response.headers.get('cache-control') === 'no-store', `Check ${label} lacks no-store.`);
    try { return await response.json(); } catch { throw new Error(`Check ${label} returned invalid JSON.`); }
  }
  const statePath = path.join(config.outputDir, 'state.json');
  try {
    let state;
    try { state = await readPrivateJson(statePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    check(phase !== 'verify' || state, 'Verification requires an existing prepared private state.');
    if (!state) {
      const inspection = await call('inspect_before_assignment', `/api/v1/admin/device-v3/nodes/${config.nodeId}`, undefined, true);
      const { fixture, frozen } = await prepareFixture(config, inspection, tools);
      state = { schema: 'v3-integration-private-state/1', endpoint: config.endpoint, actor: config.actor, fixture, frozen };
      // Persist before mutation so a lost response can be retried without changing identity.
      await writePrivate(config.outputDir, 'state.json', state);
      await writePrivate(config.outputDir, 'frozen-policy.json', frozen);
      await writePrivate(config.outputDir, 'capabilities.json', fixture.caps);
    }
    check(state.schema === 'v3-integration-private-state/1' && state.endpoint === config.endpoint && state.actor === config.actor && state.fixture.caps.node_id === config.nodeId && state.fixture.policy.custody.placement_id === config.placementId, 'Private state does not match this run.');
    const f = state.fixture, frozen = await tools.validateFrozenDeviceConfigV3(state.frozen);
    check(JSON.stringify(await tools.freezeDeviceConfigV3(f.policy)) === JSON.stringify(frozen), 'Frozen policy state changed.');
    check(f.policy.custody.dataset === 'controlled_test' && f.policy.custody.purpose === 'controlled_test' && f.policy.local_raw.mode === 'off', 'Only controlled_test with local raw off is accepted.');
    if (phase !== 'verify') {
      if (config.actor === 'synthetic_client') {
        const registration = tools.v3Registration(f.caps);
        const receipt = await call('capability_registration', '/api/v3/device/capabilities', registration);
        check(receipt.capability_sha256 === await tools.capabilityDigestV3(f.caps) && receipt.applied === false, 'Capability receipt mismatch.');
        check(JSON.stringify(await call('capability_exact_retry', '/api/v3/device/capabilities', registration)) === JSON.stringify(receipt), 'Registration retry changed.');
      }
      const assignment = { policy: f.policy, expected_generation: f.policy.assignment_generation - 1 };
      const assigned = await call('administrator_assignment', '/api/v1/admin/device-v3/assignments', assignment, true);
      check(assigned.policy_sha256 === frozen.policy_sha256 && assigned.applied === false && assigned.requires_device_ack === true, 'Assignment receipt mismatch.');
      check(JSON.stringify(await call('assignment_exact_retry', '/api/v1/admin/device-v3/assignments', assignment, true)) === JSON.stringify(assigned), 'Assignment retry changed.');
    }
    const delivered = await call('device_configuration', `/api/v3/device/config?boot_id=${f.caps.boot_id}`);
    check(JSON.stringify(await tools.validateFrozenDeviceConfigV3(delivered.config)) === JSON.stringify(frozen), 'Delivered configuration differs from frozen policy.');
    check(delivered.data_ingestion_available === true, 'Private ingestion gate is unavailable.');
    if (phase === 'prepare') { report.outcome = 'prepared_awaiting_device_ack'; return report; }
    let applied;
    if (phase === 'verify') {
      const inspection = await call('inspect_actual_device_ack', `/api/v1/admin/device-v3/nodes/${config.nodeId}`, undefined, true);
      applied = inspection.acknowledgement;
      check(inspection.state === 'applied' && applied?.state === 'applied' && applied.policy_sha256 === frozen.policy_sha256 && applied.boot_id === f.caps.boot_id && applied.assignment_generation === f.policy.assignment_generation && applied.durability === 'committed', 'Matching committed device ACK is not present.');
      report.outcome = 'device_claimed_applied'; report.observation_acceptance = 'not_tested_by_verify'; return report;
    }
    const ack = await tools.v3Ack(f.policy);
    applied = await call('synthetic_device_ack', '/api/v3/device/config/ack', ack);
    check(applied.state === 'applied' && applied.durability === 'committed', 'Applied ACK is not committed.');
    check(JSON.stringify(await call('ack_exact_retry', '/api/v3/device/config/ack', ack)) === JSON.stringify(applied), 'ACK retry changed.');
    // Never reuse historical fixture times before A. Wait for a whole window AFTER the server ACK.
    const appliedAt = Date.parse(applied.received_at);
    check(Number.isFinite(appliedAt), 'Applied ACK has no valid server time.');
    if (!state.bodies) {
      const start = Math.max(appliedAt + 100, Date.parse(f.policy.control.activation.not_before), Date.parse(f.caps.issued_at));
      const end = start + f.policy.collection.summary.window_ms;
      check(end < Math.min(appliedAt + f.policy.control.lease.duration_ms, Date.parse(f.policy.control.activation.expires_at), Date.parse(f.caps.expires_at), Date.parse(f.policy.custody.accept_until)), 'No complete window fits inside first lease.');
      const feature = await tools.featureBatchV3(f), status = await tools.statusBatchV3(f);
      feature.items[0].evidence.identity.token = randomBytes(16).toString('hex');
      feature.items[0].evidence.observed_time.start.utc_ms = start; feature.items[0].evidence.observed_time.end.utc_ms = end;
      feature.items[0].evidence.observed_time.end.mono_ms = feature.items[0].evidence.observed_time.start.mono_ms + end - start;
      status.items[0].time.utc_ms = end;
      state.bodies = { feature: JSON.stringify(feature), status: JSON.stringify(status) }; state.observationEnd = end;
      await writePrivate(config.outputDir, 'state.json', state);
      await writePrivate(config.outputDir, 'feature.frozen.json', state.bodies.feature);
      await writePrivate(config.outputDir, 'status.frozen.json', state.bodies.status);
    }
    let serverNow = Date.parse(delivered.server_time);
    for (let attempt = 0; serverNow <= state.observationEnd && attempt < 30; attempt++) {
      await sleep(250);
      serverNow = Date.parse((await call('wait_server_window_closed', `/api/v3/device/config?boot_id=${f.caps.boot_id}`)).server_time);
    }
    check(serverNow > state.observationEnd, 'Server clock has not reached the frozen observation end.');
    for (const stream of ['feature', 'status']) {
      const body = state.bodies[stream];
      const receipt = await call(`${stream}_ingest`, '/api/v3/ingest', body, false, 200, true); expectedReceipt(receipt, body);
      const retry = await call(`${stream}_exact_retry`, '/api/v3/ingest', body, false, 200, true); expectedReceipt(retry, body);
      check(JSON.stringify(receipt) === JSON.stringify(retry), 'Exact receipt retry changed.');
      report.checks.push({ check: `${stream}_receipt_match`, body_sha256: hash(body), accepted_count: receipt.accepted_count, receipt_sha256: hash(JSON.stringify(receipt)) });
    }
    const changed = JSON.parse(state.bodies.feature); changed.producer_version = 'synthetic-conflict/1';
    await call('changed_bytes_same_batch_conflict', '/api/v3/ingest', changed, false, 409, true);
    const wrong = JSON.parse(state.bodies.feature); wrong.node_id = 'synthetic-wrong-node'; wrong.items[0].evidence.scope.node_id = wrong.node_id;
    await call('wrong_node_rejected', '/api/v3/ingest', wrong, false, 403, true);
    report.outcome = 'synthetic_server_acceptance_passed'; return report;
  } catch (error) {
    report.outcome = 'failed'; throw error;
  } finally { report.finished_at = new Date().toISOString(); await writePrivate(config.outputDir, 'report.json', report); }
}
async function main() {
  const args = process.argv.slice(2);
  check(args.length === 4 && args[0] === '--config' && args[2] === '--phase', 'Usage: node scripts/v3-device-integration.mjs --config /private/config.json --phase prepare|exercise|verify');
  const report = await runIntegration(await readPrivateJson(args[1]), args[3]);
  process.stdout.write(JSON.stringify({ outcome: report.outcome, phase: report.phase, actor: report.actor, checks: report.checks.length, physical_validation: report.physical_validation }) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(() => {
  // Do not expose arbitrary JSON, response text, credential-bearing URLs or parser exceptions.
  process.stderr.write('v3 integration failed; inspect the private redacted report and configuration.\n'); process.exitCode = 1;
});
