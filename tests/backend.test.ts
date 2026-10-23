import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleApi, summarize, validateObservation } from '../worker/index';
import type { Env, Observation, Place } from '../worker/types';

// Executes the production migration and SQL against SQLite, rather than matching
// query strings in a mock. Cloudflare deployment/runtime acceptance is separate.
function sqliteD1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let bindings: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { bindings = values; return statement; },
        async first() { return db.prepare(sql).get(...bindings as []) ?? null; },
        async all() { return { results: db.prepare(sql).all(...bindings as []), success: true, meta: {} }; },
        async run() { const result = db.prepare(sql).run(...bindings as []); return { success: true, meta: { changes: Number(result.changes) } }; },
      };
      return statement;
    },
  } as unknown as D1Database;
}

let db: DatabaseSync;
let env: Env;
const id = '12345678-1234-4234-8234-123456789abc';
const body = () => ({ id, place_id: 'east-parking', kind: 'parking', observed_at: new Date().toISOString(), parking_min: 3, parking_max: 6 });
const api = async (path: string, init?: RequestInit) => {
  const response = await handleApi(new Request(`http://localhost${path}`, init), env);
  if (!response) throw new Error('Expected API response');
  return response;
};
const post = (value: unknown, authorization = 'Bearer test-operator') => api('/api/v1/observations', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization }, body: JSON.stringify(value),
});

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  env = { DB: sqliteD1(db), OPERATOR_TOKEN: 'test-operator' };
});
afterEach(() => db.close());

describe('public read API', () => {
  it('returns schematic places and honest empty summaries', async () => {
    const places = await (await api('/api/v1/places')).json() as { places: Place[] };
    expect(places.places).toHaveLength(3);
    expect(places.places.every(p => p.coverage === 'unconfigured')).toBe(true);
    expect(places.places.find(p => p.id === 'library')?.gis_anchor).toEqual({
      x: 15656 / 24576, y: 9059 / 24576, verified: true,
    });
    expect(places.places.find(p => p.id === 'east-parking')?.gis_anchor).toBeUndefined();
    expect(places.places.find(p => p.id === 'teaching-elevator')?.gis_anchor).toBeUndefined();
    const summary = await (await api('/api/v1/places/library/summary')).json();
    expect(summary).toMatchObject({ sensor: null, latest_observation: null, freshness: 'no_data' });
    expect((await api('/api/v1/places/unknown/summary')).status).toBe(404);
  });

  it('rejects unbounded history ranges', async () => {
    expect((await api('/api/v1/places/library/history?minutes=999999')).status).toBe(422);
    const history = await (await api('/api/v1/places/library/history?minutes=1')).json();
    expect(history).toMatchObject({ observations: [], truncated: false });
  });
});

describe('authenticated manual observations', () => {
  it('fails closed before writing when auth is wrong or unconfigured', async () => {
    expect((await post(body(), 'Bearer wrong')).status).toBe(401);
    delete env.OPERATOR_TOKEN;
    expect((await post(body())).status).toBe(503);
    expect(db.prepare('SELECT COUNT(*) AS n FROM observations').get()?.n).toBe(0);
  });

  it('stores manual data, retries idempotently, and rejects changed content', async () => {
    const data = body();
    expect((await post(data)).status).toBe(201);
    expect((await post(data)).status).toBe(200);
    expect((await post({ ...data, parking_max: 7 })).status).toBe(409);
    expect(db.prepare('SELECT COUNT(*) AS n FROM observations').get()?.n).toBe(1);
    const summary = await (await api('/api/v1/places/east-parking/summary')).json();
    expect(summary).toMatchObject({ freshness: 'fresh', sensor: null, latest_observation: { source: 'manual', parking_min: 3, parking_max: 6 } });
  });

  it('cancels without deleting evidence or resurrecting on retry', async () => {
    const data = body();
    await post(data);
    const cancel = () => api(`/api/v1/observations/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer test-operator' } });
    expect((await cancel()).status).toBe(200);
    expect((await cancel()).status).toBe(200);
    expect((await post(data)).status).toBe(200);
    const summary = await (await api('/api/v1/places/east-parking/summary')).json();
    expect(summary).toMatchObject({ latest_observation: null, freshness: 'no_data' });
    expect(db.prepare('SELECT status FROM observations WHERE id = ?').get(id)?.status).toBe('cancelled');
  });

  it('rejects malformed, extra, mismatched and oversized input before storage', async () => {
    expect((await post({ ...body(), parking_min: 9 })).status).toBe(422);
    expect((await post({ ...body(), source: 'sensor' })).status).toBe(422);
    expect((await post({ ...body(), place_id: 'library' })).status).toBe(422);
    expect((await post({ ...body(), observed_at: '2026-02-30T00:00:00.000Z' })).status).toBe(422);
    expect((await post({ ...body(), extra: 'x'.repeat(9000) })).status).toBe(413);
    expect(db.prepare('SELECT COUNT(*) AS n FROM observations').get()?.n).toBe(0);
  });

  it('rejects cross-origin writes', async () => {
    const response = await api('/api/v1/observations', {
      method: 'POST', headers: { Authorization: 'Bearer test-operator', Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: JSON.stringify(body()),
    });
    expect(response.status).toBe(403);
  });

  it('preserves zero measured waits, excludes cancelled records from history', async () => {
    const data = { id, place_id: 'teaching-elevator', kind: 'elevator', observed_at: new Date().toISOString(), wait_seconds: 0 };
    expect((await post(data)).status).toBe(201);
    const result = await (await api('/api/v1/places/teaching-elevator/history?minutes=15')).json() as { observations: Observation[] };
    expect(result.observations[0].wait_seconds).toBe(0);
    expect(result.observations[0].parking_min).toBeNull();
    await api(`/api/v1/observations/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer test-operator' } });
    expect(await (await api('/api/v1/places/teaching-elevator/history')).json()).toMatchObject({ observations: [] });
  });
});

it('marks freshness by observation expiry rather than receive time', () => {
  const place = { id: 'p', name: 'P', kind: 'parking', anchor: { x: 0, y: 0 }, coverage: 'unconfigured' } as const;
  const observation = { valid_until: '2026-10-23T00:15:00.000Z' } as Observation;
  expect(summarize(place, observation, Date.parse('2026-10-23T00:15:00.000Z')).freshness).toBe('stale');
  expect(() => validateObservation({ ...body(), observed_at: new Date(Date.now() + 60_000).toISOString() })).toThrow();
});
