/** Opt-in private custody only. No public projection, inference, raw or MQTT. */
import { device, json, readBytes, sha256 } from './http';
import { IngestError, parseIngestJson } from './strict-json';
import { findV3NamespaceConflict } from './device-v3-namespace';
import { supportsV3StatisticsPolicy } from './device-v3-statistics-policy';
import { capabilityDigestV3, DeviceV3ConfigError, negotiateDeviceConfigV3, validateDeviceCapabilitiesV3, validateFrozenDeviceConfigV3,
  type DeviceConfigV3, type FrozenDeviceConfigV3, type DeviceCapabilitiesV3 } from './device-v3-config';
import { DeviceV3EvidenceError } from './device-v3-evidence';
import { assertV3IngestPolicy, canonicalV3Evidence, ingestTimeV3, rejectV3, supportsV3IngestPolicy, validateV3Envelope,
  validateV3Feature, validateV3Status, v3IngestEnabled, V3_LOSSES,
  type DeviceV3IngestEnv, type V3Envelope, type V3FeatureItem, type V3IngestPolicy, type V3StatusItem } from './device-v3-ingest-validation';
export { assertV3IngestPolicy, supportsV3IngestPolicy, v3IngestEnabled } from './device-v3-ingest-validation';
export type { DeviceV3IngestEnv } from './device-v3-ingest-validation';

const NOW = "(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
const DAY = 86400000, WEEK = 7 * DAY;
const encoder = new TextEncoder();
interface Control { boot_id: string; state_version: number }
interface StoredPolicy {
  node_id: string; generation: number; policy_id: string; revision: number; boot_id: string; capability_sha256: string;
  policy_sha256: string; envelope_json: string; placement_id: string | null; not_before_ms: number; expires_at_ms: number;
  capability_json: string; capability_issued: number; capability_expires: number;
  acknowledgement_json: string | null; ack_state: string | null; ack_received: string | null;
}
interface Applied {
  frozen: FrozenDeviceConfigV3; caps: DeviceCapabilitiesV3; at: number; deadline: number;
  closed_window_seq: number; closed_segment_seq: number;
}
interface ReceiptRow { body_sha256: string; receipt_json: string; retain_until_ms: number }
export interface V3IngestReceipt {
  protocol: 'campuspulse/3'; schema: 'device-ingest-receipt/3'; node_id: string; boot_id: string;
  stream: V3Envelope['stream']; batch_id: string; body_sha256: string; policy_id: string; policy_sha256: string;
  assignment_generation: number; seq_first: number; seq_last: number; accepted_count: number;
  receipt_id: string; received_at: string; expires_at: string; retain_until: string;
  durability: 'committed'; custody: 'private_source'; inference: 'not_performed'; window_completeness: 'not_established';
}
async function databaseNow(env: DeviceV3IngestEnv) {
  const row = await env.DB.prepare(`SELECT ${NOW} AS now`).first<{ now: number }>();
  if (!row || !Number.isSafeInteger(row.now)) rejectV3(503, 'storage_unavailable');
  return row.now;
}
async function authorized(env: DeviceV3IngestEnv, node: string, hash: string) {
  if (!await env.DB.prepare('SELECT 1 FROM device_nodes WHERE id=? AND credential_sha256=? AND enabled=1').bind(node, hash).first()) rejectV3(401, 'unauthorized');
}
async function receipt(env: DeviceV3IngestEnv, node: string, batch: string) {
  return env.DB.prepare('SELECT body_sha256,receipt_json,retain_until_ms FROM ingestion_batches_v3 WHERE node_id=? AND batch_id=?').bind(node, batch).first<ReceiptRow>();
}
function replay(row: ReceiptRow, hash: string, now: number): V3IngestReceipt {
  if (row.body_sha256 !== hash) rejectV3(409, 'v3_batch_conflict');
  if (row.retain_until_ms <= now) rejectV3(410, 'v3_receipt_expired');
  try { return JSON.parse(row.receipt_json) as V3IngestReceipt; }
  catch { return rejectV3(503, 'v3_registry_invalid'); }
}
function timestamp(s: string) {
  const n = Date.parse(s);
  if (!Number.isSafeInteger(n) || new Date(n).toISOString() !== s) throw new Error('Invalid registry time');
  return n;
}
function namespaceSeq(item: unknown): number {
  if (!item || typeof item !== 'object' || !('seq' in item) || typeof item.seq !== 'number' ||
      !Number.isSafeInteger(item.seq) || item.seq < 1 || item.seq > 0xffffffff) return rejectV3(422, 'invalid_v3_ingest');
  return item.seq;
}
/** Immutable history is bounded by the control migration. Read it once and bind
 * current state_version at commit so a new applied policy cannot race the quota. */
async function appliedHistory(env: DeviceV3IngestEnv, node: string): Promise<Applied[]> {
  const rows = await env.DB.prepare(`SELECT a.*,c.capability_json,c.issued_at_ms AS capability_issued,c.expires_at_ms AS capability_expires,
    k.acknowledgement_json,k.state AS ack_state,k.received_at AS ack_received
    FROM device_assignments_v3 a JOIN device_capabilities_v3 c ON c.node_id=a.node_id AND c.capability_sha256=a.capability_sha256
    JOIN device_acknowledgements_v3 k ON k.node_id=a.node_id AND k.generation=a.generation
    WHERE a.node_id=? AND k.state='applied' ORDER BY a.generation LIMIT 4097`).bind(node).all<StoredPolicy>();
  if (rows.results.length > 4096) rejectV3(503, 'v3_registry_invalid');
  const history: Applied[] = [];
  try {
    for (const row of rows.results) {
      const frozen = await validateFrozenDeviceConfigV3(JSON.parse(row.envelope_json)), p = frozen.policy;
      const caps = validateDeviceCapabilitiesV3(JSON.parse(row.capability_json));
      const ack = JSON.parse(row.acknowledgement_json!) as Record<string, unknown>, at = timestamp(row.ack_received!);
      if (p.node_id !== node || p.assignment_generation !== row.generation || p.policy_id !== row.policy_id || p.revision !== row.revision ||
        frozen.policy_sha256 !== row.policy_sha256 || p.control.capability_sha256 !== row.capability_sha256 ||
        p.control.activation.boot_id !== row.boot_id || p.custody.placement_id !== row.placement_id ||
        timestamp(p.control.activation.not_before) !== row.not_before_ms || timestamp(p.control.activation.expires_at) !== row.expires_at_ms ||
        caps.node_id !== node || caps.boot_id !== row.boot_id || await capabilityDigestV3(caps) !== row.capability_sha256 ||
        timestamp(caps.issued_at) !== row.capability_issued || timestamp(caps.expires_at) !== row.capability_expires ||
        ack.node_id !== node || ack.protocol !== 'campuspulse/3' || ack.state !== 'applied' || ack.boot_id !== row.boot_id ||
        ack.policy_id !== p.policy_id || ack.policy_sha256 !== frozen.policy_sha256 || ack.assignment_generation !== row.generation ||
        ack.window_open !== false || ack.segment_open !== false ||
        !Number.isSafeInteger(ack.closed_window_seq) || !Number.isSafeInteger(ack.closed_segment_seq)) throw new Error('Registry mismatch');
      const closed_window_seq = ack.closed_window_seq as number, closed_segment_seq = ack.closed_segment_seq as number;
      const negotiated = await negotiateDeviceConfigV3(frozen, caps, { node_id: node, boot_id: row.boot_id, now: new Date(at).toISOString(),
        last_assignment_generation: row.generation - 1, closed_window_seq, closed_segment_seq, window_open: false, segment_open: false });
      if (negotiated.state !== 'compatible' || p.uplink.enabled && !supportsV3IngestPolicy(p) && !supportsV3StatisticsPolicy(p)) throw new Error('Unsupported registry');
      history.push({ frozen, caps, at, deadline: Math.min(row.expires_at_ms, timestamp(p.custody.accept_until), row.capability_expires,
        at + p.control.lease.duration_ms), closed_window_seq, closed_segment_seq });
    }
  } catch { rejectV3(503, 'v3_registry_invalid'); }
  return history;
}
interface Prepared {
  items: (V3FeatureItem | V3StatusItem)[]; low: number; high: number; expiry: number;
  window?: { seq: number; signature: string; examined: number; available: number; worker: number; unknown: number; bytes: number; seen: number | null };
}
async function prepareItems(batch: V3Envelope, active: Applied, policy: V3IngestPolicy, next: Applied | undefined): Promise<Prepared> {
  const items: (V3FeatureItem | V3StatusItem)[] = batch.stream === 'feature_summaries' ? batch.items.map(validateV3Feature) : batch.items.map(validateV3Status);
  for (let i = 1; i < items.length; i++) if (items[i].seq <= items[i - 1].seq) rejectV3(422, 'invalid_v3_ingest');
  let low: number, high: number, window: Prepared['window'];
  if (batch.stream === 'feature_summaries') {
    const features = items as V3FeatureItem[], first = features[0].evidence;
    const signature = (r: typeof first) => canonicalV3Evidence({ scope: r.scope, observed_time: r.observed_time, population: r.population,
      sampling: r.sampling, extractor_version: r.extractor_version, window_counters: {
        window_reports_seen: r.source_counters.window_reports_seen, window_reports_aggregated: r.source_counters.window_reports_aggregated,
        window_queue_drops: r.source_counters.window_queue_drops, window_address_overflow: r.source_counters.window_address_overflow } });
    const common = signature(first), start = ingestTimeV3(first.observed_time.start), end = ingestTimeV3(first.observed_time.end);
    low = start.utc_ms - start.uncertainty_ms; high = end.utc_ms + end.uncertainty_ms;
    if (end.mono_ms - start.mono_ms !== policy.collection.summary.window_ms ||
      Math.abs(end.utc_ms - start.utc_ms - policy.collection.summary.window_ms) > start.uncertainty_ms + end.uncertainty_ms) rejectV3(422, 'v3_observed_time');
    const seenIdentities = new Set<string>();
    window = { seq: first.scope.window_seq, signature: await sha256(encoder.encode(common)), examined: 0, available: 0, worker: 0, unknown: 0, bytes: 0,
      seen: first.source_counters.window_reports_seen.value };
    for (const item of features) {
      const r = item.evidence, s = r.scope;
      if (signature(r) !== common || s.node_id !== batch.node_id || s.boot_id !== batch.boot_id || s.policy_sha256 !== batch.policy_sha256 ||
        s.capture_config_id !== batch.policy_id || s.placement_id !== batch.placement_id || s.dataset !== batch.dataset ||
        s.window_seq <= Math.max(policy.control.activation.after_window_seq, active.closed_window_seq) ||
        next && s.window_seq > next.closed_window_seq || r.extractor_version !== policy.evidence.extractor_version || r.population !== policy.evidence.population ||
        r.sampling && (r.sampling.every_n !== policy.evidence.sample_every_n || r.sampling.max_reports_per_window !== policy.evidence.max_reports_per_window)) rejectV3(409, 'v3_window_conflict');
      for (const [kind, list] of Object.entries(r.features)) {
        const field = policy.evidence.fields.find(f => f.kind === kind);
        if (!field || list.values !== null && list.values.length > field.max_values_per_identifier) rejectV3(422, 'v3_feature_policy');
      }
      if (r.extraction_state === 'complete' && policy.evidence.fields.some(f => r.features[f.kind] === undefined)) rejectV3(422, 'v3_feature_policy');
      const key = r.identity.token + '/' + r.identity.address_type;
      if (seenIdentities.has(key)) rejectV3(409, 'v3_window_conflict');
      seenIdentities.add(key);
      window.examined += r.reports.examined_reports; window.available += r.reports.available_reports;
      if (r.source_counters.identifier_worker_reports.value === null) window.unknown++;
      else window.worker += r.source_counters.identifier_worker_reports.value;
      window.bytes += encoder.encode(canonicalV3Evidence(r)).byteLength;
    }
  } else {
    const item = items[0] as V3StatusItem;
    if (item.queue.feature_summaries.pending_items + item.queue.node_status.pending_items > policy.local_queue.max_items - policy.local_queue.control_reserve_items ||
      item.queue.feature_summaries.pending_bytes + item.queue.node_status.pending_bytes > policy.local_queue.max_bytes - policy.local_queue.control_reserve_bytes) rejectV3(422, 'v3_queue_claim');
    low = item.time.utc_ms - item.time.uncertainty_ms; high = item.time.utc_ms + item.time.uncertainty_ms;
  }
  if (low < Math.max(active.at, timestamp(policy.control.activation.not_before), timestamp(active.caps.issued_at)) || high >= active.deadline || next && high >= next.at) rejectV3(422, 'v3_observed_time');
  return { items, low, high, expiry: low + policy.custody.source_retention_hours * 3600000, window };
}

export async function handleDeviceV3Ingest(request: Request, env: DeviceV3IngestEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/v3/ingest') return null;
  try {
    if (!v3IngestEnabled(env)) rejectV3(503, 'v3_ingest_disabled');
    if (url.protocol !== 'https:') rejectV3(403, 'v3_https_required');
    if (request.method !== 'POST') rejectV3(405, 'method_not_allowed');
    if (url.search) rejectV3(422, 'invalid_v3_ingest');
    const node = await device(request, env), credential = await sha256(encoder.encode(request.headers.get('Authorization')!.slice(7)));
    const bytes = await readBytes(request), hash = await sha256(bytes);
    if (request.headers.get('X-Body-SHA256') !== hash) rejectV3(400, 'body_hash_mismatch');
    const batch = validateV3Envelope(parseIngestJson(bytes));
    if (batch.node_id !== node) rejectV3(403, 'node_not_allowed');
    const prior = await receipt(env, node, batch.batch_id);
    if (prior) { await authorized(env, node, credential); return json(replay(prior, hash, await databaseNow(env))); }
    const namespaceConflict = await findV3NamespaceConflict(env.DB, node, batch.batch_id, batch.boot_id,
      batch.stream, namespaceSeq(batch.items[0]), namespaceSeq(batch.items[batch.items.length - 1]));
    if (namespaceConflict) rejectV3(409, namespaceConflict === 'batch_conflict' ? 'v3_batch_conflict' : 'v3_evidence_conflict');
    const control = await env.DB.prepare('SELECT boot_id,state_version FROM device_control_v3 WHERE node_id=?').bind(node).first<Control>();
    if (!control || control.boot_id !== batch.boot_id) rejectV3(409, 'v3_current_boot_required');
    const history = await appliedHistory(env, node), active = history.find(h => h.frozen.policy.assignment_generation === batch.assignment_generation);
    if (!active) rejectV3(409, 'v3_applied_policy_required');
    const p = active.frozen.policy;
    assertV3IngestPolicy(p, env, active.caps.producer_version);
    if (p.node_id !== node || p.policy_id !== batch.policy_id || active.frozen.policy_sha256 !== batch.policy_sha256 ||
      p.control.activation.boot_id !== batch.boot_id || p.custody.placement_id !== batch.placement_id || p.custody.dataset !== batch.dataset ||
      active.caps.producer_version !== batch.producer_version) rejectV3(403, 'v3_policy_mismatch');
    if (bytes.byteLength > p.uplink.max_body_bytes) rejectV3(413, 'payload_too_large');
    if (batch.items.length > p.uplink.max_batch_items) rejectV3(422, 'v3_item_limit');
    const next = history.find(h => h.frozen.policy.control.activation.boot_id === batch.boot_id && h.frozen.policy.assignment_generation > batch.assignment_generation);
    const prepared = await prepareItems(batch, active, p, next), now = await databaseNow(env);
    if (now >= active.deadline || prepared.expiry <= now) rejectV3(410, 'v3_ingest_expired');
    if (prepared.high > now) rejectV3(422, 'v3_observed_time');
    const validPlacement = () => env.DB.prepare(`SELECT 1 FROM placements p LEFT JOIN placement_closures c ON c.placement_id=p.id AND c.node_id=p.node_id
      WHERE p.id=? AND p.node_id=? AND p.valid_from_ms<=? AND COALESCE(c.valid_until_ms,p.valid_until_ms,9223372036854775807)>?`)
      .bind(batch.placement_id, node, prepared.low, prepared.high).first();
    if (!await validPlacement()) rejectV3(409, 'v3_placement_interval');
    const day = Math.floor(now / DAY) * DAY, retain = Math.max(prepared.expiry, timestamp(p.custody.accept_until) + WEEK);
    const quota = Math.min(...history.filter(h => h.frozen.policy.uplink.enabled && h.at < day + DAY && h.deadline > day)
      .map(h => h.frozen.policy.custody.max_upload_bytes_per_day));
    if (!Number.isSafeInteger(quota)) rejectV3(503, 'v3_registry_invalid');
    const ack: V3IngestReceipt = { protocol: 'campuspulse/3', schema: 'device-ingest-receipt/3', node_id: node, boot_id: batch.boot_id,
      stream: batch.stream, batch_id: batch.batch_id, body_sha256: hash, policy_id: batch.policy_id, policy_sha256: batch.policy_sha256,
      assignment_generation: batch.assignment_generation, seq_first: prepared.items[0].seq, seq_last: prepared.items[prepared.items.length - 1].seq,
      accepted_count: prepared.items.length, receipt_id: crypto.randomUUID(), received_at: new Date(now).toISOString(), expires_at: new Date(prepared.expiry).toISOString(),
      retain_until: new Date(retain).toISOString(), durability: 'committed', custody: 'private_source', inference: 'not_performed', window_completeness: 'not_established' };
    const ids: string[] = [], writes: D1PreparedStatement[] = [];
    const assertions: { sql: string; bindings: (string | number | null)[] }[] = [];
    const guard = (sql: string, bindings: (string | number | null)[]) => {
      assertions.push({ sql, bindings });
      const id = crypto.randomUUID(); ids.push(id);
      writes.push(env.DB.prepare(`INSERT INTO admin_write_assertions(id,ok) SELECT ?,CASE WHEN (${sql}) THEN 1 ELSE 0 END`).bind(id, ...bindings));
    };
    guard('EXISTS(SELECT 1 FROM device_nodes WHERE id=? AND credential_sha256=? AND enabled=1)', [node, credential]);
    guard('EXISTS(SELECT 1 FROM device_control_v3 WHERE node_id=? AND boot_id=? AND state_version=?)', [node, batch.boot_id, control.state_version]);
    guard(`${NOW}<? AND ${NOW}<? AND ${NOW}>=? AND ${NOW}<? AND ?<=${NOW}`,
      [active.deadline, prepared.expiry, day, day + DAY, prepared.high]);
    guard(`EXISTS(SELECT 1 FROM placements p LEFT JOIN placement_closures c ON c.placement_id=p.id AND c.node_id=p.node_id
      WHERE p.id=? AND p.node_id=? AND p.valid_from_ms<=? AND COALESCE(c.valid_until_ms,p.valid_until_ms,9223372036854775807)>?)`,
      [batch.placement_id, node, prepared.low, prepared.high]);
    writes.push(env.DB.prepare(`INSERT INTO ingestion_batches_v3(node_id,batch_id,boot_id,stream,generation,policy_sha256,body_sha256,seq_first,seq_last,receipt_json,expires_at_ms,retain_until_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(node, batch.batch_id, batch.boot_id, batch.stream, batch.assignment_generation, batch.policy_sha256, hash,
        ack.seq_first, ack.seq_last, JSON.stringify(ack), prepared.expiry, retain));
    if (prepared.window) {
      const w = prepared.window;
      guard(`NOT EXISTS(SELECT 1 FROM ingestion_windows_v3 WHERE node_id=? AND boot_id=? AND window_seq=?) OR
        EXISTS(SELECT 1 FROM ingestion_windows_v3 WHERE node_id=? AND boot_id=? AND window_seq=? AND signature_sha256=? AND expires_at_ms=? AND expires_at_ms>${NOW})`,
        [node, batch.boot_id, w.seq, node, batch.boot_id, w.seq, w.signature, prepared.expiry]);
      writes.push(env.DB.prepare(`INSERT INTO ingestion_windows_v3(node_id,boot_id,window_seq,signature_sha256,accepted_count,examined_reports,available_reports,worker_reports,unknown_worker_counts,evidence_bytes,seen_reports,max_identifiers,max_reports,max_bytes,expires_at_ms,retain_until_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(node_id,boot_id,window_seq) DO UPDATE SET
        accepted_count=accepted_count+excluded.accepted_count,examined_reports=examined_reports+excluded.examined_reports,
        available_reports=available_reports+excluded.available_reports,worker_reports=worker_reports+excluded.worker_reports,
        unknown_worker_counts=unknown_worker_counts+excluded.unknown_worker_counts,evidence_bytes=evidence_bytes+excluded.evidence_bytes`)
        .bind(node, batch.boot_id, w.seq, w.signature, prepared.items.length, w.examined, w.available, w.worker, w.unknown, w.bytes, w.seen,
          p.collection.summary.max_addresses, p.evidence.max_reports_per_window, p.evidence.max_bytes_per_window, prepared.expiry, retain));
    } else {
      const s = prepared.items[0] as V3StatusItem;
      writes.push(env.DB.prepare(`INSERT INTO ingestion_status_order_v3(node_id,boot_id,seq,uptime_ms,clock_epoch,feature_items_dropped,feature_bytes_dropped,status_samples_coalesced,upload_failures,ack_failures,retain_until_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(node, batch.boot_id, s.seq, s.uptime_ms, s.time.clock_epoch, ...V3_LOSSES.map(k => s.losses[k]), retain));
    }
    for (const item of prepared.items) {
      const e = 'evidence' in item ? item.evidence : null;
      writes.push(env.DB.prepare(`INSERT INTO ingestion_items_v3(node_id,boot_id,stream,seq,batch_id,window_seq,token,address_type,item_json,expires_at_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(node, batch.boot_id, batch.stream, item.seq, batch.batch_id, e?.scope.window_seq ?? null,
          e?.identity.token ?? null, e?.identity.address_type ?? null, JSON.stringify(item), prepared.expiry));
    }
    writes.push(env.DB.prepare(`INSERT INTO ingestion_quota_v3(node_id,day_start_ms,used_bytes,limit_bytes,retain_until_ms) VALUES(?,?,?,?,?)
      ON CONFLICT(node_id,day_start_ms) DO UPDATE SET used_bytes=used_bytes+excluded.used_bytes,limit_bytes=MIN(limit_bytes,excluded.limit_bytes)`)
      .bind(node, day, bytes.byteLength, quota, day + DAY + WEEK));
    // A slow item/trigger write can cross a lease, retention or UTC-day cutoff.
    // The final statements recheck authoritative state and clock before commit.
    for (const a of [...assertions]) guard(a.sql, a.bindings);
    writes.push(...ids.map(id => env.DB.prepare('DELETE FROM admin_write_assertions WHERE id=?').bind(id)));
    try { await env.DB.batch(writes); }
    catch (error) {
      await authorized(env, node, credential);
      const winner = await receipt(env, node, batch.batch_id);
      if (winner) return json(replay(winner, hash, await databaseNow(env)));
      const currentTime = await databaseNow(env);
      if (currentTime >= active.deadline || currentTime >= prepared.expiry) rejectV3(410, 'v3_ingest_expired');
      if (!await validPlacement()) rejectV3(409, 'v3_placement_interval');
      let message = '';
      for (let e: unknown = error, n = 0; e instanceof Error && n < 5; e = e.cause, n++) message += e.message;
      if (/used_bytes\s*<=\s*limit_bytes/.test(message)) rejectV3(429, 'v3_quota_exhausted');
      if (/v3_namespace_conflict|v3_statistics_namespace_conflict|v3_status_order|UNIQUE constraint failed: ingestion_|CHECK constraint failed: (accepted_count|examined_reports|2\+evidence_bytes|seen_reports)/.test(message)) rejectV3(409, 'v3_evidence_conflict');
      if (prepared.window) {
        const w = await env.DB.prepare('SELECT signature_sha256,expires_at_ms FROM ingestion_windows_v3 WHERE node_id=? AND boot_id=? AND window_seq=?')
          .bind(node, batch.boot_id, prepared.window.seq).first<{ signature_sha256: string; expires_at_ms: number }>();
        if (w && (w.signature_sha256 !== prepared.window.signature || w.expires_at_ms <= currentTime)) rejectV3(409, 'v3_window_conflict');
      }
      rejectV3(503, 'storage_unavailable');
    }
    return json(ack);
  } catch (error) {
    if (error instanceof DeviceV3EvidenceError || error instanceof DeviceV3ConfigError) return json({ error: { code: 'invalid_v3_ingest', message: 'Invalid v3 evidence or policy.', retryable: false } }, 422);
    if (error instanceof IngestError) return json({ error: { code: error.code, message: error.message, retryable: error.status >= 500 || error.status === 429 } }, error.status);
    return json({ error: { code: 'storage_unavailable', message: 'Service temporarily unavailable.', retryable: true } }, 503);
  }
}

/** Cleanup is deliberately independent of enablement and old v1/v2/R2 cleanup.
 * Expiry is live-row enforcement, not a claim that provider backups are erased. */
export async function expireDeviceV3Ingest(env: DeviceV3IngestEnv, now = Date.now()) {
  // Code may be deployed before the additive migration. Missing schema is the
  // only condition skipped; operational errors must still reach the scheduler.
  if (!await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ingestion_batches_v3'").first()) return { schema_available: false, deleted_private_rows: 0, rounds: 0, expired_backlog: false, oldest_expired_age_ms: null };
  let deleted = 0, rounds = 0;
  for (; rounds < 4;) {
    const result = await env.DB.prepare(`DELETE FROM ingestion_items_v3 WHERE rowid IN (SELECT rowid FROM ingestion_items_v3
      WHERE expires_at_ms<=? LIMIT 5000)`).bind(now).run();
    rounds++; deleted += result.meta.changes;
    if (result.meta.changes < 5000) break;
  }
  const backlog = await env.DB.prepare('SELECT expires_at_ms FROM ingestion_items_v3 WHERE expires_at_ms<=? ORDER BY expires_at_ms LIMIT 1')
    .bind(now).first<{ expires_at_ms: number }>();
  const result = { schema_available: true, deleted_private_rows: deleted, rounds, expired_backlog: backlog !== null,
    oldest_expired_age_ms: backlog ? Math.max(0, now - backlog.expires_at_ms) : null };
  if (backlog) console.warn(JSON.stringify({ event: 'v3_private_retention_backlog', ...result }));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM ingestion_windows_v3 WHERE rowid IN (SELECT rowid FROM ingestion_windows_v3 WHERE retain_until_ms<=? LIMIT 500)').bind(now),
    env.DB.prepare('DELETE FROM ingestion_status_order_v3 WHERE rowid IN (SELECT rowid FROM ingestion_status_order_v3 WHERE retain_until_ms<=? LIMIT 500)').bind(now),
    env.DB.prepare('DELETE FROM ingestion_quota_v3 WHERE rowid IN (SELECT rowid FROM ingestion_quota_v3 WHERE retain_until_ms<=? LIMIT 500)').bind(now),
    env.DB.prepare(`DELETE FROM ingestion_batches_v3 WHERE rowid IN (SELECT b.rowid FROM ingestion_batches_v3 b
      WHERE b.retain_until_ms<=? AND NOT EXISTS(SELECT 1 FROM ingestion_items_v3 i WHERE i.node_id=b.node_id AND i.batch_id=b.batch_id) LIMIT 100)`).bind(now),
  ]);
  return result;
}
