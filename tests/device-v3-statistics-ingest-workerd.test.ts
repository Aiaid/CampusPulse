import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { sha256 } from '../worker/http';
import { seedStatistics, statisticsBatch, statisticsFixture, statisticsEvent, statisticsStatus, STATISTICS_FLAGS, type StatisticsFixture } from './helpers/v3-statistics-fixtures';
let mf: Miniflare, db: D1Database, f: StatisticsFixture;
const ORIGIN = 'https://statistics-workerd.example.test', token = 'synthetic-statistics-ingest-workerd';
async function seed(f: StatisticsFixture, credential = token) {
  await db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').bind(f.policy.node_id, await sha256(new TextEncoder().encode(credential))).run();
  await db.prepare('INSERT INTO placements(id,node_id,valid_from_ms) VALUES(?,?,0)').bind(f.policy.custody.placement_id, f.policy.node_id).run();
  await seedStatistics(db, f);
}
async function request(value: unknown, credential = token) {
  const body = JSON.stringify(value);
  return mf.dispatchFetch(ORIGIN + '/api/v3/statistics/ingest', { method: 'POST', headers: { Authorization: `Bearer ${credential}`,
    'Content-Type': 'application/json', 'X-Body-SHA256': await sha256(new TextEncoder().encode(body)) }, body });
}
beforeAll(async () => {
  const bundle = await build({ entryPoints: ['tests/helpers/v3-statistics-workerd.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:*'], target: 'es2022' });
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'v3-statistics-ingest-test', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], bindings: STATISTICS_FLAGS, log: new Log(LogLevel.ERROR) }));
  db = await mf.getD1Database('DB');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(n => /^\d+.*\.sql$/.test(n)).sort())
    await db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8').replace(/^--.*$/gm, '').replace(/\n/g, ' '));
  f = await statisticsFixture('statistics-workerd-node', 'statistics-workerd-place'); await seed(f);
}, 30000);
afterAll(async () => { await mf?.dispose(); });

describe.sequential('compact statistics in real local workerd D1', () => {
  it('deduplicates concurrent frozen batches with a single source row and quota charge', async () => {
    const b = await statisticsBatch(f), responses = await Promise.all([request(b), request(b)]);
    const values = await Promise.all(responses.map(r => r.json()));
    expect(responses.map(r => r.status), JSON.stringify(values)).toEqual([200, 200]); expect(values[0]).toEqual(values[1]);
    expect(await db.prepare('SELECT COUNT(*) n FROM statistics_windows_v3').first()).toMatchObject({ n: 1 });
    expect(await db.prepare('SELECT used_bytes FROM statistics_quota_v3').first()).toMatchObject({ used_bytes: new TextEncoder().encode(JSON.stringify(b)).byteLength });
  });
  it('serializes overlapping sequence and window identities with full loser rollback', async () => {
    const a = await statisticsBatch(f, 2), b = { ...a, b: crypto.randomUUID() };
    const responses = await Promise.all([request(a), request(b)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    expect(await db.prepare('SELECT COUNT(*) n FROM statistics_windows_v3').first()).toMatchObject({ n: 2 });
    expect(await db.prepare('SELECT COUNT(*) n FROM admin_write_assertions').first()).toMatchObject({ n: 0 });
  });
  it('rolls back injected source failure and accepts the exact frozen retry', async () => {
    const b = await statisticsBatch(f, 3);
    await db.exec("CREATE TRIGGER statistics_failure BEFORE INSERT ON statistics_windows_v3 WHEN NEW.seq=3 BEGIN SELECT RAISE(ABORT,'synthetic_storage_failure'); END");
    expect((await request(b)).status).toBe(503);
    expect(await db.prepare('SELECT 1 FROM statistics_batches_v3 WHERE batch_id=?').bind(b.b).first()).toBeNull();
    await db.exec('DROP TRIGGER statistics_failure'); expect((await request(b)).status).toBe(200);
  });
  it('serializes concurrent quota consumption without partial receipts', async () => {
    const q = await statisticsFixture('statistics-quota-node', 'statistics-quota-place'), credential = token + '-quota';
    q.policy.custody.max_upload_bytes_per_day = 1024; if (q.policy.uplink.enabled) q.policy.uplink.max_body_bytes = 1024;
    await seed(q, credential); const batches = await Promise.all([1, 2, 3].map(n => statisticsBatch(q, n)));
    const responses = await Promise.all(batches.map(b => request(b, credential)));
    expect(responses.some(r => r.status === 200)).toBe(true); expect(responses.some(r => r.status === 429)).toBe(true);
    expect(responses.every(r => [200, 429].includes(r.status))).toBe(true);
    const accepted = batches.reduce((n, b, i) => n + (responses[i].status === 200 ? new TextEncoder().encode(JSON.stringify(b)).byteLength : 0), 0);
    expect(await db.prepare('SELECT used_bytes FROM statistics_quota_v3 WHERE node_id=?').bind(q.policy.node_id).first()).toMatchObject({ used_bytes: accepted });
  });
  it('protects event revision compare-and-swap under competing terminal updates', async () => {
    const e = await statisticsFixture('statistics-events-node', 'statistics-events-place', Date.now(), true), credential = token + '-events';
    await seed(e, credential); const open = await statisticsEvent(e); expect((await request(open, credential)).status).toBe(200);
    const a = await statisticsEvent(e, 2, 2, open.x[0].i, true), b = await statisticsEvent(e, 3, 2, open.x[0].i, true);
    const responses = await Promise.all([request(a, credential), request(b, credential)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    expect(await db.prepare('SELECT COUNT(*) n FROM statistics_events_v3').first()).toMatchObject({ n: 1 });
    expect(await db.prepare('SELECT revision,state FROM statistics_events_v3').first()).toMatchObject({ revision: 2, state: 'closed' });
  });
  it('accepts exact paused health retries after the capture lease ends without renewing it', async () => {
    const h = await statisticsFixture('statistics-health-node', 'statistics-health-place'), credential = token + '-health'; await seed(h, credential);
    await db.prepare('UPDATE device_statistics_lease_spans_v3 SET end_ms=? WHERE node_id=?').bind(h.now - 5000, h.policy.node_id).run();
    const before = await db.prepare('SELECT * FROM device_statistics_authorizations_v3 WHERE node_id=?').bind(h.policy.node_id).first();
    const health = await statisticsStatus(h); health.x[0].s = 'paused'; health.x[0].j = [1, 512, 200, 300000, 1, 512];
    const first = await request(health, credential), receipt = await first.json(); expect(first.status, JSON.stringify(receipt)).toBe(200);
    const retry = await request(health, credential); expect(retry.status).toBe(200); expect(await retry.json()).toEqual(receipt);
    expect(await db.prepare('SELECT * FROM device_statistics_authorizations_v3 WHERE node_id=?').bind(h.policy.node_id).first()).toEqual(before);
    expect((await request(await statisticsStatus(h, 2), credential)).status).toBe(409);
  });
  it('authorizes scanned absences through observed_until but not a later logical censor tail', async () => {
    const e = await statisticsFixture('statistics-censor-node', 'statistics-censor-place', Date.now(), true), credential = token + '-censor'; await seed(e, credential);
    await db.prepare('UPDATE device_statistics_lease_spans_v3 SET end_ms=? WHERE node_id=?').bind(e.now - 5000, e.policy.node_id).run();
    const batch = await statisticsEvent(e, 1, 1, crypto.randomUUID(), true);
    Object.assign(batch.x[0], { s: 'censored', c: 'lease_expired', f: 8, u: [5000, e.now - 5000, 1, 0] });
    batch.x[0].r[2] = 1; batch.x[0].r[3] = 4000;
    const first = await request(batch, credential), receipt = await first.json() as { expires_at: string };
    expect(first.status, JSON.stringify(receipt)).toBe(200); expect(Date.parse(receipt.expires_at)).toBe(e.now - 5000 + 3600000);
    expect(await (await request(batch, credential)).json()).toEqual(receipt);
    const unsupported = structuredClone(batch); unsupported.b = crypto.randomUUID(); unsupported.x[0].q = 2; unsupported.x[0].i = crypto.randomUUID();
    unsupported.x[0].u = [6000, e.now - 4000, 1, 0]; expect((await request(unsupported, credential)).status).toBe(409);
  });
});
