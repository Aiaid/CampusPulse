import { describe, it, expect } from 'vitest';
import { validateAnyCaptureConfig } from '../../worker/device-v2-validation.ts';
import { cloudProgress, provisionConfig, assignProvisionConfig } from '../../src/admin/provisioning/enrollment.js';
describe('enrollment state boundaries',()=>{
  it('publishes supported v2 defaults with explicit dataset',()=>{const c=provisionConfig('cp_001122aabbcc','p','c');expect(validateAnyCaptureConfig(c)).toEqual(c);expect(c.protocol).toBe('campuspulse/2');expect(c.dataset).toBe('controlled_test');expect(c.summary).toEqual({window_ms:30000,bin_ms:5000,max_addresses:64});expect(c.upload_policy.max_body_bytes).toBe(8192);});
  it('requires fresh contact and the same applied config, not registration alone',()=>{
    const d={device:{desired_config_id:'c',applied_config_id:'c',config_state:'applied',last_seen_at:'2026-10-24T00:00:00Z'}};
    expect(cloudProgress(d,'c',Date.parse('2026-10-24T01:00:00Z')).applied).toBe(false);
    d.device.latest_control={received_at:'2026-10-24T02:00:00Z'};expect(cloudProgress(d,'c',Date.parse('2026-10-24T01:00:00Z')).applied).toBe(true);
  });
  it('reconciles already-published assignment with no writes',async()=>{const calls=[];const id=await assignProvisionConfig(async(path,opts)=>{calls.push([path,opts]);return{device:{desired_config_id:'cp_001122aabbcc-c-1111111122224333'}}},'cp_001122aabbcc','11111111-2222-4333-8444-555555555555','p','field');expect(id).toBe('cp_001122aabbcc-c-1111111122224333');expect(calls).toHaveLength(1);expect(calls[0][1]).toBeUndefined();});
});
