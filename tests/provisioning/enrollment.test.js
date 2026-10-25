import { describe, it, expect } from 'vitest';
import { validateAnyCaptureConfig } from '../../worker/device-v2-validation.ts';
import { cloudProgress, provisionConfig, assignProvisionConfig } from '../../src/admin/provisioning/enrollment.js';
describe('enrollment state boundaries',()=>{
  it('publishes supported v2 defaults with explicit dataset',()=>{const c=provisionConfig('cp_001122aabbcc','p','c');expect(validateAnyCaptureConfig(c)).toEqual(c);expect(c.protocol).toBe('campuspulse/2');expect(c.dataset).toBe('controlled_test');expect(c.summary).toEqual({window_ms:30000,bin_ms:5000,max_addresses:64});expect(c.upload_policy.max_body_bytes).toBe(8192);});
  it('requires fresh contact and the same applied config, not registration alone',()=>{
    const d={device:{desired_config_id:'c',applied_config_id:'c',config_state:'applied',last_seen_at:'2026-10-24T00:00:00Z'}};
    expect(cloudProgress(d,'c',Date.parse('2026-10-24T01:00:00Z')).applied).toBe(false);
    d.device.latest_control={received_at:'2026-10-24T02:00:00Z'};d.activation={current:{state:'applied',capture_config_id:'c',received_at:'2026-10-24T02:00:00Z'}};expect(cloudProgress(d,'c',Date.parse('2026-10-24T01:00:00Z')).applied).toBe(true);
  });
  it('reconciles already-published assignment with no writes',async()=>{const calls=[];const id=await assignProvisionConfig(async(path,opts)=>{calls.push([path,opts]);return{device:{desired_config_id:'cp_001122aabbcc-c-1111111122224333'}}},'cp_001122aabbcc','11111111-2222-4333-8444-555555555555','p','field');expect(id).toBe('cp_001122aabbcc-c-1111111122224333');expect(calls).toHaveLength(1);expect(calls[0][1]).toBeUndefined();});
});

describe('reconfiguration keeps cloud identity and assignment', () => {
  it('recognizes existing nodes and only an explicit unknown-device response permits registration', async () => {
    const { inspectEnrollment } = await import('../../src/admin/provisioning/enrollment.js');
    const node = 'cp_001122aabbcc';
    expect((await inspectEnrollment(async () => ({ device: { id: node } }), node)).kind).toBe('existing');
    expect((await inspectEnrollment(async () => { throw Object.assign(new Error(), { status: 404, code: 'device_not_found' }); }, node)).kind).toBe('new');
    for (const error of [new Error('offline'), Object.assign(new Error(), { status: 401 }), Object.assign(new Error(), { status: 404, code: 'not_found' }), Object.assign(new Error(), { status: 500 })]) {
      await expect(inspectEnrollment(async () => { throw error; }, node)).rejects.toBe(error);
    }
    await expect(inspectEnrollment(async () => ({ device: { id: 'cp_ffffffffffff' } }), node)).rejects.toThrow('不同');
  });
  it('preserves only a current published v2 policy with an active placement', async () => {
    const { currentProvisionConfig } = await import('../../src/admin/provisioning/enrollment.js');
    const now = Date.now(), config = provisionConfig('cp_001122aabbcc', 'p', 'c', 'field', now);
    const detail = { device: { id: config.node_id, desired_config_id: 'c' }, configs: [{ id: 'c', config }], placements: [{ id: 'p', valid_from_ms: now - 1000, effective_valid_until_ms: null }] };
    expect(currentProvisionConfig(detail, now)?.id).toBe('c');
    expect(currentProvisionConfig({ ...detail, configs: [] }, now)).toBeNull();
    expect(currentProvisionConfig({ ...detail, placements: [{ ...detail.placements[0], effective_valid_until_ms: now - 1 }] }, now)).toBeNull();
    expect(currentProvisionConfig(detail, now + 8 * 86400000)).toBeNull();
  });
  it('never treats an old applied ACK plus a fresh heartbeat as a new Wi-Fi success', () => {
    const now = Date.now(), detail = { device: { desired_config_id: 'c', applied_config_id: 'c', config_state: 'applied', latest_control: { received_at: new Date(now + 100).toISOString(), boot_id: 'new' } }, activation: { current: { capture_config_id: 'c', state: 'applied', received_at: new Date(now - 1).toISOString(), boot_id: 'old' } } };
    expect(cloudProgress(detail, 'c', now)).toMatchObject({ contact: true, applied: false });
    detail.activation.current.received_at = new Date(now + 100).toISOString(); expect(cloudProgress(detail, 'c', now).applied).toBe(false);
    detail.activation.current.boot_id = 'new'; expect(cloudProgress(detail, 'c', now).applied).toBe(true);
  });
});
