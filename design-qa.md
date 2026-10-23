# Map scene — current visual QA

Date: 2026-10-23. Scope: selected PixiJS8/pixi-filters6 transparent light overlay,
preserving existing official map and interactions. Database-write verification
is excluded at the user's request. Historical checks are archived below.

## Wall registration and night grade — latest review

The user's two P2 findings were daylight-like dimming and detached building
lights. Reference docs/design/assets/campus-concept.png and current desktop
/tmp/campuspulse-facade-pass2.jpg (both1487x1058,DPR1,night20:10,library6x)
were opened together; /tmp/campuspulse-facade-detail-pass2.jpg focused392x289
at1045,229 was also compared. Architecture remains the approved real GIS,
so this iteration targets night response/registration, not a different campus.

### Findings, fixes and second comparison

1. P2, surface registration: replaced rotated point windows with14 visible wall
planes and733 registered polygonal panes across library, Tianjiabing, teaching8,
literature and the unnamed southern H-shaped building. Sloping roofs, circular
canopy and sampled foreground trees are excluded. Added continuous wall reception
without replacing source raster detail. First comparison found east library
window rows fanning with the roof; corrected to parallel floor axes. Second
full/detail review found no remaining P1/P2 registration issue in these masks.
2. P2, luminous grid: first pass made most panes uniformly bright. Stable
bright/dim/unlit room exposure now gives varied emission while preserving glass
structure and continuous warm response; second comparison no longer found the
uniform luminous-grid issue. This is synthetic illustration, not occupancy.
3. P2, daylight-like grade: per-map sRGB matrix + gamma gives neutral roofs a
slate-blue response and vegetation a darker green response. It affects only
the raster; emitted warm light and actor materials stay independent.
4. P2, camera detachment: removed raster-only240ms transform interpolation.
Found a cancelled StrictMode async renderer clearing its replacement's runtime
callback, which froze GPU lights at the first camera. Cleanup now clears only
its own runtime. Browser zoom6x->7.5x->9.4x and back updated GPU scale/origin to
match raster values; overview remained independent. Search selection/reset also
matched both cameras after reinitialization.

### Required surfaces and verification

- Fonts/layout/spacing: existing fonts, panels, timeline, labels and controls
  retained. Phone390x844 has body width390 and no horizontal overflow.
- Colors/image quality: selective cool grade and registered warm wall reception;
  actual remote GIS and original actor sprites/proportions retained. No copied
  school raster, replacement models or new bitmap/dependency assets.
- Copy/content: existing source/synthetic/field notices unchanged; no added live
  or measured light claim. Fourteen masks are manually registered artwork.
- Browser: daylight reports day-original actor material; evening returns local
  light. Original effect restores its previous filter. Search 八号 and 图书馆,
  selected-building transparency, actor pause/resume and independent local zoom
  passed. Desktop actorCount28 and person heights6.29/13.00 remain unchanged.
  Both GPU canvases report14 wall planes.
- Build and28 frontend tests passed (including5 new wall-plane invariants). No
  database tests/writes, commit, push or deployment in this iteration.
- Scoped logs: no runtime errors; existing Pixi pooled-texture/sampler binding
  warnings still appear on appearance changes and resize. Both maps continue
  rendering. This P3 resource-lifetime polish remains open and is not certified
  warning-free. GPU-failure fallback has matching wall artwork, not force-tested.
- Final evidence /tmp/campuspulse-facade-final.jpg, detail392x289 and phone390x844
  /tmp/campuspulse-facade-detail.jpg,/tmp/campuspulse-facade-mobile.jpg. Final JPEG
  copies stripped/rechecked via ExifTool for EXIF/XMP/IPTC/MakerNotes/comments;
  no embedded identifying metadata remained. Orientation/readability checked.

The scoped night-grade/registered-wall/camera correction passes this iteration.
Reference-wide illumination coverage and real 3D indirect/tree/material response
remain broader roadmap work; this is not pixel-identical or physical-light parity.

Latest iteration final result: passed

## Local illumination iteration — current review

The user correctly identified that the prior image was still far from the
concept. The earlier renderer acceptance below establishes filter integration,
not reference-level visual fidelity. Full-campus light coverage and true 3D
material response remain P2 work.

- Added shared analytic world light sources, falloff and receiver masks for the
  ground atlas and actor materials. Expanded reviewed library forecourt/entry
  paving, excluded planting islands and retained projected building masks. Four
  additional entrance spills are decorative, not surveyed fixtures.
- Reduced continuous road fill relative to entry spill, added low-frequency
  facade bounce, reduced window bloom/cores and raised cool ambient exposure.
  The original GIS, actor sizes, paths, counts and interactions are retained.
- People, riders and parked bikes sample light at their existing feet/tyres.
  Cached 2.5D materials change brightness, temperature and source-facing edge;
  source alpha and blue/orange identities remain. Day/original mode keeps its
  former rendering. This is not physical shading or dynamic cast shadows.
- Final captures: /tmp/campuspulse-local-light-final.jpg (1487x1058),
  /tmp/campuspulse-local-light-detail.jpg (392x289 at1045,229), and
  /tmp/campuspulse-local-light-mobile.jpg (390x844). Same concept and library
  night20:10 state; motion paused for capture. Opened full/detail/phone for visual
  comparison. Facades and foreground paving are warmer; the source map still
  lacks the reference's lighting coverage, normals and night-specific textures.
- Browser: original/enhanced, motion pause and morning/evening passed. Both
  actor canvases reported local-field-2.5d at night,28 actors, unchanged parked
  signature; sampled intensity overview0-.832/local.088-.832. Desktop actor
  heights stay6.29/13.00px. Phone width/body390, no horizontal overflow.
- Build and23 frontend-only tests passed. Database tests/writes excluded. No
  browser runtime errors; two known Pixi pooled-binding warnings appeared during
  device resize. Renderer remained active; P3 lifetime warning remains open.
- Final JPEGs stripped/rechecked with ExifTool; no EXIF/XMP/IPTC/MakerNotes/comment
  metadata remained. Visual orientation and readability retained.

Current result: functional integration passed; reference fidelity remains partial.

## Previous Pixi integration review

### Source, state and comparison

Reference: `docs/design/assets/campus-concept.png`, 1487x1058. Prior implemented
map: `/tmp/campuspulse-enhanced-lighting.jpg`, 1487x1058. Current:
`/tmp/campuspulse-pixi-final.jpg`, 1487x1058; focused sidebar clip
`/tmp/campuspulse-pixi-detail.jpg`, 470x900 at (1017,70); phone
`/tmp/campuspulse-pixi-mobile.jpg`, 390x844. CSS viewports match these pixels at
DPR1; no density normalization. Library, night20:10, all layers, normal occlusion,
local view6x. Actor positions can vary because simulation is independent of
static lighting. These screenshots are local evidence and are not committed.

Reference/current full images and current focused/phone images were opened in
one comparison input. The approved real GIS architecture intentionally differs
from the generated campus. Existing layout, typography, spacing, icon assets
and content are retained; only lighting composite and cool map treatment change.

## Findings and iteration history

1. P2: initial hand-drawn field resembled painted yellow roads. Reduced constant
fill, bounded the light field to reviewed paving and retained falloff. User then
selected Pixi as the effect backend.
2. P2: first Pixi view was too weak; its diffuse field had the same soft mask
applied twice. Removed duplicate masking and adjusted bloom thresholds/explicit
alpha halos. Final full/focused captures retain pavement detail and restrained
warm windows rather than large white light disks.
3. P2: switching/resize exposed still-bound temporary textures. Released pooled
filter inputs after rendering and owned filter shaders on disposal, and detached
the shared FilterSystem group before renderer screen removal. Fresh browser
checks covering mode/day/night transitions returned no runtime errors. A later
reset to the native app viewport emitted a transient library pooled-texture
binding warning; the two GPU views continued rendering. This remains P3 lifetime
polish and is not certified warning-free across every resize.

No P0/P1 integration blocker was found in that pass. Reference fidelity remains P2. The reference's
true 3D material response, dense full-campus lighting and tree detail remain
source/asset limitations; this is not pixel-identical or physical-lighting QA.

## Required surfaces and interaction checks

- Typography/layout: existing font stack, sizes, hierarchy, panels, timeline and
phone sheet unchanged. Phone body390 and dock bottom832 fit viewport390x844.
- Colors/tokens: cool ambient treatment plus bounded warm ground/window layers;
original appearance remains independently selectable.
- Image fidelity: official map tiles and generated actor assets retained. No
school raster is read through WebGL, copied into a bundle or replaced.
- Copy/content: source/mock/field labels retained; lighting remains illustrative.
- Browser: two `pixi-webgl` canvases, actual
`AdvancedBloomFilter+BlurFilter`, tickers stopped. Pan/zoom GPU origin/scale
matched raster transforms, including independent local view. Original/enhanced
switch and morning/day zero lamps, evening GPU recreation and phone resizing
passed. The automatic GPU-failure fallback is implemented but was not force-tested.
- Tests: build and13 frontend tests passed. No database tests or mutations ran.
- Final screenshot metadata: ExifTool removal/recheck passed; orientation and
readability visually retained.

Lighting fidelity remains active work; surface normals/depth require additional
assets.

## Actor proportion correction — latest review

The user identified that people/vehicles were visibly oversized compared with
the concept. This was a missed visual acceptance item in the initial lighting
pass; working filters alone did not certify actor proportions.

1. **Reference/current capture, issue confirmed:** concept source remains
`docs/design/assets/campus-concept.png`. Fresh before captures:
`/tmp/campuspulse-actor-before.jpg` (1487x1058) and
`/tmp/campuspulse-actor-detail-before.jpg` (392x289 at1045,229). The full square
direction cells were stretched into13x22 for people, making the visible body
both oversized and unnaturally narrow. Moving vehicles used22x23 while parked
vehicles used7.5x8, giving inconsistent vehicle bodies.
2. **Correction, implemented:** new `actor-style.js` measures each local PNG
cell's alpha bounds once, preserves the visible aspect ratio and places the
frame's bottom at the existing route point. Registered illustration heights
are walk4.8, riding4.8 and parked3.6 reference pixels; these are not metres or
surveyed dimensions. The old .8–2.2 map-scale clamp is removed. Source images,
positions, paths, headings, motion, actor counts and occlusion rules are retained.
3. **Desktop/phone review, passed:** after captures:
`/tmp/campuspulse-actor-after.jpg`,1487x1058;
`/tmp/campuspulse-actor-detail-after.jpg`,392x289;
`/tmp/campuspulse-actor-mobile.jpg`,390x844. Source local crop
`/tmp/campuspulse-reference-local.png` is417x422. Reference and before/after
regions were opened together. Because the generated and actual campuses differ,
comparison uses people-to-door/floor/paving ratios rather than forcing equal
screen pixels or stretching differently sized crops.

At the checked desktop transform, person/riding draw height was6.29px overview
and13.00px local; parked height4.72/9.75px. Overview +25% zoom changed only its
person height to7.87px; independent local +25% zoom changed only its height to
16.26px. Phone heights were4.54/9.51px, with body width390 inside viewport390.
Both maps still reported28 actors and identical four parked slot signatures.
The visual judgement has roughly25% uncertainty due to the different buildings
and artistic camera; no physical-scale claim is made.

Build and17 frontend-only tests passed (alpha bounds, aspect/zoom consistency,
vehicle ratios, geometry/masks). No database tests or writes ran. Final captures
were stripped/rechecked with ExifTool before sharing. The earlier oversized
actor findings are resolved for this iteration; illustration density is unchanged.

---

## Archived earlier migration and handwritten experiment

# October 21 frontend migration — visual QA

> Follow-up status: the later uncommitted surface-mask lighting experiment is
> not yet visually accepted. The user requested library research instead of
> further hand tuning, and deferred write-to-database testing. The historical
> migration checks below remain evidence for the earlier implementation only.

Date: 2026-10-23. Scope: preserve the user-selected October 21 interface and
improve its illustrative night lighting. This is visual/read-only interaction
acceptance, not a certificate for browser writes, deployment or hardware.

## Visual truth and normalization

Primary source:
`local-reference/pre-hackathon/captures/gis-ui-spatial-20261021/desktop-night-final.jpg`
(1487x1058 pixels). Focus source: the same folder's
`implementation-detail.png` (470x900). Phone source: `mobile-night-final.jpg`
(390x844). Secondary light/art direction: `docs/design/assets/campus-concept.png`
(1487x1058); its generated architecture is intentionally not used as geography.

Current full view: `/tmp/campuspulse-enhanced-lighting.jpg` (1487x1058).
Original-effect comparison: `/tmp/campuspulse-original-lighting.jpg` (1487x1058).
Current focused region: `/tmp/campuspulse-lighting-detail.jpg` (470x900, browser
clip x=1017,y=70). Current phone: `/tmp/campuspulse-migrated-mobile.jpg` (390x844).
Fixed phone record dialog: `/tmp/campuspulse-mobile-records.jpg` (390x844).
Screenshots stay local; no school-raster screenshots are added to Git.

Desktop CSS viewport 1487x1058, phone 390x844, device scale factor 1. Pixel sizes
match CSS sizes; no density normalization was needed. The browser screenshot API
with an explicit clip was used, because the app panel's native screenshot showed
only a physically visible subsection after viewport emulation. State: library,
synthetic 20:10, night, all layers, local detail open at 6x, ordinary occlusion,
enhanced lighting. Actors are paused; exact actor positions differ from the old
capture because the simulation clock ran before pausing. Date labels now show
October 23, and source attribution now says official online tiles.

The source and current full-view images were opened together in one comparison
input, alongside the concept. Source/current focused detail and source/current
phone images were also opened together. An intermediate focused capture showed
the time-comparison view; it was rejected as a state mismatch. The final focused
capture was taken again with the local map visible at 6x before comparison.

## Findings and fix history

1. **P2, phone field-record dialog:** the inherited grid let its 540px intrinsic
   width exceed the viewport (observed x=-150..390 at width390). Fixed its width
   with `min(540px, calc(100vw - 36px))` and `min-width:0`. Post-fix browser bounds
   were x=18..372 (width354), y=29.54..814.45 on 390x844; screenshot and full phone
   comparison confirm the dialog fits. Its content remains vertically scrollable.
2. Local preview initially stalled after dependency replacement because Vite
   retained removed Lucide modules. Restarting the owned dev process restored
   the page. This was environment troubleshooting, not a design-QA iteration.

No actionable P0/P1/P2 visual findings remain for the bounded migration. The
photorealistic architecture, dense trees, full-campus lighting and true shadows
in the generated concept remain outside the fixed-raster implementation. These
are explicit source limitations, not a claim of pixel-identical reconstruction.

## Required fidelity surfaces

- **Typography:** original system/PingFang/Microsoft YaHei family, hierarchy,
  weight and sizing retained. Desktop heading, source labels and three metrics
  align with the October 21 baseline. Phone action labels remain readable.
- **Spacing/layout:** overview, wide local pane, bottom timeline and independent
  layer strip retained. Phone sheet/dock match the earlier composition. On phone,
  body width390 equals viewport390, dock bottom832 is inside height844 and sheet
  bottom708 leaves the dock available. Record dialog overflow was fixed above.
- **Colors/tokens:** original navy/day tokens, blue walkers and orange vehicles
  retained. Enhanced lighting produces stronger amber ground pools against a
  darker cool map; original effect remains selectable in both views.
- **Image quality:** original generated directional sprites and glow texture are
  reused; real architecture comes from the official online GIS tile extent.
  Registered building masks clip actors/ground glow and support transparency.
  Close-up sharpness and daylight shadows remain bounded by the source raster.
- **Copy/content:** mock/source notices, missing waits and non-individual-position
  boundaries retained. Added explicit field mode and independent record placement
  selection. No synthetic field counts or predicted waits are displayed.

## Browser acceptance

Observed in the in-app browser at desktop/phone:

- Official tiles loaded in both maps; actual visible tile extents are requested.
- Search 八号 and Enter select 八号教学楼 and update its detail/time comparison.
- Morning preset selects day appearance and both light canvases report zero lamps.
  Evening returns to night; manual and automatic theme buttons remain available.
- Electric-bike toggle removes riding and parked sprites while people remain20.
  Wait toggle removes all map wait labels without disabling other layers.
- Both maps receive xray=true and the selected building mask; toggling off restores
  ordinary opacity. Local keyboard zoom changed only the local raster transform.
- Detail close/reopen, time comparison and return to the local view work.
- Field mode reports actorCount=0 in both canvases, no synthetic wait labels,
  no synthetic metrics, and disabled replay. API read panel loads real local
  places/empty summaries independently of map landmark IDs.
- Phone record dialog opens/closes; simulation can be restored. Data-explanation
  Shift+Tab wraps to the final button and Escape closes it.
- Inspected final browser warning/error log: empty.

The local authenticated record POST was rejected by automatic approval review,
including a retry after checking loopback/local-only D1 and soft-cancel behavior.
No workaround was used. Browser submission/cancellation remains pending explicit
user reapproval; it is not claimed passed. The API/SQLite unit contracts passed
separately. The updated browser smoke is syntax checked, not executed here.

## Validation and follow-up

`npm run build` passed after migration; all 18 tests passed (9 API/SQLite and 9
geometry invariants). Generated PNG assets and final delivered JPEG screenshots
were checked with ExifTool; no identifying embedded metadata was found.

P3/future: registered depth/light masks or a licensed baked night render can
improve surface-specific illumination. A genuine Three.js scene needs registered
models/materials rather than a switch of UI library. See
[the rendering study](docs/design/frontend-lighting.md).

Prior handwritten-experiment result: blocked


final result: passed
