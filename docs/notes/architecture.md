# Contributor architecture overview

Status: the web/API slice and selected frontend migration are implemented.
BLE ingestion and private raw archival are implemented and deployed with separate
local/cloud demo acceptance; device firmware remains planned. Recorded
deployment and verification evidence is in [CI/CD](ci-cd.md) and
[development notes](development.md).
The stack below describes the current source. Earlier release verification does
not validate or establish deployment of later frontend revisions; see the
[frontend implementation notes](../design/frontend-lighting.md) for their scope.
The additive [admin management slice](../specs/admin-v1.md) introduces independent
administrator sessions, editable policy drafts, desired/device activation state,
runtime settings and audit. Its local acceptance and deployment are separate.

## Stack and delivery boundary

| Layer | Technology | Current scope |
| --- | --- | --- |
| Web application | React 19, JavaScript/JSX, CSS, Vite; Phosphor icons | Overview/local maps, search, timeline and independent layers. Manual records use a separate API-backed panel. |
| Campus map | External CCNU GIS raster tiles, DOM/CSS positioning | Official zoom-3 tiles in a registered 1024×640 scene extent. The raster is not a 3D campus model or evidence of sensor coverage. |
| Illustrative overlays | Canvas 2D and CSS | Synthetic moving/parked actors, occlusion, optional building transparency and warm night lighting. Three.js is no longer a dependency. |
| Hosting and API | Cloudflare Workers Static Assets and a TypeScript Worker | Implemented: frontend assets and same-origin `/api/*` routes. GitHub stores source and runs delivery checks. |
| Persistence | Cloudflare D1, SQL migrations | Implemented: places/manual records, immutable capture/placement policy, sensor windows, status, durable receipts and range exclusion. |
| Administration | Same-origin `/admin`, Worker API and additive D1 migrations | Device health/credentials, deployments, editable capture drafts and publication, settings/audit; managed administrator account, password/Passkeys and recent reauthentication for sensitive changes. |
| Development and checks | Node 24, Wrangler, Vitest, Playwright | Configured: local Worker/D1 development, SQLite/API tests, build and browser smoke checks. Follow the linked guides for commands and recorded results. |
| Device ingestion | HTTPS window/raw/status streams | Server implemented: scoped auth, strict validation, atomic sequence handling and independent stream acknowledgements. Firmware buffering remains planned. See [ingestion implementation](backend-ingestion.md). |
| Research raw archive | Private R2 with D1 receipts | Implemented with conditional immutable R2 writes, D1 receipts, private research reads and bounded retention. Production D1/R2 is bound and the server passed isolated demo uploads; firmware and physical-node acceptance remain separate. |
| Firmware and displays | ESP32 BLE nodes, portable terminals, ePaper | Planned; no firmware is included in this repository. |

## Frontend rendering

On 2026-10-23 the user authorized migrating selected 2026-10-21 UI modules and
generated visual assets. That work uses React/JSX, Canvas 2D, CSS and Phosphor
icons, replacing the first release's Three.js scene. It preserves overview/local
maps, search, replay, independent layers, directional moving/parked actors,
occlusion and optional building transparency, and adds illustrative warm night
lighting. A future 3D/GLTF approach is not implemented.

The migration loads official zoom-3 GIS tiles into a registered 1024×640 scene
extent rather than bundling the historical school raster. API-backed records use
a separate panel; map places are not yet fully registered to the API's record
places. Synthetic activity, waits and replay are hidden in field mode, and
lighting remains a visual effect. Migrated source lives under
[`src/campus/`](../../src/campus/), generated visuals under [`public/`](../../public/),
and frontend tests under [`tests/frontend/`](../../tests/frontend/), with
provenance maintained in the [reuse record](reuse.md).

## Current data path

The browser loads the built frontend from Workers Static Assets. Its
manual-recording interface queries the same Worker's public place, summary and
history routes. The Worker reads logical places and active manual observations
from D1. Summaries expose the observation's
source, observation time, validity deadline and freshness. Sensor windows use a
separate eligible field-only projection; coverage remains `unconfigured` pending
physical acceptance. Missing observations mean no data.

An operator submits a parking quantity range or measured elevator wait through
the browser. The Worker authenticates and validates the request, writes to D1,
and returns a committed confirmation. Identical retries are idempotent; changed
content with the same ID conflicts. An operator can cancel a record and submit a
new one to correct it. Manual observations expire according to the configured
TTL at insertion (15 minutes by default), measured from observation time. See the [implemented API contract](../specs/web-api-v0.md) for
the exact routes, limits and remaining operational gaps.

GIS images are fetched directly from the external tile origin, separately from
the observation API. Tile availability does not establish data availability or
coverage. The Canvas 2D/CSS overlays are illustrative. Synthetic activity never fills gaps in
field records. In the D1 seed, only the library has a verified GIS image anchor.
Scene actors and lighting do not establish measured counts, current elevator
predictions or radio completeness.

The implemented server device path stores BLE observation windows and node status
in D1, with research raw batches in private R2 and independent durable receipts.
It uses separate ingestion/authentication from manual observation writes.
The [hackathon plan](../design/hackathon-plan.md) explains the
intended product flow; [ingest v1](../specs/ingest-v1.md) defines the draft upload
semantics.

## Repository map

| Path | Responsibility |
| --- | --- |
| [`src/App.tsx`](../../src/App.tsx), [`src/campus/`](../../src/campus/) | Entry wrapper and React/CSS interface. `CampusMap.jsx` loads remote GIS tiles; `ActivityLayer.jsx`, `MapRegions.jsx` and `NightLighting.jsx` render illustrative overlays; `Observations.jsx` handles API-backed records. |
| [`src/admin/`](../../src/admin/), [`worker/admin.ts`](../../worker/admin.ts) | Separate management UI, shared-admin sessions, editable management workflow and audit. |
| [`public/`](../../public/) | Selected generated visual assets with reuse provenance; excludes the historical school raster snapshot. |
| [`worker/index.ts`](../../worker/index.ts), [`worker/types.ts`](../../worker/types.ts) | Worker routing, validation, D1 queries and shared web/API types. |
| [`migrations/`](../../migrations/) | D1 schema and seed places. |
| [`tests/`](../../tests/) | SQLite/API tests and frontend source/geometry tests under `frontend/`. |
| [`scripts/`](../../scripts/) | Browser/deployment smoke checks and production configuration generation. |
| [`wrangler.jsonc`](../../wrangler.jsonc), [`vite.config.ts`](../../vite.config.ts) | Worker/assets/D1 bindings and local frontend API proxy. The tracked D1 ID is a placeholder; production setup is documented in CI/CD. |
| [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) | Checks and configured Cloudflare deployment. |
| [`docs/`](../README.md) | Indexed specifications, design, engineering notes, research and explicitly historical material. |

## Planned hardware roles

These are inventory and proposed assignments, not firmware or device-validation
claims. Confirm each board revision before choosing drivers or flash layouts.

| Inventory | Proposed role |
| --- | --- |
| LILYGO T-Energy-S3 ×2 | Collection/upload first on both boards, primarily at fixed observation points. |
| FoloToy AI Passport ×2 | Collection/upload first on both boards; then status screens, place selection, manual parking reports and elevator-wait timing. |
| Waveshare 1.54-inch ESP32-S3 ePaper board ×1 | Collection/upload first; then a place-summary display with source, observation time and validity deadline. |

The 2026-10-23 hardware decision makes all five devices BLE collectors with
bounded durable buffering, direct HTTPS uploads and health status. They share
the window/raw/status protocol and core logic, with board-specific drivers,
flash layouts and memory budgets; raw capture requires an authorized config.
Each device holds its own scoped upload credential, including the ePaper board.
Manual-entry permissions remain separate from sensor-upload permissions.

Verify one node, adapt all three board families, and accept each of the five
devices before adding Passport interaction and ePaper presentation. Beacon mode
is temporary and separately tagged; no Passport is permanently reserved for it.
Mobile placement changes split windows and preserve the original placement on
queued records; unlocated transit data stays out of fixed-place summaries.
UI/display tasks must not block collection/upload, and coexistence, losses and
queue pressure require measurement. Five devices do not imply five locations,
cross-board comparability or exact people counts.

See the [hardware assignments and constraints](../design/hackathon-plan.md#2-五台硬件的分工)
before implementing a device role. The [roadmap](../design/ROADMAP.md) tracks the
remaining implementation and acceptance work.

## Contributor entry points

- [Development](development.md): prerequisites, local setup, commands and local verification evidence.
- [Web/API contract](../specs/web-api-v0.md): implemented public reads and authenticated manual writes.
- [CI/CD](ci-cd.md): checks, deployment configuration and recorded cloud verification.
- [Ingest v1 draft](../specs/ingest-v1.md): planned device streams, raw storage and acknowledgement rules.
- [Reuse record](reuse.md): provenance and licensing boundaries for reused material.
