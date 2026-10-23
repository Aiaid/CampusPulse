import semantics from './gis-semantics.json' with { type: 'json' };
import routeSample from './gis-route-sample.json' with { type: 'json' };

/** Fixed-view projected geometry. Official records stay distinct from artwork. */
export const spatialNotice = '建筑投影与桂中路区域来自学校公开 GIS；自建地面路径、停放、灯光与移动为示意，非测绘路网或实时观测。';
const manualProvenance = { kind: 'manual-illustrative', basis: 'visual-pavement-review', rasterSnapshot: '2026-10-15', coordinateSystem: 'campuspulse_map_pixels_1024x640' };

// This explicit reviewed list deliberately excludes mixed-category parks/roads.
// placeId is a UI association, not an official cross-namespace identifier join.
const reviewedBuildings = [
  ['10644', 'library-main', 'library'],
  ['10646', 'foreign-languages-source', null],
  ['10653', 'literature-source', 'literature'],
  ['10655', 'tianjiabing-main', 'tianjiabing'],
  ['10660', 'gym-source', 'gym'],
  ['10665', 'teaching-8-source', 'teaching-8'],
  ['10680', 'teaching-9-source', 'teaching-9'],
  ['10687', 'manjianghong-source', null],
  ['10728', 'teaching-2-south-source', null],
  ['10750', 'museum-source', null],
  ['11773', 'humanities-research-source', null],
  ['11880', 'faculty-home-4-source', null],
  ['11883', 'faculty-home-1-source', null],
  ['11885', 'faculty-home-36-source', null],
  ['11918', 'guiyuan-shops-source', null],
];
export const officialBuildings = reviewedBuildings.map(([sourceId, id, placeId]) => {
  const source = semantics.sourcePolygons.find((record) => record.sourceId === sourceId);
  return {
    id, placeId, sourceId, name: source.name, polygon: source.vertices,
    geometryRole: 'projected-screen-occluder', groundObstacle: false,
    provenance: { kind: 'official-hover-polygon', sourceNamespace: source.sourceNamespace,
      snapshotDate: semantics.metadata.snapshotDate, sourceFiles: source.sourceFiles, sources: source.sources,
      interpretation: 'visually-reviewed-projected-silhouette-not-ground-footprint' },
  };
});

// The white H-shaped building south of the official Tianjiabing outline has no
// reviewed source polygon in this sample. Do not assign it a guessed school name.
export const manualBuildings = [
  { id: 'central-south-wing-manual', placeId: null, name: '南侧未具名楼体（描摹）', sourceId: null,
    polygon: [[562, 357], [590, 366], [600, 355], [608, 353], [617, 343], [628, 345], [635, 339], [649, 345], [645, 354], [658, 359], [658, 377], [649, 385], [635, 381], [624, 389], [605, 383], [588, 383], [565, 374]] },
  { id: 'central-front-building-manual', placeId: null, name: '南侧未具名楼体前翼（描摹）', sourceId: null,
    polygon: [[557, 375], [579, 381], [586, 376], [604, 384], [614, 381], [627, 385], [629, 380], [669, 394], [674, 402], [672, 415], [658, 420], [623, 408], [617, 414], [592, 405], [591, 401], [560, 390]] },
].map((building) => ({ ...building, geometryRole: 'projected-screen-occluder', groundObstacle: false,
  provenance: { ...manualProvenance, basis: 'visible-silhouette-no-reviewed-official-outline' } }));
export const buildings = [...officialBuildings, ...manualBuildings];

const sourceRoad = semantics.sourcePolygons.find(({ sourceId }) => sourceId === '10759');
export const roadRegions = [{
  id: 'guizhong-source-corridor', name: sourceRoad.name, sourceId: sourceRoad.sourceId, polygon: sourceRoad.vertices,
  geometryRole: 'reviewed-road-related-region',
  provenance: { kind: 'official-hover-polygon', sourceNamespace: sourceRoad.sourceNamespace,
    snapshotDate: semantics.metadata.snapshotDate, sourceFiles: sourceRoad.sourceFiles,
    sources: sourceRoad.sources, interpretation: 'partial-paved-corridor-not-road-network' },
}];

// A screen-space artistic lane choice INSIDE the source quadrilateral. Neither
// the lateral offset nor the opposing headings assert official traffic rules.
function insetRoadLane(kind, lateralOffset) {
  const [a, b, c, d] = sourceRoad.vertices;
  const start = [(a[0] + d[0]) / 2, (a[1] + d[1]) / 2];
  const end = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2];
  const dx = end[0] - start[0], dy = end[1] - start[1], length = Math.hypot(dx, dy);
  const point = (fraction) => [start[0] + dx * fraction - dy / length * lateralOffset, start[1] + dy * fraction + dx / length * lateralOffset];
  const points = [point(.035), point(.5), point(.965)];
  return { id: `guizhong-source-${kind}`, kind, placeId: 'yundaiying', sourceId: sourceRoad.sourceId,
    regionId: roadRegions[0].id, points: kind === 'ride' ? points.reverse() : points, width: 2,
    provenance: { kind: 'derived-illustrative-lane', sourceNamespace: sourceRoad.sourceNamespace,
      sourceId: sourceRoad.sourceId, method: 'inset-edge-midpoint-centerline-with-screen-offset',
      laneOffsetPixels: lateralOffset, groundBasis: 'visually-reviewed-source-road-region',
      notice: 'Synthetic actor corridor, not an official centerline, direction or traffic rule.' } };
}
// This narrow boundary subset follows the source silhouette around the visible
// circular canopy; interpreting it as an entrance cover is a visual review.
const canopyApproach = semantics.sourcePolygons.find(({ sourceId }) => sourceId === '10644').vertices.slice(6, 29);
export const manualRoutes = [
  { id: 'library-west-apron', kind: 'walk', placeId: 'library', width: 6,
    coveredBy: 'library-main', allowedOcclusionRegion: canopyApproach,
    points: [[557, 253], [572, 258], [586, 264], [602, 271], [617, 277], [628, 281], [640, 283]] },
  { id: 'library-west-passage', kind: 'walk', placeId: 'library', width: 4,
    points: [[594, 281], [584, 296], [575, 309], [566, 322]] },
  { id: 'library-east-apron', kind: 'walk', placeId: 'library', width: 5,
    points: [[723, 290], [716, 301], [704, 313], [695, 323]] },
  { id: 'east-road-walk-north', kind: 'walk', placeId: 'library', width: 4,
    points: [[778, 184], [772, 204], [764, 229], [756, 255], [748, 277], [736, 301]] },
  { id: 'east-road-ride-north', kind: 'ride', placeId: 'library', width: 7,
    points: [[786, 176], [779, 198], [772, 220], [765, 244], [756, 269], [744, 293], [730, 313]] },
  { id: 'east-road-ride-south', kind: 'ride', placeId: 'tianjiabing', width: 7,
    points: [[724, 324], [711, 345], [708, 367], [707, 393], [707, 421], [714, 442], [728, 457]] },
  { id: 'east-road-walk-south', kind: 'walk', placeId: 'tianjiabing', width: 4,
    points: [[716, 332], [702, 355], [700, 379], [700, 405], [700, 428], [707, 443]] },
].map((route) => ({ ...route, sourceId: null, provenance: { ...manualProvenance, geometryRole: 'reviewed-visible-pavement-demo-path' } }));
export const routes = [...manualRoutes, insetRoadLane('walk', -1.15), insetRoadLane('ride', 1.15)];

// Preserve the real GetRoute response for optional inspection. It crosses roof/
// facade projections and lacks verified entrance/ground alignment, so it never
// enters routes or supplies moving actor positions.
export const officialRoutePreviews = [{ ...routeSample, id: 'library-tianjiabing-official-preview',
  eligibleForActors: false, status: 'source-response-preview-not-ground-validated',
  points: routeSample.worldPoints.map(([x, y]) => [(x - 10240) / 8, (y - 7168) / 8])
    .filter((point, index, points) => index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1]),
}];

export const parkingAreas = [
  { id: 'library-paved-apron-demo', placeId: 'library',
    polygon: [[562, 255], [586, 265], [582, 271], [558, 261]],
    slots: [{ x: 564, y: 259, heading: 112 }, { x: 569, y: 261, heading: 112 }, { x: 574, y: 263, heading: 112 }, { x: 579, y: 265, heading: 112 }] },
  { id: 'central-paved-edge-demo', placeId: 'tianjiabing',
    polygon: [[569, 406], [594, 417], [591, 422], [566, 411]],
    slots: [{ x: 570, y: 409, heading: 113 }, { x: 575, y: 411, heading: 113 }, { x: 580, y: 413, heading: 113 }, { x: 585, y: 415, heading: 113 }, { x: 590, y: 418, heading: 113 }] },
].map((area) => ({ ...area, sourceId: null, provenance: { ...manualProvenance,
  geometryRole: 'artistic-parking-layout-on-visible-paving', confirmedParkingFacility: false } }));

export const lampPoints = [
  { x: 557, y: 252, strength: .72 }, { x: 586, y: 264, strength: .9 },
  { x: 612, y: 276, strength: .72 }, { x: 582, y: 299, strength: .52 },
  { x: 724, y: 290, strength: .8 }, { x: 708, y: 309, strength: .72 },
  { x: 779, y: 188, strength: .65 }, { x: 765, y: 232, strength: .68 },
  { x: 749, y: 276, strength: .68 }, { x: 725, y: 322, strength: .72 },
  { x: 702, y: 360, strength: .7 }, { x: 701, y: 399, strength: .72 },
  { x: 709, y: 441, strength: .7 }, { x: 553, y: 410, strength: .65 },
  { x: 591, y: 427, strength: .8 }, { x: 632, y: 445, strength: .7 },
].map((lamp) => ({ ...lamp, provenance: { kind: 'manual-artistic-light', sourceId: null } }));

// Warm points lie on actual visible window facades. No glow is put on roof grids.
// Angle follows the projected facade; width/height are in reference pixels.
export const facadeLights = [];
function windowStrip(buildingId, start, end, rows, columns, rowStep, strength) {
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      // Deliberately leave some rooms unlit; stable across playback.
      if ((row * 7 + column * 3) % 8 === 0) continue;
      const fraction = (column + .5) / columns;
      facadeLights.push({
        buildingId,
        provenance: { kind: 'manual-artistic-light', sourceId: null },
        x: start[0] + (end[0] - start[0]) * fraction,
        y: start[1] + (end[1] - start[1]) * fraction + row * rowStep,
        width: 1.3, height: 1.1, angle: 18,
        strength: strength * (.75 + ((column + row) % 3) * .12),
      });
    }
  }
}
windowStrip('library-main', [613, 228], [670, 246], 5, 15, 3.3, .85);
windowStrip('library-main', [662, 289], [681, 296], 5, 5, 3.1, .7);
windowStrip('tianjiabing-main', [605, 311], [679, 336], 4, 18, 3.3, .78);
windowStrip('central-front-building-manual', [566, 383], [615, 400], 3, 12, 2.5, .6);

const xy = (point) => Array.isArray(point) ? point : [point.x, point.y];
export function pointInPolygon(point, polygon) {
  const [x, y] = xy(point);
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    const cross = (x - xi) * (yj - yi) - (y - yi) * (xj - xi);
    if (Math.abs(cross) < 1e-7 && x >= Math.min(xi, xj) && x <= Math.max(xi, xj) && y >= Math.min(yi, yj) && y <= Math.max(yi, yj)) return true;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Arc-length progress in [0,1], with screen heading 0° right / 90° down. */
export function sampleRoute(route, progress) {
  const points = route.points;
  if (!points?.length) return { x: 0, y: 0, heading: 0 };
  if (points.length === 1) return { x: points[0][0], y: points[0][1], heading: 0 };
  const lengths = points.slice(1).map((point, i) => Math.hypot(point[0] - points[i][0], point[1] - points[i][1]));
  const total = lengths.reduce((sum, value) => sum + value, 0);
  let distance = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0)) * total;
  for (let i = 0; i < lengths.length; i += 1) {
    if (lengths[i] === 0) continue;
    if (distance <= lengths[i] || i === lengths.length - 1) {
      const fraction = Math.min(1, distance / lengths[i]);
      const dx = points[i + 1][0] - points[i][0], dy = points[i + 1][1] - points[i][1];
      return { x: points[i][0] + dx * fraction, y: points[i][1] + dy * fraction, heading: (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360 };
    }
    distance -= lengths[i];
  }
  return { x: points.at(-1)[0], y: points.at(-1)[1], heading: 0 };
}

export function classifyOcclusion(point) {
  return buildings.find((building) => pointInPolygon(point, building.polygon)) ?? null;
}
