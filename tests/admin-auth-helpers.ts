import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { expect } from 'vitest';
import worker from '../worker/index';
import { setup } from './helpers/ingestion';

export const ORIGIN = 'https://admin.example.test';
export const TOKEN = 'synthetic-bootstrap-only-for-auth-tests';
export const ACCOUNT = { username: 'qa-admin', display_name: 'Synthetic administrator', password: ' synthetic long password for auth tests ' };
export const NEW_PASSWORD = ' changed synthetic password for auth tests ';
export type State = Awaited<ReturnType<typeof setup>>;
export async function authState() {
  const state = await setup();
  state.env.ADMIN_TOKEN = TOKEN;
  state.env.ADMIN_WEBAUTHN_ORIGIN = ORIGIN;
  state.env.ADMIN_WEBAUTHN_RP_ID = new URL(ORIGIN).hostname;
  return state;
}
export class Client {
  cookies = new Map<string, string>();
  constructor(public state: State, public origin = ORIGIN, public ip = '192.0.2.10') {}
  async call(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    const response = await worker.fetch(new Request(`${this.origin}/api/v1/admin${path}`, {
      method,
      headers: { Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '), 'CF-Connecting-IP': this.ip,
        ...(method === 'GET' ? {} : { Origin: this.origin }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), this.state.env);
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const position = pair.indexOf('=');
      this.cookies.set(pair.slice(0, position), pair.slice(position + 1));
    }
    return response;
  }
  clone() { const client = new Client(this.state, this.origin, this.ip); client.cookies = new Map(this.cookies); return client; }
  async bootstrap() { return json(await this.call('/session', 'POST', { token: TOKEN })); }
  async initialize() { await this.bootstrap(); return json(await this.call('/auth/setup', 'POST', ACCOUNT), 201); }
  async login(password = ACCOUNT.password, username = ACCOUNT.username) { return json(await this.call('/session', 'POST', { username, password })); }
  async reauth(password = ACCOUNT.password) { return json(await this.call('/auth/reauth', 'POST', { password })); }
}
export async function json(response: Response, status = 200): Promise<any> {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body;
}
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest();
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const countBytes = (count: number) => { const value = Buffer.alloc(4); value.writeUInt32BE(count); return value; };

/** A synthetic ES256 authenticator, not a server verifier mock. All attestations
 * and assertions traverse the production SimpleWebAuthn verifier and D1 SQL.
 * The browser acceptance script separately covers Chrome's actual WebAuthn API.
 */
export class Authenticator {
  id = b64(randomBytes(32));
  privateKey: KeyObject;
  publicKey: Buffer;
  userHandle = '';
  constructor(public counter = 0, public backedUp = false, public backupEligible = backedUp) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: 'jwk' });
    this.publicKey = Buffer.from(isoCBOR.encode(new Map<number, number | Uint8Array>([
      [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')],
    ])));
  }
  register(options: any, override: { origin?: string; rp?: string; uv?: boolean; resident?: boolean; type?: string; challenge?: string } = {}) {
    this.userHandle = options.user.id;
    const credential = Buffer.from(this.id, 'base64url');
    const length = Buffer.alloc(2); length.writeUInt16BE(credential.length);
    const flags = 0x41 | (override.uv === false ? 0 : 0x04) | (this.backupEligible ? 0x08 : 0) | (this.backedUp ? 0x10 : 0);
    const authData = Buffer.concat([hash(override.rp ?? options.rp.id), Buffer.from([flags]), countBytes(this.counter), Buffer.alloc(16), length, credential, this.publicKey]);
    const clientData = Buffer.from(JSON.stringify({ type: override.type ?? 'webauthn.create', challenge: override.challenge ?? options.challenge, origin: override.origin ?? ORIGIN, crossOrigin: false }));
    return { id: this.id, rawId: this.id, type: 'public-key', authenticatorAttachment: 'platform',
      clientExtensionResults: { credProps: { rk: override.resident !== false } },
      response: { clientDataJSON: b64(clientData), attestationObject: b64(isoCBOR.encode(new Map<string, any>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))), transports: ['internal'] } };
  }
  authenticate(options: any, override: { origin?: string; rp?: string; uv?: boolean; userHandle?: string | null; counter?: number; type?: string; challenge?: string; signingKey?: KeyObject } = {}) {
    const flags = 0x01 | (override.uv === false ? 0 : 0x04) | (this.backupEligible ? 0x08 : 0) | (this.backedUp ? 0x10 : 0);
    const authData = Buffer.concat([hash(override.rp ?? options.rpId), Buffer.from([flags]), countBytes(override.counter ?? this.counter)]);
    const clientData = Buffer.from(JSON.stringify({ type: override.type ?? 'webauthn.get', challenge: override.challenge ?? options.challenge, origin: override.origin ?? ORIGIN, crossOrigin: false }));
    return { id: this.id, rawId: this.id, type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(sign('sha256', Buffer.concat([authData, hash(clientData)]), override.signingKey ?? this.privateKey)), userHandle: override.userHandle === undefined ? this.userHandle : override.userHandle } };
  }
}
export async function register(client: Client, authenticator = new Authenticator(), name = 'Synthetic test authenticator') {
  const challenge = await json(await client.call('/passkeys/registration/options', 'POST', { name }));
  const response = authenticator.register(challenge.optionsJSON);
  const verified = await json(await client.call('/passkeys/registration/verify', 'POST', { challenge_id: challenge.challenge_id, response }), 201);
  return { authenticator, challenge, response, passkey: verified.passkey };
}
export async function authentication(client: Client, authenticator: Authenticator, intent: 'login' | 'reauth' = 'login', override?: Parameters<Authenticator['authenticate']>[1]) {
  const challenge = await json(await client.call('/passkeys/authentication/options', 'POST', { intent }));
  const response = authenticator.authenticate(challenge.optionsJSON, override);
  return { challenge, response, body: { challenge_id: challenge.challenge_id, response } };
}
