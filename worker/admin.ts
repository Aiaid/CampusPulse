import type { Env, PlaceKind } from './types';
import { IngestError, parseIngestJson } from './strict-json';
import { DeviceV3ConfigError } from './device-v3-config';
import { handleAdminV3 } from './admin-v3';
import { json, readBytes, sha256 } from './http';
import { adminOrigin, adminSecret, requireAdminSession, requireFreshSession, sessionAssertion, AuthRateLimitError } from './admin-auth';
import { handleAdminIdentity } from './admin-account';
import { handleAdminMqtt } from './admin-mqtt';
import { reportAdminFailure } from './admin-errors';
import { DEVICE_SELECT, DEVICE_PLACEMENTS_SELECT } from './admin-device-query';
import { assignMqtt, decryptMqtt, mqttReadyAssertion, readyMqtt } from './mqtt-credentials';
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
  last_seen_at: string | null; firmware_version: string | null; reported_policy_id: string | null;
  desired_policy_id: string | null; activation_state: 'applied' | 'failed' | null;
  status_json: string | null; status_received_at: string | null; status_boot_id: string | null; status_policy_id: string | null; status_batch_id: string | null;
  ingestion_received_at: string | null; ingestion_boot_id: string | null; ingestion_stream: string | null; ingestion_batch_id: string | null;
  applied_policy_id: string | null; desired_generation: number | null; applied_generation: number | null; control_boot_id: string | null;
  mqtt_state: 'pending_broker' | 'ready' | 'assigned' | null; mqtt_verified_at: string | null; mqtt_namespace: string | null;
}

function deviceFromRow(row: DeviceRow, staleSeconds: number, now: number) {
  const lastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : NaN;
  return { id: row.id, name: row.name || row.id, board: row.board, enabled: row.enabled === 1,
    // Registry assignment and broker verification do not prove that this device
    // has saved the identity or successfully connected with it.
    mqtt_assignment: { state: row.mqtt_state ?? 'unconfigured', broker_verified: row.mqtt_verified_at !== null, namespace: row.mqtt_namespace },
    last_seen_at: row.last_seen_at || null,
    contact_state: !Number.isFinite(lastSeen) ? 'unknown' : now - lastSeen <= staleSeconds * 1000 ? 'recent' : 'stale',
    firmware_version: row.firmware_version,
    latest_status: row.status_json ? { item: JSON.parse(row.status_json), received_at: row.status_received_at, boot_id: row.status_boot_id, policy_id: row.status_policy_id, batch_id: row.status_batch_id } : null,
    protocol: 'campuspulse/3', boot_id: row.control_boot_id, desired_generation: row.desired_generation, applied_generation: row.applied_generation,
    latest_ingestion: row.ingestion_received_at ? { received_at: row.ingestion_received_at, boot_id: row.ingestion_boot_id, stream: row.ingestion_stream, batch_id: row.ingestion_batch_id, policy_id: row.reported_policy_id } : null,
    server_time: new Date(now).toISOString(), stale_after_seconds: staleSeconds,
    applied_policy_id: row.applied_policy_id,
    desired_policy_id: row.desired_policy_id, reported_policy_id: row.reported_policy_id,
    config_state: !row.desired_policy_id ? 'unassigned' : row.activation_state ?? 'pending' };
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
    const v3 = await handleAdminV3(request, env, route);
    if (v3) return v3;
    const transact = (writes: D1PreparedStatement[], action: string, target: string, detail: ObjectValue, assertions: Assertion[] = []) =>
      atomic(env, writes, action, target, detail, [sessionAssertion(session), ...assertions]);
    const mqttAdmin = await handleAdminMqtt(request, env, route, session, transact);
    if (mqttAdmin) return mqttAdmin;
    if (route === '/overview' && request.method === 'GET') {
      const settings = await readRuntimeSettings(env);
      const since = new Date(Date.now() - settings.stale_after_seconds * 1000).toISOString();
      const row = await env.DB.prepare(`SELECT COUNT(*) AS devices_total,COALESCE(SUM(enabled),0) AS devices_enabled,
        COALESCE(SUM(last_seen_at >= ?),0) AS devices_recent,COALESCE(SUM(last_seen_at < ?),0) AS devices_stale,
        COALESCE(SUM(last_seen_at IS NULL),0) AS devices_unknown,
        COALESCE(SUM(desired_policy_id IS NOT NULL AND (activation_state IS NULL OR activation_state != 'applied')),0) AS config_pending
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
        // Registry, assignment and audit share one D1 transaction. Retry only
        // a competing pool allocation; never create a half-enrolled node.
        for (let attempt = 0; attempt < 4; attempt++) {
          if (await env.DB.prepare('SELECT id FROM device_nodes WHERE id=?').bind(id).first()) conflict();
          const pool = await readyMqtt(env), mqtt = await decryptMqtt(env, pool);
          try {
            await transact([env.DB.prepare('INSERT INTO device_nodes(id,credential_sha256,name,board,created_at,updated_at) VALUES (?,?,?,?,?,?)')
              .bind(id, hash, name, board, now, now), assignMqtt(env, pool, id)], 'device.register', id,
              { fields: ['name', 'board'], mqtt_pool_id: pool.id }, [sessionAssertion(session, true), mqttReadyAssertion(pool)]);
            return json({ device: await findDevice(env, id), credential, mqtt }, 201);
          } catch (error) {
            if (!(error instanceof IngestError) || error.code !== 'revision_conflict') throw error;
            const winner = await env.DB.prepare('SELECT state,node_id FROM mqtt_credentials WHERE id=?').bind(pool.id).first<{state:string;node_id:string|null}>();
            if (winner?.state === 'ready' || winner?.node_id === id) throw error;
          }
        }
        throw new IngestError(409, 'mqtt_pool_busy', 'MQTT identities were allocated concurrently. Retry enrollment.');
      }
    }
    const deviceRoute = /^\/devices\/([a-z0-9_-]{1,64})(?:\/(rotate-credential|placements))?$/.exec(route);
    if (deviceRoute) {
      const [, id, action] = deviceRoute;
      await requireDevice(env, id);
      if (!action && request.method === 'GET') {
        const [device, placements] = await Promise.all([findDevice(env, id), env.DB.prepare(DEVICE_PLACEMENTS_SELECT).bind(id).all<PlacementRow>()]);
        return json({ device, placements: placements.results.slice(0,200).map(placementFromRow), placements_truncated: placements.results.length>200 });
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
          requires_v3_assignment: true, requires_firmware_window_split: true }, 201);
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
    if (['/session', '/overview', '/devices', '/places', '/settings', '/audit'].includes(route) || deviceRoute || placeRoute)
      throw new IngestError(405, 'method_not_allowed', 'Method is not supported for this administrator resource.');
    throw new IngestError(404, 'not_found', 'Unknown administrator endpoint.');
  } catch (error) {
    if (error instanceof DeviceV3ConfigError) return json({ error: { code: error.code, message: error.message, retryable: false } }, 422);
    if (error instanceof IngestError) {
      const response = json({ error: { code: error.code, message: error.message, retryable: error.status >= 500 || error.status === 429 } }, error.status);
      if (error instanceof AuthRateLimitError) response.headers.set('Retry-After', String(error.retryAfterSeconds));
      return response;
    }
    const requestId = reportAdminFailure(request, error);
    const response = json({ error: { code: 'storage_unavailable', message: 'Administrator service temporarily unavailable.', retryable: true, request_id: requestId } }, 503);
    response.headers.set('X-Request-ID', requestId);
    return response;
  }
}
