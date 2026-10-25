import type { CreateObservation, Env, Observation, Place, PlaceSummary } from './types';
import { handleDocs } from './docs';
import { handleIngestion } from './ingest';
import { handleDeviceV2 } from './device-v2';
import { readLastReportedSensor, readPublicWindows } from './sensors';
import { expireIngestion } from './retention';
import { handleAdmin, readPublicSettings, readRuntimeSettings } from './admin';
import { readAutomaticObservations } from './place-inference';

const MAX_BODY = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBS_COLUMNS = 'id,place_id,kind,source,status,observed_at,valid_until,parking_min,parking_max,wait_seconds';
interface PlaceRow { id: string; name: string; kind: Place['kind']; observation_kinds_json: string; anchor_x: number; anchor_y: number; gis_anchor_x: number | null; gis_anchor_y: number | null }
const PLACE_COLUMNS = 'id,name,kind,observation_kinds_json,anchor_x,anchor_y,gis_anchor_x,gis_anchor_y';

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

const placeFromRow = (row: PlaceRow): Place => ({
  id: row.id, name: row.name, kind: row.kind, observation_kinds: JSON.parse(row.observation_kinds_json),
  anchor: { x: row.anchor_x, y: row.anchor_y }, coverage: 'unconfigured',
  ...(row.gis_anchor_x !== null && row.gis_anchor_y !== null
    ? { gis_anchor: { x: row.gis_anchor_x, y: row.gis_anchor_y, verified: true } } : {}),
});

async function findPlace(env: Env, id: string): Promise<Place> {
  const row = await env.DB.prepare(`SELECT ${PLACE_COLUMNS} FROM places WHERE id = ?`).bind(id).first<PlaceRow>();
  if (!row) throw new ApiError(404, 'place_not_found', 'Unknown place.');
  return placeFromRow(row);
}

export function summarize(place: Place, observation: Observation | null, now = Date.now(), latest: PlaceSummary['latest_observations'] = {
  parking: observation?.kind === 'parking' ? observation : null,
  elevator: observation?.kind === 'elevator' ? observation : null,
}): PlaceSummary {
  const records = [observation, latest.parking, latest.elevator].filter((row): row is Observation => row !== null);
  return {
    place, sensor: null, latest_observation: observation, latest_observations: latest,
    freshness: records.some(row => Date.parse(row.valid_until) > now) ? 'fresh' : records.length ? 'stale' : 'no_data',
    as_of: new Date(now).toISOString(),
  };
}

async function authorize(request: Request, env: Env) {
  if (!env.OPERATOR_TOKEN) throw new ApiError(503, 'operator_not_configured', 'Manual entry is not configured.');
  const supplied = request.headers.get('Authorization') ?? '';
  const expected = `Bearer ${env.OPERATOR_TOKEN}`;
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(supplied), digest(expected)]);
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i] ^ b[i];
  if (different) throw new ApiError(401, 'unauthorized', 'Operator credential required.');
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) throw new ApiError(403, 'origin_rejected', 'Cross-origin writes are not accepted.');
}

async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'content_type', 'Use application/json.');
  }
  if (request.headers.get('Content-Encoding')) throw new ApiError(415, 'content_encoding', 'Compressed requests are not supported.');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'invalid_json', 'A JSON body is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw new ApiError(413, 'payload_too_large', 'Body exceeds 8 KiB.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ApiError(400, 'invalid_json', 'Invalid JSON body.'); }
}

export function validateObservation(value: unknown, now = Date.now()): CreateObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(422, 'invalid_observation', 'Expected an observation object.');
  const data = value as Record<string, unknown>;
  const keys = ['id', 'place_id', 'kind', 'observed_at', 'parking_min', 'parking_max', 'wait_seconds'];
  if (Object.keys(data).some(key => !keys.includes(key))) throw new ApiError(422, 'unknown_field', 'Unknown observation field.');
  if (typeof data.id !== 'string' || !UUID.test(data.id) || typeof data.place_id !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(data.place_id)) {
    throw new ApiError(422, 'invalid_identity', 'Provide a UUIDv4 observation id and valid place id.');
  }
  const timestamp = typeof data.observed_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.observed_at) ? Date.parse(data.observed_at) : NaN;
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== data.observed_at || timestamp < now - 86_400_000 || timestamp > now + 30_000) {
    throw new ApiError(422, 'invalid_time', 'Observation time must be ISO UTC within the last 24 hours and no more than 30 seconds ahead.');
  }
  const integer = (n: unknown, max: number) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max;
  if (data.kind === 'parking') {
    if (!integer(data.parking_min, 10000) || !integer(data.parking_max, 10000) || (data.parking_min as number) > (data.parking_max as number) || 'wait_seconds' in data) {
      throw new ApiError(422, 'invalid_parking', 'Provide a parking range from 0 to 10000.');
    }
  } else if (data.kind === 'elevator') {
    if (!integer(data.wait_seconds, 7200) || 'parking_min' in data || 'parking_max' in data) throw new ApiError(422, 'invalid_wait', 'Provide a measured wait from 0 to 7200 seconds.');
  } else throw new ApiError(422, 'invalid_kind', 'Manual kind must be parking or elevator.');
  return data as unknown as CreateObservation;
}

export async function handleApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;
  try {
    const admin = await handleAdmin(request, env);
    if (admin) return admin;
    const ingestion = await handleIngestion(request, env);
    if (ingestion) return ingestion;
    const deviceV2 = await handleDeviceV2(request, env);
    if (deviceV2) return deviceV2;
    if (url.pathname === '/api/v1/health' && request.method === 'GET') return json({ status: 'ok', ingestion: 'implemented', raw_storage: env.RAW_BUCKET ? 'configured' : 'unconfigured' });
    if (url.pathname === '/api/v1/settings' && request.method === 'GET') return json(await readPublicSettings(env));
    if (url.pathname === '/api/v1/places' && request.method === 'GET') {
      const result = await env.DB.prepare(`SELECT ${PLACE_COLUMNS} FROM places ORDER BY id`).all<PlaceRow>();
      return json({ places: result.results.map(placeFromRow) });
    }
    const route = /^\/api\/v1\/places\/([a-z0-9_-]{1,64})\/(summary|history)$/.exec(url.pathname);
    if (route && request.method === 'GET') {
      const place = await findPlace(env, route[1]);
      if (route[2] === 'summary') {
        // One snapshot returns the latest active record independently per manual
        // purpose, including retained evidence for purposes since disabled.
        const rows = await env.DB.prepare(`SELECT ${OBS_COLUMNS} FROM (SELECT ${OBS_COLUMNS},
          ROW_NUMBER() OVER (PARTITION BY kind ORDER BY observed_at DESC,id DESC) AS rank
          FROM observations WHERE place_id=? AND status='active') WHERE rank=1 ORDER BY observed_at DESC,id DESC`)
          .bind(place.id).all<Observation>();
        const latest = rows.results[0] ?? null;
        const latestByKind = { parking: rows.results.find(row => row.kind === 'parking') ?? null,
          elevator: rows.results.find(row => row.kind === 'elevator') ?? null };
        const now = Date.now();
        const windows = await readPublicWindows(env, place.id, now - 86_400_000, now);
        const summary = summarize(place, latest, now, latestByKind);
        const sensor = windows[0] ?? null;
        const last_reported_sensor = sensor ? null : await readLastReportedSensor(env, place.id, now);
        const automatic_observations = await readAutomaticObservations(env, place, windows, now);
        return json({ ...summary, sensor, last_reported_sensor, automatic_observations, freshness: sensor?.freshness === 'fresh' || summary.freshness === 'fresh' ? 'fresh' : sensor || latest ? 'stale' : 'no_data' });
      }
      const minutesText = url.searchParams.get('minutes') ?? '15';
      if (!['1', '5', '15', '60', '1440'].includes(minutesText)) throw new ApiError(422, 'invalid_range', 'minutes must be 1, 5, 15, 60, or 1440.');
      const to = new Date().toISOString();
      const from = new Date(Date.parse(to) - Number(minutesText) * 60_000).toISOString();
      const result = await env.DB.prepare(`SELECT ${OBS_COLUMNS} FROM observations WHERE place_id = ? AND status = 'active' AND observed_at >= ? AND observed_at <= ? ORDER BY observed_at DESC, id DESC LIMIT 201`).bind(place.id, from, to).all<Observation>();
      const windows = await readPublicWindows(env, place.id, Date.parse(from), Date.parse(to));
      return json({ place_id: place.id, observations: result.results.slice(0, 200), sensor_windows: windows.slice(0, 200), from, to, truncated: result.results.length > 200, sensor_truncated: windows.length > 200 });
    }
    if (url.pathname === '/api/v1/observations' && request.method === 'POST') {
      await authorize(request, env);
      const observation = validateObservation(await readJson(request));
      const place = await findPlace(env, observation.place_id);
      const existing = await env.DB.prepare('SELECT id FROM observations WHERE id=?').bind(observation.id).first();
      if (!existing && !place.observation_kinds.includes(observation.kind)) throw new ApiError(422, 'place_kind_mismatch', 'Observation purpose must be enabled for the place.');
      const settings = await readRuntimeSettings(env);
      const validUntil = new Date(Date.parse(observation.observed_at) + settings.observation_ttl_minutes * 60_000).toISOString();
      const min = observation.parking_min ?? null;
      const max = observation.parking_max ?? null;
      const wait = observation.wait_seconds ?? null;
      let inserted: D1Result;
      try {
        inserted = await env.DB.prepare('INSERT INTO observations (id,place_id,kind,observed_at,valid_until,received_at,parking_min,parking_max,wait_seconds) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
          .bind(observation.id, observation.place_id, observation.kind, observation.observed_at, validUntil, new Date().toISOString(), min, max, wait).run();
      } catch (error) {
        const messages: string[] = [];
        for (let cause: unknown = error, depth = 0; cause instanceof Error && depth < 4; cause = cause.cause, depth++) messages.push(cause.message);
        if (messages.some(message => message.includes('place_kind_conflict'))) throw new ApiError(422, 'place_kind_mismatch', 'Observation purpose must be enabled for the place.');
        throw error;
      }
      const stored = await env.DB.prepare(`SELECT ${OBS_COLUMNS} FROM observations WHERE id = ?`).bind(observation.id).first<Observation>();
      if (!stored) throw new Error('Missing committed observation');
      if (stored.place_id !== observation.place_id || stored.kind !== observation.kind || stored.observed_at !== observation.observed_at || stored.parking_min !== min || stored.parking_max !== max || stored.wait_seconds !== wait) {
        throw new ApiError(409, 'observation_conflict', 'Observation id already has different content.');
      }
      return json({ observation: stored, durability: 'committed' }, inserted.meta.changes ? 201 : 200);
    }
    const cancel = /^\/api\/v1\/observations\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (cancel && request.method === 'DELETE') {
      await authorize(request, env);
      await env.DB.prepare("UPDATE observations SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, ?) WHERE id = ?").bind(new Date().toISOString(), cancel[1]).run();
      const observation = await env.DB.prepare(`SELECT ${OBS_COLUMNS} FROM observations WHERE id = ?`).bind(cancel[1]).first<Observation>();
      if (!observation) throw new ApiError(404, 'observation_not_found', 'Unknown observation.');
      return json({ observation, durability: 'committed' });
    }
    return json({ error: { code: 'not_found', message: 'API route not found.', retryable: false } }, 404);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message, retryable: error.status >= 500 } }, error.status);
    return json({ error: { code: 'storage_unavailable', message: 'Service temporarily unavailable.', retryable: true } }, 503);
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await expireIngestion(env);
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleDocs(request) ?? await handleApi(request, env) ?? (env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 }));
  },
};
