import { describe, it, expect } from 'vitest';
import { MQTT_BROKER_URI, mqttSettings, provisionAuthorization } from '../../src/admin/provisioning/mqtt.js';
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
