import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDeviceV3Control, type DeviceV3ControlEnv } from '../worker/device-v3-control';
import { capabilityDigestV3, type DeviceConfigV3 } from '../worker/device-v3-config';
import { authState, Client, ORIGIN, json } from './admin-auth-helpers';
import { DEVICE_TOKEN } from './helpers/ingestion';
import { v3Ack, v3Registration } from './helpers/device-v3-fixtures';
import { statisticsCapabilities, statisticsPolicy } from './helpers/v3-statistics-policy-fixtures';
let state: Awaited<ReturnType<typeof authState>>, env: DeviceV3ControlEnv, client: Client;
let caps: ReturnType<typeof statisticsCapabilities>, policy: DeviceConfigV3;
async function request(path: string, body?: unknown, admin = false) {
  return (await handleDeviceV3Control(new Request(ORIGIN + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: ORIGIN, ...(admin ? { Cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : { Authorization: `Bearer ${DEVICE_TOKEN}` }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env))!;
}
const device = (path: string, body?: unknown) => request('/api/v3/device' + path, body);
const grant = (body?: unknown) => request('/api/v1/admin/device-v3/nodes/' + caps.node_id + '/startup-grant', body, true);
const config = () => device('/config?boot_id=' + caps.boot_id);
const assign = (p = policy) => request('/api/v1/admin/device-v3/assignments', { policy: p, expected_generation: p.assignment_generation - 1 }, true);
const approval = () => ({ enabled: true, expected_revision: 0, source_generation: 1,
  grant_expires_at: new Date(Date.now() + 86400000).toISOString(), policy_ttl_ms: 1200000, accept_grace_ms: 3600000 });
async function prepare() {
  await json(await device('/capabilities', v3Registration(caps))); await json(await assign());
  await json(await device('/config/ack', await v3Ack(policy)));
}
async function reboot() {
  caps = { ...caps, boot_id: crypto.randomUUID(), capability_id: 'synthetic-' + crypto.randomUUID() };
  await json(await device('/capabilities', v3Registration(caps)));
}
beforeEach(async () => {
  state = await authState(); env = { ...state.env, DEVICE_V3_CONTROL_ENABLED: 'true', DEVICE_V3_STATISTICS_ENABLED: 'true',
    DEVICE_V3_PRODUCER_VERSIONS: '["synthetic-statistics/1"]', DEVICE_V3_STARTUP_ENABLED: 'true' };
  client = new Client(state); await client.initialize(); caps = statisticsCapabilities(state.config.node_id);
  caps.uplink!.transports = ['mqtt_tls']; policy = await statisticsPolicy(caps, state.config.placement_id);
  if (policy.uplink.enabled) policy.uplink.transport = 'mqtt_tls';
});
afterEach(() => { vi.restoreAllMocks(); state.db.close(); });

describe('explicit renewable startup authority', () => {
  it('never converts existing manual assignments to automatic authority by default', async () => {
    await prepare(); await reboot();
    expect(await json(await config())).toMatchObject({ config: null, reason: 'boot_changed' });
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_startup_grants_v3').get()?.n).toBe(0);
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_assignments_v3').get()?.n).toBe(1);
  });
  it('requires enabled service, administrator, exact applied source and bounded explicit approval', async () => {
    await json(await device('/capabilities', v3Registration(caps))); await json(await assign());
    await json(await grant(approval()), 409);
    await json(await device('/config/ack', await v3Ack(policy)));
    delete env.DEVICE_V3_STARTUP_ENABLED; await json(await grant(approval()), 422); env.DEVICE_V3_STARTUP_ENABLED = 'true';
    await json(await request('/api/v1/admin/device-v3/nodes/' + caps.node_id + '/startup-grant', approval()), 401);
    await json(await grant({ ...approval(), policy_ttl_ms: 1800001 }), 422);
    await json(await grant({ ...approval(), accept_grace_ms: 86400000 }), 422);
    await json(await grant({ ...approval(), grant_expires_at: new Date(Date.now() + 31 * 86400000).toISOString() }), 422);
    await json(await grant(approval()));
    expect(await json(await grant())).toMatchObject({ startup_grant: { enabled: 1, revision: 1 }, applied: false });
  });
  it('mints a new boot/digest/generation without ACK or lease, preserves the old custody deadline', async () => {
    await prepare(); await json(await grant(approval())); const old = state.db.prepare('SELECT * FROM device_assignments_v3').get();
    await reboot(); const reply = await json(await config()); const p = reply.config.policy as DeviceConfigV3;
    expect(p.assignment_generation).toBe(2); expect(p.control.activation.boot_id).toBe(caps.boot_id);
    expect(p.control.capability_sha256).toBe(await capabilityDigestV3(caps)); expect(reply.applied_generation).toBeNull();
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_acknowledgements_v3').get()?.n).toBe(1);
    expect(state.db.prepare('SELECT * FROM device_assignments_v3 WHERE generation=1').get()).toEqual(old);
    expect(await json(await config())).toMatchObject({ config: reply.config });
    expect(await json(await device('/config/ack', { ...await v3Ack(p), window_open: true }), 422)).toMatchObject({ error: { code: 'v3_activation_rejected' } });
    await json(await device('/config/ack', await v3Ack(p)));
    expect(state.db.prepare('SELECT applied_generation FROM device_control_v3').get()?.applied_generation).toBe(2);
  });
  it('refreshes actual same-boot capabilities at a closed boundary, without extending an old policy', async () => {
    await prepare(); await json(await grant(approval())); await reboot();
    const p = (await json(await config())).config.policy as DeviceConfigV3;
    await json(await device('/config/ack', await v3Ack(p)));
    caps = { ...caps, capability_id: 'fresh-actual-capability', issued_at: new Date(Date.now() - 1).toISOString() };
    await json(await device('/capabilities', v3Registration(caps, 2, 2000)));
    const next = (await json(await config())).config.policy as DeviceConfigV3;
    expect(next.assignment_generation).toBe(3); expect(next.control.activation.boot_id).toBe(p.control.activation.boot_id);
    expect(next.control.capability_sha256).not.toBe(p.control.capability_sha256);
    await json(await device('/config/ack', await v3Ack(next, 2)));
    expect(JSON.parse(state.db.prepare('SELECT envelope_json FROM device_assignments_v3 WHERE generation=2').get()!.envelope_json as string).policy).toEqual(p);
  });
  it('refuses refreshed capabilities that cannot satisfy the approved template', async () => {
    await prepare(); await json(await grant(approval())); await reboot();
    caps = { ...caps, capability_id: 'missing-statistics', statistics: undefined };
    await json(await device('/capabilities', v3Registration(caps, 2, 2000)));
    await json(await config(), 422);
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_assignments_v3').get()?.n).toBe(1);
  });
  it('caps fresh activation at grant expiry and refuses expired approval or placement', async () => {
    await prepare(); const expiry = new Date(Date.now() + 300000).toISOString();
    await json(await grant({ ...approval(), grant_expires_at: expiry })); await reboot();
    const p = (await json(await config())).config.policy as DeviceConfigV3;
    expect(p.control.activation.expires_at).toBe(expiry);
    expect(Date.parse(p.custody.accept_until)).toBe(Date.parse(expiry) + 3600000);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expiry) + 1);
    expect(await json(await config())).toMatchObject({ config: null, reason: 'policy_expired' }); now.mockRestore();
    state.db.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES(?,?,?,?)')
      .run(state.config.placement_id, caps.node_id, Date.now() - 1, new Date().toISOString());
    expect(await json(await config())).toMatchObject({ config: null, reason: 'placement_inactive' });
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_assignments_v3').get()?.n).toBe(2);
  });
  it('preserves explicitly applied local TF capture and its budgets without enabling cloud raw', async () => {
    policy.local_raw = { mode: 'tf_cpraw', format: 'cpraw/1', max_segment_bytes: 1048576, max_total_bytes: 16777216,
      min_free_bytes: 1048576, sync_interval_ms: 1000, full_behavior: 'stop_recording' };
    await prepare(); await json(await grant(approval())); await reboot();
    const p = (await json(await config())).config.policy as DeviceConfigV3;
    expect(p.local_raw).toEqual(policy.local_raw); expect(p.uplink).toEqual(policy.uplink);
    expect(p.resources).toEqual(policy.resources); expect(p.custody.placement_id).toBe(policy.custody.placement_id);
  });
  it('revokes future ACK/renewal and terminates live spans while preserving receipts and acceptance deadlines', async () => {
    await prepare(); await json(await grant(approval())); await reboot();
    const p = (await json(await config())).config.policy as DeviceConfigV3, ack = await v3Ack(p);
    await json(await device('/config/ack', ack));
    const before = state.db.prepare('SELECT accept_until_ms FROM device_statistics_authorizations_v3 WHERE generation=2').get();
    await json(await grant({ expected_revision: 1, enabled: false }));
    expect(await json(await config())).toMatchObject({ config: null, reason: 'startup_grant_inactive' });
    await json(await device('/lease', { protocol: 'campuspulse/3', boot_id: p.control.activation.boot_id, policy_id: p.policy_id,
      policy_sha256: ack.policy_sha256, assignment_generation: 2, contact_seq: 1, uptime_ms: 2000 }), 409);
    expect(state.db.prepare('SELECT accept_until_ms FROM device_statistics_authorizations_v3 WHERE generation=2').get()).toEqual(before);
    expect(Number(state.db.prepare('SELECT lease_until_ms FROM device_statistics_authorizations_v3 WHERE generation=2').get()?.lease_until_ms)).toBeLessThanOrEqual(Date.now());
    expect((await json(await device('/config/ack', ack))).durability).toBe('committed');
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_startup_grants_v3').get()?.n).toBe(2);
  });
  it('feature removal also refuses generated authority and cannot silently keep enabling startup', async () => {
    await prepare(); await json(await grant(approval())); await reboot(); const p = (await json(await config())).config.policy;
    delete env.DEVICE_V3_STARTUP_ENABLED;
    expect(await json(await config())).toMatchObject({ config: null, reason: 'startup_grant_inactive' });
    await json(await device('/config/ack', await v3Ack(p)), 409);
  });
  it('manual assignment revokes startup so an unrelated desired policy is never overwritten', async () => {
    await prepare(); await json(await grant(approval()));
    const manual = { ...policy, policy_id: 'new-manual-approval', assignment_generation: 2 };
    const committed=await assign(manual);
    expect(committed.headers.get('X-CP-Startup-Revision-Before')).toBe('1');
    expect(committed.headers.get('X-CP-Startup-Revision-After')).toBe('2');
    expect(committed.headers.get('X-CP-Startup-Revoked')).toBe('1');
    const committedReceipt=await json(committed), replay=await assign(manual);
    expect(replay.headers.has('X-CP-Startup-Revision-Before')).toBe(false);
    expect(replay.headers.has('X-CP-Startup-Revision-After')).toBe(false);
    expect(await json(replay)).toEqual(committedReceipt);
    expect((await json(await grant())).startup_grant).toMatchObject({ enabled: 0, revision: 2 });
    await reboot(); expect(await json(await config())).toMatchObject({ config: null, reason: 'boot_changed' });
    expect(state.db.prepare('SELECT desired_generation FROM device_control_v3').get()?.desired_generation).toBe(2);
  });
  it('does not commit automatic setup assignment after an intervening grant revocation',async()=>{
    await prepare();await json(await grant(approval()));
    await json(await grant({expected_revision:1,enabled:false}));
    const next={...policy,policy_id:'synthetic-new-setup',assignment_generation:2};
    const response=await request('/api/v1/admin/device-v3/assignments',{
      policy:next,expected_generation:1,expected_startup_revision:1,
    },true);
    expect(await json(response,409)).toMatchObject({error:{code:'v3_startup_revision_conflict'}});
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_assignments_v3').get()?.n).toBe(1);
    expect((await json(await grant())).startup_grant).toMatchObject({enabled:0,revision:2});
  });
  it('rolls back setup assignment if revocation wins during its transaction',async()=>{
    await prepare();await json(await grant(approval()));
    const batch=env.DB.batch.bind(env.DB);let raced=false;
    vi.spyOn(env.DB,'batch').mockImplementation(async statements=>{
      if(!raced){raced=true;await json(await grant({expected_revision:1,enabled:false}));}
      return batch(statements);
    });
    const next={...policy,policy_id:'synthetic-racing-setup',assignment_generation:2};
    await json(await request('/api/v1/admin/device-v3/assignments',{
      policy:next,expected_generation:1,expected_startup_revision:1,
    },true),409);
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_assignments_v3').get()?.n).toBe(1);
    expect((await json(await grant())).startup_grant).toMatchObject({enabled:0,revision:2});
  });
  it('rolls back issuance if a concurrent revocation wins before its transaction', async () => {
    await prepare(); await json(await grant(approval())); await reboot();
    const batch = env.DB.batch.bind(env.DB); let fired = false;
    vi.spyOn(env.DB, 'batch').mockImplementation(async statements => {
      if (!fired) { fired = true; await json(await grant({ expected_revision: 1, enabled: false })); }
      return batch(statements);
    });
    await json(await config(), 409);
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_assignments_v3').get()?.n).toBe(1);
    expect(state.db.prepare('SELECT COUNT(*) n FROM device_startup_assignments_v3').get()?.n).toBe(0);
  });
});
