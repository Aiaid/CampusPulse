/**
 * Hand-reviewed light masks in the fixed 1024 × 640 map projection.
 * These are illustrative visible WALL surfaces, never footprints, roof geometry,
 * surveyed windows, occupancy observations or a claim about actual night lights.
 * Registration was visually checked against the local 2048 × 1280 GIS reference
 * (divide reference pixels by two). No reference raster is included in this file.
 * Sloped roofs, foreground roofs, canopy and trees are intentionally excluded.
 */
const provenance = {
  kind: 'manual-illustrative-facade-mask',
  basis: 'visible-wall-and-window-band-review',
  rasterSnapshot: '2026-10-15',
  reviewed: '2026-10-23',
  coordinateSystem: 'campuspulse_map_pixels_1024x640',
  accuracy: 'visual-registration-only-not-surveyed',
  illumination: 'stable-synthetic-room-pattern-not-live-observation',
};

/** Corners follow the wall: top start, top end, bottom end, bottom start. */
export function pointOnFacade(quad, u, v) {
  const [a, b, c, d] = quad;
  return [0, 1].map(axis => (1 - v) * ((1 - u) * a[axis] + u * b[axis])
    + v * ((1 - u) * d[axis] + u * c[axis]));
}

/** Each pane follows BOTH projected wall axes; it is not a rotated point. */
export function facadeCell(quad, u0, v0, u1, v1) {
  return [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]
    .map(([u, v]) => pointOnFacade(quad, u, v));
}

function insideConvex(point, polygon) {
  let sign = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const cross = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
    if (Math.abs(cross) < 1e-8) continue;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

function surface({ id, buildingId, polygon, windowQuad = polygon, columns = 0, rows = 0,
  fillU = .66, fillV = .57, phase = 0, strength = .28, color = 0xffd5a2,
  material = 'painted-masonry', windowStrength = .84 }) {
  const windows = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const u0 = (column + (1 - fillU) / 2) / columns;
      const v0 = (row + (1 - fillV) / 2) / rows;
      const cell = facadeCell(windowQuad, u0, v0, u0 + fillU / columns, v0 + fillV / rows);
      // The source plane continues behind roofs. Drop a crossing pane entirely,
      // keeping room spacing consistent instead of stretching a grid into a wedge.
      if (!cell.every(point => insideConvex(point, polygon))) continue;
      const pattern = (column * 7 + row * 11 + phase) % 17;
      windows.push({ id: `${id}-${row}-${column}`, polygon: cell,
        lit: pattern !== 0 && pattern !== 3 && pattern !== 10 && pattern !== 14,
        strength: windowStrength * (.76 + ((row + column * 3 + phase) % 5) * .06) });
    }
  }
  return { id, buildingId, polygon, color, strength, material, provenance, windows };
}

export const facadeSurfaces = [
  // Library main curtain wall. The diagonal right boundary is the white sloped
  // roof in front of it, not an edge that window rows should converge towards.
  surface({ id: 'library-west-glass', buildingId: 'library-main', material: 'curtain-glass',
    polygon: [[610, 218], [676.5, 238], [662.6, 272], [610, 252]],
    windowQuad: [[611.1, 219.4], [677.1, 239.4], [677.1, 268.4], [611.1, 248.4]],
    columns: 18, rows: 9, fillU: .79, fillV: .63, strength: .31, phase: 1 }),
  // Low front face under the sloping roof; keep the narrow service shaft out.
  surface({ id: 'library-south-glass', buildingId: 'library-main', material: 'curtain-glass',
    polygon: [[660, 284.2], [685.8, 292.6], [685.8, 322], [660, 312.9]],
    windowQuad: [[661, 286.1], [684.9, 293.9], [684.9, 316.3], [661, 308.5]],
    columns: 7, rows: 7, fillU: .76, fillV: .6, strength: .29, phase: 5 }),
  // Tall east glass face has a rising top edge along the white roof. Its panes
  // follow that plane, while the doors below remain individually visible.
  surface({ id: 'library-east-glass', buildingId: 'library-main', material: 'curtain-glass',
    polygon: [[686.7, 292], [713.3, 250.5], [713.3, 296.3], [686.7, 321.8]],
    windowQuad: [[687.7, 277.8], [712.3, 254], [712.3, 293], [687.7, 316.8]],
    columns: 9, rows: 12, fillU: .76, fillV: .61, strength: .23, phase: 9 }),
  // Adjacent white building: separate wings so the central circular windows
  // and the different roof heights are not overwritten by one generic grid.
  surface({ id: 'tianjiabing-west-wing', buildingId: 'tianjiabing-main',
    polygon: [[599, 307.2], [621.7, 315.1], [621.7, 339.8], [599, 332]],
    windowQuad: [[600.1, 309.3], [620.6, 316.5], [620.6, 338.3], [600.1, 331.1]],
    columns: 8, rows: 7, fillU: .58, fillV: .55, strength: .33, phase: 4 }),
  surface({ id: 'tianjiabing-central-wall', buildingId: 'tianjiabing-main',
    polygon: [[621.9, 317.2], [647.2, 325.9], [647.2, 346.7], [621.9, 338]],
    strength: .29 }),
  surface({ id: 'tianjiabing-east-wing', buildingId: 'tianjiabing-main',
    polygon: [[647.5, 326], [675.1, 335.7], [675.1, 358.7], [647.5, 349]],
    windowQuad: [[648.7, 327.1], [674, 336], [674, 356.7], [648.7, 347.8]],
    columns: 10, rows: 7, fillU: .55, fillV: .55, strength: .34, phase: 10 }),
  surface({ id: 'tianjiabing-east-end', buildingId: 'tianjiabing-main',
    polygon: [[675.6, 335.4], [685.7, 325.2], [685.7, 348.2], [675.6, 358.4]],
    windowQuad: [[677, 335.6], [684.5, 328], [684.5, 346.9], [677, 354.5]],
    columns: 3, rows: 6, fillU: .52, fillV: .55, strength: .21, phase: 3 }),
  // Teaching 8: one connected south wall, with windows only in the reviewed
  // central window bands; the solid end towers retain the raster's detail.
  surface({ id: 'teaching-8-south-wall', buildingId: 'teaching-8-source',
    polygon: [[457.5, 170], [559.1, 209.6], [559.1, 236.3], [457.5, 196.7]],
    windowQuad: [[472.3, 176.9], [544.9, 205.5], [544.9, 226.6], [472.3, 198]],
    columns: 23, rows: 6, fillU: .65, fillV: .55, strength: .27, phase: 6 }),
  surface({ id: 'teaching-8-east-wall', buildingId: 'teaching-8-source',
    polygon: [[559.7, 209.7], [584, 184.3], [584, 210], [559.7, 235.4]],
    windowQuad: [[561.1, 211.1], [582.9, 188.3], [582.9, 208.4], [561.1, 231.2]],
    columns: 8, rows: 6, fillU: .42, fillV: .53, strength: .2, phase: 11 }),
  // Literature's low walls start BELOW the blue tiled eaves. The left wing is
  // tree-occluded and omitted. These short walls should never become roof light.
  surface({ id: 'literature-central-wall', buildingId: 'literature-source',
    polygon: [[483.3, 343], [513, 354], [513, 360.6], [483.3, 349.6]],
    windowQuad: [[484.2, 343.7], [512.2, 354.1], [512.2, 359.4], [484.2, 349]],
    columns: 9, rows: 2, fillU: .55, fillV: .52, strength: .27, phase: 4 }),
  surface({ id: 'literature-east-wall', buildingId: 'literature-source',
    polygon: [[516.6, 356.7], [535.1, 363.8], [535.1, 367.9], [516.6, 360.8]],
    windowQuad: [[517.3, 357.1], [534.2, 363.6], [534.2, 367], [517.3, 360.5]],
    columns: 6, rows: 1, fillU: .56, fillV: .65, strength: .25, phase: 12 }),
  // Unnamed H-shaped building south of Tianjiabing. These are new WALL masks
  // from the visible raster, independent of the older approximate occluders.
  surface({ id: 'central-front-west-wall', buildingId: 'central-front-building-manual',
    polygon: [[559.8, 364.1], [597.7, 378.5], [597.7, 392.2], [559.8, 377.8]],
    windowQuad: [[561, 365.1], [596.8, 378.7], [596.8, 391.5], [561, 377.9]],
    columns: 18, rows: 3, fillU: .54, fillV: .6, strength: .34, phase: 2 }),
  // Only the upper central wall is exposed above the projecting entrance roof.
  surface({ id: 'central-front-entry-wall', buildingId: 'central-front-building-manual',
    polygon: [[598.4, 376.7], [622.1, 385.3], [622.1, 395.1], [598.4, 386.5]],
    windowQuad: [[603.6, 379.5], [616.8, 384.3], [616.8, 393.5], [603.6, 388.7]],
    columns: 5, rows: 2, fillU: .66, fillV: .67, strength: .37, phase: 8 }),
  // Stop at the foreground tree edge rather than lighting through its canopy.
  surface({ id: 'central-front-east-wall', buildingId: 'central-front-building-manual',
    polygon: [[625.7, 390.8], [652.1, 400.9], [649.7, 413], [625.7, 403.9]],
    windowQuad: [[626.5, 391.2], [652, 401], [652, 413.5], [626.5, 403.7]],
    columns: 13, rows: 3, fillU: .52, fillV: .59, strength: .32, phase: 9 }),
];
