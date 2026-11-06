/** Private historical aggregate snapshots. This never enters device ingestion or field projections. */
import type { Env } from './types';
import { sessionAssertion, unauthorized, type AdminSession, type AuthAssertion } from './admin-auth';
import { IngestError, parseIngestJson } from './strict-json';
import { json, readBytes, sha256 } from './http';
import { validateStatisticsV3Window, type StatisticsV3Limits } from './device-v3-statistics-validation';

const MAX_BYTES = 256 * 1024;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[0-9a-f]{64}$/;
type ObjectValue = Record<string, unknown>;
type Transact = (writes: D1PreparedStatement[], action: string, target: string, detail: ObjectValue, assertions?: AuthAssertion[]) => Promise<void>;
const invalid = (): never => { throw new IngestError(422, 'invalid_replay_import', 'Use bounded aggregate-only historical replay data with complete report accounting.'); };
function object(value: unknown, keys: string[]): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || keys.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => !keys.includes(k))) invalid();
  return value as ObjectValue;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid();
}
function identifier(value: unknown): string { return typeof value === 'string' && ID.test(value) ? value : invalid(); }
function label(value: unknown): string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 120 && value.trim() && !/[\x00-\x1f\x7f]/.test(value) ? value : invalid();
}
interface ClockAnchor { mono_us: number; utc_epoch_seconds: number; uncertainty_us: number; source: number }
const LIMITS: StatisticsV3Limits = {
  window_ms: 60000, bin_ms: 5000, max_addresses: 512, extractor_version: 'cp-v3-stats/1', ruleset_version: 'unclassified-v1',
  max_batch_items: 120, max_body_bytes: MAX_BYTES, streams: ['window_statistics'], queue: { max_items: 120, max_bytes: MAX_BYTES, stream_reserves: [] },
};

export function validateReplayImport(value: unknown) {
  const o = object(value, ['schema', 'id', 'label', 'place_id', 'window_ms', 'bin_ms', 'source', 'windows']);
  if (o.schema !== 'campuspulse-replay-import/1' || o.window_ms !== LIMITS.window_ms || o.bin_ms !== LIMITS.bin_ms) invalid();
  const id = identifier(o.id), name = label(o.label), place = o.place_id === null ? null : identifier(o.place_id);
  const source = object(o.source, ['sha256', 'total_reports', 'replayed_reports', 'time_semantics', 'clock_anchors']);
  if (!Array.isArray(source.sha256) || !source.sha256.length || source.sha256.length > 128 || source.sha256.some(h => typeof h !== 'string' || !HASH.test(h)) || new Set(source.sha256).size !== source.sha256.length || source.time_semantics !== 'historical_capture') invalid();
  const total = integer(source.total_reports, 1), replayed = integer(source.replayed_reports, 1);
  if (total !== replayed || !Array.isArray(source.clock_anchors) || source.clock_anchors.length > 1024) invalid();
  const anchors: ClockAnchor[] = (source.clock_anchors as unknown[]).map(value => {
    const a = object(value, ['mono_us', 'utc_epoch_seconds', 'uncertainty_us', 'source']);
    return { mono_us: integer(a.mono_us), utc_epoch_seconds: integer(a.utc_epoch_seconds, 0, 8640000000000), uncertainty_us: integer(a.uncertainty_us, 0, 0xffffffff), source: integer(a.source, 1, 2) };
  });
  if (anchors.some((a, i) => i > 0 && a.mono_us < anchors[i - 1].mono_us)) invalid();
  if (!Array.isArray(o.windows) || !o.windows.length || o.windows.length > 120) invalid();
  let previousEnd: number | null = null, workerReports = 0n;
  const windows = (o.windows as unknown[]).map((value, index, all) => {
    const w = object(value, ['source_start_mono_us', 'source_end_mono_us', 'item']);
    const start = integer(w.source_start_mono_us), end = integer(w.source_end_mono_us, start + 1000);
    const item = object(w.item, ['d', 'b', 'c', 'r', 'x', 's', 'l', 'f', 'v']);
    const duration = integer(item.d, 1, LIMITS.window_ms);
    if (start % 1000 || end % 1000 || end - start !== duration * 1000 || previousEnd !== null && start !== previousEnd || index < all.length - 1 && duration !== LIMITS.window_ms) invalid();
    previousEnd = end;
    // Retain the original monotonic clock; any UTC is derived solely from the
    // producer's historical anchor, never the import/server clock. The first
    // anchor permits an explicit historical back-projection before that anchor.
    let anchorIndex = -1;
    for (let i = 0; i < anchors.length; i++) { if (anchors[i].mono_us <= end) anchorIndex = i; else break; }
    if (anchorIndex < 0 && anchors.length) anchorIndex = 0;
    const anchor = anchors[anchorIndex], utc = anchor ? Math.floor(anchor.utc_epoch_seconds * 1000 + (end - anchor.mono_us) / 1000) : null;
    const uncertainty = anchor ? Math.ceil(anchor.uncertainty_us / 1000) : null;
    const flags = integer(item.f, 0, 63) | (utc === null || uncertainty! > 0 ? 2 : 0);
    const normalized = validateStatisticsV3Window({ ...item, q: index + 1, w: index + 1,
      t: [end / 1000, utc, anchorIndex < 0 ? 1 : anchorIndex + 1, uncertainty], f: flags }, LIMITS);
    workerReports += BigInt(normalized.reports.worker);
    return { source_start_mono_us: start, source_end_mono_us: end, item: normalized };
  });
  if (workerReports !== BigInt(replayed)) invalid();
  return { schema: 'campuspulse-replay-view/1' as const, dataset: 'controlled_test' as const, source: 'historical_cpraw' as const,
    id, label: name, place_id: place, window_ms: LIMITS.window_ms, bin_ms: LIMITS.bin_ms,
    source_metadata: { sha256: source.sha256, total_reports: total, replayed_reports: replayed, time_semantics: 'historical_capture', clock_anchors: anchors }, windows };
}
interface ReplayRow { body_sha256: string; imported_at: string; snapshot_json: string }
function liveSession(session: AdminSession): AuthAssertion {
  const a = sessionAssertion(session);
  return { sql: `(${a.sql}) AND EXISTS (SELECT 1 FROM admin_sessions WHERE token_sha256=? AND expires_at_ms>CAST(unixepoch('subsec')*1000 AS INTEGER))`, bindings: [...a.bindings, session.hash] };
}
async function findReplay(env: Env, id: string, session: AdminSession): Promise<ReplayRow | null> {
  const a = liveSession(session);
  // Authorization and snapshot are read in the same SQL statement. The LEFT
  // JOIN retains a guard row even when the replay itself does not exist.
  const row = await env.DB.prepare(`SELECT r.body_sha256,r.imported_at,r.snapshot_json,(${a.sql}) AS authorized
    FROM (SELECT 1) LEFT JOIN controlled_replays r ON r.id=?`).bind(...a.bindings, id).first<ReplayRow & { authorized: number }>();
  if (!row?.authorized) throw unauthorized();
  return row.snapshot_json === null ? null : row;
}
function privateJson(value: unknown, status = 200) {
  const response = json(value, status);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
function view(row: ReplayRow) { return { ...JSON.parse(row.snapshot_json), imported_at: row.imported_at, body_sha256: row.body_sha256 }; }
const conflict = (): never => { throw new IngestError(409, 'replay_id_conflict', 'This replay ID already identifies different immutable content.'); };

/** Called only after same-origin policy and the existing full administrator session check. */
export async function handleAdminReplays(request: Request, env: Env, route: string, session: AdminSession, transact: Transact): Promise<Response | null> {
  const match = /^\/replays\/([a-z0-9][a-z0-9_-]{0,63})$/.exec(route);
  if (route !== '/replays' && !match) return null;
  if (new URL(request.url).search) invalid();
  if (route === '/replays' ? request.method !== 'POST' : request.method !== 'GET') {
    const response = privateJson({ error: 'method_not_allowed' }, 405);
    response.headers.set('Allow', route === '/replays' ? 'POST' : 'GET');
    return response;
  }
  if (match && request.method === 'GET') {
    const row = await findReplay(env, match[1], session);
    if (!row) throw new IngestError(404, 'replay_not_found', 'Unknown historical replay.');
    return privateJson(view(row));
  }
  if (route !== '/replays' || request.method !== 'POST') return null;
  const bytes = await readBytes(request, MAX_BYTES), snapshot = validateReplayImport(parseIngestJson(bytes));
  const digest = await sha256(bytes), snapshotJson = JSON.stringify(snapshot);
  if (new TextEncoder().encode(snapshotJson).byteLength > MAX_BYTES) throw new IngestError(413, 'replay_too_large', 'Normalized historical replay exceeds its storage bound.');
  const find = () => findReplay(env, snapshot.id, session);
  const existing = await find();
  if (existing) { if (existing.body_sha256 !== digest) conflict(); return privateJson(view(existing)); }
  const stamp = new Date().toISOString();
  // Atomic sessionAssertion is injected by the existing administrator handler,
  // after every body read/hash await. The ID check prevents concurrent overwrite.
  await transact([env.DB.prepare(`INSERT INTO controlled_replays(id,body_sha256,imported_at,imported_by,snapshot_json)
    VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(snapshot.id, digest, stamp, session.account!.id, snapshotJson)],
  'replay.import', snapshot.id, { windows: snapshot.windows.length, reports: snapshot.source_metadata.replayed_reports, dataset: 'controlled_test' },
  [liveSession(session), { sql: 'NOT EXISTS (SELECT 1 FROM controlled_replays WHERE id=?) OR EXISTS (SELECT 1 FROM controlled_replays WHERE id=? AND body_sha256=?)', bindings: [snapshot.id, snapshot.id, digest] }]);
  const row = await find();
  if (!row) return conflict();
  if (row.body_sha256 !== digest) conflict();
  return privateJson(view(row), 201);
}
