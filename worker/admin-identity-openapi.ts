/** Additional account/bootstrap/WebAuthn contract; cryptographic payloads stay opaque. */
export function createAdminIdentityOpenApi() {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const entity = (properties: Record<string, object>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
  const string = { type: 'string' };
  const name = { type: 'string', minLength: 1, maxLength: 80 };
  const uuid = { type: 'string', format: 'uuid' };
  const username = { type: 'string', minLength: 3, maxLength: 64, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$', description: 'Normalized to lowercase; account identity and Passkeys do not change when this name changes.' };
  const password = { type: 'string', minLength: 12, maxLength: 256, writeOnly: true, description: '12–256 Unicode characters, at most1024 UTF-8 bytes, preserved exactly including spaces. Never returned or audited.' };
  const response = (description: string, schema: object = { type: 'object' }) => ({ description, content: { 'application/json': { schema } } });
  const errors = {
    '400': response('Passkey proof, browser binding or one-use challenge is invalid. Begin a new ceremony.'),
    '401': response('Incorrect credentials or absent/expired/revoked session. Username/password failures use a generic response.'),
    '403': response('Origin, session role or fresh reauthentication does not permit this action.'),
    '404': response('Unknown account-owned Passkey.'),
    '409': response('Concurrent setup/account/session/key state changed; no partial account or audit write.'),
    '413': response('Authentication JSON exceeds its bounded request size.'),
    '422': response('Unsupported fields or invalid account/password/name input.'),
    '429': { ...response('Too many attempts; honor Retry-After.'), headers: { 'Retry-After': { schema: { type: 'integer', minimum: 1 } } } },
    '503': response('Administrator secret, storage or trusted Passkey origin/RP configuration is unavailable.'),
  };
  function operation(operationId: string, summary: string, schema: object | null, description: string, publicRoute = false, status = '200', result: object = { type: 'object' }) {
    return { operationId, summary, description, tags: ['Administration'], security: publicRoute ? [] : [{ AdminSession: [] }],
      ...(schema ? { requestBody: { required: true, content: { 'application/json': { schema } } } } : {}),
      responses: { [status]: response('Committed authentication result; no plaintext password or stored hash/public-key blob.', result), ...errors } };
  }
  const proof = entity({ challenge_id: uuid, response: { type: 'object', description: 'Unmodified RegistrationResponseJSON or AuthenticationResponseJSON produced by @simplewebauthn/browser. The server performs complete verification.' } });
  return {
    schemas: {
      AdminAccount: entity({ id: uuid, username, display_name: name }),
      AdminAuthenticationStatus: entity({ initialized: { type: 'boolean' }, bootstrap_available: { type: 'boolean' }, password_login_available: { type: 'boolean' }, passkey_available: { type: 'boolean' }, rp_id: { type: ['string', 'null'] }, passkey_unavailable_code: { type: ['string', 'null'] } }),
      AdminPasskey: entity({ id: uuid, name, created_at: { type: 'string', format: 'date-time' }, last_used_at: { type: ['string', 'null'], format: 'date-time' }, device_type: { type: 'string', enum: ['singleDevice', 'multiDevice'] }, backed_up: { type: 'boolean' } }),
      AdminSessionState: { oneOf: [entity({ authenticated: { type: 'boolean', const: true }, role: { type: 'string', const: 'bootstrap' }, setup_required: { type: 'boolean', const: true } }), entity({ authenticated: { type: 'boolean', const: true }, role: { type: 'string', const: 'admin' }, setup_required: { type: 'boolean', const: false }, account: ref('AdminAccount') })] },
    },
    paths: {
      '/api/v1/admin/auth/status': { get: operation('getAdminAuthenticationStatus', 'Read first-use state and available login methods', null, 'Does not disclose username, password or Passkey identifiers. Passkey availability requires explicitly trusted production origin/RP configuration; loopback-only development can derive it.', true, '200', ref('AdminAuthenticationStatus')) },
      '/api/v1/admin/session': {
        get: operation('getAdminSession', 'Read the current bootstrap or administrator session', null, 'Bootstrap authority is limited to initial setup/logout. Account sessions are bound to the current account authentication version.', false, '200', ref('AdminSessionState')),
        post: operation('createAdminSession', 'Log in for initial setup, or with username and password', { oneOf: [entity({ token: { ...string, writeOnly: true } }), entity({ username: string, password: { ...string, writeOnly: true } })] }, 'A bootstrap token works only before the single administrator account is initialized. After setup it cannot bypass account authentication. Requires exact same-origin Origin. Sets an eight-hour signed, revocable HttpOnly/SameSite=Strict session cookie; Secure on HTTPS.', true, '200', ref('AdminSessionState')),
        delete: operation('deleteAdminSession', 'Log out and revoke this session', null, 'Clears the cookie and associated pending session challenges; works for bootstrap and full administrator sessions.'),
      },
      '/api/v1/admin/auth/setup': { post: operation('setupAdminAccount', 'Create the single administrator account once', entity({ username, display_name: name, password }), 'Requires a valid restricted bootstrap session, not a public signup. Concurrent setup is guarded atomically. Creates a new full account session and invalidates prior/bootstrap sessions.', false, '201', ref('AdminSessionState')) },
      '/api/v1/admin/account': {
        get: operation('getAdminAccount', 'Read own profile, Passkey metadata and step-up state', null, 'Returns account, passkeys and reauth_required; never returns password hashes, salts or public-key blobs.'),
        patch: operation('updateAdminAccount', 'Change username and display name', entity({ username, display_name: name }), 'Requires a full session and successful password/Passkey reauthentication within five minutes. Stable account ID preserves existing Passkeys. Mutation and redacted audit are atomic.'),
      },
      '/api/v1/admin/auth/reauth': { post: operation('reauthenticateAdminPassword', 'Verify the current password for sensitive actions', entity({ password: { ...string, writeOnly: true } }), 'Successful verification updates only this session\'s five-minute freshness. A wrong password does not revoke an otherwise valid session. Returns reauthenticated and expires_at.') },
      '/api/v1/admin/account/password': { put: operation('changeAdminPassword', 'Change password and revoke all management sessions', entity({ new_password: password }), 'Requires fresh password or Passkey reauthentication. Stores a newly salted scrypt hash, increments authentication version, revokes all sessions/challenges and clears the current cookie. Existing Passkeys remain valid. User must log in again.') },
      '/api/v1/admin/passkeys': { get: operation('listAdminPasskeys', 'List own registered Passkey metadata', null, 'Bounded to20 credentials; private keys stay with authenticators. Does not establish physical backup/sync independently of authenticator reports.') },
      '/api/v1/admin/passkeys/registration/options': { post: operation('beginAdminPasskeyRegistration', 'Begin enrolling a discoverable Passkey', entity({ name }), 'Requires a full, recently reauthenticated session. Returns challenge_id/optionsJSON. Requests residentKey required, userVerification required and attestation none. Challenge is account/session/version/intent/origin-bound and expires in five minutes.') },
      '/api/v1/admin/passkeys/registration/verify': { post: operation('verifyAdminPasskeyRegistration', 'Verify and store a new Passkey', proof, 'Claims the challenge once before cryptographic verification. Requires the same account/session and fresh reauthentication. Verifies WebAuthn creation type, exact origin/RP ID, challenge, presence/UV and credential via SimpleWebAuthn. Failure consumes the ceremony; start again.', false, '201') },
      '/api/v1/admin/passkeys/authentication/options': { post: operation('beginAdminPasskeyAuthentication', 'Begin Passkey login or sensitive-action reauthentication', entity({ intent: { type: 'string', enum: ['login', 'reauth'] } }), 'Login is public and sets a short-lived HttpOnly browser-binding nonce cookie. Reauth requires a full administrator session. Both use discoverable credentials with required user verification. No username enumeration or credential list is returned.', true) },
      '/api/v1/admin/passkeys/authentication/verify': { post: operation('verifyAdminPasskeyAuthentication', 'Verify a Passkey login or session-bound reauthentication', proof, 'Consumes the matching one-time challenge; checks browser/session binding, exact RP/origin, user handle, signature, UV and counter. Final transaction guards current account version and still-present credential/counter revision. Login sets a new account session; reauth updates freshness of the existing session.', true) },
      '/api/v1/admin/passkeys/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: uuid }],
        patch: operation('renameAdminPasskey', 'Rename an owned Passkey', entity({ name }), 'Requires fresh password/Passkey reauthentication and ownership. The credential itself is unchanged.'),
        delete: operation('deleteAdminPasskey', 'Remove an owned Passkey', null, 'Requires fresh password/Passkey reauthentication and ownership. Deleted keys cannot complete new login/step-up, including a ceremony concurrently finishing. Password login and other registered keys remain available.'),
      },
    },
  };
}
