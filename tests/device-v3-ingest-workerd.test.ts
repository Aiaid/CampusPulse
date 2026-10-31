import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { sha256 } from '../worker/http';
import { featureBatchV3, ingestV3Fixture, INGEST_V3_FLAGS, seedIngestV3, statusBatchV3, type IngestV3Fixture } from './helpers/v3-ingest-fixtures';
import { fixture } from './helpers/ingestion';
let mf: Miniflare, db: D1Database, f: IngestV3Fixture;
const token = 'synthetic-v3-ingest-workerd-token', ORIGIN = 'https://v3-ingest.example.test';
async function request(body: unknown, credential = token) {
  const bytes = JSON.stringify(body);
  return mf.dispatchFetch(ORIGIN + '/api/v3/ingest', { method: 'POST', headers: { Authorization: `Bearer ${credential}`,
    'Content-Type': 'application/json', 'X-Body-SHA256': await sha256(new TextEncoder().encode(bytes)) }, body: bytes });
}
async function expectOk(body: unknown) {
  const r = await request(body), parsed = await r.json(); expect(r.status, JSON.stringify(parsed)).toBe(200); return parsed as Record<string, any>;
}
async function seedNode(fixture: IngestV3Fixture, credential: string) {
  await db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').bind(fixture.policy.node_id, await sha256(new TextEncoder().encode(credential))).run();
  await db.prepare('INSERT INTO placements(id,node_id,valid_from_ms) VALUES(?,?,0)').bind(fixture.policy.custody.placement_id, fixture.policy.node_id).run();
  await seedIngestV3(db, fixture);
}
beforeAll(async () => {
  const bundle = await build({ entryPoints: ['tests/helpers/v3-ingest-workerd.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*'], target: 'es2022' });
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'v3-ingest-test', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-23',
    compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], bindings: INGEST_V3_FLAGS, log: new Log(LogLevel.ERROR) }));
  db = await mf.getD1Database('DB');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(n => /^\d+.*\.sql$/.test(n)).sort()) {
    await db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8').replace(/^--.*$/gm, '').replace(/\n/g, ' '));
  }
  f = await ingestV3Fixture('synthetic-ingest-node', 'synthetic-ingest-place'); await seedNode(f, token);
}, 30000);
afterAll(async () => { await mf?.dispose(); });

describe.sequential('v3 private ingestion in real local workerd/D1', () => {
  it('returns one immutable receipt for concurrent exact retries', async () => {
    const batch = await featureBatchV3(f), replies = await Promise.all([request(batch), request(batch)]);
    const values = await Promise.all(replies.map(r => r.json()));
    expect(replies.map(r => r.status), JSON.stringify(values)).toEqual([200, 200]); expect(values[0]).toEqual(values[1]);
    expect(await db.prepare('SELECT COUNT(*) n FROM ingestion_batches_v3').first()).toMatchObject({ n: 1 });
    expect(await db.prepare('SELECT used_bytes FROM ingestion_quota_v3').first()).toMatchObject({ used_bytes: new TextEncoder().encode(JSON.stringify(batch)).byteLength });
    expect((await request({ ...batch, producer_version: 'changed' })).status).toBe(409);
  });
  it('serializes competing split-window budgets with complete loser rollback', async () => {
    const replies = await Promise.all([request(await featureBatchV3(f, 2)), request(await featureBatchV3(f, 3))]);
    expect(replies.map(r => r.status).sort()).toEqual([200, 409]);
    expect(await db.prepare('SELECT accepted_count FROM ingestion_windows_v3 WHERE window_seq=4').first()).toMatchObject({ accepted_count: 2 });
    expect(await db.prepare('SELECT COUNT(*) n FROM ingestion_batches_v3').first()).toMatchObject({ n: 2 });
    expect(await db.prepare('SELECT COUNT(*) n FROM ingestion_items_v3').first()).toMatchObject({ n: 2 });
    expect(await db.prepare('SELECT COUNT(*) n FROM admin_write_assertions').first()).toMatchObject({ n: 0 });
  });
  it('rolls back injected failure between receipt and item writes and accepts the exact retry', async () => {
    const batch = await featureBatchV3(f, 99, 10);
    await db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON ingestion_items_v3 WHEN NEW.seq=99 BEGIN SELECT RAISE(ABORT,'synthetic_storage_failure'); END");
    expect((await request(batch)).status).toBe(503);
    expect(await db.prepare('SELECT 1 FROM ingestion_batches_v3 WHERE batch_id=?').bind(batch.batch_id).first()).toBeNull();
    expect(await db.prepare('SELECT 1 FROM ingestion_windows_v3 WHERE window_seq=10').first()).toBeNull();
    await db.exec('DROP TRIGGER synthetic_failure'); await expectOk(batch);
  });
  it('enforces the node quota under concurrent independent windows', async () => {
    const quotaToken = 'synthetic-v3-quota-workerd-token', q = await ingestV3Fixture('synthetic-quota-node', 'synthetic-quota-place');
    q.policy.custody.max_upload_bytes_per_day = 4096; if (q.policy.uplink.enabled) q.policy.uplink.max_body_bytes = 4096;
    await seedNode(q, quotaToken);
    const batches = await Promise.all([1, 2, 3].map(n => featureBatchV3(q, n, n + 3)));
    const replies = await Promise.all(batches.map(b => request(b, quotaToken)));
    expect(replies.some(r => r.status === 200)).toBe(true); expect(replies.some(r => r.status === 429)).toBe(true);
    expect(replies.every(r => [200, 429].includes(r.status))).toBe(true);
    const acceptedBytes = batches.reduce((n, b, i) => n + (replies[i].status === 200 ? new TextEncoder().encode(JSON.stringify(b)).byteLength : 0), 0);
    expect(await db.prepare('SELECT used_bytes FROM ingestion_quota_v3 WHERE node_id=?').bind(q.policy.node_id).first()).toMatchObject({ used_bytes: acceptedBytes });
  });
  it('enforces bidirectional legacy batch and status-sequence namespaces', async () => {
    const config = fixture('capture-config.fixture');
    Object.assign(config, { node_id: f.policy.node_id, placement_id: f.policy.custody.placement_id, capture_config_id: 'synthetic-legacy-policy', accept_until: new Date(Date.now() + 60000).toISOString() });
    await db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)')
      .bind(config.capture_config_id, config.node_id, config.placement_id, config.dataset, JSON.stringify(config), Date.parse(config.accept_until)).run();
    const legacy = (batchId: string, seq: number) => db.prepare(`INSERT INTO ingestion_batches(node_id,batch_id,receipt_id,body_sha256,boot_id,stream,seq_first,seq_last,accepted_count,placement_id,capture_config_id,dataset,firmware_version,received_at,expires_at_ms,retain_until_ms)
      VALUES(?,?,?,?,?,'node_status',?,?,1,?,?,?,?,?,?,?)`).bind(config.node_id, batchId, crypto.randomUUID(), '0'.repeat(64), f.caps.boot_id, seq, seq,
        config.placement_id, config.capture_config_id, config.dataset, 'synthetic-legacy', new Date().toISOString(), Date.now() + 10000, Date.now() + 100000);
    const status = await statusBatchV3(f, 60); await expectOk(status);
    await expect(legacy(crypto.randomUUID(), 60).run()).rejects.toThrow();
    await expect(legacy(status.batch_id, 61).run()).rejects.toThrow();
    const oldId = crypto.randomUUID(); await legacy(oldId, 62).run();
    expect((await request({ ...await statusBatchV3(f, 63), batch_id: oldId })).status).toBe(409);
    expect((await request(await statusBatchV3(f, 62))).status).toBe(409);
  });
  it('removes private rows with ingestion disabled while retaining immutable source receipts', async () => {
    const batch = await featureBatchV3(f, 100, 11), receipt = await expectOk(batch);
    const cleanup = await mf.dispatchFetch(ORIGIN + '/__synthetic_cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ now: Date.parse(receipt.expires_at) + 1 }) });
    expect(cleanup.status).toBe(200);
    expect(await db.prepare('SELECT 1 FROM ingestion_items_v3 WHERE batch_id=?').bind(batch.batch_id).first()).toBeNull();
    expect(await expectOk(batch)).toEqual(receipt);
    expect(await db.prepare('SELECT 1 FROM ingestion_items_v3 WHERE batch_id=?').bind(batch.batch_id).first()).toBeNull();
  });
});
