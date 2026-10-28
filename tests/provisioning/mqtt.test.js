import { describe, it, expect } from 'vitest';
import { MQTT_BROKER_URI, mqttSettings, provisionAuthorization } from '../../src/admin/provisioning/mqtt.js';
import { bleRequestFrames } from '../../src/admin/provisioning/bluetooth.js';
import { safeDiagnostic, previousDiagnostic } from '../../src/admin/provisioning/diagnostics.js';

const mqtt = { uri: MQTT_BROKER_URI, username: 'synthetic-user', password: 'synthetic-private-password', namespace: 'pool_a' };
describe('MQTT provisioning authorization', () => {
  it('keeps the allocated namespace independent of factory node and preserves authorization on retries', () => {
    const first = provisionAuthorization('provided', 'synthetic-token', mqtt);
    expect(first.mqtt.namespace).toBe('pool_a');
    expect(provisionAuthorization('provided', 'synthetic-token', structuredClone(mqtt))).toEqual(first);
    expect(provisionAuthorization('saved', '', null)).toEqual({ reuse_saved_credential: true });
    expect(provisionAuthorization('saved', '', mqtt)).toEqual({ reuse_saved_credential: true, mqtt });
  });
  it('rejects nonproduction brokers, partial secrets and values the firmware cannot store', () => {
    for (const bad of [{ uri: 'mqtt://other:1883' }, { password: '' }, { password: 'p'.repeat(97) }, { username: 'u'.repeat(65) }, { username: 'line\nbreak' }, { namespace: 'cp_001122aabbcc-extra' }, { namespace: '../topic' }]) {
      expect(() => mqttSettings({ ...mqtt, ...bad })).toThrow('MQTT');
    }
    expect(mqttSettings({ ...mqtt, extra: 'not-forwarded' })).toEqual(mqtt);
  });
  it('never copies nested MQTT authorization into current or historical diagnostics', () => {
    const diagnostic = { stage: 'tls', code: 'tls_failed', mqtt, mqtt_password: mqtt.password, username: mqtt.username };
    expect(JSON.stringify(safeDiagnostic({ diagnostic }))).not.toContain('synthetic');
    expect(JSON.stringify(previousDiagnostic({ previous_attempt: { state: 'failed', diagnostic, mqtt } }))).not.toContain('synthetic');
  });
});

describe('authenticated BLE MQTT chunking', () => {
  it('retains the small legacy configure packet and rejects oversized nonconfigure requests', () => {
    expect(bleRequestFrames({ op: 'info' })).toEqual([{ v: 1, op: 'info' }]);
    expect(() => bleRequestFrames({ op: 'info', text: 'x'.repeat(500) })).toThrow();
  });
  it('bounds every encrypted plaintext wrapper after escaping and reconstructs Unicode exactly', () => {
    const body = { op: 'configure', node_id: 'cp_001122aabbcc', attempt_id: '11111111-2222-4333-8444-555555555555', ssid: '汉字😀'.repeat(25), password: '\\"'.repeat(40), mqtt };
    const frames = bleRequestFrames(body), chunks = frames.slice(0, -1);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].reset).toBe(true); expect(chunks.slice(1).every(chunk => chunk.reset === undefined)).toBe(true);
    for (const frame of frames) expect(new TextEncoder().encode(JSON.stringify(frame)).length).toBeLessThanOrEqual(496);
    expect(JSON.parse(chunks.map(chunk => chunk.data).join(''))).toEqual({ v: 1, ...body });
    expect(frames.at(-1)).toEqual({ v: 1, op: 'configure_commit' });
    expect(() => bleRequestFrames({ op: 'configure', text: '汉'.repeat(600) })).toThrow();
  });
});
