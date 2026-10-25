import { describe, it, expect } from 'vitest';
import { safeDiagnostic, diagnosticView, previousDiagnostic, bootEvidence, networkSettingsSaved } from '../../src/admin/provisioning/diagnostics.js';
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
  it('reports allocation failure explicitly instead of a TLS timeout', () => {
    expect(diagnosticView({ state: 'failed', diagnostic: { stage: 'cloud_auth', code: 'resource_exhausted', esp_err: 257 } }))
      .toMatchObject({ failed: true, problem: '设备内存不足', diagnostic: { code: 'resource_exhausted', esp_err: 257 } });
  });
});

describe('boot and persisted diagnostics remain distinct from this attempt', () => {
  const attemptId = '11111111-2222-4333-8444-555555555555';
  const savedAttempt = { state: 'saved', attempt_id: attemptId, diagnostic: { stage: 'saved', code: 'saved' } };
  it('recognizes the exact saved attempt before and after reboot without a capture ACK', () => {
    expect(networkSettingsSaved({ ...savedAttempt, has_saved_credential: true }, attemptId)).toBe(true);
    const status = { state: 'idle', active: false, has_saved_credential: true, previous_attempt: savedAttempt };
    expect(networkSettingsSaved(status, attemptId)).toBe(true);
    expect(diagnosticView(status).state).toBe('设备已退出配网，已有保存设置');
    expect(diagnosticView({ state: 'idle' }).state).toBe('设备已退出配网');
  });
  it('never confirms a candidate from unrelated history or incomplete save evidence', () => {
    const status = { state: 'idle', has_saved_credential: true, previous_attempt: savedAttempt };
    expect(networkSettingsSaved(status, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBe(false);
    for (const attempt of ['', undefined, 'not-a-uuid', '11111111-2222-3333-8444-555555555555']) expect(networkSettingsSaved(status, attempt)).toBe(false);
    for (const has_saved_credential of [false, undefined, 'true']) expect(networkSettingsSaved({ ...status, has_saved_credential }, attemptId)).toBe(false);
    for (const changed of [{ state: 'testing' }, { diagnostic: { code: 'saving' } }, { attempt_id: undefined }]) {
      expect(networkSettingsSaved({ ...savedAttempt, ...changed, has_saved_credential: true }, attemptId)).toBe(false);
      expect(networkSettingsSaved({ ...status, previous_attempt: { ...savedAttempt, ...changed } }, attemptId)).toBe(false);
    }
  });
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
