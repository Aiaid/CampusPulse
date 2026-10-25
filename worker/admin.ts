import type { Env, PlaceKind } from './types';
import { IngestError, parseIngestJson } from './ingest-validation';
import { validateAnyCaptureConfig as validateCaptureConfig, type AnyCaptureConfig as CaptureConfig } from './device-v2-validation';
import { json, readBytes, sha256 } from './ingest';
import { adminOrigin, adminSecret, requireAdminSession, requireFreshSession, sessionAssertion, AuthRateLimitError } from './admin-auth';
import { handleAdminIdentity } from './admin-account';
import { handleAdminDeviceDiagnostics } from './admin-device-diagnostics';
import { readRuntimeSettings, readSettingsRecord, validateSettings } from './admin-settings';
export { readRuntimeSettings, readPublicSettings } from './admin-settings';

const ID = /^[a-z0-9_-]{1,64}$/;
type ObjectValue = Record<string, unknown>;
const fail = (field: string): never => { throw new IngestError(422, 'invalid_admin_input', `Invalid field: ${field}.`); };
function object(value: unknown, required: string[], optional: string[] = []): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('body');
  const o = value as ObjectValue;
  if (required.some(key => !Object.hasOwn(o, key)) || Object.keys(o).some(key => !required.includes(key) && !optional.includes(key))) return fail('body');
  return o;
}
const identifier = (value: unknown, field: string): string => typeof value === 'string' && ID.test(value) ? value : fail(field);
function label(value: unknown, field: string, max = 80): string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max && value.trim() && !/[\x00-\x1f\x7f]/.test(value) ? value : fail(field);
}
function integer(value: unknown, field: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : fail(field);
}
const readBody = async (request: Request) => parseIngestJson(await readBytes(request, 32768));
const missing = (name: string): never => { throw new IngestError(404, `${name}_not_found`, `Unknown ${name}.`); };
const conflict = (code = 'revision_conflict'): never => { throw new IngestError(409, code, 'The registry changed or conflicts with existing evidence. Refresh before retrying.'); };

function audit(db: D1Database, action: string, target: string, detail: ObjectValue, now: string) {
  // Callers construct a small explicit allowlist; never pass request bodies,
  // credentials, digests, raw evidence, or arbitrary device messages here.
  return db.prepare('INSERT INTO admin_audit(action,target,detail_json,created_at) VALUES (?,?,?,?)')
    .bind(action, target, JSON.stringify(detail), now);
}
interface Assertion { sql: string; bindings: unknown[] }
/** Preconditions execute inside the same transaction as changes and audit. */
async function atomic(env: Env, writes: D1PreparedStatement[], action: string, target: string, detail: ObjectValue, assertions: Assertion[] = []) {
  const now = new Date().toISOString();
  const guards = assertions.map(() => crypto.randomUUID());
  const checks = assertions.map((condition, i) => env.DB.prepare(`INSERT INTO admin_write_assertions(id,ok) SELECT ?,CASE WHEN (${condition.sql}) THEN 1 ELSE 0 END`).bind(guards[i], ...condition.bindings));
  try {
    await env.DB.batch([...checks, ...writes, audit(env.DB, action, target, detail, now),
      ...guards.map(id => env.DB.prepare('DELETE FROM admin_write_assertions WHERE id = ?').bind(id))]);
  } catch (error) {
    const messages: string[] = [];
    for (let e: unknown = error, depth = 0; e instanceof Error && depth < 4; e = e.cause, depth++) messages.push(e.message);
    if (/constraint|unique|foreign key|overlap|immutable|place_kind_conflict|purposes_invalid|config_assignment_owner/i.test(messages.join(' '))) conflict();
    throw error;
  }
}

interface DeviceRow {
  id: string; name: string; board: string; enabled: number;
  last_seen_at: string | null; firmware_version: string | null; reported_config_id: string | null;
  desired_config_id: string | null; activation_state: 'applied' | 'failed' | null;
  status_json: string | null; status_received_at: string | null; status_boot_id: string | null; status_config_id: string | null; status_batch_id: string | null;
  ingestion_received_at: string | null; ingestion_boot_id: string | null; ingestion_stream: string | null; ingestion_batch_id: string | null;
  applied_config_id: string | null; control_json: string | null; control_received_at: string | null; desired_protocol: string | null;
}
const DEVICE_SELECT = `SELECT n.id,n.name,n.board,n.enabled,
  CASE WHEN c.received_at IS NOT NULL AND (b.received_at IS NULL OR c.received_at>b.received_at) THEN c.received_at ELSE b.received_at END AS last_seen_at,
  CASE WHEN c.received_at IS NOT NULL AND (b.received_at IS NULL OR c.received_at>b.received_at) THEN c.firmware_version ELSE b.firmware_version END AS firmware_version,
  b.capture_config_id AS reported_config_id,d.capture_config_id AS desired_config_id,
  b.received_at AS ingestion_received_at,b.boot_id AS ingestion_boot_id,b.stream AS ingestion_stream,b.batch_id AS ingestion_batch_id,
  CASE WHEN json_extract(p.config_json,'$.protocol')='campuspulse/2' THEN
    CASE WHEN c.activation_config_id=d.capture_config_id THEN c.activation_state ELSE NULL END ELSE a.state END AS activation_state,
  CASE WHEN json_extract(p.config_json,'$.protocol')='campuspulse/2' THEN c.applied_config_id
    WHEN a.state='applied' THEN a.capture_config_id ELSE NULL END AS applied_config_id,
  json_extract(p.config_json,'$.protocol') AS desired_protocol,
  c.contact_json AS control_json,c.received_at AS control_received_at,
  s.item_json AS status_json,s.received_at AS status_received_at,s.boot_id AS status_boot_id,s.capture_config_id AS status_config_id,s.batch_id AS status_batch_id
  FROM device_nodes n
  LEFT JOIN all_ingestion_batches b ON b.node_id=n.id AND b.batch_id=(SELECT x.batch_id FROM all_ingestion_batches x WHERE x.node_id=n.id ORDER BY x.received_at DESC,x.batch_id DESC LIMIT 1)
  LEFT JOIN device_desired_configs d ON d.node_id=n.id
  LEFT JOIN capture_configs p ON p.id=d.capture_config_id
  LEFT JOIN config_activation a ON a.node_id=n.id AND a.capture_config_id=d.capture_config_id
  LEFT JOIN device_control_v2 c ON c.node_id=n.id
  LEFT JOIN all_node_status s ON s.node_id=n.id AND s.batch_id=(SELECT x.batch_id FROM all_node_status x WHERE x.node_id=n.id ORDER BY x.received_at DESC,x.batch_id DESC LIMIT 1)`;

function deviceFromRow(row: DeviceRow, staleSeconds: number, now: number) {
  const lastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : NaN;
  return { id: row.id, name: row.name || row.id, board: row.board, enabled: row.enabled === 1,
    last_seen_at: row.last_seen_at,
    contact_state: !Number.isFinite(lastSeen) ? 'unknown' : now - lastSeen <= staleSeconds * 1000 ? 'recent' : 'stale',
    firmware_version: row.firmware_version,
    latest_status: row.status_json ? { item: JSON.parse(row.status_json), received_at: row.status_received_at, boot_id: row.status_boot_id, capture_config_id: row.status_config_id, batch_id: row.status_batch_id } : null,
    latest_control: row.control_json ? { ...JSON.parse(row.control_json), received_at: row.control_received_at } : null,
    latest_ingestion: row.ingestion_received_at ? { received_at: row.ingestion_received_at, boot_id: row.ingestion_boot_id, stream: row.ingestion_stream, batch_id: row.ingestion_batch_id, capture_config_id: row.reported_config_id } : null,
    server_time: new Date(now).toISOString(), stale_after_seconds: staleSeconds,
    applied_config_id: row.applied_config_id,
    desired_config_id: row.desired_config_id, reported_config_id: row.reported_config_id,
    config_state: row.desired_protocol === 'campuspulse/2' ? (row.activation_state ?? 'pending') : !row.desired_config_id ? 'unassigned' : row.activation_state ?? (row.reported_config_id === row.desired_config_id ? 'reported' : 'pending') };
}
async function findDevice(env: Env, id: string) {
  const [row, settings] = await Promise.all([
    env.DB.prepare(`${DEVICE_SELECT} WHERE n.id = ?`).bind(id).first<DeviceRow>(), readRuntimeSettings(env),
  ]);
  return row ? deviceFromRow(row, settings.stale_after_seconds, Date.now()) : missing('device');
}
async function requireDevice(env: Env, id: string): Promise<void> {
  if (!await env.DB.prepare('SELECT id FROM device_nodes WHERE id = ?').bind(id).first()) missing('device');
}

interface PlaceRow { id: string; name: string; kind: PlaceKind; observation_kinds_json: string; anchor_x: number; anchor_y: number; gis_anchor_x: number | null; gis_anchor_y: number | null }
const PLACE_COLUMNS = 'id,name,kind,observation_kinds_json,anchor_x,anchor_y,gis_anchor_x,gis_anchor_y';
const placeFromRow = (p: PlaceRow) => ({ id: p.id, name: p.name, kind: p.kind, observation_kinds: JSON.parse(p.observation_kinds_json) as PlaceKind[], anchor: { x: p.anchor_x, y: p.anchor_y },
  ...(p.gis_anchor_x !== null && p.gis_anchor_y !== null ? { gis_anchor: { x: p.gis_anchor_x, y: p.gis_anchor_y, verified: true } } : {}) });
function anchor(value: unknown, field: string, gis = false) {
  const o = object(value, gis ? ['x', 'y', 'verified'] : ['x', 'y']);
  if (gis && o.verified !== true) fail(field);
  const coordinate = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : fail(field);
  return { x: coordinate(o.x), y: coordinate(o.y) };
}
const placeKind = (value: unknown): PlaceKind => value === 'activity' || value === 'parking' || value === 'elevator' ? value : fail('kind');
function observationKinds(value: unknown): PlaceKind[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return fail('observation_kinds');
  const kinds = value.map(placeKind);
  if (new Set(kinds).size !== kinds.length) return fail('observation_kinds');
  return kinds;
}
function placePurposes(o: ObjectValue) {
  const kinds = 'observation_kinds' in o ? observationKinds(o.observation_kinds) : [placeKind(o.kind)];
  const kind = 'kind' in o ? placeKind(o.kind) : kinds[0];
  if (!kinds.includes(kind)) fail('kind');
  return { kind, kinds };
}
interface PlacementRow { observation_kinds_json: string; [key: string]: unknown }
const placementFromRow = ({ observation_kinds_json, ...row }: PlacementRow) => ({ ...row, observation_kinds: JSON.parse(observation_kinds_json) as PlaceKind[] });

interface DraftRow { id: string; node_id: string; config_json: string; raw_retention_hours: number; aggregate_retention_days: number; revision: number; created_at: string; updated_at: string; published_at: string | null }
const draftFromRow = (r: DraftRow) => ({ id: r.id, config: JSON.parse(r.config_json) as CaptureConfig, raw_retention_hours: r.raw_retention_hours,
  aggregate_retention_days: r.aggregate_retention_days, revision: r.revision, created_at: r.created_at, updated_at: r.updated_at, published_at: r.published_at });
async function findDraft(env: Env, id: string) {
  const row = await env.DB.prepare('SELECT * FROM config_drafts WHERE id = ?').bind(id).first<DraftRow>();
  return row ?? missing('draft');
}
interface PublishedRow { id: string; node_id: string; placement_id: string; dataset: string; config_json: string; raw_retention_hours: number; aggregate_retention_days: number; published_at: string | null }
const PUBLISHED_SELECT = `SELECT c.id,c.node_id,c.placement_id,c.dataset,c.config_json,c.raw_retention_hours,c.aggregate_retention_days,d.published_at
 FROM capture_configs c LEFT JOIN config_drafts d ON d.id = c.id`;
function publishedFromRow(r: PublishedRow) {
  return { id: r.id, node_id: r.node_id, placement_id: r.placement_id, dataset: r.dataset, config: JSON.parse(r.config_json) as CaptureConfig,
    raw_retention_hours: r.raw_retention_hours, aggregate_retention_days: r.aggregate_retention_days, published_at: r.published_at };
}
async function configInput(env: Env, body: ObjectValue) {
  const config = validateCaptureConfig(body.config);
  const defaults = await readRuntimeSettings(env);
  const raw = body.raw_retention_hours === undefined ? defaults.default_raw_retention_hours : integer(body.raw_retention_hours, 'raw_retention_hours', 1, 8760);
  const aggregate = body.aggregate_retention_days === undefined ? defaults.default_aggregate_retention_days : integer(body.aggregate_retention_days, 'aggregate_retention_days', 1, 3650);
  await requireDevice(env, config.node_id);
  return { config, raw, aggregate };
}
async function validateDraftRegistry(env: Env, config: CaptureConfig) {
  const placement = await env.DB.prepare(`SELECT p.valid_from_ms,COALESCE(c.valid_until_ms,p.valid_until_ms) AS valid_until_ms
    FROM placements p LEFT JOIN placement_closures c ON c.placement_id=p.id WHERE p.id=? AND p.node_id=?`)
    .bind(config.placement_id, config.node_id).first<{ valid_from_ms: number; valid_until_ms: number | null }>();
  if (!placement)
    throw new IngestError(422, 'placement_mismatch', 'Capture policy must reference a placement belonging to the device.');
  const now = Date.now();
  if (placement.valid_from_ms > now || placement.valid_until_ms !== null && placement.valid_until_ms <= now)
    throw new IngestError(422, 'placement_inactive', 'Publish for a placement active now; keep future or historical changes in a draft.');
  if (Date.parse(config.accept_until) <= now) throw new IngestError(422, 'config_expired', 'A newly published policy must accept data in the future.');
  if (config.raw_capture.mode !== 'off' && !env.RAW_BUCKET)
    throw new IngestError(503, 'raw_storage_not_configured', 'Private raw storage must be configured before publishing a raw policy.');
}
const revisionAssertion = (id: string, revision: number): Assertion => ({
  sql: 'EXISTS (SELECT 1 FROM config_drafts WHERE id = ? AND revision = ? AND published_at IS NULL)', bindings: [id, revision],
});
// Evaluate time and placement validity during the transaction as well as in the
// friendly preflight: a concurrent relocation must invalidate a stale publish.
const SQL_NOW_MS = "(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
const activePlacementAssertion = (config: CaptureConfig): Assertion => ({
  sql: `EXISTS (SELECT 1 FROM placements p LEFT JOIN placement_closures c ON c.placement_id=p.id
    WHERE p.id=? AND p.node_id=? AND p.valid_from_ms<=${SQL_NOW_MS}
      AND COALESCE(c.valid_until_ms,p.valid_until_ms,9223372036854775807)>${SQL_NOW_MS}) AND ?>${SQL_NOW_MS}`,
  bindings: [config.placement_id, config.node_id, Date.parse(config.accept_until)],
});
function checkRevision(row: DraftRow, revision: number) {
  if (row.published_at !== null) conflict('config_already_published');
  if (row.revision !== revision) conflict();
}

/** Admin sessions remain separate from research/device bearer auth. Selected batch diagnostics are explicit private reads. */
export async function handleAdmin(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/v1/admin/') && url.pathname !== '/api/v1/admin') return null;
  try {
    const secret = adminSecret(env); // Fail closed before touching the database.
    adminOrigin(request, !['GET', 'HEAD', 'OPTIONS'].includes(request.method));
    const route = url.pathname.slice('/api/v1/admin'.length);
    const identity = await handleAdminIdentity(request, env, secret, route);
    if (identity) return identity;
    const session = await requireAdminSession(request, env, secret);
    const diagnostics = await handleAdminDeviceDiagnostics(request, env, route);
    if (diagnostics) return diagnostics;
    const transact = (writes: D1PreparedStatement[], action: string, target: string, detail: ObjectValue, assertions: Assertion[] = []) =>
      atomic(env, writes, action, target, detail, [sessionAssertion(session), ...assertions]);
    if (route === '/overview' && request.method === 'GET') {
      const settings = await readRuntimeSettings(env);
      const since = new Date(Date.now() - settings.stale_after_seconds * 1000).toISOString();
      const row = await env.DB.prepare(`SELECT COUNT(*) AS devices_total,COALESCE(SUM(enabled),0) AS devices_enabled,
        COALESCE(SUM(last_seen_at >= ?),0) AS devices_recent,COALESCE(SUM(last_seen_at < ?),0) AS devices_stale,
        COALESCE(SUM(last_seen_at IS NULL),0) AS devices_unknown,
        COALESCE(SUM(desired_config_id IS NOT NULL AND (activation_state IS NULL OR activation_state != 'applied')),0) AS config_pending
        FROM (${DEVICE_SELECT})`).bind(since,since).first();
      return json({ ...row, server_time: new Date().toISOString() });
    }
    if (route === '/devices') {
      if (request.method === 'GET') {
        const after = url.searchParams.get('after');
        if (after !== null) identifier(after, 'after');
        const settings = await readRuntimeSettings(env);
        const rows = await env.DB.prepare(`${DEVICE_SELECT} ${after ? 'WHERE n.id > ?' : ''} ORDER BY n.id LIMIT 201`).bind(...(after ? [after] : [])).all<DeviceRow>();
        const now = Date.now();
        return json({ devices: rows.results.slice(0, 200).map(r => deviceFromRow(r, settings.stale_after_seconds, now)),
          next_cursor: rows.results.length > 200 ? rows.results[199].id : null, server_time: new Date(now).toISOString() });
      }
      if (request.method === 'POST') {
        requireFreshSession(session);
        const o = object(await readBody(request), ['id', 'name', 'board']);
        const id = identifier(o.id, 'id'), name = label(o.name, 'name'), board = label(o.board, 'board');
        const credential = `cpd_${Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')}`;
        const hash = await sha256(new TextEncoder().encode(credential));
        const now = new Date().toISOString();
        await transact([env.DB.prepare('INSERT INTO device_nodes(id,credential_sha256,name,board,created_at,updated_at) VALUES (?,?,?,?,?,?)')
          .bind(id, hash, name, board, now, now)], 'device.register', id, { fields: ['name', 'board'] }, [sessionAssertion(session, true)]);
        return json({ device: await findDevice(env, id), credential }, 201);
      }
    }
    const deviceRoute = /^\/devices\/([a-z0-9_-]{1,64})(?:\/(rotate-credential|placements))?$/.exec(route);
    if (deviceRoute) {
      const [, id, action] = deviceRoute;
      await requireDevice(env, id);
      if (!action && request.method === 'GET') {
        const [device, placements, configs, activation, events] = await Promise.all([
          findDevice(env, id),
          env.DB.prepare(`SELECT p.*,COALESCE(c.valid_until_ms,p.valid_until_ms) AS effective_valid_until_ms,c.recorded_at AS closed_at,
            (SELECT COUNT(*) FROM all_sensor_windows w WHERE w.placement_id=p.id AND w.utc_ms IS NOT NULL AND
             (w.utc_ms < p.valid_from_ms OR w.utc_ms+w.duration_ms > COALESCE(c.valid_until_ms,p.valid_until_ms,9223372036854775807))) AS incompatible_window_count
            FROM placements p LEFT JOIN placement_closures c ON c.placement_id=p.id WHERE p.node_id=? ORDER BY p.valid_from_ms DESC,p.id LIMIT 201`).bind(id).all<PlacementRow>(),
          env.DB.prepare(`${PUBLISHED_SELECT} WHERE c.node_id = ? ORDER BY c.accept_until_ms DESC,c.id DESC LIMIT 201`).bind(id).all<PublishedRow>(),
          env.DB.prepare(`SELECT a.node_id,a.capture_config_id,a.state,a.message,a.received_at,NULL AS boot_id,NULL AS apply_seq FROM config_activation a JOIN device_desired_configs d ON d.node_id=a.node_id AND d.capture_config_id=a.capture_config_id JOIN capture_configs p ON p.id=d.capture_config_id WHERE a.node_id=? AND json_extract(p.config_json,'$.protocol') IS NOT 'campuspulse/2' UNION ALL SELECT c.node_id,c.activation_config_id,c.activation_state,c.activation_message,c.activation_received_at,c.boot_id,c.apply_seq FROM device_control_v2 c JOIN device_desired_configs d ON d.node_id=c.node_id AND d.capture_config_id=c.activation_config_id WHERE c.node_id=?`).bind(id,id).first(),
          env.DB.prepare(`SELECT id,capture_config_id,state,message,received_at,NULL AS boot_id,NULL AS apply_seq FROM config_activation_events WHERE node_id=? UNION ALL SELECT id,capture_config_id,state,message,received_at,boot_id,apply_seq FROM config_activation_events_v2 WHERE node_id=? ORDER BY received_at DESC,id DESC LIMIT 100`).bind(id,id).all(),
        ]);
        return json({ device, placements: placements.results.slice(0, 200).map(placementFromRow), configs: configs.results.slice(0, 200).map(publishedFromRow),
          activation: { current: activation, history: events.results }, placements_truncated: placements.results.length > 200, configs_truncated: configs.results.length > 200 });
      }
      if (!action && request.method === 'PATCH') {
        const o = object(await readBody(request), [], ['name', 'board', 'enabled']);
        if (!Object.keys(o).length) fail('body');
        const entries: [string, unknown][] = [];
        if ('name' in o) entries.push(['name', label(o.name, 'name')]);
        if ('board' in o) entries.push(['board', label(o.board, 'board')]);
        if ('enabled' in o) { if (typeof o.enabled !== 'boolean') fail('enabled'); entries.push(['enabled', o.enabled ? 1 : 0]); }
        await transact([env.DB.prepare(`UPDATE device_nodes SET ${entries.map(([key]) => `${key}=?`).join(',')},updated_at=? WHERE id=?`)
          .bind(...entries.map(([, value]) => value), new Date().toISOString(), id)], 'device.update', id, { fields: Object.keys(o) });
        return json({ device: await findDevice(env, id) });
      }
      if (action === 'rotate-credential' && request.method === 'POST') {
        requireFreshSession(session);
        object(await readBody(request), []);
        const credential = `cpd_${Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')}`;
        const hash = await sha256(new TextEncoder().encode(credential));
        await transact([env.DB.prepare('UPDATE device_nodes SET credential_sha256=?,updated_at=? WHERE id=?').bind(hash, new Date().toISOString(), id)], 'device.rotate_credential', id, {}, [sessionAssertion(session, true)]);
        return json({ credential });
      }
      if (action === 'placements' && request.method === 'POST') {
        const o = object(await readBody(request), ['id', 'place_id', 'valid_from_ms', 'valid_until_ms'], ['observation_kinds']);
        const placementId = identifier(o.id, 'id');
        const place = o.place_id === null ? null : identifier(o.place_id, 'place_id');
        const from = integer(o.valid_from_ms, 'valid_from_ms', 0, 8640000000000000);
        const until = o.valid_until_ms === null ? null : integer(o.valid_until_ms, 'valid_until_ms', from + 1, 8640000000000000);
        const target = place === null ? null : await env.DB.prepare(`SELECT ${PLACE_COLUMNS} FROM places WHERE id=?`).bind(place).first<PlaceRow>();
        if (place !== null && !target) missing('place');
        const allowed = target ? JSON.parse(target.observation_kinds_json) as PlaceKind[] : null;
        const kinds: PlaceKind[] = 'observation_kinds' in o ? observationKinds(o.observation_kinds) : allowed ?? ['activity'];
        if (allowed && kinds.some(kind => !allowed.includes(kind))) fail('observation_kinds');
        // Recheck the target scope in the transaction before closing the prior
        // placement. A purpose edit racing this write must roll back both.
        const scope: Assertion[] = place === null ? [] : [{ sql: `EXISTS (SELECT 1 FROM places WHERE id=?) AND NOT EXISTS
          (SELECT 1 FROM json_each(?) selected WHERE NOT EXISTS
            (SELECT 1 FROM places p,json_each(p.observation_kinds_json) allowed WHERE p.id=? AND allowed.value=selected.value))`,
          bindings: [place, JSON.stringify(kinds), place] }];
        if (target && !('observation_kinds' in o)) scope.push({
          sql: 'EXISTS (SELECT 1 FROM places WHERE id=? AND observation_kinds_json=?)',
          bindings: [place, target.observation_kinds_json],
        });
        const now = new Date().toISOString();
        await transact([
          env.DB.prepare(`INSERT INTO placement_closures(placement_id,node_id,valid_until_ms,recorded_at)
            SELECT p.id,p.node_id,?,? FROM placements p LEFT JOIN placement_closures c ON c.placement_id=p.id
            WHERE p.node_id=? AND p.valid_until_ms IS NULL AND c.placement_id IS NULL AND p.valid_from_ms < ?`).bind(from, now, id, from),
          env.DB.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms,valid_until_ms,observation_kinds_json) VALUES (?,?,?,?,?,?)').bind(placementId, id, place, from, until, JSON.stringify(kinds)),
        ], 'placement.create', placementId, { node_id: id, place_id: place, observation_kinds: kinds, valid_from_ms: from, valid_until_ms: until }, scope);
        return json({ placement: { id: placementId, node_id: id, place_id: place, observation_kinds: kinds, valid_from_ms: from, valid_until_ms: until, effective_valid_until_ms: until, closed_at: null },
          requires_capture_config: true, requires_firmware_window_split: true }, 201);
      }
    }
    if (route === '/places') {
      if (request.method === 'GET') {
        const rows = await env.DB.prepare(`SELECT ${PLACE_COLUMNS} FROM places ORDER BY id LIMIT 501`).all<PlaceRow>();
        return json({ places: rows.results.slice(0, 500).map(placeFromRow), truncated: rows.results.length > 500 });
      }
      if (request.method === 'POST') {
        const o = object(await readBody(request), ['id', 'name', 'anchor'], ['kind', 'observation_kinds', 'gis_anchor']);
        const id = identifier(o.id, 'id'), name = label(o.name, 'name', 120), { kind, kinds } = placePurposes(o), point = anchor(o.anchor, 'anchor');
        const gis = o.gis_anchor === undefined || o.gis_anchor === null ? null : anchor(o.gis_anchor, 'gis_anchor', true);
        await transact([env.DB.prepare('INSERT INTO places(id,name,kind,observation_kinds_json,anchor_x,anchor_y,gis_anchor_x,gis_anchor_y) VALUES (?,?,?,?,?,?,?,?)')
          .bind(id, name, kind, JSON.stringify(kinds), point.x, point.y, gis?.x ?? null, gis?.y ?? null)], 'place.create', id, { kind, observation_kinds: kinds });
        return json({ place: { id, name, kind, observation_kinds: kinds, anchor: point, ...(gis ? { gis_anchor: { ...gis, verified: true } } : {}) } }, 201);
      }
    }
    const placeRoute = /^\/places\/([a-z0-9_-]{1,64})$/.exec(route);
    if (placeRoute && request.method === 'PATCH') {
      const id = placeRoute[1];
      if (!await env.DB.prepare('SELECT id FROM places WHERE id=?').bind(id).first()) missing('place');
      const o = object(await readBody(request), [], ['name', 'kind', 'observation_kinds', 'anchor', 'gis_anchor']);
      if (!Object.keys(o).length) fail('body');
      const entries: [string, unknown][] = [];
      if ('name' in o) entries.push(['name', label(o.name, 'name', 120)]);
      if ('kind' in o || 'observation_kinds' in o) { const { kind, kinds } = placePurposes(o); entries.push(['kind', kind], ['observation_kinds_json', JSON.stringify(kinds)]); }
      if ('anchor' in o) { const p = anchor(o.anchor, 'anchor'); entries.push(['anchor_x', p.x], ['anchor_y', p.y]); }
      if ('gis_anchor' in o) { const p = o.gis_anchor === null ? null : anchor(o.gis_anchor, 'gis_anchor', true); entries.push(['gis_anchor_x', p?.x ?? null], ['gis_anchor_y', p?.y ?? null]); }
      await transact([env.DB.prepare(`UPDATE places SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`).bind(...entries.map(([, value]) => value), id)],
        'place.update', id, { fields: Object.keys(o) });
      const row = await env.DB.prepare(`SELECT ${PLACE_COLUMNS} FROM places WHERE id=?`).bind(id).first<PlaceRow>();
      return json({ place: placeFromRow(row!) });
    }
    if (route === '/configs') {
      if (request.method === 'GET') {
        const node = url.searchParams.get('node_id');
        if (node !== null) identifier(node, 'node_id');
        const [drafts, configs] = await Promise.all([
          env.DB.prepare(`SELECT * FROM config_drafts WHERE published_at IS NULL ${node ? 'AND node_id=?' : ''} ORDER BY updated_at DESC,id DESC LIMIT 201`).bind(...(node ? [node] : [])).all<DraftRow>(),
          env.DB.prepare(`${PUBLISHED_SELECT} ${node ? 'WHERE c.node_id=?' : ''} ORDER BY c.accept_until_ms DESC,c.id DESC LIMIT 201`).bind(...(node ? [node] : [])).all<PublishedRow>(),
        ]);
        return json({ drafts: drafts.results.slice(0, 200).map(draftFromRow), configs: configs.results.slice(0, 200).map(publishedFromRow),
          drafts_truncated: drafts.results.length > 200, configs_truncated: configs.results.length > 200 });
      }
      if (request.method === 'POST') {
        const o = object(await readBody(request), ['config'], ['raw_retention_hours', 'aggregate_retention_days']);
        const { config, raw, aggregate } = await configInput(env, o);
        const now = new Date().toISOString();
        await transact([env.DB.prepare('INSERT INTO config_drafts(id,node_id,config_json,raw_retention_hours,aggregate_retention_days,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
          .bind(config.capture_config_id, config.node_id, JSON.stringify(config), raw, aggregate, now, now)], 'config.create_draft', config.capture_config_id,
        { node_id: config.node_id, dataset: config.dataset }, [{ sql: 'NOT EXISTS (SELECT 1 FROM capture_configs WHERE id=?)', bindings: [config.capture_config_id] }]);
        return json({ draft: draftFromRow(await findDraft(env, config.capture_config_id)) }, 201);
      }
    }
    const configRoute = /^\/configs\/([a-z0-9_-]{1,64})(?:\/(publish|validate))?$/.exec(route);
    if (configRoute) {
      const [, id, action] = configRoute;
      if (!action && request.method === 'PUT') {
        const o = object(await readBody(request), ['config', 'revision'], ['raw_retention_hours', 'aggregate_retention_days']);
        const revision = integer(o.revision, 'revision');
        const old = await findDraft(env, id);
        checkRevision(old, revision);
        const { config, raw, aggregate } = await configInput(env, { ...o,
          raw_retention_hours: o.raw_retention_hours === undefined ? old.raw_retention_hours : o.raw_retention_hours,
          aggregate_retention_days: o.aggregate_retention_days === undefined ? old.aggregate_retention_days : o.aggregate_retention_days });
        if (config.capture_config_id !== id) fail('config.capture_config_id');
        await transact([env.DB.prepare('UPDATE config_drafts SET node_id=?,config_json=?,raw_retention_hours=?,aggregate_retention_days=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND published_at IS NULL')
          .bind(config.node_id, JSON.stringify(config), raw, aggregate, new Date().toISOString(), id, revision)], 'config.update_draft', id,
        { node_id: config.node_id, revision: revision + 1 }, [revisionAssertion(id, revision)]);
        return json({ draft: draftFromRow(await findDraft(env, id)) });
      }
      if ((action === 'publish' || action === 'validate') && request.method === 'POST') {
        const o = object(await readBody(request), ['revision']);
        const revision = integer(o.revision, 'revision');
        const row = await findDraft(env, id);
        checkRevision(row, revision);
        const config = validateCaptureConfig(JSON.parse(row.config_json));
        await validateDraftRegistry(env, config);
        if (action === 'validate') return json({ valid: true, draft: draftFromRow(row) });
        const now = new Date().toISOString();
        await transact([
          env.DB.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms,raw_retention_hours,aggregate_retention_days) VALUES (?,?,?,?,?,?,?,?)')
            .bind(id, config.node_id, config.placement_id, config.dataset, JSON.stringify(config), Date.parse(config.accept_until), row.raw_retention_hours, row.aggregate_retention_days),
          env.DB.prepare('UPDATE config_drafts SET published_at=?,updated_at=? WHERE id=? AND revision=? AND published_at IS NULL').bind(now, now, id, revision),
          env.DB.prepare('INSERT INTO config_assignments(node_id,capture_config_id,assigned_at) VALUES (?,?,?)').bind(config.node_id, id, now),
          env.DB.prepare('INSERT INTO device_desired_configs(node_id,capture_config_id,assigned_at) VALUES (?,?,?) ON CONFLICT(node_id) DO UPDATE SET capture_config_id=excluded.capture_config_id,assigned_at=excluded.assigned_at').bind(config.node_id, id, now),
        ], 'config.publish', id, { node_id: config.node_id, placement_id: config.placement_id, dataset: config.dataset, capture_profile: config.capture_profile,
          raw_retention_hours: row.raw_retention_hours, aggregate_retention_days: row.aggregate_retention_days }, [revisionAssertion(id, revision), activePlacementAssertion(config)]);
        const published = await env.DB.prepare(`${PUBLISHED_SELECT} WHERE c.id=?`).bind(id).first<PublishedRow>();
        return json({ config: publishedFromRow(published!), desired_config_id: id });
      }
    }
    if (route === '/settings') {
      if (request.method === 'GET') return json(await readSettingsRecord(env));
      if (request.method === 'PUT') {
        const o = object(await readBody(request), ['settings', 'revision']);
        const settings = validateSettings(o.settings), revision = integer(o.revision, 'revision');
        await transact([env.DB.prepare('UPDATE admin_settings SET settings_json=?,revision=revision+1,updated_at=? WHERE id=1 AND revision=?')
          .bind(JSON.stringify(settings), new Date().toISOString(), revision)], 'settings.update', 'runtime', { revision: revision + 1, fields: Object.keys(settings) },
        [{ sql: 'EXISTS (SELECT 1 FROM admin_settings WHERE id=1 AND revision=?)', bindings: [revision] }]);
        return json(await readSettingsRecord(env));
      }
    }
    if (route === '/audit' && request.method === 'GET') {
      const before = url.searchParams.get('before');
      if (before !== null && !/^[1-9]\d{0,14}$/.test(before)) fail('before');
      const rows = await env.DB.prepare(`SELECT id,action,target,detail_json,created_at FROM admin_audit ${before ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT 101`)
        .bind(...(before ? [Number(before)] : [])).all<{ id: number; action: string; target: string; detail_json: string; created_at: string }>();
      return json({ entries: rows.results.slice(0, 100).map(({ detail_json, ...entry }) => ({ ...entry, detail: JSON.parse(detail_json) })),
        next_cursor: rows.results.length > 100 ? String(rows.results[99].id) : null });
    }
    if (['/session', '/overview', '/devices', '/places', '/configs', '/settings', '/audit'].includes(route) || deviceRoute || placeRoute || configRoute)
      throw new IngestError(405, 'method_not_allowed', 'Method is not supported for this administrator resource.');
    throw new IngestError(404, 'not_found', 'Unknown administrator endpoint.');
  } catch (error) {
    if (error instanceof IngestError) {
      const response = json({ error: { code: error.code, message: error.message, retryable: error.status >= 500 || error.status === 429 } }, error.status);
      if (error instanceof AuthRateLimitError) response.headers.set('Retry-After', String(error.retryAfterSeconds));
      return response;
    }
    return json({ error: { code: 'storage_unavailable', message: 'Administrator service temporarily unavailable.', retryable: true } }, 503);
  }
}
