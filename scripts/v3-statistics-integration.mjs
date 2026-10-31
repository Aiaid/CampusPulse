#!/usr/bin/env node
/** Isolated small-statistics acceptance client; all generated counts are synthetic.
 * node scripts/v3-statistics-integration.mjs --config /private/config.json --phase prepare|exercise|verify
 * Uses the v3-device-integration private 0600 config/profile, pinned HTTPS allowlist,
 * actor and policyOptions. Existing devices require a private policyTemplateFile.
 * Only an explicit synthetic_client may register, ACK, renew or POST compact statistics.
 * Default synthetic cadence is 60s/5s; explicit policyOptions.windowMs=1000 is a
 * synthetic test shortcut. 30s/5s and 60s/5s protocol fixtures remain separate.
 * No raw, per-address, production upload, deployment or physical acceptance claim.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { readPrivateJson, validateConfig, httpsTransport } from './v3-device-integration.mjs';

export { readPrivateJson, validateConfig, httpsTransport };
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (ok, message) => { if (!ok) throw new Error(message); };
let modulePromise;
export function statisticsTools() {
  return modulePromise ??= (async () => {
    const bundle = await build({ stdin: { contents: `export * from './tests/helpers/v3-statistics-policy-fixtures'; export {v3Ack,v3Registration} from './tests/helpers/device-v3-fixtures'; export {capabilityDigestV3,freezeDeviceConfigV3,validateDeviceCapabilitiesV3,validateFrozenDeviceConfigV3,negotiateDeviceConfigV3} from './worker/device-v3-config';`, resolveDir: ROOT, loader: 'ts' },
      bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent' });
    return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  })();
}
async function writePrivate(dir, name, value) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  check(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077), 'Output directory must be owned and private (0700).');
  const temporary = path.join(dir, `.${name}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'); } finally { await handle.close(); }
  await rename(temporary, path.join(dir, name));
}
function safePolicy(p) {
  check(p.custody.dataset === 'controlled_test' && p.custody.purpose === 'controlled_test' && p.local_raw.mode === 'off', 'Only controlled_test with local raw off is accepted.');
  check(p.evidence.mode === 'statistics' && p.evidence.schema === 'window-statistics/1' && p.evidence.extractor_version === 'cp-v3-stats/1' && p.evidence.ruleset_version === 'unclassified-v1', 'A small-statistics policy is required.');
  check(p.uplink.enabled && p.uplink.raw_sample.mode === 'off' && p.uplink.archive.mode === 'off' &&
    p.uplink.streams.length === 2 && p.uplink.streams.includes('window_statistics') && p.uplink.streams.includes('node_status'), 'Only window_statistics and node_status uploads are accepted.');
}
/** Reject extra fields as well as any receipt that does not authorize exact bytes. */
export function expectedStatisticsReceipt(receipt, body) {
  const p = JSON.parse(body);
  const expected = { protocol: 'campuspulse/3', schema: 'device-statistics-receipt/3', node_id: p.n, boot_id: p.o,
    stream: p.k, batch_id: p.b, body_sha256: hash(body), policy_id: p.c, policy_sha256: p.h,
    assignment_generation: p.g, seq_first: p.x[0].q, seq_last: p.x.at(-1).q, accepted_count: p.x.length,
    durability: 'committed', custody: 'small_statistics' };
  check(Object.entries(expected).every(([key, value]) => receipt[key] === value), 'Receipt does not exactly authorize the frozen statistics batch.');
  check(Object.keys(receipt).length === Object.keys(expected).length + 4, 'Unexpected statistics receipt fields.');
  check(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(receipt.receipt_id), 'Invalid committed receipt identity.');
  for (const key of ['received_at', 'expires_at', 'retain_until']) check(typeof receipt[key] === 'string' && new Date(receipt[key]).toISOString() === receipt[key], 'Invalid receipt time.');
  check(Date.parse(receipt.expires_at) > Date.parse(receipt.received_at) && Date.parse(receipt.retain_until) >= Date.parse(receipt.expires_at), 'Invalid statistics retention.');
}
async function prepareState(config, inspection, tools) {
  const now = Date.now(), generation = (config.expectedGeneration ?? 0) + 1;
  check((inspection.desired?.policy?.assignment_generation ?? 0) === generation - 1, 'Unexpected desired generation; set expectedGeneration explicitly.');
  let caps, policy;
  if (config.actor === 'existing_device') {
    check(config.policyTemplateFile, 'Existing-device preparation requires policyTemplateFile.');
    caps = tools.validateDeviceCapabilitiesV3(inspection.capabilities);
    check(caps.node_id === config.nodeId && caps.producer_version === 'cp-v3-small/1' && caps.statistics?.extractor_versions.includes('cp-v3-stats/1'), 'Actual device has not declared the small-statistics producer.');
    check(!inspection.desired || config.expectedGeneration !== undefined, 'Replacing a desired policy needs an explicit expectedGeneration.');
    policy = await readPrivateJson(config.policyTemplateFile);
  } else {
    caps = tools.statisticsCapabilities(config.nodeId, now);
    caps.boot_id = randomUUID(); caps.capability_id = `synthetic-statistics-${randomUUID()}`;
    policy = await tools.statisticsPolicy(caps, config.placementId, generation, now);
    const window = config.policyOptions.windowMs ?? 60000;
    check([1000, 30000, 60000].includes(window), 'Synthetic cadence must be 1000, 30000 or 60000ms.');
    policy.collection.summary.window_ms = window; policy.collection.summary.bin_ms = window === 1000 ? 1000 : 5000;
    policy.temporal = { mode: 'off' };
  }
  policy.node_id = config.nodeId; policy.policy_id = `synthetic-stats-${randomUUID()}`; policy.assignment_generation = generation;
  policy.custody.placement_id = config.placementId;
  policy.custody.accept_until = new Date(now + 7200000).toISOString();
  policy.control.capability_sha256 = await tools.capabilityDigestV3(caps);
  policy.control.activation.boot_id = caps.boot_id;
  policy.control.activation.not_before = new Date(now - 1000).toISOString();
  policy.control.activation.expires_at = new Date(Math.min(now + 1800000, Date.parse(caps.expires_at))).toISOString();
  if (config.actor === 'synthetic_client' && config.policyOptions.leaseDurationMs !== undefined) policy.control.lease.duration_ms = config.policyOptions.leaseDurationMs;
  safePolicy(policy);
  const frozen = await tools.freezeDeviceConfigV3(policy);
  const negotiation = await tools.negotiateDeviceConfigV3(frozen, caps, { node_id: config.nodeId, boot_id: caps.boot_id, now: new Date(now).toISOString(),
    last_assignment_generation: generation - 1, closed_window_seq: policy.control.activation.after_window_seq,
    closed_segment_seq: policy.control.activation.after_segment_seq, window_open: false, segment_open: false });
  check(negotiation.state === 'compatible', 'Policy exceeds actual capability or activation bounds.');
  return { schema: 'v3-statistics-private-state/1', endpoint: config.endpoint, actor: config.actor, caps, frozen };
}
function frozenBodies(state, start) {
  const p = state.frozen.policy, summary = p.collection.summary, duration = summary.window_ms, bins = duration / summary.bin_ms, end = start + duration;
  const envelope = k => ({ p: 3, z: 'statistics/1', b: randomUUID(), n: p.node_id, o: state.caps.boot_id, c: p.policy_id,
    h: state.frozen.policy_sha256, g: p.assignment_generation, d: 'controlled_test', k });
  const statistics = { ...envelope('window_statistics'), x: [{ q: 1, w: p.control.activation.after_window_seq + 1,
    t: [duration + 1000, end, 1, 0], d: duration, b: summary.bin_ms, c: [0, 0, 0, 0, 2, 0],
    r: [4 * bins, 4 * bins, 3 * bins, bins], x: Array.from({ length: bins }, () => [4, 2, 4, -240]),
    s: [4 * bins, -240 * bins, -60, -60], l: [duration, 0, 0, 0], f: 0, v: ['cp-v3-stats/1', 'unclassified-v1'] }] };
  const status = { ...envelope('node_status'), x: [{ q: 1, t: [duration + 1000, end, 1, 0], u: duration + 1000,
    s: 'running', r: [null, null, null, null, null], j: [1, 512, 0, 0, 1, 512], l: [0, 0, 0, 0, 0, 0] }] };
  const bodies = { statistics: JSON.stringify(statistics), status: JSON.stringify(status) };
  check(Object.values(bodies).every(body => Buffer.byteLength(body) <= p.uplink.max_body_bytes), 'Frozen body exceeds negotiated byte budget.');
  return { bodies, observationEnd: end };
}
export async function runStatisticsIntegration(rawConfig, phase = 'exercise', dependencies = {}) {
  const config = validateConfig(rawConfig);
  check(['prepare', 'exercise', 'verify'].includes(phase), 'Unknown phase.');
  check(phase !== 'exercise' || config.actor === 'synthetic_client', 'Exercise is reserved for a separate synthetic client.');
  const tools = await statisticsTools(), transport = dependencies.transport ?? httpsTransport(config.caFile ? await readFile(config.caFile) : undefined);
  const sleep = dependencies.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const report = { schema: 'v3-statistics-integration-report/1', dataset: 'controlled_test', actor: config.actor, phase,
    outcome: 'running', observation_acceptance: 'not_tested_by_phase', started_at: new Date().toISOString(), node_sha256: hash(config.nodeId),
    checks: [], physical_validation: 'not_established' };
  async function call(label, pathname, body, admin = false, expected = 200) {
    const bytes = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const response = await transport(config.endpoint + pathname, { method: bytes === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { ...(admin ? { Cookie: config.adminCookie, Origin: config.endpoint } : { Authorization: `Bearer ${config.deviceBearer}` }),
        ...(bytes === undefined ? {} : { 'Content-Type': 'application/json', 'X-Body-SHA256': hash(bytes) }) }, body: bytes });
    report.checks.push({ check: label, status: response.status, expected_status: expected,
      ...(bytes === undefined ? {} : { request_sha256: hash(bytes), request_bytes: Buffer.byteLength(bytes) }) });
    check(response.status === expected, `Check ${label} failed (HTTP ${response.status}, expected ${expected}).`);
    if (expected !== 200) return null;
    check(response.headers.get('cache-control') === 'no-store', `Check ${label} lacks no-store.`);
    try { return await response.json(); } catch { throw new Error(`Check ${label} returned invalid JSON.`); }
  }
  try {
    let state;
    try { state = await readPrivateJson(path.join(config.outputDir, 'state.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    check(phase !== 'verify' || state, 'Verification requires an existing prepared private state.');
    if (!state) {
      state = await prepareState(config, await call('inspect_before_assignment', `/api/v1/admin/device-v3/nodes/${config.nodeId}`, undefined, true), tools);
      await writePrivate(config.outputDir, 'state.json', state);
    }
    check(state.schema === 'v3-statistics-private-state/1' && state.endpoint === config.endpoint && state.actor === config.actor &&
      state.caps.node_id === config.nodeId && state.frozen.policy.custody.placement_id === config.placementId, 'Private state does not match this run.');
    const frozen = await tools.validateFrozenDeviceConfigV3(state.frozen), p = frozen.policy;
    check(p.control.capability_sha256 === await tools.capabilityDigestV3(state.caps), 'Capability digest changed.'); safePolicy(p);
    if (phase === 'verify') {
      const inspection = await call('inspect_actual_device_ack', `/api/v1/admin/device-v3/nodes/${config.nodeId}`, undefined, true), ack = inspection.acknowledgement;
      check(inspection.state === 'applied' && ack?.state === 'applied' && ack.policy_sha256 === frozen.policy_sha256 && ack.boot_id === state.caps.boot_id &&
        ack.assignment_generation === p.assignment_generation && ack.durability === 'committed', 'Matching committed device ACK is not present.');
      report.outcome = 'device_claimed_applied'; return report;
    }
    if (config.actor === 'synthetic_client') {
      const registration = tools.v3Registration(state.caps), receipt = await call('synthetic_capability_registration', '/api/v3/device/capabilities', registration);
      check(receipt.capability_sha256 === p.control.capability_sha256 && receipt.applied === false, 'Capability receipt mismatch.');
      check(JSON.stringify(await call('capability_exact_retry', '/api/v3/device/capabilities', registration)) === JSON.stringify(receipt), 'Registration retry changed.');
    }
    const assignment = { policy: p, expected_generation: p.assignment_generation - 1 }, assigned = await call('administrator_assignment', '/api/v1/admin/device-v3/assignments', assignment, true);
    check(assigned.policy_sha256 === frozen.policy_sha256 && assigned.applied === false && assigned.requires_device_ack === true, 'Assignment receipt mismatch.');
    check(JSON.stringify(await call('assignment_exact_retry', '/api/v1/admin/device-v3/assignments', assignment, true)) === JSON.stringify(assigned), 'Assignment retry changed.');
    if (phase === 'prepare') { report.outcome = 'prepared_awaiting_device_ack'; return report; }
    const delivered = await call('device_configuration', `/api/v3/device/config?boot_id=${state.caps.boot_id}`);
    check(JSON.stringify(await tools.validateFrozenDeviceConfigV3(delivered.config)) === JSON.stringify(frozen), 'Delivered configuration differs from frozen policy.');
    const ackBody = await tools.v3Ack(p), ack = await call('synthetic_device_ack', '/api/v3/device/config/ack', ackBody);
    check(ack.state === 'applied' && ack.durability === 'committed' && Number.isSafeInteger(ack.lease_until_ms), 'Applied statistics ACK has no committed lease.');
    check(JSON.stringify(await call('ack_exact_retry', '/api/v3/device/config/ack', ackBody)) === JSON.stringify(ack), 'ACK retry changed.');
    if (!state.bodies) {
      const start = Math.max(Date.parse(ack.server_time) + 100, Date.parse(p.control.activation.not_before), Date.parse(state.caps.issued_at));
      check(Number.isFinite(start) && start + p.collection.summary.window_ms < ack.lease_until_ms, 'No complete window fits inside first lease.');
      Object.assign(state, frozenBodies(state, start)); await writePrivate(config.outputDir, 'state.json', state);
    }
    let now = Date.parse(delivered.server_time), waits = 0;
    while (now <= state.observationEnd && waits++ < Math.ceil(p.collection.summary.window_ms / 250) + 40) {
      await sleep(250); now = Date.parse((await call('wait_server_window_closed', `/api/v3/device/config?boot_id=${state.caps.boot_id}`)).server_time);
    }
    check(now > state.observationEnd, 'Server clock has not reached the frozen window end.');
    for (const stream of ['statistics', 'status']) {
      const body = state.bodies[stream], receipt = await call(`${stream}_ingest`, '/api/v3/statistics/ingest', body); expectedStatisticsReceipt(receipt, body);
      const retry = await call(`${stream}_exact_retry`, '/api/v3/statistics/ingest', body); expectedStatisticsReceipt(retry, body);
      check(JSON.stringify(receipt) === JSON.stringify(retry), 'Exact statistics receipt retry changed.');
      report.checks.push({ check: `${stream}_receipt_match`, body_sha256: hash(body), body_bytes: Buffer.byteLength(body), accepted_count: receipt.accepted_count, receipt_sha256: hash(JSON.stringify(receipt)) });
    }
    const changed = state.bodies.statistics + ' ';
    await call('changed_bytes_same_batch_conflict', '/api/v3/statistics/ingest', changed, false, 409);
    const wrong = JSON.parse(state.bodies.statistics); wrong.n = 'synthetic-wrong-node';
    await call('wrong_node_rejected', '/api/v3/statistics/ingest', wrong, false, 403);
    const contact = { protocol: 'campuspulse/3', boot_id: state.caps.boot_id, policy_id: p.policy_id, policy_sha256: frozen.policy_sha256,
      assignment_generation: p.assignment_generation, contact_seq: 1, uptime_ms: p.collection.summary.window_ms + 2000 };
    const lease = await call('synthetic_lease_renewal', '/api/v3/device/lease', contact);
    const expected = { protocol: 'campuspulse/3', schema: 'device-lease/3', node_id: p.node_id, boot_id: state.caps.boot_id,
      policy_id: p.policy_id, policy_sha256: frozen.policy_sha256, assignment_generation: p.assignment_generation, contact_seq: 1,
      uptime_ms: contact.uptime_ms, body_sha256: hash(JSON.stringify(contact)), durability: 'committed', span_seq: 1, contiguous: true };
    check(Object.entries(expected).every(([key, value]) => lease[key] === value) && Object.keys(lease).length === Object.keys(expected).length + 2 &&
      Number.isSafeInteger(lease.lease_until_ms) && lease.lease_until_ms > ack.lease_until_ms && Date.parse(lease.server_time) <= lease.lease_until_ms, 'Lease renewal receipt mismatch.');
    check(JSON.stringify(await call('lease_exact_retry', '/api/v3/device/lease', contact)) === JSON.stringify(lease), 'Lease retry changed.');
    report.outcome = 'synthetic_statistics_acceptance_passed'; report.observation_acceptance = 'synthetic_small_statistics_committed'; return report;
  } catch (error) { report.outcome = 'failed'; throw error; }
  finally { report.finished_at = new Date().toISOString(); await writePrivate(config.outputDir, 'report.json', report); }
}
async function main() {
  const args = process.argv.slice(2);
  check(args.length === 4 && args[0] === '--config' && args[2] === '--phase', 'Usage: node scripts/v3-statistics-integration.mjs --config /private/config.json --phase prepare|exercise|verify');
  const report = await runStatisticsIntegration(await readPrivateJson(args[1]), args[3]);
  process.stdout.write(JSON.stringify({ outcome: report.outcome, phase: report.phase, actor: report.actor, checks: report.checks.length, physical_validation: report.physical_validation }) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(() => {
  process.stderr.write('v3 statistics integration failed; inspect the private redacted report and configuration.\n'); process.exitCode = 1;
});
