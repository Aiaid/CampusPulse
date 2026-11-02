/** Public, credential-free time proofs. A response never establishes its own trust key. */
import { json, readBytes } from './http';
import { parseIngestJson, IngestError } from './strict-json';

export interface DeviceV3ClockEnv {
  /** P-256 private JWK. Configure as a Worker secret, never a checked-in variable. */
  DEVICE_V3_CLOCK_PRIVATE_KEY_JWK?: string;
  DEVICE_V3_CLOCK_KEY_ID?: string;
  DEVICE_V3_CLOCK_AUDIENCE?: string;
  /** Explicit operator bound on the server clock, excluding client network RTT. */
  DEVICE_V3_CLOCK_MAX_ERROR_MS?: string;
}
export const CLOCK_SCHEMA = 'cp-v3-signed-clock/1';
export interface ClockProofFields { audience: string; key_id: string; nonce: string; unix_ms: number; max_error_ms: number }
/** Fixed ASCII fields, base-10 integers, LF delimiters and a final LF. */
export function clockTranscript(p: ClockProofFields): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${CLOCK_SCHEMA}\n${p.audience}\n${p.key_id}\n${p.nonce}\n${p.unix_ms}\n${p.max_error_ms}\n`);
}
function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function unavailable(): never { throw new IngestError(503, 'v3_clock_unavailable', 'Signed time is not configured.'); }
async function signer(env: DeviceV3ClockEnv, origin: string) {
  const audience = env.DEVICE_V3_CLOCK_AUDIENCE, key_id = env.DEVICE_V3_CLOCK_KEY_ID;
  const maxError = env.DEVICE_V3_CLOCK_MAX_ERROR_MS;
  if (!audience || audience.length > 128 || !/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/.test(audience) ||
    new URL(audience).origin !== audience || origin !== audience || !key_id || !/^[A-Za-z0-9_-]{1,32}$/.test(key_id) ||
    !maxError || !/^[1-9][0-9]{0,3}$/.test(maxError) || Number(maxError) > 3000 || !env.DEVICE_V3_CLOCK_PRIVATE_KEY_JWK) unavailable();
  try {
    const key = JSON.parse(env.DEVICE_V3_CLOCK_PRIVATE_KEY_JWK) as JsonWebKey;
    if (key.kty !== 'EC' || key.crv !== 'P-256' || typeof key.d !== 'string' || typeof key.x !== 'string' || typeof key.y !== 'string') unavailable();
    const privateKey = await crypto.subtle.importKey('jwk', key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const publicKey = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: key.x, y: key.y }, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const spki = await crypto.subtle.exportKey('spki', publicKey);
    if (spki.byteLength !== 91) unavailable();
    return { audience, key_id, max_error_ms: Number(maxError), privateKey, publicKey, spki };
  } catch { return unavailable(); }
}

export async function handleDeviceV3Clock(request: Request, env: DeviceV3ClockEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!['/api/v3/clock', '/api/v3/clock/key'].includes(url.pathname)) return null;
  try {
    const keyRequest = url.pathname.endsWith('/key');
    if (request.method !== (keyRequest ? 'GET' : 'POST')) throw new IngestError(405, 'method_not_allowed', keyRequest ? 'Use GET.' : 'Use POST.');
    if (url.search || request.headers.has('Authorization') || request.headers.has('Cookie'))
      throw new IngestError(400, 'v3_clock_credentials_forbidden', 'Send no query, device identity or credentials to the public clock.');
    let nonce = '';
    if (!keyRequest) {
      const value = parseIngestJson(await readBytes(request, 128));
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 ||
        typeof (value as Record<string, unknown>).nonce !== 'string' || !/^[0-9a-f]{64}$/.test((value as Record<string, string>).nonce))
        throw new IngestError(422, 'v3_clock_nonce_invalid', 'Supply one fresh 32-byte nonce as lowercase hexadecimal.');
      nonce = (value as { nonce: string }).nonce;
    }
    const key = await signer(env, url.origin);
    if (keyRequest) return json({ schema: 'cp-v3-signed-clock-key/1', audience: key.audience, key_id: key.key_id, public_key_spki: base64url(key.spki) });
    const fields: ClockProofFields = { audience: key.audience, key_id: key.key_id, nonce, unix_ms: Date.now(), max_error_ms: key.max_error_ms };
    const transcript = clockTranscript(fields);
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, transcript);
    // Reject malformed/mismatched operator key material without disclosing it.
    if (signature.byteLength !== 64 || !await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key.publicKey, signature, transcript)) unavailable();
    return json({ schema: CLOCK_SCHEMA, ...fields, sig: base64url(signature) });
  } catch (error) {
    if (error instanceof IngestError) return json({ error: { code: error.code, message: error.message, retryable: error.status >= 500 } }, error.status);
    return json({ error: { code: 'v3_clock_unavailable', message: 'Signed time is unavailable.', retryable: true } }, 503);
  }
}
