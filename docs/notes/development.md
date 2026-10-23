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
production views start empty. The frontend provides a separate explicit simulation.
Manual entry needs the local operator token and a parking or elevator place.

## Verification

```sh
npm test
npm run build
# With the built local Worker already running and local .dev.vars configured:
npm run test:browser
```

The API tests execute the actual migration and queries against Node's SQLite.
This is local database/API validation, not Cloudflare deployment, hardware or radio
validation. Browser checks use the local Worker with a disposable operator secret.
The browser smoke expects Chromium at `/usr/bin/chromium`; override with
`CHROMIUM_PATH` on another machine. `SMOKE_URL` accepts only localhost targets.
In this managed environment it uses the configured HTTPS proxy and pins the
configured proxy CA for Chromium, rather than disabling HTTPS validation globally.

On 2026-10-23, all 9 SQLite/API tests, TypeScript checking, Vite production build,
and local D1 migration passed. Browser checks exercised actual official GIS tile
rendering, explicit simulation, a WebGL canvas, manual record submission and
cancellation, and a 390px phone layout. This is the first functional slice rather
than a claim of matching the concept image's detailed buildings and lighting.
Private QA screenshots contain only structural PNG chunks (IHDR/IDAT/IEND), no
embedded text/EXIF metadata; they are not committed or published.

The GIS tile origin defaults to `https://gis.ccnu.edu.cn`; an approved compatible
origin can be supplied with `VITE_GIS_TILE_ORIGIN` at build time. `VITE_GIS_URL`
controls the attribution link. These are public source URLs, never credentials.

## Cloudflare deployment

No account or existing database is configured in this checkout. Create a D1 database
using `npx wrangler d1 create campuspulse`, replace the placeholder database ID in
`wrangler.jsonc`, apply `npx wrangler d1 migrations apply campuspulse --remote`,
and set `npx wrangler secret put OPERATOR_TOKEN`. Then `npm run deploy` builds and
deploys the Worker and assets. Keep the credential out of frontend environment
variables. Review operator access, retention, rate limits and map display terms
before public use. This session does not claim a deployed service.

See [CCNU GIS research](../research/ccnu-gis.md) for the map source and limitations,
and [web API contract](../specs/web-api-v0.md) for the implemented routes.
