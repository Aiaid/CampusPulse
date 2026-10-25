import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import worker from '../worker/index';
import { createOpenApiDocument } from '../worker/openapi';
import type { Env } from '../worker/types';

type Json = Record<string, any>;
const document = () => createOpenApiDocument() as unknown as Json;
const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
const implemented = [
  'GET /api/v1/health', 'GET /api/v1/places',
  'GET /api/v1/places/{id}/summary', 'GET /api/v1/places/{id}/history',
  'GET /api/v1/places/{id}/elevator-events',
  'POST /api/v1/observations', 'DELETE /api/v1/observations/{id}',
  'POST /api/v1/ingest', 'GET /api/v1/device/config', 'GET /api/v1/research/batches/{id}',
  'GET /api/v1/settings', 'POST /api/v1/device/config/ack',
  'GET /api/v2/device/config', 'POST /api/v2/device/contact', 'POST /api/v2/device/config/ack',
  'POST /api/v2/ingest', 'GET /api/v2/research/batches/{id}',
  'GET /api/v1/admin/session', 'POST /api/v1/admin/session', 'DELETE /api/v1/admin/session',
  'GET /api/v1/admin/overview', 'GET /api/v1/admin/devices', 'POST /api/v1/admin/devices',
  'GET /api/v1/admin/devices/{id}', 'PATCH /api/v1/admin/devices/{id}',
  'POST /api/v1/admin/devices/{id}/rotate-credential', 'POST /api/v1/admin/devices/{id}/placements',
  'GET /api/v1/admin/places', 'POST /api/v1/admin/places', 'PATCH /api/v1/admin/places/{id}',
  'GET /api/v1/admin/configs', 'POST /api/v1/admin/configs', 'PUT /api/v1/admin/configs/{id}',
  'POST /api/v1/admin/configs/{id}/validate', 'POST /api/v1/admin/configs/{id}/publish',
  'GET /api/v1/admin/settings', 'PUT /api/v1/admin/settings', 'GET /api/v1/admin/audit',
  'GET /api/v1/admin/auth/status', 'POST /api/v1/admin/auth/setup', 'POST /api/v1/admin/auth/reauth',
  'GET /api/v1/admin/account', 'PATCH /api/v1/admin/account', 'PUT /api/v1/admin/account/password',
  'GET /api/v1/admin/passkeys', 'PATCH /api/v1/admin/passkeys/{id}', 'DELETE /api/v1/admin/passkeys/{id}',
  'POST /api/v1/admin/passkeys/registration/options', 'POST /api/v1/admin/passkeys/registration/verify',
  'POST /api/v1/admin/passkeys/authentication/options', 'POST /api/v1/admin/passkeys/authentication/verify',
];
const token = 'test-only-private-operator-token';
function noStorageEnv(): Env {
  return {
    OPERATOR_TOKEN: token,
    DB: { prepare() { throw new Error('This route must not access D1'); } } as unknown as D1Database,
    ASSETS: { fetch: async () => new Response('<html>SPA fallback</html>') } as unknown as Fetcher,
  };
}
const fetchWorker = (path: string, init?: RequestInit, env = noStorageEnv()) => worker.fetch(new Request(`http://localhost${path}`, init), env);
function resolve(root: Json, ref: string): Json {
  expect(ref.startsWith('#/'), `Only local references: ${ref}`).toBe(true);
  const value = ref.slice(2).split('/').reduce<any>((node, segment) => node?.[segment.replace(/~1/g, '/').replace(/~0/g, '~')], root);
  expect(value, `Unresolved reference: ${ref}`).toBeDefined();
  return value;
}
function deref(root: Json, schema: Json): Json { return schema.$ref ? deref(root, resolve(root, schema.$ref)) : schema; }

// Validate returned API data against the published contract, including union
// branches. This intentionally does not validate annotations or examples.
function checkSchema(root: Json, schema: Json | boolean, value: unknown): void {
  if (schema === true) return;
  if (schema === false) throw new Error('Forbidden schema value');
  if (schema.$ref) checkSchema(root, resolve(root, schema.$ref), value);
  for (const branch of schema.allOf ?? []) checkSchema(root, branch, value);
  for (const keyword of ['anyOf', 'oneOf']) {
    if (!schema[keyword]) continue;
    const successes = schema[keyword].filter((branch: Json) => { try { checkSchema(root, branch, value); return true; } catch { return false; } }).length;
    if (keyword === 'oneOf') expect(successes).toBe(1);
    else expect(successes).toBeGreaterThan(0);
  }
  if ('const' in schema) expect(value).toEqual(schema.const);
  if (schema.enum) expect(schema.enum).toContainEqual(value);
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    expect(types.some((type: string) => type === actual || (type === 'integer' && Number.isInteger(value)))).toBe(true);
  }
  if (typeof value === 'string') {
    if (schema.pattern) expect(value).toMatch(new RegExp(schema.pattern));
    if (schema.minLength !== undefined) expect(value.length).toBeGreaterThanOrEqual(schema.minLength);
    if (schema.maxLength !== undefined) expect(value.length).toBeLessThanOrEqual(schema.maxLength);
    if (schema.format === 'date-time') expect(Number.isFinite(Date.parse(value))).toBe(true);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined) expect(value).toBeGreaterThanOrEqual(schema.minimum);
    if (schema.maximum !== undefined) expect(value).toBeLessThanOrEqual(schema.maximum);
  }
  if (Array.isArray(value)) for (const entry of value) if (schema.items) checkSchema(root, schema.items, entry);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) expect(Object.hasOwn(value, key), `Required property ${key}`).toBe(true);
    for (const [key, entry] of Object.entries(value)) {
      if (schema.properties?.[key]) checkSchema(root, schema.properties[key], entry);
      else if (schema.additionalProperties === false) throw new Error(`Unexpected property ${key}`);
    }
  }
}

describe('same-origin documentation routes', () => {
  it('serves HTML, JSON and initializer before SPA fallback without D1 or credentials', async () => {
    for (const path of ['/docs', '/docs/']) {
      const response = await fetchWorker(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      const html = await response.text();
      expect(html).toContain('swagger-ui');
      expect(html).not.toContain(token);
      const scripts = [...html.matchAll(/<script\b[^>]*src=["']([^"']+)["']/g)].map(match => match[1]);
      expect(scripts).toEqual(expect.arrayContaining(['/vendor/swagger-ui/swagger-ui-bundle.js', '/docs/swagger-init.js']));
      expect(scripts.every(src => src.startsWith('/') && !src.startsWith('//'))).toBe(true);
      expect(html).toContain('/vendor/swagger-ui/swagger-ui.css');
      expect(html).not.toMatch(/https?:\/\/[^\s"']+\.(?:js|css)/);
      expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
    const spec = await fetchWorker('/openapi.json');
    expect(spec.status).toBe(200);
    expect(spec.headers.get('content-type')).toContain('application/json');
    const text = await spec.text();
    const contractOnly = (value: unknown) => JSON.parse(JSON.stringify(value, (key, child) => key === 'examples' ? '[generated examples]' : child));
    expect(contractOnly(JSON.parse(text))).toEqual(contractOnly(document()));
    expect(text).not.toContain(token);
    expect(text).not.toContain('SPA fallback');
    const init = await fetchWorker('/docs/swagger-init.js');
    expect(init.status).toBe(200);
    expect(init.headers.get('content-type')).toMatch(/javascript/);
    const code = await init.text();
    expect(code).toContain('/openapi.json');
    expect(code).toMatch(/persistAuthorization\s*:\s*false/);
    expect(code).toMatch(/queryConfigEnabled\s*:\s*false/);
    expect(code).toMatch(/withCredentials\s*:\s*false/);
    expect(code).toMatch(/validatorUrl\s*:\s*(?:null|["']none["'])/);
    expect(code).not.toContain(token);
  });

  it('allows both implemented API versions while blocking off-origin or unsupported documentation requests', async () => {
    const code = await (await fetchWorker('/docs/swagger-init.js')).text();
    const window = { location: { origin: 'https://docs.campuspulse.test' }, ui: undefined as Json | undefined };
    new Function('window', 'SwaggerUIBundle', code)(window, (options: Json) => options);
    const intercept = window.ui!.requestInterceptor as (request: { url: string }) => { url: string };
    for (const path of ['/openapi.json', '/api/v1/health', '/api/v2/device/config', '/api/v2/ingest']) {
      const request = { url: new URL(path, window.location.origin).href };
      expect(intercept(request)).toBe(request);
    }
    for (const url of ['https://external.invalid/api/v2/ingest', '/api/v3/ingest', '/api/v20/ingest', '/unrelated']) {
      expect(() => intercept({ url })).toThrow('Documentation requests must stay on this site and its API.');
    }
  });

  it('handles HEAD, rejects mutation methods, and does not mask unknown docs as the SPA', async () => {
    for (const path of ['/docs', '/docs/', '/openapi.json', '/docs/swagger-init.js']) {
      const get = await fetchWorker(path);
      const head = await fetchWorker(path, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'));
      expect(await head.text()).toBe('');
      for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
        const response = await fetchWorker(path, { method });
        expect(response.status).toBe(405);
        expect(response.headers.get('allow')?.replace(/\s/g, '')).toBe('GET,HEAD');
      }
    }
    expect((await fetchWorker('/docs/unknown')).status).toBe(404);
    expect(await (await fetchWorker('/some-frontend-route')).text()).toContain('SPA fallback');
  });
});

describe('OpenAPI contract and existing authorization', () => {
  it('documents the implemented operations with independent session and bearer scopes', () => {
    const root = document();
    expect(root.openapi).toMatch(/^3\.1\./);
    const operations = Object.entries(root.paths).flatMap(([path, item]) => methods.filter(method => (item as Json)[method]).map(method => ({ path, method, operation: (item as Json)[method] })));
    expect(operations.map(({ path, method }) => `${method.toUpperCase()} ${path}`).sort()).toEqual([...implemented].sort());
    for (const { path, method, operation } of operations) {
      const security = operation.security ?? root.security ?? [];
      const publicAdmin = path === '/api/v1/admin/auth/status' || path === '/api/v1/admin/session' && method === 'post' || path.startsWith('/api/v1/admin/passkeys/authentication/');
      const expectedScheme = path.startsWith('/api/v1/admin/') ? publicAdmin ? null : 'AdminSession'
        : path === '/api/v1/ingest' || path === '/api/v1/device/config' || path === '/api/v1/device/config/ack' || path === '/api/v2/ingest' || path.startsWith('/api/v2/device/') ? 'DeviceToken'
        : path === '/api/v1/research/batches/{id}' || path === '/api/v2/research/batches/{id}' ? 'ResearchToken'
          : method !== 'get' ? 'OperatorToken' : null;
      if (!expectedScheme) expect(security).toEqual([]);
      else {
        expect(security).toEqual([{ [expectedScheme]: [] }]);
        for (const alternative of security) {
          expect(Object.keys(alternative)).toHaveLength(1);
          const scheme = root.components.securitySchemes[Object.keys(alternative)[0]];
          expect(scheme).toMatchObject(expectedScheme === 'AdminSession' ? { type: 'apiKey', in: 'cookie' } : { type: 'http', scheme: 'bearer' });
        }
        expect(operation.responses).toHaveProperty('401');
        expect(operation.responses).toHaveProperty('503');
      }
    }
    const walk = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if ('$ref' in value) resolve(root, (value as Json).$ref);
      for (const child of Object.values(value)) walk(child);
    };
    walk(root);
    expect(root.servers?.every((server: Json) => server.url.startsWith('/') && !server.url.startsWith('//')) ?? true).toBe(true);
  });

  it('fails closed for protected routes before storage and leaves public GET public', async () => {
    for (const [path, method] of [['/api/v1/observations', 'POST'], ['/api/v1/observations/12345678-1234-4234-8234-123456789abc', 'DELETE']]) {
      expect((await fetchWorker(path, { method })).status).toBe(401);
      expect((await fetchWorker(path, { method, headers: { Authorization: 'Bearer incorrect' } })).status).toBe(401);
      expect((await fetchWorker(path, { method }, { ...noStorageEnv(), OPERATOR_TOKEN: undefined })).status).toBe(503);
      expect((await fetchWorker(path, { method, headers: { Authorization: `Bearer ${token}`, Origin: 'https://other.example' } })).status).toBe(403);
    }
    for (const [path, method] of [['/api/v1/ingest', 'POST'], ['/api/v1/device/config', 'GET']]) {
      expect((await fetchWorker(path, { method })).status).toBe(401);
      expect((await fetchWorker(path, { method, headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    }
    const research = '/api/v1/research/batches/33333333-3333-4333-8333-333333333333?node_id=cp-demo-01';
    expect((await fetchWorker(research)).status).toBe(503);
    expect((await fetchWorker(research, { headers: { Authorization: 'Bearer wrong' } }, { ...noStorageEnv(), RESEARCH_TOKEN: 'private-research-token' })).status).toBe(401);
    expect((await fetchWorker('/api/v1/health')).status).toBe(200);
  });

  it('describes strict wire schemas and exact-byte hashing for each synthetic stream fixture', () => {
    const root = document();
    const ingest = root.paths['/api/v1/ingest'].post;
    expect(ingest.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'X-Body-SHA256', required: true })]));
    expect(ingest.description).toMatch(/exact UTF-8 HTTP body bytes/);
    expect(ingest.responses).toHaveProperty('409');
    expect(ingest.responses).toHaveProperty('410');
    const schema = ingest.requestBody.content['application/json'].schema;
    for (const file of ['ble-windows.request.json', 'ble-reports.request.json', 'node-status.request.json']) {
      const value = JSON.parse(readFileSync(new URL(`../docs/specs/examples/${file}`, import.meta.url), 'utf8'));
      checkSchema(root, schema, value);
      expect(() => checkSchema(root, schema, { ...value, unexpected: true })).toThrow();
      expect(() => checkSchema(root, schema, { ...value, stream: 'unknown' })).toThrow();
    }
    const reports = JSON.parse(readFileSync(new URL('../docs/specs/examples/ble-reports.request.json', import.meta.url), 'utf8'));
    expect(() => checkSchema(root, schema, { ...reports, items: [{ ...reports.items[0], payload_hex: 'f' }] })).toThrow();
    const health = root.components.schemas.Health;
    expect(health.properties).toMatchObject({ ingestion: { const: 'implemented' }, raw_storage: { enum: ['configured', 'unconfigured'] } });
    const sensor = {
      node_id: 'cp-demo-01', boot_id: '11111111-1111-4111-8111-111111111111',
      placement_id: 'demo-placement-01', capture_config_id: 'demo-capture-raw-v1',
      source: 'sensor', dataset: 'field', seq: 1,
      observed_at: '2026-10-23T00:00:00.000Z', valid_until: '2026-10-23T00:01:29.980Z',
      uncertainty_ms: 20, duration_ms: 30000, scan_enabled_ms: 30000,
      reports_aggregated: 280, visible_identifiers: 12, unique_table_overflow: false,
      aggregation_drops: 0, quality_flags: [], freshness: 'fresh',
    };
    checkSchema(root, root.components.schemas.PublicSensorWindow, sensor);
    expect(() => checkSchema(root, root.components.schemas.PublicSensorWindow, { ...sensor, uncertainty_ms: null })).toThrow();
    expect(() => checkSchema(root, root.components.schemas.PublicSensorWindow, { ...sensor, uncertainty_ms: 30001 })).toThrow();
  });

  it('matches the contract to actual SQLite-backed responses and both request variants', async () => {
    const db = new DatabaseSync(':memory:');
    for (const migration of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      db.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
    }
    const env = noStorageEnv();
    env.DB = { prepare(sql: string) {
      let values: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) { values = args; return stmt; },
        async first() { return db.prepare(sql).get(...values as []) ?? null; },
        async all() { return { results: db.prepare(sql).all(...values as []), success: true, meta: {} }; },
        async run() { const result = db.prepare(sql).run(...values as []); return { success: true, meta: { changes: Number(result.changes) } }; },
      };
      return stmt;
    } } as unknown as D1Database;
    const root = document();
    const request = async (path: string, contractPath = path, init?: RequestInit, expected = 200) => {
      const response = await fetchWorker(path, init, env);
      expect(response.status).toBe(expected);
      const operation = root.paths[contractPath][(init?.method ?? 'GET').toLowerCase()];
      const schema = deref(root, operation.responses[String(expected)]).content['application/json'].schema;
      checkSchema(root, schema, await response.json());
    };
    try {
      await request('/api/v1/health');
      await request('/api/v1/places');
      await request('/api/v1/places/library/summary', '/api/v1/places/{id}/summary');
      await request('/api/v1/places/library/history', '/api/v1/places/{id}/history');
      await request('/api/v1/places/teaching-elevator/elevator-events', '/api/v1/places/{id}/elevator-events');
      await request('/api/v1/places/library/elevator-events', '/api/v1/places/{id}/elevator-events', undefined, 422);
      await request('/api/v1/places/library/history?minutes=999', '/api/v1/places/{id}/history', undefined, 422);
      await request('/api/v1/places/unknown/summary', '/api/v1/places/{id}/summary', undefined, 404);
      for (const data of [
        { id: '12345678-1234-4234-8234-123456789abc', place_id: 'east-parking', kind: 'parking', observed_at: new Date().toISOString(), parking_min: 0, parking_max: 6 },
        { id: '12345678-1234-4234-8234-123456789abd', place_id: 'teaching-elevator', kind: 'elevator', observed_at: new Date().toISOString(), wait_seconds: 0 },
      ]) {
        const createSchema = root.paths['/api/v1/observations'].post.requestBody.content['application/json'].schema;
        checkSchema(root, createSchema, data);
        expect(() => checkSchema(root, createSchema, { ...data, source: 'sensor' })).toThrow();
        expect(() => checkSchema(root, createSchema, { ...data, kind: 'activity' })).toThrow();
        if (data.kind === 'parking') {
          expect(() => checkSchema(root, createSchema, { ...data, parking_min: -1 })).toThrow();
          expect(() => checkSchema(root, createSchema, { ...data, parking_max: 10001 })).toThrow();
          expect(() => checkSchema(root, createSchema, { ...data, wait_seconds: 0 })).toThrow();
        } else {
          expect(() => checkSchema(root, createSchema, { ...data, wait_seconds: 0.5 })).toThrow();
          expect(() => checkSchema(root, createSchema, { ...data, wait_seconds: 7201 })).toThrow();
        }
        const init = { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(data) };
        await request('/api/v1/observations', undefined, init, 201);
        await request('/api/v1/observations', undefined, init, 200);
        await request(`/api/v1/places/${data.place_id}/summary`, '/api/v1/places/{id}/summary');
        await request(`/api/v1/places/${data.place_id}/history?minutes=15`, '/api/v1/places/{id}/history');
        await request(`/api/v1/observations/${data.id}`, '/api/v1/observations/{id}', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      }
    } finally { db.close(); }
  });
});
