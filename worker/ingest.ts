import type { Env } from './types';
import { IngestError, parseIngestJson, validateEnvelope, validateCaptureConfig, validateConfigBatch, type CaptureConfig } from './ingest-validation';
import { commitBatch, findReceipt, ackFromReceipt, IngestStoreError } from './ingest-store';
import { parseAdvertisement } from './ble-ad';

export const MAX_INGEST_BYTES = 65536;
export const json = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
export async function readBytes(request: Request, limit = MAX_INGEST_BYTES): Promise<Uint8Array<ArrayBuffer>> {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
    throw new IngestError(415, 'content_type', 'Use application/json.');
  if (request.headers.has('Content-Encoding')) throw new IngestError(415, 'content_encoding', 'Compressed requests are not supported.');
  const reader = request.body?.getReader();
  if (!reader) throw new IngestError(400, 'invalid_json', 'A JSON body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new IngestError(413, 'payload_too_large', 'Request exceeds the byte limit.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
function sameOrigin(request: Request) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) throw new IngestError(403, 'origin_rejected', 'Cross-origin requests are not accepted.');
}
export async function device(request: Request, env: Env): Promise<string> {
  sameOrigin(request);
  const authorization = request.headers.get('Authorization') ?? '';
  if (!/^Bearer [!-~]{16,256}$/.test(authorization)) throw new IngestError(401, 'unauthorized', 'Device credential required.');
  const hash = await sha256(new TextEncoder().encode(authorization.slice(7)));
  const row = await env.DB.prepare('SELECT id FROM device_nodes WHERE credential_sha256 = ? AND enabled = 1').bind(hash).first<{ id: string }>();
  if (!row) throw new IngestError(401, 'unauthorized', 'Device credential required.');
  return row.id;
}
interface ConfigRow { config_json: string; accept_until_ms: number; placement_id: string; raw_retention_hours: number; aggregate_retention_days: number }
async function configFor(env: Env, node: string, id?: string): Promise<{ config: CaptureConfig; row: ConfigRow }> {
  // Explicit IDs belong to frozen queued uploads. Only an unqualified fetch
  // follows the desired pointer; pre-administration nodes keep legacy lookup.
  const row = await env.DB.prepare(`SELECT c.config_json,c.accept_until_ms,c.placement_id,c.raw_retention_hours,c.aggregate_retention_days
    FROM capture_configs c LEFT JOIN device_desired_configs d ON d.node_id = c.node_id
    WHERE c.node_id = ? ${id ? 'AND c.id = ?' : 'AND (d.node_id IS NULL OR c.id = d.capture_config_id)'}
    ORDER BY c.accept_until_ms DESC,c.id DESC LIMIT 1`)
    .bind(...(id ? [node, id] : [node])).first<ConfigRow>();
  if (!row) throw new IngestError(403, 'capture_config_not_allowed', 'No registered capture policy.');
  // Stored policy is server-owned but still validated, so an invalid registry
  // entry fails closed rather than quietly expanding permissions.
  let config: CaptureConfig;
  try { config = validateCaptureConfig(JSON.parse(row.config_json)); }
  catch { throw new IngestError(503, 'capture_config_invalid', 'Registered capture policy is invalid.'); }
  return { config, row };
}
export async function archive(env: Env, node: string, batch: string, hash: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (!env.RAW_BUCKET) throw new IngestError(503, 'raw_storage_not_configured', 'Private raw storage is not configured.');
  const key = `ingest/${node}/${batch}/${hash}.json`;
  const object = await env.RAW_BUCKET.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: '*' }, sha256: hash,
    httpMetadata: { contentType: 'application/json' },
  });
  if (!object) {
    const existing = await env.RAW_BUCKET.get(key);
    if (!existing || existing.size !== bytes.byteLength || existing.size > MAX_INGEST_BYTES || await sha256(new Uint8Array(await existing.arrayBuffer())) !== hash)
      throw new IngestError(503, 'raw_integrity_error', 'Stored evidence could not be verified.');
  }
  return key;
}
export async function authorizeResearch(request: Request, env: Env) {
  sameOrigin(request);
  if (!env.RESEARCH_TOKEN) throw new IngestError(503, 'research_not_configured', 'Research access is not configured.');
  const [actual, expected] = await Promise.all([
    sha256(new TextEncoder().encode(request.headers.get('Authorization') ?? '')),
    sha256(new TextEncoder().encode(`Bearer ${env.RESEARCH_TOKEN}`)),
  ]);
  let mismatch = 0;
  for (let i = 0; i < actual.length; i++) mismatch |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  if (mismatch) throw new IngestError(401, 'unauthorized', 'Research credential required.');
}
export async function handleIngestion(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const research = /^\/api\/v1\/research\/batches\/([0-9a-f-]{36})$/i.exec(url.pathname);
  const recognized = ['/api/v1/ingest', '/api/v1/device/config', '/api/v1/device/config/ack'].includes(url.pathname) || research;
  if (!recognized) return null;
  try {
    if (url.pathname === '/api/v1/ingest') {
      if (request.method !== 'POST') return json({ error: { code: 'method_not_allowed', message: 'Use POST.', retryable: false } }, 405);
      const node = await device(request, env);
      const bytes = await readBytes(request);
      const hash = await sha256(bytes);
      const suppliedHash = request.headers.get('X-Body-SHA256');
      if (!suppliedHash || !/^[0-9a-f]{64}$/.test(suppliedHash) || suppliedHash !== hash)
        throw new IngestError(400, 'body_hash_mismatch', 'Provide the SHA-256 of the exact request bytes.');
      const batch = validateEnvelope(parseIngestJson(bytes));
      if (batch.node_id !== node) throw new IngestError(403, 'node_not_allowed', 'Credential does not permit this node.');
      // A durable retry survives policy expiry and record retention. It never
      // recreates cleaned evidence or changes the original acknowledgement.
      const receipt = await findReceipt(env.DB, node, batch.batch_id);
      if (receipt) {
        if (receipt.body_sha256 !== hash) throw new IngestError(409, 'batch_conflict', 'Batch ID already has different bytes.');
        return json(ackFromReceipt(receipt));
      }
      const { config, row } = await configFor(env, node, batch.capture_config_id);
      if (bytes.byteLength > config.upload_policy.max_body_bytes) throw new IngestError(413, 'payload_too_large', 'Request exceeds the configured byte limit.');
      validateConfigBatch(batch, config);
      if (Date.now() > row.accept_until_ms) throw new IngestError(410, 'capture_config_expired', 'Capture policy has expired; preserve pending data.');
      const key = batch.stream === 'ble_reports' ? await archive(env, node, batch.batch_id, hash, bytes) : null;
      const result = await commitBatch(env.DB, batch, hash, key, Date.now());
      return json(result.ack);
    }
    if (url.pathname === '/api/v1/device/config') {
      if (request.method !== 'GET') return json({ error: { code: 'method_not_allowed', message: 'Use GET.', retryable: false } }, 405);
      const node = await device(request, env);
      const requested = url.searchParams.get('capture_config_id');
      if (requested !== null && !/^[a-z0-9_-]{1,64}$/.test(requested)) throw new IngestError(422, 'invalid_config_id', 'Invalid capture configuration ID.');
      const { config, row } = await configFor(env, node, requested ?? undefined);
      return json({ protocol: 'campuspulse/1', config, server_limits: { max_items: 128, max_body_bytes: MAX_INGEST_BYTES },
        expired: Date.now() > row.accept_until_ms, server_time: new Date().toISOString(),
        retention: { raw_hours: row.raw_retention_hours, aggregate_days: row.aggregate_retention_days, receipt_min_days_after_accept_until: 7 } });
    }
    if (url.pathname === '/api/v1/device/config/ack') {
      if (request.method !== 'POST') return json({ error: { code: 'method_not_allowed', message: 'Use POST.', retryable: false } }, 405);
      const node = await device(request, env);
      const value = parseIngestJson(await readBytes(request, 4096));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IngestError(422, 'invalid_config_ack', 'Provide a configuration activation acknowledgement.');
      const o = value as Record<string, unknown>;
      if (Object.keys(o).some(key => !['capture_config_id', 'state', 'message'].includes(key)) ||
          typeof o.capture_config_id !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(o.capture_config_id) ||
          typeof o.state !== 'string' || !['applied', 'failed'].includes(o.state) ||
          o.message !== undefined && (typeof o.message !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,79}$/.test(o.message)))
        throw new IngestError(422, 'invalid_config_ack', 'Use a known configuration ID, applied/failed state and an optional bounded machine label.');
      const assignment = await env.DB.prepare('SELECT assigned_at FROM config_assignments WHERE node_id = ? AND capture_config_id = ?')
        .bind(node, o.capture_config_id).first();
      if (!assignment) throw new IngestError(403, 'config_not_assigned', 'Acknowledge only a configuration assigned to this device.');
      const receivedAt = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO config_activation(node_id,capture_config_id,state,message,received_at) VALUES (?,?,?,?,?)
          ON CONFLICT(node_id,capture_config_id) DO UPDATE SET state=excluded.state,message=excluded.message,received_at=excluded.received_at
          WHERE excluded.received_at >= config_activation.received_at`).bind(node, o.capture_config_id, o.state, o.message ?? null, receivedAt),
        env.DB.prepare('INSERT INTO config_activation_events(node_id,capture_config_id,state,message,received_at) VALUES (?,?,?,?,?)')
          .bind(node, o.capture_config_id, o.state, o.message ?? null, receivedAt),
      ]);
      return json({ node_id: node, capture_config_id: o.capture_config_id, state: o.state, received_at: receivedAt });
    }
    if (research) {
      if (request.method !== 'GET') return json({ error: { code: 'method_not_allowed', message: 'Use GET.', retryable: false } }, 405);
      await authorizeResearch(request, env);
      const node = url.searchParams.get('node_id');
      if (!node || !/^[a-z0-9_-]{1,64}$/.test(node)) throw new IngestError(422, 'node_id_required', 'Provide the batch node_id.');
      const row = await env.DB.prepare("SELECT body_sha256,raw_object_key,expires_at_ms FROM ingestion_batches WHERE node_id = ? AND batch_id = ? AND stream = 'ble_reports'")
        .bind(node, research[1]).first<{ body_sha256: string; raw_object_key: string | null; expires_at_ms: number }>();
      if (!row) throw new IngestError(404, 'batch_not_found', 'Unknown raw batch.');
      if (row.expires_at_ms <= Date.now() || !row.raw_object_key) throw new IngestError(410, 'raw_expired', 'Raw evidence retention has expired.');
      if (!env.RAW_BUCKET) throw new IngestError(503, 'raw_storage_not_configured', 'Private raw storage is not configured.');
      const object = await env.RAW_BUCKET.get(row.raw_object_key);
      if (!object || object.size > MAX_INGEST_BYTES) throw new IngestError(503, 'raw_integrity_error', 'Stored evidence could not be verified.');
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (await sha256(bytes) !== row.body_sha256) throw new IngestError(503, 'raw_integrity_error', 'Stored evidence could not be verified.');
      const batch = validateEnvelope(parseIngestJson(bytes));
      if (batch.stream !== 'ble_reports') throw new Error('Invalid stored stream');
      return json({ batch, body_sha256: row.body_sha256, derived: batch.items.map(item => ({ seq: item.seq, ...parseAdvertisement(item.payload_hex) })) });
    }
    return null;
  } catch (error) {
    if (error instanceof IngestError || error instanceof IngestStoreError) return json({ error: { code: error.code, message: error.message, retryable: error.status >= 500 } }, error.status);
    return json({ error: { code: 'storage_unavailable', message: 'Service temporarily unavailable.', retryable: true } }, 503);
  }
}
