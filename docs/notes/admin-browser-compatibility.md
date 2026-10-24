# Administrator UI and cosmetic filters

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
