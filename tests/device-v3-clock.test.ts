import { beforeAll, describe, expect, it } from 'vitest';
import { handleDeviceV3Clock, clockTranscript, type DeviceV3ClockEnv, type ClockProofFields } from '../worker/device-v3-clock';
const origin = 'https://synthetic-clock.example.test', nonce = 'ab'.repeat(32);
let env: DeviceV3ClockEnv, publicKey: CryptoKey;
const request = (body: unknown = { nonce }, headers: Record<string, string> = {}) => new Request(origin + '/api/v3/clock', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
beforeAll(async () => {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  publicKey = keys.publicKey;
  env = { DEVICE_V3_CLOCK_PRIVATE_KEY_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', keys.privateKey)),
    DEVICE_V3_CLOCK_KEY_ID: 'synthetic-key-1', DEVICE_V3_CLOCK_AUDIENCE: origin, DEVICE_V3_CLOCK_MAX_ERROR_MS: '1000' };
});
describe('credential-free pinned-key signed time', () => {
  it('signs the exact nonce/audience/key/time transcript as a 64-byte P1363 signature', async () => {
    const response = (await handleDeviceV3Clock(request(), env))!;
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json() as ClockProofFields & { schema: string; sig: string };
    expect(body).toMatchObject({ schema: 'cp-v3-signed-clock/1', nonce, audience: origin, key_id: 'synthetic-key-1', max_error_ms: 1000 });
    const signature = Buffer.from(body.sig, 'base64url'); expect(signature.length).toBe(64); expect(body.sig).not.toContain('=');
    expect(new TextDecoder().decode(clockTranscript(body))).toBe(`cp-v3-signed-clock/1\n${origin}\nsynthetic-key-1\n${nonce}\n${body.unix_ms}\n1000\n`);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, clockTranscript(body))).toBe(true);
    for (const changed of [{ ...body, nonce: 'cd'.repeat(32) }, { ...body, audience: 'https://other.example.test' }, { ...body, unix_ms: body.unix_ms + 1 }]) {
      expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, clockTranscript(changed))).toBe(false);
    }
  });
  it('exports only DER91 public metadata for trusted USB provisioning', async () => {
    const response = (await handleDeviceV3Clock(new Request(origin + '/api/v3/clock/key'), env))!;
    const body = await response.json() as { public_key_spki: string };
    expect(response.status).toBe(200); expect(Buffer.from(body.public_key_spki, 'base64url')).toHaveLength(91);
    expect(Object.keys(body).sort()).toEqual(['audience', 'key_id', 'public_key_spki', 'schema']);
    expect(body.public_key_spki).toBe(Buffer.from(await crypto.subtle.exportKey('spki', publicKey)).toString('base64url'));
  });
  it('rejects identifiers, credentials, duplicate keys, invalid nonce and oversized requests', async () => {
    for (const body of [{ nonce, node_id: 'synthetic-node' }, { nonce: nonce.toUpperCase() }, { nonce: 'a'.repeat(62) }, `{"nonce":"${nonce}","nonce":"${nonce}"}`]) {
      expect((await handleDeviceV3Clock(request(body), env))!.status).toBeGreaterThanOrEqual(400);
    }
    for (const headers of [{ Authorization: 'Bearer synthetic-test-token' }, { Cookie: 'synthetic=1' }] as Record<string, string>[]) {
      expect((await handleDeviceV3Clock(request({ nonce }, headers), env))!.status).toBe(400);
    }
    expect((await handleDeviceV3Clock(request(' '.repeat(129)), env))!.status).toBe(413);
  });
  it('fails closed for missing keys, mismatched public/private pair, origin and absent clock bound', async () => {
    expect((await handleDeviceV3Clock(request(), {}))!.status).toBe(503);
    expect((await handleDeviceV3Clock(request(), { ...env, DEVICE_V3_CLOCK_MAX_ERROR_MS: undefined }))!.status).toBe(503);
    expect((await handleDeviceV3Clock(request(), { ...env, DEVICE_V3_CLOCK_AUDIENCE: 'https://other.example.test' }))!.status).toBe(503);
    const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const wrong = { ...JSON.parse(env.DEVICE_V3_CLOCK_PRIVATE_KEY_JWK!), ...await crypto.subtle.exportKey('jwk', other.publicKey), key_ops: ['sign'] };
    expect((await handleDeviceV3Clock(request(), { ...env, DEVICE_V3_CLOCK_PRIVATE_KEY_JWK: JSON.stringify(wrong) }))!.status).toBe(503);
    expect((await handleDeviceV3Clock(new Request(origin + '/api/v3/clock/key'),
      { ...env, DEVICE_V3_CLOCK_PRIVATE_KEY_JWK: JSON.stringify(wrong) }))!.status).toBe(503);
  });
  it('keeps the declared server-clock error within the firmware verifier range', async () => {
    expect((await handleDeviceV3Clock(request(), { ...env, DEVICE_V3_CLOCK_MAX_ERROR_MS: '3000' }))!.status).toBe(200);
    for (const bound of ['0', '3001', '5000']) {
      const configured = { ...env, DEVICE_V3_CLOCK_MAX_ERROR_MS: bound };
      expect((await handleDeviceV3Clock(request(), configured))!.status).toBe(503);
      expect((await handleDeviceV3Clock(new Request(origin + '/api/v3/clock/key'), configured))!.status).toBe(503);
    }
  });
});
