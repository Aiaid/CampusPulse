# Map scene — current visual QA

Updated: 2026-10-24. Scope: full visible-campus 2.5D material extension, accepted library profile and
retained PixiJS8/pixi-filters6 fallback, preserving official map and interactions. Database-write verification
is excluded at the user's request. Historical checks are archived below.

## Full-campus integration — 2026-10-24

User feedback caught unmodeled native crowns under broad ground light. The
correction removes the duplicate warm overlay, retains native source crown alpha
above ground, clips actor/fixture/shadow depth, and places crown tops above path
fixtures with strict incidence. An initial5.5-unit canopy test was rejected on
visual review because it created yellow blobs; final11-unit tops reject light
from below. Final desktop source layers were30/30 and4/4 ready,0 jobs pending,
with147384/39578 native canopy pixels retained; the plaza then had218545/123451,
and phone187112/137258 native pixels across fully ready12/12 and6/6 chunks.
Phone remained390px wide with90 moving actors and unchanged parking. Final
images canopy-depth-final/plaza-canopy-final/mobile-canopy-final were stripped
and rechecked for embedded metadata. Reviewed final overview shows
road/plaza crowns above the light without the previous yellow washes. This is
representative acceptance, not a claim of complete native-tree segmentation.

The accepted library field is now retained inside its ROI while a data-driven
campus field covers all eight places and the visible map. Authored proxies:
103 roofs,29 walls,44 grounds,309 crowns,94 point sources and77 window patches.
Unknown surfaces keep the raster/fallback; this is approximate fixed-view
illustration, not a survey, physical light measurement or full reconstructed3D.

| Requirement | Current evidence | Result |
| --- | --- | --- |
| Campus coverage and framing | All8 actual places searched/framed; each shows activity; outer housing roof chart and36 reviewed vegetation zones; tests reject roof-crossing new routes | Passed within authored chart |
| Shared materials and field | Runtime official CORS texture, indexed normal/light/occlusion/ground/window response and common actor sample; source imagery stays online | Passed |
| Browser material readiness |30/30 overview and4/4 library chunks ready, later20/20 and6/6 at teaching9;0 failed;34 shared chunks/64 images resident | Passed representative views |
| Bounded work |40 world keys,64-entry caches,2 cooperative jobs; grid maxima8 surfaces/9 crowns/8 lights/22 facade patches; on-demand material frames | Passed local checks |
| Activity and comparisons |90 actors at20:10,74 walks/12 rides/4 parked; original/day retain count/parking, legacy display returns physical size | Passed |
| Field and layers |Field mode0 actors/contacts; people off retains12 rides+4 parked, bikes off retains74 walks | Passed |
| Desktop/phone layout |1487×1058 and390×844 client equals scroll dimensions; reviewed library/eastern building and phone views | Passed |
| Source fallback |Pure scheduler tests cover stale retention, density upgrades, bounded eviction and failure cooldown; previous library browser CORS fault remains historical | Unit verified; campus network fault not injected |
| Build/test |npm run build and190 frontend tests/21 suites passed; no database tests or writes by this task | Passed |

Local images are under ignored captures/campus-lighting-20261024. Final images
are metadata-stripped and rechecked before sharing. First source/material
compilation is cooperative CPU work; measured aggregate chunk compile time is
not a frame-time or mobile-device guarantee. The local settings API was
unavailable during frontend-only checks; the explicit fallback field mode was
manually switched to demo. A parallel admin task owns that settings workflow.
No deployment or commit was performed for this lighting extension.

## Final library-entry acceptance — pass16, 2026-10-24

The requested bounded trial is accepted: keep the actual GIS library and its
interface, unify building/ground/tree/actor reception and approach the selected
night concept's local style. `paired-pass16.png` places reference/current full
views and entrance crops in the same comparison. Current full input1487x1058,
detail394x355 and phone390x844 are metadata-stripped/rechecked, viewed and
independently reviewed. Real architecture differs intentionally from the
generated concept. Whole-campus parity is a separate roadmap direction.

| Requirement | Current authoritative evidence | Result |
| --- | --- | --- |
| Shared surface lighting | One cached atlas, registered normals,13 sources,4 ready material inputs; runtime GIS roof/door details replace old washes | Passed |
| Warm night style and readable activity | Paired pass16 plus desktop/mobile independent review; human poses readable at16/13px without glow or altered source alpha | Passed for this local trial |
| Route, scale and parking continuity |148 frontend tests;86.328s/2084 advancing render frames in both maps with equal scene clock,56 actors and unchanged four parking anchors | Passed for representative runtime window |
| Zoom/pan and occlusion | Panned/zoomed parking capture, matching raster/atlas matrices, ordinary motion A/B and xray screenshot | Passed |
| Comparison/day/field boundaries | Enhanced/original/day restore physical presentation/readable0; field mode actors/contacts/readable all0 | Passed |
| Existing controls | Independent people/bike/wait toggles, search and return to library verified in-app | Passed |
| Scoped readable display | Selected-library detail only; fresh reload and teaching8 search restore exact physical display/readable0 | Passed |
| Phone fit and ready assets |390px client/scroll width, loaded official tiles, ready materials and readable13px figures | Passed |
| Source failure and privacy | Prior CORS fault/recovery verified; no raster bundled; final generated hashes unchanged and embedded metadata rechecked | Passed |
| Build and code checks | Final post-guard build and148 frontend tests/16 suites passed at03:57:21; portable smoke syntax and diff whitespace checked | Passed |

The last P1 was resolved by bounded, ROI-feathered cartographic display sizing,
not by changing world paths or source height. Overview, other selected buildings,
day and legacy comparisons keep their prior world presentation. A walk-only
bounded green lift precedes the same common shader, retaining warm/shadow
differences. Physical cast shadows and exact foot/tyre anchors remain; contacts
follow the visible footprint. Independent review found no blocking P1 in default,
phone, motion A/B, parked near-view or xray representative frames. Tight groups
remain distinguishable. This is not an exhaustive proof of every possible pose.

Final local evidence under `captures/library-material-20261024/`:
`pass16-desktop.png`, `pass16-detail.png`, `pass16-mobile.png`,
`paired-pass16.png`, `pass16-motion-a.png`, `pass16-motion-b.png`,
`pass16-parking.png` and `pass16-xray.png`. The portable headless smoke was
extended and syntax checked, not rerun directly; the current browser checks
used the in-app browser. Database writes/tests, deployment, physical-phone
performance and whole-campus fidelity are not claimed.

## Common linear materials — historical iterations

Latest pass15: `pass15-desktop.png`, `pass15-detail.png`, `pass15-mobile.png`,
`paired-pass15.png` and the matched `paired-sky14-15.png` A/B are under
`captures/library-material-20261024/`. All final PNGs were metadata stripped,
rechecked and viewed. Build and139 frontend tests/16 suites passed after the
final sky calibration; the portable smoke script was extended and syntax checked,
not rerun through direct headless Playwright. No DB/deploy operations ran.

The final rendering split was removed: separately anonymous-loaded official
zoom2 tiles provide runtime-only source detail for29778 roof/5644 canopy/7327
wall pixels in the573x441 ROI. Bounded low-frequency linear reflectance
normalization and wall-only cool-cast reduction preserve ribs, seams and color
differences; they do not recover true albedo. These pixels now use the common
normal/light/shader and replace legacy washes. Both views report source-ready
and share one cache. Blocking zoom2 with browser cache disabled produced GIS
fallback while ordinary zoom3 images and authored materials remained available;
network settings were restored in finally and reload recovered source-ready.

Three discrete downlights follow the existing canopy's visible front arc below
its roof, with smooth downward cones shared by ground, foliage, actors and bounce.
Tiny cached casings/lenses replace street-pole duplication; no ring or halo is
drawn. Total13 sources/9 receivers/8 trees. Xray includes the new building fixture
material; original/day remove local layers, field mode shows0 actors/contacts.
Phone390x844 has matching DOM/scroll width, all official tiles loaded and both
source materials plus3 downlights ready. Captures were inspected.

Selected A/B: sky strength.65, scene exposure1.6 and lamp/room energy unchanged;
the library raster's unlit context uses corresponding .34/.38/.43 main channels.
Independent review prefers pass15 over14: warmer entry/window/paving hierarchy,
retained roof/foliage/actor detail, no black grove. Final cached atlas compile was
2332.1ms on this desktop, not per-frame or physical-phone timing.

Completion audit still finds P1 actor readability: people near the canopy's left
forecourt/lower-left path are fine blue lines at desktop default size and near
dots on phone, unlike the reference's clear human poses. Overall night cohesion
is acceptable as an experiment; full requested visual fidelity remains open.
Next calibrate presentation size/material readability, preserving paths/counts
and field truth. Alpha-bound analysis rules out broad transparent padding:
person frame heights at alpha32 are571/571/557/555 versus569/569/555/553 at220.
This is a display/readability issue, not a reason to add further density.
Runtime person heights are10.452px in the1487x1058 detail and6.708px in the
390x844 detail. Opaque sprite median RGB is0/66/244: blue is already strong,
while low green limits perceived brightness. Preserve original/day materials
when evaluating a more readable library presentation. Motion was restored after
captures; viewport emulation and temporary comparison tabs were cleared.

Latest pass11: `pass11-desktop.png`, `pass11-detail.png`, `pass11-mobile.png`
and `paired-pass11.png` under `captures/library-material-20261024/`. Reference
and current full inputs are1487x1058/DPR1/night20:10; current detail is394x355
with bounds framing rather than the former6x crop. All final PNGs were stripped,
rechecked with ExifTool and visually inspected. Build and123 frontend tests in14
suites passed. No database operations or deployment were run.

The roof/facade/entry now fit together; the desktop image gains64px height while
the same three metric rows remain. Compact selected badges and removal of
redundant local waits prevent facade obstruction; overview labels/layers remain.
Campus background uses the previous atmospheric matrix instead of crushing the
whole GIS. Shared bounded dielectric response and independent actor contact AO
improve reception/grounding. Preserved-door reflection alpha is.38 (was.72),
keeping over60% of underlying local contrast; existing canopy-entry light is
power1.8/radius26. Current desktop atlas compile2203.4ms is cached between views.

20:10 now has47 walkers/5 riders/4 parked; the full replay-minute/layer audit
peaked at57/72, so parking is not truncated. Existing actors' IDs/phases/poses
remain. Inspected desktop local frame had27 visible actors,26 contacts and25
direct casts. New contacts remain independent of hard-source shadows. In-app
search, local zoom/pan registration, original/day restoration, xray and field
zero actors/contacts were checked. Phone390x844 has matching DOM/scroll width,
ready materials and all requested official tiles loaded; entrance strip uses
its responsive framing. Static screenshots do not prove every moving pose.

Independent pass11 review: substantial compositional improvement, lighter-base
correction retained, no new obvious static crowd overlap or phone clipping.
Phone deliberately prioritizes the entry over the upper roof. P1 remains the
warm-night visual hierarchy: the large gray-blue building still dominates more
than warm sources, nearby foliage and actors do in the concept. More brightness
or people alone will not satisfy that gate. Goal stays active, fidelity open.

Latest pass7: `pass7-desktop.png`, `pass7-detail.png`, `pass7-mobile.png` and
`paired-pass7.png` in `captures/library-material-20261024/`. Metadata was
stripped/rechecked and final files viewed. Build and107 frontend tests/12 suites
passed. Both maps share ready materials and4867 preserved-door reflection pixels;
cached atlas compile2127.9ms on this desktop. Phone width390 equals scroll width,
with all official tiles loaded. New reflection uses the same shader/irradiance,
ambient0 and bounded.72screen reception on real doors/sills; source detail stays
visible. Existing3 west-door fixtures keep their positions/heights and have
stronger near power/shorter radii. Canopy top remains cool and unlit by low lamps.

Independent pass7 review: the dark base is improved but now somewhat flat/pale;
paving falloff is slightly clearer. No severe clipping or erased structure was
observed. P1 remains the readable entrance-light hierarchy and related tree/actor
reception. The material foundation is implemented; visual matching still has a
clear gap. The goal remains active and final fidelity result remains blocked.

Reference: `docs/design/assets/campus-concept.png`. Actual implementation:
`captures/library-material-20261024/pass6-desktop.png` and `pass6-detail.png`;
`paired-pass6.png` puts the full views and entrance details in the same input.
Scene inputs are1487x1058/DPR1/night20:10/library6x. Real GIS architecture is
intentionally retained. Final PNG metadata was stripped/rechecked with ExifTool.

The common material pass replaces independently tuned sRGB responses with shared
linear albedo, raw direct/bounce/facade irradiance, exposure and tone mapping for
authored walls, paving, foliage and cached actor pixels. Interior emission is
additive and normalized independently of reflective glass. Three planting-island
masks keep the new paving off existing beds. Ready material assets and all
official tiles were observed in both views. One cached atlas compile measured
2221.6ms on this desktop; this is not physical-phone timing.

Build and106 frontend tests/12 suites passed at this checkpoint. In-app browser
checks verified original-mode removal of the local layer, original actor colors,
day-mode removal and day actor materials, and field-mode zero synthetic actors.
Xray screenshots show faded building channels with ground/foliage retained.
Local zoom/pan changed only its transform; overlay and raster registration agreed
within CSS matrix serialization precision. Phone390x844 has DOM width390 with
all assets/tiles ready; `pass6-mobile.png` was inspected. The portable smoke
script was extended for paving/common-pipeline readiness and syntax checked;
it was not rerun through direct headless Playwright during this checkpoint.

Independent visual review finds a substantial improvement in readable interior
light and complete paving reception, but does not accept concept fidelity yet.
P1: the real door/sill band remains dark beneath bright upper windows. P1: broad
uniform forecourt light needs a stronger entrance-to-periphery falloff. Preserve
the real door details and cool canopy top while fixing these. Typography, UI
layout, controls and synthetic/field copy remain unchanged. Historical Vite HMR
errors predate the complete reload; no newer uncaught render error was observed.
No database operations, deployment or physical-device acceptance ran.

## Foliage and fixture checkpoint — 2026-10-24 (historical)

Latest comparison: `captures/library-fidelity-20261023/final-comparison.jpg`,
including full-view and focused entrance images in the same comparison.
Accepted current screenshots are `final-desktop.jpg`, `final-detail.jpg` and
`final-mobile.png` in that folder. The mobile image is390x844; an IAB/native
screenshot scale mismatch produced rejected miniature/cropped captures first.
Those are not acceptance evidence. Explicit CSS viewport clipping through the
same in-app browser produced the inspected final PNG. Metadata was removed and
rechecked on all accepted files and both generated project assets.

Pass5 review correctly rejected the bright equal-window grid, flat ochre paving,
unreadable actors and insufficient tree warmth as visual completion. Subsequent
changes use25 bright/70 ordinary/120 dim/64 unlit room panes, source-facing actor
reflection, source-powered single ground bounce and thin-leaf response. Two low
illustrative fixtures on the retained west approach illuminate the front grove;
narrower doorway radii focus the entry. Soft inward receiver feathering removes
the initially hard rectangular path-light boundary. Ground-bounce and actor
shadow metadata remain separate; only direct lamps determine cast shadows.

Latest build and75 frontend tests passed. Current browser evidence reports
9 local receivers,8 textured crowns, ready fixture assets and shared10-source
library illumination; global baseline has13 authored paving receivers/57 new
lights and32 wall planes/14 building groups. Final local atlas compilation was
1289.4ms on the inspected desktop; this is not physical-phone timing. Phone DOM
width390 equals its viewport, both tree/fixture assets are ready, and the final
render was inspected. Earlier in-app checks also covered original/enhanced
comparison, day/field isolation and fine-LOD selection. Historical HMR errors
from temporarily incomplete concurrent modules remain in the log; no later
uncaught render error was observed after the complete reload.

Required fidelity surfaces: typography and accepted UI layout remain unchanged;
phone labels/controls fit. Warm/cool separation, foliage detail, room contrast
and light attachment improved. Asset alpha, scale, clipping and metadata were
checked. Copy continues to distinguish synthetic activity/illustrative lighting
from field observations. Architecture/camera differences from the generated
concept are intentional. P1 visual gap remains in source material/ambient depth:
the official day raster still determines much of the architectural response.
The goal is active and the fidelity result stays blocked; passing runtime checks
and bounded approximations do not prove the requested overall effect achieved.

### Earlier comparison history

The goal is now the selected concept's lighting/material quality, beyond the
earlier functional prototype. Current side-by-side evidence is
`captures/library-fidelity-20261023/comparison-pass3.jpg`; both source and current
scene images in that comparison are1487x1058 at20:10/DPR1. Actual GIS architecture
is intentionally retained. The normal browser screenshot used for the combined
comparison is JPEG; viewport scaling in the comparison is equal for both inputs.

Actionable P1 gaps remain: insufficient campus-wide warm corridor/window coverage
and incomplete environmental density compared with the reference. P2 material
issues from the first pass (whole-glass yellow wash and smooth oval tree patches)
were reduced by lower material exposure, texture-preserving foliage, and more
readable cool tree ambience. Local detail now requests official zoom2 tiles;
closer views request zoom1, with persistent standard-resolution fallback.
Do not interpret the previous checkpoint's passing functional checks as visual
acceptance of this broader goal. The next pass extends reviewed paving/facades
and repeats the matched comparison. This QA gate is still open.

## Library-entry shared normals — prior checkpoint

Implemented local 2.5D normals/heights, 8 surface receivers, 8 tree volumes and
8 shared illustrative fixtures. The default **入口实验** can be compared with
the retained enhanced/original modes in scene settings. See
[geometry, renderer, verification and limits](docs/design/library-entry-lighting.md).

Final local evidence is `captures/library-lighting-20261023/final-desktop.png`,
`final-detail.png`, `final-previous.png`, `final-detail-previous.png`,
`final-mobile.png` and `final-mobile-settings.png` (ignored, metadata checked).
Desktop1487x1058/DPR1 and phone390x844/DPR1 were checked. Comparison images use
paused actors and matching cameras. Initial images taken before remote tiles
finished loading were rejected; the final desktop had46/46 tile elements loaded.

Review corrected two defects: ground reception above actors was bypassing their
normal materials; it now sits below them. Projected fixture height could reverse
an actor's shadow; ground direction is now separate from elevation and has an
actual-fixture regression. Regular tree tint boundaries were softened with
stable irregular insets, shared with actor masks. Ground, wall and tree response
now varies with the common light field; original raster detail is retained.

Build,48 frontend tests and the frontend-only browser regression passed. No
uncaught browser errors; inherited Pixi teardown binding warnings remain.
Physical phone speed, full campus coverage and reference-image parity are not
claimed. The original baked day shadows and approximate crown registration are
still visible limits; this is an experiment for user comparison.

## Wall registration and night grade — prior checkpoint

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
