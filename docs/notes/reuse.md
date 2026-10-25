# Prior work and reuse

## 2026-10-25 — Short PIN and USB provisioning

The revised local BLE flow uses the installed Apache-2.0 ESP-IDF 5.5.3
`protocomm_security2` and SRP implementation, linked from the SDK rather than
vendored. The browser implementation independently follows its protobuf schema,
SRP group/formulas and patch-1 AES-GCM counter behavior. The public synthetic
fixture and generation recipe under `tests/provisioning/` fingerprint the six
SDK reference files; they contain no actual device secrets or observations.
The former Security 1 runtime and fixtures remain in Git history.

WebCrypto supplies SHA-512 and AES-GCM; browser SRP arithmetic uses JavaScript
BigInt and makes no constant-time execution guarantee. A passing mock/browser
fixture does not establish physical Bluetooth transport, timing or memory
behavior. Pinned SDK debug logging includes secret material, so provisioning
builds reject a compiled log maximum above INFO.

A generated build copy of the pinned SDK `security2.c` receives an IV alignment
correction, with original Apache-2.0 notices retained and source fingerprints
checked before transformation. The installed SDK and wire/cryptographic
algorithms are unchanged. Fixed-width HMAC salt and standard mbedTLS verifier
generation also avoid the original helper's leading-zero salt conversion.
Native interoperability checks compile the actual SDK implementation; host
platform shims and these compatibility guards are distinguished from device
timing/transport acceptance.

The bounded USB framing, console adapter and administrator Web Serial path are
new CampusPulse code. They use the installed SDK native USB Serial/JTAG driver;
no new upstream board driver, font, image, capture or credential is imported.
See the [local provisioning contract](../specs/local-provisioning-v2.md) for
verification gates and the distinction between local receipt and cloud ACK.

## 2026-10-25 — Redistributable firmware font replacement

The current generated text/digit font files use official Noto Sans CJK SC Bold
2.004, pinned to notofonts/noto-cjk revision
`523d033d6cb47f4a80c58a35753646f5c3608a78` and font SHA-256
`b5f0d1a190a7f9b43c310a8850630af12553df32c4c050543f9059732d9b4c0a`.
The exact upstream SIL OFL 1.1 license and the font's embedded Adobe copyright
are retained in `firmware/fonts/OFL.txt` and `COPYRIGHT.txt`. The modified font
names are CampusPulse Raster Text / CampusPulse Raster Digits; their font data
remain OFL-1.1 rather than inheriting the application's MIT license.

All 141 original text codepoints and 11 digit characters are regenerated; no
Microsoft-derived pixel data is reused. A pinned uv generator, source/license
and output fingerprints, coverage manifest, ASan/UBSan lookup tests and explicit
20×20/60-row/107-pixel three-digit layout checks accompany the replacement.
See [font provenance and regeneration](../../firmware/fonts/README.md). Local
previews were metadata-cleared/rechecked and remain outside the repository.
The full OTF is fetched separately, not bundled. New firmware images are required
because this replacement changes the accepted firmware source fingerprint.

## 2026-10-24 — User-selected AI Passport Radar firmware baseline

The user explicitly selected `xiaoYan-bit/ai-passport-radar` for a local source
import on the CampusPulse firmware branch. Upstream HEAD was verified as
`5fb8ab532414eb0029fc5ea131a03cb0993db180`; the read-only local reference remains
unchanged. The compiled radar sources, BSP, build defaults, dependency lock and
MIT license are copied to `firmware/ai-passport-radar/`, with source/destination
SHA-256 records in `UPSTREAM.json`. This is an exception for the selected
firmware, not permission to publish the original private repository or its
observations. On 2026-10-25 the user separately authorized publication of the
selected current CampusPulse firmware; raw private history/data remain excluded.

The source declares MIT, Copyright (c) 2026 FoloToy; its notice is retained.
The original imported font arrays came from Microsoft YaHei/Bahnschrift and
their independent redistribution rights were unverified. On 2026-10-25 those
arrays were replaced completely with OFL-1.1 Noto Sans CJK-derived raster fonts;
see the replacement record above. Historical import hashes stay historical.
No external-use image assets are imported.

Credentials, real observation examples, logs, captures, development diary,
upstream Git metadata/instructions/workflows/skills, binaries and build outputs
are excluded. Local adaptations preserve protected Flash regions, remove
identifying source examples/diagnostic values, disable default raw calibration
export/persistence, allow unconfigured Wi-Fi and correct Appearance byte order.
See [firmware baseline](firmware-baseline.md) for verification and integration
limits. No old CampusPulse receiver/backend or binary upload protocol is copied.

Stage A adaptation: baseline commit `82549b0` preserves the import. Subsequent
shared core, Passport adapter, supervisor, status renderer, maintenance boundary
and host tests are local work described in [runtime notes](firmware-runtime.md).
Imported Radar/UI sources are adapted in place; their original import hashes
remain explicitly scoped to the baseline, with later changes visible in Git.
No new private-source application, driver or bitmap/font was added by this stage.

Post-stage-A provisioning, network/settings, v2 aggregation, journal, retry
scheduler, codec, administrator wizard and tests are new CampusPulse code. The
Security 1 wire contract follows the installed Apache-2.0 ESP-IDF 5.5.3 protocol
definitions and reference client; its implementation is linked from the SDK,
not vendored. Synthetic interoperability fixtures retain their generation recipe
in `tests/provisioning/`; pinned SDK cJSON is used only from the external IDF
checkout for host tests. See [firmware chain](firmware-chain.md) and the component
README for provenance and verification boundaries. No additional upstream board
drivers, captures, fonts, credentials or image assets were copied by this stage.

Current boundary change: the runtime official-GIS source-material entry below
supersedes the earlier blanket no-GIS-canvas-read design constraint. Historical
checkpoint claims remain scoped to their dates/modules. The four generated
assets still have no GIS input; live source processing is a separate path.

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
## 2026-10-23 — Library-entry surface-light experiment

The new `library-lighting.js`, atlas/layer and baseline-mask modules are authored
for this repository. They derive three wall registrations and pane emission from
the already authorized `facade-surfaces.js`/`facade-atlas.js` baseline; no additional
historical application, shader library, model or map raster was copied. Existing
React/Pixi APIs and the generated actor sheets keep their recorded provenance.
No dependency or third-party license was added. Proxy tree geometry, fixture
positions and heights are manually authored illustration, not official GIS data.
See [the experiment](../design/library-entry-lighting.md) for validation limits.

### 2026-10-24 — Generated foliage and concept-fidelity continuation

The transparent `public/assets/library-tree-canopy-v1.png` was newly generated
with built-in imagegen using the already selected concept as style guidance.
The [asset record](library-tree-generation.md) contains the full prompt, final
fingerprint, metadata/privacy checks and illustrative-use limits. New shared
foliage material preparation and adaptive official tile selection are authored
in this repository; no new external code or school-map snapshots were copied.

### 2026-10-24 — Common materials, room emitters and authored paving (historical)

`surface-lighting.js`, `building-material.js`, `paving-material.js`,
`room-lighting.js` and the shared `ground-features.js` planting masks are authored
for this repository. The atlas/layer and actor-material adapters use the same
linear-RGB decode, raw irradiance, exposure and tone map. Neutral glass
reflectance is separate from additive warm interior emission; its generated
RGB is normalized by mean linear luminance and masked off metal frames.
`library-lighting.js` derives 19 cached area patches from 120 emitting panes in the
same stable 37 bright/83 ordinary/95 dim/64 unlit pattern. No additional campus
observations, routes, surveyed lights or source geometry are inferred.

The new `public/assets/library-facade-material-v1.png` and
`public/assets/library-paving-v1.png`, together with the crown and lamp prop,
were produced with built-in imagegen. They were not copied from a texture
package, school GIS image or pre-hackathon application. The
[generation record](library-tree-generation.md) records final fingerprints,
metadata stripping/rechecks, visual checks and original-output preservation.
Generated appearance is illustrative; this entry asserts no blanket external
license for school data or generated imagery. No new runtime dependency or
third-party implementation/model was added.

Authored paving uses existing registered receivers and excludes three shared
planting islands with inward coverage. The wall material keeps279 actual pane
quads and original64 unlit flags, preserving doors/sills outside window-band
UV0..1. Roofs/canopy and other unmodified surfaces retain GIS appearance. No
school raster pixels are read or bundled by these material modules.

Validation for this local continuation: `npm run build` and
`npx vitest run tests/frontend` passed 106 tests across 12 suites. Pass6 desktop
and phone captures under `captures/library-material-20261024/` are local review
evidence. Independent review did not accept pass6 fidelity; later entry-band
refinements are outside this 106-test checkpoint. These checks are not fidelity
acceptance, deployment, database
testing/writes or hardware validation. Earlier validation records remain
historical checkpoints.

### 2026-10-24 — Responsive framing, contact AO and bounded reflection (pass11 historical)

Final local checkpoint: build and123 frontend tests/14 suites passed after
pass11. Desktop/phone/paired screenshots are ignored local review evidence,
metadata checked. Denser walkers use the existing routes/IDs/phases/geometry;
no historical route code, new map image or external dependency was added.
The20:10 illustration has47 walk/5 riding/4 parked; real observations stay
separate and field mode hides all synthetic actors. Night-fidelity acceptance
remains open despite improved composition/material integration.

`map-framing.js` and the App/CampusMap/style adaptations are authored display
logic for fitting the existing library roof/facade/entry together. They alter
camera framing and local label placement, not official geometry or observations.
`actor-lighting.js` adds small foot/tyre contact AO independently of direct-light
cast shadows. `surface-lighting.js` adds an optional bounded dielectric GGX lobe
using the field's received-energy direction across its three source families.
The conceptual reference is [Filament's material documentation](https://google.github.io/filament/main/filament.html#materialsystem)
for GGX distribution, Smith masking, Schlick Fresnel and diffuse/specular
separation. No Filament implementation, asset, package or dependency was copied.
The code is an independently authored one-direction approximation with a 0.5
specular-weight ceiling, not Filament integration or a full PBR renderer.

Roughness values are foliage 0.5, paving 0.78, glass 0.3, frames 0.82 and actors 0.75.
Generated bitmap bytes/hashes and their original-output preservation are
unchanged; no new image was introduced. The library raster grade again uses
the atmospheric matrix rather than the previous extra-dark variant. Source
geometry, 279 panes, room-state pattern and 19 facade patches remain intact.

The final local checkpoint passed build and123 frontend tests across14 suites.
Pass11 desktop/detail/mobile/paired PNGs were metadata-stripped/rechecked and
reviewed. One final desktop atlas compile was2203.4ms, cached across both maps.
The earlier pass9 measured2224.7ms; the separate approximately42ms incremental
shader benchmark for111509 pixels ran in Node, not a browser or physical phone.
No database operations, deployment, new external license or fidelity acceptance
is claimed. The 107-test pass7 and earlier records remain historical evidence.

### 2026-10-24 — Runtime-only official GIS source materials (pass13 historical)

`gis-material.js` is newly authored browser code for separate anonymous-CORS
loading of the minimal official zoom2 tiles covering `LIBRARY_BOUNDS`. It
assembles a 573x441 ROI and performs one bounded canvas pixel read, then applies
approximate bounded linear-albedo normalization. The atlas uses those source
colors/details for registered roof, canopy, door and solid-wall material under
the existing normals/light field, replacing their earlier wash on those pixels.
Ordinary map `<img>` loading, topology and generated material provenance remain
separate. No third-party implementation or new runtime package was copied.

The input is live official GIS, not a local pre-hackathon raster. Images and
processed material stay in runtime memory; no source snapshot/derived bitmap is
bundled, committed or exported to an application image store. This supersedes
the old no-pixel-read rendering limit, not the prohibition on publishing the
historical school snapshot. Generated crown/fixture/facade/paving bytes and
their no-GIS-input generation records remain unchanged. Existing source-rights
and license boundaries are not altered by this technical CORS check.

The read-only 2026-10-24 probe of
[the official zoom3 tile](https://gis.ccnu.edu.cn/mapdata/zoom3/14_8.jpg) returned
GET 200/image JPEG and `Access-Control-Allow-Origin: *`; HEAD 404 was not evidence
that the GET image was unavailable. The requested zoom2 subset has now loaded
and been read successfully in the actual in-app browser. Its CORS design follows
[MDN's image/canvas guidance](https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image);
no proxy, credential or canvas security bypass is introduced.

The implementation gates tree/building/paving/GIS ready-or-fallback before one
shared atlas compile, exposes GIS status/source-material pixel counts and
retains pass11's old material wash on request/CORS/read failure. With cache off
and zoom2 requests blocked, both GIS loaders reached fallback/source-ready false
while generated materials stayed ready and ordinary zoom3 tiles loaded. After
restoring settings in `finally`, reload verified GIS ready in both views again.
This is controlled request-failure coverage, not every possible failure mode.

The wall-only `coolNeutralization: 0.6` source profile partially reduces eligible
baked cyan/blue casts while preserving linear luminance/detail contrast and
protecting warm, green and near-black features. Roof/canopy profiles are
unchanged. This changes runtime processing only; generated image inputs/bytes
and hashes remain intact. It is approximate cast correction, not recovered
reflectance or complete sun-shadow removal.

The build and 133 frontend tests across 15 suites passed. Actual browser status
was ready/source-ready true in both maps, revision `1:1:1:1`, source pixels
roof 29778/canopy 5644/wall 7327. One desktop atlas compile measured 2261.2ms and
was cached across both views. Metadata-cleaned/viewed pass13 desktop/detail
captures are local evidence; pass12 predates the source-cast fix. Phone/mode
and fidelity review were pending at pass13; later checks are separately recorded
below. The 123-test pass11
evidence above remains historical. No database operations, deployment or
fidelity acceptance are claimed.

### 2026-10-24 — Discrete canopy fixtures and shared sky (pass15 historical)

The new `libraryCanopyDownlights` positions are independently authored on the
existing circular canopy's front arc at 30/90/150 degrees. There are three new
sources,13 library fixtures total, with 9 receivers and 8 tree volumes unchanged.
Each lens is at height 7.1, 0.4 below the 7.5 roof, using power 1.2/radius 26 and
downward full response to 58 degrees, feathering to zero at 68 degrees. Direct
reception and derived ground bounce share that cone; these sources add zero
light to the canopy top. They are illustrative, not measured fixtures.

`library-light-atlas.js` draws three small common-shaded casings/emissive lenses
in cached normal `buildingFixtureMaterial`; it adds no ring/halo or external
bitmap. Street-pole asset rendering excludes them and xray fades this building
channel. No vendor source, dependency or new generated image was introduced;
existing generated asset inputs/hashes and runtime-only GIS boundaries remain.

Pass15 sets shared `SCENE_SKY_STRENGTH=0.65`, exposure 1.6 and library raster
matrix diagonal .34/.38/.43, gamma 1.13. Existing lamp/room powers remain unchanged
from pass14 and other appearance modes retain their treatment. The local A/B
review selected 15 over 14 for stronger warm hierarchy while keeping roof ribs,
foliage and blue activity marks visible. This is an improvement decision, not concept
fidelity acceptance.

Final build and 139 frontend tests/16 suites passed at 03:25:44 after sky 0.65
calibration, with script syntax/diff checks passing. Pass14 phone/mode checks covered original/day
restoration, field-zero actors/contacts and 390x844 without overflow, with all
four material sources/three fixtures ready and official tiles loaded. Those
captures were metadata-checked/viewed. Pass15 desktop/detail/mobile,
`paired-pass15.png` and `paired-sky14-15.png` remain local evidence; the final
mobile and source/current pair were metadata-cleared/viewed. Pass15 at 390x844
reported scroll/client 390/390, both GIS sources ready, three fixtures and all
official tiles loaded. Review found no layout/geometry regression and judged
night cohesion acceptable as an experiment. The style goal remains incomplete:
P1 actor readability concerns fine blue lines/dots at default desktop detail/
phone scales; body/pose legibility is the next work. One shared cached desktop compile measured 2332.1ms, not phone
performance. The source-failure/recovery check remains scoped to pass13's
133-test phase. No database operations or deployment ran.

### 2026-10-24 — Bounded detail actor presentation (pass16)

New presentation/palette logic in `actor-style.js`, `ActivityLayer.jsx` and
`actor-lighting.js` is authored for this repository. It uses the retained actor
assets without editing their PNG/RGBA buffers, alpha or provenance. No vendor
code, dependency, model or new image was copied/generated. The person baseline
remains 4.8 illustration map units; foot/tyre anchors, 47 walkers/5 riders/4 parked
bikes, routes, headings and shared clock stay intact.

Only detail/demo/night/library ROI presentation with `selectedId === 'library'`
is enlarged with feathering,
cap 2 and no shrink of larger physical/high-zoom art. Walking/riding/parked types
share one factor. At 1487x1058, overview physical/display stays 6.2925px; detail
10.452px physical becomes 16px display (1.5308). At 390x844, overview stays 4.5375px;
detail 6.7077px becomes 13px (1.9381). Cast shadows use physical dimensions while
contact AO uses visible footprints. This is cartographic presentation, not
measured stature or a change to source-world positions.

The walk-only palette lifts green on eligible bright blue source pixels by at
most 42, capped at 0.58B, before the same shared material shader. The source
example 0/66/244 becomes 0/108/244; dark seams, warm/white detail and alpha remain.
There is no new actor emission floor, private exposure, glow or post-filter.
Vehicles and default/ineligible presentation keep their previous material path.
Optional-profile cache keys remain separate under the existing bounded cache.

Final production build and 148 frontend tests across 16 suites passed at 03:57:21
after the selected-place scope guard. Metadata-cleaned/
viewed pass16 desktop/detail/mobile captures show the default static frame;
390x844 has scroll/client 390/390, no horizontal overflow and all tiles loaded.
Independent static review resolved P1 readability and accepted bounded trial
style/cohesion, without oversize/clipping/overlap regression. The independent
final review also inspected `paired-pass16.png`, motion A/B, parking-pan and xray
captures: no P1 prevents acceptance of this bounded local trial. The frames are
representative rather than exhaustive motion coverage; full-campus extension
remains separate.

Both maps advanced 2084 frames during 86.328 seconds with matching scene clock
125.776, stable 56 actors and unchanged four-slot parked signature. Raster/atlas
matrices matched after local pan/zoom at scale 2.721893 while overview stayed
1.3109375. Browser enhanced/original/day restored physical=display/readable 0/
library hosts 0; field had 0 actors/contacts/readable. People/bikes/waits toggles
and search/place switching were exercised, preserving their separate controls.
An other-selected-place edge was fixed with `selectedId === 'library'`; full
reload showed `teaching-8` physical/display 15.885/readable 0, then library 16px/
readable 27 on return. The final 148-test result follows that fix. Parking anchor
constancy is supported by runtime coordinates, not a single photograph.
The motion/parking/xray and paired PNGs were metadata-cleaned/viewed. No database
operations, deployment or commit ran for this pass. Earlier 139/pass15 and
133/pass13 records retain their historical scopes.

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

Simulation update (2026-10-24): the current teaching-day/weekend/rain hourly
curves, independent parking intensity, scenario selector and browser acceptance
script are newly authored for this repository. The migrated geometry, place
anchors, renderer, artwork and original provenance remain in use. The old
`sceneAttribution.scenarios` reference describes historical provenance, not the
new curve values. No additional source/assets or third-party license were
introduced. See [simulation scenarios](simulation.md).
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
## 2026-10-24 — Full-campus material extension

The campus scene chart, spatial field, viewport chunk scheduler/material renderer
and affine crown masks are newly authored in this repository. They generalize
the accepted library chart and shader and retain the previously attributed
frontend modules. They introduce no third-party source, dependency, model or
license change. Existing generated material bytes and their provenance remain
unchanged in [the asset record](library-tree-generation.md). The official GIS
is loaded online and processed only in transient CORS-permitted browser memory;
no historical or newly downloaded school raster is bundled or published.

Native-canopy correction adds newly authored bounded runtime foliage inference
and cached alpha/depth compositing. It reuses only CORS-permitted live source
pixels in memory, retains native leaf texture, and adds no bundled raster or
third-party implementation. The prior broad warm overlay is disabled in campus
mode. Final local screenshots were metadata-stripped/rechecked before sharing.

## 2026-10-24 administrator account and Passkey dependencies

The account/session/password/D1 adapters and React account-security interface are
newly authored in this repository. WebAuthn generation and verification use
`@simplewebauthn/server`14.0.3 and browser ceremonies use
`@simplewebauthn/browser`14.0.0, both MIT-licensed packages installed from npm and
recorded in the lockfile. Their transitive package notices remain part of their
packages; no library source or external example application was copied wholesale.
Sources: [server documentation](https://simplewebauthn.dev/docs/packages/server),
[browser documentation](https://simplewebauthn.dev/docs/packages/browser).
Password derivation uses native `node:crypto` scrypt rather than third-party
password implementation code. New auth screenshots show synthetic local QA only,
contain no credential values and are not committed; final copies are metadata
stripped/rechecked before any sharing.

## 2026-10-25 application icon

The selected icon is newly AI-generated with the built-in image generation tool
for CampusPulse; no external logo, artwork or implementation was imported.
The selected design is an abstract C-shaped campus route with a turquoise endpoint
on navy. The earlier literal gateway/pulse concept was rejected and is not bundled.
This is a generated raster asset, not a claim of trademark clearance or an
upstream open-source license. Existing third-party notices are unchanged.

`public/icons/campuspulse-1024.png` is the metadata-stripped selected master.
The 512/192 px manifest icons, 180 px Apple touch icon, 32 px favicon and
16/32/48 px ICO are Lanczos-resized derivatives. The homepage brand uses the
192 px variant, as do the administrator sidebar, login and account-initialization
screens. These files add no service worker or offline functionality.
Original generation output is retained outside the repository. Final served PNG
and ICO files were inspected with ExifTool after conversion: no EXIF, GPS, XMP,
IPTC, MakerNotes, comments, embedded thumbnails, or identity/contact/path metadata
were found. Only image-format structure remains. Orientation and colors were
visually checked. Local browser/build verification is separate from deployment.

Final generation prompt (built-in tool; opaque background):

```text
Use case: logo-brand
Asset type: original CampusPulse application icon, single square image.
Design a refined, memorable abstract identity for a campus activity map. One bold geometric C-shaped continuous route, suggestive of a softly folded map or a campus circulation loop. The C has a subtle upward rhythm in its open right edge, integrated into the same shape, not an added heartbeat line. Make it feel like a smart map product, contemporary university life, and movement.
Visual discipline: one cohesive thick silhouette, a few decisive rounded corners, carefully balanced negative space. Prefer a beautiful simple symbol over literal explanation. Flat vector-like graphic, no texture, no glow, no shadows. Pale icy cyan for the main C, one restrained turquoise endpoint that belongs to the route. Deep midnight navy full-bleed square background. Symbol occupies about 68 percent of canvas width, centered optically. Crisp at 16px.
No literal buildings, no gates, no towers, no roofs, no heart or ECG zigzag, no antennas, no shields, no pins, no tiny details, no text, no wordmark, no letters other than the abstract C shape, no presentation mockup, no outer border. Deliver exactly one finished square icon.
```
