# Campus material and lighting extension

Updated: 2026-10-24. Status: locally built, tested and browser-verified; no deployment.

## Scope and evidence boundary

`校园光照` is the default appearance. It extends the accepted library trial to
the full visible 1024×640 map and all eight selectable places. The original GIS
architecture, roof details, paths and labels remain. Heights, normal planes,
vegetation proxies, lamp positions and all activity are illustrative, manually
registered chart data, not surveyed geometry or observed campus illumination.
The map has a common 2.5D chart, not a reconstructed 3D model.

The source-only chart contains103 visible roof planes,29 retained wall planes,
44 ground masks,309 crowns in36 vegetation zones and94 point sources outside
the accepted library ROI, plus77 pane-derived area emitters. The library keeps its separate calibrated surfaces,
trees and sources. Unmodeled pixels retain the existing raster/fallback lighting;
full-campus coverage does not mean that every facade or tree has been measured.

## Shared rendering

- `campus-scene-data.js` holds portable geometry, lights, eight detail frames and
  ten added synthetic routes for the five places previously without routes.
- `campus-scene-lighting.js` compiles a32-unit spatial index. Surface/actor
  queries use local cells; visibility tests visit only intersected cells. Roofs,
  true-plane walls, foliage and grounds receive the same scene-linear material
  response, point-source occlusion, bounded ground bounce and window emission.
  Registered building silhouettes exclude ground overlays where geometry is
  incomplete. The accepted library ROI delegates to the original field.
- `CampusLightingLayer.jsx` compiles128-unit world chunks asynchronously, two
  jobs at a time, yielding after row batches. The two maps share one cache.
  Overview density1 and detail density2 replace the same stable chunk key.
  Eight source-map units of halo exceed the normalization kernel radius,
  preventing artificial normalization borders between neighboring chunks.
- The chunk cache and anonymous source-image cache are bounded to64 entries
  each. The whole chart has40 keys. Previous successful material remains visible
  while upgrading or recovering from a failed request; unknown/failed pixels
  remain transparent over the graded GIS. The older broad screen glow is disabled
  in campus mode because it can wash over native canopies outside the proxy set. Compilation is demand driven,
  without a continuous material animation loop.
- Source textures load anonymously from the official online GIS with CORS.
  Processing is in memory only; no school raster snapshot is bundled. The
  existing generated tree, fixture, paving and window assets are reused.
- Buildings composite above actors. Grounds and trees composite beneath actors;
  per-actor affine crown alpha masks preserve painter depth without a map-wide
  per-frame pixel read. Contact/cast shadows use the same light sample. Cast
  geometry retains physical actor dimensions even when detail symbols enlarge.
- Fixtures use the same campus source coordinates/heights. Ceiling downlights
  retain their accepted local material and never gain a ground-standing pole.

## Native GIS canopy correction

User feedback exposed a coverage error: the309 modeled crowns did not mask all
native raster trees, and the legacy broad warm overlay still painted across
them. Campus mode now disables that duplicate overlay. Runtime source foliage
is retained as an opaque, normally composited tree material over ground light.
A bounded source classifier uses green/olive texture and reviewed vegetation-zone
priors for pink/gray crowns; building, grass, water and sports exclusions remain.
This is conservative raster inference, not complete semantic segmentation.

Native crown tops use an11-unit elevation proxy above7-unit path fixtures and
strict top-facing Lambertian reception. They reject direct light from below;
the underside wrap used by modeled ellipsoids would create false yellow blobs
on this flat top proxy. Their cached alpha also clips behind actors, fixtures
and all ground shadows with painter depth. Foreground actors remain intact.
Uncertain or excluded crown pixels can still need manual registration.

## Activity and comparison

All lighting comparisons and daytime share the extended route set, stable actor
IDs, old-route phases and fixed parking anchors. Changing lighting does not add
or remove activity. Actor demand is bounded at200; the current chart's peak
allocation fits below that cap. Independent people/bike/wait controls remain.
Readable detail symbols now apply to every selected place in campus mode; the
older entrance experiment retains its selected-library scope.

`现场观察` displays no synthetic actors, parking or waits. Illustrative night
materials remain explicitly separated from field data. No database write,
backend acceptance, hardware validation, deployment or commit is implied here.

## Validation

`npm run build` and190 frontend tests/21 suites passed. All eight selectable
places were searched and framed in the actual browser; each displayed activity.
At20:10 both maps held90 actors (74 walks,12 rides and4 parked vehicles);
original/day comparisons preserved the same demand and parking anchors. People
and bike toggles remained independent, and field mode had0 actors/contacts.
Desktop1487×1058 and phone390×844 had equal client/scroll dimensions.
Representative loaded views showed0 failed chunks,30/30 overview plus4/4 local
chunks, later20/20 plus6/6 at the eastern teaching building. Shared residency
was34 chunks and64 source images. Material rendering stopped when idle.
Measured grid maxima were8 surfaces,9 trees,8 lights and22 facade patches per
cell, versus176/309/94/77 total respectively. These are local browser and
synthetic-test observations, not production-device performance guarantees.

The data, field and cache tests cover all-place frames/routes, roof clearance,
normal/receiver priority, spatial query bounds, porous tree blocking, direct-only
cast metadata, ground bounce, pane emission, cache sharing/bounds, atomic density
upgrades, source failure cooldown and normalization halos. Browser acceptance
records in `design-qa.md` distinguish this extension from the earlier library
trial. Capture files stay ignored local evidence.
