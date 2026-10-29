import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reportAdminFailure } from '../worker/admin-errors';
import { authState, Client } from './admin-auth-helpers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const secret = 'synthetic-private-value-never-log';
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });
const log = () => JSON.parse(vi.mocked(console.error).mock.calls.at(-1)![0] as string);

it.each([
  ['/devices/cp_001122aabbcc', 'GET', '/devices/:id', 'GET'],
  ['/devices/cp_001122aabbcc/mqtt', 'POST', '/devices/:id/mqtt', 'POST'],
  ['/devices/cp_001122aabbcc/rotate-credential', 'POST', '/devices/:id/rotate-credential', 'POST'],
  ['/auth/reauth', 'POST', '/auth/reauth', 'POST'],
  [`/${secret}`, 'PRIVATE', 'other', 'OTHER'],
])('logs only a canonical route and method for %s', (path, method, operation, safeMethod) => {
  const request = new Request(`https://admin.test/api/v1/admin${path}?private=${secret}`, { method, headers: { Authorization: `Bearer ${secret}` } });
  const requestId = reportAdminFailure(request, new Error(secret, { cause: new Error(secret) }));
  expect(requestId).toMatch(UUID);
  expect(log()).toEqual({ event: 'admin_request_failed', request_id: requestId, operation, method: safeMethod, category: 'unknown' });
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secret);
  expect(JSON.stringify(log())).not.toContain('cp_001122aabbcc');
});

it.each([
  [new Error(`D1_ERROR: no such table: ${secret}`), 'storage_schema'],
  [new Error(`D1_ERROR: database or disk is full ${secret}`), 'storage_capacity'],
  [new Error(`D1_ERROR: query exceeded time limit ${secret}`), 'storage_timeout'],
  [new Error(`D1_ERROR: ${secret}`), 'storage_unavailable'],
  [Object.assign(new Error(secret), { name: 'OperationError' }), 'crypto_unavailable'],
  [new Error(secret, { cause: new Error(`D1_ERROR: no such column: ${secret}`) }), 'storage_schema'],
  [{ message: `D1_ERROR: ${secret}`, cause: secret }, 'unknown'],
])('classifies failures without serializing their text or causes', (error, category) => {
  reportAdminFailure(new Request('https://admin.test/api/v1/admin/devices'), error);
  expect(log().category).toBe(category);
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secret);
});

it('returns the same reference in the 503 response, header, and safe diagnostic log', async () => {
  const state = await authState();
  try {
    const client = new Client(state); await client.initialize();
    const prepare = state.env.DB.prepare.bind(state.env.DB);
    vi.spyOn(state.env.DB, 'prepare').mockImplementation(sql => {
      if (sql.startsWith('SELECT n.id,n.name')) throw new Error(`D1_ERROR: query timed out ${secret}`);
      return prepare(sql);
    });
    const response = await client.call('/devices/cp-demo-01');
    const body = await response.json() as { error: { code: string; message: string; retryable: boolean; request_id: string } };
    expect(response.status).toBe(503);
    expect(body.error).toEqual({ code: 'storage_unavailable', message: 'Administrator service temporarily unavailable.', retryable: true, request_id: expect.stringMatching(UUID) });
    expect(response.headers.get('X-Request-ID')).toBe(body.error.request_id);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(log()).toMatchObject({ request_id: body.error.request_id, operation: '/devices/:id', method: 'GET', category: 'storage_timeout' });
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(secret);
  } finally { state.db.close(); }
});

it('keeps expected authentication errors unchanged and out of unexpected-failure logs', async () => {
  const state = await authState();
  try {
    const response = await new Client(state).call('/devices');
    expect(response.status).toBe(401);
    expect(response.headers.has('X-Request-ID')).toBe(false);
    expect(await response.json()).toEqual({ error: { code: 'unauthorized', message: 'Administrator authentication failed.', retryable: false } });
    expect(console.error).not.toHaveBeenCalled();
  } finally { state.db.close(); }
});
