# Library-entry shared lighting experiment

## Detail actor readability — pass16, 2026-10-24

The final post-selection-guard `npm run build` and all frontend tests passed 148
tests across 16 suites at 03:57:21. Metadata-cleaned/viewed evidence under
`captures/library-material-20261024/` includes `pass16-desktop.png`,
`pass16-detail.png` (394x355), `pass16-mobile.png` (390x844), `paired-pass16.png`,
motion A/B, parking-pan and xray captures.
Independent static and representative-motion review resolved P1 actor
readability and accepted this bounded local library trial's style/cohesion.
Inspected frames showed clear poses and consistent night lighting, without
obvious floating, unintended rendering through walls, oversizing or new overlap.
Runtime coordinates support parked-anchor constancy; it is not inferred from
one photo.
Acceptance covers the checked library trial and representative frames, not every
possible motion pose or full-campus reconstruction. Full-campus extension remains
a separate open direction.

`actor-style.js` keeps the 4.8-map-unit person baseline and adds optional
cartographic detail presentation. Actual in-app measurements were:

| Viewport/view | Physical proxy height (CSS px) | Display height (CSS px) | Presentation factor |
| --- | --- | --- | --- |
| 1487x1058 overview | 6.2925 | 6.2925 | 1 |
| 1487x1058 library detail | 10.452 | 16 | 1.5308 |
| 390x844 overview | 4.5375 | 4.5375 | 1 |
| 390x844 library detail | 6.7077 | 13 | 1.9381 |

The table records full-ROI person diagnostics; border figures feather back.
Physical means the retained illustration-world proxy, not surveyed human size.
The optional factor requires detail/demo/night/library mode,
`selectedId === 'library'`, and the local ROI. It is feathered at the ROI boundary
and capped at 2. It never shrinks larger physical/high-zoom artwork.
Walking/riding/parked ratios share the same factor;
overview world presentation remains unchanged. Foot/tyre anchors, 47 walkers,
5 riders/4 parked bikes, routes, headings and the shared clock are retained.
Cast shadows use physical dimensions; contact AO follows the visible footprint.

`actor-lighting.js` adds a walk-only blue albedo profile before the same
`shadeSceneSurface` call. A soft bright/blue pixel mask adds at most 42 to green,
capped at 0.58B: the source example 0/66/244 becomes 0/108/244 before lighting.
Dark seams, warm/white features and source alpha remain; original asset bytes/
RGBA buffers are untouched. No emissive floor, private exposure, glow or post-
filter is added. Source-facing/light-shadow differences still come from
the common field/shader. Vehicles keep their existing palette. Original/day/
enhanced and ineligible world presentations retain their defaults in code,
unit checks and the browser modes verified below.

### Runtime closure checks

Both maps were observed for 86.328 seconds/2084 advancing motion frames with
matching scene-clock value 125.776. Poses advanced, total actor count stayed 56,
and the four-slot parked signature stayed identical. Metadata-cleaned/viewed
`pass16-motion-a.png`, `pass16-motion-b.png`, `pass16-parking.png` and
`pass16-xray.png` support the representative visual review. Local raster/atlas
matrices matched after pan/zoom at projected scale 2.721893; overview remained
1.3109375. Search/place switching was exercised.

| Browser check | Observed result |
| --- | --- |
| Enhanced/original/day | Display height equals physical proxy; readable count 0; library material hosts 0 |
| Field mode | Actors 0, contacts 0, readable 0 |
| People layer off | Walk 0, riding 5, parked 4 |
| Bikes layer off | Walk 47, riding 0, parked 0 |
| Waits layer off | Wait labels 0; actor count 56 retained |

The other-selected-place check found a scope edge and added the explicit
`selectedId === 'library'` guard. After full reload, `teaching-8` detail had
physical/display 15.885, readable 0 and registered-world presentation. Returning
to the library restored 16px with `readableActorCount=27` in that observation.
The final 148-test run above followed this fix. No further feature work is
required for the accepted bounded trial; the wider campus remains separate.

The phone capture reported scroll/client 390/390 without horizontal overflow
and all official tiles loaded. Earlier pass15 source/sky and pass13 controlled
failure evidence remains separately scoped below. No database operations,
deployment, commit or physical-phone performance validation ran for this pass.

## Canopy fixtures and shared sky — pass15 (historical)

Pass15 was selected over pass14 in `paired-sky14-15.png`: the warm entry,
windows and paving read more strongly, while roof ribs, foliage and blue activity
marks remain visible without a black grove. This accepts the local A/B improvement,
not overall concept fidelity. Checkpoint desktop evidence was `pass15-desktop.png`
and `pass15-detail.png` (394x355) under `captures/library-material-20261024/`.
`pass15-mobile.png` and `paired-pass15.png` were also metadata-cleared/viewed.
Review found no layout/geometry regression and judged night cohesion acceptable
for this experiment. The full style goal remains incomplete: **P1 actor
readability** remains because people appear as fine blue lines in the default
desktop detail and blue dots on the phone, where the reference shows clear human poses. Body/pose
legibility at actual default scales is the next work; overall fidelity is not
accepted.

The new `libraryCanopyDownlights` export adds three illustrative fixtures to
`libraryLights`, now 13 total; the 9 receiver planes and 8 tree volumes are
unchanged. Fixtures follow the existing canopy front arc at 30/90/150 degrees.
Each lens is at height 7.1, 0.4 map units below the unchanged 7.5 canopy roof, with
power 1.2/radius 26. Their downward cone has full response within 58 degrees of
the downward axis, feathering to zero at 68 degrees. The same cone controls
direct reception and derived ground bounce; these new sources add zero light
to the canopy top. Positions/heights are authored illustration, not a survey.

The cached `buildingFixtureMaterial` normal canvas draws three discrete casings
and tiny emissive lenses through the common material colors. It draws no
continuous ring or halo. These fixtures are excluded from the street-pole image
list, and xray fades this building channel. Existing source-preserving roof,
canopy, door and solid-wall materials remain in the common lighting pipeline.

The selected sky calibration is `SCENE_SKY_STRENGTH=0.65` with
`SCENE_EXPOSURE=1.6`. Lamp/room powers are unchanged between pass14 and pass15.
Library-only raster grading now pairs with that ambient using main RGB matrix
diagonal .34/.38/.43 and gamma 1.13; enhanced-atmospheric/original modes retain
their own existing treatment. This is a scene calibration, not new source data.

The final `npm run build` and `npx vitest run tests/frontend` repeat passed 139
tests across 16 suites at 03:25:44 after sky 0.65 calibration. Script syntax and
diff checks passed. Pass14 phone/mode checks
verified original/day with zero library hosts and original actor materials,
field mode with zero synthetic actors/contacts, and 390x844 without horizontal
overflow. All four material sources were ready, all three fixtures present and
official tiles loaded. Those captures were metadata-checked/viewed. Pass15 at
390x844 reported scroll/client width 390/390, both GIS sources ready, three
downlights and all official tiles loaded. One desktop atlas compile measured 2332.1ms,
cached for both maps; no physical-phone or per-frame performance is claimed.
The controlled source-failure/recovery evidence remains scoped to the earlier
133-test checkpoint below. No database operations or deployment ran.

## Runtime GIS source-material checkpoint — pass13 (historical)

The previous absolute no-GIS-canvas-read design limit is explicitly superseded
for this local library relighting path. Authored materials share the linear
shader, while roofs, the circular canopy and retained door/solid-wall details
still carried the original GIS daylight appearance under a wash. The new
`gis-material.js` direction processes a bounded official-source region at
runtime so these registered surfaces can use the same normals, raw lighting
and normal-composited material response. It does not change their geometry.

The loader separately requests the minimal official zoom2 tiles covering
`LIBRARY_BOUNDS` with anonymous CORS images, assembles a 573x441 ROI canvas and
performs one bounded `getImageData` read. Approximate bounded linear-albedo
normalization aims to preserve ribs, seams and source colors. This is not true
albedo recovery: source shading is inseparable from unknown reflectance and
residual baked illumination may remain. Processed material stays in browser
memory; no school raster, historic snapshot or derived bitmap is added to
tracked assets or an application-persisted image store. Ordinary map `<img>`
loading remains unchanged.

A 2026-10-24 GET probe of the
[official zoom3 tile](https://gis.ccnu.edu.cn/mapdata/zoom3/14_8.jpg) returned
200/image JPEG with `Access-Control-Allow-Origin: *`; HEAD returned 404.
This endpoint probe is separate from the browser checks below. Anonymous
image loading needs the server's CORS approval before canvas reads are
allowed, as described in [MDN's canvas/CORS guide](https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image).
No proxy or security restriction bypass is introduced.

Source-material pixels replace the old wash with a normal composite using the
same linear shader. `LibraryLightingLayer.jsx` waits for tree, building, paving
and GIS sources to reach ready/fallback before one shared compile for both
maps. Diagnostics add `data-gis-material-status` and `sourceMaterialPixels`.
Network/CORS/read failure retains the pass11 material/wash path.

`npm run build` and `npx vitest run tests/frontend` passed 133 tests across 15
suites. In the actual in-app browser, both views reported GIS material status
`ready`, `sourceMaterialReady=true` and shared revision `1:1:1:1`.
`sourceMaterialPixels` was roof 29778/canopy 5644/wall 7327. One desktop compile
measured 2261.2ms and both maps reused the cached 573x441 atlas. This is startup
work, not per-frame time or phone performance.

The actual browser fault check disabled cache and blocked zoom2 requests through
CDP. All ordinary zoom3 tiles still loaded. Both GIS loaders reached `fallback`,
`sourceMaterialReady=false` and `sourceMaterial=gis-wash-fallback`; generated
materials remained ready and the 573x441 atlas rendered. Request/cache settings
were restored in a `finally` cleanup, then a clean reload reconfirmed `ready` in
both views. This verifies that controlled request-failure fallback/recovery,
not every possible CORS or network failure.

After the pass12 source-material baseline, `gis-material.js` added a wall-only
`coolNeutralization: 0.6` adjustment for eligible baked cyan/blue casts. That
component leaves 40% of the original chroma difference at full eligibility,
while softer eligibility reduces it less, preserving
linear luminance and detail contrast. Warm colors, green paint and near-black
features are guarded; roof/canopy profiles are unchanged. This remains a partial
source-cast approximation, not physical albedo recovery. Debug samples in the
model's map-coordinate chart illustrate that checkpoint's shader response:

| Sample | Approximate albedo RGB | Shaded RGB |
| --- | --- | --- |
| Roof (640,212) | 194, 188, 169 | 79, 94, 104 |
| Door (637,262) | 69, 80, 81 | 105, 103, 87 |

These are model diagnostics, not surveyed positions or colorimetry. Final
metadata-cleaned/viewed desktop captures are `pass13-desktop.png` and
`pass13-detail.png` (394x355) under `captures/library-material-20261024/`;
pass12 predates the cool-cast adjustment. Phone/mode and fidelity checks were
pending at this checkpoint; later pass14 checks are recorded above. No database operations, deployment
or fidelity acceptance is claimed. The 123-test pass11 result below stays
historical. Generated assets retain their separate no-GIS-input provenance;
runtime source processing is a distinct path.

## Framing, contact and reflection checkpoint — pass11 (historical)

`npm run build` and `npx vitest run tests/frontend` passed 123 tests across 14
suites after the final density/reflection refinement. Local final evidence is
`pass11-desktop.png`, `pass11-detail.png`, `pass11-mobile.png` and
`paired-pass11.png` under `captures/library-material-20261024/`; final PNGs
were metadata-stripped/rechecked and viewed. In-app checks covered search,
independent local zoom/pan registration, original/day restoration, xray and
field-mode zero synthetic actors/contacts. Phone390x844 has no horizontal
overflow and loaded all requested official tiles. Independent review finds no
new static-frame regression or crowd overlap, but warm-night hierarchy still
falls short of the concept. No DB operations, deployment or fidelity acceptance.

The final pass lowers preserved-door reflection alpha from.72 to.38, retaining
over60% source contrast even at saturated reflection. The existing canopy-entry
lamp keeps its position/height with power1.8/radius 26, focusing a local peak.
Synthetic walkers are denser on unchanged routes:47 walk/5 riding/4 parked at
20:10. Existing IDs, phases and world positions remain; the full replay/layer
capacity audit peaked at57/72. This is illustrative activity, not field counts.

`map-framing.js` now fits the library roof, facade and forecourt together rather
than retaining a fixed close crop. Desktop display bounds are
left/top/width/height 554/190/169/134 with 12px padding; a wide phone strip uses
571/235/147/78. These are authored display extents, not surveyed geometry.
At 1487x1058, the detail scene is 394x355px rather than the earlier 394x291px.
Its selected-place badge sits in a corner and redundant local wait labels are
hidden; overview labels, metrics and independent layers remain. The whole
library-mode campus again uses the atmospheric raster matrix (main RGB
diagonal .42/.46/.48, gamma 1.13); the earlier extra-dark grade separated authored
materials too strongly from their surroundings.

The actor contact AO proxy anchors feet/tyres independently of direct-light cast
shadows, remaining bounded by ground coverage and sprite scale. Broad window
fill does not invent a hard cast direction. `surface-lighting.js` also adds an
optional dielectric GGX response using the field's model-world
`surfaceLightDirection`: the normalized received-energy direction across direct,
ground-bounce and facade source families. Roughness is 0.5 for foliage, 0.78 for
paving, 0.3 for glass, 0.82 for frames and 0.75 for actors. Specular weight is capped
at 0.5 and replaces the matching diffuse share; zero incident energy cannot
create gloss. The independently authored approximation uses GGX/Smith/Schlick
concepts described in [Filament's material reference](https://google.github.io/filament/main/filament.html#materialsystem).
No Filament code or dependency was copied. One averaged lobe is not per-light
BRDF integration, environment reflection, refraction or a full PBR renderer.

One final desktop atlas compile measured2203.4ms and the same cached result served
both maps. This is startup compilation, not per-frame time or phone hardware
performance. A separate Node benchmark measured approximately 42ms incremental
shader cost over 111509 supplied pixels; it is not a browser timing. Geometry,
279 pane quads, the 37/83/95/64 room pattern, 19 area patches and asset hashes
remain as documented below. Independent fidelity judgment is still required.

## Entry-reflection checkpoint — 107 tests (historical)

Build and107 frontend tests/12 suites passed after the entry refinement.
Final evidence is `pass7-desktop.png`, `pass7-detail.png`, `pass7-mobile.png`
and `paired-pass7.png` under `captures/library-material-20261024/`. Phone390x844
fits without overflow; both maps report ready materials,4867 preserved-door
reception pixels and one shared atlas (2127.9ms measured desktop compile).
Final PNG metadata was checked and the images were visually reviewed.

The three existing west-door fixtures retain their positions/heights with
power/radius2.8/30,2.5/28 and2.2/26. Actual door/sill details receive bounded
screen reflection from the shared shader with ambient disabled; they remain
transparent in the authored material channel and do not become emitters.
This is a relight approximation, not recovered GIS albedo. Independent pass7
review confirms a lighter base and slightly more focused paving, but finds a
flat pale band and insufficient entrance/foliage/actor hierarchy. Fidelity is
still open; this checkpoint is not concept acceptance. No DB/deploy operations.

## Common-material checkpoint — 2026-10-24 (historical)

`npm run build` and `npx vitest run tests/frontend` passed: 106 tests across 12
suites at this checkpoint. Subsequent entry-band refinements are covered by the
separate107-test checkpoint above. This remains a local prototype;
no database tests/writes, deployment or physical-device acceptance was performed.
Local evidence is under `captures/library-material-20261024/`:
`pass6-desktop.png`, `pass6-detail.png`, `pass6-mobile.png` and `paired-pass6.png`.
Independent review did not accept pass6 as close to the concept: a dark ground-
floor stripe and overly even paving remain. Brighter materials and passing tests
are progress evidence, not fidelity acceptance.

The library has 9 registered receivers, 10 illustrative fixtures and 8 textured
tree volumes. `surface-lighting.js` now supplies one linear-RGB response for
authored paving, foliage, facade materials and cached actor pixels: sRGB decode,
cool normal-aware ambient, raw direct/ground-bounce/facade irradiance, shared
exposure 1.6, bounded Reinhard mapping and sRGB output. Incidence and visibility
come from the existing common field; no material samples school raster pixels.

`building-material.js` keeps neutral glass reflectance separate from additive
warm interior emission. The latter is normalized by the generated warm cell's
masked-interior mean linear luminance and masked away from its metal frame. The 279 exact pane
quads retain 64 original unlit flags. `room-lighting.js` shares the stable pattern
between rendering and the field: 37 bright, 83 ordinary, 95 dim and 64 unlit panes.
The 120 emitting panes form 19 cached area-emitter patches on the actual reviewed
wall planes in `library-lighting.js`. Their outward/receiver response, distance
cutoff and shared plane/tree blockers illuminate paving, foliage and actors.
Room powers use calibrated illustration units, not measured radiometry.

`paving-material.js` registers the authored gray-concrete/red-grout bitmap to
anchor(600,270), basis(11,3.6)/(-5.5,7.5). Its normal-composited ground material
replaces old shade/tint/screen channels only inside the registered ground
receivers. Three shared planting-island polygons in `ground-features.js` and
inward edge feathering preserve those beds. The generated wall material replaces
only true window-band UV0..1; door/sill regions beyond that band, roofs and the
circular canopy retain their underlying GIS details. No extra windows or floors
are tiled into clipped cells. Original, enhanced and day comparisons remain.

`library-light-atlas.js` caches the 573x441 world atlas. `LibraryLightingLayer.jsx`
waits for tree, building and paving assets to reach ready/fallback before one
compile; both views share the result and crop it on demand. Failed assets keep
their previous material path. Xray fades building channels while ground and
foreground foliage retain their depth behavior. Asset prompts, final hashes and
metadata checks are in the [generation record](../notes/library-tree-generation.md).

Remaining limits include proxy geometry, generated appearance/leaf relief,
approximate area lighting and single ground bounce, and baked GIS appearance on
unreplaced surfaces. This is not a reconstructed campus or full global-
illumination renderer. See [visual QA](../../design-qa.md) for the separate
fidelity judgment; earlier evidence below is preserved as historical checkpoints.

## Previous local checkpoint — 75 tests (historical)

Continuation recorded on 2026-10-24: build and75 frontend tests passed. The library
then had9 receivers,10 illustrative fixtures and 8 textured tree volumes; the campus
baseline has13 added paving receivers,57 added lamps and32 registered facade
planes across 14 building groups. Official detail tiles adapt through zoom3/2/1
without removing the base while fine tiles load. This supersedes the original
eight-receiver/eight-fixture checkpoint described below.

The current shared evaluator also includes opt-in, energy-losing single ground
bounce and thin-leaf wrap/transmission. Direct-only remains available for its
physics checks. Cast shadows stay tied to direct fixtures. The last two low
fixtures follow the existing west-passage route; narrower doorway radii focus
the entry. Generated foliage and fixtures have
[prompt/metadata/provenance records](../notes/library-tree-generation.md).
Windows keep their pane positions but use stable room clusters:25 bright,
70 ordinary,120 dim and 64 original unlit panes. Actors retain world proportions
and paths, with denser explicitly synthetic activity and source-facing material
reflection. Original/day modes retain their existing material path.

Latest desktop evidence: `captures/library-fidelity-20261023/final-desktop.jpg`,
`final-detail.jpg` and combined source/current `final-comparison.jpg`.
Both scene inputs are1487x1058/DPR1/library6x/night20:10; focused crops have
different pane heights already present in the accepted UI. One current browser
atlas compile measured1289.4ms (573x441 pixels), shared by both views and compiled
only after the generated material settles. This is not phone-hardware timing.
Screenshots and generated assets were checked for identifying metadata.

Visual review still finds a gap to the concept's fully modeled geometry and
material response. `design-qa.md` keeps its fidelity result blocked; no claim of
concept parity or goal completion is made. Implementation and passing tests
are progress evidence, rather than a substitute for that visual judgment.

## Original local checkpoint (historical)

Status: locally implemented and browser-checked on 2026-10-23. This is a fixed-view
2.5D visual prototype with approximate geometry and illustrative lights. It does
not measure the campus, lamp state, occupancy, or individual positions. It has
not been deployed or validated on physical phones. Database tests and writes
remain excluded.

## Compare the result

Start `npm run dev`, open the local frontend, and select the library. The default
night treatment is **入口实验**. Under **场景设置 → 夜景光照**, compare it with
**暖光增强** (the previous renderer) and **原始效果**. The same selection applies
to the overview and independently zoomable detail. Daylight restores original
actor materials and suppresses night overlays. Field mode still hides all
synthetic actors, metrics, waits and replay.

Only the library region, map x=548..739/y=188..335, changes to the new field.
Previous ground lighting is feathered out there; its library wall emission and
fixed wall gradients are replaced rather than added a second time. Other campus
regions keep their earlier light field. No school raster or reference image is
bundled. The runtime GIS source-material continuation above now reads a bounded
official-source ROI; earlier no-read checkpoint claims are historical rather
than a current renderer-wide restriction.

## Shared geometry and illumination (original checkpoint)

`src/campus/library-lighting.js` defines an approximate orthographic chart:

```
screen.x = 540 + u - 0.65v
screen.y = 250 + 0.35u + 0.7v - z
```

These are arbitrary map units, not meters or a recovered official camera.
Increasing z at a fixed ground point moves vertically upward. Three reviewed
library wall masks retain their existing clipping and pane layout; their normals
come from the parallel floor/window quad rather than the roof-clipped outline.
Two roof planes, the circular entry canopy and two paving regions make eight
receivers. Eight porous ellipsoid tree proxies have curved normals, soft
id-stable irregular silhouette coverage and approximate heights. The highest
intersection of the camera ray selects the visible surface.

Eight illustrative path/entry sources feed the same evaluator for every
material. Direct response uses normal-dot-light, distance/radius attenuation,
plane intersections and porous tree-volume transmission. Low lights do not
illuminate an upward-facing roof. This is direct-light approximation; window
self-emission is separate and does not solve indirect/global illumination.

`library-light-atlas.js` caches a 382x294 CPU atlas at two pixels per map unit.
It contains independent cool shade, warm reception, reviewed pane emission and
normal diagnostic channels. Both maps share this CPU result; camera changes only
redraw its viewport crop. Ground shade/reception is below upright actors;
building overlays remain clipped above them. Library xray fades building
channels only, preserving paving and vegetation.

Actors sample the same sources/blockers at approximate torso height. Their
existing directional sprite art receives a quantized capsule-normal material;
alpha, dimensions, counts, paths and heading cells are preserved. Ground shadow
direction uses the lamp's **ground position**, with elevation handled separately
for normal shading. This avoids an elevated lamp reversing a ground shadow.
Contact/cast shadows stay under all actors and outside projected buildings.
Per-sprite canopy masks clip figures behind a tree base; foreground figures stay
visible. Masks and small actor material variants are cached with bounded sets.

## Verification (original checkpoint)

- `npm run build`: TypeScript and Vite production build passed.
- `npx vitest run tests/frontend`: 48 tests passed. New coverage includes chart
  inversion, wall planes, normal direction, low-light roof exclusion, actual
  fixture/tree/wall occlusion, shared actor sampling, canopy depth/coverage,
  ground-shadow direction and exact sprite-alpha preservation.
- `npm run test:lighting`: frontend-only Chromium regression at desktop 1487x1058
  and phone viewport390x844. Use `BASE_URL` for another local Vite port and
  `SCREENSHOT_DIR` for evidence output; defaults are port5173 and ignored
  `captures/library-lighting-qa/`. No observation forms are opened/submitted.
- The inspected desktop loaded all46 requested tile elements. Both maps reported
  the same cached atlas, 8 surfaces, 8 tree volumes and215 reviewed lit panes.
  One measured Chromium atlas compilation was459.9ms; this is a local desktop
  measurement, not a physical-phone performance claim. Idle light render counts
  remained unchanged after motion was paused.
- Verified independent local zoom/pan and matching raster/overlay transforms,
  previous/original comparison, building-only xray, morning/evening switching,
  field-mode zero actors, no phone horizontal overflow and visible comparisons.
  A simulated context-loss event selected Canvas fallback while preserving the
  local layer; this does not certify recovery from every real GPU failure.
- No uncaught browser errors. Existing Pixi texture/sampler binding warnings
  remain during renderer teardown/day-original transitions; Chromium capture
  also reports GPU ReadPixels stalls. Neither is claimed fixed by this prototype.

The inspected final desktop/detail/phone screenshots are under the ignored
`captures/library-lighting-20261023/`. ExifTool stripped/rechecked the actual
six final PNGs: no embedded identifying metadata was found. These captures
include remotely displayed GIS imagery and remain local review evidence.

## Remaining visual limits (original checkpoint)

The original GIS already includes daylight shading, vegetation detail and fixed
perspective. The overlay cannot recover clean albedo or remove all baked sun
shadows. Tree ellipsoids approximate crowns; their leaf edges, trunks, branches
and hidden geometry are not reconstructed. Plane blockers are partial surfaces,
not watertight surveyed buildings. The selected registration and art exposure
therefore remain subject to visual review. The result adds a common direct-light
response but does not reproduce the generated concept's full geometry, dense
foliage, indirect illumination or material fidelity. Full-campus expansion and
performance optimization remain on the roadmap.
