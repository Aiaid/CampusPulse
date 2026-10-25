/**
 * Illustrative 2.5D library-entry lighting registered to the 1024 × 640 GIS.
 * Coordinates and heights are visual proxies, not a survey or live observations.
 * No raster is read, sampled or bundled here. Distances use arbitrary map units.
 * The first three wall masks/window quads match facade-surfaces.js (2026-10-23).
 */
import { facadeSurfaces } from './facade-surfaces.js';
import { sampleTreeMaterial, treeMaterialState } from './tree-material.js';
import { chooseRoomAppearance } from './room-lighting.js';
import { libraryPlantingIslands } from './ground-features.js';

export const LIBRARY_BOUNDS = Object.freeze({ left: 548, top: 188, width: 191, height: 147 });
export const libraryProvenance = Object.freeze({
  kind: 'manual-illustrative-2.5d-library-model',
  coordinateSystem: 'campuspulse_map_pixels_1024x640',
  accuracy: 'visual-registration-only-not-surveyed',
  illumination: 'illustrative-fixtures-not-live-observation',
  basis: '2026-10-15-GIS-visible-surface-review',
  reviewed: '2026-10-23',
});

const DET = .9275;
const RAY = [.65 / DET, 1 / DET, 1];
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const smooth = x => { const t = clamp(x); return t * t * (3 - 2 * t); };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = a => { const length = Math.hypot(...a); return length > 1e-9 ? a.map(v => v / length) : [0, 0, 0]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const finite3 = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);

/** Orthographic chart: ground is z=0 and increasing height moves straight up. */
export function worldToScreen([u, v, z]) {
  return { x: 540 + u - .65 * v, y: 250 + .35 * u + .7 * v - z };
}

export function screenToWorld(x, y, z = 0) {
  const dx = x - 540, dy = y - 250 + z;
  return [(.7 * dx + .65 * dy) / DET, (-.35 * dx + dy) / DET, z];
}

/** Feather only the outer ROI. Material coverage is evaluated separately. */
export function libraryBlend(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  const { left, top, width, height } = LIBRARY_BOUNDS;
  return smooth(Math.min(x - left, left + width - x, y - top, top + height - y) / 9);
}

function inside(x, y, polygon) {
  let yes = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) yes = !yes;
  }
  return yes;
}

function edgeDistance(x, y, polygon) {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = clamp(((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1));
    best = Math.min(best, Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy));
  }
  return best;
}

function plane(id, kind, polygon, points, extra = {}) {
  let normal = unit(cross(sub(points[1], points[0]), sub(points[2], points[0])));
  if (dot(normal, RAY) < 0) normal = normal.map(v => -v);
  const constant = dot(normal, points[0]);
  return { id, kind, polygon, normal, buildingId: kind === 'ground' ? null : 'library-main',
    mapping: { origin: points[0], normal, constant, rayDenominator: dot(normal, RAY) },
    provenance: libraryProvenance, ...extra };
}

// Plane geometry follows the TRUE parallel wall quad, never the clipped mask.
// Its base extends below the window band to the visible door/ground junction.
const wallRegistrations = [
  { id: 'library-west-glass', quad: [[611.1, 219.4], [677.1, 239.4], [677.1, 268.4], [611.1, 248.4]], sill: 7.6, columns: 18, rows: 9 },
  { id: 'library-south-glass', quad: [[661, 286.1], [684.9, 293.9], [684.9, 316.3], [661, 308.5]], sill: 4.4, columns: 7, rows: 7 },
  { id: 'library-east-glass', quad: [[687.7, 277.8], [712.3, 254], [712.3, 293], [687.7, 316.8]], sill: 5, columns: 9, rows: 12 },
];
const walls = wallRegistrations.map(({ id, quad, sill, columns, rows }) => {
  const source = facadeSurfaces.find(surface => surface.id === id);
  const height = quad[3][1] - quad[0][1] + sill;
  const points = [screenToWorld(...quad[0], height), screenToWorld(...quad[1], height), screenToWorld(...quad[3], sill)];
  const surface = plane(id, 'wall', source.polygon, points, { material: source.material, windows: source.windows });
  surface.mapping.windowQuad = quad;
  surface.mapping.windowTopHeight = height;
  surface.mapping.windowBottomHeight = sill;
  surface.mapping.columns = columns;
  surface.mapping.rows = rows;
  return surface;
});

const roofPolygon = [[602, 211], [619, 193], [687, 215], [676.5, 238], [610, 218]];
const slopePolygon = [[677, 238], [704, 246], [686, 292], [660, 284]];
const canopyPolygon = Array.from({ length: 32 }, (_, i) => {
  const a = i * Math.PI / 16;
  return [635 + Math.cos(a) * 17.5, 276 + Math.sin(a) * 11.5];
});

export const librarySurfaces = [
  ...walls,
  plane('library-main-roof', 'roof', roofPolygon, roofPolygon.slice(0, 3).map(p => screenToWorld(...p, 39))),
  plane('library-sloping-roof', 'roof', slopePolygon, [screenToWorld(677, 238, 46), screenToWorld(704, 246, 46), screenToWorld(660, 284, 30)]),
  plane('library-entry-canopy', 'canopy', canopyPolygon, canopyPolygon.slice(0, 3).map(p => screenToWorld(...p, 7.5))),
  plane('library-west-paving', 'ground', [[555, 251], [574, 250], [610, 255], [660, 274], [660, 310], [632, 299], [606, 288], [580, 279], [555, 268]],
    [[0, 0, 0], [1, 0, 0], [0, 1, 0]]),
  plane('library-east-paving', 'ground', [[715, 278], [734, 288], [718, 314], [699, 334], [686, 328], [699, 307]],
    [[0, 0, 0], [1, 0, 0], [0, 1, 0]]),
  // Same retained west-passage walking corridor, extended only as a receiver.
  // It supplies visible paving beside the foreground grove, not a new route.
  plane('library-grove-passage', 'ground', [[590,280],[598,284],[579,315],[570,312]],
    [[0,0,0],[1,0,0],[0,1,0]]),
];
const blockingSurfaces = librarySurfaces.filter(surface => surface.kind !== 'ground');

function tree(id, x, y, height, radii) {
  const center = screenToWorld(x, y, 0); center[2] = height;
  const projected = worldToScreen(center), [rx, ry, rz] = radii;
  // The projected ellipsoid is generally rotated: preserve its covariance.
  const xx = rx * rx + .4225 * ry * ry;
  const yy = .1225 * rx * rx + .49 * ry * ry + rz * rz;
  const xy = .35 * rx * rx - .455 * ry * ry;
  const determinant = xx * yy - xy * xy;
  const phase = [...id].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) / 4294967296 * Math.PI * 2;
  return { id, kind: 'tree', base: { x, y }, ellipsoid: { center, radii },
    screenBounds: { left: projected.x - Math.sqrt(xx), top: projected.y - Math.sqrt(yy), width: 2 * Math.sqrt(xx), height: 2 * Math.sqrt(yy) },
    projection: { center: projected, xx, xy, yy, determinant, phase },
    provenance: libraryProvenance };
}

// Reviewed grove west of the glass, and foreground crowns left of the canopy.
export const libraryTrees = [
  tree('library-tree-northwest', 600, 241, 10.5, [6.8, 6, 9]),
  tree('library-tree-west-wall', 598, 253, 10, [7.3, 5.5, 9]),
  tree('library-tree-west-path', 587, 261, 8.5, [5, 4.5, 7]),
  tree('library-tree-outer-path', 572, 265, 9, [6, 5.2, 7.5]),
  tree('library-tree-west-grove', 583, 282, 11, [8, 6.5, 9.5]),
  tree('library-tree-forecourt', 599, 292, 11.5, [8, 6.5, 10]),
  tree('library-tree-front-west', 589, 299, 10, [7.2, 6, 8.5]),
  tree('library-tree-front-small', 609, 300, 7, [4.3, 3.5, 5.5]),
];

function makeLight(id, x, y, height, power, radius, warmth = .78) {
  const position = screenToWorld(x, y, 0); position[2] = height;
  return { id, position, height, power, radius, warmth, color: [1, .79, .54],
    ground: { x, y }, provenance: libraryProvenance };
}

/** Three discrete illustrative fixtures under the retained circular canopy's
 * front 120-degree arc. Their XY comes from that SAME roof point at z=7.5;
 * the lens hangs only .4 map units below it. These are not observed fixtures.
 */
export const libraryCanopyDownlights = Object.freeze([30, 90, 150].map(angleDegrees => {
  const angleRadians = angleDegrees * Math.PI / 180;
  const x = 635 + 17.5 * Math.cos(angleRadians);
  const roofY = 276 + 11.5 * Math.sin(angleRadians);
  return {
    ...makeLight(`library-canopy-downlight-${angleDegrees}`, x, roofY + 7.5, 7.1, 1.2, 26),
    fixtureType: 'canopy-downlight', angleDegrees, angleRadians,
    screenTangentAngle: Math.atan2(11.5 * Math.cos(angleRadians), -17.5 * Math.sin(angleRadians)),
    emissionDirection: [0, 0, -1], coneHalfAngleDegrees: 68, coneSoftEdgeDegrees: 10,
    provenance: Object.freeze({ ...libraryProvenance, fixture: 'manual-illustrative-under-canopy-not-observed' }),
  };
}));

/** Low entry / path fixtures outside the walls; no roof-height floating lamps. */
export const libraryLights = [
  // Concentrated entrance reception: retain each existing fixture's position
  // and height, with a brighter near field and shorter spill onto the plaza.
  makeLight('library-west-door-north', 615, 264, 5.5, 2.8, 30),
  makeLight('library-west-door-center', 635, 270, 5.5, 2.5, 28),
  makeLight('library-west-door-south', 652, 275, 5, 2.2, 26),
  makeLight('library-canopy-entry', 634, 290, 4, 1.8, 26),
  makeLight('library-west-walk', 581, 269, 5.5, 1.25, 48),
  makeLight('library-west-grove-lamp', 608, 285, 5, 1.1, 43),
  makeLight('library-east-entry', 715, 307, 5.5, 1.45, 56),
  makeLight('library-south-entry', 688, 326, 4.5, .9, 45),
  // Low illustrative fixtures on the already retained west-passage approach.
  // Front-side placement lets crown normals receive light instead of raising
  // every leaf's ambient exposure. These are artwork, never observed fixtures.
  makeLight('library-grove-approach-west', 575, 309, 3.5, 1.35, 37),
  makeLight('library-grove-approach-north', 584, 296, 3.5, 1.1, 32),
  ...libraryCanopyDownlights,
];

/** `toSource` points receiver -> source, opposite the lamp emission direction.
 * Omnidirectional sources take the exact original unit response. A smooth cone
 * cutoff applies to both direct reception and its derived ground reflection.
 */
function sourceEmission(light, toSource, distance) {
  if (!light.emissionDirection) return 1;
  const axis = unit(light.emissionDirection);
  const halfAngle = (light.coneHalfAngleDegrees ?? 68) * Math.PI / 180;
  const softEdge = (light.coneSoftEdgeDegrees ?? 10) * Math.PI / 180;
  const outer = Math.cos(halfAngle), inner = Math.cos(Math.max(0, halfAngle - softEdge));
  const alignment = -dot(axis, toSource) / distance;
  return smooth((alignment - outer) / Math.max(1e-9, inner - outer));
}

/** Undo the projected ellipsoid covariance, so every crown uses the material
 * in its own local coordinates without changing the registered tree bounds.
 */
export function treeMaterialUV(tree, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const p = tree.projection, dx = x - p.center.x, dy = y - p.center.y;
  const u = dx / Math.sqrt(p.xx);
  const v = (dy - p.xy / Math.sqrt(p.xx) * u) / Math.sqrt(p.determinant / p.xx);
  if (u * u + v * v >= 1) return null;
  // Stable horizontal mirroring avoids identical leaf clusters in the grove.
  return [.5 + .5 * u * (p.phase > Math.PI ? -1 : 1), .5 + .5 * v];
}

function treeCoverage(tree, x, y) {
  const p = tree.projection, dx = x - p.center.x, dy = y - p.center.y;
  const q = (p.yy * dx * dx - 2 * p.xy * dx * dy + p.xx * dy * dy) / p.determinant;
  if (q >= 1) return 0;
  const uv = treeMaterialUV(tree, x, y);
  const material = uv && sampleTreeMaterial(...uv);
  if (material) {
    // Only soften the last fraction of a map pixel at the analytical volume
    // boundary. The interior and silhouette come from actual leaf alpha.
    return material.alpha * smooth((1 - Math.sqrt(Math.max(0, q))) * Math.min(Math.sqrt(p.xx), Math.sqrt(p.yy)) / .22);
  }
  const angle = Math.atan2((dy - p.xy / p.xx * dx) / Math.sqrt(p.determinant / p.xx), dx / Math.sqrt(p.xx));
  // Small deterministic insets break the repeated oval tint edge while the
  // underlying raster retains its leaves. All lobes stay INSIDE the analytical
  // ellipsoid, so ray normals, blocking volumes and exported bounds are intact.
  const rim = 1 - .025
    - .036 * (.5 + .5 * Math.sin(5 * angle + p.phase))
    - .025 * (.5 + .5 * Math.sin(9 * angle - 1.7 * p.phase))
    - .018 * (.5 + .5 * Math.sin(13 * angle + 1.3 * p.phase));
  return smooth((rim - Math.sqrt(Math.max(0, q))) * Math.min(Math.sqrt(p.xx), Math.sqrt(p.yy)) / 1.4);
}

function foliageNormal(normal, detail, mirrored) {
  // Project map-x/map-y derivatives into the tangent plane. The existing 3D
  // ellipsoid supplies the large-scale normal; texture only adds leaf relief.
  const tangent = axis => unit(axis.map((value, index) => value - normal[index] * dot(axis, normal)));
  const tx = tangent([.7 / DET, -.35 / DET, 0]), ty = tangent([.65 / DET, 1 / DET, 0]);
  return unit(normal.map((value, index) => value + tx[index] * detail[0] * (mirrored ? -1 : 1) + ty[index] * detail[1]));
}

function ellipsoidRoots(origin, direction, ellipsoid) {
  const { center, radii } = ellipsoid;
  let a = 0, b = 0, c = -1;
  for (let axis = 0; axis < 3; axis++) {
    const o = (origin[axis] - center[axis]) / radii[axis], d = direction[axis] / radii[axis];
    a += d * d; b += 2 * o * d; c += o * o;
  }
  const discriminant = b * b - 4 * a * c;
  if (a < 1e-12 || discriminant <= 0) return null;
  const root = Math.sqrt(discriminant);
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
}

/** Return the closest visible plane or ellipsoid on the orthographic view ray. */
export function resolveLibrarySurface(x, y) {
  if (!libraryBlend(x, y)) return null;
  const ground = screenToWorld(x, y), candidates = [];
  for (const surface of librarySurfaces) {
    if (!inside(x, y, surface.polygon)) continue;
    if (surface.kind === 'ground' && libraryPlantingIslands.some(polygon => inside(x, y, polygon))) continue;
    const { mapping, normal } = surface;
    if (Math.abs(mapping.rayDenominator) < 1e-9) continue;
    const z = (mapping.constant - dot(normal, ground)) / mapping.rayDenominator;
    if (z < -.5) continue;
    candidates.push({ position: screenToWorld(x, y, Math.max(0, z)), normal, kind: surface.kind,
      id: surface.id, buildingId: surface.buildingId,
      // Feather both outer paving limits and the retained planting islands.
      coverage: surface.kind === 'ground' ? smooth(Math.min(edgeDistance(x, y, surface.polygon),
        ...libraryPlantingIslands.map(polygon => edgeDistance(x, y, polygon))) / 2.5) : 1 });
  }
  for (const tree of libraryTrees) {
    const coverage = treeCoverage(tree, x, y);
    if (!coverage) continue;
    const roots = ellipsoidRoots(ground, RAY, tree.ellipsoid);
    if (!roots || roots[1] < 0) continue;
    const position = screenToWorld(x, y, roots[1]);
    let normal = unit(position.map((v, i) => (v - tree.ellipsoid.center[i]) / tree.ellipsoid.radii[i] ** 2));
    const materialUV = treeMaterialUV(tree, x, y);
    const material = materialUV && sampleTreeMaterial(...materialUV);
    if (material) normal = foliageNormal(normal, material.normalDetail, tree.projection.phase > Math.PI);
    candidates.push({ position, normal, kind: 'tree', id: tree.id, buildingId: null, coverage,
      ...(material ? { material: 'generated-foliage', materialUV, baseColor: material.baseColor } : {}) });
  }
  // Height parametrizes this view ray, so its highest intersection is nearest.
  let nearest = null;
  for (const candidate of candidates) if (!nearest || candidate.position[2] > nearest.position[2]) nearest = candidate;
  return nearest;
}

/** Segment transmission: opaque planes with soft edges and porous tree volume.
 * The epsilon offset and excludeId prevent a receiver from shadowing itself.
 */
export function librarySegmentVisibility(start, end, { excludeId } = {}) {
  if (!finite3(start) || !finite3(end)) return 1;
  const direction = sub(end, start);
  let visibility = 1;
  for (const surface of blockingSurfaces) {
    if (surface.id === excludeId || surface.buildingId === excludeId) continue;
    const denominator = dot(surface.normal, direction);
    if (Math.abs(denominator) < 1e-8) continue;
    const t = (surface.mapping.constant - dot(surface.normal, start)) / denominator;
    if (t <= .015 || t >= .985) continue;
    const hit = worldToScreen(start.map((v, i) => v + direction[i] * t));
    if (!inside(hit.x, hit.y, surface.polygon)) continue;
    visibility *= 1 - .95 * smooth(edgeDistance(hit.x, hit.y, surface.polygon) / 1.8);
    if (visibility < .025) return visibility;
  }
  for (const tree of libraryTrees) {
    if (tree.id === excludeId) continue;
    const roots = ellipsoidRoots(start, direction, tree.ellipsoid);
    if (!roots) continue;
    const enter = Math.max(.015, roots[0]), leave = Math.min(.985, roots[1]);
    if (leave <= enter) continue;
    const normalizedChord = (leave - enter) * Math.hypot(...direction) / Math.min(...tree.ellipsoid.radii);
    visibility *= Math.exp(-1.05 * normalizedChord);
  }
  return clamp(visibility);
}

const noLight = () => ({ intensity: 0, warmth: 0, direction: { x: 0, y: 0 }, visibility: 1,
  directIntensity: 0, indirectIntensity: 0, directWarmth: 0, indirectWarmth: 0,
  directDirection: { x: 0, y: 0 }, indirectDirection: { x: 0, y: 0 },
  indirectGroundDirection: { x: 0, y: 0 }, directIrradiance: 0, indirectIrradiance: 0,
  facadeIrradiance: 0, facadeIntensity: 0, facadeWarmth: 0, facadeDirection: { x: 0, y: 0 },
  surfaceGroundDirection: { x: 0, y: 0 }, surfaceElevation: 0,
  surfaceLightDirection: [0, 0, 0],
  groundDirection: { x: 0, y: 0 }, sourceHeight: 0, sourceDistance: 0,
  groundSourceDistance: 0, elevation: 0, dominantSourceId: null, blend: 0 });

const groundBounceCache = new WeakMap();
const GROUND_REFLECTANCE = .28;

/** Approximate ONE ground reflection, not global illumination. Each finite
 * patch is fixed beneath an existing lamp and powered only by that lamp's
 * ray-tested direct ground irradiance. It is never an independent light or a
 * shifted lamp. Warm pavement reflectance loses energy before re-emission.
 */
export function libraryGroundBounce(lights = libraryLights) {
  if (groundBounceCache.has(lights)) return groundBounceCache.get(lights);
  const patches = lights.map(light => {
    const position = [light.position[0], light.position[1], .08];
    const delta = sub(light.position, [position[0], position[1], .12]);
    const distance = Math.hypot(...delta);
    const cutoff = Math.max(0, 1 - (distance / light.radius) ** 2);
    const visibility = librarySegmentVisibility([position[0], position[1], .12], light.position);
    const groundIrradiance = distance > 1e-7 ? light.power * sourceEmission(light, delta, distance) * Math.max(0, delta[2] / distance)
      * cutoff ** 2 / (1 + (distance / 12) ** 2) * visibility : 0;
    return Object.freeze({ sourceId: light.id, position, ground: light.ground,
      power: groundIrradiance * GROUND_REFLECTANCE, groundIrradiance,
      radius: Math.min(34, light.radius * .6), warmth: light.warmth,
      provenance: 'illustrative-single-ground-bounce' });
  });
  groundBounceCache.set(lights, Object.freeze(patches));
  return patches;
}

function pointOnWall(surface, x, y) {
  const ground = screenToWorld(x, y), { mapping, normal } = surface;
  const height = (mapping.constant - dot(normal, ground)) / mapping.rayDenominator;
  return screenToWorld(x, y, height);
}

/** True wall-plane coordinates keep room appearance independent of whether a
 * tree texture has loaded or currently overlaps the pane's screen center.
 * Explicit lamp-only sampling prevents room-emitter compilation recursion.
 */
export function libraryPaneEntryIntensity(surface, pane) {
  const center = pane.polygon.reduce((sum, p) => [sum[0] + p[0] / 4, sum[1] + p[1] / 4], [0, 0]);
  return sampleLibraryLight(pointOnWall(surface, ...center), surface.normal,
    { excludeId: surface.id, emissive: false, indirect: false }).directIntensity;
}

/** Coalesce ONLY actual emitting pane areas into at most 23 facade patches:
 * six columns by three rows per group. Radiance-weighted centroids remain on
 * their original wall plane; no dropped pane, door or whole-wall area emits.
 * The area-light quadrature is an illustrative finite approximation, not GI.
 */
export function compileLibraryFacadeEmitters(surfaces = librarySurfaces, appearance = chooseRoomAppearance) {
  const groups = new Map();
  for (const surface of surfaces) {
    if (surface.kind !== 'wall') continue;
    const lastRow = Math.max(0, ...surface.windows.map(pane => Number(pane.id.split('-').at(-2))));
    for (const pane of surface.windows) {
      const [row, column] = pane.id.split('-').slice(-2).map(Number);
      const entry = row >= lastRow - 1 ? libraryPaneEntryIntensity(surface, pane) : 0;
      const room = appearance(surface.id, pane, lastRow, entry);
      if (!(room.emission > 0)) continue;
      const corners = pane.polygon.map(point => pointOnWall(surface, ...point));
      const area = (Math.hypot(...cross(sub(corners[1], corners[0]), sub(corners[2], corners[0])))
        + Math.hypot(...cross(sub(corners[2], corners[0]), sub(corners[3], corners[0])))) * .5;
      const flux = area * room.emission;
      const id = `${surface.id}:area:${Math.floor(row / 3)}:${Math.floor(column / 6)}`;
      if (!groups.has(id)) groups.set(id, { id, wallId: surface.id, normal: surface.normal,
        weightedPosition: [0, 0, 0], area: 0, radianceArea: 0, paneIds: [] });
      const group = groups.get(id);
      for (let axis = 0; axis < 3; axis++) group.weightedPosition[axis] += corners.reduce((sum, point) => sum + point[axis] / 4, 0) * flux;
      group.area += area; group.radianceArea += flux; group.paneIds.push(pane.id);
    }
  }
  return Object.freeze([...groups.values()].map(group => {
    const position = Object.freeze(group.weightedPosition.map(value => value / group.radianceArea));
    // Offset only the visibility endpoint out of its own plane; the radiance
    // distance, area and direction continue using the exact pane centroid.
    const rayPosition = Object.freeze(position.map((value, axis) => value + group.normal[axis] * .15));
    return Object.freeze({ id: group.id, wallId: group.wallId, position, rayPosition,
      normal: Object.freeze([...group.normal]), area: group.area, radianceArea: group.radianceArea,
      power: group.radianceArea / Math.PI, radius: Math.min(76, 34 + Math.sqrt(group.area) * 5), warmth: .84,
      ground: Object.freeze(worldToScreen([position[0], position[1], 0])),
      paneIds: Object.freeze(group.paneIds), provenance: 'authored-room-radiance-from-actual-pane-area' });
  }));
}

let cachedFacadeEmitters;
// Authored room emission is dimensionless display radiance. This one explicit
// calibration maps it into the same illustrative world irradiance scale as the
// existing fixtures; pane area, distance, facing and blocking still govern it.
const FACADE_RADIANCE_UNITS = 4;
export function libraryFacadeEmitters() {
  return cachedFacadeEmitters ??= compileLibraryFacadeEmitters();
}

function receiverCosine(normal, delta, distance, options) {
  if (options.upright) return .78 * Math.hypot(delta[0], delta[1]) / distance + .22 * Math.max(0, delta[2] / distance);
  const cosine = dot(normal, delta) / distance;
  // A crown is a cluster of thin leaves, not a smooth solid ellipsoid. A small
  // wrapped lobe and weak back transmission retain silhouettes and occlusion
  // while letting the lower/side leaves respond to the same nearby fixtures.
  if (options.receiverKind === 'tree') return clamp(Math.max(0, (cosine + .25) / 1.25) + .12 * Math.max(0, -cosine));
  return Math.max(0, cosine);
}

function direction2(x, y) {
  const length = Math.hypot(x, y);
  return length > 1e-9 ? { x: x / length, y: y / length } : { x: 0, y: 0 };
}

/** Shared Lambertian point-light evaluator. `lights` supports deterministic
 * isolated-source checks; runtime callers use the same exported source list.
 * `upright` averages the front/back normals of a vertical capsule, retaining
 * incident elevation rather than borrowing a horizontal pavement normal.
 * Direct-only remains the default. Opt-in indirect reception uses a bounded,
 * cached single ground bounce, the same blockers and no additional GIS reads.
 */
export function sampleLibraryLight(position, normal, options = {}) {
  if (!finite3(position) || !finite3(normal)) return noLight();
  const screen = worldToScreen(position), blend = libraryBlend(screen.x, screen.y);
  if (!blend) return noLight();
  const n = unit(normal);
  const lights = options.lights ?? libraryLights;
  const start = position.map((v, i) => v + n[i] * .12);
  let total = 0, warm = 0, dx = 0, dy = 0, possible = 0, transmitted = 0;
  let groundDx = 0, groundDy = 0, groundSourceDistance = 0;
  let sourceHeight = 0, sourceDistance = 0, elevation = 0, strongest = 0, dominantSourceId = null;
  let worldLightX = 0, worldLightY = 0, worldLightZ = 0;
  for (const light of lights) {
    const delta = sub(light.position, position), distance = Math.hypot(...delta);
    if (distance >= light.radius || distance < 1e-7) continue;
    const cosine = receiverCosine(n, delta, distance, options);
    if (cosine <= 0) continue;
    const emission = sourceEmission(light, delta, distance);
    if (emission <= 0) continue;
    const cutoff = Math.max(0, 1 - (distance / light.radius) ** 2);
    const unblocked = light.power * cosine * cutoff ** 2 / (1 + (distance / 12) ** 2) * emission;
    const visibility = options.occlusion === false ? 1 : librarySegmentVisibility(start, light.position, options);
    const value = unblocked * visibility;
    possible += unblocked; transmitted += value; total += value; warm += value * light.warmth;
    worldLightX += delta[0] / distance * value;
    worldLightY += delta[1] / distance * value;
    worldLightZ += delta[2] / distance * value;
    const source = worldToScreen(light.position), horizontal = Math.hypot(delta[0], delta[1]);
    dx += (source.x - screen.x) * value; dy += (source.y - screen.y) * value;
    // Cast shadows are projected on z=0. Using the elevated lamp's screen y
    // can reverse a ground shadow when a receiver stands just north of it.
    const groundX = light.ground.x - screen.x;
    const groundY = light.ground.y - (screen.y + position[2]);
    groundDx += groundX * value; groundDy += groundY * value;
    groundSourceDistance += Math.hypot(groundX, groundY) * value;
    sourceHeight += light.height * value; sourceDistance += horizontal * value;
    elevation += clamp(Math.max(0, delta[2]) / distance) * value;
    if (value > strongest) { strongest = value; dominantSourceId = light.id; }
  }
  let indirect = 0, indirectWarm = 0, indirectDx = 0, indirectDy = 0, indirectGroundDx = 0, indirectGroundDy = 0;
  if (options.indirect && position[2] > .08) {
    for (const patch of libraryGroundBounce(lights)) {
      if (patch.power <= 0) continue;
      const delta = sub(patch.position, position), distance = Math.hypot(...delta);
      if (distance >= patch.radius || distance < 1e-7) continue;
      const cosine = receiverCosine(n, delta, distance, options);
      if (cosine <= 0) continue;
      // Reflected ground flux exits only upward and loses energy at grazing
      // angles. An upward-facing roof cannot see this low emitter's front.
      const outgoing = Math.max(0, -delta[2] / distance);
      const cutoff = Math.max(0, 1 - (distance / patch.radius) ** 2);
      const unblocked = patch.power * outgoing * cosine * cutoff ** 2 / (1 + (distance / 12) ** 2);
      const visibility = options.occlusion === false ? 1 : librarySegmentVisibility(start, patch.position, options);
      const value = unblocked * visibility;
      possible += unblocked; transmitted += value;
      indirect += value; indirectWarm += value * patch.warmth;
      worldLightX += delta[0] / distance * value;
      worldLightY += delta[1] / distance * value;
      worldLightZ += delta[2] / distance * value;
      const source = worldToScreen(patch.position);
      indirectDx += (source.x - screen.x) * value; indirectDy += (source.y - screen.y) * value;
      indirectGroundDx += (patch.ground.x - screen.x) * value;
      indirectGroundDy += (patch.ground.y - (screen.y + position[2])) * value;
    }
  }
  let facade = 0, facadeWarm = 0, facadeDx = 0, facadeDy = 0, facadeGroundDx = 0, facadeGroundDy = 0, facadeElevation = 0;
  if (options.emissive) {
    for (const patch of options.facadeEmitters ?? libraryFacadeEmitters()) {
      const delta = sub(patch.position, position), distance = Math.hypot(...delta);
      if (distance >= patch.radius || distance < 1e-7) continue;
      // Windows emit only through the outward wall hemisphere. Inward faces
      // and other sides of the same building do not receive invented light.
      const outgoing = Math.max(0, -dot(patch.normal, delta) / distance);
      if (outgoing <= 0) continue;
      const cosine = receiverCosine(n, delta, distance, options);
      if (cosine <= 0) continue;
      const cutoff = Math.max(0, 1 - (distance / patch.radius) ** 2);
      const unblocked = FACADE_RADIANCE_UNITS * patch.power * outgoing * cosine * cutoff ** 2 / (distance * distance + patch.area / Math.PI);
      const visibility = options.occlusion === false ? 1 : librarySegmentVisibility(start, patch.rayPosition, options);
      const value = unblocked * visibility;
      possible += unblocked; transmitted += value;
      facade += value; facadeWarm += value * patch.warmth;
      worldLightX += delta[0] / distance * value;
      worldLightY += delta[1] / distance * value;
      worldLightZ += delta[2] / distance * value;
      const source = worldToScreen(patch.position);
      facadeDx += (source.x - screen.x) * value; facadeDy += (source.y - screen.y) * value;
      facadeGroundDx += (patch.ground.x - screen.x) * value;
      facadeGroundDy += (patch.ground.y - (screen.y + position[2])) * value;
      facadeElevation += clamp(Math.max(0, delta[2]) / distance) * value;
    }
  }
  const directIntensity = clamp(1 - Math.exp(-1.25 * total));
  const reflectedIntensity = clamp(1 - Math.exp(-1.25 * (total + indirect)));
  const intensity = clamp(1 - Math.exp(-1.25 * (total + indirect + facade)));
  const allEnergy = total + indirect + facade;
  return { intensity, directIntensity, indirectIntensity: reflectedIntensity - directIntensity, facadeIntensity: intensity - reflectedIntensity,
    directIrradiance: total, indirectIrradiance: indirect,
    facadeIrradiance: facade, facadeWarmth: facade > 0 ? facadeWarm / facade : 0,
    facadeDirection: direction2(facadeDx, facadeDy),
    directWarmth: total > 0 ? clamp(warm / total) : 0,
    indirectWarmth: indirect > 0 ? clamp(indirectWarm / indirect) : 0,
    warmth: allEnergy > 0 ? clamp((warm + indirectWarm + facadeWarm) / allEnergy) : 0,
    direction: direction2(dx + indirectDx + facadeDx, dy + indirectDy + facadeDy), directDirection: direction2(dx, dy),
    surfaceGroundDirection: direction2(groundDx + indirectGroundDx + facadeGroundDx, groundDy + indirectGroundDy + facadeGroundDy),
    surfaceElevation: allEnergy > 0 ? clamp((elevation + facadeElevation) / allEnergy) : 0,
    // The common dielectric lobe uses one energy-weighted WORLD direction,
    // including downward bounce. This does not replace lamp shadow metadata.
    surfaceLightDirection: unit([worldLightX, worldLightY, worldLightZ]),
    indirectDirection: direction2(indirectDx, indirectDy), indirectGroundDirection: direction2(indirectGroundDx, indirectGroundDy),
    // Ground shadow geometry stays tied to DIRECT fixtures. A reflected patch
    // adds material fill but must not invent another low shadow-casting lamp.
    groundDirection: direction2(groundDx, groundDy),
    visibility: possible > 0 ? clamp(transmitted / possible) : 1,
    sourceHeight: total > 0 ? sourceHeight / total : 0,
    sourceDistance: total > 0 ? sourceDistance / total : 0,
    groundSourceDistance: total > 0 ? groundSourceDistance / total : 0,
    elevation: total > 0 ? clamp(elevation / total) : 0, dominantSourceId, blend };
}

/** Ground anchor -> torso in the same chart, sources and blockers as the atlas. */
export function sampleLibraryActor(x, y) {
  if (!libraryBlend(x, y)) return noLight();
  const position = screenToWorld(x, y, 0); position[2] = 1.8;
  const result = sampleLibraryLight(position, [0, 0, 1], { upright: true, indirect: true, emissive: true, receiverKind: 'actor' });
  result.blend = libraryBlend(x, y);
  return result;
}

/** Sprite occlusion only: painter depth keeps actors in front of a tree intact.
 * Omitting groundY provides a mask of all crowns, suitable for cached atlases.
 */
export function treeOpacityAt(x, y, groundY = -Infinity) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || Number.isNaN(groundY)) return 0;
  // Generated leaves already encode their gaps in alpha. A second porousness
  // factor would expose a ghost of an actor through an otherwise opaque leaf.
  const opacity = treeMaterialState().ready ? 1 : .92;
  let transmission = 1;
  for (const tree of libraryTrees) {
    if (groundY >= tree.base.y) continue;
    transmission *= 1 - opacity * treeCoverage(tree, x, y);
  }
  return clamp(1 - transmission);
}
