# October 21 frontend migration and night lighting

Status: PixiJS lighting overlay implemented and visually checked locally on
2026-10-23. Database-write testing is explicitly excluded at the user's request.
This note does not certify deployment, hardware, radio accuracy or measured
campus activity. [Reuse provenance](../notes/reuse.md) records the selected prior
code and assets; [the QA report](../../design-qa.md) records current evidence.

## Current verification

The latest local checkpoint passed the production build,28 frontend tests and
desktop/phone browser checks. It includes registered wall light, actor materials,
proportion correction and camera-registration fixes. Existing Pixi binding
warnings and incomplete reference-wide fidelity are recorded in design-qa.md.
Database tests/writes were deferred for these frontend iterations. Earlier
verification sections below are historical and do not replace this boundary.

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
not packaged or uploaded. Geometric sprite clipping avoids reading remote school
pixels through canvas, so it needs no CORS bypass or bundled foreground image.

The default is explicitly labelled synthetic demonstration. Field mode suppresses
all synthetic actors, waits, metrics and replay; the independent field-record
panel reads the current API. It requires selecting an API placement and does not
invent matches between every API placement and historical map landmarks.

## Implemented light comparison

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

## Pixi integration acceptance

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

## Actor scale review after lighting integration

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

## Shared ground/actor illumination

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

Build and23 frontend tests passed; browser mode/motion/day-night and390x844 phone
checks passed. Existing transient Pixi binding warnings remain on device resize;
no runtime errors were observed. Metadata-cleaned final desktop/detail/phone
captures and remaining fidelity gaps are recorded in design-qa.md. Full-campus
coverage and physical material response remain incomplete; this is not a claim
of visual parity. Database tests/writes remain excluded.

## Wall-plane registration and selective night grade

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
