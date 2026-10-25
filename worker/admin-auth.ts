import type { Env } from './types';
import { IngestError } from './ingest-validation';
import { sha256 } from './ingest';

export const ADMIN_COOKIE = 'cp_admin_session';
export const ADMIN_SESSION_SECONDS = 8 * 60 * 60;
export const ADMIN_REAUTH_MS = 5 * 60 * 1000;
const encoder = new TextEncoder();
export const unauthorized = () => new IngestError(401, 'unauthorized', 'Administrator authentication failed.');
export interface AdminAccount {
  id: string; username: string; display_name: string; password_hash: string; webauthn_user_id: string;
  auth_version: number; profile_revision: number; created_at: string; updated_at: string;
}
export interface AdminSession {
  hash: string; role: 'bootstrap' | 'admin'; expires: number; reauthenticatedAt: number | null; account: AdminAccount | null;
}
export interface AuthAssertion { sql: string; bindings: unknown[] }
export class AuthRateLimitError extends IngestError {
  constructor(public retryAfterSeconds: number) { super(429, 'rate_limited', 'Too many authentication attempts. Try again later.'); }
}
export const publicAccount = (account: AdminAccount) => ({ id: account.id, username: account.username, display_name: account.display_name });
export const findAdminAccount = (env: Env) => env.DB.prepare('SELECT * FROM admin_accounts WHERE singleton=1').first<AdminAccount>();

export function adminSecret(env: Env): string {
  if (!env.ADMIN_TOKEN || !/^[!-~]{16,1024}$/.test(env.ADMIN_TOKEN) || env.ADMIN_TOKEN === env.OPERATOR_TOKEN || env.ADMIN_TOKEN === env.RESEARCH_TOKEN)
    throw new IngestError(503, 'admin_not_configured', 'Independent administrator authentication is not configured.');
  return env.ADMIN_TOKEN;
}

export function adminOrigin(request: Request, mutation = false): void {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    throw new IngestError(403, 'https_required', 'Administrator access requires HTTPS.');
  const origin = request.headers.get('Origin');
  if ((mutation && origin !== url.origin) || (origin !== null && origin !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site')
    throw new IngestError(403, 'origin_rejected', 'Use a same-origin administrator request.');
}

export async function adminTokenMatches(supplied: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(encoder.encode(supplied)), sha256(encoder.encode(expected))]);
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
export const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export function decode64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
}
const signingKey = (secret: string) => crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export async function createAdminSession(secret: string) {
  const id = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const expires = Date.now() + ADMIN_SESSION_SECONDS * 1000;
  const unsigned = `${id}.${expires}`;
  const signature = base64url(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(unsigned))));
  return { hash: await sha256(encoder.encode(id)), expires, value: `${unsigned}.${signature}` };
}

/** Bad signatures and expired cookies fail before any database lookup. */
export async function requireAdminSession(request: Request, env: Env, secret: string, allowBootstrap = false): Promise<AdminSession> {
  const cookieValues = (request.headers.get('Cookie') ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${ADMIN_COOKIE}=`));
  if (cookieValues.length !== 1) throw unauthorized();
  const value = cookieValues[0].slice(ADMIN_COOKIE.length + 1);
  const match = /^([A-Za-z0-9_-]{43})\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match || Number(match[2]) <= Date.now() || Number(match[2]) > Date.now() + ADMIN_SESSION_SECONDS * 1000 + 1000) throw unauthorized();
  const verified = await crypto.subtle.verify('HMAC', await signingKey(secret), decode64(match[3]), encoder.encode(`${match[1]}.${match[2]}`));
  if (!verified) throw unauthorized();
  const hash = await sha256(encoder.encode(match[1]));
  const row = await env.DB.prepare('SELECT expires_at_ms,role,account_id,auth_version,reauthenticated_at_ms FROM admin_sessions WHERE token_sha256 = ? AND expires_at_ms > ?')
    .bind(hash, Date.now()).first<{ expires_at_ms: number; role: 'bootstrap' | 'admin'; account_id: string | null; auth_version: number | null; reauthenticated_at_ms: number | null }>();
  if (!row || row.expires_at_ms !== Number(match[2])) throw unauthorized();
  const account = await findAdminAccount(env);
  if (row.role === 'bootstrap') {
    if (account || row.account_id !== null || row.auth_version !== null) throw unauthorized();
    if (!allowBootstrap) throw new IngestError(403, 'bootstrap_only', 'Complete administrator account setup first.');
  } else if (!account || row.account_id !== account.id || row.auth_version !== account.auth_version) throw unauthorized();
  return { hash, role: row.role, expires: row.expires_at_ms, reauthenticatedAt: row.reauthenticated_at_ms, account };
}

export function adminCookie(request: Request, value: string, clear = false): string {
  return `${ADMIN_COOKIE}=${value}; Path=/api/v1/admin; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : ADMIN_SESSION_SECONDS}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}

export function requireFreshSession(session: AdminSession): void {
  if (session.role !== 'admin' || session.reauthenticatedAt === null || Date.now() - session.reauthenticatedAt > ADMIN_REAUTH_MS)
    throw new IngestError(403, 'reauth_required', 'Verify your password or Passkey again before this action.');
}
export const sessionResponse = (session: AdminSession) => session.role === 'bootstrap'
  ? { authenticated: true, role: 'bootstrap', setup_required: true }
  : { authenticated: true, role: 'admin', setup_required: false, account: publicAccount(session.account!) };
export const sessionAssertion = (session: AdminSession, fresh = false): AuthAssertion => session.role === 'bootstrap'
  ? { sql: "EXISTS (SELECT 1 FROM admin_sessions WHERE token_sha256=? AND role='bootstrap' AND expires_at_ms>?) AND NOT EXISTS (SELECT 1 FROM admin_accounts)", bindings: [session.hash, Date.now()] }
  : { sql: `EXISTS (SELECT 1 FROM admin_sessions s JOIN admin_accounts a ON a.id=s.account_id AND a.auth_version=s.auth_version
      WHERE s.token_sha256=? AND s.role='admin' AND s.expires_at_ms>? AND a.id=? AND a.auth_version=? ${fresh ? 'AND s.reauthenticated_at_ms>=?' : ''})`,
    bindings: [session.hash, Date.now(), session.account!.id, session.account!.auth_version, ...(fresh ? [Date.now() - ADMIN_REAUTH_MS] : [])] };
export const accountAssertion = (account: AdminAccount): AuthAssertion => ({
  sql: 'EXISTS (SELECT 1 FROM admin_accounts WHERE id=? AND auth_version=?)', bindings: [account.id, account.auth_version],
});
export function sessionInsert(env: Env, session: Awaited<ReturnType<typeof createAdminSession>>, account: AdminAccount | null, reauthenticatedAt: number | null = null) {
  return env.DB.prepare('INSERT INTO admin_sessions(token_sha256,created_at,expires_at_ms,role,account_id,auth_version,reauthenticated_at_ms) VALUES (?,?,?,?,?,?,?)')
    .bind(session.hash, new Date().toISOString(), session.expires, account ? 'admin' : 'bootstrap', account?.id ?? null, account?.auth_version ?? null, reauthenticatedAt);
}
export function authAudit(env: Env, action: string, target: string, detail: Record<string, unknown> = {}) {
  return env.DB.prepare('INSERT INTO admin_audit(action,target,detail_json,created_at) VALUES (?,?,?,?)')
    .bind(action, target, JSON.stringify(detail), new Date().toISOString());
}
/** The same guard-table transaction pattern protects auth version/counter races. */
export async function authAtomic(env: Env, statements: D1PreparedStatement[], assertions: AuthAssertion[] = []): Promise<void> {
  const ids = assertions.map(() => crypto.randomUUID());
  try {
    await env.DB.batch([
      ...assertions.map((a, i) => env.DB.prepare(`INSERT INTO admin_write_assertions(id,ok) SELECT ?,CASE WHEN (${a.sql}) THEN 1 ELSE 0 END`).bind(ids[i], ...a.bindings)),
      ...statements, ...ids.map(id => env.DB.prepare('DELETE FROM admin_write_assertions WHERE id=?').bind(id)),
    ]);
  } catch (error) {
    let message = '';
    for (let e: unknown = error, depth = 0; e instanceof Error && depth < 4; e = e.cause, depth++) message += e.message;
    if (/constraint|unique|foreign key|auth_passkey_capacity/i.test(message))
      throw new IngestError(409, 'auth_conflict', 'Authentication state changed. Refresh and try again.');
    if (/auth_challenge_capacity/.test(message)) throw new AuthRateLimitError(300);
    throw error;
  }
}

/** Persistent bounded fixed-window admission, before expensive authentication.
 * CF-Connecting-IP is supplied/overwritten by Cloudflare; never trust XFF.
 * The keyed digest prevents plaintext IPs and offline enumeration in D1.
 */
export async function authRateLimit(request: Request, env: Env, secret: string, scope: string, limit = 20, windowMs = 900_000): Promise<void> {
  const now = Date.now(), start = Math.floor(now / windowMs) * windowMs;
  const address = (request.headers.get('CF-Connecting-IP') ?? 'unavailable').slice(0, 128);
  const digest = await sha256(encoder.encode(`campuspulse-auth-rate-v1\0${secret}\0${scope}\0${address}`));
  await env.DB.prepare('DELETE FROM admin_auth_rate_limits WHERE bucket IN (SELECT bucket FROM admin_auth_rate_limits WHERE expires_at_ms<=? LIMIT 100)').bind(now).run();
  for (const [bucket, maximum] of [[`${scope}:${digest}`, limit], [`global:${scope}`, limit * 20]] as const) {
    try {
      const result = await env.DB.prepare(`INSERT INTO admin_auth_rate_limits(bucket,window_start_ms,attempts,expires_at_ms) VALUES (?,?,1,?)
        ON CONFLICT(bucket) DO UPDATE SET window_start_ms=excluded.window_start_ms,
          attempts=CASE WHEN admin_auth_rate_limits.window_start_ms=excluded.window_start_ms THEN admin_auth_rate_limits.attempts+1 ELSE 1 END,
          expires_at_ms=excluded.expires_at_ms
        WHERE admin_auth_rate_limits.window_start_ms!=excluded.window_start_ms OR admin_auth_rate_limits.attempts<?`)
        .bind(bucket, start, start + windowMs, maximum).run();
      if (result.meta.changes !== 1) throw new AuthRateLimitError(Math.max(1, Math.ceil((start + windowMs - now) / 1000)));
    } catch (error) {
      if (error instanceof IngestError) throw error;
      if (error instanceof Error && /auth_rate_capacity/.test(`${error.message} ${error.cause instanceof Error ? error.cause.message : ''}`))
        throw new AuthRateLimitError(300);
      throw error;
    }
  }
}
