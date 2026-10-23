# Prior work and reuse

## Initial public baseline

This baseline contains newly written project documentation and Git exclusions,
plus adapted project development rules. It contains no firmware, receiver, UI,
tests, runtime data, or third-party implementation code.

Pre-hackathon prototypes are design references. Useful lessons include preserving
the board's protected Flash regions, keeping BLE callbacks nonblocking, reporting
data loss, and distinguishing activity observations from exact people counts.
These lessons do not establish that the new implementation works.

Local pre-hackathon material is kept under the ignored `local-reference/`
directory. It must never be force-added or published as part of this baseline.

## 2026-10-23 — First web/API implementation

- `src/`, `worker/`, migrations and tests are newly written for this baseline;
  no pre-hackathon application or vendor renderer was copied.
- The browser tile adapter references the official CCNU GIS remote JPG endpoint
  and includes source attribution. No map images or POI datasets are bundled,
  mirrored, committed or uploaded. Public display/redistribution terms still
  require confirmation before wider publication.
- The library focus anchor is a manually recorded fact from the official UI;
  see [GIS research](../research/ccnu-gis.md). It is not a sensor position.
- Runtime dependencies: React and React DOM (MIT), Three.js (MIT), and Lucide
  React (ISC). Exact installed versions are recorded in `package-lock.json`;
  package license notices are retained by npm. The code uses their APIs without
  copying implementation into source files. Cloudflare Workers/D1 are the chosen
  runtime services. No school-map or concept-image license is inferred from those
  dependency licenses.

## Future reuse entries

Before committing reused code, add an entry with:

- Source repository or vendor, exact revision, and source paths.
- Destination paths and the reason for reuse.
- Applicable license, required notices, and modifications made.
- Validation performed for the new implementation and remaining limitations.

Reused board drivers must retain their upstream copyright and license. Record
any permitted reuse transparently; do not relabel prior code as newly written.

## 2026-10-23 — Prior visual concept

- Source: the user's pre-hackathon CampusPulse generated concept, locally saved
  as `local-reference/pre-hackathon/captures/gis-ui-spatial-20261021/selected-reference.png`.
  This material predates the new hackathon implementation; it has no source Git
  revision. The user explicitly authorized borrowing earlier design images.
- Destination: `docs/design/assets/campus-concept.png`; used as visual direction
  in the [hackathon plan](../design/hackathon-plan.md), not a real campus map.
- Reuse scope: image only. No prior application code or runtime data was copied.
  The campus, actors, and wait values in the concept are illustrative.
- Metadata: ExifTool inspected input and final PNG on 2026-10-23. An explicit
  metadata stripping pass found nothing to remove; the final file exposes only
  structural image fields and computed dimensions, without embedded EXIF, GPS,
  XMP, IPTC, comments, author, contact, device, or path fields.
- Final image: 1487 x 1058 pixels; final and source bytes are identical, retaining
  orientation, appearance, and color. SHA-256:
  `4e3fb661c3ec14402e5e6ab463ae3d5f5449573ea1dc274492e6aecf6fbd81df`.
- No blanket license for prior material or third-party map assets is inferred.
  The old GIS raster, sprites, screenshots, and third-party enclosure models
  have not been copied into this public baseline in this change.

## 2026-10-23 — Selected historical Markdown

The user requested carrying earlier observations into the new documentation.
`docs/upstream/pre-hackathon/vehicle-rules.md` retains the prior document body;
`wire-v0.md` retains the old contract with two internal links adapted.
Each wrapper records its source path and SHA-256. `observations.md` summarizes
selected device, storage, network, and GIS evidence with original Markdown hashes.
All three are explicitly historical and have not been rerun against new code.

Only documentation was migrated. Prior application code, captures, MAC lists,
databases, credentials, and deployment configuration remain excluded.
The current upload protocol and JSON examples were newly authored; examples
use synthetic identities/payloads/counters and are not field measurements.
An invited private Radar repository was cloned to ignored local reference storage;
its code, detailed review, and field data have not been copied into public docs.

## 2026-10-23 — User-selected October 21 frontend migration

This entry supersedes the initial baseline's no-UI-reuse statement for the
selected frontend only. The user explicitly requested migrating the October 21
version, keeping its interactions and improving its night lighting. This is
selected prior-work reuse, not a newly authored replacement or a claim that the
entire application was created during the hackathon.

- Source: `local-reference/pre-hackathon/gis-prototype/`, the user's saved
  2026-10-21 local prototype; no source Git revision is available. The exact
  source/destination files and SHA-256 fingerprints are recorded in
  [the reuse manifest](frontend-reuse-manifest.json).
- Reused/adapted: the overview/local map UI, CSS, shared timeline and simulation,
  directional actor renderer, reviewed projected geometry, building masks,
  historical geometry invariants, generated pedestrian/moped sprites and glow
  texture. Destinations are `src/campus/`, `tests/frontend/`, and `public/assets/`.
- New/adapted integration: remote zoom3 tile loading preserves the original
  1024x640 registration; geometric actor clipping removes the need to repaint a
  bundled school raster. `Observations.jsx` connects the existing API through a
  separate field-record flow. Field mode clears synthetic actors, waits and
  metrics. `NightLighting.jsx` adds the selectable enhanced treatment at the
  existing illustrative lamp/window anchors.
- No original school JPEG, raw capture, device identity, database, firmware,
  receiver, secrets or deployment configuration was copied. School images load
  from the official endpoint at runtime. The selected derived geometry retains
  official/manual provenance; availability does not establish redistribution
  rights or a survey. School display/geometry terms still need confirmation
  before wider publication.
- License boundary: no standalone license was supplied for the user's local
  UI snapshot; this migration relies on the user's explicit instruction and
  does not impose a new license on it. No blanket license is asserted for the
  school's data or generated assets. Phosphor React icons are used via the npm
  package API (MIT); React/React DOM remain MIT. Their license files remain in
  installed packages. The unused Three.js/Lucide implementation and dependencies
  were removed from the active frontend.
- Final asset metadata: ExifTool inspected and applied an all-metadata removal
  pass to the four destination PNGs. All four were already clean and unchanged;
  the final bytes contain PNG structural/color/alpha information and no embedded
  EXIF, GPS, XMP, IPTC, comments, author, device or path tags. Orientation,
  transparency and appearance were visually retained. Source assets are intact.
- Validation: build and 18 API/geometry tests passed. Real in-app-browser checks
  cover actual tiles, dual view navigation, search, theme/presets, independent
  layers, xray, field/demo separation and phone layout. Local authenticated
  submission/cancellation was blocked by automatic approval review and was not
  executed; the updated CI browser smoke has not been run in this session.
  See [lighting/QA notes](../design/frontend-lighting.md).

## 2026-10-23 — Self-hosted Swagger UI

- Source: official npm artifact `swagger-ui-dist@5.34.0`, upstream
  [swagger-api/swagger-ui](https://github.com/swagger-api/swagger-ui), published
  Git revision `a3d333d7e99611288312d597c4023ee10df721e0`.
- Package integrity was verified before extraction:
  `sha512-H6tAIjr3XqE31PbkZl0OFya1ziRLDfTwh3J6OHdumPtPCLfjTnyLeagl/55kFNZcTOz9a9QI9WP0FXldwiGJag==`.
- Destination: `public/vendor/swagger-ui/`. Only `swagger-ui-bundle.js`,
  `swagger-ui.css`, `LICENSE`, `NOTICE` and the bundle's transitive
  `swagger-ui-bundle.js.LICENSE.txt` were copied, unmodified. No upstream demo,
  OAuth redirect, source map or favicon was copied. The project-specific HTML,
  initializer and OpenAPI contract in `worker/` are newly authored.
- License: Apache-2.0, with the upstream NOTICE and bundled dependency notices
  retained beside the assets. Those notices remain available in the deployed
  static files. This entry does not change the rest of the project's licenses.
- Final JavaScript SHA-256:
  `3f6abf70480db7e07914df4c98a77385f22ea585eaf457a3e6415ba0eae2d167`.
  Final stylesheet SHA-256:
  `c3cfe8248c4b0b89673600fb829924eafbac6de4bc4b2b06f5f5243483074d0a`.
- Assets are served from the application origin rather than a runtime CDN.
  Swagger's remote validator and query configuration override are disabled;
  bearer credentials are never persisted by the docs UI. Contract/browser
  validation is recorded with the API feature, separately from cloud deployment.

## 2026-10-23 — Pixi light-only integration

The user selected PixiJS + pixi-filters. Runtime dependencies are now PixiJS
8.22.0 and pixi-filters 6.1.5 (both MIT), installed through npm with their license
files retained; exact resolution/integrity is in package-lock.json. Their APIs
supply bloom, blur, textures and masking; no vendor implementation was copied
into tracked source. New wrappers/geometry helpers are in PixiLightLayer.jsx,
NightLighting.jsx and lighting-field.js. The selected historical renderer now
lives in CanvasNightLighting.jsx; the reuse manifest tracks that destination.

Map tiles, actor assets, route geometry and UI handlers were not replaced.
World light/mask textures are procedural local canvases, not captured school
pixels or a new geographic model. Final review screenshots stay in /tmp and
were stripped/rechecked with ExifTool. No new external-use bitmap asset was added.

Validation: production build, 13 frontend-only geometry tests and real-browser
GPU/filter/registration/switch/phone checks passed. Database tests/writes were
excluded as requested. The rendering fallback is implemented but was not forcibly
triggered. Renderer/filter lifetime compatibility guards for the installed
versions are documented in the lighting study and should be rechecked on upgrades.

## 2026-10-23 — Ingestion server implementation

The ingest validator, D1 migration/store, R2 upload handler, public projection,
retention handler, provisioning helper, AD parser and tests are newly authored
for this baseline. No pre-hackathon backend, parser implementation, firmware,
raw capture, credential or database was copied. Existing synthetic protocol
fixtures are contract inputs, not field evidence. The implementation uses the
Cloudflare D1/R2 APIs and existing development dependencies; it adds no copied
third-party implementation or new license claim. Local workerd and docs-browser
acceptance do not establish production deployment or device validation.

## 2026-10-23 — Actor proportion correction

The adapted historical ActivityLayer renderer now measures each direction's
alpha bounds and draws the visible artwork at its natural aspect ratio using
new actor-style.js helpers. The generated sprite PNGs are unchanged. Per-map
screen-space clamps and mismatched vehicle frame scales were removed in favour
of a shared registered illustration size; foot/tyre anchors use the same route
points. This is a visual calibration, not measured metres or a new map source.
The reuse manifest destination hash for ActivityLayer was updated. Build,
17 frontend tests and current desktop/phone screenshots verified the change;
no database tests or writes ran. Final screenshots remain local and were
metadata-checked/stripped before sharing.

## 2026-10-23 — Shared ground and actor illumination

lighting-field.js receiver/entry-spill additions and new actor-lighting.js cached
materials are newly authored for this baseline. They reuse existing selected
scene coordinates and unchanged generated sprite assets; no additional map,
model, bitmap, vendor source or pre-hackathon backend was copied. ActivityLayer
and CampusMap adaptations plus the night CSS hashes are reflected in the reuse
manifest. Final screenshots stay in /tmp, stripped/rechecked before sharing.
Build,23 frontend tests and browser checks passed; reference fidelity remains
partial and database writes/tests were excluded.

## 2026-10-23 — Registered wall-light surfaces

New facade-surfaces.js defines14 manually reviewed wall-light masks/pane polygons
in the retained map projection. New facade-atlas.js bakes only procedural light
receivers/emission, without copying reference raster pixels. These helpers, the
selective SVG color filter, camera-registration fixes and material variation are
new work. Historical facadeLights remain solely for original-night mode. The
selected generated sprite assets are unchanged; no new dependency or third-party
code/bitmap/model was added. Canvas/Pixi enhanced paths now share these wall
surfaces. Reuse-manifest hashes were refreshed for modified adapted modules.
Build and28 frontend tests passed; no database tests/writes, commit or deployment
were performed for this iteration. Screenshots remain local evidence only.
