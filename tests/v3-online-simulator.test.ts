import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
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

/** Exact receipts, canonical frozen policy negotiation and a host-owned clock;
 * no broker, private files or production requests are used by this harness. */
async function continuousHarness({ policyLifetimeMs, cadenceMs = 60000 }: { policyLifetimeMs?: number; cadenceMs?: number } = {}) {
  let clock = Date.now(), policy: any, caps: any, generation = 0;
  let assignAfter = 0, failRegistration = false, failStatistics = false, stalePolicy = false;
  const tools = (await createSimulatedV3Device({ nodeId, deviceBearer: 'fixture', request: () => {} })).tools;
  const calls: { endpoint: string; body: string }[] = [];
  const digest = (s: string) => createHash('sha256').update(s).digest('hex');
  const respond = async (endpoint: string, init: any) => {
    calls.push({ endpoint, body: init.body ?? '' });
    const body = init.body ? JSON.parse(init.body) : null;
    let value: any;
    if (endpoint.endsWith('/capabilities')) {
      const changed = caps?.capability_id !== body.capabilities.capability_id;
      caps = body.capabilities;
      if (changed && !stalePolicy) {
        const next = await createSimulationPolicy(caps, { placementId: config.placementId,
          onlineConfiguration, transport: 'mqtt_tls', cadenceMs, generation: ++generation, now: clock });
        if (policyLifetimeMs !== undefined) next.control.activation.expires_at = new Date(clock + policyLifetimeMs).toISOString();
        policy = await tools.freezeDeviceConfigV3(next);
      }
      if (failRegistration) { failRegistration = false; throw new Error('Lost committed registration response'); }
      value = { protocol: 'campuspulse/3', node_id: nodeId, boot_id: caps.boot_id, registration_seq: body.registration_seq,
        capability_sha256: await tools.capabilityDigestV3(caps), applied: false };
    } else if (endpoint.includes('/config?')) {
      value = { protocol: 'campuspulse/3', requires_device_ack: true, server_time: new Date(clock).toISOString(),
        config: clock >= assignAfter ? policy : null, reason: clock >= assignAfter ? null : 'unassigned' };
    } else if (endpoint.endsWith('/config/ack')) {
      value = { ...body, node_id: nodeId, body_sha256: digest(init.body), durability: 'committed', evidence: 'device_ack',
        server_time: new Date(clock).toISOString(), lease_until_ms: clock + 120000 };
    } else if (endpoint.endsWith('/lease')) {
      value = { ...body, schema: 'device-lease/3', node_id: nodeId, body_sha256: digest(init.body), durability: 'committed',
        server_time: new Date(clock).toISOString(), lease_until_ms: clock + 120000, span_seq: 1, contiguous: true };
    } else {
      if (failStatistics) throw new Error('Disconnected');
      value = { protocol: 'campuspulse/3', schema: 'device-statistics-receipt/3', node_id: body.n, boot_id: body.o,
        stream: body.k, batch_id: body.b, body_sha256: digest(init.body), policy_id: body.c, policy_sha256: body.h,
        assignment_generation: body.g, seq_first: body.x[0].q, seq_last: body.x.at(-1).q, accepted_count: body.x.length,
        durability: 'committed', custody: 'small_statistics', receipt_id: randomUUID(), received_at: new Date(clock).toISOString(),
        expires_at: new Date(clock + 3600000).toISOString(), retain_until: new Date(clock + 7200000).toISOString() };
    }
    return new Response(JSON.stringify(value), { headers: { 'Cache-Control': 'no-store' } });
  };
  return { respond, calls, now: () => clock, advance: (ms: number) => { clock += ms; }, get policy() { return policy; },
    set assignAfter(n: number) { assignAfter = n; }, set failRegistration(v: boolean) { failRegistration = v; },
    set failStatistics(v: boolean) { failStatistics = v; }, set stalePolicy(v: boolean) { stalePolicy = v; } };
}

describe('continuous online lifecycle with an injected clock', () => {
  it('renews a short applied policy before expiry while capabilities remain valid, without an immediate renewal loop', async () => {
    const h = await continuousHarness({ policyLifetimeMs: 12000, cadenceMs: 1000 }), start = h.now();
    const device = await createSimulatedV3Device({ nodeId, deviceBearer: config.deviceBearer, transport: 'mqtt_tls',
      onlineConfiguration, continuous: true, cadenceMs: 1000, now: h.now, request: h.respond });
    await device.start(); const first = device.capabilities;
    expect(device.status()).toMatchObject({ appliedGeneration: 1, policyRenewAtMs: start + 9000 });
    await device.tick(); h.advance(8000); await device.tick();
    expect(device.status()).toMatchObject({ registrationSeq: 1, appliedGeneration: 1 });
    h.advance(1000); await device.tick();
    expect(device.status()).toMatchObject({ registrationSeq: 2, appliedGeneration: 2, pendingItems: 0, lastError: null });
    expect(h.now()).toBeLessThan(start + 12000);
    expect(Date.parse(first.expires_at) - h.now()).toBeGreaterThan(120000);
    expect(device.capabilities.boot_id).toBe(first.boot_id);
    expect(device.status().sequences).toEqual({ window_statistics: 2, node_status: 2 });
    await device.tick();
    expect(device.status()).toMatchObject({ registrationSeq: 2, appliedGeneration: 2, policyRenewAtMs: start + 18000 });
    expect(h.calls.filter(x => x.endpoint.endsWith('/config/ack')).map(x => JSON.parse(x.body).apply_seq)).toEqual([1, 2]);
    device.stop();
  });
  it('runs beyond twenty minutes, rotates at a drained boundary and preserves boot-global sequences', async () => {
    const h = await continuousHarness(), controller = new AbortController(), start = h.now();
    const { adminCookie: _, ...privateConfig } = config;
    let preserved: any;
    const result = await runOnlineSimulator({ ...privateConfig, continuous: true, cadenceMs: 60000 }, 'run', {
      now: h.now, signal: controller.signal, sleep: async (ms: number) => { h.advance(ms); if (h.now() - start >= 1900000) controller.abort(); },
      createClient: async () => ({ request: h.respond, status: () => ({ connected: true }), close: async () => {} }),
      preserveState: (state: any) => { preserved = structuredClone(state); },
    });
    expect(result).toMatchObject({ outcome: 'stopped', continuous: true, runPhase: 'stopped', runDeadlineMs: null,
      registrationSeq: 2, appliedGeneration: 2, pendingItems: 0, deviceError: false });
    expect(result.accepted.window_statistics).toBeGreaterThan(20);
    const registrations = h.calls.filter(x => x.endpoint.endsWith('/capabilities')).map(x => JSON.parse(x.body));
    expect(new Set(registrations.map(x => x.capabilities.boot_id)).size).toBe(1);
    expect(registrations.map(x => x.registration_seq)).toEqual([1, 2]);
    expect(registrations[0].capabilities.capability_id).not.toBe(registrations[1].capabilities.capability_id);
    const windows = h.calls.filter(x => x.endpoint.endsWith('/ingest')).map(x => JSON.parse(x.body)).filter(x => x.k === 'window_statistics');
    expect(windows.map(x => x.x[0].w)).toEqual(windows.map((_, i) => i + 1));
    expect(windows.map(x => x.x[0].q)).toEqual(windows.map((_, i) => i + 1));
    expect(h.calls.filter(x => x.endpoint.endsWith('/config/ack')).map(x => JSON.parse(x.body).apply_seq)).toEqual([1, 2]);
    expect(preserved.status).toMatchObject({ running: false, phase: 'stopped', registrationSeq: 2 });
    expect(JSON.stringify(preserved)).not.toContain(config.deviceBearer);
  });
  it('starts the bounded duration only after the first applied assignment', async () => {
    const h = await continuousHarness(), start = h.now(); h.assignAfter = start + 3000;
    const { adminCookie: _, ...privateConfig } = config;
    const result = await runOnlineSimulator({ ...privateConfig, durationMs: 2000, assignmentWaitMs: 10000 }, 'run', {
      now: h.now, sleep: async (ms: number) => h.advance(ms),
      createClient: async () => ({ request: h.respond, status: () => ({ connected: true }), close: async () => {} }),
    });
    expect(h.now() - start).toBe(5000);
    expect(result).toMatchObject({ outcome: 'bounded_run_complete', runStartedAtMs: start + 3000, runDeadlineMs: start + 5000 });
  });
  it('retains pending bytes, retries a frozen registration and waits for the new capability assignment', async () => {
    const h = await continuousHarness();
    const device = await createSimulatedV3Device({ nodeId, deviceBearer: config.deviceBearer, transport: 'mqtt_tls',
      onlineConfiguration, continuous: true, cadenceMs: 60000, now: h.now, request: h.respond });
    await device.start(); h.advance(60010); h.failStatistics = true; await device.tick();
    const pending = device.pending.map((x: any) => x.body), before = device.capabilities;
    device.requestCapabilityRenewal(); await device.tick();
    expect(device.capabilities).toEqual(before); expect(device.pending.map((x: any) => x.body)).toEqual(pending);
    h.failStatistics = false; h.failRegistration = true; h.stalePolicy = true; h.advance(1000); await device.tick();
    expect(device.status()).toMatchObject({ registrationSeq: 2, registered: false, awaitingCapabilityAssignment: true, pendingItems: 0 });
    const frozen = device.registrationBody; h.advance(1000); await device.tick();
    expect(device.registrationBody).toBe(frozen);
    expect(device.status()).toMatchObject({ phase: 'unassigned', configReason: 'awaiting_current_capability_assignment', appliedGeneration: 1 });
    const retries = h.calls.filter(x => x.endpoint.endsWith('/capabilities') && JSON.parse(x.body).registration_seq === 2);
    expect(retries).toHaveLength(2); expect(retries[0].body).toBe(retries[1].body);
    expect(h.calls.filter(x => x.endpoint.endsWith('/config/ack'))).toHaveLength(1);
    const retained = device.registrationBody; device.stop(); await device.tick(); expect(device.registrationBody).toBe(retained);
  });
  it('requests an approved new generation when a policy expires before valid capabilities', async () => {
    const h = await continuousHarness(); let expired = false;
    const device = await createSimulatedV3Device({ nodeId, deviceBearer: config.deviceBearer, transport: 'mqtt_tls',
      onlineConfiguration, continuous: true, cadenceMs: 60000, now: h.now,
      request: (endpoint: string, init: any) => {
        if (expired && endpoint.includes('/config?')) {
          expired = false;
          return new Response(JSON.stringify({ protocol: 'campuspulse/3', requires_device_ack: true,
            server_time: new Date(h.now()).toISOString(), config: null, reason: 'policy_expired' }), { headers: { 'Cache-Control': 'no-store' } });
        }
        return h.respond(endpoint, init);
      } });
    await device.start(); const first = device.capabilities;
    expired = true; await device.tick();
    expect(device.status()).toMatchObject({ renewalReason: 'policy_expired', phase: 'unavailable' });
    expect(Date.parse(first.expires_at) - h.now()).toBeGreaterThan(120000);
    await device.tick();
    expect(device.status()).toMatchObject({ registrationSeq: 2, appliedGeneration: 2, lastError: null });
    expect(device.capabilities.boot_id).toBe(first.boot_id);
    expect(h.calls.filter(x => x.endpoint.endsWith('/config/ack')).every(x => JSON.parse(x.body).state === 'applied')).toBe(true);
  });
  it('carries the MQTT RPC high-water mark across native clients', async () => {
    const f = await fixture();
    f.fake.onPublish = topic => f.fake.emit('message', topic.replace('/req/', '/rep/'), reply({ ok: true }));
    await f.client.request('/api/v3/statistics/ingest', post()); const highwater = f.client.status().lastRpc;
    await f.client.close();
    const next = new FakeMqtt();
    const client = await createMqttV3DeviceClient({ mqtt, nodeId, bootId: boot, initialRpc: highwater }, {
      connectFn: () => { queueMicrotask(() => next.emit('connect')); return next; },
    });
    next.onPublish = topic => next.emit('message', topic.replace('/req/', '/rep/'), reply({ ok: true }));
    await client.request('/api/v3/statistics/ingest', post());
    expect(next.publications[0].topic).toBe(`cp/v1/sim_test/${boot}/req/ingest/2`); await client.close();
  });
  it('reconnects with bounded backoff and the same boot/RPC high-water mark', async () => {
    const h = await continuousHarness(), controller = new AbortController(), start = h.now();
    const { adminCookie: _, ...privateConfig } = config;
    const connections: any[] = []; let connected = true, rpc = 0;
    const result = await runOnlineSimulator({ ...privateConfig, continuous: true, cadenceMs: 60000 }, 'run', {
      now: h.now, signal: controller.signal, sleep: async (ms: number) => {
        h.advance(ms); if (h.now() - start === 1000) connected = false;
        if (h.now() - start >= 5000) controller.abort();
      },
      createClient: async (options: any) => {
        connections.push({ ...options, at: h.now() });
        if (connections.length === 2) throw new Error('Temporary unavailable transport');
        connected = true; rpc = options.initialRpc;
        return { request: async (...args: any[]) => { rpc++; return h.respond(args[0], args[1]); },
          status: () => ({ connected, lastRpc: rpc }), close: async () => { connected = false; } };
      },
    });
    expect(connections).toHaveLength(3);
    expect(new Set(connections.map(x => x.bootId)).size).toBe(1);
    expect(connections[1].initialRpc).toBe(3); expect(connections[2].initialRpc).toBe(3);
    expect(connections[2].at - connections[1].at).toBe(1000);
    expect(result).toMatchObject({ outcome: 'stopped', appliedGeneration: 1, transportCounts: { reconnects: 1 } });
  });
  it('uses a host renewal signal and preserves exact pending bytes when manually stopped', async () => {
    const h = await continuousHarness(), controller = new AbortController(), renewSignal = new EventTarget(), start = h.now();
    const { adminCookie: _, ...privateConfig } = config;
    let preserved: any;
    const result = await runOnlineSimulator({ ...privateConfig, continuous: true, cadenceMs: 60000 }, 'run', {
      now: h.now, signal: controller.signal, renewSignal, sleep: async (ms: number) => {
        h.advance(ms);
        if (h.now() - start === 1000) renewSignal.dispatchEvent(new Event('renew'));
        if (h.now() - start >= 122000) h.failStatistics = true;
        if (h.now() - start >= 124000) controller.abort();
      },
      createClient: async () => ({ request: h.respond, status: () => ({ connected: true }), close: async () => {} }),
      preserveState: (state: any) => { preserved = structuredClone(state); },
    });
    expect(result).toMatchObject({ outcome: 'stopped', registrationSeq: 2, appliedGeneration: 2, pendingItems: 2 });
    expect(preserved.status).toMatchObject({ running: false, phase: 'stopped', pendingItems: 2 });
    const attempts = h.calls.filter(x => x.endpoint.endsWith('/ingest') && x.body === preserved.pending[0].body);
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect(preserved.pending[0].body).toBe(attempts[0].body);
    expect(preserved.capabilities.boot_id).toBe(JSON.parse(preserved.pending[0].body).o);
  });
});

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
    expect(result).toMatchObject({ outcome: 'initial_assignment_timeout', accepted: { window_statistics: 0, node_status: 0 } });
    expect(preserved.capabilities.boot_id).toBe(caps.boot_id);
    await expect(runOnlineSimulator(withoutCookie, 'prepare')).rejects.toThrow('Prepare requires');
  });
});
