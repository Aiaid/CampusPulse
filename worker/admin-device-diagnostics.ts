import type { Env } from './types';
import { IngestError } from './ingest-validation';
import { json, MAX_INGEST_BYTES, sha256 } from './ingest';

const streams = ['ble_windows', 'address_summaries', 'node_status', 'ble_reports'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const columns = 'node_id,batch_id,receipt_id,body_sha256,boot_id,stream,seq_first,seq_last,accepted_count,placement_id,capture_config_id,dataset,firmware_version,raw_object_key,received_at,expires_at_ms,retain_until_ms';
const batches = `SELECT 'campuspulse/1' AS protocol,${columns} FROM ingestion_batches UNION ALL SELECT 'campuspulse/2' AS protocol,${columns} FROM ingestion_batches_v2`;
interface BatchRow {
  protocol: string; node_id: string; batch_id: string; receipt_id: string; body_sha256: string;
  boot_id: string; stream: string; seq_first: number; seq_last: number; accepted_count: number;
  placement_id: string; capture_config_id: string; dataset: string; firmware_version: string;
  raw_object_key: string | null; received_at: string; expires_at_ms: number; retain_until_ms: number;
}
const invalid = (): never => { throw new IngestError(422, 'invalid_diagnostics_query', 'Invalid batch filter, cursor or page size.'); };
const notFound = (): never => { throw new IngestError(404, 'batch_not_found', 'No receipt for this device and batch.'); };
function publicBatch(row: BatchRow, now: number) {
  const { raw_object_key, ...metadata } = row;
  return { ...metadata, durability: 'committed', source: 'server_receipt',
    payload_retention: row.expires_at_ms <= now ? 'expired' : 'within_retention',
    exact_payload_status: row.expires_at_ms <= now ? 'expired' : raw_object_key ? 'archive_registered' : 'not_archived',
    // Receipt storage has no original byte length. Only a selected R2 object can establish it.
    exact_size_bytes: null };
}
function itemSource(row: BatchRow) {
  return row.protocol === 'campuspulse/2' ? 'ingestion_items_v2' : row.stream === 'ble_windows' ? 'sensor_windows' : row.stream === 'node_status' ? 'node_status' : null;
}
const sensitiveKey = /password|passphrase|passwd|credential|secret|authorization|private_key|^(mqtt|mqtt_username|mqtt_namespace|wifi|eap|device_token|research_token|operator_token|admin_token|access_token|refresh_token|api_key|pin|proof|setup_pin|setup_proof|pairing_code|wifi_ssid|eap_identity|eap_username|anonymous_identity)$/i;
function redact(value: unknown): { value: unknown; changed: boolean } {
  if (!value || typeof value !== 'object') return { value, changed: false };
  let changed = false;
  if (Array.isArray(value)) {
    const output = value.map(item => { const result = redact(item); changed ||= result.changed; return result.value; });
    return { value: output, changed };
  }
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveKey.test(key)) { changed = true; continue; }
    const result = redact(item); changed ||= result.changed; output[key] = result.value;
  }
  return { value: output, changed };
}

/** Called only after requireAdminSession. Never accepts device/research bearer auth. */
export async function handleAdminDeviceDiagnostics(request: Request, env: Env, route: string): Promise<Response | null> {
  const match = /^\/devices\/([a-z0-9_-]{1,64})\/batches(?:\/([0-9a-f-]{36}))?$/.exec(route);
  if (!match) return null;
  if (request.method !== 'GET') throw new IngestError(405, 'method_not_allowed', 'Batch diagnostics are read-only.');
  const [, node, batchId] = match;
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => !['stream', 'before', 'limit'].includes(key)) || [...params.keys()].some(key => params.getAll(key).length !== 1)) invalid();
  if (!await env.DB.prepare('SELECT id FROM device_nodes WHERE id=?').bind(node).first()) throw new IngestError(404, 'device_not_found', 'Unknown device.');
  const now = Date.now();
  if (!batchId) {
    const stream = params.get('stream'), before = params.get('before'), limitText = params.get('limit');
    if (stream !== null && !streams.includes(stream)) invalid();
    if (limitText !== null && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limitText)) invalid();
    const limit = Number(limitText ?? 20);
    let cursor: { received_at: string; batch_id: string } | null = null;
    if (before !== null) {
      try {
        if (before.length > 256 || !/^[A-Za-z0-9_-]+$/.test(before)) invalid();
        cursor = JSON.parse(atob(before.replace(/-/g, '+').replace(/_/g, '/')));
        if (!cursor || Object.keys(cursor).sort().join(',') !== 'batch_id,received_at' || !uuid.test(cursor.batch_id) || typeof cursor.received_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor.received_at) || !Number.isFinite(Date.parse(cursor.received_at))) invalid();
      } catch { invalid(); }
    }
    const rows = await env.DB.prepare(`SELECT * FROM (${batches}) WHERE node_id=? ${stream ? 'AND stream=?' : ''} ${cursor ? 'AND (received_at<? OR (received_at=? AND batch_id<?))' : ''} ORDER BY received_at DESC,batch_id DESC LIMIT ?`)
      .bind(node, ...(stream ? [stream] : []), ...(cursor ? [cursor.received_at, cursor.received_at, cursor.batch_id] : []), limit + 1).all<BatchRow>();
    const selected = rows.results.slice(0, limit);
    const last = selected.at(-1);
    const next = rows.results.length > limit && last ? btoa(JSON.stringify({ received_at: last.received_at, batch_id: last.batch_id })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') : null;
    return json({ batches: selected.map(row => publicBatch(row, now)), next_cursor: next, server_time: new Date(now).toISOString() });
  }
  if (!uuid.test(batchId) || params.size) invalid();
  const row = await env.DB.prepare(`SELECT * FROM (${batches}) WHERE node_id=? AND batch_id=?`).bind(node, batchId).first<BatchRow>();
  if (!row) return notFound();
  const metadata = publicBatch(row, now);
  const table = itemSource(row);
  const records = row.expires_at_ms > now && table ? (await env.DB.prepare(`SELECT seq,utc_ms,item_json FROM ${table} WHERE node_id=? AND batch_id=? AND expires_at_ms>? ORDER BY seq LIMIT 128`).bind(node, batchId, now).all<{ seq: number; utc_ms: number | null; item_json: string }>()).results : [];
  const projection = records.map(record => ({ seq: record.seq, measured_at_ms: record.utc_ms, item: redact(JSON.parse(record.item_json)).value }));
  const exact: { status: string; size_bytes: number | null; sha256_verified: boolean; utf8_text?: string } = {
    status: metadata.exact_payload_status, size_bytes: null, sha256_verified: false,
  };
  // No bucket enumeration and no bulk downloads: one retained object, <= ingestion cap.
  if (row.expires_at_ms > now && row.raw_object_key) {
    if (!env.RAW_BUCKET) exact.status = 'storage_unavailable';
    else {
      const object = await env.RAW_BUCKET.get(row.raw_object_key);
      if (!object) exact.status = 'missing';
      else if (object.size > MAX_INGEST_BYTES) { exact.status = 'size_limit'; await object.body?.cancel(); }
      else {
        const bytes = new Uint8Array(await object.arrayBuffer());
        exact.size_bytes = bytes.byteLength;
        if (bytes.byteLength > MAX_INGEST_BYTES || await sha256(bytes) !== row.body_sha256) exact.status = 'integrity_error';
        else {
          exact.sha256_verified = true;
          try {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            const content: unknown = JSON.parse(text);
            if (redact(content).changed) exact.status = 'sensitive_fields_omitted';
            else { exact.status = 'verified'; exact.utf8_text = text; }
          } catch { exact.status = 'invalid_archive'; }
        }
      }
    }
  }
  return json({ batch: metadata, projection: { source: 'normalized_d1', items: projection,
    status: row.expires_at_ms <= now ? 'expired' : !table ? 'not_stored' : records.length === row.accepted_count ? 'complete' : 'partial_or_missing',
    content: row.stream === 'ble_reports' ? 'sequence_bookkeeping_only' : 'validated_items',
    measured_first_ms: projection.reduce<number | null>((min, r) => r.measured_at_ms === null ? min : min === null ? r.measured_at_ms : Math.min(min, r.measured_at_ms), null),
    measured_last_ms: projection.reduce<number | null>((max, r) => r.measured_at_ms === null ? max : max === null ? r.measured_at_ms : Math.max(max, r.measured_at_ms), null),
  }, exact, server_time: new Date(now).toISOString() });
}
