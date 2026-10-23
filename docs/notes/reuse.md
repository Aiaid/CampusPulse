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

## 2026-10-23 — AI Passport field terminal firmware

- Source: the user's local pre-hackathon `ai-passport` firmware workspace
  (FoloToy AI Passport, MIT License, Copyright (c) 2026 FoloToy), at local
  revision `5fb8ab532414eb0029fc5ea131a03cb0993db180`. That repository is a
  read-only neighbor and remains unpublished here; only the files listed
  below were carried over.
- Destination: `firmware/passport-terminal/`, the CampusPulse field terminal
  for manual parking/elevator observations against `docs/specs/web-api-v0.md`.
- Copied without modification: `components/bsp/include/bsp_*.h` (pins, i2c,
  display, button, battery) and `components/bsp/src/` implementations,
  `main/key_guard.h`, `main/ui_mini.c/h`, and `tools/gen_font.ps1`.
  Copyright headers and pin mappings are preserved per project rules.
- Modified during reuse: `components/bsp/CMakeLists.txt` and
  `idf_component.yml` were trimmed to display/button/battery/i2c only; audio
  (ES8311) and the LVGL layer are excluded and never initialized.
  `tools/gen_font.ps1` gained the terminal's Chinese glyph set; generated
  `font_zh`/`font_digit` outputs are artifacts of that tool.
- Adapted, not copied: `main/main.c` keeps the old boot/input-dispatch
  structure with new module wiring; `main/net_link.c` reuses the old
  wifi_time.c connection/diagnostics/SNTP patterns but changes the lifecycle
  to on-demand connect with idle disconnect (this firmware runs no BLE scan).
- Newly written: `main/page_term.*`, `main/obs_api.*`, `main/obs_store.*`,
  `main/term_cred.example.h`, project CMake/partition/sdkconfig files.
  The old radar pages, BLE scan pipeline, demos, and vehicle rules were
  not copied.
- Partition layout preserves the 3 MB factory app and the protected `cardid`
  at 0x356000 per hardware constraints; no merged padded image is produced.
- Validation: pending first ESP-IDF build and on-device checks; no radio,
  upload, or UI validation is claimed yet.

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
