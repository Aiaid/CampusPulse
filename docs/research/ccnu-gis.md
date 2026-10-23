# CCNU GIS base investigation

Checked 2026-10-23 against the current public site. This investigation used
public HTML, JavaScript and two small POI responses, plus a few individual tile
requests. No campus image, vendor JavaScript or downloaded POI collection is
included in this repository. This is separate from the historical GIS audit in
[pre-hackathon observations](../upstream/pre-hackathon/observations.md).

## Result

The [official campus GIS](https://gis.ccnu.edu.cn/) is a usable **fixed-view raster
base**, with an image coordinate system. Its illustrated buildings already have
perspective and shading baked into JPG tiles. The inspected renderer does not
provide building meshes, surface normals, a depth buffer or a documented 3D
scene export. Calling the site “三维虚拟校园” does not make those render inputs
available to our app.

For the first implementation, preserve the image view and place independently
rendered selection rings, glows and observation anchors above it. Three.js can
render these overlays and Bloom, but cannot make the baked building windows or
shadows respond physically to new lighting. Arbitrary camera rotation would
expose the flat raster. Real building occlusion and dynamic building lighting
would require separately obtained, aligned 3D geometry.

## Evidence and coordinates

| Public source | Observed behavior |
| --- | --- |
| [Root page](https://gis.ccnu.edu.cn/) | Loads `inc/api/maps.js?x=&y=&z=` and identifies the campus GIS vendor; campus shortcuts use image x/y values |
| [Map loader](https://gis.ccnu.edu.cn/inc/api/maps.js) | Creates a map iframe and loads the public `xbgis?t=1` renderer |
| [Renderer](https://gis.ccnu.edu.cn/xbgis?t=1) | Creates positioned 256×256 JPG image tiles, handles zoom by powers of two, loads XML annotations separately |
| [UI](https://gis.ccnu.edu.cn/inc/webUI.js) | Contains named popular-place focus anchors, including library `(15656, 9059)` |
| [Library-area annotations](https://gis.ccnu.edu.cn/xml/gadgets/3/15,8.xml) | Library label anchor `(15602, 8970)`; this differs slightly from the focus anchor |

The renderer's permitted image grid has these bounds; these are grid bounds,
not a measured campus footprint or a guarantee that every tile has content.

| Official level | Image dimensions at that level | Tile x/y indices | Original image pixels per tile |
| --- | --- | --- | --- |
| `zoom1` | 24576×24576 | 0–95 inclusive | 256 |
| `zoom2` | 12288×12288 | 0–47 inclusive | 512 |
| `zoom3` | 6144×6144 | 0–23 inclusive | 1024 |
| `zoom4` | 3072×3072 | 0–11 inclusive | 2048 |

Template: `https://gis.ccnu.edu.cn/mapdata/zoom{level}/{x}_{y}.jpg`.
Level numbers run opposite to many web-map libraries: 1 is finest, 4 coarsest.
The original coordinate origin is top left; x increases right, y increases down.
At official level `L`, original image coordinates are divided by `2^(L-1)`.
Normalized anchors use `u=x/24576`, `v=y/24576`.

Useful focus anchors from the site's existing named shortcuts:

| Place | Original image x/y | Normalized u/v |
| --- | --- | --- |
| 图书馆 | 15656 / 9059 | 0.6370442708 / 0.3686116536 |
| 行政楼 | 15379 / 10996 | 0.6257731120 / 0.4474283854 |
| 文学院 | 14297 / 9847 | 0.5817464193 / 0.4006754557 |
| 田家炳楼 | 15358 / 9681 | 0.6249186198 / 0.3939208984 |

These are map focus/label positions, not surveyed building footprints, entrances,
sensor installation locations or WGS84 coordinates. Register an actual sensor
placement separately; do not infer BLE coverage from a building marker.

## Access checks

An actual GET of `mapdata/zoom3/13_9.jpg` with
`Origin: http://localhost:5173` returned HTTP 200, `image/jpeg`, 256×256 and
`Access-Control-Allow-Origin: *`. The corresponding XML annotation request also
returned 200 and the same CORS header. GET requests around the library confirmed
`zoom4/7_4.jpg`, `zoom4/6_4.jpg` and `zoom3/15_8.jpg` were available. Their sizes
were approximately 120 KB, 120 KB and 111 KB respectively.

**HEAD is misleading on this server:** the tested image URLs returned 404 to
HEAD while returning 200 to GET. Do not use HEAD as a runtime tile availability
test. Tile responses advertised a 600-second cache lifetime. These are point-in-
time HTTP checks, not evidence of future uptime, browser rendering or campus
network reachability.

The site's map-download button calls `html2canvas(document.body)` and saves the
rendered view; inspection did not identify a single complete-map image endpoint.
For an initial browser integration, request only visible tiles, reuse loaded
tiles and dispose textures when evicted. Do not fetch or bundle all 96×96 tiles.
Use cross-origin anonymous image loading before making WebGL textures; handle
image load/CORS failures with an explicit unavailable-base state.

## Integration boundaries

- Keep attribution and an accessible link to the official GIS visible. Public
  reachability and CORS do not establish an open redistribution license.
  Confirm permission before redistributing or caching a campus map snapshot in
  the project or on another host. No public mirror or bulk asset copy is made
  by this research.
- Use a single image-coordinate transform for tiles and overlays. A fixed
  orthographic view preserves alignment; pan and zoom together. GIS selection
  and WebGL selection must share that transform.
- Do not copy the vendor renderer into the app. A small independently written
  tile adapter is enough; keep its URLs configurable and failure behavior
  explicit.
- Treat the official heatmap/parking layers separately from CampusPulse's own
  observations. This work does not establish their freshness, measurement units,
  sampling source or suitability as BLE-derived activity evidence.
- Expose live/manual/demo provenance and missing coverage independently of the
  base. A detailed campus illustration does not imply campus-wide sensing.
