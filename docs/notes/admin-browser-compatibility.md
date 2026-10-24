# Administrator browser compatibility

## Cosmetic filters

On 2026-10-24, the production `/admin` page in the user's Safari displayed
only the top bar. Safari Web Inspector showed an injected `.ad-sidebar`
`display: none` rule. The administrator interface used the generic `ad-`
prefix, including `.ad-main`, so cosmetic advertising selectors could hide
its navigation and workspace. The exact extension/subscription responsible
was not identified.

All administrator CSS classes, custom properties and animation names now use
the `cp-admin-` namespace. This is a mechanical rename: account/session logic,
API behavior and browser protection settings are unchanged. The optional
Cloudflare analytics CSP error observed during diagnosis is separate from the
hidden layout; this fix does not broaden the CSP.

The existing real-Worker authentication and management browser checks install
a controlled set of generic `.ad-*` hiding rules before each document loads.
A matching probe must be hidden, while the actual navigation, main content,
overview and account panels must remain visible with usable desktop and
390px phone geometry. Authentication still uses the real local Worker and
CTAP2 virtual authenticator. The fixture is an isolated regression condition,
not a complete content-blocker subscription or physical Passkey validation.

The relevant checks are `scripts/admin-auth-browser-smoke.mjs` followed by
`scripts/admin-browser-smoke.mjs` against a fresh, isolated local Worker.
Both are part of the existing CI workflow. Production Safari verification is
recorded separately from this controlled Chromium regression.

The exact main-based release snapshot passed 324 tests across 34 suites, the
production build, fresh local migrations 0001–0004, and both browser workflows
with the controlled hiding rules active. These checks used synthetic local
accounts and devices, and did not mutate production data.

## Optional Passkey extension reports

The user's Safari subsequently displayed `invalid_passkey_response` after an
enrollment attempt. The account page and navigation were visible at this point.
A source audit found that registration required `credProps.rk === true` even
though the [WebAuthn credential-properties extension](https://www.w3.org/TR/webauthn-3/#sctn-credProps-extension)
defines this client report as optional. The failed Safari request's extension
contents were not captured, so this source defect and the observed error are
recorded separately pending a successful retry.

Registration now tolerates omitted extension results, `credProps`, or `rk`,
while rejecting explicit `false` and malformed values. The browser still requests
resident credentials and user verification as required; the server retains exact
origin/RP/challenge/ceremony, UP/UV, credential and one-use session checks.
Missing reports remain unreported and are never rewritten as `rk: true`.

The real-browser authentication regression removes only the unsigned extension
report from one actual CTAP2 registration request. The Worker must persist that
credential and verify its subsequent signed login and reauthentication; no
successful API response, client data, authenticator data or signature is mocked.
Physical Safari/Touch ID enrollment remains a separate user-operated acceptance
step.

The exact main-based Passkey compatibility snapshot passed 350 tests across
34 suites (including 61 real-crypto Passkey cases), build, fresh local migrations
and both real-Worker browser workflows. The omitted-extension registration and
its subsequent signed login/reauthentication passed with no mocked responses.
