/** Indexed, illustrative 2.5D campus field. Geometry and light powers are visual
 * proxies, never a physical survey, radio coverage, occupancy or live lighting.
 * All receivers share the accepted library's world-Z-up chart and material light
 * payload. No image, canvas readback or network operation runs in this module.
 */
import { campusSurfaces, campusTrees, campusLights } from './campus-scene-data.js';
import {
  screenToWorld, worldToScreen, libraryBlend, LIBRARY_BOUNDS,
  resolveLibrarySurface, sampleLibraryLight, sampleLibraryActor,
  librarySegmentVisibility, libraryTrees, treeOpacityAt, treeMaterialUV,
} from './library-lighting.js';
import { sampleTreeMaterial, treeMaterialState } from './tree-material.js';
import { chooseRoomAppearance } from './room-lighting.js';
import { buildings } from './spatial-scene.js';

const DET = .9275, RAY = [.65 / DET, 1 / DET, 1], CELL = 32;
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const smooth = value => { const x = clamp(value); return x * x * (3 - 2 * x); };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => a.map((v, i) => v - b[i]);
const unit = a => { const length = Math.hypot(...a); return length > 1e-9 ? a.map(v => v / length) : [0, 0, 0]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const finite3 = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
const direction2 = (x, y) => { const length = Math.hypot(x, y); return length > 1e-9 ? { x: x / length, y: y / length } : { x: 0, y: 0 }; };
const overlap = (a, b) => a.left <= b.left + b.width && a.left + a.width >= b.left
  && a.top <= b.top + b.height && a.top + a.height >= b.top;
const boundsOf = polygon => {
  const xs = polygon.map(p => p[0]), ys = polygon.map(p => p[1]);
  const left = Math.min(...xs), top = Math.min(...ys);
  return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
};
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

/** Lists are visited only while compiling the index. Pixel/actor queries visit
 * their cell; segment/bounds queries deduplicate only the intersected cells.
 */
function spatialIndex(items, getBounds) {
  const cells = new Map();
  const eachCell = (bounds, visit) => {
    for (let cy = Math.floor(bounds.top / CELL); cy <= Math.floor((bounds.top + bounds.height) / CELL); cy++)
      for (let cx = Math.floor(bounds.left / CELL); cx <= Math.floor((bounds.left + bounds.width) / CELL); cx++) visit(`${cx}:${cy}`);
  };
  for (const item of items) eachCell(getBounds(item), key => {
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(item);
  });
  return {
    at: (x, y) => cells.get(`${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`) ?? [],
    in: bounds => {
      const found = new Set();
      eachCell(bounds, key => { for (const item of cells.get(key) ?? []) if (overlap(bounds, getBounds(item))) found.add(item); });
      return [...found];
    },
    cells: cells.size,
  };
}

function compileSurface(surface) {
  const { polygon, kind } = surface;
  const height = kind === 'ground' ? 0 : surface.height;
  const points = kind === 'wall'
    ? [screenToWorld(...polygon[0], height), screenToWorld(...polygon[1], height), screenToWorld(...polygon.at(-1), 0)]
    : polygon.slice(0, 3).map(p => screenToWorld(...p, height));
  let normal = kind === 'wall' ? unit(cross(sub(points[1], points[0]), sub(points[2], points[0]))) : [0, 0, 1];
  if (dot(normal, RAY) < 0) normal = normal.map(v => -v);
  const panes = (surface.windows ?? []).map(pane => ({ ...pane, screenBounds: boundsOf(pane.polygon) }));
  const lastRow = Math.max(0, ...panes.map(pane => Number(pane.id.split('-').at(-2))).filter(Number.isFinite));
  for (const pane of panes) pane.room = chooseRoomAppearance(surface.id, pane, lastRow);
  return { ...surface, normal, screenBounds: boundsOf(polygon),
    mapping: { constant: dot(normal, points[0]), rayDenominator: dot(normal, RAY) },
    windowPanes: panes, panes: spatialIndex(panes, pane => pane.screenBounds) };
}

function compileTree(source) {
  const { id, x, y, height, radii } = source;
  const center = screenToWorld(x, y); center[2] = height;
  const projected = worldToScreen(center), [rx, ry, rz] = radii;
  const xx = rx * rx + .4225 * ry * ry;
  const yy = .1225 * rx * rx + .49 * ry * ry + rz * rz;
  const xy = .35 * rx * rx - .455 * ry * ry;
  const phase = [...id].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) / 4294967296 * Math.PI * 2;
  return { ...source, kind: 'tree', base: { x, y }, ellipsoid: { center, radii },
    screenBounds: { left: projected.x - Math.sqrt(xx), top: projected.y - Math.sqrt(yy), width: 2 * Math.sqrt(xx), height: 2 * Math.sqrt(yy) },
    projection: { center: projected, xx, xy, yy, determinant: xx * yy - xy * xy, phase } };
}

function treeMaterial(tree, x, y) {
  const p = tree.projection, dx = x - p.center.x, dy = y - p.center.y;
  const q = (p.yy * dx * dx - 2 * p.xy * dx * dy + p.xx * dy * dy) / p.determinant;
  if (q >= 1) return null;
  const uv = treeMaterialUV(tree, x, y), sample = uv && sampleTreeMaterial(...uv);
  const radius = Math.sqrt(Math.max(0, q)), size = Math.min(Math.sqrt(p.xx), Math.sqrt(p.yy));
  if (sample) return { uv, sample, coverage: sample.alpha * smooth((1 - radius) * size / .22) };
  const angle = Math.atan2((dy - p.xy / p.xx * dx) / Math.sqrt(p.determinant / p.xx), dx / Math.sqrt(p.xx));
  const rim = 1 - .025 - .036 * (.5 + .5 * Math.sin(5 * angle + p.phase))
    - .025 * (.5 + .5 * Math.sin(9 * angle - 1.7 * p.phase)) - .018 * (.5 + .5 * Math.sin(13 * angle + 1.3 * p.phase));
  return { uv, sample: null, coverage: smooth((rim - radius) * size / 1.4) };
}

function ellipsoidRoots(origin, direction, { center, radii }) {
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
function foliageNormal(normal, detail, mirror) {
  const tangent = axis => unit(axis.map((value, i) => value - normal[i] * dot(axis, normal)));
  const tx = tangent([.7 / DET, -.35 / DET, 0]), ty = tangent([.65 / DET, 1 / DET, 0]);
  return unit(normal.map((value, i) => value + tx[i] * detail[0] * (mirror ? -1 : 1) + ty[i] * detail[1]));
}
function paneEmission(surface, x, y) {
  for (const pane of surface.panes.at(x, y)) {
    if (!inside(x, y, pane.polygon)) continue;
    const [a, b, , d] = pane.polygon;
    const ax = b[0] - a[0], ay = b[1] - a[1], bx = d[0] - a[0], by = d[1] - a[1];
    const determinant = ax * by - ay * bx;
    const uv = Math.abs(determinant) > 1e-9
      ? [((x - a[0]) * by - (y - a[1]) * bx) / determinant, (ax * (y - a[1]) - ay * (x - a[0])) / determinant] : [.5, .5];
    const color = pane.color ?? surface.color ?? 0xffd5a2;
    return { color: Array.isArray(color) ? color : [(color >> 16) & 255, (color >> 8) & 255, color & 255],
      strength: pane.room.emission, normalization: 1, uv, pane, room: pane.room };
  }
  return null;
}

function noLight() {
  const zero = () => ({ x: 0, y: 0 });
  return { intensity: 0, warmth: 0, visibility: 1, directIntensity: 0, indirectIntensity: 0,
    directWarmth: 0, indirectWarmth: 0, directIrradiance: 0, indirectIrradiance: 0,
    facadeIrradiance: 0, facadeIntensity: 0, facadeWarmth: 0, direction: zero(), directDirection: zero(),
    indirectDirection: zero(), indirectGroundDirection: zero(), facadeDirection: zero(), surfaceGroundDirection: zero(),
    groundDirection: zero(), surfaceElevation: 0, surfaceLightDirection: [0, 0, 0],
    sourceHeight: 0, sourceDistance: 0, groundSourceDistance: 0, elevation: 0, dominantSourceId: null, blend: 0, libraryBlend: 0 };
}
function compileLight(light) {
  const position = light.position ?? (() => { const p = screenToWorld(light.x, light.y); p[2] = light.height; return p; })();
  const screen = worldToScreen(position), ground = light.ground
    ?? (Number.isFinite(light.x) && Number.isFinite(light.y) ? { x: light.x, y: light.y } : worldToScreen([position[0], position[1], 0]));
  // A world sphere projects to at most 1.271r in screen Y and 1.193r in X.
  const extent = light.radius * 1.28;
  return { ...light, position, ground, height: light.height ?? position[2], warmth: light.warmth ?? .78,
    screenBounds: { left: screen.x - extent, top: screen.y - extent, width: extent * 2, height: extent * 2 } };
}
function receiverCosine(normal, delta, distance, options) {
  if (options.upright) return .78 * Math.hypot(delta[0], delta[1]) / distance + .22 * Math.max(0, delta[2] / distance);
  const cosine = dot(normal, delta) / distance;
  return options.receiverKind === 'tree'
    ? clamp(Math.max(0, (cosine + .25) / 1.25) + .12 * Math.max(0, -cosine)) : Math.max(0, cosine);
}
function sourceEmission(light, delta, distance) {
  if (!light.emissionDirection) return 1;
  const half = (light.coneHalfAngleDegrees ?? 68) * Math.PI / 180;
  const soft = (light.coneSoftEdgeDegrees ?? 10) * Math.PI / 180;
  return smooth((-dot(unit(light.emissionDirection), delta) / distance - Math.cos(half)) / Math.max(1e-9, Math.cos(Math.max(0, half - soft)) - Math.cos(half)));
}

/** Coalesce only actual emitting panes, with the same six-column/three-row
 * quadrature and scene radiance units as the library. Centroids stay on the
 * original wall plane; finite pane area limits near-field energy.
 */
function compileFacadePatches(planes, delegateLibrary) {
  const groups = new Map();
  for (const surface of planes) {
    if (surface.kind !== 'wall') continue;
    const pointOnWall = ([x, y]) => {
      const ground = screenToWorld(x, y), { mapping, normal } = surface;
      return screenToWorld(x, y, (mapping.constant - dot(normal, ground)) / mapping.rayDenominator);
    };
    for (const pane of surface.windowPanes) {
      if (!(pane.room.emission > 0)) continue;
      const center = pane.polygon.reduce((sum, p) => [sum[0] + p[0] / 4, sum[1] + p[1] / 4], [0, 0]);
      if (delegateLibrary && libraryBlend(...center) > 0) continue;
      const corners = pane.polygon.map(pointOnWall);
      const area = (Math.hypot(...cross(sub(corners[1], corners[0]), sub(corners[2], corners[0])))
        + Math.hypot(...cross(sub(corners[2], corners[0]), sub(corners[3], corners[0])))) * .5;
      if (!(area > 0) || !Number.isFinite(area)) continue;
      const [row, column] = pane.id.split('-').slice(-2).map(Number);
      const id = `${surface.id}:area:${Math.floor(row / 3)}:${Math.floor(column / 6)}`;
      if (!groups.has(id)) groups.set(id, { id, wallId: surface.id, normal: surface.normal,
        weightedPosition: [0, 0, 0], area: 0, radianceArea: 0, paneIds: [] });
      const group = groups.get(id), flux = area * pane.room.emission;
      for (let axis = 0; axis < 3; axis++) group.weightedPosition[axis] += corners.reduce((sum, p) => sum + p[axis] / 4, 0) * flux;
      group.area += area; group.radianceArea += flux; group.paneIds.push(pane.id);
    }
  }
  return Object.freeze([...groups.values()].map(group => {
    const position = group.weightedPosition.map(v => v / group.radianceArea);
    return Object.freeze(compileLight({ id: group.id, wallId: group.wallId, position,
      rayPosition: position.map((v, i) => v + group.normal[i] * .15), normal: group.normal,
      area: group.area, power: group.radianceArea / Math.PI,
      radius: Math.min(76, 34 + Math.sqrt(group.area) * 5), warmth: .84,
      paneIds: Object.freeze(group.paneIds), provenance: 'authored-room-radiance-from-actual-pane-area' }));
  }));
}

/** Factory isolates deterministic scene checks; production compiles one field.
 * Custom test arrays also compile once (WeakMap), never once per sample.
 */
export function createCampusSceneField({ surfaces = [], trees = [], lights = [], silhouettes = [], delegateLibrary = true } = {}) {
  const planes = surfaces.map(compileSurface), crowns = trees.map(compileTree);
  const surfaceIndex = spatialIndex(planes, p => p.screenBounds);
  const treeIndex = spatialIndex(crowns, p => p.screenBounds);
  const silhouetteIndex = spatialIndex(silhouettes, p => boundsOf(p.polygon));
  const lightSets = new WeakMap();
  const facadePatches = compileFacadePatches(planes, delegateLibrary), facadeIndexes = new WeakMap();
  const getFacadeIndex = patches => {
    if (!facadeIndexes.has(patches)) facadeIndexes.set(patches, spatialIndex(patches === facadePatches ? patches : patches.map(compileLight), p => p.screenBounds));
    return facadeIndexes.get(patches);
  };
  const resolve = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1024 || y < 0 || y > 640) return null;
    const blend = delegateLibrary ? libraryBlend(x, y) : 0;
    if (blend > 0) { const hit = resolveLibrarySurface(x, y); return hit ? { ...hit, libraryBlend: blend } : null; }
    const ground = screenToWorld(x, y);
    const groundBlocked = silhouetteIndex.at(x, y).some(building => inside(x, y, building.polygon));
    let nearest = null;
    for (const surface of surfaceIndex.at(x, y)) {
      if (!inside(x, y, surface.polygon)) continue;
      if (surface.kind === 'ground' && groundBlocked) continue;
      const { normal, mapping } = surface;
      if (Math.abs(mapping.rayDenominator) < 1e-9) continue;
      const z = (mapping.constant - dot(normal, ground)) / mapping.rayDenominator;
      if (z < -.5 || nearest && z < nearest.position[2] - 1e-7) continue;
      // Coplanar authored ground layers follow painter order, allowing a pond
      // inset to supersede its plaza without ever superseding an elevated roof.
      if (nearest && Math.abs(z - nearest.position[2]) <= 1e-7 && surface.kind === 'ground' && nearest.kind !== 'ground') continue;
      nearest = { id: surface.id, kind: surface.kind, material: surface.material, surface,
        buildingId: surface.buildingId ?? null, normal, position: screenToWorld(x, y, Math.max(0, z)),
        coverage: surface.kind === 'ground' ? smooth(edgeDistance(x, y, surface.polygon) / 1.5) : 1,
        libraryBlend: 0, emission: surface.kind === 'wall' ? paneEmission(surface, x, y) : null };
    }
    for (const tree of treeIndex.at(x, y)) {
      const material = treeMaterial(tree, x, y);
      if (!material?.coverage) continue;
      const roots = ellipsoidRoots(ground, RAY, tree.ellipsoid);
      if (!roots || roots[1] < 0 || nearest && roots[1] <= nearest.position[2]) continue;
      const position = screenToWorld(x, y, roots[1]);
      let normal = unit(position.map((v, i) => (v - tree.ellipsoid.center[i]) / tree.ellipsoid.radii[i] ** 2));
      if (material.sample) normal = foliageNormal(normal, material.sample.normalDetail, tree.projection.phase > Math.PI);
      nearest = { id: tree.id, kind: 'tree', material: 'generated-foliage', tree, buildingId: null,
        position, normal, coverage: material.coverage, materialUV: material.uv, libraryBlend: 0,
        ...(material.sample ? { baseColor: material.sample.baseColor } : {}) };
    }
    return nearest;
  };

  const visibility = (start, end, { excludeId } = {}) => {
    if (!finite3(start) || !finite3(end)) return 1;
    const direction = sub(end, start), a = worldToScreen(start), b = worldToScreen(end);
    const bounds = { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
    let transmission = delegateLibrary && overlap(bounds, LIBRARY_BOUNDS) ? librarySegmentVisibility(start, end, { excludeId }) : 1;
    for (const surface of surfaceIndex.in(bounds)) {
      if (surface.kind === 'ground' || surface.id === excludeId || surface.buildingId === excludeId) continue;
      const denominator = dot(surface.normal, direction);
      if (Math.abs(denominator) < 1e-8) continue;
      const t = (surface.mapping.constant - dot(surface.normal, start)) / denominator;
      if (t <= .015 || t >= .985) continue;
      const hit = worldToScreen(start.map((v, i) => v + direction[i] * t));
      if (!inside(hit.x, hit.y, surface.polygon)) continue;
      transmission *= 1 - .95 * smooth(edgeDistance(hit.x, hit.y, surface.polygon) / 1.8);
      if (transmission < .025) return transmission;
    }
    for (const tree of treeIndex.in(bounds)) {
      if (tree.id === excludeId) continue;
      const roots = ellipsoidRoots(start, direction, tree.ellipsoid);
      if (!roots) continue;
      const enter = Math.max(.015, roots[0]), leave = Math.min(.985, roots[1]);
      if (leave > enter) transmission *= Math.exp(-1.05 * (leave - enter) * Math.hypot(...direction) / Math.min(...tree.ellipsoid.radii));
    }
    return clamp(transmission);
  };

  function getLightSet(sources) {
    if (lightSets.has(sources)) return lightSets.get(sources);
    const compiled = sources.map(compileLight), index = spatialIndex(compiled, p => p.screenBounds);
    const patches = compiled.map(light => {
      const position = [light.position[0], light.position[1], .08], ground = light.ground;
      // Reflection exists only on authored ground, excluding visible buildings.
      const candidates = surfaceIndex.at(ground.x, ground.y).filter(surface => inside(ground.x, ground.y, surface.polygon));
      const receiver = candidates.findLast(surface => surface.kind === 'ground');
      const blocked = candidates.some(surface => surface.kind !== 'ground');
      const distance = Math.max(.01, light.position[2] - .12);
      const cutoff = Math.max(0, 1 - (distance / light.radius) ** 2);
      const direct = receiver && !blocked && light.position[2] > .12
        ? light.power * sourceEmission(light, [0, 0, distance], distance) * cutoff ** 2 / (1 + (distance / 12) ** 2)
          * visibility([position[0], position[1], .12], light.position) : 0;
      const reflectance = receiver?.material === 'grass' ? .18 : receiver?.material === 'water' ? .08 : .28;
      return compileLight({ id: `${light.id}:bounce`, sourceId: light.id, position, ground, power: direct * reflectance,
        groundIrradiance: direct, radius: Math.min(34, light.radius * .6), warmth: light.warmth });
    });
    const result = { compiled, index, patches: Object.freeze(patches), patchIndex: spatialIndex(patches, p => p.screenBounds) };
    lightSets.set(sources, result); return result;
  }

  const sample = (position, normal, options = {}) => {
    if (!finite3(position) || !finite3(normal)) return noLight();
    const screen = worldToScreen(position);
    if (delegateLibrary && libraryBlend(screen.x, screen.y) > 0) return sampleLibraryLight(position, normal, options);
    if (screen.x < 0 || screen.x > 1024 || screen.y < 0 || screen.y > 640) return noLight();
    const n = unit(normal), start = position.map((v, i) => v + n[i] * .12), sources = getLightSet(options.lights ?? lights);
    let total = 0, indirect = 0, warm = 0, indirectWarm = 0, possible = 0, transmitted = 0;
    let dx = 0, dy = 0, gx = 0, gy = 0, ix = 0, iy = 0, igx = 0, igy = 0;
    let facade = 0, facadeWarm = 0, fx = 0, fy = 0, fgx = 0, fgy = 0, facadeElevation = 0;
    let sourceHeight = 0, sourceDistance = 0, groundSourceDistance = 0, elevation = 0, strongest = 0, dominantSourceId = null;
    const worldDirection = [0, 0, 0];
    const add = (light, bounce, areaEmitter = false) => {
      const delta = sub(light.position, position), distance = Math.hypot(...delta);
      if (distance >= light.radius || distance < 1e-7 || light.power <= 0) return;
      const cosine = receiverCosine(n, delta, distance, options);
      const outgoing = areaEmitter ? Math.max(0, -dot(light.normal, delta) / distance)
        : bounce ? Math.max(0, -delta[2] / distance) : sourceEmission(light, delta, distance);
      if (cosine <= 0 || outgoing <= 0) return;
      const cutoff = Math.max(0, 1 - (distance / light.radius) ** 2);
      const unblocked = areaEmitter
        ? 4 * light.power * cosine * outgoing * cutoff ** 2 / (distance * distance + light.area / Math.PI)
        : light.power * cosine * outgoing * cutoff ** 2 / (1 + (distance / 12) ** 2);
      const transmission = options.occlusion === false ? 1 : visibility(start, light.rayPosition ?? light.position, options);
      const value = unblocked * transmission, projected = worldToScreen(light.position);
      possible += unblocked; transmitted += value;
      for (let axis = 0; axis < 3; axis++) worldDirection[axis] += delta[axis] / distance * value;
      const groundX = light.ground.x - screen.x, groundY = light.ground.y - (screen.y + position[2]);
      if (areaEmitter) {
        facade += value; facadeWarm += value * light.warmth;
        fx += (projected.x - screen.x) * value; fy += (projected.y - screen.y) * value;
        fgx += groundX * value; fgy += groundY * value;
        facadeElevation += clamp(Math.max(0, delta[2]) / distance) * value;
      } else if (bounce) {
        indirect += value; indirectWarm += value * light.warmth;
        ix += (projected.x - screen.x) * value; iy += (projected.y - screen.y) * value;
        igx += groundX * value; igy += groundY * value;
      } else {
        total += value; warm += value * light.warmth;
        dx += (projected.x - screen.x) * value; dy += (projected.y - screen.y) * value;
        gx += groundX * value; gy += groundY * value;
        sourceHeight += light.height * value; sourceDistance += Math.hypot(delta[0], delta[1]) * value;
        groundSourceDistance += Math.hypot(groundX, groundY) * value;
        elevation += clamp(Math.max(0, delta[2]) / distance) * value;
        if (value > strongest) { strongest = value; dominantSourceId = light.id; }
      }
    };
    for (const light of sources.index.at(screen.x, screen.y)) add(light, false);
    if (options.indirect && position[2] > .08) for (const patch of sources.patchIndex.at(screen.x, screen.y)) add(patch, true);
    if (options.emissive) for (const patch of getFacadeIndex(options.facadeEmitters ?? facadePatches).at(screen.x, screen.y)) add(patch, false, true);
    const directIntensity = clamp(1 - Math.exp(-1.25 * total)), reflectedIntensity = clamp(1 - Math.exp(-1.25 * (total + indirect)));
    const intensity = clamp(1 - Math.exp(-1.25 * (total + indirect + facade))), energy = total + indirect + facade;
    return { ...noLight(), intensity, directIntensity, indirectIntensity: reflectedIntensity - directIntensity, facadeIntensity: intensity - reflectedIntensity,
      directIrradiance: total, indirectIrradiance: indirect, facadeIrradiance: facade, facadeWarmth: facade > 0 ? facadeWarm / facade : 0,
      facadeDirection: direction2(fx, fy), warmth: energy > 0 ? clamp((warm + indirectWarm + facadeWarm) / energy) : 0,
      directWarmth: total > 0 ? clamp(warm / total) : 0, indirectWarmth: indirect > 0 ? clamp(indirectWarm / indirect) : 0,
      direction: direction2(dx + ix + fx, dy + iy + fy), directDirection: direction2(dx, dy), indirectDirection: direction2(ix, iy),
      indirectGroundDirection: direction2(igx, igy), groundDirection: direction2(gx, gy), surfaceGroundDirection: direction2(gx + igx + fgx, gy + igy + fgy),
      surfaceLightDirection: unit(worldDirection), visibility: possible > 0 ? clamp(transmitted / possible) : 1,
      sourceHeight: total > 0 ? sourceHeight / total : 0, sourceDistance: total > 0 ? sourceDistance / total : 0,
      groundSourceDistance: total > 0 ? groundSourceDistance / total : 0, elevation: total > 0 ? clamp(elevation / total) : 0,
      surfaceElevation: energy > 0 ? clamp((elevation + facadeElevation) / energy) : 0, dominantSourceId, blend: 1 };
  };

  return {
    resolveCampusSurface: resolve, sampleCampusLight: sample, campusSegmentVisibility: visibility,
    sampleCampusActor: (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return noLight();
      if (delegateLibrary && libraryBlend(x, y) > 0) return sampleLibraryActor(x, y);
      const position = screenToWorld(x, y); position[2] = 1.8;
      return sample(position, [0, 0, 1], { upright: true, indirect: true, emissive: true, receiverKind: 'actor' });
    },
    campusTreeOpacityAt: (x, y, groundY = -Infinity) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || Number.isNaN(groundY)) return 0;
      if (delegateLibrary && libraryBlend(x, y) > 0) return treeOpacityAt(x, y, groundY);
      let transmission = 1;
      for (const tree of treeIndex.at(x, y)) if (groundY < tree.base.y) transmission *= 1 - (treeMaterialState().ready ? 1 : .92) * (treeMaterial(tree, x, y)?.coverage ?? 0);
      return clamp(1 - transmission);
    },
    getCampusTreesInBounds: bounds => bounds && [bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite)
      ? [...treeIndex.in(bounds), ...(delegateLibrary && overlap(bounds, LIBRARY_BOUNDS) ? libraryTrees.filter(tree => overlap(bounds, tree.screenBounds)) : [])] : [],
    campusGroundBounce: (sources = lights) => getLightSet(sources).patches,
    campusFacadeEmitters: () => facadePatches,
    campusSpatialQueryStats: (x, y) => ({ cellSize: CELL, surfaceCount: planes.length, treeCount: crowns.length, lightCount: lights.length,
      surfaceCandidates: surfaceIndex.at(x, y).length, treeCandidates: treeIndex.at(x, y).length,
      lightCandidates: getLightSet(lights).index.at(x, y).length, facadeCount: facadePatches.length,
      facadeCandidates: getFacadeIndex(facadePatches).at(x, y).length, surfaceCells: surfaceIndex.cells, treeCells: treeIndex.cells }),
  };
}

const campusField = createCampusSceneField({ surfaces: campusSurfaces, trees: campusTrees, lights: campusLights, silhouettes: buildings });
export const {
  resolveCampusSurface, sampleCampusLight, sampleCampusActor, campusTreeOpacityAt,
  getCampusTreesInBounds, campusSegmentVisibility, campusGroundBounce, campusFacadeEmitters, campusSpatialQueryStats,
} = campusField;
export const campusLibraryBlend = libraryBlend;
