import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { CPRAW_ID, concatCpraw, cprawHash, cprawHeader, cprawManifest, cprawReport, maximumCprawFile } from './helpers/cpraw-fixtures';

let mf: Miniflare;
const token = 'synthetic-workerd-device-token';
const base = `/api/v1/cpraw/uploads/${CPRAW_ID}`;
const file = concatCpraw(cprawHeader(), ...Array.from({ length: 40 }, () => cprawReport(1650, true)));
const upload = cprawManifest(file);
async function request(path: string, method = 'GET', bytes?: Uint8Array, headers: Record<string, string> = {}) {
  return mf.dispatchFetch(`https://synthetic.test${path}`, { method, body: bytes,
    headers: { Authorization: `Bearer ${token}`, ...headers } });
}
async function manifest() { return request(base, 'PUT', upload.bytes, { 'Content-Type': 'application/json', 'X-Body-SHA256': upload.hash }); }
async function chunk(index: number) { return request(`${base}/chunks/${index}`, 'PUT', upload.chunks[index],
  { 'Content-Type': 'application/octet-stream', 'X-Body-SHA256': cprawHash(upload.chunks[index]), 'X-Manifest-SHA256': upload.hash }); }
async function commit() { return request(`${base}/commit`, 'POST', undefined, { 'X-Manifest-SHA256': upload.hash }); }

beforeAll(async () => {
  const bundle = await build({ entryPoints: ['tests/helpers/cpraw-workerd.ts'], bundle: true, write: false,
    format: 'esm', platform: 'neutral', external: ['node:*'], target: 'es2022' });
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'cpraw-test', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-23',
    compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['RAW_BUCKET'],
    bindings: { CPRAW_ARCHIVE_ENABLED: '1', RESEARCH_TOKEN: 'synthetic-workerd-research-token' }, log: new Log(LogLevel.ERROR) }));
  const db = await mf.getD1Database('DB');
  await db.exec('CREATE TABLE device_nodes (id TEXT PRIMARY KEY,credential_sha256 TEXT,enabled INTEGER DEFAULT 1); CREATE TABLE placements (id TEXT,node_id TEXT,UNIQUE(id,node_id));');
  // D1 exec is line-oriented; keep each multi-line trigger as one SQL statement.
  await db.exec(readFileSync(new URL('../migrations/0013_cpraw_archive.sql', import.meta.url), 'utf8').replace(/^--.*$/gm, '').replace(/\n/g, ' '));
  await db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES (?,?)').bind('synthetic-node', cprawHash(token)).run();
  await db.prepare(`INSERT INTO cpraw_archive_policies
    (id,node_id,cpraw_archive,policy_kind,dataset,purpose,accept_until_ms,raw_retention_hours,max_file_bytes,max_files,max_pending_uploads,max_total_bytes)
    VALUES ('synthetic-import','synthetic-node',1,'offline_import','controlled_test','workerd synthetic',?,1,16780672,20,10,335613440)`)
    .bind(Date.now() + 86_400_000).run();
}, 30_000);
afterAll(async () => { await mf?.dispose(); });

describe.sequential('CPRAW in real local workerd D1/R2', () => {
  it('commits crossing-chunk frames and concurrent manifest/chunk/file retries', async () => {
    const manifests = await Promise.all([manifest(), manifest()]);
    expect(manifests.map(response => response.status)).toEqual([200, 200]);
    expect(await manifests[0].json()).toEqual(await manifests[1].json());
    expect((await commit()).status).toBe(409);
    const results = await Promise.all(upload.chunks.flatMap((_, index) => [chunk(index), chunk(index)]));
    for (let index = 0; index < results.length; index += 2) {
      expect(results[index].status).toBe(200);
      expect(await results[index].json()).toEqual(await results[index + 1].json());
    }
    const committed = await Promise.all([commit(), commit()]);
    expect(committed.map(response => response.status)).toEqual([200, 200]);
    const receipt = await committed[0].json();
    expect(receipt).toMatchObject({ file_bytes: file.length, chunk_count: 2, validation: { status: 'valid', reports: 40 } });
    expect(await committed[1].json()).toEqual(receipt);
    expect(await (await commit()).json()).toEqual(receipt);
    const status = await (await request(base)).json() as { chunks: unknown[]; receipt: unknown };
    expect(status.chunks.length).toBe(2); expect(status.receipt).toEqual(receipt);
  });
  it('retains binary bytes privately and tombstones repeated cleanup without resurrection', async () => {
    const researchPath = `/api/v1/research/cpraw/${CPRAW_ID}/chunks/0?node_id=synthetic-node`;
    expect((await request(researchPath)).status).toBe(401);
    const read = await request(researchPath, 'GET', undefined, { Authorization: 'Bearer synthetic-workerd-research-token' });
    expect(read.status).toBe(200); expect(new Uint8Array(await read.arrayBuffer())).toEqual(upload.chunks[0]);
    const before = await (await mf.getR2Bucket('RAW_BUCKET')).list(); expect(before.objects).toHaveLength(2);
    expect((await request('/__synthetic_cleanup', 'POST')).status).toBe(200);
    expect((await (await mf.getR2Bucket('RAW_BUCKET')).list()).objects).toHaveLength(0);
    expect((await chunk(0)).status).toBe(410);
    expect((await commit()).status).toBe(410);
    expect((await manifest()).status).toBe(410);
    expect((await request(researchPath, 'GET', undefined, { Authorization: 'Bearer synthetic-workerd-research-token' })).status).toBe(410);
    expect((await request('/__synthetic_cleanup', 'POST')).status).toBe(200);
    expect((await (await mf.getR2Bucket('RAW_BUCKET')).list()).objects).toHaveLength(0);
  });
  it('verifies the maximum valid 257-chunk segment with bounded parser input', async () => {
    const largest = maximumCprawFile();
    const item = cprawManifest(largest, '33333333-3333-4333-8333-333333333333');
    const route = `/api/v1/cpraw/uploads/${item.manifest.upload_id}`;
    expect(item.chunks).toHaveLength(257); expect(largest.length).toBe(16_780_672);
    expect((await request(route, 'PUT', item.bytes, { 'Content-Type': 'application/json', 'X-Body-SHA256': item.hash })).status).toBe(200);
    for (let index = 0; index < item.chunks.length; index++) {
      const response = await request(`${route}/chunks/${index}`, 'PUT', item.chunks[index], {
        'Content-Type': 'application/octet-stream', 'X-Body-SHA256': cprawHash(item.chunks[index]), 'X-Manifest-SHA256': item.hash,
      });
      expect(response.status).toBe(200);
    }
    const started = performance.now();
    const response = await request(`${route}/commit`, 'POST', undefined, { 'X-Manifest-SHA256': item.hash });
    const result = await response.json();
    const elapsed = Math.round(performance.now() - started);
    expect(response.status).toBe(200);
    expect(result).toMatchObject({ file_bytes: largest.length, chunk_count: 257,
      validation: { status: 'valid', valid_bytes: largest.length, reports: Math.floor((largest.length - 32) / 1705) + 1 } });
    // Wall time is local acceptance only, never a claim about production CPU or heap.
    console.info(JSON.stringify({ cpraw_synthetic_benchmark: { file_bytes: largest.length, chunks: 257, commit_wall_ms: elapsed,
      r2_reads: 257, primary_d1_operations: 6, production_cpu_heap_acceptance: 'pending' } }));
  }, 30_000);
});
