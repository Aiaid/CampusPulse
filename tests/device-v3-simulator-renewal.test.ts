import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { capabilityDigestV3, freezeDeviceConfigV3, type DeviceConfigV3 } from '../worker/device-v3-config';
import { continuousSimulatorNodes, type SimulatorRenewalEnv } from '../worker/device-v3-simulator-renewal';
import { sha256 } from '../worker/http';
import { seedIngestV3 } from './helpers/v3-ingest-fixtures';
import { statisticsBatch, statisticsFixture } from './helpers/v3-statistics-fixtures';
import { v3Ack, v3Registration } from './helpers/device-v3-fixtures';

let mf: Miniflare, db: Awaited<ReturnType<Miniflare['getD1Database']>>;
const labels = ['same', 'boot', 'race', 'pending', 'initial', 'closed', 'producer', 'unsupported', 'expired', 'revoked', 'corrupt', 'bounded'];
const nodes = labels.map(label => 'sim-live-renew-' + label);
const bindings = { DEVICE_V3_CONTROL_ENABLED: 'true', DEVICE_V3_STATISTICS_ENABLED: 'true', DEVICE_V3_INGEST_ENABLED: 'false',
  CPRAW_ARCHIVE_ENABLED: '0', DEVICE_V3_PRODUCER_VERSIONS: '["cp-v3-small/1"]',
  DEVICE_V3_SIMULATOR_NODE_IDS: JSON.stringify([...nodes, 'sim-live-renew-ungranted']),
  DEVICE_V3_SIMULATOR_CONTINUOUS_NODE_IDS: JSON.stringify(nodes) };
const bytes = (value: unknown) => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
async function fixture(label: string, applied = true, now = Date.now()) {
  const f = await statisticsFixture('sim-live-renew-' + label, 'sim-renew-place-' + label, now);
  f.caps.producer_version = 'synthetic-statistics/1'; f.caps.uplink!.transports = ['mqtt_tls'];
  if (f.policy.uplink.enabled) f.policy.uplink.transport = 'mqtt_tls';
  f.policy.custody.dataset = 'field'; f.policy.custody.purpose = 'site_observation';
  f.policy.control.activation.after_window_seq = 0; f.policy.control.activation.after_segment_seq = 0;
  f.policy.control.capability_sha256 = await capabilityDigestV3(f.caps);
  const node = f.policy.node_id, identity = { username: 'r-' + label, namespace: 'r-' + label };
  await db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').bind(node, await sha256(bytes('synthetic-token-' + label))).run();
  await db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,NULL,0)').bind(f.policy.custody.placement_id, node).run();
  await db.prepare("INSERT INTO mqtt_credentials(id,username,namespace,password_ciphertext,state,node_id,created_at,verified_at) VALUES(?,?,?,'synthetic-encrypted','assigned',?,?,?)")
    .bind('renew-map-' + label, identity.username, identity.namespace, node, new Date().toISOString(), new Date().toISOString()).run();
  let rpc = 0;
  async function send(subop: number, value: unknown = '', boot = f.caps.boot_id) {
    const response = await mf.dispatchFetch('https://test.invalid/', { method: 'POST', body: JSON.stringify({ ...identity,
      boot, op: 'ingest', rpc: ++rpc, body: [...bytes(value)], v3: { subop, receiptOnly: false } }) });
    return await response.json() as { status: number; body: Record<string, any> };
  }
  if (label !== 'initial') {
    const frozen = await seedIngestV3(db as unknown as D1Database, f, applied, 0, 0);
    if (applied) await db.batch([
      db.prepare(`INSERT INTO device_statistics_authorizations_v3(node_id,generation,boot_id,policy_sha256,accept_until_ms,lease_until_ms,uptime_ms,span_count)
        VALUES(?,1,?,?,?,?,0,1)`).bind(node, f.caps.boot_id, frozen.policy_sha256, Date.parse(f.policy.custody.accept_until), f.appliedAt + f.policy.control.lease.duration_ms),
      db.prepare('INSERT INTO device_statistics_lease_spans_v3(node_id,generation,span_seq,start_ms,end_ms,accept_until_ms) VALUES(?,1,1,?,?,?)')
        .bind(node, f.appliedAt, f.appliedAt + f.policy.control.lease.duration_ms, Date.parse(f.policy.custody.accept_until)),
    ]);
  }
  const refresh = (seq = 2, boot = f.caps.boot_id) => v3Registration({ ...f.caps, boot_id: boot, capability_id: `renewed-${label}-${seq}`,
    issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 1800000).toISOString() }, seq, 20000 + seq);
  const count = async (table: string) => (await db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE node_id=?`).bind(node).first<{ n: number }>())!.n;
  return { f, node, send, refresh, count };
}
beforeAll(async () => {
  const api = await build({ entryPoints: ['tests/helpers/mqtt-v3-api.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral',
    external: ['cloudflare:workers', 'node:*'], target: 'es2022' });
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'sim-renew-bridge', modules: true, compatibilityDate: '2026-10-23',
    script: `export default { async fetch(request,env) { const input=await request.json(); input.body=Uint8Array.from(input.body);
      const result=await env.API.dispatch(input); return Response.json({status:result.status,body:JSON.parse(new TextDecoder().decode(result.body))}); } };`,
    serviceBindings: { API: { name: 'sim-renew-api', entrypoint: 'MqttDeviceApi' } } },
  { name: 'sim-renew-api', modules: true, script: api.outputFiles[0].text, compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], bindings }], log: new Log(LogLevel.ERROR) }));
  db = await mf.getD1Database('DB', 'sim-renew-api');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(n => /^\d+.*\.sql$/.test(n)).sort())
    await db.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8').replace(/^--.*$/gm, '').replace(/\n/g, ' '));
}, 30000);
afterAll(async () => { await mf?.dispose(); });

describe.sequential('explicit same-scope simulator renewal through native MQTT and real D1', () => {
  it('renews on the same boot with the committed window cutoff, preserves scope, and still requires a real ACK', async () => {
    const { f, node, send, refresh, count } = await fixture('same');
    expect(await send(5, await statisticsBatch(f))).toMatchObject({ status: 200 });
    const registration = refresh();
    expect(await send(1, registration)).toMatchObject({ status: 200 });
    const reply = await send(2), policy = reply.body.config.policy as DeviceConfigV3;
    expect(policy.assignment_generation).toBe(2);
    expect(policy.control.activation.after_window_seq).toBe(4);
    expect(policy.control.activation.after_segment_seq).toBe(0);
    expect(policy.control.capability_sha256).toBe(await capabilityDigestV3(registration.capabilities));
    for (const key of ['collection', 'evidence', 'temporal', 'resources', 'local_raw', 'uplink', 'local_queue'] as const)
      expect(policy[key]).toEqual(f.policy[key]);
    expect({ ...policy.custody, accept_until: '' }).toEqual({ ...f.policy.custody, accept_until: '' });
    expect(Date.parse(policy.control.activation.expires_at)).toBeLessThanOrEqual(Date.parse(registration.capabilities.expires_at));
    expect(await count('device_acknowledgements_v3')).toBe(1); expect(await count('device_statistics_authorizations_v3')).toBe(1);
    expect(await send(1, registration)).toMatchObject({ status: 200 });
    expect(await count('device_assignments_v3')).toBe(2);
    const premature = await statisticsBatch({ ...f, caps: registration.capabilities, policy });
    expect((await send(5, premature)).status).toBe(409);
    const ack = { ...await v3Ack(policy, 2), closed_window_seq: 4, closed_segment_seq: 0 };
    expect((await send(3, { ...ack, closed_window_seq: 3 })).status).not.toBe(200);
    expect(await send(3, ack)).toMatchObject({ status: 200, body: { state: 'applied', durability: 'committed' } });
    expect(await count('device_statistics_authorizations_v3')).toBe(2);
    // A retained floor survives source TTL cleanup and cannot be reset by renewal.
    await db.prepare("INSERT INTO statistics_sequence_floors_v3(node_id,boot_id,stream,seq_floor,window_seq_floor) VALUES(?,?,'window_statistics',9,12)")
      .bind(node, f.caps.boot_id).run();
    expect(await send(1, refresh(3))).toMatchObject({ status: 200 });
    expect((await send(2)).body.config.policy.control.activation.after_window_seq).toBe(12);
    expect(await count('device_assignments_v3')).toBe(3);
  });
  it('uses a new boot and zero boundary while retaining the prior durable applied template and receipts', async () => {
    const { send, refresh, count } = await fixture('boot'), boot = crypto.randomUUID(), registration = refresh(1, boot);
    expect(await send(1, registration, boot)).toMatchObject({ status: 200 });
    const config = (await send(2, '', boot)).body;
    expect(config.applied_generation).toBeNull();
    expect(config.config.policy.control.activation).toMatchObject({ boot_id: boot, after_window_seq: 0, after_segment_seq: 0 });
    expect(await count('device_acknowledgements_v3')).toBe(1);
    expect(await send(3, { ...await v3Ack(config.config.policy), closed_window_seq: 0, closed_segment_seq: 0 }, boot)).toMatchObject({ status: 200 });
    expect(await count('device_acknowledgements_v3')).toBe(2);
  });
  it('rolls back a final authorization race, then completes on the same frozen registration retry', async () => {
    const { node, send, refresh, count } = await fixture('race'), registration = refresh();
    await db.exec(`CREATE TRIGGER simulator_revoke AFTER INSERT ON device_assignments_v3 WHEN NEW.node_id='${node}' AND NEW.generation=2 BEGIN UPDATE device_nodes SET enabled=0 WHERE id=NEW.node_id; END`);
    expect(await send(1, registration)).toMatchObject({ status: 503, body: { error: { retryable: true } } });
    expect(await count('device_capabilities_v3')).toBe(2); expect(await count('device_assignments_v3')).toBe(1);
    expect(await db.prepare('SELECT enabled FROM device_nodes WHERE id=?').bind(node).first()).toEqual({ enabled: 1 });
    await db.exec('DROP TRIGGER simulator_revoke');
    expect(await send(1, registration)).toMatchObject({ status: 200 });
    expect(await count('device_assignments_v3')).toBe(2);
    expect(await db.prepare('SELECT COUNT(*) n FROM admin_write_assertions').first()).toEqual({ n: 0 });
  });
  it('never overwrites a desired generation without its matching applied ACK', async () => {
    const { f, node, send, refresh, count } = await fixture('pending');
    // An operator has replaced the approved generation with a pending change.
    // The helper must not fall back to generation 1's valid applied evidence.
    const pending = await freezeDeviceConfigV3({ ...f.policy, policy_id: 'operator-pending', assignment_generation: 2 });
    await db.prepare(`INSERT INTO device_assignments_v3(node_id,generation,policy_id,revision,boot_id,capability_sha256,policy_sha256,envelope_json,placement_id,not_before_ms,expires_at_ms,assigned_at)
      SELECT node_id,2,?,revision,boot_id,capability_sha256,?,?,placement_id,not_before_ms,expires_at_ms,assigned_at FROM device_assignments_v3 WHERE node_id=? AND generation=1`)
      .bind(pending.policy.policy_id, pending.policy_sha256, JSON.stringify(pending), node).run();
    await db.prepare('UPDATE device_control_v3 SET desired_generation=2,state_version=state_version+1 WHERE node_id=?').bind(node).run();
    expect((await send(1, refresh())).status).not.toBe(200);
    expect(await count('device_assignments_v3')).toBe(2); expect(await count('device_acknowledgements_v3')).toBe(1);
    expect((await db.prepare('SELECT desired_generation FROM device_control_v3 WHERE node_id=?').bind(node).first())?.desired_generation).toBe(2);
  });
  it('leaves a first registration waiting for ordinary administrator approval', async () => {
    const { send, refresh, count } = await fixture('initial');
    expect(await send(1, refresh(1))).toMatchObject({ status: 200 });
    expect((await send(2)).body).toMatchObject({ config: null, reason: 'unassigned' });
    expect(await count('device_assignments_v3')).toBe(0);
  });
  it('rejects an inactive placement and a revoked MQTT principal', async () => {
    const closed = await fixture('closed');
    await db.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES(?,?,?,?)')
      .bind(closed.f.policy.custody.placement_id, closed.node, Date.now() - 1, new Date().toISOString()).run();
    expect((await closed.send(1, closed.refresh())).status).toBe(503);
    expect(await closed.count('device_assignments_v3')).toBe(1);
    const revoked = await fixture('revoked');
    await db.prepare("UPDATE mqtt_credentials SET state='pending_broker',verified_at=NULL WHERE node_id=?").bind(revoked.node).run();
    expect((await revoked.send(1, revoked.refresh())).status).toBe(403);
    expect(await revoked.count('device_capabilities_v3')).toBe(1);
  });
  it('does not expand policy scope from changed capabilities or accept a different producer', async () => {
    const f = await fixture('producer'), changed = f.refresh(); changed.capabilities.producer_version = 'cp-v3-small/1';
    expect((await f.send(1, changed)).status).toBe(503); expect(await f.count('device_assignments_v3')).toBe(1);
    const g = await fixture('unsupported'), unsupported = g.refresh(); unsupported.capabilities.summary!.max_addresses = 1;
    expect((await g.send(1, unsupported)).status).toBe(503); expect(await g.count('device_assignments_v3')).toBe(1);
  });
  it('permits an expired applied template under the explicit continuous grant and fresh capabilities', async () => {
    const { send, refresh, count } = await fixture('expired', true, Date.now() - 3700000);
    expect(await send(1, refresh())).toMatchObject({ status: 200 });
    expect(await count('device_assignments_v3')).toBe(2);
  });
  it('fails closed when durable source policy integrity no longer verifies', async () => {
    const { send, refresh, node, count } = await fixture('corrupt');
    await db.exec('DROP TRIGGER device_assignments_v3_immutable_update');
    await db.prepare("UPDATE device_assignments_v3 SET policy_sha256=? WHERE node_id=?").bind('a'.repeat(64), node).run();
    await db.exec("CREATE TRIGGER device_assignments_v3_immutable_update BEFORE UPDATE ON device_assignments_v3 BEGIN SELECT RAISE(ABORT,'v3_immutable'); END");
    expect((await send(1, refresh())).status).toBe(503); expect(await count('device_assignments_v3')).toBe(1);
  });
  it('bounds a renewal to the effective finite placement deadline and 30 minute maximum', async () => {
    const { f, node, send, refresh } = await fixture('bounded'), until = Date.now() + 300000;
    await db.prepare('INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at) VALUES(?,?,?,?)')
      .bind(f.policy.custody.placement_id, node, until, new Date().toISOString()).run();
    expect(await send(1, refresh())).toMatchObject({ status: 200 });
    const p = (await send(2)).body.config.policy;
    expect(Date.parse(p.control.activation.expires_at)).toBe(until);
    expect(Date.parse(p.control.activation.expires_at) - Date.parse(p.control.activation.not_before)).toBeLessThanOrEqual(1800000);
  });
  it('does not renew an admitted simulator without the separate exact continuous grant', async () => {
    const { send, refresh, count } = await fixture('ungranted');
    expect(await send(1, refresh())).toMatchObject({ status: 200 }); expect(await count('device_assignments_v3')).toBe(1);
  });
});

describe('strict deployment grants', () => {
  const env = bindings as SimulatorRenewalEnv;
  it('defaults off and accepts an exact admitted subset', () => {
    expect(continuousSimulatorNodes({ ...env, DEVICE_V3_SIMULATOR_CONTINUOUS_NODE_IDS: undefined })).toEqual([]);
    expect(continuousSimulatorNodes({ ...env, DEVICE_V3_SIMULATOR_CONTINUOUS_NODE_IDS: JSON.stringify([nodes[0]]) })).toEqual([nodes[0]]);
  });
  it.each(['', 'null', '{}', 'bad-json', '[42]', '["sim-live-*"]', '["physical-node"]', JSON.stringify([nodes[0], nodes[0]]),
    '["sim-live-not-admitted"]', JSON.stringify(Array.from({ length: 17 }, (_, i) => `sim-live-${i}`))])('rejects malformed or overbroad grants: %s', grant => {
    expect(() => continuousSimulatorNodes({ ...env, DEVICE_V3_SIMULATOR_CONTINUOUS_NODE_IDS: grant })).toThrow();
  });
});
