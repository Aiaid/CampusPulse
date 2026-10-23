# October 21 frontend migration and night lighting

Status: implemented locally on 2026-10-23. Visual/read-only browser acceptance
passed; authenticated record-write browser acceptance remains pending approval.
This note does not certify deployment, hardware, radio accuracy or measured
campus activity. [Reuse provenance](../notes/reuse.md) records the selected prior
code and assets; [the QA report](../../design-qa.md) records current evidence.

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

The enhanced treatment uses a slightly darker, more saturated cool base,
stronger elongated amber pavement pools, a broad entrance wash at existing
stronger lamp anchors and brighter warm window cores with restrained halos.
Ground illumination is subtracted from each building silhouette independently,
so overlapping polygons cannot accidentally reopen a roof to ground light.
Facade lights remain clipped to their source building and fade with xray.
No lamp positions, actual lighting states or building interiors are inferred.
The light layer invalidates for view/theme/settings/asset changes rather than
running a continuous render loop.

Compared with the retained concept, this improves warm/cool separation and
visible pavement illumination while preserving real campus architecture. It
still has the detail and fixed camera of a daytime GIS raster: the original
shadows are baked into that picture. It cannot reproduce the concept's full
three-dimensional indirect lighting, tree detail or physically correct shadows.

## Rendering choice

| Approach | Fit for this implementation | Remaining work |
| --- | --- | --- |
| React + Canvas 2D + CSS | Implemented; retains existing GIS registration, masks and all interactions | Better reviewed light/depth masks and additional artistic coverage |
| PixiJS | Candidate if sprite/filter rendering becomes a measured bottleneck | Port render layers; does not supply absent building geometry |
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

## Current verification

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
