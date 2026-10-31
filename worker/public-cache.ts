interface CacheContext { waitUntil(promise: Promise<unknown>): void }
interface PublicCachePlan { key: Request; ttl: number; sensor: boolean }

const HISTORY_MINUTES = new Set(['1', '5', '15', '60', '1440']);
const BYPASS = /(?:^|,)\s*(?:no-cache|no-store)\s*(?:=|,|$)/i;

function publicCachePlan(request: Request): PublicCachePlan | null {
  if (request.method !== 'GET' || request.headers.has('Authorization') ||
      request.headers.has('Range') || BYPASS.test(request.headers.get('Cache-Control') ?? '') ||
      BYPASS.test(request.headers.get('Pragma') ?? '')) return null;
  const url = new URL(request.url);
  if (!['https:', 'http:'].includes(url.protocol)) return null;
  const route = /^\/api\/v1\/places\/[a-z0-9_-]{1,64}\/(summary|history)$/.exec(url.pathname);
  let ttl: number;
  if (url.pathname === '/api/v1/places') ttl = 60;
  else if (url.pathname === '/api/v1/settings' || route?.[1] === 'summary') ttl = 10;
  else if (route?.[1] === 'history') ttl = 30;
  else return null;

  if (route?.[1] === 'history') {
    if ([...url.searchParams.keys()].some(key => key !== 'minutes') || url.searchParams.getAll('minutes').length > 1) return null;
    const minutes = url.searchParams.get('minutes') ?? '15';
    if (!HISTORY_MINUTES.has(minutes)) return null;
    url.search = '';
    url.searchParams.set('minutes', minutes);
  } else if (url.searchParams.size) return null;

  // A versioned, header-free key shares only the public snapshot. It never
  // incorporates client addresses, credentials, cookies or arbitrary queries.
  url.hash = '';
  url.searchParams.set('__campuspulse_public_cache', '3');
  return { key: new Request(url.toString(), { method: 'GET' }), ttl, sensor: !!route };
}

function isPublicResponse(response: Response): boolean {
  return response.status === 200 && !response.headers.has('Set-Cookie') && !response.headers.has('Vary') &&
    !/(?:^|,)\s*private\s*(?:=|,|$)/i.test(response.headers.get('Cache-Control') ?? '') &&
    response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() === 'application/json';
}

function withHeaders(response: Response, changes: Record<string, string>): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(changes)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Cache only bounded public snapshots at the serving edge. These allowlisted
 * handlers return identical public data regardless of cookies; personalized
 * routes must remain outside the allowlist. Browser
 * responses remain no-store; as_of/from/to retain the original snapshot time.
 * Explicit refreshes bypass reads and writes. Other clients converge after the
 * short TTL, without adding invalidation writes to ingestion or private routes. */
export async function cachePublicRead(request: Request, read: () => Promise<Response>, ctx?: CacheContext): Promise<Response> {
  const plan = publicCachePlan(request);
  // DOM CacheStorage omits Cloudflare's optional default-cache extension.
  const cache = typeof caches === 'undefined' ? undefined : (caches as CacheStorage & { readonly default?: Cache }).default;
  if (!plan || !cache) return withHeaders(await read(), { 'X-CampusPulse-Cache': 'BYPASS' });

  try {
    const cached = await cache.match(plan.key);
    if (cached && isPublicResponse(cached) && (!plan.sensor || cached.headers.get('X-CampusPulse-Projection') === 'statistics-v3')) return withHeaders(cached, { 'Cache-Control': 'no-store', 'X-CampusPulse-Cache': 'HIT' });
  } catch { /* Cache availability must not prevent a database read. */ }

  const response = await read();
  if (!isPublicResponse(response) || plan.sensor && response.headers.get('X-CampusPulse-Projection') !== 'statistics-v3') return withHeaders(response, { 'X-CampusPulse-Cache': 'BYPASS' });
  const stored = withHeaders(response.clone(), { 'Cache-Control': `public, max-age=${plan.ttl}` });
  const write = (async () => {
    try { await cache.put(plan.key, stored); }
    catch { /* A cache miss on the next request is safe. */ }
  })();
  if (ctx) ctx.waitUntil(write);
  else await write;
  return withHeaders(response, { 'Cache-Control': 'no-store', 'X-CampusPulse-Cache': 'MISS' });
}
