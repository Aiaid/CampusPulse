import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expireDeviceV3Statistics, handleDeviceV3Statistics, type DeviceV3StatisticsEnv } from '../worker/device-v3-statistics';
import { handleIngestion, sha256 } from '../worker/ingest';
import { handleDeviceV2 } from '../worker/device-v2';
import { handleDeviceV3Ingest } from '../worker/device-v3-ingest';
import { capabilityDigestV3 } from '../worker/device-v3-config';
import { ingestV3Fixture, seedIngestV3, statusBatchV3, INGEST_V3_FLAGS } from './helpers/v3-ingest-fixtures';
import { DEVICE_TOKEN, fixture, setup } from './helpers/ingestion';
import { seedStatistics, statisticsBatch, statisticsEvent, statisticsFixture, statisticsStatus, STATISTICS_FLAGS, type StatisticsFixture } from './helpers/v3-statistics-fixtures';
let state: Awaited<ReturnType<typeof setup>>, env: DeviceV3StatisticsEnv, f: StatisticsFixture;
const path = 'https://statistics.example.test/api/v3/statistics/ingest';
async function request(value: unknown, headers: Record<string, string> = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  return (await handleDeviceV3Statistics(new Request(path, { method: 'POST', headers: { Authorization: `Bearer ${DEVICE_TOKEN}`,
    'Content-Type': 'application/json', 'X-Body-SHA256': await sha256(new TextEncoder().encode(body)), ...headers }, body }), env))!;
}
async function expectResponse(value: unknown, status = 200) {
  const response = await request(value), body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status); return body as Record<string, any>;
}
const count = (table: string) => Number(state.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
function interpose(action: () => unknown) {
  const batch = env.DB.batch.bind(env.DB); let fired = false;
  vi.spyOn(env.DB, 'batch').mockImplementation(async writes => { if (!fired) { fired = true; await action(); } return batch(writes); });
}
beforeEach(async () => {
  state = await setup(); env = { ...state.env, ...STATISTICS_FLAGS };
  f = await statisticsFixture(state.config.node_id, state.config.placement_id);
});
afterEach(() => { vi.restoreAllMocks(); state.db.close(); });

describe('compact v3 statistics custody', () => {
  it('defaults off, requires HTTPS, and does not claim other routes', async () => {
    delete env.DEVICE_V3_STATISTICS_ENABLED;
    await expectResponse(await statisticsBatch(f), 503);
    expect(await handleDeviceV3Statistics(new Request('https://example.test/api/v3/ingest'), env)).toBeNull();
    env.DEVICE_V3_STATISTICS_ENABLED = 'true';
    expect((await handleDeviceV3Statistics(new Request(path.replace('https:', 'http:')), env))?.status).toBe(403);
    expect(count('statistics_batches_v3')).toBe(0);
  });
  it('requires historical successful applied ACK and lease authority', async () => {
    await seedStatistics(env.DB, f, false); await expectResponse(await statisticsBatch(f), 409);
    expect(count('statistics_windows_v3')).toBe(0);
  });
  it('commits one window row with stable exact receipts and no raw or per-address data', async () => {
    await seedStatistics(env.DB, f); const b = await statisticsBatch(f), first = await expectResponse(b);
    expect(first).toMatchObject({ schema: 'device-statistics-receipt/3', durability: 'committed', custody: 'small_statistics', accepted_count: 1 });
    expect(await expectResponse(b)).toEqual(first);
    expect(count('statistics_windows_v3')).toBe(1); expect(count('statistics_batches_v3')).toBe(1);
    expect(count('ingestion_items_v3')).toBe(0); expect(state.raw.objects.size).toBe(0);
    const row = state.db.prepare('SELECT item_json FROM statistics_windows_v3').get()!;
    expect(JSON.parse(String(row.item_json))).toMatchObject({ visible_identifiers: 2, estimated_total: null, categories: { unknown: 2 } });
    expect(state.db.prepare('SELECT used_bytes FROM statistics_quota_v3').get()!.used_bytes).toBe(new TextEncoder().encode(JSON.stringify(b)).byteLength);
    await expectResponse({ ...b, d: 'demo' }, 409);
  });
  it('rejects malformed exact bytes, privacy fields, duplicate decoded keys and large bodies', async () => {
    await seedStatistics(env.DB, f); const b = await statisticsBatch(f);
    expect((await request(b, { 'X-Body-SHA256': '0'.repeat(64) })).status).toBe(400);
    await expectResponse({ ...b, address: 'PRIVATE_NEVER_ECHO' }, 422);
    await expectResponse(JSON.stringify(b).replace('"p":3', '"p":3,"\\u0070":3'), 400);
    expect((await request(' '.repeat(8193))).status).toBe(413);
    expect(count('statistics_windows_v3')).toBe(0);
  });
  it('rejects overlap and duplicate windows under new batch or sequence identities', async () => {
    await seedStatistics(env.DB, f); const first = await statisticsBatch(f); await expectResponse(first);
    await expectResponse({ ...first, b: crypto.randomUUID() }, 409);
    const second = await statisticsBatch(f, 2); second.x[0].w = first.x[0].w;
    await expectResponse(second, 409); expect(count('statistics_windows_v3')).toBe(1);
  });
  it('requires one UTC mapping per clock epoch and non-overlapping monotonic windows on both sides', async () => {
    await seedStatistics(env.DB, f);
    await expectResponse(await statisticsBatch(f, 1)); await expectResponse(await statisticsBatch(f, 3));
    const late = await statisticsBatch(f, 2); late.x[0].t[1] = Number(late.x[0].t[1]) - 500;
    await expectResponse(late, 409);
    const overlap = await statisticsBatch(f, 2); overlap.x[0].t[0] = Number(overlap.x[0].t[0]) - 500;
    overlap.x[0].t[1] = Number(overlap.x[0].t[1]) - 500; await expectResponse(overlap, 409);
    await expectResponse(await statisticsBatch(f, 2));
    expect(count('statistics_windows_v3')).toBe(3);
  });
  it('rejects a five-second UTC jump across adjacent windows unless the clock epoch changes', async () => {
    await seedStatistics(env.DB, f);
    const a = await statisticsBatch(f, 1); a.x[0].t[1] = f.now - 8000; await expectResponse(a);
    const b = await statisticsBatch(f, 2); b.x[0].t[1] = f.now - 2000; await expectResponse(b, 409);
    b.x[0].t[2] = 2; await expectResponse(b);
  });
  it('rejects unknown UTC and capture outside the lease without renewing it', async () => {
    await seedStatistics(env.DB, f); const unknown = await statisticsBatch(f);
    unknown.x[0].t[1] = null; unknown.x[0].t[3] = null; unknown.x[0].f = 2;
    expect(await expectResponse(unknown, 422)).toMatchObject({ error: { code: 'v3_statistics_time_unprovable' } });
    state.db.prepare('UPDATE device_statistics_lease_spans_v3 SET end_ms=?').run(f.now - 5000);
    await expectResponse(await statisticsBatch(f), 409);
    expect(state.db.prepare('SELECT contact_seq FROM device_statistics_authorizations_v3').get()!.contact_seq).toBe(0);
  });
  it.each(['paused', 'failed'])('accepts frozen late %s health after capture expiry without renewing authority', async collectionState => {
    f.policy.control.activation.expires_at = new Date(f.now - 5000).toISOString();
    await seedStatistics(env.DB, f);
    state.db.prepare('UPDATE device_statistics_lease_spans_v3 SET end_ms=?').run(f.now - 5000);
    const status = await statisticsStatus(f); status.x[0].s = collectionState;
    const frozenBody = JSON.stringify(status), before = state.db.prepare('SELECT * FROM device_statistics_authorizations_v3').get();
    const receipt = await expectResponse(frozenBody); expect(await expectResponse(frozenBody)).toEqual(receipt);
    expect(state.db.prepare('SELECT * FROM device_statistics_authorizations_v3').get()).toEqual(before);
    await expectResponse(await statisticsStatus(f, 2), 409);
    const unknown = await statisticsStatus(f, 2); unknown.x[0].s = collectionState;
    await expectResponse({ ...unknown, x: [{ ...unknown.x[0], t: [unknown.x[0].u, null, 1, null] }] }, 422);
  });
  it.each(['lease_expired', 'timeout'])('accepts a %s censor marker after lease end while authorizing only real observations', async cause => {
    f = await statisticsFixture(state.config.node_id, state.config.placement_id, Date.now(), true); await seedStatistics(env.DB, f);
    state.db.prepare('UPDATE device_statistics_lease_spans_v3 SET end_ms=?').run(f.now - 5000);
    const event = await statisticsEvent(f, 1, 1, crypto.randomUUID(), true);
    event.x[0].s = 'censored'; event.x[0].c = cause; event.x[0].f = 8;
    event.x[0].u = [5000, f.now - 5000, 1, 0]; event.x[0].r[2] = 1; event.x[0].r[3] = 4000;
    const frozenBody = JSON.stringify(event), receipt = await expectResponse(frozenBody);
    expect(await expectResponse(frozenBody)).toEqual(receipt);
    expect(Date.parse(receipt.expires_at)).toBe(f.now - 5000 + 3600000);
    expect(state.db.prepare('SELECT contact_seq FROM device_statistics_authorizations_v3').get()!.contact_seq).toBe(0);
    const closed = await statisticsEvent(f, 2, 1, crypto.randomUUID(), true); await expectResponse(closed, 409);
    const overrun = structuredClone(event); overrun.b = crypto.randomUUID(); overrun.x[0].i = crypto.randomUUID(); overrun.x[0].q = 2;
    overrun.x[0].r[3] = 5000; await expectResponse(overrun, 422);
    overrun.x[0].r[3] = 4000; overrun.x[0].u = [6000, f.now - 4000, 1, 0]; await expectResponse(overrun, 409);
  });
  it('rejects future logical censor times and rechecks health revocation at commit', async () => {
    f = await statisticsFixture(state.config.node_id, state.config.placement_id, Date.now(), true); await seedStatistics(env.DB, f);
    state.db.prepare('UPDATE device_statistics_lease_spans_v3 SET end_ms=?').run(f.now - 5000);
    const event = await statisticsEvent(f, 1, 1, crypto.randomUUID(), true);
    event.x[0].s = 'censored'; event.x[0].c = 'lease_expired'; event.x[0].f = 8; event.x[0].r[2] = 0; event.x[0].r[3] = 3000;
    event.x[0].u = [5000, f.now - 5000, 1, 0];
    event.x[0].e = [11000, f.now + 1000, 1, 0]; await expectResponse(event, 409);
    const health = await statisticsStatus(f); health.x[0].s = 'paused';
    interpose(() => state.db.prepare('UPDATE device_nodes SET enabled=0').run());
    await expectResponse(health, 401); expect(count('statistics_status_v3')).toBe(0); expect(count('statistics_events_v3')).toBe(0);
  });
  it('accepts an old boot frozen window captured before retirement, but denies new capture', async () => {
    await seedStatistics(env.DB, f);
    const boot = crypto.randomUUID(); state.db.prepare('INSERT INTO device_boots_v3(node_id,boot_id,first_seen_at) VALUES(?,?,?)').run(f.policy.node_id, boot, new Date(f.now - 2000).toISOString());
    state.db.prepare('UPDATE device_control_v3 SET boot_id=?,state_version=state_version+1').run(boot);
    state.db.prepare('UPDATE device_statistics_lease_spans_v3 SET end_ms=?').run(f.now - 2000);
    await expectResponse(await statisticsBatch(f));
    const later = await statisticsBatch(f, 2); later.x[0].t[1] = f.now - 1000;
    await expectResponse(later, 409);
  });
  it('rejects capture bridging a lease gap while permitting either authorized span', async () => {
    await seedStatistics(env.DB, f);
    state.db.prepare('UPDATE device_statistics_lease_spans_v3 SET end_ms=?').run(f.now - 4500);
    state.db.prepare('INSERT INTO device_statistics_lease_spans_v3 VALUES(?,?,?,?,?,?)').run(f.policy.node_id, 1, 2, f.now - 2500, f.now + 10000, Date.parse(f.policy.custody.accept_until));
    await expectResponse(await statisticsBatch(f), 409);
    const b = await statisticsBatch(f, 2); b.x[0].t[1] = f.now - 1000; await expectResponse(b);
  });
  it('enforces quota atomically and exact retries do not spend it again', async () => {
    await seedStatistics(env.DB, f); const b = await statisticsBatch(f); await expectResponse(b);
    state.db.prepare('UPDATE statistics_quota_v3 SET limit_bytes=used_bytes').run();
    await expectResponse(b); await expectResponse(await statisticsBatch(f, 2), 429);
    expect(count('statistics_windows_v3')).toBe(1);
  });
  it('enforces bidirectional batch and status namespaces against historical protocols', async () => {
    await seedStatistics(env.DB, f); const status = await statisticsStatus(f); await expectResponse(status);
    const old = (table: string, batch: string, seq: number, config = state.config.capture_config_id) => state.db.prepare(`INSERT INTO ${table}
      (node_id,batch_id,receipt_id,body_sha256,boot_id,stream,seq_first,seq_last,accepted_count,placement_id,capture_config_id,dataset,firmware_version,received_at,expires_at_ms,retain_until_ms)
      VALUES(?,?,?,?,?,'node_status',?,?,1,?,?,?,?,?,?,?)`).run(f.policy.node_id, batch, crypto.randomUUID(), '0'.repeat(64), f.caps.boot_id,
        seq, seq, state.config.placement_id, config, state.config.dataset, 'synthetic-only', new Date().toISOString(), Date.now() + 10000, Date.now() + 100000);
    expect(() => old('ingestion_batches', crypto.randomUUID(), 1)).toThrow(/v3_statistics_namespace/);
    const v2id = 'synthetic-old-v2', v2accept = Date.now() + 100000;
    state.db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)')
      .run(v2id, f.policy.node_id, state.config.placement_id, state.config.dataset,
        JSON.stringify({ ...state.config, capture_config_id: v2id, protocol: 'campuspulse/2', accept_until: new Date(v2accept).toISOString() }), v2accept);
    expect(() => old('ingestion_batches_v2', status.b, 5, v2id)).toThrow(/v3_statistics_namespace/);
    const feature = (batch: string) => state.db.prepare(`INSERT INTO ingestion_batches_v3(node_id,batch_id,boot_id,stream,generation,policy_sha256,body_sha256,seq_first,seq_last,receipt_json,expires_at_ms,retain_until_ms)
      VALUES(?,?,?,'feature_summaries',1,?,?,1,1,'{}',?,?)`).run(f.policy.node_id, batch, f.caps.boot_id, status.h, '0'.repeat(64), Date.now() + 1000, Date.now() + 10000);
    expect(() => feature(status.b)).toThrow(/v3_statistics_namespace/);
    old('ingestion_batches', crypto.randomUUID(), 2);
    await expectResponse(await statisticsStatus(f, 2), 409);
    const featureId = crypto.randomUUID(); feature(featureId);
    await expectResponse({ ...await statisticsBatch(f), b: featureId }, 409);
  });
  it.each([1, 2])('returns non-retryable legacy v%i HTTP conflicts, including after receipt cleanup', async version => {
    await seedStatistics(env.DB, f); const compact = await statisticsStatus(f), ack = await expectResponse(compact);
    const config = version === 1 ? state.config : fixture('capture-config-v2.fixture');
    if (version === 2) {
      config.accept_until = new Date(Date.now() + 60000).toISOString();
      state.db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)')
        .run(config.capture_config_id, config.node_id, config.placement_id, config.dataset, JSON.stringify(config), Date.parse(config.accept_until));
      state.db.prepare('INSERT INTO config_assignments(node_id,capture_config_id,assigned_at) VALUES(?,?,?)').run(config.node_id, config.capture_config_id, new Date().toISOString());
    }
    const upload = async (seq: number, batch = crypto.randomUUID()) => {
      const old = fixture(version === 1 ? 'node-status.request' : 'node-status-v2.request');
      old.capture_config_id = config.capture_config_id; old.boot_id = f.caps.boot_id; old.batch_id = batch; old.items[0].seq = seq;
      const body = JSON.stringify(old), req = new Request(`https://statistics.example.test/api/v${version}/ingest`, { method: 'POST', body,
        headers: { Authorization: `Bearer ${DEVICE_TOKEN}`, 'Content-Type': 'application/json', 'X-Body-SHA256': await sha256(new TextEncoder().encode(body)) } });
      const response = (await (version === 1 ? handleIngestion(req, env) : handleDeviceV2(req, env)))!, value = await response.json();
      expect(response.status, JSON.stringify(value)).toBe(409); expect(value).toMatchObject({ error: { retryable: false } });
    };
    await upload(1); await upload(2, compact.b);
    await expireDeviceV3Statistics(env, Date.parse(ack.retain_until) + 1);
    expect(count('statistics_batches_v3')).toBe(0); expect(count('statistics_sequence_floors_v3')).toBe(1);
    await upload(1);
    expect(count('ingestion_batches')).toBe(0); expect(count('ingestion_batches_v2')).toBe(0);
  });
  it('returns a non-retryable old feature HTTP conflict in a mixed applied-policy history', async () => {
    await seedStatistics(env.DB, f); const compact = await statisticsStatus(f); await expectResponse(compact);
    const old = await ingestV3Fixture(f.policy.node_id, f.policy.custody.placement_id!, Date.now(), 2);
    old.caps.capability_id = 'synthetic-historical-features'; old.policy.control.capability_sha256 = await capabilityDigestV3(old.caps);
    await seedIngestV3(env.DB, old); const oldBatch = await statusBatchV3(old, 1), body = JSON.stringify(oldBatch);
    const response = (await handleDeviceV3Ingest(new Request('https://statistics.example.test/api/v3/ingest', { method: 'POST', body,
      headers: { Authorization: `Bearer ${DEVICE_TOKEN}`, 'Content-Type': 'application/json', 'X-Body-SHA256': await sha256(new TextEncoder().encode(body)) } }),
      { ...env, ...INGEST_V3_FLAGS }))!;
    const result = await response.json(); expect(response.status, JSON.stringify(result)).toBe(409);
    expect(result).toMatchObject({ error: { retryable: false } }); expect(count('ingestion_batches_v3')).toBe(0);
  });
  it('rechecks credential revocation and lease truncation inside the transaction', async () => {
    await seedStatistics(env.DB, f);
    interpose(() => state.db.prepare('UPDATE device_nodes SET enabled=0').run());
    await expectResponse(await statisticsBatch(f), 401); expect(count('statistics_batches_v3')).toBe(0);
    vi.restoreAllMocks(); state.db.prepare('UPDATE device_nodes SET enabled=1').run();
    interpose(() => state.db.prepare('UPDATE device_statistics_lease_spans_v3 SET end_ms=start_ms').run());
    await expectResponse(await statisticsBatch(f), 409); expect(count('statistics_batches_v3')).toBe(0);
  });
  it('rechecks revocation after source writes before returning a committed receipt', async () => {
    await seedStatistics(env.DB, f);
    state.db.exec(`CREATE TRIGGER revoke_statistics AFTER INSERT ON statistics_windows_v3 BEGIN UPDATE device_nodes SET enabled=0 WHERE id=NEW.node_id; END;`);
    await expectResponse(await statisticsBatch(f), 409);
    expect(count('statistics_windows_v3')).toBe(0); expect(count('statistics_batches_v3')).toBe(0);
    expect(state.db.prepare('SELECT enabled FROM device_nodes').get()!.enabled).toBe(1);
  });
  it('rolls back a slow transaction that crosses the frozen acceptance deadline', async () => {
    f.policy.custody.accept_until = new Date(Date.now() + 200).toISOString();
    // Policy acceptance must extend beyond its collection expiry.
    f.policy.control.activation.expires_at = new Date(Date.now() + 100).toISOString();
    await seedStatistics(env.DB, f);
    state.db.function('statistics_delay', () => { const until = Date.now() + 300; while (Date.now() < until) { /* Synthetic slow SQL. */ } return 1; });
    state.db.exec('CREATE TRIGGER statistics_slow BEFORE INSERT ON statistics_windows_v3 BEGIN SELECT statistics_delay(); END;');
    await expectResponse(await statisticsBatch(f), 410);
    expect(count('statistics_batches_v3')).toBe(0); expect(count('statistics_windows_v3')).toBe(0); expect(count('statistics_quota_v3')).toBe(0);
  });
  it('keeps infrastructure failures retryable and deduplicates concurrent exact retries', async () => {
    await seedStatistics(env.DB, f); const b = await statisticsBatch(f);
    vi.spyOn(env.DB, 'batch').mockRejectedValueOnce(new Error('Synthetic unavailable storage'));
    expect(await expectResponse(b, 503)).toMatchObject({ error: { retryable: true } });
    expect(count('statistics_windows_v3')).toBe(0); vi.restoreAllMocks();
    const results = await Promise.all([request(b), request(b)]);
    expect(results.map(r => r.status)).toEqual([200, 200]); expect(await results[0].json()).toEqual(await results[1].json());
    expect(count('statistics_windows_v3')).toBe(1);
  });
  it('enforces both neighboring status sequence counters for delayed insertions', async () => {
    await seedStatistics(env.DB, f);
    await expectResponse(await statisticsStatus(f, 1, 2)); await expectResponse(await statisticsStatus(f, 3, 4));
    await expectResponse(await statisticsStatus(f, 2, 5), 409);
    await expectResponse(await statisticsStatus(f, 2, 1), 409);
    await expectResponse(await statisticsStatus(f, 2, 3)); expect(count('statistics_status_v3')).toBe(3);
  });
  it('reports historical event backlog against physical queue capacity without granting event upload', async () => {
    await seedStatistics(env.DB, f);
    const health = await statisticsStatus(f); health.x[0].s = 'paused';
    // Exceeds the current policy's per-stream minima and total budget, while
    // fitting the original selected medium's declared physical capacity.
    health.x[0].j = [1, 512, 200, 300000, 1, 512];
    const original = await expectResponse(health); expect(await expectResponse(health)).toEqual(original);
    const stored = JSON.parse(String(state.db.prepare('SELECT item_json FROM statistics_status_v3').get()!.item_json));
    expect(stored.queue.candidate_events).toEqual({ pending_items: 200, pending_bytes: 300000 });
    expect(f.policy.temporal).toEqual({ mode: 'off' });
    expect(await expectResponse(await statisticsEvent(f), 422)).toMatchObject({ error: { code: 'v3_statistics_stream_unavailable', retryable: false } });
    expect(count('statistics_events_v3')).toBe(0); expect(state.raw.objects.size).toBe(0);
  });
  it('bounds status queue totals by the selected frozen capability medium, not a larger alternate medium', async () => {
    f.caps.queue!.media.push({ medium: 'tf_journal', usable_bytes: 16777216, max_items: 100000, power_loss_recovery: true });
    f.policy.control.capability_sha256 = await capabilityDigestV3(f.caps); await seedStatistics(env.DB, f);
    for (const pending of [[1, 512, 10001, 300000, 1, 512], [1, 512, 200, 1048577, 1, 512],
      [6000, 400000, 5000, 400000, 1, 512], [100, 600000, 100, 600000, 1, 512]]) {
      const health = await statisticsStatus(f); health.x[0].s = 'paused'; health.x[0].j = pending;
      await expectResponse(health, 422);
    }
    expect(count('statistics_status_v3')).toBe(0); expect(count('statistics_batches_v3')).toBe(0);
  });
  it('stores only latest candidate revision and rejects stale or reopened terminal events', async () => {
    f = await statisticsFixture(state.config.node_id, state.config.placement_id, Date.now(), true); await seedStatistics(env.DB, f);
    const open = await statisticsEvent(f); await expectResponse(open);
    const terminal = await statisticsEvent(f, 2, 2, open.x[0].i, true); await expectResponse(terminal);
    expect(count('statistics_events_v3')).toBe(1);
    expect(state.db.prepare('SELECT revision,state FROM statistics_events_v3').get()).toMatchObject({ revision: 2, state: 'closed' });
    await expectResponse({ ...terminal, b: crypto.randomUUID(), x: [{ ...terminal.x[0], q: 3, v: 1 }] }, 409);
    await expectResponse(await statisticsEvent(f, 3, 3, open.x[0].i), 409);
  });
  it('limits open snapshots by server receive time but never blocks terminal delivery', async () => {
    f = await statisticsFixture(state.config.node_id, state.config.placement_id, Date.now(), true); await seedStatistics(env.DB, f);
    const first = await statisticsEvent(f); await expectResponse(first);
    await expectResponse(await statisticsEvent(f, 2, 2, first.x[0].i), 429);
    await expectResponse(await statisticsEvent(f, 2, 2, first.x[0].i, true));
  });
  it('cleans expired contents with gates off, preserves receipts and does not restore data', async () => {
    await seedStatistics(env.DB, f); const b = await statisticsBatch(f), original = await expectResponse(b);
    const expiry = Date.parse(original.expires_at); delete env.DEVICE_V3_STATISTICS_ENABLED;
    const result = await expireDeviceV3Statistics(env, expiry + 1); expect(result.deleted_private_rows).toBe(1);
    expect(state.db.prepare('SELECT item_json FROM statistics_windows_v3').get()!.item_json).toBeNull();
    env.DEVICE_V3_STATISTICS_ENABLED = 'true'; delete env.DEVICE_V3_PRODUCER_VERSIONS;
    expect(await expectResponse(b)).toEqual(original); // DB clock has not advanced; content is still never restored.
    expect(state.db.prepare('SELECT item_json FROM statistics_windows_v3').get()!.item_json).toBeNull();
    expect(count('statistics_quota_v3')).toBe(1);
    state.db.function('strftime', (format, _date) => format === '%s' ? String(Math.floor((expiry + 1) / 1000)) : `00.${String((expiry + 1) % 1000).padStart(3, '0')}`);
    expect(await expectResponse(b, 410)).toMatchObject({ evidence_state: 'expired', receipt: original, error: { retryable: false } });
    expect(count('statistics_windows_v3')).toBe(1);
  });
  it('checks local TF counters across unknown samples and in delayed known insertions', async () => {
    f.policy.local_raw = { mode: 'tf_cpraw', format: 'cpraw/1', max_segment_bytes: 1048576, max_total_bytes: 16777216,
      min_free_bytes: 1048576, sync_interval_ms: 1000, full_behavior: 'stop_recording' };
    await seedStatistics(env.DB, f);
    const first = await statisticsStatus(f, 1), unknown = await statisticsStatus(f, 2), later = await statisticsStatus(f, 3);
    await expectResponse({ ...first, x: [{ ...first.x[0], a: [10, 9, 8, 2, 1, 1] }] });
    await expectResponse({ ...unknown, x: [{ ...unknown.x[0], a: null }] });
    await expectResponse({ ...later, x: [{ ...later.x[0], a: [9, 9, 8, 2, 1, 1] }] }, 409);
    await expectResponse({ ...later, x: [{ ...later.x[0], a: [11, 10, 9, 3, 2, 2] }] });
    expect(state.raw.objects.size).toBe(0);
  });
  it('checks both nearest known TF samples across intervening unknown status', async () => {
    f.policy.local_raw = { mode: 'tf_cpraw', format: 'cpraw/1', max_segment_bytes: 1048576, max_total_bytes: 16777216,
      min_free_bytes: 1048576, sync_interval_ms: 1000, full_behavior: 'stop_recording' };
    await seedStatistics(env.DB, f);
    const status = async (seq: number, raw: number[] | null) => {
      const b = await statisticsStatus(f, seq); b.x[0].t[1] = f.now - 1000;
      return { ...b, x: [{ ...b.x[0], a: raw }] };
    };
    await expectResponse(await status(1, [10, 9, 8, 2, 1, 1]));
    await expectResponse(await status(2, null));
    await expectResponse(await status(5, [20, 19, 18, 4, 3, 3]));
    await expectResponse(await status(4, null));
    await expectResponse(await status(3, [21, 19, 18, 3, 2, 2]), 409);
    await expectResponse(await status(3, [15, 14, 13, 3, 2, 2]));
  });
  it('retains a bounded counter and sequence floor after receipt cleanup', async () => {
    await seedStatistics(env.DB, f); const b = await statisticsStatus(f, 1, 5); const original = await expectResponse(b);
    const afterRetain = Date.parse(original.retain_until) + 1;
    await expireDeviceV3Statistics(env, afterRetain);
    expect(count('statistics_batches_v3')).toBe(0); expect(count('statistics_status_v3')).toBe(0);
    expect(state.db.prepare('SELECT seq_floor,window_drops FROM statistics_sequence_floors_v3').get()).toMatchObject({ seq_floor: 1, window_drops: 5 });
    await expectResponse({ ...b, b: crypto.randomUUID() }, 409);
    await expectResponse(await statisticsStatus(f, 2, 4), 409);
  });
  it('retains the last window clock mapping and window high-water mark after cleanup', async () => {
    await seedStatistics(env.DB, f); const original = await expectResponse(await statisticsBatch(f, 1));
    await expireDeviceV3Statistics(env, Date.parse(original.retain_until) + 1);
    expect(count('statistics_windows_v3')).toBe(0);
    expect(state.db.prepare('SELECT seq_floor,window_seq_floor,uptime_ms,clock_epoch FROM statistics_sequence_floors_v3').get())
      .toMatchObject({ seq_floor: 1, window_seq_floor: 4, uptime_ms: 7000, clock_epoch: 1 });
    const bad = await statisticsBatch(f, 2); bad.x[0].t[1] = Number(bad.x[0].t[1]) - 500;
    await expectResponse(bad, 409); await expectResponse(await statisticsBatch(f, 2));
  });
  it('skips cleanup only when the additive migration is absent', async () => {
    state.db.exec('PRAGMA foreign_keys=OFF; DROP TABLE statistics_batches_v3;');
    expect(await expireDeviceV3Statistics(env)).toMatchObject({ schema_available: false });
  });
});
