# Administrator accounts and Passkeys / 管理员账号与 Passkey

Status: implemented and locally verified (2026-10-24).
This document supersedes the shared-token login portion of [Admin v1](admin-v1.md)
when migration `0004_admin_auth.sql` is applied. Management data and device,
operator and researcher permissions keep their independent boundaries.

## First login and normal use

1. Configure an independent random `ADMIN_TOKEN` secret. There is no default
   account or password, public registration, or emailed invitation.
2. Before initialization, open `/admin`, enter that bootstrap secret, and create
   the administrator's username, display name and password. The bootstrap session
   can only complete setup or log out; it cannot read or change management data.
3. Setup creates one administrator account and revokes bootstrap/older sessions.
   Subsequent login uses the account password or an enrolled Passkey. The bootstrap
   token no longer logs in or bypasses the account. Keep the server secret private;
   it still signs sessions, and changing it invalidates their signatures.
4. Open **账号与安全** to change the username/display name/password, or enroll,
   rename and remove Passkeys. Account identity stays stable when username changes.

The first version intentionally supports one managed administrator account with
multiple Passkeys. It does not introduce public signup, multiple account roles,
operator record ownership, an email reset flow or an emergency token bypass.
Account recovery without any working password/Passkey requires controlled server
maintenance; do not reopen bootstrap login on an initialized public database.

## Sessions and sensitive changes

Sessions use an expiring signed HttpOnly/SameSite=Strict cookie, Secure on HTTPS;
loopback HTTP is only for development. D1 associates sessions with the account's
current authentication version. Logout invalidates its session; password changes
revoke all sessions and require a new login. Existing pre-account sessions are
invalidated by migration. No passwords or bootstrap secrets go in browser storage,
URLs, frontend build variables, logs or audit details.

Account edits, password changes and Passkey enrollment/rename/removal require a
fresh, session-bound verification within five minutes. Verify with the account's
password or an existing Passkey. A previously open management page is insufficient
by itself. A canceled system prompt does not create or remove a key. Password
login remains available when a browser lacks WebAuthn or a key is unavailable.

Account changes and redacted audit records are atomic. Setup races cannot create
multiple administrators. Password version/session checks prevent a concurrent old
login or challenge from recreating a valid session after credential changes.
Persistent bounded rate limits protect login and challenge/verification attempts;
wrong username/password errors use the same outward response.

## Password storage and runtime boundary

Use native `node:crypto` scrypt with a random per-password salt, a versioned stored
format, N=32768, r=8, p=3 and constant-time comparison. No plaintext password or
fast SHA-only password hash is stored. Password input is bounded and not trimmed.
The chosen scrypt parameters are an [OWASP-listed memory/CPU tradeoff](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).
`nodejs_compat` is explicit in the Worker configuration.

A local workerd probe on 2026-10-24 successfully derived a 32-byte result with these
parameters in about188ms elapsed wall time. This is a capability check, not a
Cloudflare production CPU measurement or throughput guarantee. Production must
have sufficient CPU/memory budget and pass login under its actual plan. Cloudflare
[documents different CPU limits by Workers plan](https://developers.cloudflare.com/workers/platform/limits/#cpu-time);
local acceptance does not prove a free-plan deployment meets those limits. Do not
reduce the password hash cost silently to make a deployment pass. Prefer enrolled
Passkeys for routine sign-in, and verify cloud cost/limits separately before release.

## Passkey trust configuration

Passkeys use maintained `@simplewebauthn/server` and `@simplewebauthn/browser`,
installed and locked at14.0.3/14.0.0 respectively (both MIT). The implementation
follows their [server](https://simplewebauthn.dev/docs/packages/server) and
[browser](https://simplewebauthn.dev/docs/packages/browser) registration and
assertion verification flow; it does not implement custom signature verification.

Configure public, non-secret deployment values:

- `ADMIN_WEBAUTHN_ORIGIN`: the exact HTTPS origin, for example
  `https://pulse.anend.net` without a path/query/fragment.
- `ADMIN_WEBAUTHN_RP_ID`: the matching hostname, for example `pulse.anend.net`.

The deployment config generator accepts these explicitly; if omitted it can use
an explicitly configured `DEPLOYMENT_URL` as the trusted origin. It never derives
production trust from an arbitrary request Host. Missing/mismatched trust config
makes Passkeys unavailable, with password authentication still independently
configured. For loopback development only, the current local origin can be used
when explicit values are absent. If testing through Vite, the browser origin and
Worker's observed/proxied origin must agree; direct local Worker access is simplest.

Passkeys belong to their RP domain. A key enrolled on `localhost` will not log in
to `pulse.anend.net`; enroll a new key on the intended production origin. Changing
domains does not move keys automatically. The browser/system credential manager
retains the private key; the server stores its public credential and metadata.

Registration requires a discoverable resident credential and user verification.
The server checks response type, origin, RP ID, challenge, presence/verification,
account/user-handle binding, signature and supported counter behavior. Synced
Passkeys reporting zero counters are supported; nonzero counter replays and
concurrent stale updates are guarded. Challenges expire, are purpose/account/
session-bound as appropriate, and are claimed once before verification; failed
verification consumes them. Credential removal and authentication version changes
must also be checked in the final transaction.

## Additive APIs

Paths below are relative to `/api/v1/admin`. All responses are no-store; browser
mutations require an exact matching Origin. Tokens, passwords, hashes, salts,
assertion payloads and public-key blobs are excluded from audit output.

| Route | Purpose |
| --- | --- |
| `GET /auth/status` | Public initialization and available login modes |
| `POST /session` | Restricted first-use token login, or normal username/password login |
| `GET/DELETE /session` | Current role/account or logout |
| `POST /auth/setup` | One-time account creation from a bootstrap session |
| `GET/PATCH /account` | Read/edit the administrator profile |
| `POST /auth/reauth` | Fresh verification using the password |
| `PUT /account/password` | Change password and invalidate sessions |
| `GET /passkeys` | Read own Passkey metadata |
| `POST /passkeys/registration/options` | Start enrollment after fresh verification |
| `POST /passkeys/registration/verify` | Verify and persist enrollment |
| `POST /passkeys/authentication/options` | Begin login or session-bound step-up |
| `POST /passkeys/authentication/verify` | Verify a Passkey login or step-up |
| `PATCH/DELETE /passkeys/:id` | Rename/remove a key after fresh verification |

See `/docs` and `/openapi.json` for request/response contracts. The base
management APIs continue to require a full administrator session, never a
bootstrap session or an operator/device/research bearer credential.

## Validation boundary

Unit/integration tests use actual
D1-compatible SQLite migrations and real cryptographic attestation/assertion
fixtures. Browser validation uses a local Worker plus Chromium's virtual WebAuthn
authenticator; it does not bypass server signature checks. A successful virtual
key flow is not evidence of a physical Touch ID/Face ID/security-key enrollment,
production-domain availability, iCloud sync or actual cloud CPU/cost acceptance.
No production account, password, biometric enrollment or deployment is created by
these local tests. The deferred manual-record browser-write regression remains
separate.

Local acceptance on 2026-10-24:

- Four migrations applied to a fresh isolated local D1 database. Native workerd
  ingestion retained its three-stream, retry/conflict, private-read and synthetic
  isolation checks after the auth/schema additions.
- Full working-tree suite:326 tests in34 files passed, including11 account,
  35 real-signature WebAuthn,14 management and9 deployment-origin cases.
  TypeScript and the Vite production build passed. The total also includes
  independently developed frontend tests; it is a local verification snapshot.
- Publication scope check: the exact staged source snapshot passed316 tests in33
  files, its production build and real workerd ingestion regression. It excludes
  ten unrelated uncommitted research-analysis tests included in the326-test
  working-tree count; those research files and their shared-document hunks are
  intentionally left outside the administrator commit.
- Chromium CTAP2 resident-key/UV registration and assertion ceremonies reached
  the actual Worker and production SimpleWebAuthn verifier, including an invalid
  signature rejection. Browser tests passed restricted bootstrap/setup, wrong/
  correct password login, Passkey login/reauth, profile and key rename, password
  rotation/all-session revocation, existing-key login after account changes,
  key deletion denial, password fallback, audit secrecy and HttpOnly cookies.
- The original management browser regression passed using the resulting
  replacement account: device credential rotation/disable/enable, place/
  deployment, draft edit/clone/publication/history preservation, synthetic device
  ACK UI, settings persistence and phone table layout.
- Read-only Swagger rendered45 operations without runtime errors. Desktop
  1440×1000 and phone390×844 account/login pages were inspected; blank password
  fields and credential-free synthetic screenshots were metadata stripped and
  rechecked. The admin CSP/frame protections remained present. Deferred manual
  record browser writes were not resumed.
- Tests exercised setup/signature/challenge replay and failure consumption,
  session/intent/browser/user-handle binding, UV/origin/RP checks, duplicate client
  JSON, synced zero counters, mutable backup state versus permanent backup
  eligibility, counter/revision races, mid-flight account revocation, audit
  rollback, bounded rate admission and exact trusted deploy-origin rejection.

Repository publication and cloud delivery are tracked separately in Git history
and GitHub Actions; the local checks above do not establish deployment. No
production account, secret, password, Passkey or device data was created or changed
by these tests. Physical Touch ID/Face ID/security keys, password-manager sync and
the actual production domain/plan CPU budget still require separate acceptance.
