import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCprawArchive, expireCprawArchives } from '../worker/cpraw-archive';
import { CprawValidator } from '../worker/cpraw-format';
import { parseCprawManifest } from '../worker/cpraw-manifest';
import { DEVICE_TOKEN, setup } from './helpers/ingestion';
import { CPRAW_ID, concatCpraw, cprawFrame, cprawHash, cprawHeader, cprawManifest, cprawReport, maximumCprawFile } from './helpers/cpraw-fixtures';

let state: Awaited<ReturnType<typeof setup>>;
let upload: ReturnType<typeof cprawManifest>;
const base = `/api/v1/cpraw/uploads/${CPRAW_ID}`;
async function request(path: string, init: RequestInit = {}) {
  const response = await handleCprawArchive(new Request(`https://synthetic.test${path}`, {
    ...init, headers: { Authorization: `Bearer ${DEVICE_TOKEN}`, ...init.headers },
  }), state.env);
  expect(response).not.toBeNull();
  expect(response!.headers.get('Cache-Control')).toBe('no-store');
  return response!;
}
const putManifest = (bytes = upload.bytes, headers: Record<string, string> = {}) => request(base, { method: 'PUT', body: bytes,
  headers: { 'Content-Type': 'application/json', 'X-Body-SHA256': cprawHash(bytes), ...headers } });
const putChunk = (index = 0, bytes = upload.chunks[index], headers: Record<string, string> = {}) => request(`${base}/chunks/${index}`,
  { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'X-Body-SHA256': cprawHash(bytes), 'X-Manifest-SHA256': upload.hash, ...headers } });
const commit = () => request(`${base}/commit`, { method: 'POST', headers: { 'X-Manifest-SHA256': upload.hash } });
const research = (suffix = '', authorization = 'Bearer synthetic-research-token') => request(`/api/v1/research/cpraw/${CPRAW_ID}${suffix}?node_id=${state.config.node_id}`,
  { headers: { Authorization: authorization } });
async function uploadAll() {
  expect((await putManifest()).status).toBe(200);
  for (let index = 0; index < upload.chunks.length; index++) expect((await putChunk(index)).status).toBe(200);
  return commit();
}
function expireTime() { vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_001); }
beforeEach(async () => {
  state = await setup(); state.env.CPRAW_ARCHIVE_ENABLED = '1';
  state.db.prepare(`INSERT INTO cpraw_archive_policies
    (id,node_id,cpraw_archive,policy_kind,dataset,purpose,accept_until_ms,raw_retention_hours,max_file_bytes,max_files,max_pending_uploads,max_total_bytes)
    VALUES (?,?,1,'offline_import','controlled_test','synthetic acceptance',?,1,16780672,20,10,335613440)`)
    .run('synthetic-import', state.config.node_id, Date.now() + 86_400_000);
  const originalDelete = state.raw.bucket.delete.bind(state.raw.bucket);
  state.raw.bucket.delete = async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) await originalDelete(key); };
  upload = cprawManifest(concatCpraw(cprawHeader(), cprawReport()));
});
afterEach(() => { vi.restoreAllMocks(); state.db.close(); });

describe('private CPRAW custody', () => {
  it('defaults to disabled and never borrows legacy capture permission', async () => {
    state.env.CPRAW_ARCHIVE_ENABLED = undefined;
    expect((await putManifest()).status).toBe(503);
    state.env.CPRAW_ARCHIVE_ENABLED = '1';
    state.db.exec('DELETE FROM cpraw_archive_policies');
    expect((await putManifest()).status).toBe(403);
    expect(state.raw.objects.size).toBe(0);
  });
  it('preserves exact/concurrent receipts and returns a consistent status without raw keys', async () => {
    const manifests = await Promise.all([putManifest(), putManifest()]);
    expect(manifests.map(response => response.status)).toEqual([200, 200]);
    expect(await manifests[0].json()).toEqual(await manifests[1].json());
    const chunks = await Promise.all([putChunk(), putChunk()]);
    const first = await chunks[0].json();
    expect(await chunks[1].json()).toEqual(first);
    const files = await Promise.all([commit(), commit()]);
    const file = await files[0].json();
    expect(file).toMatchObject({ scope: 'file', durability: 'committed', validation: { status: 'valid', reports: 1 } });
    expect(await files[1].json()).toEqual(file);
    expect(await (await commit()).json()).toEqual(file);
    const status = await (await request(base)).json();
    expect(status).toMatchObject({ chunks: [first], receipt: file, state: 'committed' });
    expect(JSON.stringify(status)).not.toMatch(/raw_object_key|session_hex|cpraw\/[0-9a-f]{64}/);
    expect(state.raw.objects.size).toBe(1);
    expect(state.db.prepare('SELECT COUNT(*) n FROM public_sensor_projection_v2').get()?.n).toBe(0);
    expect(state.db.prepare('SELECT COUNT(*) n FROM public_observation_projection').get()?.n).toBe(0);
  });
  it('rejects identity, bounds, encoding, hash and unexpected query changes', async () => {
    expect((await putManifest(upload.bytes, { 'Content-Encoding': 'identity' })).status).toBe(415);
    expect((await putManifest(upload.bytes, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await putManifest(upload.bytes, { 'X-Body-SHA256': '0'.repeat(64) })).status).toBe(422);
    expect((await putManifest(new Uint8Array(65_537))).status).toBe(413);
    expect((await request(`${base}?unexpected=1`, { method: 'GET' })).status).toBe(422);
    expect((await putManifest()).status).toBe(200);
    expect((await putManifest(new TextEncoder().encode(JSON.stringify(upload.manifest, null, 1)))).status).toBe(409);
    expect((await putChunk(0, upload.chunks[0], { 'X-Manifest-SHA256': '0'.repeat(64) })).status).toBe(409);
    expect((await putChunk(0, upload.chunks[0].slice(1))).status).toBe(422);
    expect((await putChunk(0, concatCpraw(upload.chunks[0], new Uint8Array(1)))).status).toBe(413);
    expect((await putChunk(0, new Uint8Array(upload.chunks[0].length))).status).toBe(409);
    expect((await request(`${base}/chunks/257`, { method: 'PUT' })).status).toBe(422);
    expect((await commit()).status).toBe(409);
    expect((await request(`${base}/commit`, { method: 'POST', body: 'x', headers: { 'X-Manifest-SHA256': upload.hash } })).status).toBe(413);
    expect(state.raw.objects.size).toBe(0);
  });
  it('rejects unknown fields, duplicated keys, unsafe sizes and inconsistent chunk coverage', () => {
    for (const value of [{ ...upload.manifest, dataset: 'field' }, { ...upload.manifest, source: ['usb_export'] }, { ...upload.manifest, file_bytes: Number.MAX_SAFE_INTEGER + 1 },
      { ...upload.manifest, chunks: [{ ...upload.manifest.chunks[0], offset: 1 }] }, { ...upload.manifest, chunks: [] }])
      expect(() => parseCprawManifest(new TextEncoder().encode(JSON.stringify(value)))).toThrow();
    expect(() => parseCprawManifest(new TextEncoder().encode(new TextDecoder().decode(upload.bytes).replace('"protocol":', '"source":"usb_export","protocol":')))).toThrow();
  });
  it('rejects a placement association without explicit provenance', () => {
    expect(() => state.db.prepare(`INSERT INTO cpraw_archive_policies
      (id,node_id,cpraw_archive,policy_kind,dataset,purpose,accept_until_ms,raw_retention_hours,max_file_bytes,max_files,max_pending_uploads,max_total_bytes,placement_id,placement_provenance)
      VALUES ('missing-provenance',?,1,'offline_import','controlled_test','test',?,1,16780672,1,1,16780672,?,NULL)`)
      .run(state.config.node_id, Date.now() + 1000, state.config.placement_id)).toThrow();
  });
  it('binds node and policy, denies wrong auth and research before finalization', async () => {
    for (const token of ['wrong', 'synthetic-research-token', 'synthetic-operator-token'])
      expect((await putManifest(upload.bytes, { Authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await putManifest(upload.bytes, { Origin: 'https://wrong.test' })).status).toBe(403);
    await putManifest();
    expect((await research()).status).toBe(409);
    expect((await research('', `Bearer ${DEVICE_TOKEN}`)).status).toBe(401);
    state.db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES (?,?)').run('another-node', cprawHash('synthetic-other-node-token'));
    expect((await request(base, { headers: { Authorization: 'Bearer synthetic-other-node-token' } })).status).toBe(404);
    expect((await putManifest(upload.bytes, { Authorization: 'Bearer synthetic-other-node-token' })).status).toBe(403);
    state.db.prepare('UPDATE device_nodes SET enabled=0 WHERE id=?').run(state.config.node_id);
    expect((await putChunk()).status).toBe(401);
  });
  it('freezes quota limits atomically, while exact retries remain possible', async () => {
    state.db.exec('DELETE FROM cpraw_archive_policies');
    state.db.prepare(`INSERT INTO cpraw_archive_policies
      (id,node_id,cpraw_archive,policy_kind,dataset,purpose,accept_until_ms,raw_retention_hours,max_file_bytes,max_files,max_pending_uploads,max_total_bytes)
      VALUES (?,?,1,'offline_import','controlled_test','quota test',?,1,16780672,1,1,16780672)`)
      .run('synthetic-import', state.config.node_id, Date.now() + 86_400_000);
    expect((await putManifest()).status).toBe(200);
    const other = cprawManifest(cprawHeader(), '22222222-2222-4222-8222-222222222222');
    const response = await request(`/api/v1/cpraw/uploads/${other.manifest.upload_id}`, { method: 'PUT', body: other.bytes,
      headers: { 'Content-Type': 'application/json', 'X-Body-SHA256': other.hash } });
    expect(response.status).toBe(429); expect(response.headers.get('Retry-After')).toBe('60');
    expect((await putManifest()).status).toBe(200);
  });
  it('never acknowledges R2 or D1 failures and recovers an orphan with exact bytes', async () => {
    await putManifest(); state.raw.failPut = true;
    expect((await putChunk()).status).toBe(503); state.raw.failPut = false;
    state.db.exec("CREATE TRIGGER synthetic_fail BEFORE INSERT ON cpraw_chunks BEGIN SELECT RAISE(ABORT,'private path secret'); END;");
    const response = await putChunk();
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('private path secret');
    expect(state.raw.objects.size).toBe(1);
    expect(await (await request(base)).json()).toMatchObject({ chunks: [] });
    state.db.exec('DROP TRIGGER synthetic_fail');
    expect((await putChunk()).status).toBe(200);
    expect((await commit()).status).toBe(200);
  });
  it('checks existing R2 bytes instead of trusting object existence or size', async () => {
    await putManifest();
    state.db.exec("CREATE TRIGGER synthetic_fail BEFORE INSERT ON cpraw_chunks BEGIN SELECT RAISE(ABORT,'failure'); END;");
    await putChunk(); state.db.exec('DROP TRIGGER synthetic_fail');
    const key = [...state.raw.objects.keys()][0];
    state.raw.objects.set(key, new Uint8Array(upload.chunks[0].length));
    expect((await putChunk()).status).toBe(503);
    expect((await commit()).status).toBe(409);
  });
  it('fails full-file digest without a final receipt and rejects later R2 corruption', async () => {
    upload.manifest.file_sha256 = '0'.repeat(64);
    upload.bytes = new TextEncoder().encode(JSON.stringify(upload.manifest)); upload.hash = cprawHash(upload.bytes);
    expect((await uploadAll()).status).toBe(422);
    expect(state.db.prepare('SELECT final_receipt_json FROM cpraw_uploads').get()?.final_receipt_json).toBeNull();
    state.raw.objects.set([...state.raw.objects.keys()][0], new Uint8Array(upload.chunks[0].length));
    expect((await commit()).status).toBe(503);
  });
  it('archives empty and corrupt originals with invalid validation, preserving bytes', async () => {
    upload = cprawManifest(new Uint8Array());
    const response = await uploadAll();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ validation: { status: 'invalid', reports: null, valid_bytes: 0 }, chunk_count: 0 });
  });
  it('reads retained research bytes safely and denies them immediately after expiry', async () => {
    const file = await (await uploadAll()).json();
    expect(await (await research()).json()).toMatchObject({ receipt: file, policy: { dataset: 'controlled_test', placement_id: null } });
    const binary = await research('/chunks/0');
    expect(binary.headers.get('Content-Disposition')).toContain('attachment');
    expect(new Uint8Array(await binary.arrayBuffer())).toEqual(upload.chunks[0]);
    expireTime();
    expect((await research()).status).toBe(410);
    expect((await research('/chunks/0')).status).toBe(410);
    expect((await putChunk()).status).toBe(410);
    expect(await (await commit()).json()).toMatchObject({ evidence_state: 'expired', receipt: file });
    state.env.CPRAW_ARCHIVE_ENABLED = undefined;
    await expireCprawArchives(state.env);
    expect(state.raw.objects.size).toBe(0);
    expect(state.db.prepare('SELECT private_summary_json FROM cpraw_uploads').get()?.private_summary_json).toBeNull();
    state.env.CPRAW_ARCHIVE_ENABLED = '1';
    expect((await putManifest()).status).toBe(410);
    expect((await putChunk()).status).toBe(410);
    expect(state.raw.objects.size).toBe(0);
  });
  it('cleanup wins against an in-flight PUT and reconciles late R2 bytes on the next pass', async () => {
    await putManifest();
    const originalPut = state.raw.bucket.put.bind(state.raw.bucket);
    state.raw.bucket.put = (async (...args: Parameters<R2Bucket['put']>) => {
      expireTime(); await expireCprawArchives(state.env);
      return originalPut(...args);
    }) as R2Bucket['put'];
    expect((await putChunk()).status).toBe(410);
    expect(state.raw.objects.size).toBe(1);
    expect(state.db.prepare('SELECT COUNT(*) n FROM cpraw_chunks').get()?.n).toBe(0);
    await expireCprawArchives(state.env);
    expect(state.raw.objects.size).toBe(0);
    expect((await commit()).status).toBe(410);
  });
  it('cleanup racing final validation prevents a successful file receipt', async () => {
    await putManifest(); await putChunk();
    const originalGet = state.raw.bucket.get.bind(state.raw.bucket);
    state.raw.bucket.get = (async (...args: Parameters<R2Bucket['get']>) => {
      const result = await originalGet(...args);
      expireTime(); await expireCprawArchives(state.env);
      return result;
    }) as R2Bucket['get'];
    expect((await commit()).status).toBe(410);
    expect(state.db.prepare('SELECT final_receipt_json FROM cpraw_uploads').get()?.final_receipt_json).toBeNull();
  });
});

describe('incremental CPRAW validation', () => {
  function validate(file: Uint8Array, step = 65_536) {
    const parser = new CprawValidator();
    for (let offset = 0; offset < file.length; offset += step) parser.write(file.subarray(offset, offset + step));
    return parser;
  }
  it('handles legacy/extended reports, stats, events and anchors across every framing boundary', () => {
    const anchor = new Uint8Array(21); anchor[20] = 1;
    const file = concatCpraw(cprawHeader(), cprawReport(), cprawReport(1650, true), cprawFrame(2, new Uint8Array(56)), cprawFrame(3, new Uint8Array(16)), cprawFrame(4, anchor));
    for (const step of [1, 3, 31, 32, 100, 65_536]) {
      const parser = validate(file, step);
      expect(parser.finish()).toMatchObject({ status: 'valid', valid_bytes: file.length, reports: 2 });
      expect(parser.privateSummary()).toMatchObject({ anchor_frames: 1, last_anchor: { source: 1 } });
      expect(parser.peakBufferBytes).toBeLessThanOrEqual(step + 1727);
    }
  });
  it('distinguishes partial header, CRC damage, short tail and hidden later frames', () => {
    expect(validate(cprawHeader().slice(1)).finish().status).toBe('invalid');
    const damaged = concatCpraw(cprawHeader(), cprawReport()); damaged[damaged.length - 1] ^= 1;
    expect(validate(damaged).finish()).toMatchObject({ status: 'invalid', reports: null, valid_bytes: 32 });
    const tail = concatCpraw(cprawHeader(), cprawReport().slice(0, -1));
    expect(validate(tail).finish()).toMatchObject({ status: 'interrupted_tail', truncated_offset: 32 });
    const hidden = new Uint8Array(8); new DataView(hidden.buffer).setUint32(0, 1728, true);
    expect(validate(concatCpraw(cprawHeader(), hidden, cprawReport())).finish().status).toBe('invalid');
    expect(validate(concatCpraw(cprawHeader(), cprawFrame(99, new Uint8Array()))).finish().status).toBe('invalid');
  });
  it('keeps maximum-segment parser carry bounded to one frame plus a chunk', () => {
    const file = maximumCprawFile();
    const parser = validate(file);
    expect(parser.finish()).toMatchObject({ status: 'valid', valid_bytes: 16_780_672 });
    expect(parser.peakBufferBytes).toBeLessThanOrEqual(65_536 + 1727);
  });
});
