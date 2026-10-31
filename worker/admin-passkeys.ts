import {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
  type RegistrationResponseJSON, type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import type { Env } from './types';
import { IngestError, parseIngestJson } from './strict-json';
import { json, sha256 } from './http';
import { authBody, authName, authObject } from './admin-auth-input';
import {
  accountAssertion, adminCookie, authAtomic, authAudit, authRateLimit, base64url, createAdminSession, decode64,
  findAdminAccount, publicAccount, requireAdminSession, requireFreshSession, sessionAssertion, sessionInsert,
  unauthorized, ADMIN_REAUTH_MS, type AdminAccount, type AdminSession, type AuthAssertion,
} from './admin-auth';

const CHALLENGE_MS = 5 * 60 * 1000;
const BINDING_COOKIE = 'cp_admin_passkey';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALGORITHMS = [-7, -257]; // ES256 and RS256; explicit, widely interoperable.
const encoder = new TextEncoder();
const invalidPasskey = () => new IngestError(400, 'invalid_passkey_response', 'Passkey verification failed. Start a new verification and try again.');

/** Production RP identity is explicitly provisioned, never inferred from Host. */
export function passkeyContext(request: Request, env: Env): { origin: string; rpID: string } {
  const actual = new URL(request.url);
  if (env.ADMIN_WEBAUTHN_ORIGIN !== undefined || env.ADMIN_WEBAUTHN_RP_ID !== undefined) {
    let configured: URL;
    try { configured = new URL(env.ADMIN_WEBAUTHN_ORIGIN!); } catch { throw new IngestError(503, 'passkey_not_configured', 'Configure an exact trusted Passkey origin and RP ID.'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname);
    if (!env.ADMIN_WEBAUTHN_RP_ID || configured.origin !== env.ADMIN_WEBAUTHN_ORIGIN ||
        configured.hostname !== env.ADMIN_WEBAUTHN_RP_ID || configured.username || configured.password ||
        (configured.protocol !== 'https:' && !(local && configured.protocol === 'http:')) || actual.origin !== configured.origin)
      throw new IngestError(503, 'passkey_not_configured', 'This origin does not match the configured Passkey origin and RP ID.');
    return { origin: configured.origin, rpID: configured.hostname };
  }
  if (['localhost', '127.0.0.1', '[::1]'].includes(actual.hostname) && ['http:', 'https:'].includes(actual.protocol))
    return { origin: actual.origin, rpID: actual.hostname };
  throw new IngestError(503, 'passkey_not_configured', 'Configure an exact trusted Passkey origin and RP ID.');
}
interface PasskeyRow {
  id: string; account_id: string; credential_id: string; public_key: string; counter: number; transports_json: string;
  device_type: 'singleDevice' | 'multiDevice'; backed_up: number; name: string; rp_id: string; origin: string;
  revision: number; created_at: string; last_used_at: string | null;
}
const publicPasskey = (key: PasskeyRow) => ({ id: key.id, name: key.name, created_at: key.created_at, last_used_at: key.last_used_at,
  device_type: key.device_type, backed_up: key.backed_up === 1 });
export async function publicPasskeys(env: Env, accountID: string) {
  const keys = await env.DB.prepare('SELECT id,name,created_at,last_used_at,device_type,backed_up FROM admin_passkeys WHERE account_id=? ORDER BY created_at,id LIMIT 20')
    .bind(accountID).all<PasskeyRow>();
  return keys.results.map(publicPasskey);
}
interface ChallengeRow {
  id: string; challenge: string; kind: 'registration' | 'login' | 'reauth'; account_id: string; auth_version: number;
  session_sha256: string | null; binding_sha256: string | null; name: string | null; rp_id: string; origin: string;
  expires_at_ms: number; claimed_at_ms: number | null; claim_id: string | null;
}
function bindingCookie(request: Request, value: string, clear = false): string {
  return `${BINDING_COOKIE}=${value}; Path=/api/v1/admin/passkeys; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 300}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
async function browserBinding(request: Request): Promise<string> {
  const entries = (request.headers.get('Cookie') ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${BINDING_COOKIE}=`));
  if (entries.length !== 1) throw invalidPasskey();
  const value = entries[0].slice(BINDING_COOKIE.length + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw invalidPasskey();
  return sha256(encoder.encode(value));
}
async function storeChallenge(env: Env, account: AdminAccount, kind: ChallengeRow['kind'], challenge: string,
  rp: { origin: string; rpID: string }, session: AdminSession | null, binding: string | null, name: string | null = null) {
  const id = crypto.randomUUID(), now = Date.now();
  await authAtomic(env, [
    env.DB.prepare('DELETE FROM admin_auth_challenges WHERE id IN (SELECT id FROM admin_auth_challenges WHERE expires_at_ms<=? LIMIT 100)').bind(now),
    env.DB.prepare(`INSERT INTO admin_auth_challenges(id,challenge,kind,account_id,auth_version,session_sha256,binding_sha256,name,rp_id,origin,expires_at_ms,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, challenge, kind, account.id, account.auth_version, session?.hash ?? null, binding, name, rp.rpID, rp.origin, now + CHALLENGE_MS, new Date(now).toISOString()),
  ], [accountAssertion(account), ...(session ? [sessionAssertion(session, kind === 'registration')] : [])]);
  return id;
}
/** Claim is its own committed atomic UPDATE before any cryptographic check.
 * Failed verification is intentionally not retryable with the same challenge.
 */
async function claimChallenge(env: Env, id: unknown, kind: ChallengeRow['kind'], rp: { origin: string; rpID: string },
  session: AdminSession | null, binding: string | null): Promise<ChallengeRow> {
  if (typeof id !== 'string' || !UUID.test(id)) throw invalidPasskey();
  const claim = crypto.randomUUID();
  const result = await env.DB.prepare(`UPDATE admin_auth_challenges SET claimed_at_ms=?,claim_id=?
    WHERE id=? AND kind=? AND claimed_at_ms IS NULL AND expires_at_ms>? AND origin=? AND rp_id=?
      AND session_sha256 IS ? AND binding_sha256 IS ?
      AND EXISTS (SELECT 1 FROM admin_accounts a WHERE a.id=admin_auth_challenges.account_id AND a.auth_version=admin_auth_challenges.auth_version)`)
    .bind(Date.now(), claim, id, kind, Date.now(), rp.origin, rp.rpID, session?.hash ?? null, binding).run();
  if (result.meta.changes !== 1) throw invalidPasskey();
  const row = await env.DB.prepare('SELECT * FROM admin_auth_challenges WHERE id=? AND claim_id=?').bind(id, claim).first<ChallengeRow>();
  if (!row || session && (row.account_id !== session.account!.id || row.auth_version !== session.account!.auth_version)) throw invalidPasskey();
  return row;
}
function claimedAssertion(challenge: ChallengeRow): AuthAssertion {
  return { sql: 'EXISTS (SELECT 1 FROM admin_auth_challenges WHERE id=? AND claim_id=? AND claimed_at_ms IS NOT NULL AND account_id=? AND auth_version=?)',
    bindings: [challenge.id, challenge.claim_id, challenge.account_id, challenge.auth_version] };
}
/** Extra policy checks supplement, rather than replace, the maintained verifier. */
function credentialResponse(value: unknown): RegistrationResponseJSON | AuthenticationResponseJSON {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidPasskey();
  const o = value as Record<string, unknown>;
  if (typeof o.id !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(o.id) || o.rawId !== o.id || o.type !== 'public-key' ||
      !o.response || typeof o.response !== 'object' || Array.isArray(o.response)) throw invalidPasskey();
  const response = o.response as Record<string, unknown>;
  if (typeof response.clientDataJSON !== 'string' || !/^[A-Za-z0-9_-]{1,8192}$/.test(response.clientDataJSON)) throw invalidPasskey();
  try {
    const client = parseIngestJson(decode64(response.clientDataJSON)) as Record<string, unknown>;
    if (!client || typeof client !== 'object' || Array.isArray(client) || client.crossOrigin !== undefined && client.crossOrigin !== false || 'topOrigin' in client) throw invalidPasskey();
  } catch { throw invalidPasskey(); }
  return value as RegistrationResponseJSON | AuthenticationResponseJSON;
}

/** Optional client property reports may be omitted by browsers/authenticators. */
function validateRegistrationExtensions(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidPasskey();
  const properties = (value as Record<string, unknown>).credProps;
  if (properties === undefined) return;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) throw invalidPasskey();
  const resident = (properties as Record<string, unknown>).rk;
  if (resident !== undefined && resident !== true) throw invalidPasskey();
}

export async function handlePasskeys(request: Request, env: Env, secret: string, route: string): Promise<Response> {
  if (route === '/passkeys/authentication/options' && request.method === 'POST') {
    await authRateLimit(request, env, secret, 'passkey-options', 40, CHALLENGE_MS);
    const o = authObject(await authBody(request, 4096), ['intent']);
    if (o.intent !== 'login' && o.intent !== 'reauth') throw new IngestError(422, 'invalid_auth_input', 'Choose login or reauth intent.');
    const rp = passkeyContext(request, env);
    const session = o.intent === 'reauth' ? await requireAdminSession(request, env, secret) : null;
    const account = session?.account ?? await findAdminAccount(env);
    if (!account) throw unauthorized();
    const binding = session ? null : base64url(crypto.getRandomValues(new Uint8Array(32)));
    const optionsJSON = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required', timeout: CHALLENGE_MS });
    const id = await storeChallenge(env, account, o.intent, optionsJSON.challenge, rp, session,
      binding ? await sha256(encoder.encode(binding)) : null);
    const response = json({ challenge_id: id, optionsJSON });
    if (binding) response.headers.set('Set-Cookie', bindingCookie(request, binding));
    return response;
  }
  if (route === '/passkeys/authentication/verify' && request.method === 'POST') {
    await authRateLimit(request, env, secret, 'passkey-verify', 40, CHALLENGE_MS);
    const o = authObject(await authBody(request), ['challenge_id', 'response']);
    const rp = passkeyContext(request, env);
    if (typeof o.challenge_id !== 'string' || !UUID.test(o.challenge_id)) throw invalidPasskey();
    const pending = await env.DB.prepare("SELECT kind FROM admin_auth_challenges WHERE id=? AND kind IN ('login','reauth')").bind(o.challenge_id).first<{ kind: 'login' | 'reauth' }>();
    if (!pending) throw invalidPasskey();
    const session = pending.kind === 'reauth' ? await requireAdminSession(request, env, secret) : null;
    const challenge = await claimChallenge(env, o.challenge_id, pending.kind, rp, session, session ? null : await browserBinding(request));
    const account = await findAdminAccount(env);
    if (!account || account.id !== challenge.account_id || account.auth_version !== challenge.auth_version) throw invalidPasskey();
    const response = credentialResponse(o.response) as AuthenticationResponseJSON;
    const key = await env.DB.prepare('SELECT * FROM admin_passkeys WHERE credential_id=? AND account_id=? AND rp_id=? AND origin=?')
      .bind(response.id, account.id, rp.rpID, rp.origin).first<PasskeyRow>();
    if (!key || response.response.userHandle !== account.webauthn_user_id) throw invalidPasskey();
    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge,
        expectedOrigin: rp.origin, expectedRPID: rp.rpID, expectedType: 'webauthn.get', requireUserVerification: true,
        credential: { id: key.credential_id, publicKey: decode64(key.public_key), counter: key.counter, transports: JSON.parse(key.transports_json) } });
    } catch { throw invalidPasskey(); }
    if (!verification.verified || !verification.authenticationInfo.userVerified || verification.authenticationInfo.credentialDeviceType !== key.device_type) throw invalidPasskey();
    const info = verification.authenticationInfo, now = Date.now();
    const newSession = session ? null : await createAdminSession(secret);
    await authAtomic(env, [
      env.DB.prepare('UPDATE admin_passkeys SET counter=?,backed_up=?,last_used_at=?,revision=revision+1 WHERE id=? AND account_id=? AND counter=? AND revision=?')
        .bind(info.newCounter, info.credentialBackedUp ? 1 : 0, new Date(now).toISOString(), key.id, account.id, key.counter, key.revision),
      ...(session ? [env.DB.prepare('UPDATE admin_sessions SET reauthenticated_at_ms=? WHERE token_sha256=?').bind(now, session.hash)]
        : [env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at_ms<=?').bind(now), sessionInsert(env, newSession!, account, now)]),
      authAudit(env, session ? 'session.reauthenticate' : 'session.login', account.id, { method: 'passkey', passkey_id: key.id }),
    ], [accountAssertion(account), claimedAssertion(challenge), ...(session ? [sessionAssertion(session)] : []),
      { sql: 'EXISTS (SELECT 1 FROM admin_passkeys WHERE id=? AND account_id=? AND counter=? AND revision=?)', bindings: [key.id, account.id, key.counter, key.revision] }]);
    if (session) return json({ reauthenticated: true, expires_at: new Date(now + ADMIN_REAUTH_MS).toISOString() });
    const result = json({ authenticated: true, role: 'admin', setup_required: false, account: publicAccount(account) });
    result.headers.append('Set-Cookie', adminCookie(request, newSession!.value));
    result.headers.append('Set-Cookie', bindingCookie(request, '', true));
    return result;
  }
  const session = await requireAdminSession(request, env, secret);
  const account = session.account!;
  if (route === '/passkeys' && request.method === 'GET') return json({ passkeys: await publicPasskeys(env, account.id) });
  if (route === '/passkeys/registration/options' && request.method === 'POST') {
    requireFreshSession(session);
    await authRateLimit(request, env, secret, 'passkey-register', 20, CHALLENGE_MS);
    const o = authObject(await authBody(request, 4096), ['name']);
    const name = authName(o.name), rp = passkeyContext(request, env);
    const keys = await env.DB.prepare('SELECT credential_id,transports_json FROM admin_passkeys WHERE account_id=? AND rp_id=? LIMIT 20').bind(account.id, rp.rpID).all<PasskeyRow>();
    const optionsJSON = await generateRegistrationOptions({ rpName: 'CampusPulse', rpID: rp.rpID, userName: account.username,
      userDisplayName: account.display_name, userID: decode64(account.webauthn_user_id), attestationType: 'none', timeout: CHALLENGE_MS,
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      supportedAlgorithmIDs: ALGORITHMS, extensions: { credProps: true },
      excludeCredentials: keys.results.map(key => ({ id: key.credential_id, transports: JSON.parse(key.transports_json) })) });
    return json({ challenge_id: await storeChallenge(env, account, 'registration', optionsJSON.challenge, rp, session, null, name), optionsJSON });
  }
  if (route === '/passkeys/registration/verify' && request.method === 'POST') {
    requireFreshSession(session);
    await authRateLimit(request, env, secret, 'passkey-register-verify', 20, CHALLENGE_MS);
    const o = authObject(await authBody(request), ['challenge_id', 'response']);
    const rp = passkeyContext(request, env);
    const challenge = await claimChallenge(env, o.challenge_id, 'registration', rp, session, null);
    const response = credentialResponse(o.response) as RegistrationResponseJSON;
    validateRegistrationExtensions(response.clientExtensionResults);
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: rp.origin,
        expectedRPID: rp.rpID, expectedType: 'webauthn.create', requireUserVerification: true, requireUserPresence: true, supportedAlgorithmIDs: ALGORITHMS });
    } catch { throw invalidPasskey(); }
    if (!verification.verified || !verification.registrationInfo.userVerified || verification.registrationInfo.fmt !== 'none') throw invalidPasskey();
    const info = verification.registrationInfo, credential = info.credential;
    if (credential.id !== response.id || credential.publicKey.byteLength > 4096) throw invalidPasskey();
    const transports = credential.transports ?? [];
    if (!Array.isArray(transports) || transports.length > 8 || transports.some(t => typeof t !== 'string' || !/^[a-z-]{1,32}$/.test(t))) throw invalidPasskey();
    const key: PasskeyRow = { id: crypto.randomUUID(), account_id: account.id, credential_id: credential.id, public_key: base64url(credential.publicKey),
      counter: credential.counter, transports_json: JSON.stringify(transports), device_type: info.credentialDeviceType, backed_up: info.credentialBackedUp ? 1 : 0,
      name: challenge.name!, rp_id: rp.rpID, origin: rp.origin, revision: 1, created_at: new Date().toISOString(), last_used_at: null };
    await authAtomic(env, [env.DB.prepare(`INSERT INTO admin_passkeys(id,account_id,credential_id,public_key,counter,transports_json,device_type,backed_up,name,rp_id,origin,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(key.id, key.account_id, key.credential_id, key.public_key, key.counter, key.transports_json, key.device_type, key.backed_up, key.name, key.rp_id, key.origin, key.created_at),
      authAudit(env, 'passkey.register', account.id, { passkey_id: key.id })], [sessionAssertion(session, true), claimedAssertion(challenge)]);
    return json({ passkey: publicPasskey(key) }, 201);
  }
  const keyRoute = /^\/passkeys\/([0-9a-f-]{36})$/i.exec(route);
  if (keyRoute && (request.method === 'PATCH' || request.method === 'DELETE')) {
    requireFreshSession(session);
    const key = await env.DB.prepare('SELECT * FROM admin_passkeys WHERE id=? AND account_id=?').bind(keyRoute[1], account.id).first<PasskeyRow>();
    if (!key) throw new IngestError(404, 'passkey_not_found', 'Unknown Passkey.');
    const guard: AuthAssertion = { sql: 'EXISTS (SELECT 1 FROM admin_passkeys WHERE id=? AND account_id=? AND revision=?)', bindings: [key.id, account.id, key.revision] };
    if (request.method === 'PATCH') {
      const o = authObject(await authBody(request, 4096), ['name']), name = authName(o.name);
      await authAtomic(env, [env.DB.prepare('UPDATE admin_passkeys SET name=?,revision=revision+1 WHERE id=? AND account_id=?').bind(name, key.id, account.id),
        authAudit(env, 'passkey.rename', account.id, { passkey_id: key.id })], [sessionAssertion(session, true), guard]);
      return json({ passkey: publicPasskey({ ...key, name }) });
    }
    await authAtomic(env, [env.DB.prepare('DELETE FROM admin_passkeys WHERE id=? AND account_id=?').bind(key.id, account.id),
      authAudit(env, 'passkey.delete', account.id, { passkey_id: key.id })], [sessionAssertion(session, true), guard]);
    return json({ deleted: true });
  }
  if (['/passkeys', '/passkeys/registration/options', '/passkeys/registration/verify', '/passkeys/authentication/options', '/passkeys/authentication/verify'].includes(route) || keyRoute)
    throw new IngestError(405, 'method_not_allowed', 'Method is not supported for this Passkey resource.');
  throw new IngestError(404, 'not_found', 'Unknown Passkey endpoint.');
}
