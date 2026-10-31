import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDeviceV3Control, type DeviceV3ControlEnv } from '../worker/device-v3-control';
import { capabilityDigestV3, freezeDeviceConfigV3, negotiateDeviceConfigV3, validateDeviceConfigV3 } from '../worker/device-v3-config';
import { cleanupStatisticsLeaseSpans, loadStatisticsAuthority, statisticsCaptureAssertion, supportsV3StatisticsPolicy } from '../worker/device-v3-statistics-policy';
import { authState, Client, ORIGIN, json } from './admin-auth-helpers';
import { DEVICE_TOKEN } from './helpers/ingestion';
import { sha256 } from '../worker/ingest';
import { expireDeviceV3Statistics } from '../worker/device-v3-statistics';
import { v3Ack, v3Registration } from './helpers/device-v3-fixtures';
import { statisticsCapabilities, statisticsPolicy } from './helpers/v3-statistics-policy-fixtures';

let state: Awaited<ReturnType<typeof authState>>, env: DeviceV3ControlEnv, client: Client;
let caps: ReturnType<typeof statisticsCapabilities>, policy: Awaited<ReturnType<typeof statisticsPolicy>>;
const device = async (path: string, body?: unknown, headers: Record<string, string> = {}) => (await handleDeviceV3Control(new Request(ORIGIN + '/api/v3/device' + path,
  { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${DEVICE_TOKEN}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env))!;
const assign = async (p = policy) => (await handleDeviceV3Control(new Request(ORIGIN + '/api/v1/admin/device-v3/assignments',
  { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    body: JSON.stringify({ policy: p, expected_generation: p.assignment_generation - 1 }) }), env))!;
const identity = async () => ({ node_id: policy.node_id, boot_id: caps.boot_id, policy_id: policy.policy_id,
  policy_sha256: (await freezeDeviceConfigV3(policy)).policy_sha256, assignment_generation: policy.assignment_generation });
const contact = async (seq = 1, uptime = 2000) => { const i = await identity(); return { protocol: 'campuspulse/3', boot_id: i.boot_id,
  policy_id: i.policy_id, policy_sha256: i.policy_sha256, assignment_generation: i.assignment_generation, contact_seq: seq, uptime_ms: uptime }; };
async function applied() {
  await json(await device('/capabilities', v3Registration(caps))); await json(await assign());
  return json(await device('/config/ack', await v3Ack(policy)));
}
function interpose(fn: () => void) {
  const batch = env.DB.batch.bind(env.DB); let done = false;
  vi.spyOn(env.DB, 'batch').mockImplementation(async statements => { if (!done) { done = true; fn(); } return batch(statements); });
}
async function captured(start: number, end = start): Promise<boolean> {
  const authority = await loadStatisticsAuthority(env, await identity()), a = statisticsCaptureAssertion(authority, start, end);
  return (await env.DB.prepare(`SELECT CASE WHEN (${a.sql}) THEN 1 ELSE 0 END AS ok`).bind(...a.bindings).first<{ ok: number }>())?.ok === 1;
}
beforeEach(async () => {
  state = await authState(); env = { ...state.env, DEVICE_V3_CONTROL_ENABLED: 'true', DEVICE_V3_STATISTICS_ENABLED: 'true',
    DEVICE_V3_PRODUCER_VERSIONS: '["synthetic-statistics/1"]' };
  client = new Client(state); await client.initialize(); caps = statisticsCapabilities(state.config.node_id);
  policy = await statisticsPolicy(caps, state.config.placement_id);
});
afterEach(() => { vi.restoreAllMocks(); state.db.close(); });

describe('statistics policy and capability extension', () => {
  it('negotiates real bounded statistics without feature or cloud raw support', async () => {
    const context = { node_id: caps.node_id, boot_id: caps.boot_id, now: new Date().toISOString(), last_assignment_generation: 0,
      closed_window_seq: 3, closed_segment_seq: 2, window_open: false, segment_open: false };
    expect(supportsV3StatisticsPolicy(validateDeviceConfigV3(policy))).toBe(true);
    expect((await negotiateDeviceConfigV3(await freezeDeviceConfigV3(policy), caps, context)).state).toBe('compatible');
    policy.local_raw = { mode: 'tf_cpraw', format: 'cpraw/1', max_segment_bytes: 1048576, max_total_bytes: 16777216,
      min_free_bytes: 1048576, sync_interval_ms: 1000, full_behavior: 'stop_recording' };
    expect((await negotiateDeviceConfigV3(await freezeDeviceConfigV3(policy), caps, context)).state).toBe('compatible');
    for (const missing of [undefined, null]) {
      const absent = { ...caps, statistics: missing }; if (missing === undefined) delete absent.statistics;
      policy.control.capability_sha256 = await capabilityDigestV3(absent);
      expect((await negotiateDeviceConfigV3(await freezeDeviceConfigV3(policy), absent, context)).issues).toContainEqual({
        code: missing === undefined ? 'undeclared_capability' : 'unsupported_capability', path: 'capabilities.statistics' });
    }
  });
  it('requires explicit temporal support and rejects incompatible streams, limits and versions', async () => {
    const bad = structuredClone(policy); delete bad.temporal; expect(() => validateDeviceConfigV3(bad)).toThrow();
    if (bad.collection.summary.enabled) bad.collection.summary.max_addresses = 513;
    bad.temporal = { mode: 'off' }; expect(() => validateDeviceConfigV3(bad)).toThrow();
    const raw = structuredClone(policy); if (raw.uplink.enabled) raw.uplink.streams.push('ble_reports');
    expect(() => validateDeviceConfigV3(raw)).toThrow();
    const events = structuredClone(policy); if (events.uplink.enabled) events.uplink.streams.push('candidate_events');
    expect(() => validateDeviceConfigV3(events)).toThrow();
    if (policy.evidence.mode === 'statistics') policy.evidence.ruleset_version = 'unreviewed/1';
    await json(await assign(), 422);
  });
});

describe('explicit statistics capture leases', () => {
  it('recovers only already committed ACKs before new-boot registration without granting authority', async () => {
    await json(await device('/capabilities', v3Registration(caps))); await json(await assign());
    const body = await v3Ack(policy);
    expect(await json(await device('/config/ack', body, { 'X-Receipt-Only': '1' }), 409))
      .toMatchObject({ error: { code: 'v3_receipt_not_committed', retryable: false } });
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_acknowledgements_v3').get()?.n).toBe(0);
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_statistics_lease_spans_v3').get()?.n).toBe(0);
    const original = await json(await device('/config/ack', body));
    const next = { ...caps, boot_id: crypto.randomUUID(), capability_id: 'synthetic-next-boot' };
    await json(await device('/capabilities', v3Registration(next)));
    const before = state.db.prepare('SELECT * FROM device_statistics_authorizations_v3').all();
    expect(await json(await device('/config/ack', body, { 'X-Receipt-Only': '1' }))).toEqual(original);
    expect(state.db.prepare('SELECT * FROM device_statistics_authorizations_v3').all()).toEqual(before);
    await json(await device('/config/ack', { ...body, apply_seq: body.apply_seq + 1 }, { 'X-Receipt-Only': '1' }), 409);
  });
  it('receipt-only lease recovery cannot create or extend a missing renewal', async () => {
    await applied(); const body = await contact();
    const before = state.db.prepare('SELECT * FROM device_statistics_authorizations_v3').all();
    await json(await device('/lease', body, { 'X-Receipt-Only': '1' }), 409);
    expect(state.db.prepare('SELECT * FROM device_statistics_authorizations_v3').all()).toEqual(before);
    const original = await json(await device('/lease', body));
    await json(await device('/lease', await contact(2, 3000), { 'X-Receipt-Only': '1' }), 409);
    const next = { ...caps, boot_id: crypto.randomUUID(), capability_id: 'synthetic-next-boot' };
    await json(await device('/capabilities', v3Registration(next)));
    const afterRetirement = state.db.prepare('SELECT * FROM device_statistics_authorizations_v3').all();
    expect(await json(await device('/lease', body, { 'X-Receipt-Only': '1' }))).toEqual(original);
    expect(state.db.prepare('SELECT * FROM device_statistics_authorizations_v3').all()).toEqual(afterRetirement);
    state.db.prepare('UPDATE device_nodes SET enabled=0').run();
    await json(await device('/lease', body, { 'X-Receipt-Only': '1' }), 401);
  });
  it('rejects receipt-only mode on registration and invalid flag values', async () => {
    await json(await device('/capabilities', v3Registration(caps), { 'X-Receipt-Only': '1' }), 422);
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_capabilities_v3').get()?.n).toBe(0);
    await json(await device('/capabilities', v3Registration(caps), { 'X-Receipt-Only': 'true' }), 422);
  });
  it('requires its independent gate and does not enable legacy feature ingestion', async () => {
    delete env.DEVICE_V3_STATISTICS_ENABLED;
    expect(await json(await assign(), 422)).toMatchObject({ error: { code: 'v3_statistics_unavailable' } });
    expect(await json(await device('/lease', await contact()), 503)).toMatchObject({ error: { code: 'v3_statistics_disabled' } });
    expect(env.DEVICE_V3_INGEST_ENABLED).toBeUndefined();
  });
  it('creates the first lease only at successful applied ACK; GET and retries never renew', async () => {
    await json(await device('/capabilities', v3Registration(caps))); await json(await assign());
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_statistics_authorizations_v3').get()?.n).toBe(0);
    await json(await device('/lease', await contact()), 409);
    const ack = await v3Ack(policy), receipt = await json(await device('/config/ack', ack));
    expect(receipt).toMatchObject({ contact_seq: 0, durability: 'committed', lease_until_ms: expect.any(Number), server_time: expect.any(String),
      body_sha256: await sha256(new TextEncoder().encode(JSON.stringify(ack))) });
    const before = state.db.prepare('SELECT * FROM device_statistics_authorizations_v3').get();
    await json(await device('/config?boot_id=' + caps.boot_id));
    expect(await json(await device('/config/ack', ack))).toEqual(receipt);
    expect(state.db.prepare('SELECT * FROM device_statistics_authorizations_v3').get()).toEqual(before);
    const failure = await statisticsPolicy(caps, state.config.placement_id, 2); await json(await assign(failure));
    const failedBody = { ...await v3Ack(failure, 2), state: 'failed', error_code: 'storage_failed' };
    const failedReceipt = await json(await device('/config/ack', failedBody));
    expect(failedReceipt.body_sha256).toBe(await sha256(new TextEncoder().encode(JSON.stringify(failedBody))));
    expect(failedReceipt.lease_until_ms).toBeUndefined();
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_statistics_authorizations_v3').get()?.n).toBe(1);
  });
  it('renews contiguous spans with exact retries and unchanged acceptance deadline', async () => {
    await applied(); const request = await contact(), receipt = await json(await device('/lease', request));
    expect(receipt).toMatchObject({ contact_seq: 1, contiguous: true, span_seq: 1, durability: 'committed', policy_sha256: request.policy_sha256,
      body_sha256: await sha256(new TextEncoder().encode(JSON.stringify(request))) });
    const before = state.db.prepare('SELECT * FROM device_statistics_authorizations_v3').get();
    expect(await json(await device('/lease', request))).toEqual(receipt);
    expect(state.db.prepare('SELECT * FROM device_statistics_authorizations_v3').get()).toEqual(before);
    expect(before?.accept_until_ms).toBe(Date.parse(policy.custody.accept_until));
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_statistics_lease_spans_v3').get()?.n).toBe(1);
    await json(await device('/lease', { ...request, uptime_ms: request.uptime_ms + 1 }), 409);
    await json(await device('/lease?unexpected=1', request), 422);
    await json(await device('/lease', { ...await contact(2), arbitrary: 1 }), 422);
  });
  it('keeps renewed-after-expiry gaps unauthorized and accepts each original covered interval', async () => {
    await applied(); const now = Date.now();
    state.db.prepare('UPDATE device_statistics_lease_spans_v3 SET start_ms=?,end_ms=?').run(now - 10000, now - 1000);
    state.db.prepare('UPDATE device_statistics_authorizations_v3 SET lease_until_ms=?,state_version=state_version+1').run(now - 1000);
    const receipt = await json(await device('/lease', await contact()));
    expect(receipt).toMatchObject({ contiguous: false, span_seq: 2 });
    expect(await captured(now - 5000, now - 2000)).toBe(true);
    expect(await captured(now - 500, now - 200)).toBe(false);
    expect(await captured(now - 2000, Date.now())).toBe(false);
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_statistics_lease_spans_v3').get()?.n).toBe(2);
  });
  it('retains original successful boot authority after reboot and closes its future capture span', async () => {
    await applied(); const start = Number(state.db.prepare('SELECT start_ms FROM device_statistics_lease_spans_v3').get()!.start_ms);
    await new Promise(resolve => setTimeout(resolve, 5));
    const nextCaps = { ...caps, boot_id: crypto.randomUUID(), capability_id: 'next-boot' };
    await json(await device('/capabilities', v3Registration(nextCaps, 1, 0)));
    expect(await captured(start)).toBe(true); expect(await captured(Date.now() + 1000)).toBe(false);
    await json(await device('/lease', await contact()), 409);
    const auth = await loadStatisticsAuthority(env, await identity()); expect(auth.policy.policy_id).toBe(policy.policy_id);
    expect(state.db.prepare('SELECT accept_until_ms FROM device_statistics_authorizations_v3').get()?.accept_until_ms).toBe(Date.parse(policy.custody.accept_until));
  });
  it('fails closed on a corrupted stored ACK identity', async () => {
    await applied();
    state.db.exec('DROP TRIGGER device_acknowledgements_v3_immutable_update');
    state.db.prepare("UPDATE device_acknowledgements_v3 SET acknowledgement_json=json_set(acknowledgement_json,'$.boot_id',?)").run(crypto.randomUUID());
    await expect(loadStatisticsAuthority(env, await identity())).rejects.toMatchObject({ code: 'v3_registry_invalid' });
  });
  it.each(['present', 'commit_race', 'cleaned'])('rejects applied window-floor regression against %s statistics', async scenario => {
    await applied(); const next = await statisticsPolicy(caps, state.config.placement_id, 2); await json(await assign(next));
    const batch = crypto.randomUUID(), hash = (await identity()).policy_sha256, now = Date.now();
    const seed = () => {
      state.db.prepare(`INSERT INTO statistics_batches_v3(node_id,batch_id,boot_id,stream,generation,policy_sha256,body_sha256,seq_first,seq_last,receipt_json,expires_at_ms,retain_until_ms)
        VALUES(?,?,?,'window_statistics',1,?,?,1,1,'{}',?,?)`).run(policy.node_id, batch, caps.boot_id, hash, '0'.repeat(64), now + 60000, now + 60000);
      state.db.prepare(`INSERT INTO statistics_windows_v3(node_id,boot_id,generation,clock_epoch,window_seq,seq,batch_id,placement_id,dataset,collection_mode,
        end_utc_ms,end_mono_ms,uncertainty_ms,duration_ms,received_at_ms,quality_mask,extractor_version,ruleset_version,item_json,expires_at_ms,retain_until_ms)
        VALUES(?,?,1,1,50,1,?,?,'controlled_test','fixed_point',?,60000,0,60000,?,0,'cp-v3-stats/1','unclassified-v1',NULL,?,?)`)
        .run(policy.node_id, caps.boot_id, batch, state.config.placement_id, now, now, now + 60000, now + 60000);
    };
    if (scenario === 'commit_race') interpose(seed); else seed();
    if (scenario === 'cleaned') {
      await expireDeviceV3Statistics(env, now + 2 * 86400000);
      expect(state.db.prepare('SELECT COUNT(*) n FROM statistics_windows_v3').get()?.n).toBe(0);
      expect(state.db.prepare("SELECT window_seq_floor FROM statistics_sequence_floors_v3 WHERE stream='window_statistics'").get()?.window_seq_floor).toBe(50);
    }
    await json(await device('/config/ack', await v3Ack(next, 2)), 409);
    expect(state.db.prepare('SELECT COUNT(*) n FROM statistics_windows_v3').get()?.n).toBe(scenario === 'cleaned' ? 0 : 1);
    expect(state.db.prepare('SELECT applied_generation FROM device_control_v3').get()?.applied_generation).toBe(1);
    vi.restoreAllMocks();
    await json(await device('/config/ack', { ...await v3Ack(next, 2), closed_window_seq: 50 }));
    // A fresh boot has an independent window sequence, despite historical rows.
    const reboot = { ...caps, boot_id: crypto.randomUUID(), capability_id: 'independent-boot' };
    await json(await device('/capabilities', v3Registration(reboot, 1, 0)));
    const fresh = await statisticsPolicy(reboot, state.config.placement_id, 3); await json(await assign(fresh));
    await json(await device('/config/ack', await v3Ack(fresh, 1)));
  });
  it('does not require statistics source migration 0017 for a control-only deployment', async () => {
    state.db.exec('DROP TABLE statistics_windows_v3; DROP TABLE statistics_sequence_floors_v3');
    await applied();
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_statistics_authorizations_v3').get()?.n).toBe(1);
  });
  it.each(['boot', 'capability'])('replays original receipts after a %s change without granting any new capture', async change => {
    const ackBody = await v3Ack(policy), ack = await applied(), leaseBody = await contact(), lease = await json(await device('/lease', leaseBody));
    const nextCaps = { ...caps, capability_id: 'changed-capability', ...(change === 'boot' ? { boot_id: crypto.randomUUID() } : { producer_version: 'synthetic-statistics/2' }) };
    await json(await device('/capabilities', v3Registration(nextCaps, change === 'boot' ? 1 : 2, change === 'boot' ? 0 : 3000)));
    const before = state.db.prepare('SELECT * FROM device_statistics_authorizations_v3').get();
    const spans = state.db.prepare('SELECT * FROM device_statistics_lease_spans_v3').all();
    expect(await json(await device('/config/ack', ackBody))).toEqual(ack);
    expect(await json(await device('/lease', leaseBody))).toEqual(lease);
    expect(state.db.prepare('SELECT * FROM device_statistics_authorizations_v3').get()).toEqual(before);
    expect(state.db.prepare('SELECT * FROM device_statistics_lease_spans_v3').all()).toEqual(spans);
    expect(Number(before!.lease_until_ms)).toBeLessThanOrEqual(Date.now());
  });
  it('re-negotiates the complete historical capability instead of trusting valid hashes alone', async () => {
    await applied();
    caps.summary!.max_addresses = 8;
    policy.control.capability_sha256 = await capabilityDigestV3(caps);
    const frozen = await freezeDeviceConfigV3(policy);
    state.db.exec(`PRAGMA foreign_keys=OFF;
      DROP TRIGGER device_capabilities_v3_immutable_update; DROP TRIGGER device_assignments_v3_immutable_update;
      DROP TRIGGER device_acknowledgements_v3_immutable_update; DROP TRIGGER device_statistics_authorizations_v3_identity;`);
    state.db.prepare('UPDATE device_capabilities_v3 SET capability_sha256=?,capability_json=?').run(policy.control.capability_sha256, JSON.stringify(caps));
    state.db.prepare('UPDATE device_assignments_v3 SET capability_sha256=?,policy_sha256=?,envelope_json=?').run(policy.control.capability_sha256, frozen.policy_sha256, JSON.stringify(frozen));
    state.db.prepare("UPDATE device_acknowledgements_v3 SET acknowledgement_json=json_set(acknowledgement_json,'$.policy_sha256',?)").run(frozen.policy_sha256);
    state.db.prepare('UPDATE device_statistics_authorizations_v3 SET policy_sha256=?').run(frozen.policy_sha256);
    await expect(loadStatisticsAuthority(env, await identity())).rejects.toMatchObject({ code: 'v3_registry_invalid' });
  });
  it.each(['disable', 'credential', 'placement', 'generation', 'lease'])('rolls back a %s race during renewal', async kind => {
    await applied(); const before = state.db.prepare('SELECT contact_seq FROM device_statistics_authorizations_v3').get();
    interpose(() => {
      if (kind === 'disable') state.db.prepare('UPDATE device_nodes SET enabled=0').run();
      if (kind === 'credential') state.db.prepare('UPDATE device_nodes SET credential_sha256=?').run('0'.repeat(64));
      if (kind === 'placement') state.db.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES(?,?,?,?)')
        .run(state.config.placement_id, policy.node_id, Date.now() - 1, new Date().toISOString());
      if (kind === 'generation') state.db.prepare('UPDATE device_control_v3 SET state_version=state_version+1').run();
      if (kind === 'lease') state.db.prepare('UPDATE device_statistics_authorizations_v3 SET state_version=state_version+1').run();
    });
    await json(await device('/lease', await contact()), ['disable', 'credential'].includes(kind) ? 401 : 409);
    expect(state.db.prepare('SELECT contact_seq FROM device_statistics_authorizations_v3').get()).toEqual(before);
  });
  it('checks administrator expiry at the final database clock and atomic initial lease authorization', async () => {
    await json(await device('/capabilities', v3Registration(caps)));
    const expiry = state.db.prepare("SELECT expires_at_ms FROM admin_sessions WHERE role='admin'").get()!.expires_at_ms;
    interpose(() => state.db.prepare('UPDATE admin_sessions SET expires_at_ms=0').run());
    await json(await assign(), 401); expect(state.db.prepare('SELECT COUNT(*) n FROM device_assignments_v3').get()?.n).toBe(0);
    vi.restoreAllMocks(); state.db.prepare("UPDATE admin_sessions SET expires_at_ms=? WHERE role='admin'").run(expiry); await json(await assign());
    interpose(() => state.db.prepare('UPDATE device_nodes SET enabled=0').run());
    await json(await device('/config/ack', await v3Ack(policy)), 401);
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_statistics_authorizations_v3').get()?.n).toBe(0);
  });
  it.each(['registration', 'assignment', 'ack', 'lease'])('rechecks authorization after all %s writes and rolls back trigger revocation', async operation => {
    if (operation !== 'registration') await json(await device('/capabilities', v3Registration(caps)));
    if (operation === 'ack' || operation === 'lease') await json(await assign());
    if (operation === 'lease') await json(await device('/config/ack', await v3Ack(policy)));
    const clause = operation === 'registration' ? 'AFTER INSERT ON device_control_v3' : operation === 'assignment' ? 'AFTER INSERT ON admin_audit' :
      operation === 'ack' ? 'AFTER INSERT ON device_acknowledgements_v3' : 'AFTER UPDATE OF contact_seq ON device_statistics_authorizations_v3';
    const revoke = operation === 'assignment' ? 'DELETE FROM admin_sessions;' : 'UPDATE device_nodes SET enabled=0;';
    state.db.exec(`CREATE TRIGGER test_revoke_after_write ${clause} BEGIN ${revoke} END;`);
    const response = operation === 'registration' ? await device('/capabilities', v3Registration(caps)) : operation === 'assignment' ? await assign() :
      operation === 'ack' ? await device('/config/ack', await v3Ack(policy)) : await device('/lease', await contact());
    await json(response, 409);
    expect(state.db.prepare('SELECT enabled FROM device_nodes').get()?.enabled).toBe(1);
    expect(Number(state.db.prepare('SELECT COUNT(*) n FROM admin_sessions').get()?.n)).toBeGreaterThan(0);
    expect(state.db.prepare('SELECT COUNT(*) n FROM admin_write_assertions').get()?.n).toBe(0);
    if (operation === 'lease') expect(state.db.prepare('SELECT contact_seq FROM device_statistics_authorizations_v3').get()?.contact_seq).toBe(0);
    else expect(state.db.prepare('SELECT COUNT(*) n FROM device_statistics_authorizations_v3').get()?.n).toBe(0);
  });
  it('rolls back when a late write crosses the policy deadline after earlier guards passed', async () => {
    await applied(); let clock = Date.now();
    state.db.function('test_advance_time', () => { clock = Date.parse(policy.control.activation.expires_at) + 1; return 0; });
    state.db.function('strftime', (format, _date) => {
      const fmt = String(format);
      if (fmt === '%s') return String(Math.floor(clock / 1000));
      if (fmt === '%f') return new Date(clock).toISOString().slice(17, 23);
      if (fmt === '%Y-%m-%dT%H:%M:%fZ') return new Date(clock).toISOString();
      throw new Error('Unexpected synthetic time format');
    });
    state.db.exec('CREATE TRIGGER test_deadline AFTER UPDATE OF state_version ON device_control_v3 BEGIN SELECT test_advance_time(); END;');
    await json(await device('/lease', await contact()), 409);
    expect(state.db.prepare('SELECT contact_seq FROM device_statistics_authorizations_v3').get()?.contact_seq).toBe(0);
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_statistics_lease_spans_v3').get()?.n).toBe(1);
  });
  it('preserves lifetime span quota and identity after independent disabled-service cleanup', async () => {
    await applied();
    state.db.prepare('UPDATE device_statistics_authorizations_v3 SET span_count=4096,state_version=state_version+1').run();
    state.db.prepare('UPDATE device_statistics_lease_spans_v3 SET accept_until_ms=0').run();
    delete env.DEVICE_V3_STATISTICS_ENABLED; await cleanupStatisticsLeaseSpans(env);
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_statistics_lease_spans_v3').get()?.n).toBe(0);
    expect(state.db.prepare('SELECT span_count FROM device_statistics_authorizations_v3').get()?.span_count).toBe(4096);
    expect(() => state.db.prepare('DELETE FROM device_statistics_authorizations_v3').run()).toThrow(/v3_immutable/);
  });
  it('skips lease cleanup safely before the additive migration is installed', async () => {
    state.db.exec('DROP TABLE device_statistics_lease_spans_v3'); delete env.DEVICE_V3_STATISTICS_ENABLED;
    await expect(cleanupStatisticsLeaseSpans(env)).resolves.toBeUndefined();
  });
});
