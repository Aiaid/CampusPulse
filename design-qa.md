# October 21 frontend migration — visual QA

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

final result: passed
