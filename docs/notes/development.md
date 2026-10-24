# Running the first web/API slice

Use Node 24; the API tests use its built-in `node:sqlite`.

```sh
npm ci
npm run build
npm run db:migrate
cp .dev.vars.example .dev.vars
# Edit .dev.vars and replace the token; never commit it.
npm run dev:api
```

In another terminal run `npm run dev`, then open `http://localhost:5173`.
Vite forwards `/api` to the local Worker on port 8787. Or run the built application
directly through `http://localhost:8787` after `npm run build`.

The seed contains logical demonstration places only. Sensor coverage is unconfigured;
field views start empty. The frontend defaults to a visibly labelled simulation;
switch to 现场观察 for the separate field-record flow.
Manual entry needs the local operator token and a parking or elevator place.

## Administration

Apply all current migrations and configure an independent random `ADMIN_TOKEN`
in ignored `.dev.vars`, then open `/admin` on the same local origin. Do not reuse
the operator/device/research token. The secret grants restricted setup only before
the first account exists; create a username/password, then use password or enrolled
Passkeys. See [account initialization and security](../specs/admin-auth-v1.md).
Login creates an expiring, revocable HttpOnly session; passwords and the server
secret are not saved in browser storage. See
[Admin v1](../specs/admin-v1.md) for management workflows and evidence boundaries.
Runtime settings control the initial map mode/name and TTL of new manual records;
the seeded defaults retain demo mode and a 15-minute TTL.

For isolated management acceptance, use a separately migrated local Worker/state
directory and a private disposable env file. For account/Passkey acceptance the
database must be uninitialized and the mode600 file must contain `ADMIN_TOKEN`,
synthetic `ADMIN_SMOKE_USERNAME` / `ADMIN_SMOKE_PASSWORD`, and different replacement
`ADMIN_SMOKE_NEW_USERNAME` / `ADMIN_SMOKE_NEW_PASSWORD`. Use independently generated
random passwords; never reuse actual administrator credentials. Run authentication
first, then management against the same local state:

```sh
ADMIN_SMOKE_URL=http://localhost:8796 \
ADMIN_SMOKE_ENV_FILE=.dev.vars.admin-auth-qa node scripts/admin-auth-browser-smoke.mjs
ADMIN_SMOKE_URL=http://localhost:8796 \
ADMIN_SMOKE_ENV_FILE=.dev.vars.admin-auth-qa node scripts/admin-browser-smoke.mjs
```

The script permits loopback targets only. It creates synthetic management records
in that local database; it does not write to production or configure hardware.
The auth script uses Chromium's virtual CTAP2 authenticator and ends with the
replacement username/password active. Local Passkeys use `localhost`, so open
the Worker directly rather than mixing the `127.0.0.1` and `localhost` origins.

## Verification

```sh
npm test
npm run build
# With the built local Worker already running and local .dev.vars configured:
npx playwright install chromium
npm run test:browser
```

The API tests execute the actual migration and queries against Node's SQLite.
This is local database/API validation, not Cloudflare deployment, hardware or radio
validation. Browser checks use the local Worker with a disposable operator secret.
The browser smoke uses `CHROMIUM_PATH` when supplied, otherwise Playwright's
installed Chromium, then `/usr/bin/chromium` as a fallback. `SMOKE_URL` accepts
only localhost targets. If an HTTPS proxy and its CA are configured in the
environment, the script uses that proxy and pins its CA for Chromium rather than
disabling HTTPS validation globally. CI installs Chromium with system dependencies
and uses `SMOKE_GIS=offline` to check the unavailable-map state independently of
the school's tile server.

The frontend migration passed all 18 SQLite/API and scene-geometry tests,
TypeScript checking and the Vite production build locally on 2026-10-23. Scene
geometry tests do not establish surveyed routes or real-world collision behavior.
See the [frontend notes](../design/frontend-lighting.md) for interaction checks and
their limits. Local authenticated browser writes are not included in that
frontend validation; the updated browser smoke covers submission/cancellation
against a local Worker and disposable CI D1 database when the CI job runs.

### Historical first-slice verification

Historical first-slice verification (before the October 21 UI migration): on
2026-10-23, all 9 SQLite/API tests, TypeScript checking, Vite production build,
and local D1 migration passed. Browser checks exercised actual official GIS tile
rendering, explicit simulation, a WebGL canvas, manual record submission and
cancellation, and a 390px phone layout. This is the first functional slice rather
than a claim of matching the concept image's detailed buildings and lighting.
Private QA screenshots contain only structural PNG chunks (IHDR/IDAT/IEND), no
embedded text/EXIF metadata; they are not committed or published.

The GIS tile origin defaults to `https://gis.ccnu.edu.cn`; an approved compatible
origin can be supplied with `VITE_GIS_TILE_ORIGIN` at build time. The attribution
points to the official GIS site. These are public source URLs, never credentials.

## Cloudflare deployment

For automated checks and deployment, see [CI/CD setup](ci-cd.md).

The first cloud deployment is live at
[campuspulse.anend.workers.dev](https://campuspulse.anend.workers.dev), backed by
the APAC `campuspulse` D1 database. The committed Wrangler config deliberately
keeps its local placeholder. Use the configured GitHub Actions pipeline for
production releases; `npm run deploy` uses the local placeholder and is not the
configured production command.

For authorized manual recovery, supply `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_D1_DATABASE_ID`, run `node scripts/cloudflare-config.mjs`, build, and
pass `--config .wrangler/deploy/wrangler.json` to remote migrations, secret
commands and deployment. Do not create another database merely because the
tracked local configuration contains a placeholder. Keep runtime credentials out
of frontend environment variables. Operator identity, retention, rate limits and
map display terms still require review before broader public use.

See [CCNU GIS research](../research/ccnu-gis.md) for the map source and limitations,
and [web API contract](../specs/web-api-v0.md) for the implemented routes.

## Device ingestion server (2026-10-23)

The window/raw/status server now has separate local acceptance. Read
[backend ingestion](backend-ingestion.md) before provisioning: it documents exact
body hashing, per-node credentials, immutable policy, optional private R2,
retention and the boundary between server tests and hardware acceptance.
`node scripts/ingest-runtime-smoke.mjs` exercises ephemeral real local workerd
D1/R2 using synthetic data. It requires local loopback/process permissions.
No new dependency installation is needed with the current lockfile.
