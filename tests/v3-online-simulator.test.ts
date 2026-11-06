import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMqttV3DeviceClient, PRODUCTION_MQTT_URI } from '../scripts/lib/v3-mqtt-device-client.mjs';
import { validateOnlineSimulatorConfig, parseOnlineSimulatorArgs, runOnlineSimulator } from '../scripts/v3-online-simulator.mjs';
import { createSimulatedV3Device, createSimulationPolicy, SIMULATION_VEHICLE_RULESET } from '../scripts/lib/v3-simulated-device.mjs';
import { readPrivateJson } from '../scripts/v3-device-integration.mjs';
import { validateStatisticsV3Window, V3_VEHICLE_CANDIDATE_RULESET } from '../worker/device-v3-statistics-validation';

const boot = '11111111-1111-4111-8111-111111111111', nodeId = 'sim-live-unit-test';
const mqtt = { uri: PRODUCTION_MQTT_URI, username: 'sim_test', password: 'synthetic-only-secret', namespace: 'sim_test' };
const config = { origin: 'https://pulse.anend.net', operator_confirmed_production_simulation: true, nodeId,
  placementId: 'sim-unit-placement', deviceBearer: 'synthetic-device-token', adminCookie: 'synthetic-admin-cookie', mqtt };
const onlineConfiguration = { ...config, dataset: 'field', purpose: 'site_observation' };
const reply = (body: unknown, status = 200) => { const prefix = Buffer.alloc(2); prefix.writeUInt16BE(status); return Buffer.concat([prefix, Buffer.from(JSON.stringify(body))]); };

class FakeMqtt extends EventEmitter {
  connected = true;
  subscriptions: { topic: string; options: any }[] = [];
  publications: { topic: string; wire: Buffer; options: any }[] = [];
  ended = false;
  onPublish?: (topic: string, wire: Buffer) => void;
  subscribe(topic: string, options: any, callback: any) { this.subscriptions.push({ topic, options }); callback(null, [{ topic, qos: 0 }]); }
  publish(topic: string, wire: Buffer, options: any, callback: any) {
    this.publications.push({ topic, wire: Buffer.from(wire), options }); callback(null); this.onPublish?.(topic, wire);
  }
  end(force: boolean, options: any, callback: any) { this.ended = true; this.connected = false; this.emit('close'); callback(); }
}
async function fixture(timeoutMs = 1000) {
  const fake = new FakeMqtt(); let selectedUri: string, selectedOptions: any;
  const client = await createMqttV3DeviceClient({ mqtt, nodeId, bootId: boot, timeoutMs }, {
    connectFn: (uri: string, options: any) => { selectedUri = uri; selectedOptions = options; queueMicrotask(() => fake.emit('connect')); return fake; },
  });
  return { fake, client, uri: selectedUri!, options: selectedOptions };
}
const post = (body = ' {"synthetic":"测试"}\n') => ({ method: 'POST', body });

describe('production virtual CPV3 client', () => {
  it('pins verified native TLS, subscribes only its reply scope and preserves every JSON byte', async () => {
    const f = await fixture();
    expect(f.uri).toBe(PRODUCTION_MQTT_URI);
    expect(f.options).toMatchObject({ protocolVersion: 4, rejectUnauthorized: true, reconnectPeriod: 0, clean: true, resubscribe: false });
    expect(f.fake.subscriptions).toEqual([{ topic: `cp/v1/sim_test/${boot}/rep/ingest/+`, options: { qos: 0 } }]);
    const paths = ['/api/v3/device/capabilities', `/api/v3/device/config?boot_id=${boot}`, '/api/v3/device/config/ack',
      '/api/v3/device/lease', '/api/v3/statistics/ingest'];
    for (const [i, endpoint] of paths.entries()) {
      f.fake.onPublish = topic => f.fake.emit('message', topic.replace('/req/', '/rep/'), reply({ synthetic: i }), { retain: false });
      const response = await f.client.request(endpoint, i === 1 ? { method: 'GET' } : post());
      expect(await response.json()).toEqual({ synthetic: i });
      const pub = f.fake.publications[i];
      expect(pub.topic).toBe(`cp/v1/sim_test/${boot}/req/ingest/${i + 1}`);
      expect(pub.options).toEqual({ qos: 1, retain: false });
      expect(pub.wire.subarray(0, 8)).toEqual(Buffer.from([67, 80, 86, 51, 1, i + 1, 0, 0]));
      expect(pub.wire.subarray(8).toString()).toBe(i === 1 ? '' : post().body);
    }
    await f.client.close(); expect(f.fake.ended).toBe(true);
  });
  it('requires exact topic receipts, ignores late replies and never treats PUBACK as custody', async () => {
    const f = await fixture(20);
    const first = f.client.request('/api/v3/statistics/ingest', post());
    f.fake.emit('message', `cp/v1/other/${boot}/rep/ingest/1`, reply({ wrong: true }));
    await expect(first).rejects.toThrow('outcome remains unknown');
    f.fake.emit('message', f.fake.publications[0].topic.replace('/req/', '/rep/'), reply({ late: true }));
    const second = f.client.request('/api/v3/statistics/ingest', post());
    f.fake.emit('message', f.fake.publications[0].topic.replace('/req/', '/rep/'), reply({ late: true }));
    f.fake.emit('message', f.fake.publications[1].topic.replace('/req/', '/rep/'), reply({ accepted: true }));
    expect(await (await second).json()).toEqual({ accepted: true });
    expect(f.fake.publications[0].wire).toEqual(f.fake.publications[1].wire);
    expect(f.client.status()).toMatchObject({ requests: 2, replies: 1, timeouts: 1 });
    await f.client.close();
  });
  it('rejects retained/malformed/oversized replies and fails pending requests on shutdown', async () => {
    const f = await fixture();
    for (const [payload, packet] of [[reply({ wrong: true }), { retain: true }], [Buffer.from([0, 200, 123, 33]), {}],
      [reply({ padding: 'x'.repeat(2048) }), {}]] as const) {
      const promise = f.client.request('/api/v3/statistics/ingest', post());
      f.fake.emit('message', f.fake.publications.at(-1)!.topic.replace('/req/', '/rep/'), payload, packet);
      await expect(promise).rejects.toThrow('Invalid MQTT reply');
    }
    const pending = f.client.request('/api/v3/statistics/ingest', post());
    const assertion = expect(pending).rejects.toThrow('matching receipt');
    await f.client.close(); await assertion;
  });
  it('refuses alternate broker, transport overrides, wrong boot and unknown paths', async () => {
    await expect(createMqttV3DeviceClient({ mqtt: { ...mqtt, uri: 'wss://example.invalid' }, nodeId, bootId: boot })).rejects.toThrow('pinned MQTT');
    await expect(createMqttV3DeviceClient({ mqtt: { ...mqtt, rejectUnauthorized: false }, nodeId, bootId: boot })).rejects.toThrow('pinned MQTT');
    const f = await fixture();
    await expect(f.client.request('/api/v3/device/config?boot_id=other', { method: 'GET' })).rejects.toThrow('Unsupported');
    await expect(f.client.request('https://other.invalid/api/v3/statistics/ingest', post())).rejects.toThrow('Unsupported');
    await expect(f.client.request('/api/v1/ingest', post())).rejects.toThrow('Unsupported');
    await f.client.close();
  });
});

describe('explicit bounded production simulation', () => {
  it('requires an owned0600 private config and strict command/config scope', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cp-online-config-')), file = path.join(dir, 'private.json');
    try {
      await writeFile(file, JSON.stringify(config), { mode: 0o600 }); expect(await readPrivateJson(file)).toEqual(config);
      await chmod(file, 0o644); await expect(readPrivateJson(file)).rejects.toThrow('0600');
    } finally { await rm(dir, { recursive: true, force: true }); }
    expect(parseOnlineSimulatorArgs(['--config', '/private/config.json'])).toEqual({ configFile: '/private/config.json', phase: 'run' });
    expect(() => parseOnlineSimulatorArgs(['--config', '/private/config.json', '--origin', 'https://other.invalid'])).toThrow('Usage');
    expect(validateOnlineSimulatorConfig(config)).toMatchObject({ cadenceMs: 1000, durationMs: 1200000, scenario: 'busy' });
    for (const changed of [{ origin: 'https://other.invalid' }, { nodeId: 'physical-node' }, { operator_confirmed_production_simulation: false },
      { durationMs: 1800000 }, { dataset: 'controlled_test' }, { mqtt: { ...mqtt, uri: 'mqtt://public.invalid' } }])
      expect(() => validateOnlineSimulatorConfig({ ...config, ...changed })).toThrow();
  });
  it('keeps synthetic claims, pins field placement and never weakens existing default custody', async () => {
    const device = await createSimulatedV3Device({ nodeId, deviceBearer: config.deviceBearer, request: () => {}, transport: 'mqtt_tls', onlineConfiguration });
    expect(device.capabilities.producer_version).toBe('synthetic-statistics/1');
    expect(device.status()).toMatchObject({ dataset: 'field', queuePersistence: 'session-only', powerLossRecovery: false });
    const policy = await createSimulationPolicy(device.capabilities, { placementId: config.placementId, onlineConfiguration, transport: 'mqtt_tls' });
    expect(policy.custody).toMatchObject({ dataset: 'field', purpose: 'site_observation', placement_id: config.placementId });
    expect(policy.local_raw).toEqual({ mode: 'off' }); expect(policy.uplink.streams).toEqual(['window_statistics', 'node_status']);
    expect(policy.control.activation.expires_at <= device.capabilities.expires_at).toBe(true);
    await expect(createSimulationPolicy(device.capabilities, { placementId: 'different', onlineConfiguration, transport: 'mqtt_tls' })).rejects.toThrow('pinned placement');
    await expect(createSimulatedV3Device({ nodeId, deviceBearer: 'x', request: () => {}, onlineConfiguration })).rejects.toThrow('native MQTT');
    const controlled = await createSimulatedV3Device({ nodeId: 'control', deviceBearer: 'x', request: () => {} });
    expect(controlled.status().dataset).toBe('controlled_test');
  });
  it.each([1000, 30000, 60000])('validates distinct synthetic vehicle profiles at cadence %ims against the canonical backend', async cadenceMs => {
    expect(SIMULATION_VEHICLE_RULESET).toBe(V3_VEHICLE_CANDIDATE_RULESET);
    for (const [index, counts, identifiers] of [[1, { bikes: 3, cars: 2 }, 12], [2, { bikes: 6, cars: 3 }, 24]] as const) {
      let clock = Date.now();
      const node = `${nodeId}-${index}`, scoped = { ...onlineConfiguration, nodeId: node, placementId: `vehicle-place-${index}` };
      const device = await createSimulatedV3Device({ nodeId: node, deviceBearer: 'synthetic-token', request: () => {},
        transport: 'mqtt_tls', onlineConfiguration: scoped, vehicleData: true, vehicleCounts: counts, cadenceMs, scenario: 'busy', now: () => clock });
      expect(device.capabilities.statistics.ruleset_versions).toEqual([V3_VEHICLE_CANDIDATE_RULESET]);
      expect(device.capabilities.producer_version).toBe('synthetic-statistics/1');
      const policy = await createSimulationPolicy(device.capabilities, { placementId: scoped.placementId, onlineConfiguration: scoped,
        transport: 'mqtt_tls', vehicleData: true, vehicleCounts: counts, cadenceMs, now: clock });
      device.applied = await device.tools.freezeDeviceConfigV3(policy);
      device.nextStart = clock + 10; device.leaseUntil = clock + 120000; clock += cadenceMs + 10;
      device.collect();
      const window = JSON.parse(device.pending[0].body).x[0];
      const validated = validateStatisticsV3Window(window, { window_ms: cadenceMs, bin_ms: cadenceMs === 1000 ? 1000 : 5000,
        max_addresses: 512, max_bins: 12, extractor_version: 'cp-v3-stats/1', ruleset_version: V3_VEHICLE_CANDIDATE_RULESET,
        max_batch_items: 1, max_body_bytes: 2048, streams: ['window_statistics', 'node_status'], queue: policy.local_queue });
      expect(validated).toMatchObject({ visible_identifiers: identifiers, estimated_total: null, quality_mask: 0,
        categories: { phone_candidate: 0, e_bike_candidate: counts.bikes, car_candidate: counts.cars, other: 0,
          unknown: identifiers - counts.bikes - counts.cars, conflicting: 0 } });
      expect(validated.reports.worker).toBeGreaterThanOrEqual(identifiers);
      const wrongRuleset = structuredClone(policy); wrongRuleset.evidence.ruleset_version = 'unclassified-v1';
      const frozen = await device.tools.freezeDeviceConfigV3(wrongRuleset);
      // Exact configured version is enforced before ACK, even if counts could
      // otherwise fit the generic compact statistics envelope.
      device.pending.length = 0; device.pendingAck = null;
      device.request = async (endpoint: string, init: any) => {
        if (endpoint.includes('/config?')) return new Response(JSON.stringify({ protocol: 'campuspulse/3', requires_device_ack: true,
          server_time: new Date(clock).toISOString(), config: frozen }), { headers: { 'Cache-Control': 'no-store' } });
        expect(JSON.parse(init.body).state).toBe('failed');
        throw new Error('Retain rejected ACK for inspection');
      };
      await expect(device.configure()).rejects.toThrow();
      expect(JSON.parse(device.pendingAck!.body)).toMatchObject({ state: 'failed', error_code: 'unsupported_config' });
    }
  });
  it('guards vehicle options and keeps them opt-in', () => {
    expect(validateOnlineSimulatorConfig(config).vehicleData).toBe(false);
    expect(validateOnlineSimulatorConfig({ ...config, vehicleData: true, vehicleCounts: { bikes: 6, cars: 3 } })).toMatchObject({ vehicleData: true });
    for (const changed of [{ vehicleCounts: { bikes: 1, cars: 1 } }, { vehicleData: 'true' },
      { vehicleData: true, vehicleCounts: { bikes: -1, cars: 2 } }, { vehicleData: true, vehicleCounts: { bikes: 1.5, cars: 2 } },
      { vehicleData: true, vehicleCounts: { bikes: 512, cars: 1 } }, { vehicleData: true, vehicleCounts: { bikes: 1, cars: 1, phones: 1 } }])
      expect(() => validateOnlineSimulatorConfig({ ...config, ...changed })).toThrow();
  });
  it('waits for a current-boot policy without fabricating a failed ACK for an older online session', async () => {
    let delivered: any;
    const requests: string[] = [];
    const device = await createSimulatedV3Device({ nodeId, deviceBearer: config.deviceBearer, transport: 'mqtt_tls', onlineConfiguration,
      request: async (endpoint: string) => {
        requests.push(endpoint);
        return new Response(JSON.stringify(delivered), { headers: { 'Cache-Control': 'no-store' } });
      } });
    const policy = await createSimulationPolicy(device.capabilities, { placementId: config.placementId, onlineConfiguration, transport: 'mqtt_tls' });
    policy.control.activation.boot_id = boot;
    delivered = { protocol: 'campuspulse/3', requires_device_ack: true, server_time: new Date().toISOString(),
      config: await device.tools.freezeDeviceConfigV3(policy) };
    await device.configure();
    expect(device.status()).toMatchObject({ phase: 'unassigned', configReason: 'awaiting_current_boot_assignment', appliedGeneration: 0, pendingControlItems: 0 });
    expect(requests).toEqual([`/api/v3/device/config?boot_id=${device.capabilities.boot_id}`]);
  });
  it('registers over injected MQTT, revision checks assignment and preserves state on prepare shutdown', async () => {
    let caps: any, closed = false, preserved: any; const adminCalls: any[] = [];
    const result = await runOnlineSimulator(config, 'prepare', {
      createClient: async () => ({ close: async () => { closed = true; }, status: () => ({ requests: 2 }),
        request: async (endpoint: string, init: any) => {
          if (endpoint.endsWith('/capabilities')) {
            const body = JSON.parse(init.body); caps = body.capabilities;
            const tools = (await createSimulatedV3Device({ nodeId, deviceBearer: 'x', request: () => {} })).tools;
            return new Response(JSON.stringify({ protocol: 'campuspulse/3', node_id: nodeId, boot_id: caps.boot_id,
              registration_seq: 1, capability_sha256: await tools.capabilityDigestV3(caps), applied: false }), { headers: { 'Cache-Control': 'no-store' } });
          }
          return new Response(JSON.stringify({ protocol: 'campuspulse/3', requires_device_ack: true, server_time: new Date().toISOString(),
            config: null, reason: 'unassigned' }), { headers: { 'Cache-Control': 'no-store' } });
        } }),
      adminTransport: async (url: string, init: any) => {
        adminCalls.push({ url, init });
        if (init.method === 'GET') return new Response(JSON.stringify({ capabilities: caps, desired: null }), { headers: { 'Cache-Control': 'no-store' } });
        const body = JSON.parse(init.body), tools = (await createSimulatedV3Device({ nodeId, deviceBearer: 'x', request: () => {} })).tools;
        return new Response(JSON.stringify({ policy_sha256: (await tools.freezeDeviceConfigV3(body.policy)).policy_sha256,
          applied: false, requires_device_ack: true }), { headers: { 'Cache-Control': 'no-store' } });
      }, preserveState: async (state: any) => { preserved = state; },
    });
    expect(closed).toBe(true); expect(result).toMatchObject({ outcome: 'prepared_awaiting_synthetic_ack', pendingItems: 0, physicalValidation: false });
    expect(JSON.parse(adminCalls[1].init.body)).toMatchObject({ expected_generation: 0, policy: { node_id: nodeId } });
    expect(adminCalls[1].init.headers).toMatchObject({ Origin: config.origin, Cookie: config.adminCookie });
    expect(preserved).toMatchObject({ restartRecovery: false, pending: [], pendingAck: null, pendingLease: null });
    expect(JSON.stringify(preserved)).not.toContain(config.deviceBearer); expect(JSON.stringify(preserved)).not.toContain(config.adminCookie);
  });
  it('waits for UI assignment without administrator cookies or administrator requests', async () => {
    const { adminCookie: _, ...withoutCookie } = config;
    let caps: any, clock = Date.now(), preserved: any; const updates: any[] = [];
    const tools = (await createSimulatedV3Device({ nodeId, deviceBearer: 'x', request: () => {} })).tools;
    const result = await runOnlineSimulator({ ...withoutCookie, durationMs: 1000 }, 'run', {
      now: () => clock, sleep: async (ms: number) => { clock += ms; },
      adminTransport: () => { throw new Error('Administrator request must not be made'); },
      createClient: async () => ({ close: async () => {}, status: () => ({ requests: 2 }),
        request: async (endpoint: string, init: any) => {
          let response;
          if (endpoint.endsWith('/capabilities')) {
            caps = JSON.parse(init.body).capabilities;
            response = { protocol: 'campuspulse/3', node_id: nodeId, boot_id: caps.boot_id, registration_seq: 1,
              capability_sha256: await tools.capabilityDigestV3(caps), applied: false };
          } else response = { protocol: 'campuspulse/3', requires_device_ack: true, server_time: new Date(clock).toISOString(), config: null, reason: 'unassigned' };
          return new Response(JSON.stringify(response), { headers: { 'Cache-Control': 'no-store' } });
        } }),
      onProgress: (report: any) => updates.push(report), preserveState: (state: any) => { preserved = state; },
    });
    expect(updates[0]).toMatchObject({ outcome: 'waiting_for_assignment', appliedGeneration: 0 });
    expect(result).toMatchObject({ outcome: 'bounded_run_complete', accepted: { window_statistics: 0, node_status: 0 } });
    expect(preserved.capabilities.boot_id).toBe(caps.boot_id);
    await expect(runOnlineSimulator(withoutCookie, 'prepare')).rejects.toThrow('Prepare requires');
  });
});
