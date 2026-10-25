# Generated scene material provenance

Generated 2026-10-24 with the built-in imagegen tool for the user's requested
concept-fidelity work. These are illustrative environmental assets, not campus
captures, surveyed surfaces, or sources of actual vegetation/lighting information.

Generation and runtime inputs are distinct: the four generated assets below
still used no GIS imagery and their recorded bytes/hashes are unchanged. The
new runtime official-source relighting path described at the end of this note
does read bounded GIS pixels; it does not feed those pixels into imagegen or
turn them into a bundled generated asset.

- Project asset: `public/assets/library-tree-canopy-v1.png`,1254x1254 RGBA.
- Style input: the already selected `docs/design/assets/campus-concept.png`.
  The input is style guidance; no GIS tile or physical-campus photograph was
  submitted for generation.
- Original generated output remains in the tool's local output directory. The
  project copy was inspected with ExifTool, stripped of nonessential metadata,
  and rechecked. Final embedded EXIF/GPS/XMP/IPTC/MakerNotes/thumbnail/comment
  checks were empty; color/orientation and transparent leaf edges were inspected.
  Generated provenance metadata was present on the original; no private metadata
  values were logged. Filesystem timestamps are not embedded capture timestamps.
- Final project-copy SHA-256:
  `ff147b274ea7e6f0ce185da6693687ffb5dc05e4ff4a7f6eb2d3af7a60a3f4cb`.
- No new third-party model, texture package, implementation code or dependency
  was copied. Prior generated concept/actor provenance remains in `reuse.md`.

## Generation prompt

> Create a production GAME ENVIRONMENT SPRITE asset, a SINGLE mature broadleaf
> TREE CROWN viewed at a high isometric three-quarter camera about45 degrees
> from above. Transparent background. Botanical realism and intricate clustered
> individual leaves, sculpted three dimensional branching crown, irregular lobed
> edges, visible tiny gaps. Style matches the supplied reference campus nighttime
> architectural visualization: polished physically based game render, detailed
> elegant Chinese university landscaping. This is an isolated CROWN only, no
> ground, no planter, NO cast shadow, no trunk extending below crown. Use neutral
> soft diffuse lighting, deep natural rich green foliage with olive highlights
> and cool darker undersides; do not bake orange lamp light, blue rim light, or
> star-like sparkles. Crown roughly circular in projected silhouette, slightly
> taller than wide, centered, fills about85% of a square canvas, all edges intact
> with generous transparent padding. Rich leaf texture rather than smooth
> ellipsoid or stylized cartoon. ONE isolated crown, NOT sheet, no text, no UI,
> no border, no checkerboard pixels. Reference image is style guidance only; do
> not reproduce campus, buildings, vehicles or interface.

## Runtime use and limits

This foliage preparation reads only the same-origin generated asset to prepare a bounded
512px texture, alpha silhouette and restrained luminance-derived leaf relief.
Existing tree proxy normals and the shared light field shade its leaf color.
The current material uses the shared linear-RGB pipeline; generated RGB still
contains artistic texture/shading rather than recovered physical albedo.
The leaf normal detail is inferred from image luminance, not measured geometry.
Foliage preparation needs no per-frame pixel read or remote GIS canvas read;
the separate source-material loader described below now uses the latter.
Opaque leaf alpha
is shared with behind-tree actor clipping; failed loading retains the earlier
illustrative fallback. Light-ray transmission still uses porous tree volumes,
so individual leaf holes do not produce exact physical penumbrae.

## Matching lamp fixture asset

`public/assets/campus-lamp-v1.png` was generated with built-in imagegen on
2026-10-24, using the same concept as style guidance. The original's metadata
groups were inspected without logging their values; the public copy was stripped
and rechecked with ExifTool. Its transparent pole, lens and warm fringe were
visually inspected. Final SHA-256:
`d92d3b7e564e6cab72333462caa287e6fee22cdb5d9271c9c5da212507fc7abf`.

Generation prompt:

> A single production game environment prop sprite on a truly transparent
> background: one elegant small modern campus pedestrian street lamp, seen in a
> 45 degree elevated isometric view, matching a polished realistic nighttime
> Chinese university architectural visualization. Slim dark graphite vertical
> pole, compact subtly curved horizontal arm, small warm amber downward LED
> fixture with a clearly visible golden luminous lens. Physically believable
> metal, restrained tiny optical halo around lens only, neutral subtle moonlight
> on metal. Entire pole and small foot intact, centered on a square canvas with
> generous transparent padding. Lamp about5 meters in-world. Front right
> three-quarter view. ONE lamp only, no ground plane, no paving, no greenery,
> no cast ground shadow, no huge glowing pool, no text, no border, no checkerboard,
> no logos. Fixture lighting warm2700K. Style reference only; do not reproduce
> interface or campus scenery. Intended runtime placement is tiny, so keep clear
> clean silhouette and avoid fussy details.

It supplies appearance at existing illustrative anchors only; it does not add
sources, measured pole positions or real lamp-state claims. Runtime height uses
map units and shares the library emitter's height. Generated fixture perspective
is an illustrative approximation rather than a calibrated physical model.

## Authored facade material atlas

`public/assets/library-facade-material-v1.png` was newly generated with built-in
imagegen on 2026-10-24, using the selected concept as style guidance. The 1774x887
opaque bitmap has two 887px-square cells: neutral unlit glazing and a matching
warm library interior. No official GIS raster was submitted, copied or embedded.
Original metadata groups were inspected without logging values; the project
copy was stripped/rechecked with ExifTool and visually inspected. Final SHA-256:
`2f79f71779ed4cdb62b598a376b7c6ba9047798b361ee9c680f3be254b7f7bdb`.

Generation prompt:

> Create a production architectural game MATERIAL TEXTURE ATLAS, not a scene or
> mockup. Two perfectly aligned equal rectangular tiles side by side, a horizontal
> 2-column 1-row atlas, no separator, no outer margin, edge-to-edge textures. Flat
> front orthographic view, no perspective, no building silhouette, no text, no
> labels. BOTH tiles depict exactly the same single modern curtain-wall WINDOW
> PANEL with narrow graphite/satin-aluminum structural mullion border, subtle
> recessed glass edges, fine realistic surface and depth. LEFT HALF: unlit panel,
> neutral low-saturation slate-gray reflective architectural glass, subtle natural
> roughness and faint soft abstract reflection, no blue daylight cast, no sun,
> no strong baked lighting. RIGHT HALF: geometrically identical panel with a warm
> inviting softly lit library/office interior behind the glass, amber 2700K ceiling
> illumination, softly visible deep interior surfaces, restrained specular
> reflections; no people, no readable signs, no objects standing in front of glass.
> Refined realistic physically based game-render material style matches the
> supplied reference's architectural quality. Neutral glass tile should remain
> diffuse-albedo-like so runtime lighting can shade it; warm panel is the interior
> emissive alternative. No campus, no pavement, no trees, no sky, no free-standing
> lamp, no perspective building, no glow outside panel, no UI, no watermark.
> Exact TWO tiles only. Intended to be repeated within the actual registered
> library window grid at small resolution, so avoid huge borders or ornate
> detailing. Use full opaque background as a texture, not transparent.

This authored appearance is illustrative. It does not reconstruct surveyed
glazing, actual interiors or room-light state. Runtime preserves the registered
wall clipping, existing 279 pane polygons, 64 unlit flags and door/sill regions
outside the window band. Original GIS display remains available for comparison.

The current runtime always samples the neutral cell for glass reflectance.
The warm cell supplies additive interior emission rather than replacing that
reflectance. `building-material.js` computes mean linear-luminance normalization
and an interior mask that excludes the panel's metal border. The common
`surface-lighting.js` shader adds that emission after reflected raw irradiance,
then applies the same exposure/tone mapping used for paving, foliage and actors.
`room-lighting.js` and 19 cached facade-area patches share 37 bright, 83 ordinary,
95 dim and 64 unlit panes. This preserves the authored room state across camera
and replay changes; it does not describe actual interiors or occupancy.

## Authored paving material

`public/assets/library-paving-v1.png` was newly generated with built-in imagegen
on 2026-10-24. The final 1254x1254 RGB bitmap is an authored material, not a campus
capture. No GIS image was supplied to generation or copied into the asset.
The generation brief was neutral diffuse fine-aggregate gray concrete: one
square paver with narrow muted terracotta grout at all four edges, suitable for
seamless repetition. This is a brief summary, not a verbatim tool prompt.

The original generated output remains in the tool's local output directory.
Metadata was inspected, stripped from the project copy and rechecked with
ExifTool; the final copy was also visually verified. Embedded metadata checks
found no identifying EXIF/GPS/XMP/IPTC/MakerNotes/thumbnail/comment values to
retain. Orientation, color and grout readability were preserved. The checked
final file is opaque RGB, 1254px square. Final SHA-256:
`94a6d905a6ea211cb15f16039821dba6b9055442ebef7579e7c49ab88e608bfe`.

`paving-material.js` prepares the same-origin asset once and registers its UV
grid at map(600,270), basis(11,3.6)/(-5.5,7.5). Only the existing ground receivers
receive this albedo. Three planting islands in `ground-features.js` remain
excluded, with inward edge feathering; trees, roofs and the circular canopy
keep their registered receiver priority. The normal ground material uses the
common linear shader and bypasses old ground shade/tint/screen channels on
those pixels. Preparing this generated paving requires no GIS canvas read or
new runtime dependency; separate source-material processing now reads official
GIS as described below.

The paving is an illustrative local replacement, not a surveyed surface or
proof of concept fidelity. The 2026-10-24 common-material checkpoint passed its
build and 106 frontend tests / 12 suites. Independent pass6 review did not accept
fidelity: the ground-floor stripe remained dark and paving too even. Later
entry-band refinements are outside that test checkpoint. No database operations,
deployment or device validation are claimed by this asset record.

## Runtime continuation without new image generation (pass11, historical)

The pass11 renderer keeps all four generated assets and hashes above
unchanged. The common shader now accepts bounded dielectric GGX roughness:
foliage 0.5, paving 0.78 and glass 0.3; structural frames use 0.82 and actors 0.75.
Lighting direction is the field's model-world received-energy average across
direct, ground-bounce and facade sources. This is an averaged-lobe material
approximation, not new measured normals, environment reflection or recovered
physical albedo. Existing generated artistic texture/shading remains a limit.
Contact AO and responsive camera framing do not regenerate or relicense images.
See the [library experiment](../design/library-entry-lighting.md) for the 123-test
checkpoint, separately bounded timings, desktop/phone review and open fidelity gate.

## Separate runtime official-source relighting (pass13 historical)

The previous renderer-wide no-GIS-pixel-read limit is superseded for
`gis-material.js`. Its input is a minimal set of official zoom2 tiles requested
separately with anonymous CORS, not an imagegen reference or a historical school
snapshot. It assembles a 573x441 library ROI and makes one bounded canvas read.
Approximate linear-albedo normalization aims to retain source ribs/seams/colors for
the shared normal/light shader; it is not true recovered albedo and cannot
promise to remove all baked daylight information. Ordinary map images remain
unchanged. Source/processed pixels stay in browser memory; no new asset file,
image hash, bundled raster or application-persisted image output is introduced.

CORS approval is required for that pixel read; see
[MDN's cross-origin canvas guide](https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image).
Four material sources gate one shared ready-or-fallback compile. The current
checkpoint passed build and 133 frontend tests across 15 suites. In both actual
in-app browser views, GIS status/source material were ready at
revision `1:1:1:1`. Source pixels were roof 29778/canopy 5644/wall 7327; one shared
desktop compile measured 2261.2ms. This is not phone or per-frame performance.

The runtime wall-only `coolNeutralization: 0.6` adjustment partially reduces
eligible baked cyan/blue casts, preserving linear luminance/detail contrast
and guarding warm, green and near-black features. Roof/canopy profiles and all
four generated assets/hashes remain unchanged. This is approximate source-cast
processing, not a new generated image or physical reflectance recovery.

With cache disabled and zoom2 requests blocked, both GIS sources reached
fallback/source-ready false and `gis-wash-fallback`; generated materials remained
ready and ordinary zoom3 tiles loaded. Settings were restored in `finally`,
then reload reconfirmed ready. This verifies controlled request-failure recovery,
not every CORS failure. Metadata-cleaned/viewed pass13 desktop/detail captures
record the current source-cast profile; pass12 predates that adjustment. The
earlier 123-test pass11 record stays historical. Phone/mode and fidelity checks
were pending at pass13; subsequent checks are recorded below. No database operations, deployment
or fidelity acceptance are asserted.

## Discrete canopy fixtures and sky calibration (pass15 historical; no new bitmap)

The three new canopy downlights are procedural common-material casings and tiny
emissive lenses in cached `buildingFixtureMaterial`, not a new generated texture.
They sit on the retained front arc at 30/90/150 degrees, height 7.1 below the 7.5
roof, with power 1.2/radius 26 and a downward cone full to 58 degrees/zero at 68.
Direct and bounce reception use the same cone, adding no new light to the
canopy top. The street-pole asset list excludes these three building fixtures;
xray fades their building channel. No ring, halo, source snapshot or new material
asset file/hash is introduced. The four generated-asset records above remain valid.

The selected local A/B uses `SCENE_SKY_STRENGTH=0.65`, exposure 1.6 and library-only
raster diagonal .34/.38/.43, gamma 1.13, with pass14 lamp/room powers unchanged.
Pass15 was selected over 14 for warmer entry/window/paving hierarchy with visible
roof ribs, foliage and blue activity marks, not overall concept-fidelity acceptance.
Final build and 139 frontend tests/16 suites passed at 03:25:44 after sky 0.65;
script syntax/diff checks passed. Pass14 phone/mode captures were metadata-
checked/viewed with 390x844/no overflow, all four sources/three fixtures ready,
official tiles loaded and original/day/field separation checked. Final pass15
mobile and `paired-pass15.png` were metadata-cleared/viewed; 390x844 had
scroll/client 390/390, both GIS sources ready, three fixtures and official tiles
loaded. Review found no layout/geometry regression and judged experimental
night cohesion acceptable. Full style work remains incomplete, with P1 actor
readability for human poses at default desktop-detail/phone scales. These renderer changes do not
regenerate, alter the provenance of or relicense the existing images. No
database operations, deployment or hardware-performance claim is added.

## Detail actor readability (pass16; retained source RGBA)

No generated image was edited or added. Existing actor PNG bytes/source RGBA
buffers and alpha remain intact. A walk-only runtime albedo profile lifts green
on eligible bright blue pixels by at most 42, capped at 0.58B; 0/66/244 becomes
0/108/244 before the same shared shader. It retains dark seams/warm/white detail
and adds no actor emission floor, glow, private exposure or post-filter. Vehicles
keep their source palette. This changes optional displayed albedo, not the
recorded generation inputs, image hashes or lighting observations.

The 4.8-map-unit person proxy is unchanged. Optional detail/demo/night/library ROI
presentation additionally requires `selectedId === 'library'`. That
presentation uses 16px desktop/13px phone targets with feathering/cap 2 and never
shrinks larger physical/high-zoom art; overview dimensions remain unchanged.
All three actor types share the same presentation factor/ratios. Foot/tyre
anchors, 47+5+4 actors, routes, headings and shared clock remain; cast shadows
use physical dimensions and contacts follow visual footprints.

Final build and 148 frontend tests/16 suites passed at 03:57:21 after the selected-
library scope guard; pass16 desktop/detail/mobile
captures were metadata-cleaned/viewed. Independent static review resolved P1
readability and accepted the bounded trial's style/cohesion in the inspected
default frame, without oversize/clipping/overlap regression. Final independent
review of `paired-pass16.png`, motion A/B, parking-pan and xray also found no P1
preventing bounded local trial acceptance. These metadata-cleaned/viewed frames
are representative, not proof for every possible motion pose.

Runtime checks observed 86.328 seconds/2084 frames in both views with matching
scene clock 125.776, stable 56 actors and an identical four-slot parked signature.
Pan/zoom raster registration, enhanced/original/day defaults, field-zero actors/
contacts/readable, layer toggles, search and the selected-library-only guard were
checked. An other-place reload showed `teaching-8` physical=display/readable 0;
library return restored 16px/readable 27. Thus the palette/presentation changes
remain scoped; they do not edit original images or alter their provenance.
Full-campus extension remains separate. No device/performance validation,
database work, deployment, commit or new asset license is claimed.
