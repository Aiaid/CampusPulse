# GIS location settings and map navigation

Status: implemented locally, 2026-10-24. This change does not deploy the site,
change production registry records, or verify physical device locations.

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

Only verified positions inside the supported scene appear on the map. Missing,
unverified or outside-scene positions remain available in the record directory,
with their omission counted in the field UI. An API failure clears map markers
and shows an unavailable state; it does not substitute demo locations.

## Coordinate registration

The existing API contract uses the complete **24576 × 24576** official image,
normalized to `[0,1]` on each axis. The frontend scene displays the original
pixel rectangle `(10240,7168)`–`(18432,12288)` as **1024 × 640** scene units.
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

## Navigation boundary

The old camera clamp required the raster to cover the viewport continuously.
That prevented edge features from reaching the center and could disable an
entire pan axis at base zoom. `boundedMapView` now allows the camera center to
reach all four map corners, with at most half a viewport of blank margin per
axis. It remains bounded, and tiles are still requested only inside the existing
scene extent. This does not expand the supported raster region or download a
full campus snapshot.

## Verification and limits

- `npm run build`: TypeScript and production build passed.
- `npx vitest run tests/frontend`: 226 tests passed in 23 files, including
  coordinate conversion, crop boundaries, seed registration, field filtering
  and desktop/phone camera bounds.
- `node scripts/gis-location-browser-smoke.mjs`: Chromium UI regression uses
  in-memory API fixtures at a loopback development origin. It exercises map
  selection, explicit verification, pan without accidental repick, save payload,
  deep links, linked record IDs, focus refresh, demo isolation, unavailable API
  behavior, phone edits/removal and four-corner navigation at 1440×1000 and
  390×844. Desktop/phone fixture screenshots with loaded official tiles were
  inspected locally; they are not published artifacts.

The browser regression establishes frontend interaction and API payload behavior;
it does not establish a real D1 commit, cloud deployment, physical touch-device
acceptance, official tile uptime or coordinate verification in the field. No new
historical/vendor source or image asset is imported; the existing CampusMap
module is shared by both interfaces.
