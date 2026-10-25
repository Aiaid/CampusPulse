# GIS location settings and map navigation

Status: corrected and verified locally, 2026-10-25. This change does not deploy the site,
change production registry records, or verify physical device locations.

The October 24 crop-only navigation and development-server acceptance were
insufficient: the real Safari admin page blocked official tiles under its HTTP
CSP, and places beyond the authored crop could not be registered/displayed.
The corrections below supersede those navigation and verification claims.

## Editing and viewing a place

Open **管理 → 地点与部署**. The directory previews registered places on the
same official remote GIS tiles used by the public frontend. Edit a place and
click the map to select its position. Dragging pans without choosing another
point; the wheel and buttons zoom. Keyboard users can pan with arrows and press
Enter to choose the map center. Coordinate inputs remain available.

Picking or manually changing coordinates clears the verification checkbox.
Saving a GIS position requires the operator to confirm it matches the place.
Removing the GIS position saves `gis_anchor: null`; a place can also be created
without a position. The separate schematic `anchor` remains available under
the compatibility section and is never silently used as a GIS location.

The directory's **查看地图** link opens `/?place=<id>` in field mode. Field maps,
search and details read the same public `GET /api/v1/places` registry that backs
the record panel. Opening records from a mapped place selects its API ID. The
field directory refreshes every 30 seconds and on window focus. Demo mode keeps
its independently authored places and synthetic metrics; mode switching retains
each mode's selection. Field IDs never imply association with demo building
polygons, even when the IDs match.

Verified positions throughout the complete normalized image grid appear on the
map, including areas beyond the old scene crop. Missing, unverified or invalid
positions remain available in the record directory,
with their omission counted in the field UI. An API failure clears map markers
and shows an unavailable state; it does not substitute demo locations.

## Coordinate registration

The existing API contract uses the complete **24576 × 24576** official image,
normalized to `[0,1]` on each axis. The authored overlay reference rectangle
`(10240,7168)`–`(18432,12288)` remains **1024 × 640** scene units. It is no
longer a clipping boundary for map tiles or registered places. The complete
image grid occupies scene bounds `(-1280,-896)`–`(1792,2176)`.
`src/campus/place-registry.js` converts in both directions:

```text
scene.x = (gis.x × 24576 - 10240) / 8
scene.y = (gis.y × 24576 - 7168) / 8
gis.x   = (scene.x × 8 + 10240) / 24576
gis.y   = (scene.y × 8 + 7168) / 24576
```

The library seed `(15656,9059)` therefore projects to `(677,236.375)`.
It remains distinct from the authored demo label anchor `(15602,8970)`; no
database migration or seed correction is needed. These are image coordinates,
not latitude/longitude, sensor coverage or surveyed installation positions.
The school's public Nanhu shortcut `(5608,17140)` projects to
`(-579,1246.5)` and is now reachable in both the editor and public field map.

## Navigation boundary

The first implementation clipped the raster to the authored crop; the October
24 change only exposed blank margins around that crop. The corrected map
continues requesting actual official tiles as the camera crosses those former
edges. All four school levels are supported, including coarsest `zoom4`.
Viewport edges stay within the complete image grid; a viewport larger than the
grid on an axis is centered there. The grid boundary is not a surveyed campus
footprint or a guarantee that every remote tile contains buildings.

Tiles are requested only for the viewport plus overscan. The graded/masked
raster surface also tracks visible tile bounds, avoiding a full-grid bitmap or
an oversized high-zoom filter surface. Building transparency uses registered
vector mask paths; overlay locations retain their original scene coordinates.

## Admin HTTP policy

The deployed `/admin` and `/admin/*` policies previously allowed only same-origin
images and `data:` URLs. This blocked `https://gis.ccnu.edu.cn/mapdata/...` before
the browser could load the editor's background. Both policies now permit that
exact HTTPS image origin. Script, connect, frame, form and other restrictions
remain unchanged. The exception does not allow arbitrary external images or
cross-origin fetch requests.

## Verification and limits

- `npm run build`: TypeScript and production build passed.
- `npm test`: 476 tests passed in 46 files in the local working snapshot;
  this aggregate includes independently implemented firmware/API/lighting tests.
- `npx vitest run tests/frontend tests/admin-gis-csp.test.ts`: 276 tests passed
  in 29 files, including full-grid conversion, all four tile levels, preserved
  seed registration, field filtering, camera bounds and actual header rules.
- `node scripts/gis-location-browser-smoke.mjs`: Chromium UI regression uses
  in-memory API fixtures at a loopback development origin. It exercises map
  selection, explicit verification, pan without accidental repick, save payload,
  deep links, linked record IDs, focus refresh, demo isolation, unavailable API
  behavior, phone edits/removal, Nanhu coordinates beyond the former crop,
  real-grid edge clamps and the fourth tile level at 1440×1000 and 390×844.
  A browser pixel check verifies building transparency while other map regions
  stay opaque. CI uses synthetic tile images via `GIS_SMOKE_TILES=fixture`.
- `node scripts/admin-gis-csp-browser-smoke.mjs`: the built app is served with
  the actual `public/_headers` HTTP CSP on both admin routes. Synthetic tile/API
  fixtures verify that official-origin images load while an unrelated image
  origin and official-origin fetch remain blocked before network access.
  Both browser regressions are part of the CI workflow.
- Native Safari: reproduced the live admin dialog's tile-unavailable state,
  then opened a separate read-only local fixture with the corrected HTTP policy
  and real official remote tiles. The Nanhu editor displayed its actual campus
  background at the registered coordinates; its directory link opened the
  corresponding selected place in the public field map. The live draft was
  left untouched.

The browser regression establishes frontend interaction and API payload behavior;
it does not establish a real D1 commit, cloud deployment, physical touch-device
acceptance, official tile uptime or coordinate verification in the field. No new
historical/vendor source or image asset is imported; the existing CampusMap
module is shared by both interfaces.
