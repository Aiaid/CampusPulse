import type { Env } from './types';
import { IngestError } from './strict-json';
import { json } from './http';
import {
  accountAssertion, adminCookie, adminTokenMatches, authAtomic, authAudit, authRateLimit, base64url,
  createAdminSession, findAdminAccount, publicAccount, requireAdminSession, requireFreshSession,
  sessionAssertion, sessionInsert, sessionResponse, unauthorized, ADMIN_REAUTH_MS, type AdminAccount,
} from './admin-auth';
import { DUMMY_PASSWORD_HASH, hashPassword, validatePassword, verifyPassword } from './admin-password';
import { handlePasskeys, passkeyContext, publicPasskeys } from './admin-passkeys';
import { authBody, authName, authObject } from './admin-auth-input';
function username(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(value.toLowerCase()))
    throw new IngestError(422, 'invalid_username', 'Use 3–64 letters, numbers, underscores, dots or hyphens; start with a letter or number.');
  return value.toLowerCase();
}
function loginPassword(value: unknown): { password: string; valid: boolean } {
  // A malformed credential follows the same expensive dummy/real verifier path
  // as a wrong credential; never validate account existence through error text.
  try { return { password: validatePassword(value), valid: true }; }
  catch { return { password: '\0invalid-password', valid: false }; }
}

export async function handleAdminIdentity(request: Request, env: Env, secret: string, route: string): Promise<Response | null> {
  if (route.startsWith('/passkeys')) return handlePasskeys(request, env, secret, route);
  if (!['/auth/status', '/session', '/auth/setup', '/auth/reauth', '/account', '/account/password'].includes(route)) return null;
  if (route === '/auth/status' && request.method === 'GET') {
    const account = await findAdminAccount(env);
    let rp: ReturnType<typeof passkeyContext> | null = null, unavailable: string | null = null;
    try { rp = passkeyContext(request, env); } catch (error) { unavailable = error instanceof IngestError ? error.code : 'passkey_not_configured'; }
    return json({ initialized: !!account, bootstrap_available: !account, password_login_available: !!account,
      passkey_available: !!account && !!rp, rp_id: rp?.rpID ?? null, passkey_unavailable_code: unavailable });
  }
  if (route === '/session' && request.method === 'POST') {
    await authRateLimit(request, env, secret, 'login');
    const value = await authBody(request, 4096);
    const o = authObject(value, [], ['token', 'username', 'password']);
    const account = await findAdminAccount(env);
    if ('token' in o) {
      if (Object.keys(o).length !== 1 || account || typeof o.token !== 'string' || o.token.length > 1024 || !await adminTokenMatches(o.token, secret)) throw unauthorized();
      const session = await createAdminSession(secret);
      await authAtomic(env, [env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at_ms<=?').bind(Date.now()),
        sessionInsert(env, session, null), authAudit(env, 'session.bootstrap', 'setup', { method: 'bootstrap' })],
      [{ sql: 'NOT EXISTS (SELECT 1 FROM admin_accounts)', bindings: [] }]);
      const response = json({ authenticated: true, role: 'bootstrap', setup_required: true });
      response.headers.set('Set-Cookie', adminCookie(request, session.value));
      return response;
    }
    const candidate = loginPassword(o.password);
    const verified = verifyPassword(candidate.password, account?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!candidate.valid || !verified || !account || typeof o.username !== 'string' || o.username.toLowerCase() !== account.username || Object.keys(o).length !== 2) throw unauthorized();
    const session = await createAdminSession(secret);
    await authAtomic(env, [env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at_ms<=?').bind(Date.now()),
      sessionInsert(env, session, account, Date.now()), authAudit(env, 'session.login', account.id, { method: 'password' })], [accountAssertion(account)]);
    const response = json({ authenticated: true, role: 'admin', setup_required: false, account: publicAccount(account) });
    response.headers.set('Set-Cookie', adminCookie(request, session.value));
    return response;
  }
  const session = await requireAdminSession(request, env, secret, route === '/session' || route === '/auth/setup');
  if (route === '/session') {
    if (request.method === 'GET') return json(sessionResponse(session));
    if (request.method === 'DELETE') {
      await authAtomic(env, [env.DB.prepare('DELETE FROM admin_auth_challenges WHERE session_sha256=?').bind(session.hash),
        env.DB.prepare('DELETE FROM admin_sessions WHERE token_sha256=?').bind(session.hash),
        authAudit(env, 'session.logout', session.account?.id ?? 'setup', {})]);
      const response = json({ authenticated: false });
      response.headers.set('Set-Cookie', adminCookie(request, '', true));
      return response;
    }
  }
  if (route === '/auth/setup' && request.method === 'POST') {
    if (session.role !== 'bootstrap') throw new IngestError(409, 'already_initialized', 'Administrator account setup is complete.');
    await authRateLimit(request, env, secret, 'setup', 5);
    const o = authObject(await authBody(request, 4096), ['username', 'display_name', 'password']);
    const now = new Date().toISOString();
    const account: AdminAccount = { id: crypto.randomUUID(), username: username(o.username), display_name: authName(o.display_name),
      password_hash: hashPassword(validatePassword(o.password)), webauthn_user_id: base64url(crypto.getRandomValues(new Uint8Array(32))),
      auth_version: 1, profile_revision: 1, created_at: now, updated_at: now };
    const replacement = await createAdminSession(secret);
    await authAtomic(env, [
      env.DB.prepare('INSERT INTO admin_accounts(id,username,display_name,password_hash,webauthn_user_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .bind(account.id, account.username, account.display_name, account.password_hash, account.webauthn_user_id, now, now),
      env.DB.prepare('DELETE FROM admin_auth_challenges'), env.DB.prepare('DELETE FROM admin_sessions'),
      sessionInsert(env, replacement, account, Date.now()), authAudit(env, 'account.setup', account.id, { method: 'bootstrap' }),
    ], [sessionAssertion(session)]);
    const response = json({ authenticated: true, role: 'admin', setup_required: false, account: publicAccount(account) }, 201);
    response.headers.set('Set-Cookie', adminCookie(request, replacement.value));
    return response;
  }
  const account = session.account!;
  if (route === '/auth/reauth' && request.method === 'POST') {
    await authRateLimit(request, env, secret, 'reauth', 10, 300_000);
    const o = authObject(await authBody(request, 4096), ['password']);
    const candidate = loginPassword(o.password);
    if (!verifyPassword(candidate.password, account.password_hash) || !candidate.valid) throw unauthorized();
    const now = Date.now();
    await authAtomic(env, [env.DB.prepare('UPDATE admin_sessions SET reauthenticated_at_ms=? WHERE token_sha256=?').bind(now, session.hash),
      authAudit(env, 'session.reauthenticate', account.id, { method: 'password' })], [sessionAssertion(session)]);
    return json({ reauthenticated: true, expires_at: new Date(now + ADMIN_REAUTH_MS).toISOString() });
  }
  if (route === '/account') {
    if (request.method === 'GET') return json({ account: publicAccount(account), passkeys: await publicPasskeys(env, account.id),
      reauth_required: session.reauthenticatedAt === null || Date.now() - session.reauthenticatedAt > ADMIN_REAUTH_MS });
    if (request.method === 'PATCH') {
      requireFreshSession(session);
      const o = authObject(await authBody(request, 4096), ['username', 'display_name']);
      const normalized = username(o.username), name = authName(o.display_name);
      await authAtomic(env, [env.DB.prepare('UPDATE admin_accounts SET username=?,display_name=?,profile_revision=profile_revision+1,updated_at=? WHERE id=? AND profile_revision=?')
        .bind(normalized, name, new Date().toISOString(), account.id, account.profile_revision), authAudit(env, 'account.update', account.id, { fields: ['username', 'display_name'] })],
      [sessionAssertion(session, true), { sql: 'EXISTS (SELECT 1 FROM admin_accounts WHERE id=? AND profile_revision=?)', bindings: [account.id, account.profile_revision] }]);
      return json({ account: publicAccount({ ...account, username: normalized, display_name: name }) });
    }
  }
  if (route === '/account/password' && request.method === 'PUT') {
    requireFreshSession(session);
    await authRateLimit(request, env, secret, 'password-change', 5, 300_000);
    const o = authObject(await authBody(request, 4096), ['new_password']);
    const passwordHash = hashPassword(validatePassword(o.new_password));
    await authAtomic(env, [env.DB.prepare('UPDATE admin_accounts SET password_hash=?,auth_version=auth_version+1,updated_at=? WHERE id=? AND auth_version=?')
      .bind(passwordHash, new Date().toISOString(), account.id, account.auth_version),
      env.DB.prepare('DELETE FROM admin_auth_challenges'), env.DB.prepare('DELETE FROM admin_sessions'),
      authAudit(env, 'account.password_change', account.id, { sessions_revoked: true })], [sessionAssertion(session, true)]);
    const response = json({ changed: true, reauthentication_required: true });
    response.headers.set('Set-Cookie', adminCookie(request, '', true));
    return response;
  }
  throw new IngestError(405, 'method_not_allowed', 'Method is not supported for this authentication resource.');
}
