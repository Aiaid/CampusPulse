import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { ACCOUNT, NEW_PASSWORD, ORIGIN, Authenticator, Client, authState, authentication, json, register, type State } from './admin-auth-helpers';

let state: State, client: Client;
beforeEach(async () => { state = await authState(); client = new Client(state); await client.initialize(); await client.reauth(); });
afterEach(() => { vi.restoreAllMocks(); state.db.close(); });

describe('explicit WebAuthn relying-party configuration', () => {
  it('fails closed for missing, mismatched or incomplete production configuration', async () => {
    for (const config of [
      {}, { ADMIN_WEBAUTHN_ORIGIN: ORIGIN }, { ADMIN_WEBAUTHN_RP_ID: 'admin.example.test' },
      { ADMIN_WEBAUTHN_ORIGIN: 'https://another.example.test', ADMIN_WEBAUTHN_RP_ID: 'another.example.test' },
      { ADMIN_WEBAUTHN_ORIGIN: ORIGIN, ADMIN_WEBAUTHN_RP_ID: 'example.test' },
      { ADMIN_WEBAUTHN_ORIGIN: `${ORIGIN}/path`, ADMIN_WEBAUTHN_RP_ID: 'admin.example.test' },
    ]) {
      delete state.env.ADMIN_WEBAUTHN_ORIGIN; delete state.env.ADMIN_WEBAUTHN_RP_ID; Object.assign(state.env, config);
      expect(await json(await client.call('/auth/status'))).toMatchObject({ passkey_available: false, rp_id: null });
      expect((await client.call('/passkeys/registration/options', 'POST', { name: 'Denied' })).status).toBe(503);
      expect((await client.call('/passkeys/authentication/options', 'POST', { intent: 'login' })).status).toBe(503);
    }
  });
});

describe('Passkey registration verification', () => {
  it('registers an actual ES256 key, requires resident UV options, and returns only safe metadata', async () => {
    const { passkey, authenticator, challenge } = await register(client);
    expect(challenge.optionsJSON.authenticatorSelection).toMatchObject({ residentKey: 'required', requireResidentKey: true, userVerification: 'required' });
    expect(challenge.optionsJSON.attestation).toBe('none');
    expect(passkey).toMatchObject({ name: 'Synthetic test authenticator', device_type: 'singleDevice', backed_up: false });
    const exposed = JSON.stringify([await json(await client.call('/account')), await json(await client.call('/passkeys')), await json(await client.call('/audit'))]);
    expect(exposed).not.toContain(authenticator.publicKey.toString('base64url'));
    expect(exposed).not.toContain(authenticator.userHandle);
    expect(exposed).not.toContain(challenge.optionsJSON.challenge);
    expect(exposed).not.toMatch(/public_key|credential_id|clientDataJSON|attestationObject|signature/);
  });

  it.each([
    ['wrong origin', { origin: 'https://evil.example' }], ['wrong RP hash', { rp: 'evil.example' }],
    ['missing UV', { uv: false }], ['explicitly reported non-discoverable key', { resident: false }],
    ['wrong challenge', { challenge: 'synthetic-wrong-challenge' }], ['wrong ceremony', { type: 'webauthn.get' }],
  ] as const)('rejects %s and consumes the failed registration challenge', async (_label, override) => {
    const key = new Authenticator();
    const challenge = await json(await client.call('/passkeys/registration/options', 'POST', { name: 'Invalid authenticator' }));
    const invalid = key.register(challenge.optionsJSON, override);
    expect((await client.call('/passkeys/registration/verify', 'POST', { challenge_id: challenge.challenge_id, response: invalid })).status).toBe(400);
    expect((await client.call('/passkeys/registration/verify', 'POST', { challenge_id: challenge.challenge_id, response: key.register(challenge.optionsJSON) })).status).toBeGreaterThanOrEqual(400);
    expect(state.db.prepare('SELECT COUNT(*) n FROM admin_passkeys').get()?.n).toBe(0);
  });

  it.each([
    ['the entire extension result', undefined],
    ['credProps', {}],
    ['rk', { credProps: {} }],
  ] as const)('accepts a real ES256 registration omitting %s', async (_label, extensions) => {
    const key = new Authenticator();
    const challenge = await json(await client.call('/passkeys/registration/options', 'POST', { name: 'Optional extension result' }));
    const response: any = key.register(challenge.optionsJSON);
    if (extensions === undefined) delete response.clientExtensionResults;
    else response.clientExtensionResults = extensions;
    const verified = await json(await client.call('/passkeys/registration/verify', 'POST', { challenge_id: challenge.challenge_id, response }), 201);
    expect(verified.passkey).toMatchObject({ name: 'Optional extension result', device_type: 'singleDevice' });
    expect(state.db.prepare('SELECT COUNT(*) n FROM admin_passkeys').get()?.n).toBe(1);
  });

  it.each([
    ['null extension result', null], ['array extension result', []],
    ['string extension result', 'invalid'], ['number extension result', 1], ['boolean extension result', true],
    ['null credProps', { credProps: null }], ['array credProps', { credProps: [] }],
    ['string credProps', { credProps: 'invalid' }], ['number credProps', { credProps: 1 }], ['boolean credProps', { credProps: true }],
    ['explicitly reported non-discoverable key', { credProps: { rk: false } }],
    ['null rk', { credProps: { rk: null } }], ['string rk', { credProps: { rk: 'true' } }],
    ['number rk', { credProps: { rk: 1 } }], ['array rk', { credProps: { rk: [] } }], ['object rk', { credProps: { rk: {} } }],
  ] as const)('rejects %s and consumes the registration challenge without storing a key', async (_label, extensions) => {
    const key = new Authenticator();
    const challenge = await json(await client.call('/passkeys/registration/options', 'POST', { name: 'Invalid extension result' }));
    const response = { ...key.register(challenge.optionsJSON), clientExtensionResults: extensions };
    expect((await client.call('/passkeys/registration/verify', 'POST', { challenge_id: challenge.challenge_id, response })).status).toBe(400);
    expect((await client.call('/passkeys/registration/verify', 'POST', { challenge_id: challenge.challenge_id, response: key.register(challenge.optionsJSON) })).status).toBe(400);
    expect(state.db.prepare('SELECT COUNT(*) n FROM admin_passkeys').get()?.n).toBe(0);
  });

  it.each([
    ['wrong origin', { origin: 'https://evil.example' }], ['wrong RP hash', { rp: 'evil.example' }],
    ['wrong challenge', { challenge: 'synthetic-wrong-challenge' }], ['wrong ceremony', { type: 'webauthn.get' }],
    ['missing UV', { uv: false }], ['missing UP', {}],
  ] as const)('still rejects %s when registration extensions are omitted', async (label, override) => {
    const key = new Authenticator();
    const challenge = await json(await client.call('/passkeys/registration/options', 'POST', { name: 'Omitted extensions with invalid authenticator' }));
    const response: any = key.register(challenge.optionsJSON, override);
    delete response.clientExtensionResults;
    if (label === 'missing UP') {
      const attestation = isoCBOR.decodeFirst<Map<string, any>>(Buffer.from(response.response.attestationObject, 'base64url'));
      const authData = Buffer.from(attestation.get('authData'));
      authData[32] &= ~0x01;
      attestation.set('authData', authData);
      response.response.attestationObject = Buffer.from(isoCBOR.encode(attestation)).toString('base64url');
    }
    expect((await client.call('/passkeys/registration/verify', 'POST', { challenge_id: challenge.challenge_id, response })).status).toBe(400);
    expect((await client.call('/passkeys/registration/verify', 'POST', { challenge_id: challenge.challenge_id, response: key.register(challenge.optionsJSON) })).status).toBe(400);
    expect(state.db.prepare('SELECT COUNT(*) n FROM admin_passkeys').get()?.n).toBe(0);
  });

  it('binds registration to its authenticated session and expiry', async () => {
    const key = new Authenticator();
    const challenge = await json(await client.call('/passkeys/registration/options', 'POST', { name: 'Bound key' }));
    const other = new Client(state, ORIGIN, '192.0.2.40'); await other.login(); await other.reauth();
    const response = key.register(challenge.optionsJSON);
    expect((await other.call('/passkeys/registration/verify', 'POST', { challenge_id: challenge.challenge_id, response })).status).toBeGreaterThanOrEqual(400);
    const expiring = await json(await client.call('/passkeys/registration/options', 'POST', { name: 'Expired key' }));
    state.db.prepare('UPDATE admin_auth_challenges SET expires_at_ms=? WHERE id=?').run(Date.now() - 1, expiring.challenge_id);
    expect((await client.call('/passkeys/registration/verify', 'POST', { challenge_id: expiring.challenge_id, response: key.register(expiring.optionsJSON) })).status).toBeGreaterThanOrEqual(400);
    expect(state.db.prepare('SELECT COUNT(*) n FROM admin_passkeys').get()?.n).toBe(0);
  });

  it.each(['credential-id', 'transport-shape', 'cross-origin', 'top-origin', 'duplicate-client-json'])('rejects malformed registration %s before storing a key', async kind => {
    const key = new Authenticator();
    const challenge = await json(await client.call('/passkeys/registration/options', 'POST', { name: 'Malformed key' }));
    const response: any = key.register(challenge.optionsJSON);
    if (kind === 'credential-id') response.id = response.rawId = 'Zm9yZWlnbi1jcmVkZW50aWFs';
    if (kind === 'transport-shape') response.response.transports = 'internal';
    const clientData = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString());
    if (kind === 'cross-origin') clientData.crossOrigin = true;
    if (kind === 'top-origin') clientData.topOrigin = 'https://evil.example';
    let serialized = JSON.stringify(clientData);
    if (kind === 'duplicate-client-json') serialized = serialized.replace('"challenge":', '"challenge":"wrong","challenge":');
    response.response.clientDataJSON = Buffer.from(serialized).toString('base64url');
    expect((await client.call('/passkeys/registration/verify', 'POST', { challenge_id: challenge.challenge_id, response })).status).toBe(400);
    expect(state.db.prepare('SELECT COUNT(*) n FROM admin_passkeys').get()?.n).toBe(0);
  });

  it('allows only one concurrent consume and one binding for a credential', async () => {
    const key = new Authenticator();
    const challenge = await json(await client.call('/passkeys/registration/options', 'POST', { name: 'Concurrent key' }));
    const body = { challenge_id: challenge.challenge_id, response: key.register(challenge.optionsJSON) };
    const statuses = (await Promise.all([client.call('/passkeys/registration/verify', 'POST', body), client.call('/passkeys/registration/verify', 'POST', body)])).map(r => r.status);
    expect(statuses.filter(status => status === 201)).toHaveLength(1);
    expect(statuses.filter(status => status >= 400 && status < 500)).toHaveLength(1);
    const again = await json(await client.call('/passkeys/registration/options', 'POST', { name: 'Duplicate key' }));
    expect(again.optionsJSON.excludeCredentials).toEqual(expect.arrayContaining([expect.objectContaining({ id: key.id })]));
    expect((await client.call('/passkeys/registration/verify', 'POST', { challenge_id: again.challenge_id, response: key.register(again.optionsJSON) })).status).toBeGreaterThanOrEqual(400);
    expect(state.db.prepare('SELECT COUNT(*) n FROM admin_passkeys').get()?.n).toBe(1);
  });
});

describe('signed Passkey authentication and challenge lifetime', () => {
  it('uses an extension-omitting registered key for signed login and reauthentication, rejecting replays', async () => {
    const authenticator = new Authenticator();
    const registration = await json(await client.call('/passkeys/registration/options', 'POST', { name: 'Extension-omitting key' }));
    const response: any = authenticator.register(registration.optionsJSON);
    delete response.clientExtensionResults;
    await json(await client.call('/passkeys/registration/verify', 'POST', { challenge_id: registration.challenge_id, response }), 201);

    const anonymous = new Client(state, ORIGIN, '192.0.2.57');
    const login = await authentication(anonymous, authenticator);
    expect(login.challenge.optionsJSON.allowCredentials ?? []).toEqual([]);
    expect(await json(await anonymous.call('/passkeys/authentication/verify', 'POST', login.body))).toMatchObject({ authenticated: true, account: { username: ACCOUNT.username } });
    expect((await anonymous.call('/passkeys/authentication/verify', 'POST', login.body)).status).toBe(400);
    expect((await anonymous.call('/devices')).status).toBe(200);

    state.db.exec('UPDATE admin_sessions SET reauthenticated_at_ms=NULL');
    expect((await anonymous.call('/account', 'PATCH', { username: ACCOUNT.username, display_name: 'Needs reauthentication' })).status).toBe(403);
    const reauth = await authentication(anonymous, authenticator, 'reauth');
    expect(await json(await anonymous.call('/passkeys/authentication/verify', 'POST', reauth.body))).toMatchObject({ reauthenticated: true });
    expect((await anonymous.call('/passkeys/authentication/verify', 'POST', reauth.body)).status).toBe(400);
    expect((await anonymous.call('/account', 'PATCH', { username: ACCOUNT.username, display_name: 'Verified with omitted extensions' })).status).toBe(200);
  });

  it('logs in with a discoverable synced zero-counter key and rejects a replayed challenge', async () => {
    const { authenticator } = await register(client, new Authenticator(0, true));
    const anonymous = new Client(state, ORIGIN, '192.0.2.41');
    for (let attempt = 0; attempt < 2; attempt++) {
      const { challenge, body } = await authentication(anonymous, authenticator);
      expect(challenge.optionsJSON.userVerification).toBe('required');
      expect(challenge.optionsJSON.allowCredentials ?? []).toEqual([]);
      const result = await json(await anonymous.call('/passkeys/authentication/verify', 'POST', body));
      expect(result).toMatchObject({ authenticated: true, role: 'admin', account: { username: ACCOUNT.username } });
      expect((await anonymous.call('/passkeys/authentication/verify', 'POST', body)).status).toBeGreaterThanOrEqual(400);
      expect((await anonymous.call('/devices')).status).toBe(200);
      await json(await anonymous.call('/session', 'DELETE'));
    }
    expect(state.db.prepare('SELECT counter,device_type,backed_up,last_used_at FROM admin_passkeys').get()).toMatchObject({ counter: 0, device_type: 'multiDevice', backed_up: 1, last_used_at: expect.any(String) });
  });

  it('accepts a change in backup state but rejects a signed change of permanent backup eligibility', async () => {
    const { authenticator } = await register(client, new Authenticator(0, true));
    const anonymous = new Client(state, ORIGIN, '192.0.2.56');
    authenticator.backedUp = false; // BE remains true; BS may change over time.
    const changedState = await authentication(anonymous, authenticator);
    expect((await anonymous.call('/passkeys/authentication/verify', 'POST', changedState.body)).status).toBe(200);
    expect(state.db.prepare('SELECT device_type,backed_up FROM admin_passkeys').get()).toMatchObject({ device_type: 'multiDevice', backed_up: 0 });
    await json(await anonymous.call('/session', 'DELETE'));
    authenticator.backupEligible = false;
    const changedEligibility = await authentication(anonymous, authenticator);
    expect((await anonymous.call('/passkeys/authentication/verify', 'POST', changedEligibility.body)).status).toBe(400);
    expect((await anonymous.call('/devices')).status).toBe(401);
  });

  it.each([
    ['wrong origin', { origin: 'https://evil.example' }], ['wrong RP hash', { rp: 'evil.example' }],
    ['missing UV', { uv: false }], ['wrong user handle', { userHandle: 'd3JvbmctdXNlcg' }],
    ['missing user handle', { userHandle: null }], ['wrong challenge', { challenge: 'incorrect-challenge' }],
    ['wrong ceremony', { type: 'webauthn.create' }],
  ] as const)('rejects signed assertion with %s and consumes failed challenge', async (_label, override) => {
    const { authenticator } = await register(client);
    const anonymous = new Client(state, ORIGIN, '192.0.2.42');
    const { body, challenge } = await authentication(anonymous, authenticator, 'login', override);
    expect((await anonymous.call('/passkeys/authentication/verify', 'POST', body)).status).toBe(400);
    expect((await anonymous.call('/passkeys/authentication/verify', 'POST', { challenge_id: challenge.challenge_id, response: authenticator.authenticate(challenge.optionsJSON) })).status).toBeGreaterThanOrEqual(400);
    expect((await anonymous.call('/devices')).status).toBe(401);
  });

  it('rejects an otherwise valid assertion signed by a different private key', async () => {
    const { authenticator } = await register(client);
    const wrong = new Authenticator();
    const anonymous = new Client(state, ORIGIN, '192.0.2.43');
    const { body } = await authentication(anonymous, authenticator, 'login', { signingKey: wrong.privateKey });
    expect((await anonymous.call('/passkeys/authentication/verify', 'POST', body)).status).toBe(400);
    expect((await anonymous.call('/devices')).status).toBe(401);
  });

  it('binds anonymous login challenge to its browser cookie and consumes concurrent verify once', async () => {
    const { authenticator } = await register(client);
    const anonymous = new Client(state, ORIGIN, '192.0.2.44');
    const { body } = await authentication(anonymous, authenticator);
    expect(anonymous.cookies.get('cp_admin_passkey')).toBeTruthy();
    const unrelated = new Client(state, ORIGIN, '192.0.2.45');
    expect((await unrelated.call('/passkeys/authentication/verify', 'POST', body)).status).toBeGreaterThanOrEqual(400);
    const fresh = await authentication(anonymous, authenticator);
    const clone = anonymous.clone();
    const statuses = (await Promise.all([anonymous.call('/passkeys/authentication/verify', 'POST', fresh.body), clone.call('/passkeys/authentication/verify', 'POST', fresh.body)])).map(r => r.status);
    expect(statuses.filter(status => status === 200)).toHaveLength(1);
    expect(statuses.filter(status => status >= 400 && status < 500)).toHaveLength(1);
  });

  it('prevents nonzero counter rollback and concurrent duplicate-counter use across distinct challenges', async () => {
    const { authenticator } = await register(client, new Authenticator(5));
    const first = new Client(state, ORIGIN, '192.0.2.46'), second = new Client(state, ORIGIN, '192.0.2.47');
    const one = await authentication(first, authenticator, 'login', { counter: 6 });
    const two = await authentication(second, authenticator, 'login', { counter: 6 });
    const statuses = (await Promise.all([first.call('/passkeys/authentication/verify', 'POST', one.body), second.call('/passkeys/authentication/verify', 'POST', two.body)])).map(r => r.status);
    expect(statuses.filter(status => status === 200)).toHaveLength(1);
    expect(statuses.filter(status => status >= 400 && status < 500)).toHaveLength(1);
    expect(state.db.prepare('SELECT counter FROM admin_passkeys').get()?.counter).toBe(6);
    const rollback = await authentication(second, authenticator, 'login', { counter: 5 });
    expect((await second.call('/passkeys/authentication/verify', 'POST', rollback.body)).status).toBe(400);
  });

  it('separates login and reauthentication intent and binds step-up to the initiating session', async () => {
    const { authenticator } = await register(client);
    state.db.exec('UPDATE admin_sessions SET reauthenticated_at_ms=NULL');
    const other = new Client(state, ORIGIN, '192.0.2.48'); await other.login();
    state.db.exec('UPDATE admin_sessions SET reauthenticated_at_ms=NULL');
    const anonymous = new Client(state, ORIGIN, '192.0.2.49');
    expect((await anonymous.call('/passkeys/authentication/options', 'POST', { intent: 'reauth' })).status).toBe(401);
    const bound = await authentication(client, authenticator, 'reauth');
    expect((await other.call('/passkeys/authentication/verify', 'POST', bound.body)).status).toBeGreaterThanOrEqual(400);
    const actual = await authentication(client, authenticator, 'reauth');
    expect(await json(await client.call('/passkeys/authentication/verify', 'POST', actual.body))).toMatchObject({ reauthenticated: true });
    expect((await other.call('/account', 'PATCH', { username: 'stolen-step-up', display_name: 'Denied' })).status).toBe(403);
    expect((await client.call('/account', 'PATCH', { username: 'passkey-reauth-admin', display_name: 'Verified' })).status).toBe(200);
  });

  it('invalidates pending challenges on password change while retaining registered keys for new login', async () => {
    const { authenticator } = await register(client);
    const anonymous = new Client(state, ORIGIN, '192.0.2.50');
    const pending = await authentication(anonymous, authenticator);
    await json(await client.call('/account/password', 'PUT', { new_password: NEW_PASSWORD }));
    expect((await anonymous.call('/passkeys/authentication/verify', 'POST', pending.body)).status).toBeGreaterThanOrEqual(400);
    const fresh = await authentication(anonymous, authenticator);
    expect((await anonymous.call('/passkeys/authentication/verify', 'POST', fresh.body)).status).toBe(200);
  });

  it('rejects expired login challenges and cannot use registration as an authentication ceremony', async () => {
    const { authenticator } = await register(client);
    const anonymous = new Client(state, ORIGIN, '192.0.2.52');
    const expired = await authentication(anonymous, authenticator);
    state.db.prepare('UPDATE admin_auth_challenges SET expires_at_ms=? WHERE id=?').run(Date.now() - 1, expired.challenge.challenge_id);
    expect((await anonymous.call('/passkeys/authentication/verify', 'POST', expired.body)).status).toBe(400);
    const wrongIntent = await json(await client.call('/passkeys/registration/options', 'POST', { name: 'Wrong ceremony' }));
    expect((await anonymous.call('/passkeys/authentication/verify', 'POST', { challenge_id: wrongIntent.challenge_id, response: authenticator.authenticate({ ...wrongIntent.optionsJSON, rpId: 'admin.example.test' }) })).status).toBe(400);
    expect((await anonymous.call('/devices')).status).toBe(401);
  });

  it('rolls back a verified login and counter update when audit fails while consuming its challenge', async () => {
    const { authenticator } = await register(client, new Authenticator(8));
    const anonymous = new Client(state, ORIGIN, '192.0.2.53');
    const signed = await authentication(anonymous, authenticator, 'login', { counter: 9 });
    const sessionsBefore = state.db.prepare('SELECT COUNT(*) n FROM admin_sessions').get()?.n;
    state.db.exec("CREATE TRIGGER synthetic_auth_audit_outage BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT, 'synthetic_audit_failure'); END");
    expect((await anonymous.call('/passkeys/authentication/verify', 'POST', signed.body)).status).toBe(503);
    expect(state.db.prepare('SELECT counter FROM admin_passkeys').get()?.counter).toBe(8);
    expect(state.db.prepare('SELECT COUNT(*) n FROM admin_sessions').get()?.n).toBe(sessionsBefore);
    expect((await anonymous.call('/devices')).status).toBe(401);
    state.db.exec('DROP TRIGGER synthetic_auth_audit_outage');
    expect((await anonymous.call('/passkeys/authentication/verify', 'POST', signed.body)).status).toBe(400);
  });

  it('rejects account revocation that races successful signature verification before the commit', async () => {
    const { authenticator } = await register(client, new Authenticator(10));
    const anonymous = new Client(state, ORIGIN, '192.0.2.54');
    const signed = await authentication(anonymous, authenticator, 'login', { counter: 11 });
    const actualBatch = state.env.DB.batch.bind(state.env.DB);
    state.env.DB.batch = (async statements => {
      state.db.exec('UPDATE admin_accounts SET auth_version=auth_version+1; DELETE FROM admin_sessions');
      state.env.DB.batch = actualBatch;
      return actualBatch(statements);
    }) as D1Database['batch'];
    expect((await anonymous.call('/passkeys/authentication/verify', 'POST', signed.body)).status).toBe(409);
    expect(state.db.prepare('SELECT counter FROM admin_passkeys').get()?.counter).toBe(10);
    expect(state.db.prepare('SELECT COUNT(*) n FROM admin_sessions').get()?.n).toBe(0);
    expect((await anonymous.call('/devices')).status).toBe(401);
  });

  it('rate-limits public options and verify independently in persistent D1 buckets', async () => {
    const anonymous = new Client(state, ORIGIN, '192.0.2.55');
    for (let index = 0; index < 40; index++) {
      expect((await anonymous.call('/passkeys/authentication/options', 'POST', { intent: 'login' })).status).toBe(200);
      expect((await anonymous.call('/passkeys/authentication/verify', 'POST', { challenge_id: crypto.randomUUID(), response: {} })).status).toBe(400);
    }
    expect((await anonymous.call('/passkeys/authentication/options', 'POST', { intent: 'login' })).status).toBe(429);
    expect((await anonymous.call('/passkeys/authentication/verify', 'POST', { challenge_id: crypto.randomUUID(), response: {} })).status).toBe(429);
  });
});

describe('Passkey management', () => {
  it('requires fresh reauthentication for naming/removal and removed credentials cannot log in', async () => {
    const { authenticator, passkey } = await register(client);
    state.db.exec('UPDATE admin_sessions SET reauthenticated_at_ms=NULL');
    expect((await client.call(`/passkeys/${passkey.id}`, 'PATCH', { name: 'Updated' })).status).toBe(403);
    expect((await client.call(`/passkeys/${passkey.id}`, 'DELETE')).status).toBe(403);
    await client.reauth();
    expect((await client.call(`/passkeys/${passkey.id}`, 'PATCH', { name: 'x'.repeat(81) })).status).toBe(422);
    expect((await client.call(`/passkeys/${passkey.id}`, 'PATCH', { name: 'key\ncontrol' })).status).toBe(422);
    expect(await json(await client.call(`/passkeys/${passkey.id}`, 'PATCH', { name: 'Renamed local key' }))).toMatchObject({ passkey: { id: passkey.id, name: 'Renamed local key' } });
    expect(await json(await client.call(`/passkeys/${passkey.id}`, 'DELETE'))).toMatchObject({ deleted: true });
    expect(await json(await client.call('/passkeys'))).toMatchObject({ passkeys: [] });
    const anonymous = new Client(state, ORIGIN, '192.0.2.51');
    const challenge = await authentication(anonymous, authenticator);
    expect((await anonymous.call('/passkeys/authentication/verify', 'POST', challenge.body)).status).toBe(400);
    await anonymous.login();
  });

  it('rolls credential addition and removal back if the corresponding audit cannot persist', async () => {
    const { passkey } = await register(client);
    const key = new Authenticator();
    const challenge = await json(await client.call('/passkeys/registration/options', 'POST', { name: 'Unaudited key' }));
    state.db.exec("CREATE TRIGGER synthetic_auth_audit_outage BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT, 'synthetic_audit_failure'); END");
    expect((await client.call('/passkeys/registration/verify', 'POST', { challenge_id: challenge.challenge_id, response: key.register(challenge.optionsJSON) })).status).toBe(503);
    expect((await client.call(`/passkeys/${passkey.id}`, 'DELETE')).status).toBe(503);
    expect(state.db.prepare('SELECT COUNT(*) n FROM admin_passkeys').get()?.n).toBe(1);
  });
});
