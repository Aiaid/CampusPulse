# Lighting performance / 光照性能

Local implementation, updated 2026-10-25. These measurements concern the
illustrative frontend renderer, not sensor data or surveyed light behavior.
Production deployment and Safari device acceptance are separate.

The default is now the lower-resolution **轻量** lighting profile. The first
comparison below records the earlier full-quality optimization checkpoint;
the quality profiles and their separate comparison are described afterward.

## Measured comparison

Visible Chromium 156, Apple M1 Pro through ANGLE Metal, 1920×1080 CSS pixels,
DPR 2. The baseline is the frontend at `c0bd3f6`, extracted without a Git
worktree. Both versions use production Vite builds and the same browser-local
read-only demo settings. Official GIS tiles are first warmed, then identical
bytes are held only in the benchmark process for both measured runs. PNG
materials, light sources, shadow geometry and presentation resolution remain.

| Measurement | Baseline | Optimized |
| --- | ---: | ---: |
| Both maps' library/campus material ready | 19,926 ms | 6,675 ms |
| Longest observed main-thread task during startup | 2,126 ms | 139 ms |
| Sum of startup long-task time beyond 50 ms/task | 3,713 ms | 176 ms |
| DOM canvas backing-store RGBA capacity | 374.8 MiB | 157.2 MiB |
| Overview/local actor redraw rate in a 3-second sample | 25.6 / 25.6 fps | 25.3 / 25.3 fps |
| Twelve alternating local-pan inputs, including deliberate waits | 1,024 ms | 1,056 ms |
| Browser page errors | 0 | 0 |

This is one matched local laboratory comparison, not a real-user percentile.
Readiness is about 3× faster; the measured DOM canvas capacity falls 58%.
Canvas capacity is width×height×4, not total process memory: decoded textures,
worker arrays, detached canvases and GPU copies are not counted. The pan result
includes twelve 80 ms waits and is not a per-input latency measurement. No
animation-speed improvement is claimed from these near-equal frame rates.

The baseline CPU profile identified the campus pixel compiler, per-frame actor
lighting/occlusion, repeatedly invalidated lamp masks, and the synchronous
library atlas. An earlier headless run made shadow `drawImage` unusually slow;
visible hardware-accelerated checks did not reproduce that cost, so it was not
used as the hardware baseline or justification for removing shadows.

## Implemented changes

- A shared bounded two-Worker queue compiles campus chunks and the library atlas.
  Decoded material snapshots cross once per revision per worker; output buffers
  and atlas bitmaps transfer back. Worker failure or missing OffscreenCanvas
  filter support uses the same compiler with cooperative main-thread slices.
- Initial campus compilation waits for tree/facade settlement rather than
  compiling temporary fallback materials and immediately throwing them away.
  Asset requests settle within eight seconds; obsolete consumers cancel image
  waits and queued/running jobs. Normals are generated only on diagnostic demand.
- The library retains full DPR and original blend channels but allocates only
  the visible projected atlas rectangle, with a device-pixel guard. Hidden,
  offscreen and unmounted channel backing stores are released.
- Lamp mask keys depend on tree material and intersecting native-mask identities,
  so unrelated chunk progress no longer clears every lamp. Exact actor poses,
  definitions, occlusion and projected paths use bounded caches; campus actors
  skip the previously discarded legacy-light sample. Empty actor layers skip
  empty shadow processing.

At that full-quality checkpoint, no light/material equations, source positions,
brightness calibration, actor counts, frame-rate target, field/demo boundary or
generated asset bytes changed. Cropped canvas compositing may have small rasterizer rounding
differences at fractional transforms; absolute pixel equality is not claimed.
The before/after library receiver, shadow, room, source-material sample and
window statistics agree.

## Lower-resolution lighting profiles

**场景设置 → 光照精度** changes both maps together and remembers the local
choice. New visitors default to **轻量**; **精细** restores the earlier full
lighting detail. GIS raster sampling, text, actor/sprite canvas DPR, light
positions and shading equations retain their previous behavior.

| Budget | 轻量 / efficient | 精细 / full |
| --- | ---: | ---: |
| Campus lighting samples per world unit | 1 | Adaptive 1–2 |
| Library lighting samples per world unit | 2 | 3 |
| Material/lighting display DPR ceiling | 1 | 2 |
| Legacy Pixi lighting DPR ceiling | 1 | 1.5, as before |

At an originally high-detail campus chunk, efficient lighting evaluates one
quarter as many color receivers; the library evaluates four ninths as many.
Small material/light boundaries can appear softer, especially when zoomed in.
This is a deliberate lighting-detail choice, not a lower-resolution base map.
Switching quality replaces incompatible chunk/atlas cache entries and cancels
obsolete work; diagnostics can still request the full normal visualization.
Native tree-canopy alpha masks retain the original source resolution for actor
and fixture occlusion, independently of the lower-resolution lighting colors.
Quality changes also release incompatible cached work while layers are hidden
or unmounted.

Matched visible-Chromium comparison of the final quality implementation on
2026-10-25, with the same device/viewport and prewarmed official tiles:

| Measurement | 精细 / full | 轻量 / efficient |
| --- | ---: | ---: |
| All material ready | 6,923 ms | 4,077 ms |
| Longest startup main-thread task | 140 ms | 138 ms |
| Startup blocking time beyond 50 ms/task | 155 ms | 149 ms |
| DOM canvas RGBA capacity | 157.2 MiB | 86.1 MiB |
| Overview/local redraw sample | 25.6 / 25.6 fps | 25.3 / 25.3 fps |
| Browser page errors | 0 | 0 |

The lighter profile cuts readiness by 41% and DOM canvas capacity by 45% relative
to the optimized full profile. First pixels and partially prepared lighting
appear before this all-material-ready measurement. Official tile warm-up was
retried after a transient source timeout; that failed warm-up is excluded from
both timed samples. Real cold-network latency remains independent of these
renderer comparisons.

## Reproduce and acceptance

Run production previews for the baseline and candidate on separate ports, then:

```sh
BASELINE_URL=http://127.0.0.1:5197/ BASE_URL=http://127.0.0.1:5199/ \
  node scripts/lighting-performance.mjs
BASELINE_URL=http://127.0.0.1:5199/ BASELINE_QUALITY=full \
  BASE_URL=http://127.0.0.1:5199/ LIGHTING_QUALITY=efficient \
  node scripts/lighting-performance.mjs
BASE_URL=http://127.0.0.1:5199/ node scripts/lighting-runtime-smoke.mjs
npx vitest run tests/frontend tests/library-light-viewport.test.js
npm run build
```

The comparison script opens visible Chromium by default; `HEADLESS=1` is an
explicit diagnostic variant whose native-canvas timings must not be presented
as desktop GPU performance. Results default to ignored `captures/performance/`.
The renderer smoke uses browser-local GET fixtures and never submits records
or writes a database. It exercises rapid pan while preparing, phone layout,
xray, day/night and original/campus switches, idle rendering, field isolation
and a forced no-Worker fallback. It also checks quality switching/preference
and unchanged actor backing resolution. Unit coverage includes queue bounds,
cancellation, late messages, fallback, exact shading/material samples, cache
invalidation, cropped viewport geometry and full-resolution native mask equality.
The final frontend suite passes265 tests across28 files; the production build
passes. Screenshot metadata was checked and nonessential metadata removed from
the review copies; generated source assets remain byte-for-byte unchanged.

The downloaded decorative PNGs remain a separate bandwidth opportunity. This
change does not replace official GIS delivery with a bundled historical raster.
