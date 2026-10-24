# October 21 frontend migration and night lighting

Latest local iteration: [unified library-entry lighting](library-entry-lighting.md).
The default night choice is now **入口实验**, with **暖光增强** and **原始效果**
retained for comparison. The experiment adds approximate surface normals,
height, tree-volume transmission and shared actor shading; the sections below
describe the retained enhanced baseline and its historical checkpoints.

Status: PixiJS lighting overlay implemented and visually checked locally on
2026-10-23. Database-write testing is explicitly excluded at the user's request.
This note does not certify deployment, hardware, radio accuracy or measured
campus activity. [Reuse provenance](../notes/reuse.md) records the selected prior
code and assets; [the QA report](../../design-qa.md) records current evidence.

## Current extension

The full visible-campus implementation is now described in
[campus lighting](campus-lighting.md):176 authored receivers,309 crowns,94 added
point lights and a shared bounded chunk renderer cover all eight selectable
places. The accepted library keeps its calibrated model. The following pass16
record describes the earlier local trial; current campus acceptance is tracked
in the new document and root visual QA. No deployment or database write is
implied.

## Library trial verification

Final pass16 build and 148 frontend tests across 16 suites passed at 03:57:21
after adding the selected-library guard.
Metadata-cleaned/viewed desktop 1487x1058, detail 394x355 and phone 390x844
captures are `pass16-desktop.png`, `pass16-detail.png` and `pass16-mobile.png`
under `captures/library-material-20261024/`. `paired-pass16.png`, motion A/B,
parking-pan and xray captures were also metadata-cleaned/viewed. Independent
static/representative-motion review resolved P1 actor readability and accepted
the bounded local library trial's style/cohesion. Clear poses/continuous night
lighting showed no obvious floating, unintended rendering through walls or 16/13px oversize regression.
Phone scroll/client 390/390 had no horizontal overflow and all tiles loaded.
Both maps advanced 2084 frames during 86.328 seconds with shared scene clock
125.776, stable 56 actors and identical four-slot parked signature. This supports
the checked representative motion, not every possible pose. Full-campus
extension remains separate; no feature gap remains for this bounded trial.
No DB/deploy/commit operations ran.

The 4.8-map-unit person baseline is unchanged. Desktop overview stays 6.2925px;
library detail presents physical 10.452px as 16px (factor 1.5308). Phone overview
stays 4.5375px; detail presents 6.7077px as 13px (factor 1.9381). This is optional
cartographic presentation only in detail/demo/night/library ROI with
`selectedId === 'library'`, feathered and
capped at 2 without shrinking larger physical/high-zoom art. Shared type ratios,
foot/tyre anchors, 47+5+4 actors, routes, headings and clock remain. Cast shadows
use physical dimensions; contact AO follows display footprint.

Walk-only bright-blue albedo gains bounded green (max+42, cap 0.58B) before the
unchanged shared shader; source 0/66/244 becomes 0/108/244. Alpha/source RGBA and
dark/warm/white features are preserved, vehicles keep their palette, and no
emission/glow/private exposure/post-filter is introduced. Default original/day/
enhanced/world behavior remains code/unit-verified and browser mode checks now
confirmed physical=display, readable 0 and library hosts 0 for enhanced/original/
day. Field mode had 0 actors/contacts/readable. People off kept 0/5/4, bikes off
47/0/0; waits off removed labels while keeping 56 actors. Search/place switching
and local pan/zoom registration passed (local scale 2.721893, overview 1.3109375).
The selected-place edge was fixed and full-reload checked: `teaching-8` detail
physical/display 15.885/readable 0, library return 16px/readable 27. See the
[library experiment](library-entry-lighting.md) for the bounded acceptance and
physical/display measurements. No exhaustive all-motion claim is made.

### Pass15 sky/fixture checkpoint (historical)

Pass15 was selected over pass14 in the local sky A/B: stronger warm entry/
window/paving hierarchy retains roof ribs, foliage and blue activity marks without a
black grove. `pass15-desktop.png`, `pass15-detail.png` (394x355) and
`paired-sky14-15.png` are under `captures/library-material-20261024/`. This is
an A/B improvement decision, not overall fidelity acceptance. Metadata-cleared/
viewed `pass15-mobile.png` and `paired-pass15.png` record final phone/source-current
views. At 390x844, scroll/client width was 390/390; both GIS sources were ready,
three downlights present and official tiles loaded. Review found no layout/
geometry regression and accepted night cohesion as an experiment. Full style
work remains open: **P1 actor readability** concerns fine blue desktop-detail
lines and phone dots where the reference has readable human poses.

Final build and 139 frontend tests/16 suites passed at 03:25:44 after sky 0.65,
with script syntax/diff checks passing. Pass14 checks covered original/day
with zero library hosts and original actors, field mode with zero synthetic
actors/contacts, and 390x844 without overflow. Four material sources and three
canopy fixtures were ready/present with official tiles loaded; captures were
metadata-checked/viewed. The cached desktop atlas measured 2332.1ms across both
maps, not phone hardware or per-frame performance. No DB/deploy operations.

### Pass13 runtime-source checkpoint (historical)

The runtime GIS material checkpoint passed `npm run build` and
`npx vitest run tests/frontend`: 133 tests across 15 suites. Both actual in-app
browser views reported GIS `ready`, source material ready and shared
revision `1:1:1:1`, with source pixels roof 29778/canopy 5644/wall 7327. A desktop
atlas compile measured 2261.2ms, cached for both views; it is not phone or
per-frame performance. Final metadata-cleaned/viewed `pass13-desktop.png` and
`pass13-detail.png` (394x355) are in `captures/library-material-20261024/`.
Pass12 predates the wall cool-cast correction described below.

With browser cache disabled and zoom2 requests blocked, ordinary zoom3 tiles
still loaded. Both GIS states fell back with source-ready false and
`gis-wash-fallback`; generated materials stayed ready with a 573x441 atlas.
Settings were restored in `finally`, then reload reconfirmed ready in both views.
This is a controlled failure/recovery result, not coverage of every CORS failure.

The prior absolute no-GIS-canvas-read limit is superseded only for this bounded
library source path. The 123-test pass11 checks below remain historical. At
pass13, phone/mode and fidelity review were pending; later pass14 checks are
recorded above. No DB/deploy
or concept-fidelity acceptance is claimed.

### Pass11 checkpoint (historical)

The framing/contact/reflection and density checkpoint passed `npm run build`
and `npx vitest run tests/frontend`: 123 tests across 14 suites. Metadata-checked
`pass11-desktop.png`, `pass11-detail.png`, `pass11-mobile.png` and paired review
are under `captures/library-material-20261024/`. Search, local registration,
original/day, xray, field-zero and 390x844 layout were checked in-app. The final
static crowd frame is readable; visual night hierarchy remains below the target.
Door reflection was reduced to.38 and canopy-entry power/radius is1.8/26.
20:10 has47 synthetic walkers,5 riders and4 parked bikes on unchanged paths;
the replay/layer audit peaked at57/72. No DB/deploy or fidelity acceptance.
The measured final desktop atlas compile was2203.4ms, cached for both maps; the
separate approximately 42ms/111509-pixel incremental shader benchmark ran in
Node and is not browser or physical-phone performance.

Historical entry-reflection refinement: build and107 frontend tests/12 suites passed.
The pass7 desktop/detail/phone/paired PNGs under
`captures/library-material-20261024/` were metadata checked and visually reviewed.
Door details remain visible and paving falloff improved slightly; the base now
reads somewhat flat/pale and the entrance/trees/actors still lack the reference's
clear lighting hierarchy. Concept-fidelity acceptance remains open. Phone390x844
fits with material layers ready; no database operations or deployment ran.

The 2026-10-24 common-material checkpoint passed `npm run build` and
`npx vitest run tests/frontend`: 106 tests across 12 suites. The pass6 desktop/detail
captures in `captures/library-material-20261024/` record that iteration, alongside
phone and paired captures. Independent review did not accept its fidelity: the
ground-floor stripe remains dark and paving too even. Later entry-band source
refinements are covered by the separate107-test checkpoint above.
Earlier desktop/phone checks and their warnings are historical
evidence, not a new physical-phone or fidelity acceptance result. No database
tests/writes or deployment ran for this continuation. The broader concept-
fidelity gate remains open; build/test success does not establish parity.

## Current local material pipeline

`gis-material.js` adds a separate anonymous-CORS loader for the minimal official
zoom2 tiles covering the library. It builds one 573x441 ROI canvas and reads its
pixels once for bounded approximate linear-albedo normalization. Roof/canopy
ribs, door details and solid-wall source colors remain in the material while
their normal-composited reception uses the shared shader. This is approximate
relighting, not recovered physical albedo or removal of every baked shadow.
Processed pixels stay in memory; no GIS bitmap/historical snapshot is bundled
or saved as an application asset. Existing map `<img>` tile loading is unchanged.

The loader requires ordinary server-approved CORS, not a workaround; see
[MDN's cross-origin canvas guidance](https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image).
Tree/building/paving/GIS ready-or-fallback states gate one cached compile shared
by both maps. `data-gis-material-status` and `sourceMaterialPixels` expose this
path. Failed requests or canvas reads retain pass11's earlier wash; controlled
request-failure fallback and successful reload recovery were verified above.

The wall profile now includes `coolNeutralization: 0.6` for eligible baked cyan/
blue casts. Its partial mix preserves linear luminance/detail contrast and
guards warm, green and near-black source features; roof/canopy settings remain
unchanged. It approximates a source cast rather than recovering true albedo.
Pass13 diagnostic examples were roof albedo 194/188/169→79/94/104 shaded and
door 69/80/81→105/103/87 in the model chart, not measured colorimetry. The later
sky calibration changes shader output, so these are historical samples.

The **入口实验** region now uses `surface-lighting.js` for authored paving,
foliage, facade reflectance and cached actor pixels. All decode sRGB to linear
RGB, consume the shared raw direct/ground-bounce/facade irradiance, apply the same
exposure 1.6 and bounded tone map, then encode sRGB. Normals and blockers come
from `library-lighting.js`; generated asset RGB is not sampled from GIS tiles.
`paving-material.js` registers gray concrete/red grout to the retained projection.
Its normal ground canvas bypasses old shade/tint/screen light on authored pixels;
three planting islands in `ground-features.js` remain excluded with inward edge
coverage. The new source-material path above handles retained GIS surfaces;
its failure fallback preserves their earlier material/wash behavior.

`building-material.js` uses neutral reflectance plus additive warm interior RGB,
with linear-luminance normalization and a frame-excluding emission mask. Only
the 279 reviewed pane polygons receive glass material; door/sill pixels outside
window-band UV0..1 remain. `room-lighting.js` shares 37 bright/83 ordinary/95 dim/
64 unlit panes with 19 cached facade-area emitters in `library-lighting.js`.
The emitted field reaches paving, trees and actors through the same geometry;
these are illustrative rooms and lighting units, not actual occupancy/lamp data.

`library-light-atlas.js` and `LibraryLightingLayer.jsx` share one cached world
atlas between both maps and wait for tree/building/paving/GIS ready-or-fallback
states before compiling. Pan/zoom crops it on demand; xray fades building
channels. Original/enhanced/day and field/demo separation remain available.
The [library experiment](library-entry-lighting.md) records current limits and
the [generation record](../notes/library-tree-generation.md) records asset
prompts, fingerprints and metadata checks. This local material work has not
been deployed or accepted as matching the concept.

The optional GGX material response now uses one model-world received-energy
direction from the three source families. It replaces up to a 0.5 diffuse share
with a bounded dielectric specular share; ambient/self-emission alone does not
create gloss. Roughness values are foliage 0.5, paving 0.78, glass 0.3, frame 0.82 and
actor 0.75. This is an independently implemented averaged-lobe approximation
informed by [Filament's GGX/Smith/Schlick reference](https://google.github.io/filament/main/filament.html#materialsystem),
with no copied code, environment/refraction model or full PBR claim. Actor
contact AO remains at feet/tyres independently of direct fixture cast shadows.

`map-framing.js` fits the library roof/facade/entry into authored bounds
554/190/169/134 with 12px padding, or 571/235/147/78 in a wide phone strip.
At 1487x1058 the local scene is 394x355px; its selected badge sits in a corner
and redundant local wait labels are hidden. Overview labels, metrics and layers
remain. The earlier framing checkpoint used atmospheric matrix .42/.46/.48
main RGB diagonal and gamma 1.13 for library mode. The selected pass15
calibration now uses `SCENE_SKY_STRENGTH=0.65` and library-only raster diagonal
.34/.38/.43, keeping exposure 1.6 and pass14 lamp/room powers unchanged.
Enhanced-atmospheric/original modes retain their existing treatment.

`libraryCanopyDownlights` adds three fixtures under the retained circular roof,
bringing `libraryLights` to 13 with 9 receivers/8 tree volumes unchanged. Arc
angles 30/90/150 degrees and lens height 7.1 place them 0.4 below the roof at 7.5.
Each uses power 1.2/radius 26, full downward response within 58 degrees and a soft
cutoff at 68 degrees. That cone applies to direct and ground-bounce energy;
the new lights contribute zero to the canopy top. The cached normal
`buildingFixtureMaterial` channel draws discrete common-shaded casings/tiny
lenses, without a continuous ring/halo. They are excluded from street-pole art;
xray fades the building channel. These are illustrative fixtures, not observed
campus hardware, and add no generated bitmap asset.

## Preserved interaction baseline

The user selected the October 21 prototype as the implementation baseline.
`src/campus/` retains overview and independent local maps, search, label/building
selection, pointer/keyboard pan and zoom, detail close/reopen, auto/manual
appearance, shared 07:00–22:00 replay/presets, per-place time comparison, three
independent layers, directional moving riders/pedestrians, riderless parking,
projected building occlusion, selected-building transparency and separate motion
control. Phone layout keeps the detail sheet and persistent timeline/layers.

Official remote zoom3 tiles replace the old bundled JPEG without changing its
1024x640 coordinate registration (columns 10–17, rows 7–11; 256px tiles display at
128px in reference coordinates). Only visible tiles plus overscan are requested.
Failed tiles show an explicit retry message; the historical school snapshot is
not packaged or uploaded. Geometric sprite clipping itself remains independent
of remote pixel reads. The separate local source-material loader above now uses
CORS-approved canvas access; it adds no bundled foreground image.

The default is explicitly labelled synthetic demonstration. Field mode suppresses
all synthetic actors, waits, metrics and replay; the independent field-record
panel reads the current API. It requires selecting an API placement and does not
invent matches between every API placement and historical map landmarks.

## Retained enhanced light comparison

This section describes the enhanced baseline. The library source-material
continuation above supersedes the earlier renderer-wide no-pixel-read boundary.

Open **场景设置 → 夜景光照** and compare **暖光增强** / **原始效果**. Both overview
and local view use the same choice. Day appearance draws no night lights.

The enhanced treatment now uses **PixiJS 8.22.0 + pixi-filters 6.1.5** in a
transparent lighting-only overlay. `AdvancedBloomFilter` and `BlurFilter` process
separate warm ground/window emission. A shared registered paving mask clips
ground emission after filtering; window emission is limited to its reviewed
facade strips. Existing map tiles, actor rendering and interaction handlers are
unchanged. `NightLighting.jsx` lazily loads `PixiLightLayer.jsx`;
`CanvasNightLighting.jsx` retains original appearance and the initialization/
context-loss fallback. The fallback path is implemented, not force-tested here.

Ground light uses a cached world-space 2048x1280 texture. Its already-masked
diffuse layer is not masked a second time; only additional GPU emission is
post-masked. Lamp orientation uses a nearby route tangent or local apron, with a
distance cutoff. Window cores stay warm and small. No real lamp positions,
lighting states or building interiors are inferred. Midtones remain visible
under a cool soft-light treatment. Both GPU tickers are stopped; transforms,
settings and viewport changes explicitly invalidate rendering.

Compared with the retained concept, this improves warm/cool separation and
visible pavement illumination while preserving real campus architecture. It
still has the detail and fixed camera of a daytime GIS raster: the original
shadows are baked into that picture. It cannot reproduce the concept's full
three-dimensional indirect lighting, tree detail or physically correct shadows.

## Rendering choice

| Approach | Fit for this implementation | Remaining work |
| --- | --- | --- |
| React + Canvas 2D + CSS | Original appearance and GPU-failure fallback | Retained unchanged interaction baseline |
| PixiJS 8 + pixi-filters 6 | Selected and implemented for lighting only | Further appearance tuning and optional aligned light/depth assets |
| Three.js + React Three Fiber/Drei | Candidate for a genuine 3D scene with registered models | Acquire/author models, materials, height/depth and camera registration |
| Offline light/AO baking + lightweight runtime overlays | Recommended next experiment for high fidelity at a fixed camera | Produce licensed day/night renders or aligned light/depth maps; preserve original source |

A UI component library can help forms and menus but cannot create lighting data.
React Three Fiber is a React renderer for Three.js; adopting it alone does not
make the image more realistic ([official introduction](https://r3f.docs.pmnd.rs/getting-started/introduction)).
Three.js supports baked illumination through `lightMap` and occlusion through
`aoMap` ([MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)).
Its [shadow guide](https://threejs.org/manual/pages/shadows.html) explains the
cost of shadow-casting lights and the alternative of precomputed illumination.
This supports starting with aligned baked light/depth assets before attempting
an entire live 3D campus. Canvas masking/blending follows the
[Canvas compositing API](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/globalCompositeOperation).

## Migration verification (historical)

- `npm run build`: TypeScript checks and production bundle passed.
- `npm test`: 18 tests passed (9 SQLite/API contracts and 9 retained geometry
  invariants). Geometry checks do not establish navigation or surveyed accuracy.
- In-app browser: 1487x1058 and 390x844, DPR 1, real official tiles loaded.
  Search, time presets, appearance, independent actor/wait toggles, separate map
  zoom, xray, field mode and modal keyboard focus were exercised. Field mode
  returned zero synthetic actors in both canvases and no mock wait labels.
- Fixed a mobile field dialog wider than the viewport; recheck measured its
  bounds at x=18..372 on a 390px screen, with no horizontal overflow.
- Final browser warning/error log was empty in the inspected preview session.
- `scripts/browser-smoke.mjs` now covers the migrated UI, including the local
  record POST/soft-cancel flow. Its syntax was checked. This session did not run
  its authenticated mutations: automatic approval review rejected the browser
  submission and required explicit user reapproval. No workaround was used and
  no cloud observation was written. Passing API unit tests are separate evidence.
- Final generated assets and delivered screenshots were inspected for metadata.
  School-raster screenshots stay outside the repository in `/tmp/`; they are
  evidence for this local review, not authorized map redistribution.

## Research before implementation (historical)

The user deferred database-write testing and requested investigating an existing
lighting library instead of continuing hand-tuned canvas effects. The latest
uncommitted surface-mask renderer is an experiment, not visually accepted work.
Its 13 frontend geometry tests passed; no database tests or mutations were run
for this iteration.

Preferred next spike: **PixiJS 8 + pixi-filters 6**, used only for a transparent
lighting overlay over the existing map. This is an integration proposal, not an
installed dependency or proven compatibility/performance result. Keep map tiles,
registration, actor paths, selection, pan/zoom, detail view and replay unchanged.

- [PixiJS Filters compatibility and effects](https://github.com/pixijs/filters)
  explicitly pairs PixiJS 8 with Filters 6. Its existing bloom/blur/color filters
  can replace custom effect kernels.
- [AdvancedBloomFilter](https://pixijs.io/filters/docs/AdvancedBloomFilter.html)
  provides brightness threshold, bloom strength and blur controls. It affects
  visible light appearance; it does not recover surface geometry from a picture.
- [pixijs-light2d](https://github.com/haiyoucuv/pixijs-light2d) advertises PixiJS 8
  point/ambient lights, normal maps and shadows. Its LightSprite requires a normal
  texture. It is a smaller project and needs a separate compatibility/asset spike
  before being chosen; the published claims are not verified in this repository.
- [PixiJS Lights](https://github.com/pixijs-userland/lights) documents a PixiJS 7 /
  @pixi/layers 2 dependency and separate diffuse/normal/light render layers, so it
  is not an assumed drop-in for a PixiJS 8 stack.
- [Three.js postprocessing](https://github.com/pmndrs/postprocessing) is suitable
  if a real 3D scene is later introduced; the present map does not supply its
  registered models/materials.

The visual spike should judge light spill, pavement texture, warm window cores,
alpha blending over the unchanged remote tiles, mask boundaries and phone cost.
Filters reduce effect implementation work; masks/normal/depth assets still
control whether the light looks attached to real surfaces. No new library has
been installed yet.

## Pixi integration acceptance (historical)

- Build and 13 frontend-only tests passed (9 retained geometry invariants and
  4 lighting geometry checks). No API/database tests or mutations were run in
  this integration pass.
- In-app browser confirmed two `pixi-webgl` canvases with
  `AdvancedBloomFilter+BlurFilter`, stopped tickers, matched GIS/GPU origin and
  scale, original/enhanced switching, morning/day zero lights, evening GPU
  reinitialization, and 390x844 phone layout without horizontal overflow.
- Fixed double soft-mask attenuation, then resource lifetime warnings when two
  independent views resize or change appearance. Shared transient filter inputs
  are released after rendering; composite filters' owned child shaders are
  explicitly disposed. The Pixi 8.22 shared FilterSystem bind group is detached
  before renderer screen-pool pruning. These compatibility guards must be
  rechecked on dependency upgrades. Original/enhanced and day/night scoped
  checks had no runtime errors. A later reset from emulated desktop to the native
  app viewport still produced a transient pooled-texture binding warning; both
  GPU views continued rendering. This is a remaining library-lifetime polish
  item, not a claim of warning-free resize behavior.
- Final screenshots: `/tmp/campuspulse-pixi-final.jpg` (1487x1058),
  `/tmp/campuspulse-pixi-detail.jpg` (470x900),
  `/tmp/campuspulse-pixi-mobile.jpg` (390x844). ExifTool stripped/rechecked these
  final files; no identifying metadata remains. They are local evidence only.
- This remains a fixed-view 2.5D compositing implementation. The reference's
  physical facade/indirect illumination and full-campus detail are not achieved
  or claimed by adding bloom filters.

## Actor scale review after lighting integration (historical)

The user identified oversized, stretched actors. The previous renderer stretched
whole square sprite cells and assigned moving vehicles a frame almost three
times the parked frame. This has been corrected independently of lighting.
`actor-style.js` trims directional alpha bounds at runtime, preserves image
aspect, anchors feet/tyres at the existing route point, and applies a shared
world scale. Illustration heights are4.8/4.8/3.6 map-reference pixels for
walking/riding/parked; these are visually calibrated, not a survey.

At the checked desktop scale, walking/riding frames are6.29px in overview and
13.00px locally. Zoom changes are proportional in both maps; the old .8–2.2
clamp no longer decouples characters from architecture. Source assets, counts,
paths, headings and all controls are retained. Build,17 frontend tests and
current desktop/phone visual review passed. Database tests/writes stayed excluded.
See the latest section of [visual QA](../../design-qa.md) for before/after evidence.

## Shared ground/actor illumination (historical)

The latest iteration adds a single analytic world light model in lighting-field.js.
It supplies both the ground atlas and sampleLocalLight(x,y), with identical source
falloff and receiver coverage. Registered aprons extend visible library paving;
planting islands and projected buildings remain excluded. Four decorative entry
spills are explicitly illustrative. Broad lamp fill is reduced relative to entry
spill; atlas opacity is bounded at .58 and preserves the underlying paving.

ActivityLayer samples at existing feet/tyres. New actor-lighting.js quantizes
brightness/warmth/direction and caches local source-frame materials with bounded
LRU memory. Day/raw and original-night behavior remain; enhanced night adds cool
shadow and warm lit states plus a source-facing rim. Alpha, proportions, routes
and occlusion are retained. This is 2.5D pixel tinting, without normals or cast
shadows. Pixi adds low-frequency facade response with less concentrated window
bloom. No map pixels are read into either renderer.

Build and23 frontend tests passed; browser mode/motion/day-night and 390x844 phone
checks passed. Existing transient Pixi binding warnings remain on device resize;
no runtime errors were observed. Metadata-cleaned final desktop/detail/phone
captures and remaining fidelity gaps are recorded in design-qa.md. Full-campus
coverage and physical material response remain incomplete; this is not a claim
of visual parity. Database tests/writes remain excluded.

## Wall-plane registration and selective night grade (historical)

The user's next review found that the scene still looked like dimmed daylight
and that building lights detached. The active enhanced renderer now replaces
the historical rotated facade dots with manually reviewed visible wall planes
and polygonal panes. Sloped roofs, the circular canopy and ornate central
windows retain their original appearance. The wall textures combine continuous
soft reception with stable bright/dim/unlit room variation. These are artwork
in the existing fixed projection, not surveyed walls/windows or occupancy.

A per-map SVG color filter transforms the official raster in sRGB: neutral
roofs shift toward slate blue and green vegetation retains darker green. The
warm overlay is above that filter. Day/original selectors are retained. This
changes the rendered color response without copying or reading official tile
pixels. No new raster, models or runtime dependencies were added.

Camera debugging found two actual registration defects: raster-only240ms
transform interpolation, and a cancelled StrictMode async renderer initialization
clearing its replacement's invalidate callback. The raster now follows the same
camera directly, and each renderer can clear only its own runtime reference.
Post-fix local zoom changed GPU scale/origin to match the raster; old behavior
left the GPU at its initial frame. Tests and final visual evidence for this
iteration are maintained in design-qa.md.
