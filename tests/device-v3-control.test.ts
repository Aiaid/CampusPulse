import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDeviceV3Control, type DeviceV3ControlEnv } from '../worker/device-v3-control';
import { authState, Client, ORIGIN, json } from './admin-auth-helpers';
import { DEVICE_TOKEN } from './helpers/ingestion';
import { V3_BOOT, v3Ack, v3Capabilities, v3Policy, v3Registration } from './helpers/device-v3-fixtures';
import type { DeviceCapabilitiesV3, DeviceConfigV3 } from '../worker/device-v3-config';
let state: Awaited<ReturnType<typeof authState>>, env: DeviceV3ControlEnv, client: Client;
let caps: DeviceCapabilitiesV3, policy: DeviceConfigV3;
async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return (await handleDeviceV3Control(new Request(ORIGIN + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }), env))!;
}
const device = (path: string, body?: unknown) => request('/api/v3/device' + path, body === undefined ? 'GET' : 'POST', body, { Authorization: `Bearer ${DEVICE_TOKEN}` });
const admin = (path: string, body?: unknown, extra: Record<string, string> = {}) => request('/api/v1/admin/device-v3' + path, body === undefined ? 'GET' : 'POST', body,
  { Cookie: [...client.cookies].map(([key, value]) => `${key}=${value}`).join('; '), Origin: ORIGIN, ...extra });
const publish = (p = policy, expected = p.assignment_generation - 1) => admin('/assignments', { policy: p, expected_generation: expected });
const status = () => admin('/nodes/' + policy.node_id);
const fetchConfig = () => device('/config?boot_id=' + caps.boot_id);
async function prepare() { await json(await device('/capabilities', v3Registration(caps))); await json(await publish()); }
function interpose(action: () => unknown) {
  const original = env.DB.batch.bind(env.DB); let fired = false;
  vi.spyOn(env.DB, 'batch').mockImplementation(async writes => { if (!fired) { fired = true; await action(); } return original(writes); });
}
beforeEach(async () => {
  state = await authState(); env = { ...state.env, DEVICE_V3_CONTROL_ENABLED: 'true' };
  client = new Client(state); await client.initialize(); caps = v3Capabilities(state.config.node_id); policy = await v3Policy(caps);
});
afterEach(() => { vi.restoreAllMocks(); state.db.close(); });

describe('experimental v3 control boundary', () => {
  it('is disabled by default, claims no unrelated route, and preserves v1 policy state', async () => {
    delete env.DEVICE_V3_CONTROL_ENABLED;
    expect(await json(await fetchConfig(), 503)).toMatchObject({ error: { code: 'v3_control_disabled' } });
    expect(await handleDeviceV3Control(new Request(ORIGIN + '/api/v2/device/config'), env)).toBeNull();
    expect(state.db.prepare('SELECT config_json FROM capture_configs').get()).toMatchObject({ config_json: JSON.stringify(state.config) });
  });
  it('authenticates both principals, rejects cross-origin and noncanonical bodies', async () => {
    await json(await request('/api/v3/device/config'), 401);
    await json(await request('/api/v1/admin/device-v3/assignments', 'POST', { policy, expected_generation: 0 }, { Authorization: `Bearer ${DEVICE_TOKEN}`, Origin: ORIGIN }), 401);
    await json(await admin('/assignments', { policy, expected_generation: 0 }, { Origin: 'https://evil.example.test' }), 403);
    await json(await device('/capabilities', '{"protocol":"campuspulse/3","protocol":"campuspulse/3"}'), 422);
    await json(await device('/capabilities', v3Registration({ ...caps, node_id: 'another-node' })), 403);
    await json(await device('/capabilities', { ...v3Registration(caps), unexpected_secret: 'PRIVATE_NOT_ECHOED' }), 422);
    const oversized = await device('/capabilities', ' '.repeat(32769)); expect(oversized.status).toBe(413);
    await json(await request('/api/v3/device/config', 'POST', {}), 405);
  });
  it('records a device claim, immutable assignment and pending state without fabricating applied', async () => {
    const reg = await json(await device('/capabilities', v3Registration(caps)));
    expect(reg).toMatchObject({ applied: false, capability_evidence: 'device_claim' });
    expect(await json(await device('/capabilities', v3Registration(caps)))).toEqual(reg);
    const assigned = await json(await publish()); expect(assigned).toMatchObject({ state: 'assigned', applied: false, requires_device_ack: true });
    expect(await json(await publish())).toEqual(assigned);
    expect(await json(await status())).toMatchObject({ state: 'pending', applied_generation: null, acknowledgement: null });
    expect(await json(await fetchConfig())).toMatchObject({ config: { policy }, data_ingestion_available: false, applied_generation: null });
    await json(await device('/config'), 422);
    await json(await device('/config?boot_id=' + V3_BOOT + '&boot_id=' + V3_BOOT), 422);
    expect(() => state.db.prepare("UPDATE device_assignments_v3 SET envelope_json='{}'").run()).toThrow(/v3_immutable/);
    expect(() => state.db.prepare("UPDATE device_capabilities_v3 SET capability_json='{}'").run()).toThrow(/v3_immutable/);
  });
  it('bounds current-boot registration ordering and prevents retired boot replay', async () => {
    await prepare(); const ack = await v3Ack(policy); await json(await device('/config/ack', ack));
    await json(await device('/capabilities', v3Registration(caps, 1, 2000)), 409);
    await json(await device('/capabilities', v3Registration(caps, 2, 0)), 409);
    await json(await device('/capabilities', v3Registration(caps, 2, 2000)));
    await json(await device('/capabilities', v3Registration(caps)), 409);
    const next = { ...caps, capability_id: 'synthetic-new-boot', boot_id: '22222222-2222-4222-8222-222222222222' };
    await json(await device('/capabilities', v3Registration(next, 1, 0)));
    expect(await json(await status())).toMatchObject({ state: 'unavailable', desired_unavailable_reason: 'boot_changed', applied_generation: null });
    await json(await fetchConfig(), 409);
    await json(await device('/capabilities', v3Registration(caps, 3, 3000)), 409);
    // A committed retry is historical evidence only and cannot restore current applied state.
    expect(await json(await device('/config/ack', ack))).toMatchObject({ evidence: 'device_ack' });
    expect(state.db.prepare('SELECT applied_generation FROM device_control_v3').get()?.applied_generation).toBeNull();
  });
  it('requires matching immutable identities and closed device boundaries before applied ACK', async () => {
    await prepare(); const ack = await v3Ack(policy);
    for (const patch of [{ policy_id: 'other' }, { policy_sha256: '0'.repeat(64) }, { assignment_generation: 2 }, { boot_id: crypto.randomUUID() }]) await json(await device('/config/ack', { ...ack, ...patch }), 409);
    for (const patch of [{ window_open: true }, { segment_open: true }, { closed_window_seq: 2 }, { closed_segment_seq: 1 }]) await json(await device('/config/ack', { ...ack, ...patch }), 422);
    const applied = await json(await device('/config/ack', ack));
    expect(applied).toMatchObject({ state: 'applied', evidence: 'device_ack', durability: 'committed' });
    expect(await json(await device('/config/ack', ack))).toEqual(applied);
    expect(await json(await status())).toMatchObject({ state: 'applied', applied_generation: 1 });
    await json(await device('/config/ack', { ...ack, state: 'failed', error_code: 'storage_failed' }), 409);
  });
  it('retains previous actual state after a terminal failed ACK and rejects superseded activation', async () => {
    await prepare(); const ack = await v3Ack(policy); await json(await device('/config/ack', ack));
    const next = await v3Policy(caps, 2); await json(await publish(next));
    expect(await json(await status())).toMatchObject({ state: 'pending', applied_generation: 1 });
    const failed = { ...await v3Ack(next, 2), state: 'failed', error_code: 'storage_failed' };
    const saved = await json(await device('/config/ack', failed)); expect(await json(await device('/config/ack', failed))).toEqual(saved);
    expect(await json(await status())).toMatchObject({ state: 'failed', applied_generation: 1 });
    await json(await device('/config/ack', await v3Ack(next, 3)), 409);
    const third = await v3Policy(caps, 3); await json(await publish(third));
    await json(await device('/config/ack', { ...ack, apply_seq: 4 }), 409);
  });
  it('rejects expired capability/policy or placement delivery and applied ACK while accepting failure evidence', async () => {
    policy.custody = { ...policy.custody, dataset: 'controlled_test', purpose: 'controlled_test', placement_id: state.config.placement_id };
    await prepare();
    state.db.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES(?,?,?,?)').run(state.config.placement_id, policy.node_id, Date.now() - 1, new Date().toISOString());
    expect(await json(await fetchConfig())).toMatchObject({ config: null, reason: 'placement_inactive' });
    await json(await device('/config/ack', await v3Ack(policy)), 409);
    await json(await device('/config/ack', { ...await v3Ack(policy), state: 'failed', error_code: 'unsupported_config' }));
  });
  it('allows future assignments but rejects premature applied ACK and expires deliveries', async () => {
    policy.control.activation.not_before = new Date(Date.now() + 600000).toISOString();
    await prepare(); expect(await json(await fetchConfig())).toMatchObject({ config: { policy }, activation_not_before: policy.control.activation.not_before });
    await json(await device('/config/ack', await v3Ack(policy)), 422);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(policy.control.activation.expires_at));
    expect(await json(await fetchConfig())).toMatchObject({ config: null, reason: 'policy_expired' });
    await json(await device('/config/ack', await v3Ack(policy)), 409);
  });
  it('invalidates a desired policy when its complete capability snapshot changes', async () => {
    await prepare(); const updated = { ...caps, capability_id: 'changed-caps', producer_version: 'synthetic-only/2' };
    await json(await device('/capabilities', v3Registration(updated, 2, 2000)));
    expect(await json(await fetchConfig())).toMatchObject({ config: null, reason: 'capabilities_changed' });
    await json(await device('/config/ack', await v3Ack(policy)), 409);
    await json(await publish(await v3Policy(caps, 2)), 422);
  });
  it.each([0, 1])('rejects a future activation %i ms at or after capability expiry', async offset => {
    await json(await device('/capabilities', v3Registration(caps)));
    policy.control.activation.not_before = new Date(Date.parse(caps.expires_at) + offset).toISOString();
    policy.control.activation.expires_at = new Date(Date.parse(caps.expires_at) + 60000).toISOString();
    expect(await json(await publish(), 422)).toMatchObject({ error: { code: 'v3_capability_interval_disjoint' } });
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_assignments_v3').get()?.n).toBe(0);
  });
  it('rejects an otherwise valid uplink policy until v3 ingestion exists', async () => {
    policy.custody = { ...policy.custody, dataset: 'controlled_test', purpose: 'controlled_test', placement_id: state.config.placement_id, max_upload_bytes_per_day: 4096 };
    policy.uplink = { enabled: true, transport: 'https', streams: ['node_status'], max_batch_items: 1, max_body_bytes: 512,
      retry: { min_delay_ms: 1000, max_delay_ms: 5000, max_attempts: 2 }, raw_sample: { mode: 'off' }, archive: { mode: 'off' } };
    policy.local_queue = { mode: 'best_effort_research', medium: 'ram', max_bytes: 4096, max_items: 4, control_reserve_bytes: 512, control_reserve_items: 1,
      stream_reserves: [{ stream: 'node_status', bytes: 512, items: 1 }], high_water_percent: 80, full_behavior: 'drop_new_counted', recovery: 'none' };
    expect(await json(await publish(), 422)).toMatchObject({ error: { code: 'v3_uplink_unavailable' } });
  });
  it('rolls back credential disable and session revocation races', async () => {
    interpose(() => state.db.prepare('UPDATE device_nodes SET enabled=0').run());
    await json(await device('/capabilities', v3Registration(caps)), 401);
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_boots_v3').get()?.n).toBe(0);
    vi.restoreAllMocks(); state.db.prepare('UPDATE device_nodes SET enabled=1').run();
    await json(await device('/capabilities', v3Registration(caps)));
    interpose(() => state.db.prepare('DELETE FROM admin_sessions').run());
    await json(await publish(), 401); expect(state.db.prepare('SELECT COUNT(*) n FROM device_assignments_v3').get()?.n).toBe(0);
  });
  it('atomically rejects a disable race at ACK commit', async () => {
    await prepare(); interpose(() => state.db.prepare('UPDATE device_nodes SET enabled=0').run());
    await json(await device('/config/ack', await v3Ack(policy)), 401);
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_acknowledgements_v3').get()?.n).toBe(0);
    expect(state.db.prepare('SELECT applied_generation FROM device_control_v3').get()?.applied_generation).toBeNull();
  });
  it('rejects credential rotation during registration and placement closure during assignment', async () => {
    const oldHash = state.db.prepare('SELECT credential_sha256 FROM device_nodes').get()!.credential_sha256;
    interpose(() => state.db.prepare('UPDATE device_nodes SET credential_sha256=?').run('0'.repeat(64)));
    await json(await device('/capabilities', v3Registration(caps)), 401);
    vi.restoreAllMocks(); state.db.prepare('UPDATE device_nodes SET credential_sha256=?').run(oldHash);
    await json(await device('/capabilities', v3Registration(caps)));
    policy.custody = { ...policy.custody, dataset: 'controlled_test', purpose: 'controlled_test', placement_id: state.config.placement_id };
    interpose(() => state.db.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES(?,?,?,?)')
      .run(state.config.placement_id, policy.node_id, Date.now() - 1, new Date().toISOString()));
    await json(await publish(), 409); expect(state.db.prepare('SELECT COUNT(*) n FROM device_assignments_v3').get()?.n).toBe(0);
  });
  it('rejects an ACK whose desired assignment changes before the transaction', async () => {
    await prepare();
    interpose(() => state.db.prepare('UPDATE device_control_v3 SET desired_generation=NULL,state_version=state_version+1').run());
    await json(await device('/config/ack', await v3Ack(policy)), 409);
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_acknowledgements_v3').get()?.n).toBe(0);
  });
  it('uses transaction time for session expiry after a delayed request', async () => {
    await json(await device('/capabilities', v3Registration(caps)));
    interpose(async () => {
      // The initial session assertion has already captured its earlier cutoff.
      // Leave expiry after that cutoff, then cross it before executing the batch.
      const expires = Date.now() + 20;
      state.db.prepare('UPDATE admin_sessions SET expires_at_ms=?').run(expires);
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    await json(await publish(), 401);
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_assignments_v3').get()?.n).toBe(0);
  });
  it('keeps transient storage failure retryable without recording partial state', async () => {
    await prepare(); vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(new Error('Synthetic storage outage'));
    expect(await json(await device('/config/ack', await v3Ack(policy)), 503)).toMatchObject({ error: { code: 'storage_unavailable', retryable: true } });
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_acknowledgements_v3').get()?.n).toBe(0);
    await json(await device('/config/ack', await v3Ack(policy)));
  });
  it('deduplicates concurrent registrations, assignments and ACKs without duplicate evidence', async () => {
    const regs = await Promise.all([device('/capabilities', v3Registration(caps)), device('/capabilities', v3Registration(caps))]);
    expect(await json(regs[0])).toEqual(await json(regs[1]));
    const writes = await Promise.all([publish(), publish()]); expect(await json(writes[0])).toEqual(await json(writes[1]));
    const ack = await v3Ack(policy), acks = await Promise.all([device('/config/ack', ack), device('/config/ack', ack)]);
    expect(await json(acks[0])).toEqual(await json(acks[1]));
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_acknowledgements_v3').get()?.n).toBe(1);
    expect(state.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='device_v3.assign'").get()?.n).toBe(1);
  });
  it('rejects incompatible generation/capability claims without exposing arbitrary input values', async () => {
    await json(await device('/capabilities', v3Registration(caps)));
    await json(await publish(policy, 1), 422);
    await json(await publish(await v3Policy(caps, 2)), 409);
    const incompatible = structuredClone(policy); incompatible.resources.working_bytes = 2097152;
    await json(await publish(incompatible), 422);
    const changed = { ...caps, producer_version: 'PRIVATE_NOT_ECHOED' };
    const error = await json(await device('/capabilities', v3Registration(changed, 2, 2000)), 409); expect(JSON.stringify(error)).not.toContain('PRIVATE_NOT_ECHOED');
  });
});
