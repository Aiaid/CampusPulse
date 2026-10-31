/** Compact source custody; no identifiers, raw objects, inference or public writes. */
import { device, json, readBytes, sha256 } from './ingest';
import { IngestError } from './ingest-validation';
import { DeviceV3ConfigError } from './device-v3-config';
import type { AuthAssertion } from './admin-auth';
import { assertV3StatisticsPolicy, loadStatisticsAuthority, statisticsCaptureAssertion, STATISTICS_NOW_SQL as NOW,
  v3StatisticsEnabled, type DeviceV3StatisticsEnv, type V3StatisticsPolicy, type StatisticsAuthority } from './device-v3-statistics-policy';
import { assertStatisticsV3EventRevision, normalizeStatisticsV3Batch, parseStatisticsV3Json, validateStatisticsV3Envelope,
  STATISTICS_V3_STATUS_LOSSES, STATISTICS_V3_RAW_COUNTERS, type StatisticsV3Batch, type StatisticsV3Event, type StatisticsV3Limits, type StatisticsV3Time,
  type StatisticsV3Stream } from './device-v3-statistics-validation';
export { v3StatisticsEnabled } from './device-v3-statistics-policy';
export type { DeviceV3StatisticsEnv } from './device-v3-statistics-policy';

const DAY = 86400000, WEEK = 7 * DAY;
const encoder = new TextEncoder();
const reject = (status: number, code: string): never => { throw new IngestError(status, code, 'Statistics request cannot be accepted; preserve the exact frozen batch.'); };
export interface StatisticsV3Receipt {
  protocol: 'campuspulse/3'; schema: 'device-statistics-receipt/3'; node_id: string; boot_id: string;
  stream: StatisticsV3Stream; batch_id: string; body_sha256: string; policy_id: string; policy_sha256: string;
  assignment_generation: number; seq_first: number; seq_last: number; accepted_count: number;
  receipt_id: string; received_at: string; expires_at: string; retain_until: string;
  durability: 'committed'; custody: 'small_statistics';
}
interface ReceiptRow { body_sha256: string; receipt_json: string; expires_at_ms: number }
interface EventRow { revision: number; item_json: string | null; item_sha256: string; expires_at_ms: number; received_at_ms: number }
async function nowMs(env: DeviceV3StatisticsEnv) {
  const row = await env.DB.prepare(`SELECT ${NOW} AS now`).first<{ now: number }>();
  return row && Number.isSafeInteger(row.now) ? row.now : reject(503, 'storage_unavailable');
}
const auth = (node: string, hash: string): AuthAssertion => ({ sql: 'EXISTS(SELECT 1 FROM device_nodes WHERE id=? AND credential_sha256=? AND enabled=1)', bindings: [node, hash] });
async function check(env: DeviceV3StatisticsEnv, a: AuthAssertion) {
  const row = await env.DB.prepare(`SELECT CASE WHEN (${a.sql}) THEN 1 ELSE 0 END AS ok`).bind(...a.bindings).first<{ ok: number }>();
  return row?.ok === 1;
}
async function receipt(env: DeviceV3StatisticsEnv, node: string, batch: string) {
  return env.DB.prepare('SELECT body_sha256,receipt_json,expires_at_ms FROM statistics_batches_v3 WHERE node_id=? AND batch_id=?')
    .bind(node, batch).first<ReceiptRow>();
}
function replay(row: ReceiptRow, hash: string, now: number): Response {
  if (row.body_sha256 !== hash) reject(409, 'v3_statistics_batch_conflict');
  let value: StatisticsV3Receipt;
  try { value = JSON.parse(row.receipt_json) as StatisticsV3Receipt; } catch { return reject(503, 'v3_registry_invalid'); }
  return row.expires_at_ms <= now
    ? json({ error: { code: 'v3_statistics_source_expired', message: 'The committed source has expired; it will not be restored.', retryable: false }, evidence_state: 'expired', receipt: value }, 410)
    : json(value);
}
export function statisticsLimits(p: V3StatisticsPolicy): StatisticsV3Limits {
  return { ...p.collection.summary, extractor_version: p.evidence.extractor_version, ruleset_version: p.evidence.ruleset_version,
    max_batch_items: p.uplink.max_batch_items, max_body_bytes: p.uplink.max_body_bytes,
    streams: p.uplink.streams.filter((s): s is StatisticsV3Stream => ['window_statistics', 'candidate_events', 'node_status'].includes(s)),
    queue: p.local_queue, local_raw_mode: p.local_raw.mode, ...(p.temporal.mode === 'rolling' ? { temporal: p.temporal } : {}) };
}
/** Initial custody subset requires known, conservatively bounded observation UTC. */
function bounds(time: StatisticsV3Time, duration = 0) {
  if (time.utc_ms === null || time.uncertainty_ms === null || time.uncertainty_ms > 5000) return reject(422, 'v3_statistics_time_unprovable');
  const low = time.utc_ms - time.uncertainty_ms - duration, high = time.utc_ms + time.uncertainty_ms;
  if (!Number.isSafeInteger(low) || low < 0 || !Number.isSafeInteger(high)) reject(422, 'v3_statistics_time_unprovable');
  return { low, high, observedEnd: time.utc_ms - time.uncertainty_ms };
}
interface ItemBounds { low: number; high: number; observedEnd: number; health?: boolean; logicalEnd?: ReturnType<typeof bounds> }
/** Health and logical censor markers carry no authority to collect observations. */
function healthAssertion(authority: StatisticsAuthority, low: number, high: number): AuthAssertion {
  const { identity: i, policy: p, capabilities: c } = authority;
  return { sql: `EXISTS(SELECT 1 FROM device_statistics_authorizations_v3 a
    JOIN device_acknowledgements_v3 k ON k.node_id=a.node_id AND k.generation=a.generation AND k.boot_id=a.boot_id AND k.state='applied'
    WHERE a.node_id=? AND a.generation=? AND a.boot_id=? AND a.policy_sha256=? AND a.accept_until_ms>${NOW}
    AND ?>=? AND ?>=? AND ?>=? AND ?<=a.accept_until_ms AND ?<=${NOW})`,
    bindings: [i.node_id, i.assignment_generation, i.boot_id, i.policy_sha256, low, authority.applied_at_ms,
      low, Date.parse(p.control.activation.not_before), low, Date.parse(c.issued_at), high, high] };
}
function itemBounds(batch: StatisticsV3Batch): ItemBounds[] {
  if (batch.stream === 'window_statistics') return batch.items.map(i => bounds(i.time, i.duration_ms));
  if (batch.stream === 'node_status') return batch.items.map(i => ({ ...bounds(i.time), health: i.collection_state !== 'running' }));
  return batch.items.map(i => {
    const start = bounds(i.start), last = bounds(i.last_seen), observed = bounds(i.observed_until), end = bounds(i.end ?? i.observed_until);
    // An event must preserve a single monotonic-to-UTC clock mapping throughout.
    for (const t of [i.last_seen, i.observed_until, ...(i.end ? [i.end] : [])]) {
      if (Math.abs(t.utc_ms! - i.start.utc_ms! - (t.mono_ms - i.start.mono_ms)) > t.uncertainty_ms! + i.start.uncertainty_ms!) reject(422, 'v3_statistics_time_unprovable');
    }
    // observed_until includes real scanned absences after last_seen. Validation
    // bounds all coverage/slice totals by this prefix; closed end equals it.
    // A later censor marker cannot create capture authority or extend retention.
    return { low: Math.min(start.low, last.low, observed.low), high: Math.max(start.high, last.high, observed.high),
      observedEnd: observed.observedEnd, ...(i.state === 'censored' ? { logicalEnd: end } : {}) };
  });
}
async function eventWrites(env: DeviceV3StatisticsEnv, batch: Extract<StatisticsV3Batch, { stream: 'candidate_events' }>,
  limits: StatisticsV3Limits, expiry: number, retain: number, writes: D1PreparedStatement[], assert: (a: AuthAssertion) => void) {
  const seen = new Map<string, StatisticsV3Event>();
  for (const item of batch.items) {
    const key = [batch.node_id, batch.boot_id, batch.assignment_generation, item.event_id];
    const row = seen.has(item.event_id) ? null : await env.DB.prepare(`SELECT revision,item_json,item_sha256,expires_at_ms,received_at_ms FROM statistics_events_v3
      WHERE node_id=? AND boot_id=? AND generation=? AND event_id=?`).bind(...key).first<EventRow>();
    const previous = seen.get(item.event_id) ?? (row?.item_json ? JSON.parse(row.item_json) as StatisticsV3Event : null);
    if (row && (!row.item_json || row.expires_at_ms <= await nowMs(env))) reject(409, 'v3_statistics_event_expired');
    try { assertStatisticsV3EventRevision(previous, item, limits); } catch { reject(409, 'v3_statistics_event_conflict'); }
    const itemJson = JSON.stringify(item), hash = await sha256(encoder.encode(itemJson));
    if (previous && item.state === 'open') {
      if (seen.has(item.event_id) || row && await nowMs(env) - row.received_at_ms < (limits.temporal?.min_update_ms ?? 0)) reject(429, 'v3_statistics_event_rate');
      assert({ sql: `EXISTS(SELECT 1 FROM statistics_events_v3 WHERE node_id=? AND boot_id=? AND generation=? AND event_id=? AND received_at_ms+?<=${NOW})`,
        bindings: [...key, limits.temporal?.min_update_ms ?? 0] });
    }
    if (previous) assert({ sql: `EXISTS(SELECT 1 FROM statistics_events_v3 WHERE node_id=? AND boot_id=? AND generation=? AND event_id=? AND revision=? AND item_sha256=? AND item_json IS NOT NULL AND expires_at_ms>${NOW})`,
      bindings: [...key, previous.revision, row?.item_sha256 ?? await sha256(encoder.encode(JSON.stringify(previous)))] });
    else assert({ sql: 'NOT EXISTS(SELECT 1 FROM statistics_events_v3 WHERE node_id=? AND boot_id=? AND generation=? AND event_id=?)', bindings: key });
    writes.push(env.DB.prepare(`INSERT INTO statistics_events_v3(node_id,boot_id,generation,event_id,revision,seq,state,item_json,item_sha256,received_at_ms,expires_at_ms,retain_until_ms)
      VALUES(?,?,?,?,?,?,?,?,?,${NOW},?,?) ON CONFLICT(node_id,boot_id,generation,event_id) DO UPDATE SET
      revision=excluded.revision,seq=excluded.seq,state=excluded.state,item_json=excluded.item_json,item_sha256=excluded.item_sha256,
      received_at_ms=excluded.received_at_ms,expires_at_ms=excluded.expires_at_ms,retain_until_ms=MAX(retain_until_ms,excluded.retain_until_ms)`)
      .bind(...key, item.revision, item.seq, item.state, itemJson, hash, expiry, retain));
    seen.set(item.event_id, item);
  }
}

export async function handleDeviceV3Statistics(request: Request, env: DeviceV3StatisticsEnv): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/api/v3/statistics/ingest') return null;
  try {
    // Preserve public gate/method ordering before authenticating the bearer.
    if (!v3StatisticsEnabled(env)) reject(503, 'v3_statistics_disabled');
    if (new URL(request.url).protocol !== 'https:') reject(403, 'v3_https_required');
    if (request.method !== 'POST') reject(405, 'method_not_allowed');
    if (new URL(request.url).search) reject(422, 'invalid_v3_statistics');
    const node = await device(request, env), credential = await sha256(encoder.encode(request.headers.get('Authorization')!.slice(7)));
    return await handleAuthenticatedDeviceV3Statistics(request, env, node, auth(node, credential));
  } catch (error) { return statisticsError(error); }
}

/** Service-binding callers authenticate their principal outside public headers.
 * The mandatory assertion is checked again inside every final commit/replay. */
export async function handleAuthenticatedDeviceV3Statistics(request: Request, env: DeviceV3StatisticsEnv,
  node: string, authorization: AuthAssertion): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname !== '/api/v3/statistics/ingest') reject(404, 'not_found');
    if (!v3StatisticsEnabled(env)) reject(503, 'v3_statistics_disabled');
    if (url.protocol !== 'https:') reject(403, 'v3_https_required');
    if (request.method !== 'POST') reject(405, 'method_not_allowed');
    if (url.search) reject(422, 'invalid_v3_statistics');
    if (!await check(env, authorization)) reject(401, 'unauthorized');
    const bytes = await readBytes(request, 8192), hash = await sha256(bytes);
    if (request.headers.get('X-Body-SHA256') !== hash) reject(400, 'body_hash_mismatch');
    const value = parseStatisticsV3Json(bytes), envelope = validateStatisticsV3Envelope(value);
    if (envelope.node_id !== node) reject(403, 'node_not_allowed');
    const prior = await receipt(env, node, envelope.batch_id);
    if (prior) {
      if (!await check(env, authorization)) reject(401, 'unauthorized');
      return replay(prior, hash, await nowMs(env));
    }
    const control = await env.DB.prepare('SELECT state_version FROM device_control_v3 WHERE node_id=?').bind(node).first<{ state_version: number }>();
    if (!control) return reject(409, 'v3_statistics_authority_missing');
    const authority = await loadStatisticsAuthority(env, envelope), p = authority.policy;
    assertV3StatisticsPolicy(p, env, authority.capabilities.producer_version);
    if (envelope.dataset !== p.custody.dataset) reject(403, 'v3_statistics_policy_mismatch');
    if (bytes.byteLength > p.uplink.max_body_bytes) reject(413, 'payload_too_large');
    const limits = { ...statisticsLimits(p), max_bins: authority.capabilities.summary?.max_bins ?? 0 };
    if (envelope.stream === 'node_status') {
      // Status describes the physical persistent queue, including frozen work
      // from older boots/policies. Stream reserves are minima, not maxima, and
      // the latest policy's smaller budget cannot make retained backlog vanish.
      const medium = authority.capabilities.queue?.media.find(m => m.medium === p.local_queue.medium);
      if (!medium) return reject(503, 'v3_registry_invalid');
      limits.queue = { ...limits.queue, max_items: medium.max_items, max_bytes: medium.usable_bytes };
    }
    const batch = normalizeStatisticsV3Batch(value, limits), ranges = itemBounds(batch), now = await nowMs(env);
    if (authority.accept_until_ms <= now) reject(410, 'v3_statistics_acceptance_expired');
    const expiry = Math.min(...ranges.map(r => r.observedEnd + p.custody.source_retention_hours * 3600000));
    if (expiry <= now) reject(410, 'v3_statistics_source_expired');
    const captureChecks = ranges.flatMap(r => [r.health ? healthAssertion(authority, r.low, r.high) : statisticsCaptureAssertion(authority, r.low, r.high),
      ...(r.logicalEnd ? [healthAssertion(authority, r.logicalEnd.low, r.logicalEnd.high)] : [])]);
    for (const a of captureChecks) if (!await check(env, a)) reject(409, 'v3_statistics_capture_unauthorized');
    const ackRow = await env.DB.prepare('SELECT acknowledgement_json FROM device_acknowledgements_v3 WHERE node_id=? AND generation=? AND state=\'applied\'')
      .bind(node, batch.assignment_generation).first<{ acknowledgement_json: string }>();
    const ackInput = JSON.parse(ackRow!.acknowledgement_json) as { closed_window_seq: number };
    if (batch.stream === 'window_statistics' && batch.items.some(i => i.window_seq <= Math.max(p.control.activation.after_window_seq, ackInput.closed_window_seq))) reject(409, 'v3_statistics_window_conflict');
    const day = Math.floor(now / DAY) * DAY, retain = Math.max(expiry, authority.accept_until_ms + WEEK);
    // A policy replacement cannot reset the node's daily byte allowance.
    const quotaRow = await env.DB.prepare(`SELECT MIN(CAST(json_extract(a.envelope_json,'$.policy.custody.max_upload_bytes_per_day') AS INTEGER)) AS quota
      FROM device_assignments_v3 a JOIN device_acknowledgements_v3 k ON k.node_id=a.node_id AND k.generation=a.generation AND k.state='applied'
      WHERE a.node_id=? AND json_extract(a.envelope_json,'$.policy.evidence.mode')='statistics'
      AND CAST(strftime('%s',json_extract(a.envelope_json,'$.policy.custody.accept_until')) AS INTEGER)*1000>?`).bind(node, day).first<{ quota: number | null }>();
    const quota = Math.min(p.custody.max_upload_bytes_per_day, quotaRow?.quota ?? p.custody.max_upload_bytes_per_day);
    const ack: StatisticsV3Receipt = { protocol: 'campuspulse/3', schema: 'device-statistics-receipt/3', node_id: node, boot_id: batch.boot_id,
      stream: batch.stream, batch_id: batch.batch_id, body_sha256: hash, policy_id: batch.policy_id, policy_sha256: batch.policy_sha256,
      assignment_generation: batch.assignment_generation, seq_first: batch.items[0].seq, seq_last: batch.items[batch.items.length - 1].seq,
      accepted_count: batch.items.length, receipt_id: crypto.randomUUID(), received_at: new Date(now).toISOString(),
      expires_at: new Date(expiry).toISOString(), retain_until: new Date(retain).toISOString(), durability: 'committed', custody: 'small_statistics' };
    const writes: D1PreparedStatement[] = [], ids: string[] = [];
    const assert = (a: AuthAssertion) => {
      const id = crypto.randomUUID(); ids.push(id);
      writes.push(env.DB.prepare(`INSERT INTO admin_write_assertions(id,ok) SELECT ?,CASE WHEN (${a.sql}) THEN 1 ELSE 0 END`).bind(id, ...a.bindings));
    };
    const finalChecks: AuthAssertion[] = [authorization, ...captureChecks,
      { sql: 'EXISTS(SELECT 1 FROM device_control_v3 WHERE node_id=? AND state_version=?)', bindings: [node, control.state_version] },
      { sql: `${NOW}>=? AND ${NOW}<? AND ${NOW}<?`, bindings: [day, day + DAY, expiry] }];
    if (batch.stream === 'window_statistics') for (const item of batch.items) finalChecks.push({
      sql: `NOT EXISTS(SELECT 1 FROM device_acknowledgements_v3 k WHERE k.node_id=? AND k.boot_id=? AND k.generation>? AND k.state='applied'
        AND CAST(json_extract(k.acknowledgement_json,'$.closed_window_seq') AS INTEGER)<?)`,
      bindings: [node, batch.boot_id, batch.assignment_generation, item.window_seq],
    });
    finalChecks.forEach(assert);
    writes.push(env.DB.prepare(`INSERT INTO statistics_batches_v3(node_id,batch_id,boot_id,stream,generation,policy_sha256,body_sha256,seq_first,seq_last,receipt_json,expires_at_ms,retain_until_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(node, batch.batch_id, batch.boot_id, batch.stream, batch.assignment_generation, batch.policy_sha256,
        hash, ack.seq_first, ack.seq_last, JSON.stringify(ack), expiry, retain));
    if (batch.stream === 'window_statistics') {
      for (const item of batch.items) writes.push(env.DB.prepare(`INSERT INTO statistics_windows_v3(node_id,boot_id,generation,clock_epoch,window_seq,seq,batch_id,
        placement_id,dataset,collection_mode,end_utc_ms,end_mono_ms,uncertainty_ms,duration_ms,received_at_ms,quality_mask,extractor_version,ruleset_version,item_json,expires_at_ms,retain_until_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(node, batch.boot_id, batch.assignment_generation, item.time.clock_epoch, item.window_seq, item.seq,
          batch.batch_id, p.custody.placement_id, batch.dataset, p.collection.mode, item.time.utc_ms, item.time.mono_ms, item.time.uncertainty_ms, item.duration_ms, now,
          item.quality_mask, item.versions.extractor_version, item.versions.ruleset_version, JSON.stringify(item), expiry, retain));
    } else if (batch.stream === 'node_status') {
      const i = batch.items[0];
      writes.push(env.DB.prepare(`INSERT INTO statistics_status_v3(node_id,boot_id,seq,batch_id,uptime_ms,clock_epoch,window_drops,event_drops,status_coalesced,
        upload_failures,ack_failures,retries,raw_enqueued,raw_written,raw_synced,raw_queue_drops,raw_storage_failures,raw_space_stops,item_json,expires_at_ms,retain_until_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(node, batch.boot_id, i.seq, batch.batch_id, i.uptime_ms, i.time.clock_epoch, ...STATISTICS_V3_STATUS_LOSSES.map(k => i.losses[k]),
          ...STATISTICS_V3_RAW_COUNTERS.map(k => i.raw_recording?.[k] ?? null), JSON.stringify(i), expiry, retain));
    } else {
      await eventWrites(env, batch, limits, expiry, retain, writes, assert);
      if (p.temporal.mode === 'rolling') assert({ sql: `(
        SELECT COUNT(*) FROM statistics_events_v3 WHERE node_id=? AND boot_id=? AND generation=? AND state='open' AND item_json IS NOT NULL AND expires_at_ms>${NOW})<=?`,
        bindings: [node, batch.boot_id, batch.assignment_generation, p.temporal.max_open_events] });
    }
    writes.push(env.DB.prepare(`INSERT INTO statistics_quota_v3(node_id,day_start_ms,used_bytes,limit_bytes,retain_until_ms) VALUES(?,?,?,?,?)
      ON CONFLICT(node_id,day_start_ms) DO UPDATE SET used_bytes=used_bytes+excluded.used_bytes,limit_bytes=MIN(limit_bytes,excluded.limit_bytes)`)
      .bind(node, day, bytes.byteLength, quota, day + DAY + WEEK));
    // Slow source writes may cross clock boundaries or invoke revocation triggers.
    finalChecks.forEach(assert);
    assert({ sql: 'EXISTS(SELECT 1 FROM statistics_quota_v3 WHERE node_id=? AND day_start_ms=? AND used_bytes<=limit_bytes AND limit_bytes<=?)', bindings: [node, day, quota] });
    writes.push(...ids.map(id => env.DB.prepare('DELETE FROM admin_write_assertions WHERE id=?').bind(id)));
    try { await env.DB.batch(writes); }
    catch (error) {
      if (!await check(env, authorization)) reject(401, 'unauthorized');
      const winner = await receipt(env, node, batch.batch_id);
      if (winner) return replay(winner, hash, await nowMs(env));
      const current = await nowMs(env);
      if (current >= authority.accept_until_ms || current >= expiry) reject(410, 'v3_statistics_source_expired');
      for (const a of captureChecks) if (!await check(env, a)) reject(409, 'v3_statistics_capture_unauthorized');
      let message = '';
      for (let e: unknown = error, n = 0; e instanceof Error && n < 5; e = e.cause, n++) message += e.message;
      if (/used_bytes\s*<=\s*limit_bytes/.test(message)) reject(429, 'v3_statistics_quota_exhausted');
      if (/v3_statistics_capacity/.test(message)) reject(429, 'v3_statistics_capacity');
      if (/v3_statistics_namespace|v3_statistics_(?:status|window)_order|UNIQUE constraint failed: statistics_|CHECK constraint failed: ok/.test(message)) reject(409, 'v3_statistics_conflict');
      reject(503, 'storage_unavailable');
    }
    return json(ack);
  } catch (error) {
    return statisticsError(error);
  }
}
function statisticsError(error: unknown): Response {
    if (error instanceof DeviceV3ConfigError) return json({ error: { code: 'invalid_v3_statistics', message: 'Invalid statistics policy.', retryable: false } }, 422);
    if (error instanceof IngestError) return json({ error: { code: error.code, message: error.message, retryable: error.status >= 500 || error.status === 429 } }, error.status);
    return json({ error: { code: 'storage_unavailable', message: 'Service temporarily unavailable.', retryable: true } }, 503);
}

/** Cleanup is independent of upload enablement, old raw cleanup and public reads. */
export async function expireDeviceV3Statistics(env: DeviceV3StatisticsEnv, now = Date.now()) {
  if (!await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='statistics_batches_v3'").first()) {
    return { schema_available: false, deleted_private_rows: 0, expired_backlog: false };
  }
  let deleted = 0, backlog = false;
  for (const table of ['statistics_windows_v3', 'statistics_status_v3', 'statistics_events_v3']) {
    const cleared = await env.DB.prepare(`UPDATE ${table} SET item_json=NULL WHERE rowid IN
      (SELECT rowid FROM ${table} WHERE expires_at_ms<=? AND item_json IS NOT NULL LIMIT 5000)`).bind(now).run();
    deleted += cleared.meta.changes;
    backlog ||= !!await env.DB.prepare(`SELECT 1 FROM ${table} WHERE expires_at_ms<=? AND item_json IS NOT NULL LIMIT 1`).bind(now).first();
  }
  // Cross-protocol batch IDs cannot be reclaimed while an old capture policy is
  // still allowed to submit. New v3 identities remain bounded by known boot caps.
  const candidates = await env.DB.prepare(`SELECT node_id,batch_id,boot_id,stream,seq_last FROM statistics_batches_v3 b
    WHERE b.retain_until_ms<=? AND NOT EXISTS(SELECT 1 FROM capture_configs c WHERE c.node_id=b.node_id AND c.accept_until_ms>=?)
    AND NOT EXISTS(SELECT 1 FROM device_assignments_v3 a WHERE a.node_id=b.node_id
      AND json_extract(a.envelope_json,'$.policy.evidence.mode')='features' AND json_extract(a.envelope_json,'$.policy.custody.accept_until')>=?)
    ORDER BY b.retain_until_ms LIMIT 100`).bind(now, now, new Date(now).toISOString()).all<{ node_id: string; batch_id: string; boot_id: string; stream: string; seq_last: number }>();
  const counterColumns = ['uptime_ms', 'clock_epoch', ...STATISTICS_V3_STATUS_LOSSES, ...STATISTICS_V3_RAW_COUNTERS.map(k => `raw_${k}`)];
  for (const b of candidates.results) await env.DB.batch([
    ...(b.stream === 'window_statistics' ? [env.DB.prepare(`INSERT INTO statistics_sequence_floors_v3(node_id,boot_id,stream,seq_floor,uptime_ms,clock_epoch,window_end_utc_ms,window_uncertainty_ms,window_seq_floor)
      SELECT node_id,boot_id,'window_statistics',seq,end_mono_ms,clock_epoch,end_utc_ms,uncertainty_ms,window_seq FROM statistics_windows_v3 WHERE node_id=? AND batch_id=? ORDER BY seq DESC LIMIT 1
      ON CONFLICT(node_id,boot_id,stream) DO UPDATE SET uptime_ms=excluded.uptime_ms,clock_epoch=excluded.clock_epoch,window_end_utc_ms=excluded.window_end_utc_ms,
      window_uncertainty_ms=excluded.window_uncertainty_ms,window_seq_floor=MAX(COALESCE(window_seq_floor,0),excluded.window_seq_floor),seq_floor=excluded.seq_floor WHERE excluded.seq_floor>=seq_floor`)
      .bind(b.node_id, b.batch_id)] : []),
    env.DB.prepare(`INSERT INTO statistics_sequence_floors_v3(node_id,boot_id,stream,seq_floor) VALUES(?,?,?,?)
      ON CONFLICT(node_id,boot_id,stream) DO UPDATE SET seq_floor=MAX(seq_floor,excluded.seq_floor)`).bind(b.node_id, b.boot_id, b.stream, b.seq_last),
    ...(b.stream === 'window_statistics' ? [env.DB.prepare(`UPDATE statistics_sequence_floors_v3 SET window_seq_floor=MAX(COALESCE(window_seq_floor,0),
      COALESCE((SELECT MAX(window_seq) FROM statistics_windows_v3 WHERE node_id=? AND batch_id=?),0)) WHERE node_id=? AND boot_id=? AND stream='window_statistics'`)
      .bind(b.node_id, b.batch_id, b.node_id, b.boot_id)] : []),
    ...(b.stream === 'node_status' ? [env.DB.prepare(`INSERT INTO statistics_sequence_floors_v3(node_id,boot_id,stream,seq_floor,${counterColumns.join(',')})
      SELECT node_id,boot_id,'node_status',seq,${counterColumns.join(',')} FROM statistics_status_v3 WHERE node_id=? AND batch_id=?
      ON CONFLICT(node_id,boot_id,stream) DO UPDATE SET seq_floor=MAX(seq_floor,excluded.seq_floor),
      ${counterColumns.map(c => `${c}=CASE WHEN ${c} IS NULL THEN excluded.${c} WHEN excluded.${c} IS NULL THEN ${c} ELSE MAX(${c},excluded.${c}) END`).join(',')}`)
      .bind(b.node_id, b.batch_id)] : []),
    env.DB.prepare('DELETE FROM statistics_windows_v3 WHERE node_id=? AND batch_id=? AND retain_until_ms<=?').bind(b.node_id, b.batch_id, now),
    env.DB.prepare('DELETE FROM statistics_status_v3 WHERE node_id=? AND batch_id=? AND retain_until_ms<=?').bind(b.node_id, b.batch_id, now),
    env.DB.prepare('DELETE FROM statistics_batches_v3 WHERE node_id=? AND batch_id=? AND retain_until_ms<=?').bind(b.node_id, b.batch_id, now),
  ]);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM statistics_events_v3 WHERE rowid IN (SELECT rowid FROM statistics_events_v3 WHERE retain_until_ms<=? LIMIT 500)').bind(now),
    env.DB.prepare('DELETE FROM statistics_quota_v3 WHERE rowid IN (SELECT rowid FROM statistics_quota_v3 WHERE retain_until_ms<=? LIMIT 500)').bind(now),
  ]);
  const result = { schema_available: true, deleted_private_rows: deleted, expired_backlog: backlog };
  if (backlog) console.warn(JSON.stringify({ event: 'v3_statistics_retention_backlog', ...result }));
  return result;
}
