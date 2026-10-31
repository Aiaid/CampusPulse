import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDeviceV3Ingest, expireDeviceV3Ingest } from '../worker/device-v3-ingest';
import { assertV3IngestPolicy, supportsV3IngestPolicy, type DeviceV3IngestEnv } from '../worker/device-v3-ingest-validation';
import { handleDeviceV3Control } from '../worker/device-v3-control';
import { capabilityDigestV3 } from '../worker/device-v3-config';
import { sha256 } from '../worker/http';
import { handleApi } from '../worker/index';
import worker from '../worker/index';
import { DEVICE_TOKEN, fixture, setup } from './helpers/ingestion';
import { featureBatchV3, ingestV3Fixture, INGEST_V3_FLAGS, seedIngestV3, statusBatchV3, type IngestV3Fixture } from './helpers/v3-ingest-fixtures';
import { v3Ack } from './helpers/device-v3-fixtures';

let state: Awaited<ReturnType<typeof setup>>, env: DeviceV3IngestEnv, f: IngestV3Fixture;
const ORIGIN = 'https://v3-ingest.example.test';
async function request(value: unknown, headers: Record<string, string> = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  return (await handleDeviceV3Ingest(new Request(ORIGIN + '/api/v3/ingest', { method: 'POST', headers: {
    Authorization: `Bearer ${DEVICE_TOKEN}`, 'Content-Type': 'application/json', 'X-Body-SHA256': await sha256(new TextEncoder().encode(body)), ...headers }, body }), env))!;
}
async function expectResponse(value: unknown, status = 200) {
  const response = await request(value), body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status); return body as Record<string, any>;
}
function interpose(action: () => unknown) {
  const batch = env.DB.batch.bind(env.DB); let fired = false;
  vi.spyOn(env.DB, 'batch').mockImplementation(async writes => { if (!fired) { fired = true; await action(); } return batch(writes); });
}
const count = (table: string) => Number(state.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n);
async function ack(p = f.policy, window = 3, segment = 2) {
  const body = { ...await v3Ack(p, p.assignment_generation), closed_window_seq: window, closed_segment_seq: segment };
  return (await handleDeviceV3Control(new Request(ORIGIN + '/api/v3/device/config/ack', { method: 'POST',
    headers: { Authorization: `Bearer ${DEVICE_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env))!;
}
beforeEach(async () => { state = await setup(); env = { ...state.env, ...INGEST_V3_FLAGS }; f = await ingestV3Fixture(state.config.node_id, state.config.placement_id); });
afterEach(() => { vi.restoreAllMocks(); state.db.close(); });

describe('private default-off v3 ingestion', () => {
  it('gates writes, requires HTTPS/authentication, and does not claim another route', async () => {
    delete env.DEVICE_V3_INGEST_ENABLED;
    expect(await expectResponse(await featureBatchV3(f), 503)).toMatchObject({ error: { code: 'v3_ingest_disabled' } });
    expect(await handleDeviceV3Ingest(new Request(ORIGIN + '/api/v2/ingest'), env)).toBeNull();
    env.DEVICE_V3_INGEST_ENABLED = 'true';
    expect((await request({}, { Authorization: 'Bearer invalid' })).status).toBe(401);
    expect((await handleDeviceV3Ingest(new Request('http://v3-ingest.example.test/api/v3/ingest'), env))?.status).toBe(403);
    expect(count('ingestion_batches_v3')).toBe(0);
  });
  it('rejects unsupported policies and leases too short for a complete window', () => {
    for (const duration of [30000, 60000]) {
      const p = structuredClone(f.policy); p.collection.summary = { enabled: true, window_ms: 60000, bin_ms: 1000, max_addresses: 2 };
      p.control.lease.duration_ms = duration; expect(supportsV3IngestPolicy(p)).toBe(false);
    }
    const p = structuredClone(f.policy); if (p.uplink.enabled) p.uplink.transport = 'mqtt_tls';
    expect(() => assertV3IngestPolicy(p, env)).toThrow();
    delete env.DEVICE_V3_EXTRACTOR_VERSIONS; expect(() => assertV3IngestPolicy(f.policy, env)).toThrow();
  });
  it('requires a successful historical applied ACK, not a desired assignment', async () => {
    await seedIngestV3(env.DB, f, false);
    await expectResponse(await featureBatchV3(f), 409);
    expect(count('ingestion_items_v3')).toBe(0);
  });
  it('commits exact receipts and does not expose private features or increment quota on retry', async () => {
    await seedIngestV3(env.DB, f); const batch = await featureBatchV3(f), first = await expectResponse(batch);
    expect(first).toMatchObject({ protocol: 'campuspulse/3', custody: 'private_source', inference: 'not_performed', window_completeness: 'not_established', accepted_count: 1 });
    expect(first).not.toHaveProperty('items'); expect(JSON.stringify(first)).not.toContain(batch.items[0].evidence.identity.token);
    expect(await expectResponse(batch)).toEqual(first);
    const used = state.db.prepare('SELECT used_bytes FROM ingestion_quota_v3').get()!.used_bytes;
    expect(used).toBe(new TextEncoder().encode(JSON.stringify(batch)).byteLength);
    await expectResponse({ ...batch, producer_version: 'other' }, 409);
    expect(count('ingestion_batches_v3')).toBe(1); expect(count('admin_write_assertions')).toBe(0);
  });
  it('replays committed receipts after allowlist removal without revalidating private data', async () => {
    await seedIngestV3(env.DB, f); const batch = await featureBatchV3(f), original = await expectResponse(batch);
    delete env.DEVICE_V3_PRODUCER_VERSIONS; delete env.DEVICE_V3_EXTRACTOR_VERSIONS;
    expect(await expectResponse(batch)).toEqual(original);
    await expectResponse(await featureBatchV3(f, 2), 422);
  });
  it('enforces strict byte hashes, unknown fields, duplicate keys and privacy fields', async () => {
    await seedIngestV3(env.DB, f); const batch = await featureBatchV3(f);
    expect((await request(batch, { 'X-Body-SHA256': '0'.repeat(64) })).status).toBe(400);
    expect((await request(JSON.stringify(batch).replace('"protocol":', '"protocol":"campuspulse/3","protocol":'))).status).toBe(400);
    await expectResponse({ ...batch, private_name: 'PRIVATE_NEVER_ECHO' }, 422);
    Object.assign(batch.items[0].evidence.identity, { address: 'PRIVATE_NEVER_ECHO' });
    const response = await expectResponse(batch, 422); expect(JSON.stringify(response)).not.toContain('PRIVATE_NEVER_ECHO');
    expect((await request(' '.repeat(65537))).status).toBe(413);
  });
  it('enforces current credential ownership, policy binding and configured body limit', async () => {
    if (f.policy.uplink.enabled) f.policy.uplink.max_body_bytes = 512;
    await seedIngestV3(env.DB, f); const batch = await featureBatchV3(f);
    await expectResponse({ ...batch, node_id: 'other-node' }, 403);
    await expectResponse({ ...batch, policy_sha256: '0'.repeat(64) }, 403);
    await expectResponse(batch, 413);
  });
  it('enforces cross-batch identifiers, budgets and exact shared window provenance atomically', async () => {
    await seedIngestV3(env.DB, f); const first = await featureBatchV3(f, 1), second = await featureBatchV3(f, 2), third = await featureBatchV3(f, 3);
    await expectResponse(first); await expectResponse(second); await expectResponse(third, 409);
    expect(count('ingestion_items_v3')).toBe(2); expect(count('ingestion_batches_v3')).toBe(2);
    expect(state.db.prepare('SELECT accepted_count FROM ingestion_windows_v3').get()!.accepted_count).toBe(2);
    const changed = await featureBatchV3(f, 3); changed.items[0].evidence.source_counters.window_queue_drops.value = 1;
    await expectResponse(changed, 409);
  });
  it('does not accept an identifier twice under a fresh sequence or batch', async () => {
    await seedIngestV3(env.DB, f); const a = await featureBatchV3(f), b = await featureBatchV3(f, 2);
    b.items[0].evidence.identity = a.items[0].evidence.identity;
    await expectResponse(a); await expectResponse(b, 409); expect(count('ingestion_items_v3')).toBe(1);
  });
  it('enforces cumulative feature-byte and report budgets across split batches', async () => {
    if (f.policy.evidence.mode === 'features') f.policy.evidence.max_reports_per_window = 3;
    await seedIngestV3(env.DB, f); await expectResponse(await featureBatchV3(f)); await expectResponse(await featureBatchV3(f, 2), 409);
    expect(state.db.prepare('SELECT examined_reports FROM ingestion_windows_v3').get()!.examined_reports).toBe(2);
  });
  it('enforces canonical feature-byte accounting across separate batches', async () => {
    if (f.policy.evidence.mode === 'features') f.policy.evidence.max_bytes_per_window = 2500;
    await seedIngestV3(env.DB, f); await expectResponse(await featureBatchV3(f));
    await expectResponse(await featureBatchV3(f, 2), 409); expect(count('ingestion_items_v3')).toBe(1);
  });
  it('rejects null/uncertain/future/pre-activation times and honors half-open boundaries', async () => {
    await seedIngestV3(env.DB, f);
    for (const mutate of [
      (b: Awaited<ReturnType<typeof featureBatchV3>>) => { b.items[0].evidence.observed_time.start.utc_ms = null; b.items[0].evidence.observed_time.start.uncertainty_ms = null; },
      (b: Awaited<ReturnType<typeof featureBatchV3>>) => { b.items[0].evidence.observed_time.start.uncertainty_ms = 5001; },
      (b: Awaited<ReturnType<typeof featureBatchV3>>) => { b.items[0].evidence.observed_time.start.utc_ms = f.appliedAt - 1; b.items[0].evidence.observed_time.end.utc_ms = f.appliedAt + 999; },
      (b: Awaited<ReturnType<typeof featureBatchV3>>) => { b.items[0].evidence.observed_time.end.utc_ms! += 10; },
    ]) { const b = await featureBatchV3(f); mutate(b); await expectResponse(b, 422); }
  });
  it('denies new expired lease uploads but preserves already committed receipts', async () => {
    f.appliedAt = f.now - 121000; f.caps.issued_at = new Date(f.now - 200000).toISOString();
    f.policy.control.capability_sha256 = await capabilityDigestV3(f.caps); f.policy.control.activation.not_before = new Date(f.now - 150000).toISOString();
    await seedIngestV3(env.DB, f); const b = await featureBatchV3(f);
    b.items[0].evidence.observed_time.start.utc_ms = f.now - 10000; b.items[0].evidence.observed_time.end.utc_ms = f.now - 9000;
    await expectResponse(b, 410);
  });
  it('does not restart source retention at a delayed upload time', async () => {
    f.now -= 3700000; f.appliedAt = f.now - 10000;
    f.caps.issued_at = new Date(f.now - 60000).toISOString(); f.policy.control.capability_sha256 = await capabilityDigestV3(f.caps);
    f.policy.control.activation.not_before = new Date(f.now - 30000).toISOString(); f.policy.control.lease.duration_ms = 7200000;
    await seedIngestV3(env.DB, f); await expectResponse(await featureBatchV3(f), 410);
    expect(count('ingestion_batches_v3')).toBe(0);
  });
  it('allows historical applied policies within their later successful boundary', async () => {
    await seedIngestV3(env.DB, f); const old = await featureBatchV3(f);
    const newer = structuredClone(f); newer.policy.policy_id = 'synthetic-policy-2'; newer.policy.assignment_generation = 2; newer.appliedAt = f.now - 3000;
    await seedIngestV3(env.DB, newer, true, 4);
    await expectResponse(old);
    const tooLate = await featureBatchV3(f, 2, 5); await expectResponse(tooLate, 409);
  });
  it('rejects retired-boot new uploads while replaying an existing receipt', async () => {
    await seedIngestV3(env.DB, f); const b = await featureBatchV3(f), original = await expectResponse(b);
    const other = crypto.randomUUID(); state.db.prepare('INSERT INTO device_boots_v3(node_id,boot_id,first_seen_at) VALUES(?,?,?)').run(f.policy.node_id, other, new Date().toISOString());
    state.db.prepare('UPDATE device_control_v3 SET boot_id=?,state_version=state_version+1').run(other);
    expect(await expectResponse(b)).toEqual(original); await expectResponse(await featureBatchV3(f, 2), 409);
  });
  it('enforces status sequence ordering in both insertion directions', async () => {
    await seedIngestV3(env.DB, f); await expectResponse(await statusBatchV3(f, 2));
    const earlier = await statusBatchV3(f, 1); earlier.items[0].losses.upload_failures = 1;
    await expectResponse(earlier, 409);
    const later = await statusBatchV3(f, 3); later.items[0].uptime_ms = later.items[0].time.mono_ms = 8000;
    await expectResponse(later, 409); expect(count('ingestion_status_order_v3')).toBe(1);
  });
  it('rolls back a quota loser without retaining its item or budget increment', async () => {
    if (f.policy.uplink.enabled) f.policy.uplink.max_body_bytes = 4096;
    f.policy.custody.max_upload_bytes_per_day = 4096;
    await seedIngestV3(env.DB, f); const a = await featureBatchV3(f);
    await expectResponse(a);
    let status = 200;
    for (let seq = 2; seq < 6 && status === 200; seq++) status = (await request(await featureBatchV3(f, seq, seq + 10))).status;
    expect(status).toBe(429);
    const quota = state.db.prepare('SELECT used_bytes,limit_bytes FROM ingestion_quota_v3').get()!;
    expect(Number(quota.used_bytes)).toBeLessThanOrEqual(Number(quota.limit_bytes));
    expect(count('ingestion_items_v3')).toBe(count('ingestion_batches_v3'));
  });
  it('does not reset the node/day quota when a higher-quota assignment is applied', async () => {
    const initial = await featureBatchV3(f), limit = new TextEncoder().encode(JSON.stringify(initial)).byteLength + 128;
    if (f.policy.uplink.enabled) f.policy.uplink.max_body_bytes = limit;
    f.policy.custody.max_upload_bytes_per_day = limit;
    await seedIngestV3(env.DB, f); await expectResponse(await featureBatchV3(f));
    const newer = structuredClone(f); newer.policy.policy_id = 'synthetic-policy-2'; newer.policy.assignment_generation = 2;
    newer.policy.custody.max_upload_bytes_per_day = 262144; if (newer.policy.uplink.enabled) newer.policy.uplink.max_body_bytes = 65536;
    newer.appliedAt = f.now - 3000; newer.now = f.now + 3000;
    await seedIngestV3(env.DB, newer, true, 4);
    await expectResponse(await featureBatchV3(newer, 2, 5), 429);
    expect(count('ingestion_batches_v3')).toBe(1);
  });
  it('rolls back credential revocation and control changes during commit', async () => {
    await seedIngestV3(env.DB, f); const b = await featureBatchV3(f);
    interpose(() => state.db.prepare('UPDATE device_nodes SET enabled=0').run()); await expectResponse(b, 401);
    expect(count('ingestion_batches_v3')).toBe(0);
    vi.restoreAllMocks(); state.db.prepare('UPDATE device_nodes SET enabled=1').run();
    interpose(() => state.db.prepare('UPDATE device_control_v3 SET state_version=state_version+1').run()); await expectResponse(b, 503);
    expect(count('ingestion_quota_v3')).toBe(0);
  });
  it('rolls back a write that crosses the lease deadline inside the transaction', async () => {
    f.appliedAt = f.now - 119750; f.caps.issued_at = new Date(f.now - 200000).toISOString();
    f.policy.control.capability_sha256 = await capabilityDigestV3(f.caps); f.policy.control.activation.not_before = new Date(f.now - 150000).toISOString();
    await seedIngestV3(env.DB, f); let delayed = false;
    state.db.function('synthetic_delay', () => { delayed = true; const until = Date.now() + 400; while (Date.now() < until) { /* Test a slow synchronous SQL write. */ } return 1; });
    state.db.exec('CREATE TRIGGER synthetic_slow_insert BEFORE INSERT ON ingestion_items_v3 BEGIN SELECT synthetic_delay(); END');
    await expectResponse(await featureBatchV3(f), 410);
    expect(delayed).toBe(true); expect(count('ingestion_batches_v3')).toBe(0); expect(count('ingestion_items_v3')).toBe(0);
    expect(count('ingestion_quota_v3')).toBe(0); expect(count('ingestion_windows_v3')).toBe(0);
  });
  it('deduplicates concurrent retries and keeps failures retryable with no partial state', async () => {
    await seedIngestV3(env.DB, f); const b = await featureBatchV3(f);
    vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(new Error('Synthetic outage'));
    await expectResponse(b, 503); expect(count('ingestion_windows_v3')).toBe(0);
    vi.restoreAllMocks(); const responses = await Promise.all([request(b), request(b)]);
    expect(responses.map(r => r.status)).toEqual([200, 200]); expect(await responses[0].json()).toEqual(await responses[1].json());
  });
  it('cleans expired private data with the gate disabled and replay never resurrects it', async () => {
    await seedIngestV3(env.DB, f); const b = await featureBatchV3(f), original = await expectResponse(b);
    delete env.DEVICE_V3_INGEST_ENABLED; await expireDeviceV3Ingest(env, Date.parse(original.expires_at) + 1);
    expect(count('ingestion_items_v3')).toBe(0); expect(count('ingestion_windows_v3')).toBe(1);
    env.DEVICE_V3_INGEST_ENABLED = 'true'; expect(await expectResponse(b)).toEqual(original);
    expect(count('ingestion_items_v3')).toBe(0);
    await expireDeviceV3Ingest(env, Date.parse(original.retain_until) + 1);
    expect(count('ingestion_batches_v3')).toBe(0); expect(count('ingestion_windows_v3')).toBe(0);
  });
  it('safely skips cleanup before the additive migration is installed', async () => {
    state.db.exec('DROP TABLE ingestion_items_v3; DROP TABLE ingestion_batches_v3');
    await expect(expireDeviceV3Ingest(env)).resolves.toMatchObject({ schema_available: false, deleted_private_rows: 0 });
  });
  it('drains multiple bounded cleanup rounds and reports a remaining backlog without private fields', async () => {
    await seedIngestV3(env.DB, f); const b = await featureBatchV3(f); await expectResponse(b);
    // Synthetic storage stress fixture; it does not claim these rows came from
    // a legal single request or from a physical producer.
    state.db.prepare(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<21001)
      INSERT INTO ingestion_items_v3(node_id,boot_id,stream,seq,batch_id,item_json,expires_at_ms)
      SELECT ?,?,'node_status',100000+x,?,'{}',? FROM n`).run(f.policy.node_id, f.caps.boot_id, b.batch_id, f.now - 1000);
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await expireDeviceV3Ingest(env, f.now);
    expect(first).toMatchObject({ deleted_private_rows: 20000, rounds: 4, expired_backlog: true, oldest_expired_age_ms: 1000 });
    expect(JSON.stringify(log.mock.calls)).not.toContain(f.policy.node_id);
    const second = await expireDeviceV3Ingest(env, f.now);
    expect(second).toMatchObject({ deleted_private_rows: 1001, rounds: 1, expired_backlog: false, oldest_expired_age_ms: null });
  });
  it('runs v3 cleanup through the actual scheduled entry even when a separate CPRAW cleanup fails', async () => {
    await seedIngestV3(env.DB, f); const original = await expectResponse(await featureBatchV3(f));
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(original.expires_at) + 1);
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, 'prepare').mockImplementation(sql => {
      if (sql.startsWith('SELECT * FROM cpraw_uploads WHERE')) throw new Error('Synthetic CPRAW cleanup failure');
      return prepare(sql);
    });
    await expect(worker.scheduled({ scheduledTime: Date.now(), cron: 'synthetic', noRetry() {} }, env)).rejects.toThrow('Synthetic CPRAW cleanup failure');
    expect(count('ingestion_items_v3')).toBe(0); expect(count('ingestion_batches_v3')).toBe(1);
  });
  it.each([1, 2])('rejects the retired v%i HTTP route without writing source data', async version => {
    await seedIngestV3(env.DB, f); const committed = await statusBatchV3(f); await expectResponse(committed);
    const config = version === 1 ? state.config : fixture('capture-config-v2.fixture');
    if (version === 2) {
      config.accept_until = new Date(Date.now() + 60000).toISOString();
      state.db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)')
        .run(config.capture_config_id, config.node_id, config.placement_id, config.dataset, JSON.stringify(config), Date.parse(config.accept_until));
      state.db.prepare('INSERT INTO config_assignments(node_id,capture_config_id,assigned_at) VALUES(?,?,?)').run(config.node_id, config.capture_config_id, new Date().toISOString());
    }
    for (const useBatchId of [false, true]) {
      const old = fixture(version === 1 ? 'node-status.request' : 'node-status-v2.request');
      old.capture_config_id = config.capture_config_id; old.boot_id = f.caps.boot_id;
      old.batch_id = useBatchId ? committed.batch_id : crypto.randomUUID(); old.items[0].seq = useBatchId ? 2 : 1;
      const body = JSON.stringify(old), req = new Request(ORIGIN + `/api/v${version}/ingest`, { method: 'POST', body,
        headers: { Authorization: `Bearer ${DEVICE_TOKEN}`, 'Content-Type': 'application/json', 'X-Body-SHA256': await sha256(new TextEncoder().encode(body)) } });
      const response = (await handleApi(req, env))!;
      const result = await response.json(); expect(response.status, JSON.stringify(result)).toBe(404);
      expect(result).toMatchObject({ error: { code: 'not_found', retryable: false } });
    }
    expect(count('ingestion_batches')).toBe(0); expect(count('ingestion_batches_v2')).toBe(0);
  });
  it('guards applied ACKs against earlier ACK and committed-window regressions', async () => {
    await seedIngestV3(env.DB, f); await expectResponse(await featureBatchV3(f, 1, 10));
    const newer = structuredClone(f); newer.policy.policy_id = 'synthetic-policy-2'; newer.policy.assignment_generation = 2;
    await seedIngestV3(env.DB, newer, false);
    expect((await ack(newer.policy, 2)).status).toBe(409);
    expect((await ack(newer.policy, 9)).status).toBe(409);
    expect((await ack(newer.policy, 10, 1)).status).toBe(409);
    expect((await ack(newer.policy, 10)).status).toBe(200);
  });
  it('checks committed-window high water inside the applied ACK transaction', async () => {
    await seedIngestV3(env.DB, f);
    const newer = structuredClone(f); newer.policy.policy_id = 'synthetic-policy-2'; newer.policy.assignment_generation = 2;
    await seedIngestV3(env.DB, newer, false);
    interpose(async () => { await expectResponse(await featureBatchV3(f, 1, 10)); });
    expect((await ack(newer.policy, 4)).status).toBe(409);
    expect(count('device_acknowledgements_v3')).toBe(1);
  });
});
