import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cachePublicRead } from '../worker/public-cache';

const origin = 'https://public.example.test';
const summary = '/api/v1/places/library/summary';
const request = (path = summary, init?: RequestInit) => new Request(origin + path, init);
const snapshot = (value: unknown, init: ResponseInit = {}) => Response.json(value, {
  ...init, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...init.headers },
});
let now: number;
let rows: Map<string, { response: Response; expires: number }>;
let cache: { match: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };

beforeEach(() => {
  now = 1_000_000;
  rows = new Map();
  cache = {
    match: vi.fn(async (key: Request) => {
      const row = rows.get(key.url);
      if (!row || row.expires <= now) { rows.delete(key.url); return undefined; }
      return row.response.clone();
    }),
    put: vi.fn(async (key: Request, response: Response) => {
      const ttl = Number(/max-age=(\d+)/.exec(response.headers.get('Cache-Control') ?? '')?.[1]);
      // Consume the stored stream, as the platform does, to expose clone bugs.
      const body = await response.arrayBuffer();
      rows.set(key.url, { response: new Response(body, response), expires: now + ttl * 1000 });
    }),
  };
  vi.stubGlobal('caches', { default: cache });
});
afterEach(() => vi.unstubAllGlobals());

it('reuses a public snapshot without consuming subsequent responses or changing as_of', async () => {
  const read = vi.fn(async () => snapshot({ as_of: `snapshot-${read.mock.calls.length}`, value: 7 }));
  const first = await cachePublicRead(request(), read);
  const expected = await first.json();
  const second = await cachePublicRead(request(), read);
  second.headers.set('X-Only-This-Response', 'yes');
  expect(await second.json()).toEqual(expected);
  const third = await cachePublicRead(request(), read);
  expect(await third.json()).toEqual(expected);
  expect(third.headers.has('X-Only-This-Response')).toBe(false);
  expect(first.headers.get('Cache-Control')).toBe('no-store');
  expect(second.headers.get('Cache-Control')).toBe('no-store');
  expect(first.headers.get('X-CampusPulse-Cache')).toBe('MISS');
  expect(second.headers.get('X-CampusPulse-Cache')).toBe('HIT');
  expect(third.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect([...rows.values()][0].response.headers.get('Cache-Control')).toBe('public, max-age=10');
  expect(read).toHaveBeenCalledTimes(1);
});

it.each([
  ['/api/v1/places', 60], ['/api/v1/settings', 10], [summary, 10], ['/api/v1/places/library/history?minutes=60', 30],
])('expires %s after %i seconds', async (path, ttl) => {
  const read = vi.fn(async () => snapshot({ version: read.mock.calls.length }));
  await cachePublicRead(request(path), read);
  now += ttl * 1000 - 1;
  expect(await (await cachePublicRead(request(path), read)).json()).toEqual({ version: 1 });
  now++;
  expect(await (await cachePublicRead(request(path), read)).json()).toEqual({ version: 2 });
  expect(read).toHaveBeenCalledTimes(2);
});

it('normalizes the default range, separates places/routes/origins/ranges, and omits client headers from keys', async () => {
  const read = vi.fn(async () => snapshot({ version: read.mock.calls.length }));
  const history = '/api/v1/places/library/history';
  await cachePublicRead(request(history, { headers: { 'CF-Connecting-IP': '192.0.2.1', Cookie: 'anonymous=synthetic' } }), read);
  await cachePublicRead(request(history + '?minutes=%31%35', { headers: { 'CF-Connecting-IP': '192.0.2.2', Cookie: 'admin=synthetic' } }), read);
  expect(read).toHaveBeenCalledTimes(1);
  for (const path of [history + '?minutes=1', '/api/v1/places/east-parking/history', summary, '/api/v1/settings', '/api/v1/places']) {
    await cachePublicRead(request(path), read);
  }
  await cachePublicRead(new Request('https://another.example.test' + history), read);
  expect(read).toHaveBeenCalledTimes(7);
  const key = cache.put.mock.calls[0][0] as Request;
  expect([...key.headers]).toEqual([]);
  expect(new URL(key.url).searchParams.get('minutes')).toBe('15');
});

const refreshHeaders: Record<string, string>[] = [
  { 'Cache-Control': 'no-cache' }, { 'Cache-Control': 'max-age=0, NO-STORE' },
  { 'Cache-Control': 'no-cache="some-header"' }, { Pragma: 'no-cache' },
];
it.each(refreshHeaders)('bypasses both cache reads and writes for explicit refresh %j', async headers => {
  const read = vi.fn(async () => snapshot({ version: read.mock.calls.length }));
  await cachePublicRead(request(), read);
  const refreshed = await cachePublicRead(request(summary, { headers }), read);
  expect(await refreshed.json()).toEqual({ version: 2 });
  expect(refreshed.headers.get('X-CampusPulse-Cache')).toBe('BYPASS');
  expect(cache.match).toHaveBeenCalledTimes(1);
  expect(cache.put).toHaveBeenCalledTimes(1);
  expect(await (await cachePublicRead(request(), read)).json()).toEqual({ version: 1 });
});

it.each([
  ['/api/v1/admin/devices', {}], ['/api/v1/device/config', {}], ['/api/v2/device/config', {}],
  ['/api/v2/research/batches/example', {}], ['/api/v1/health', {}], ['/api/v1/places/library/summary/', {}],
  ['/api/v2/ingest', { method: 'POST' }], [summary, { method: 'POST' }], [summary, { method: 'HEAD' }],
  [summary, { headers: { Authorization: 'Bearer synthetic-test-only' } }],
  [summary, { headers: { Range: 'bytes=0-1' } }],
  [summary + '?unexpected=1', {}], ['/api/v1/settings?unexpected=1', {}],
  ['/api/v1/places/library/history?minutes=2', {}], ['/api/v1/places/library/history?minutes=', {}],
  ['/api/v1/places/library/history?minutes=15&minutes=15', {}], ['/api/v1/places/library/history?minutes=15&extra=1', {}],
])('never caches excluded request %s %j', async (path, init) => {
  const read = vi.fn(async () => snapshot({ value: 'fresh' }));
  await cachePublicRead(request(path, init), read);
  await cachePublicRead(request(path, init), read);
  expect(read).toHaveBeenCalledTimes(2);
  expect(cache.match).not.toHaveBeenCalled();
  expect(cache.put).not.toHaveBeenCalled();
});

const excludedResponses: ResponseInit[] = [
  { status: 404 }, { status: 503 }, { status: 206 }, { status: 302 },
  { headers: { 'Set-Cookie': 'session=synthetic-test-only' } },
  { headers: { Vary: 'Cookie' } }, { headers: { 'Cache-Control': 'private, no-store' } },
];
it.each(excludedResponses)('never stores errors, partial responses, redirects, or personalized responses: %j', async init => {
  const read = vi.fn(async () => snapshot({ value: 'uncached' }, init));
  const response = await cachePublicRead(request(), read);
  expect(response.headers.get('X-CampusPulse-Cache')).toBe('BYPASS');
  await cachePublicRead(request(), read);
  expect(read).toHaveBeenCalledTimes(2);
  expect(cache.put).not.toHaveBeenCalled();
});

it('tracks background writes with waitUntil and still returns an independent body', async () => {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil(promise: Promise<unknown>) { expect(this).toBe(ctx); pending.push(promise); } };
  const response = await cachePublicRead(request(), async () => snapshot({ as_of: 'original' }), ctx);
  expect(pending).toHaveLength(1);
  expect(await response.json()).toEqual({ as_of: 'original' });
  await Promise.all(pending);
  expect(rows.size).toBe(1);
});

it('works without the Worker Cache API and tolerates cache failures', async () => {
  const read = vi.fn(async () => snapshot({ value: 3 }));
  vi.stubGlobal('caches', undefined);
  expect(await (await cachePublicRead(request(), read)).json()).toEqual({ value: 3 });
  vi.stubGlobal('caches', { default: cache });
  cache.match.mockRejectedValue(new Error('synthetic cache unavailable'));
  cache.put.mockRejectedValue(new Error('synthetic cache unavailable'));
  expect(await (await cachePublicRead(request(), read)).json()).toEqual({ value: 3 });
  expect(read).toHaveBeenCalledTimes(2);
});
