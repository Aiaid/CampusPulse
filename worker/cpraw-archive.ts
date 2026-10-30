import { createHash } from 'node:crypto';
import type { Env } from './types';
import { authorizeResearch, device, json } from './ingest';
import { IngestError } from './ingest-validation';
import { CprawValidator } from './cpraw-format';
import { CPRAW_CHUNK_BYTES, CPRAW_PROTOCOL, CPRAW_SHA256, CPRAW_UUID, parseCprawManifest, readCprawBody, type CprawChunk, type CprawManifest } from './cpraw-manifest';

// Intentionally use DB directly: without Sessions API every D1 query goes to
// the primary, including lookups after a competing write or cleanup transaction.
// https://developers.cloudflare.com/d1/best-practices/read-replication/
interface Policy {
  id: string; node_id: string; cpraw_archive: number; policy_kind: 'offline_import'; dataset: string;
  purpose: string; accept_until_ms: number; raw_retention_hours: number; max_file_bytes: number;
  max_files: number; max_total_bytes: number; max_pending_uploads: number;
  placement_id: string | null; placement_provenance: string | null;
}
interface Upload {
  node_id: string; upload_id: string; policy_id: string; manifest_json: string; manifest_sha256: string;
  file_sha256: string; file_bytes: number; chunk_count: number; accepted_at_ms: number; expires_at_ms: number;
  retain_until_ms: number; state: 'open' | 'committed' | 'deleting' | 'expired'; final_receipt_json: string | null;
}
interface ChunkRow {
  chunk_index: number; byte_offset: number; byte_count: number; body_sha256: string;
  raw_object_key: string | null; receipt_json: string;
}
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function fail(status: number, code: string, message: string): never { throw new IngestError(status, code, message); }
const retained = (upload: Upload, now = Date.now()) => upload.expires_at_ms > now && !['deleting', 'expired'].includes(upload.state);
const receipt = (upload: Upload): unknown => upload.final_receipt_json ? JSON.parse(upload.final_receipt_json) : null;
const expiredResponse = (upload: Upload, chunkReceipt?: unknown) => json({
  error: { code: 'evidence_expired', message: 'Archive evidence is expired; preserve local copies.', retryable: false },
  evidence_state: 'expired', receipt: chunkReceipt ?? receipt(upload),
}, 410);
const objectKey = (upload: Upload, chunk: CprawChunk) =>
  `cpraw/${hash(upload.node_id)}/${upload.upload_id}/${upload.manifest_sha256}/chunks/${chunk.index}/${chunk.sha256}.bin`;
const manifestOf = (upload: Upload) => parseCprawManifest(new TextEncoder().encode(upload.manifest_json));

async function findUpload(env: Env, node: string, uploadId: string): Promise<Upload | null> {
  return env.DB.prepare('SELECT * FROM cpraw_uploads WHERE node_id=? AND upload_id=?').bind(node, uploadId).first<Upload>();
}
async function needUpload(env: Env, node: string, uploadId: string): Promise<Upload> {
  return await findUpload(env, node, uploadId) ?? fail(404, 'upload_not_found', 'Unknown archive upload.');
}
async function policyFor(env: Env, node: string, policyId: string): Promise<Policy> {
  const policy = await env.DB.prepare('SELECT * FROM cpraw_archive_policies WHERE id=? AND node_id=?').bind(policyId, node).first<Policy>();
  if (!policy || policy.cpraw_archive !== 1 || policy.policy_kind !== 'offline_import')
    return fail(403, 'archive_not_allowed', 'No registered archive import policy.');
  return policy;
}
function acceptPolicy(policy: Policy, now = Date.now()) {
  if (policy.accept_until_ms <= now) fail(410, 'archive_policy_expired', 'Archive import policy has expired; preserve local copies.');
}
function checkManifestHeader(request: Request, upload: Upload) {
  if (request.headers.get('X-Manifest-SHA256') !== upload.manifest_sha256)
    fail(409, 'manifest_conflict', 'Manifest identity does not match the frozen upload.');
}
function contentType(request: Request, expected: string) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== expected)
    fail(415, 'content_type', 'Unsupported request content type.');
}
function checkBodyHash(request: Request, bytes: Uint8Array): string {
  const supplied = request.headers.get('X-Body-SHA256');
  const digest = hash(bytes);
  if (!supplied || !CPRAW_SHA256.test(supplied) || supplied !== digest)
    fail(422, 'body_hash_mismatch', 'Provide the SHA-256 of the exact request bytes.');
  return digest;
}
function frozenManifestResponse(upload: Upload) {
  if (!retained(upload)) return expiredResponse(upload);
  return json({ protocol: CPRAW_PROTOCOL, node_id: upload.node_id, upload_id: upload.upload_id,
    archive_policy_id: upload.policy_id, manifest_sha256: upload.manifest_sha256, scope: 'manifest',
    state: upload.state, receipt: receipt(upload) });
}
async function putManifest(request: Request, env: Env, node: string, uploadId: string): Promise<Response> {
  contentType(request, 'application/json');
  const bytes = await readCprawBody(request, CPRAW_CHUNK_BYTES);
  const digest = checkBodyHash(request, bytes);
  const manifest = parseCprawManifest(bytes);
  if (manifest.upload_id !== uploadId) fail(422, 'upload_id_mismatch', 'Path and manifest identity must match.');
  const previous = await findUpload(env, node, uploadId);
  if (previous) {
    if (previous.manifest_sha256 !== digest) fail(409, 'manifest_conflict', 'Upload identity already has different manifest bytes.');
    return frozenManifestResponse(previous);
  }
  const policy = await policyFor(env, node, manifest.archive_policy_id);
  acceptPolicy(policy);
  if (manifest.file_bytes > policy.max_file_bytes) fail(413, 'file_too_large', 'Archive exceeds the policy file limit.');
  if (!env.RAW_BUCKET) fail(503, 'raw_storage_not_configured', 'Private archive storage is not configured.');
  const now = Date.now(), expires = now + policy.raw_retention_hours * 3_600_000;
  // Quota admission and uniqueness are evaluated together in this INSERT, so
  // concurrent allocations cannot oversubscribe or turn an exact retry into a 429.
  await env.DB.prepare(`INSERT INTO cpraw_uploads
    (node_id,upload_id,policy_id,manifest_json,manifest_sha256,file_sha256,file_bytes,chunk_count,
      accepted_at_ms,expires_at_ms,retain_until_ms,state)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,'open' FROM cpraw_archive_policies p
    WHERE p.id=? AND p.node_id=? AND p.cpraw_archive=1 AND p.accept_until_ms>?
      AND NOT EXISTS (SELECT 1 FROM cpraw_uploads WHERE node_id=? AND upload_id=?)
      AND EXISTS (SELECT 1 FROM device_nodes n WHERE n.id=p.node_id AND n.enabled=1)
      AND (SELECT COUNT(*) FROM cpraw_uploads u WHERE u.policy_id=p.id AND u.node_id=p.node_id)<p.max_files
      AND (SELECT COALESCE(SUM(file_bytes),0) FROM cpraw_uploads u WHERE u.policy_id=p.id AND u.node_id=p.node_id)+?<=p.max_total_bytes
      AND (SELECT COUNT(*) FROM cpraw_uploads u WHERE u.policy_id=p.id AND u.node_id=p.node_id AND u.state='open' AND u.expires_at_ms>?)<p.max_pending_uploads
    ON CONFLICT(node_id,upload_id) DO NOTHING`)
    .bind(node, uploadId, policy.id, new TextDecoder().decode(bytes), digest, manifest.file_sha256,
      manifest.file_bytes, manifest.chunks.length, now, expires, Math.max(expires, policy.accept_until_ms + 7 * 86_400_000),
      policy.id, node, now, node, uploadId, manifest.file_bytes, now).run();
  const winner = await findUpload(env, node, uploadId);
  if (!winner) {
    acceptPolicy(policy);
    fail(429, 'archive_quota', 'Archive allocation quota reached.');
  }
  if (winner.manifest_sha256 !== digest) fail(409, 'manifest_conflict', 'Upload identity already has different manifest bytes.');
  return frozenManifestResponse(winner);
}
async function chunkRows(env: Env, upload: Upload): Promise<ChunkRow[]> {
  return (await env.DB.prepare(`SELECT chunk_index,byte_offset,byte_count,body_sha256,raw_object_key,receipt_json
    FROM cpraw_chunks WHERE node_id=? AND upload_id=? ORDER BY chunk_index`)
    .bind(upload.node_id, upload.upload_id).all<ChunkRow>()).results;
}
async function findChunk(env: Env, upload: Upload, index: number): Promise<ChunkRow | null> {
  return env.DB.prepare('SELECT * FROM cpraw_chunks WHERE node_id=? AND upload_id=? AND chunk_index=?')
    .bind(upload.node_id, upload.upload_id, index).first<ChunkRow>();
}
function checkChunk(chunk: CprawChunk, stored: ChunkRow) {
  if (stored.chunk_index !== chunk.index || stored.byte_offset !== chunk.offset ||
      stored.byte_count !== chunk.bytes || stored.body_sha256 !== chunk.sha256)
    fail(409, 'chunk_conflict', 'Chunk identity already has different content.');
}
async function readObject(env: Env, key: string, chunk: CprawChunk): Promise<Uint8Array<ArrayBuffer>> {
  if (!env.RAW_BUCKET) return fail(503, 'raw_storage_not_configured', 'Private archive storage is not configured.');
  const object = await env.RAW_BUCKET.get(key);
  if (!object || object.size !== chunk.bytes || object.size > CPRAW_CHUNK_BYTES)
    return fail(503, 'archive_integrity_error', 'Stored archive evidence could not be verified.');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== chunk.bytes || hash(bytes) !== chunk.sha256)
    return fail(503, 'archive_integrity_error', 'Stored archive evidence could not be verified.');
  return bytes;
}
async function putChunk(request: Request, env: Env, upload: Upload, index: number): Promise<Response> {
  checkManifestHeader(request, upload);
  contentType(request, 'application/octet-stream');
  const chunk = manifestOf(upload).chunks[index];
  if (!chunk) fail(422, 'invalid_chunk_index', 'Chunk index is outside the frozen manifest.');
  const bytes = await readCprawBody(request, chunk.bytes);
  const digest = checkBodyHash(request, bytes);
  if (bytes.length !== chunk.bytes) fail(422, 'chunk_length_mismatch', 'Chunk length does not match the manifest.');
  if (digest !== chunk.sha256) fail(409, 'chunk_conflict', 'Chunk content does not match the frozen manifest.');
  const previous = await findChunk(env, upload, index);
  if (previous) {
    checkChunk(chunk, previous);
    return retained(upload) ? json(JSON.parse(previous.receipt_json)) : expiredResponse(upload, JSON.parse(previous.receipt_json));
  }
  if (!retained(upload)) return expiredResponse(upload);
  if (upload.state !== 'open') fail(409, 'upload_closed', 'Archive upload is closed.');
  const policy = await policyFor(env, upload.node_id, upload.policy_id);
  acceptPolicy(policy);
  if (!env.RAW_BUCKET) return fail(503, 'raw_storage_not_configured', 'Private archive storage is not configured.');
  const key = objectKey(upload, chunk);
  const object = await env.RAW_BUCKET.put(key, bytes, { onlyIf: { etagDoesNotMatch: '*' }, sha256: chunk.sha256,
    httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'no-store' } });
  if (!object) await readObject(env, key, chunk);
  const now = Date.now();
  const chunkReceipt = { protocol: CPRAW_PROTOCOL, node_id: upload.node_id, upload_id: upload.upload_id,
    manifest_sha256: upload.manifest_sha256, index, offset: chunk.offset, bytes: chunk.bytes,
    sha256: chunk.sha256, receipt_id: crypto.randomUUID(), received_at: new Date(now).toISOString(),
    scope: 'chunk', durability: 'committed' };
  // R2 success alone is never an ACK. Conditional INSERT prevents late writes
  // from acquiring custody after cleanup wins or either deadline closes.
  await env.DB.prepare(`INSERT INTO cpraw_chunks
    (node_id,upload_id,chunk_index,byte_offset,byte_count,body_sha256,raw_object_key,committed_at_ms,receipt_json)
    SELECT ?,?,?,?,?,?,?,?,? FROM cpraw_uploads u JOIN cpraw_archive_policies p ON p.id=u.policy_id
    WHERE u.node_id=? AND u.upload_id=? AND u.manifest_sha256=? AND u.state='open'
      AND u.expires_at_ms>? AND p.accept_until_ms>? AND p.cpraw_archive=1
      AND EXISTS (SELECT 1 FROM device_nodes n WHERE n.id=u.node_id AND n.enabled=1)
      AND NOT EXISTS (SELECT 1 FROM cpraw_chunks c WHERE c.node_id=u.node_id AND c.upload_id=u.upload_id AND c.chunk_index=?)
    ON CONFLICT(node_id,upload_id,chunk_index) DO NOTHING`)
    .bind(upload.node_id, upload.upload_id, index, chunk.offset, chunk.bytes, chunk.sha256, key, now,
      JSON.stringify(chunkReceipt), upload.node_id, upload.upload_id, upload.manifest_sha256, now, now, index).run();
  const current = await needUpload(env, upload.node_id, upload.upload_id);
  const winner = await findChunk(env, upload, index);
  if (!retained(current)) return expiredResponse(current, winner ? JSON.parse(winner.receipt_json) : null);
  if (winner) { checkChunk(chunk, winner); return json(JSON.parse(winner.receipt_json)); }
  acceptPolicy(policy);
  return fail(503, 'chunk_not_committed', 'Archive chunk custody could not be confirmed.');
}
async function commitFile(request: Request, env: Env, upload: Upload): Promise<Response> {
  checkManifestHeader(request, upload);
  await readCprawBody(request, 0);
  if (!retained(upload)) return expiredResponse(upload);
  if (upload.final_receipt_json) return json(receipt(upload));
  if (upload.state !== 'open') fail(409, 'upload_closed', 'Archive upload is closed.');
  const policy = await policyFor(env, upload.node_id, upload.policy_id);
  acceptPolicy(policy);
  const manifest = manifestOf(upload), chunks = await chunkRows(env, upload);
  if (chunks.length !== manifest.chunks.length) fail(409, 'chunks_missing', 'Archive chunks are incomplete.');
  const digest = createHash('sha256'), parser = new CprawValidator();
  let total = 0;
  for (const chunk of manifest.chunks) {
    const stored = chunks[chunk.index]; checkChunk(chunk, stored);
    const key = objectKey(upload, chunk);
    if (stored.raw_object_key !== key) fail(503, 'archive_integrity_error', 'Stored archive evidence could not be verified.');
    const bytes = await readObject(env, key, chunk);
    digest.update(bytes); parser.write(bytes); total += bytes.length;
  }
  if (total !== manifest.file_bytes || digest.digest('hex') !== manifest.file_sha256)
    fail(422, 'file_hash_mismatch', 'Complete archive digest does not match the frozen manifest.');
  const now = Date.now();
  const finalReceipt = { protocol: CPRAW_PROTOCOL, node_id: upload.node_id, upload_id: upload.upload_id,
    archive_policy_id: upload.policy_id, manifest_sha256: upload.manifest_sha256,
    file_sha256: manifest.file_sha256, file_bytes: total, chunk_count: chunks.length,
    scope: 'file', durability: 'committed', receipt_id: crypto.randomUUID(), received_at: new Date(now).toISOString(),
    expires_at: new Date(upload.expires_at_ms).toISOString(), validation: parser.finish() };
  // One atomic UPDATE freezes validation and receipt together. Cleanup must
  // first change state; a concurrent finalizer never replaces a winning receipt.
  await env.DB.prepare(`UPDATE cpraw_uploads SET state='committed',final_receipt_json=?,private_summary_json=?
    WHERE node_id=? AND upload_id=? AND manifest_sha256=? AND state='open' AND expires_at_ms>?
      AND EXISTS (SELECT 1 FROM cpraw_archive_policies p WHERE p.id=policy_id AND p.cpraw_archive=1 AND p.accept_until_ms>?)
      AND EXISTS (SELECT 1 FROM device_nodes n WHERE n.id=node_id AND n.enabled=1)
      AND (SELECT COUNT(*) FROM cpraw_chunks c WHERE c.node_id=cpraw_uploads.node_id AND c.upload_id=cpraw_uploads.upload_id AND c.raw_object_key IS NOT NULL)=chunk_count`)
    .bind(JSON.stringify(finalReceipt), JSON.stringify(parser.privateSummary()), upload.node_id, upload.upload_id, upload.manifest_sha256, now, now).run();
  const winner = await needUpload(env, upload.node_id, upload.upload_id);
  if (!retained(winner)) return expiredResponse(winner);
  if (winner.final_receipt_json) return json(receipt(winner));
  acceptPolicy(policy);
  return fail(503, 'file_not_committed', 'Archive file custody could not be confirmed.');
}
async function status(env: Env, upload: Upload): Promise<Response> {
  if (!retained(upload)) return expiredResponse(upload);
  const current = await env.DB.prepare(`SELECT u.*,
    (SELECT json_group_array(json(receipt_json)) FROM (SELECT receipt_json FROM cpraw_chunks c
      WHERE c.node_id=u.node_id AND c.upload_id=u.upload_id ORDER BY chunk_index)) AS chunks_json
    FROM cpraw_uploads u WHERE node_id=? AND upload_id=?`).bind(upload.node_id, upload.upload_id)
    .first<Upload & { chunks_json: string }>();
  if (!current) fail(503, 'storage_unavailable', 'Archive custody could not be confirmed.');
  if (!retained(current)) return expiredResponse(current);
  return json({ protocol: CPRAW_PROTOCOL, node_id: upload.node_id, upload_id: upload.upload_id,
    archive_policy_id: upload.policy_id, manifest_sha256: upload.manifest_sha256, state: current.state,
    chunks: JSON.parse(current.chunks_json), receipt: receipt(current) });
}
async function researchRead(env: Env, upload: Upload, index?: number): Promise<Response> {
  if (!retained(upload)) return expiredResponse(upload);
  if (upload.state !== 'committed' || !upload.final_receipt_json) fail(409, 'archive_uncommitted', 'Archive file custody is not committed.');
  if (index === undefined) {
    const policy = await policyFor(env, upload.node_id, upload.policy_id);
    return json({ receipt: receipt(upload), policy: { dataset: policy.dataset, purpose: policy.purpose,
      policy_kind: policy.policy_kind, placement_id: policy.placement_id, placement_provenance: policy.placement_provenance } });
  }
  const chunk = manifestOf(upload).chunks[index];
  if (!chunk) fail(422, 'invalid_chunk_index', 'Chunk index is outside the frozen manifest.');
  const stored = await findChunk(env, upload, index);
  if (!stored || stored.raw_object_key !== objectKey(upload, chunk)) fail(503, 'archive_integrity_error', 'Stored archive evidence could not be verified.');
  checkChunk(chunk, stored);
  const bytes = await readObject(env, stored.raw_object_key!, chunk);
  // Check again after storage I/O so cleanup cannot authorize a stale read.
  const current = await needUpload(env, upload.node_id, upload.upload_id);
  if (!retained(current)) return expiredResponse(current);
  return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="archive-chunk.bin"', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Body-SHA256': chunk.sha256, 'Content-Length': String(bytes.length) } });
}

export async function handleCprawArchive(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/v1/cpraw/') && !url.pathname.startsWith('/api/v1/research/cpraw/')) return null;
  try {
    // No deployment config enables this gate. Activation requires platform
    // acceptance, a private bucket and explicit operator-provisioned policies.
    if (env.CPRAW_ARCHIVE_ENABLED !== '1') fail(503, 'archive_disabled', 'Archive ingestion is not enabled.');
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      fail(403, 'https_required', 'Archive access requires HTTPS.');
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) fail(403, 'origin_rejected', 'Cross-origin requests are not accepted.');
    if (request.headers.has('Content-Encoding')) fail(415, 'content_encoding', 'Encoded requests are not supported.');
    const route = /^\/api\/v1\/(cpraw\/uploads|research\/cpraw)\/([^/]+)(?:\/(commit|chunks\/([^/]+)))?$/.exec(url.pathname);
    if (!route) fail(404, 'not_found', 'Unknown archive route.');
    const research = route[1] === 'research/cpraw', uploadId = route[2], action = route[3];
    if (!CPRAW_UUID.test(uploadId)) fail(422, 'invalid_upload_id', 'Invalid archive upload identity.');
    if (research ? [...url.searchParams.keys()].some(key => key !== 'node_id') || url.searchParams.getAll('node_id').length !== 1 : url.search !== '')
      fail(422, 'invalid_query', 'Unexpected archive query parameters.');
    const index = route[4] === undefined ? undefined : Number(route[4]);
    if (route[4] !== undefined && (!/^(0|[1-9]\d{0,2})$/.test(route[4]) || index! > 256))
      fail(422, 'invalid_chunk_index', 'Invalid archive chunk index.');
    let node: string;
    if (research) {
      await authorizeResearch(request, env);
      node = url.searchParams.get('node_id') ?? '';
      if (!/^[a-z0-9_-]{1,64}$/.test(node)) fail(422, 'invalid_node_id', 'Provide a registered node identity.');
      if (request.method !== 'GET' || action === 'commit') fail(405, 'method_not_allowed', 'Unsupported archive method.');
      await readCprawBody(request, 0);
      return await researchRead(env, await needUpload(env, node, uploadId), index);
    }
    node = await device(request, env);
    if (!action && request.method === 'PUT') return await putManifest(request, env, node, uploadId);
    const upload = await needUpload(env, node, uploadId);
    if (!action && request.method === 'GET') { await readCprawBody(request, 0); return await status(env, upload); }
    if (index !== undefined && request.method === 'PUT') return await putChunk(request, env, upload, index);
    if (action === 'commit' && request.method === 'POST') return await commitFile(request, env, upload);
    return fail(405, 'method_not_allowed', 'Unsupported archive method.');
  } catch (error) {
    const response = error instanceof IngestError
      ? json({ error: { code: error.code, message: error.message, retryable: error.status >= 500 || error.status === 429 } }, error.status)
      : json({ error: { code: 'storage_unavailable', message: 'Archive custody could not be confirmed.', retryable: true } }, 503);
    if (response.status === 429) response.headers.set('Retry-After', '60');
    return response;
  }
}

/** Bounded retained-evidence cleanup; no list-based orphan scavenger or tombstone deletion. */
export async function expireCprawArchives(env: Env, now = Date.now()): Promise<number> {
  // Disabling new API access must never suspend already-promised retention.
  if (!env.RAW_BUCKET) return 0;
  if (!await env.DB.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='cpraw_uploads'").first()) return 0;
  const expired = (await env.DB.prepare(`SELECT * FROM cpraw_uploads WHERE expires_at_ms<=?
    ORDER BY last_cleanup_at_ms,expires_at_ms LIMIT 8`).bind(now).all<Upload>()).results;
  for (const upload of expired) {
    await env.DB.prepare(`UPDATE cpraw_uploads SET state='deleting' WHERE node_id=? AND upload_id=?
      AND expires_at_ms<=? AND state IN ('open','committed')`).bind(upload.node_id, upload.upload_id, now).run();
    const current = await needUpload(env, upload.node_id, upload.upload_id);
    if (retained(current, now)) continue;
    // Include every declared key, not only committed chunks: a PUT may succeed
    // after the first deletion. Expired tombstones are reconciled on later runs.
    const chunks = manifestOf(current).chunks;
    for (let index = 0; index < chunks.length; index += 128)
      await env.RAW_BUCKET.delete(chunks.slice(index, index + 128).map(chunk => objectKey(current, chunk)));
    await env.DB.batch([
      env.DB.prepare('UPDATE cpraw_chunks SET raw_object_key=NULL WHERE node_id=? AND upload_id=?').bind(upload.node_id, upload.upload_id),
      env.DB.prepare(`UPDATE cpraw_uploads SET state='expired',last_cleanup_at_ms=?,private_summary_json=NULL WHERE node_id=? AND upload_id=?
        AND state IN ('deleting','expired')`).bind(now, upload.node_id, upload.upload_id),
    ]);
  }
  return expired.length;
}
