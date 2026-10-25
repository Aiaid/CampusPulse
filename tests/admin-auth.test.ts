import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, validatePassword, verifyPassword } from '../worker/admin-password';
import { ACCOUNT, NEW_PASSWORD, ORIGIN, TOKEN, Client, authState, json, type State } from './admin-auth-helpers';

let state: State, client: Client;
beforeEach(async () => { state = await authState(); client = new Client(state); });
afterEach(() => { vi.restoreAllMocks(); state.db.close(); });

describe('one-time account initialization and migration', () => {
  it('revokes all pre-upgrade sessions without rewriting historical registry or audit', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter(name => /^\d+.*\.sql$/.test(name)).sort();
      for (const migration of migrations.filter(name => !name.startsWith('0004'))) db.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
      db.prepare('INSERT INTO admin_sessions(token_sha256,created_at,expires_at_ms) VALUES (?,?,?)').run('synthetic-old-session', new Date().toISOString(), Date.now() + 60000);
      const before = db.prepare('SELECT COUNT(*) n FROM places').get()?.n;
      db.exec(readFileSync(new URL('../migrations/0004_admin_auth.sql', import.meta.url), 'utf8'));
      expect(db.prepare('SELECT COUNT(*) n FROM admin_sessions').get()?.n).toBe(0);
      expect(db.prepare('SELECT COUNT(*) n FROM places').get()?.n).toBe(before);
    } finally { db.close(); }
  });

  it('reports no identity publicly, restricts bootstrap, then disables the token permanently', async () => {
    const status = await json(await client.call('/auth/status'));
    expect(status).toMatchObject({ initialized: false, bootstrap_available: true, password_login_available: false });
    expect(await client.bootstrap()).toMatchObject({ authenticated: true, role: 'bootstrap', setup_required: true });
    const oldBootstrap = client.clone();
    for (const path of ['/devices', '/account', '/configs', '/settings', '/audit', '/overview']) expect((await client.call(path)).status).toBe(403);
    expect((await client.call('/devices', 'POST', { id: 'bootstrap-must-not-write', name: 'Denied', board: 'unknown' })).status).toBe(403);
    const account = await json(await client.call('/auth/setup', 'POST', ACCOUNT), 201);
    expect(account).toMatchObject({ authenticated: true, role: 'admin', setup_required: false, account: { username: ACCOUNT.username, display_name: ACCOUNT.display_name } });
    expect((await oldBootstrap.call('/session')).status).toBe(401);
    expect((await oldBootstrap.call('/auth/setup', 'POST', ACCOUNT)).status).toBeGreaterThanOrEqual(400);
    const anonymous = new Client(state);
    expect((await anonymous.call('/session', 'POST', { token: TOKEN })).status).toBe(401);
    const publicStatus = await json(await anonymous.call('/auth/status'));
    expect(publicStatus).toMatchObject({ initialized: true, bootstrap_available: false, password_login_available: true });
    expect(JSON.stringify(publicStatus)).not.toContain(ACCOUNT.username);
    expect((await anonymous.call('/devices', 'GET', undefined, { Authorization: `Bearer ${TOKEN}` })).status).toBe(401);
  });

  it('resolves simultaneous first-account setup once with one usable new session', async () => {
    await client.bootstrap();
    const second = new Client(state, ORIGIN, '192.0.2.11'); await second.bootstrap();
    const results = await Promise.all([client.call('/auth/setup', 'POST', ACCOUNT), second.call('/auth/setup', 'POST', { ...ACCOUNT, username: 'another-admin' })]);
    expect(results.filter(response => response.status === 201)).toHaveLength(1);
    expect(results.filter(response => response.status >= 400 && response.status < 500)).toHaveLength(1);
    expect(state.db.prepare('SELECT COUNT(*) n FROM admin_accounts').get()?.n).toBe(1);
    expect(state.db.prepare("SELECT COUNT(*) n FROM admin_sessions WHERE role='bootstrap'").get()?.n).toBe(0);
    expect((await Promise.all([client.call('/session'), second.call('/session')])).map(r => r.status).sort()).toEqual([200, 401]);
  });

  it('rolls account creation back when audit cannot persist', async () => {
    await client.bootstrap();
    state.db.exec("CREATE TRIGGER synthetic_auth_audit_outage BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT, 'synthetic_audit_failure'); END");
    expect((await client.call('/auth/setup', 'POST', ACCOUNT)).status).toBe(503);
    expect(state.db.prepare('SELECT COUNT(*) n FROM admin_accounts').get()?.n).toBe(0);
    expect(await json(await client.call('/session'))).toMatchObject({ role: 'bootstrap' });
  });
});

describe('password validation, storage and login boundaries', () => {
  it('uses independently salted versioned scrypt with fixed work factor and preserves whitespace', () => {
    const first = hashPassword(ACCOUNT.password), second = hashPassword(ACCOUNT.password);
    expect(first).toMatch(/^scrypt-v1\$32768\$8\$3\$[0-9a-f]{64}\$[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
    expect(verifyPassword(ACCOUNT.password, first)).toBe(true);
    expect(verifyPassword(ACCOUNT.password.trim(), first)).toBe(false);
    expect(() => verifyPassword(ACCOUNT.password, first.replace('$32768$', '$1024$'))).toThrow();
    expect(validatePassword('密'.repeat(12))).toBe('密'.repeat(12));
    expect(validatePassword('😀'.repeat(256))).toBe('😀'.repeat(256));
    for (const invalid of ['short', 'a'.repeat(257), '😀'.repeat(257), 'long invalid \ud800 sequence', null, 123]) expect(() => validatePassword(invalid)).toThrow();
  });

  it('uses generic wrong-account/password errors and persistent bounded rate limits', async () => {
    await client.initialize();
    const anonymous = new Client(state, ORIGIN, '192.0.2.22');
    const wrongAccount = await json(await anonymous.call('/session', 'POST', { username: 'unknown-admin', password: ACCOUNT.password }), 401);
    const wrongPassword = await json(await anonymous.call('/session', 'POST', { username: ACCOUNT.username, password: 'synthetic wrong password' }), 401);
    expect(wrongAccount).toEqual(wrongPassword);
    let limited: Response | undefined;
    for (let index = 0; index < 20; index++) {
      const response = await anonymous.call('/session', 'POST', { username: ACCOUNT.username, password: 'synthetic wrong password' }, { 'X-Forwarded-For': `198.51.100.${index + 1}` });
      if (response.status === 429) { limited = response; break; }
      expect(response.status).toBe(401);
    }
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get('Retry-After')).toBeTruthy();
    const freshClientSameIP = new Client(state, ORIGIN, '192.0.2.22');
    expect((await freshClientSameIP.call('/session', 'POST', { username: ACCOUNT.username, password: ACCOUNT.password })).status).toBe(429);
    const rows = JSON.stringify(state.db.prepare('SELECT * FROM admin_auth_rate_limits').all());
    expect(rows).not.toContain('192.0.2.22'); expect(rows).not.toContain(ACCOUNT.username);
  }, 15000);

  it('rejects duplicate keys and oversized bodies before authenticating', async () => {
    await client.initialize();
    const headers = { Origin: ORIGIN, 'Content-Type': 'application/json' };
    const { default: worker } = await import('../worker/index');
    const duplicate = await worker.fetch(new Request(`${ORIGIN}/api/v1/admin/session`, { method: 'POST', headers, body: '{"username":"qa-admin","username":"other","password":"synthetic-long-password"}' }), state.env);
    expect(duplicate.status).toBe(400);
    const huge = await client.call('/session', 'POST', { username: ACCOUNT.username, password: 'x'.repeat(40000) });
    expect([413, 422]).toContain(huge.status);
  });

  it('rejects insecure nonlocal transport, cross-origin writes, null Origin and cross-site requests', async () => {
    for (const origin of ['http://admin.example.test', 'http://localhost.attacker.example']) {
      const insecure = new Client(state, origin);
      expect((await insecure.call('/auth/status')).status).toBe(403);
      expect((await insecure.call('/session', 'POST', { token: TOKEN })).status).toBe(403);
    }
    await client.initialize();
    const rejectedHeaders: Record<string, string>[] = [{ Origin: 'null' }, { Origin: 'https://evil.example' }, { Origin: '' }, { 'Sec-Fetch-Site': 'cross-site' }];
    for (const headers of rejectedHeaders) {
      expect((await client.call('/auth/reauth', 'POST', { password: ACCOUNT.password }, headers)).status).toBe(403);
      expect((await client.call('/account', 'PATCH', { username: 'should-not-change', display_name: 'Denied' }, headers)).status).toBe(403);
    }
    const response = await client.call('/account');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });
});

describe('account changes, step-up and session invalidation', () => {
  it('requires session-bound fresh reauthentication and revokes all sessions on password change', async () => {
    const initial = await client.initialize();
    const other = new Client(state, ORIGIN, '192.0.2.23'); await other.login();
    const original = client.clone(), otherOriginal = other.clone();
    state.db.exec('UPDATE admin_sessions SET reauthenticated_at_ms=NULL');
    expect((await client.call('/account', 'PATCH', { username: 'renamed-admin', display_name: 'Renamed' })).status).toBe(403);
    expect((await client.call('/account/password', 'PUT', { new_password: NEW_PASSWORD })).status).toBe(403);
    await client.reauth();
    expect((await other.call('/account/password', 'PUT', { new_password: NEW_PASSWORD })).status).toBe(403);
    const renamed = await json(await client.call('/account', 'PATCH', { username: 'REnamed-Admin', display_name: 'Renamed' }));
    expect(renamed.account).toMatchObject({ id: initial.account.id, username: 'renamed-admin', display_name: 'Renamed' });
    const changed = await client.call('/account/password', 'PUT', { new_password: NEW_PASSWORD });
    expect(await json(changed)).toMatchObject({ changed: true, reauthentication_required: true });
    expect(changed.headers.get('Set-Cookie')).toContain('Max-Age=0');
    for (const stale of [client, original, otherOriginal]) expect((await stale.call('/session')).status).toBe(401);
    const anonymous = new Client(state, ORIGIN, '192.0.2.24');
    expect((await anonymous.call('/session', 'POST', { username: 'renamed-admin', password: ACCOUNT.password })).status).toBe(401);
    await anonymous.login(NEW_PASSWORD, 'renamed-admin');
    expect((await anonymous.call('/devices')).status).toBe(200);
  });

  it('expires step-up in five minutes and fails closed when account auth_version changes', async () => {
    await client.initialize(); await client.reauth();
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 301000);
    expect((await client.call('/account', 'PATCH', { username: 'stale-admin', display_name: 'Denied' })).status).toBe(403);
    vi.restoreAllMocks();
    state.db.exec('UPDATE admin_accounts SET auth_version=auth_version+1');
    expect((await client.call('/session')).status).toBe(401);
    expect((await client.call('/devices')).status).toBe(401);
  });

  it('rolls back account/password changes if audit fails and never exposes password material', async () => {
    await client.initialize(); await client.reauth();
    const before = state.db.prepare('SELECT * FROM admin_accounts').get();
    state.db.exec("CREATE TRIGGER synthetic_auth_audit_outage BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT, 'synthetic_audit_failure'); END");
    expect((await client.call('/account', 'PATCH', { username: 'unaudited-admin', display_name: 'Denied' })).status).toBe(503);
    expect((await client.call('/account/password', 'PUT', { new_password: NEW_PASSWORD })).status).toBe(503);
    expect(state.db.prepare('SELECT * FROM admin_accounts').get()).toEqual(before);
    expect((await client.call('/session')).status).toBe(200);
    state.db.exec('DROP TRIGGER synthetic_auth_audit_outage');
    const exposed = JSON.stringify([await json(await client.call('/account')), await json(await client.call('/session')), await json(await client.call('/audit')), state.db.prepare('SELECT * FROM admin_audit').all()]);
    for (const secret of [TOKEN, ACCOUNT.password, NEW_PASSWORD, String(before?.password_hash), String(before?.webauthn_user_id)]) expect(exposed).not.toContain(secret);
    expect(exposed).not.toMatch(/password_hash|scrypt-v1\$|token_sha256|public_key|clientDataJSON|signature/);
  });
});
