import { describe, it, expect } from 'vitest';
import { safeDiagnostic, diagnosticView, previousDiagnostic, bootEvidence } from '../../src/admin/provisioning/diagnostics.js';
describe('safe local diagnostics', () => {
  it('retains explicit device stages and safe numeric error values only', () => {
    const safe = safeDiagnostic({ diagnostic: { stage: 'clock', code: 'clock_timeout', elapsed_ms: 45000, retryable: true, esp_err: 263, http_status: 0, wifi_reason: 0, ssid: 'private', password: 'private', device_token: 'private', nonce: 'private', node_id: 'private' } });
    expect(safe).toEqual({ stage: 'clock', code: 'clock_timeout', elapsed_ms: 45000, retryable: true, esp_err: 263, http_status: 0, wifi_reason: 0 });
    expect(JSON.stringify(safe)).not.toContain('private');
  });
  it('does not surface arbitrary strings, oversized numbers or infer stages from disconnects', () => {
    expect(safeDiagnostic({ diagnostic: { stage: 'private', code: 'private', http_status: 999, wifi_reason: -1, elapsed_ms: Infinity, retryable: 'yes' } })).toBeNull();
    expect(diagnosticView(null)).toMatchObject({ failed: false, stage: null });
    expect(diagnosticView({ state: 'waiting' })).toMatchObject({ failed: false, problem: null });
    expect(diagnosticView({ state: 'failed', diagnostic: { stage: 'clock', code: 'clock_timeout' } })).toMatchObject({ failed: true, stage: '同步设备时间', problem: '设备时间同步超时' });
  });
});

describe('boot and persisted diagnostics remain distinct from this attempt', () => {
  it('keeps only safe historical state and diagnostics, never credential or node fields', () => {
    const prior = previousDiagnostic({ previous_attempt: { state: 'interrupted', node_id: 'private', device_token: 'private', diagnostic: { stage: 'tls', code: 'validation_interrupted', tls_code: -29824, tls_flags: 4, ssid: 'private' } } });
    expect(prior).toEqual({ state: 'interrupted', diagnostic: { stage: 'tls', code: 'validation_interrupted', tls_code: -29824, tls_flags: 4 } });
    expect(previousDiagnostic({ previous_attempt: { state: 'testing', diagnostic: { stage: 'tls' } } })).toBeNull();
  });
  it('requires a valid random boot ID and bounded numeric evidence', () => {
    expect(bootEvidence({ boot_id: 'private-device-name' })).toBeNull();
    const boot_id = '11111111-2222-4333-8444-555555555555';
    expect(bootEvidence({ boot_id, uptime_ms: 1234, reset_reason: 21, password: 'private' })).toEqual({ boot_id, uptime_ms: 1234, reset_reason: 21 });
    expect(bootEvidence({ boot_id, uptime_ms: -1, reset_reason: 'private' })).toEqual({ boot_id });
  });
});
