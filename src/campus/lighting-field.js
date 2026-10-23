import { buildings, routes, parkingAreas, roadRegions, lampPoints, pointInPolygon } from './spatial-scene.js';
import { MAP_WIDTH, MAP_HEIGHT } from './scene-data.js';

const clamp01 = value => Math.max(0, Math.min(1, value));
const xy = point => Array.isArray(point) ? point : [point.x, point.y];
const smooth = value => { const t = clamp01(value); return t * t * (3 - 2 * t); };
const CELL_SIZE = 32;
const DARK_SAMPLE = () => ({ intensity: 0, warmth: 0, direction: { x: 0, y: 0 } });
// Display exposure of the ground overlay; actor materials use local irradiance
// directly, so this artistic opacity does not change their light samples.
export const GROUND_DIFFUSE_OPACITY = .58;

/** Artistic corridor half-width in registered map pixels, not a surveyed width. */
export function corridorHalfWidth(route) {
  return Math.max(2.4, Math.min(6.5, (Number(route.width) || 4) * .8 + .8));
}

/** Closest segment projection; tangent/angle use screen coordinates, in radians. */
export function nearestRoutePoint(point, routeList = routes) {
  const [x, y] = xy(point);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  let nearest = null;
  for (const route of routeList) {
    for (let index = 1; index < route.points.length; index += 1) {
      const [ax, ay] = route.points[index - 1], [bx, by] = route.points[index];
      const dx = bx - ax, dy = by - ay, lengthSquared = dx * dx + dy * dy;
      if (!lengthSquared) continue;
      const t = clamp01(((x - ax) * dx + (y - ay) * dy) / lengthSquared);
      const px = ax + t * dx, py = ay + t * dy;
      const distance = Math.hypot(x - px, y - py);
      if (nearest && distance >= nearest.distance) continue;
      const length = Math.sqrt(lengthSquared);
      nearest = { x: px, y: py, distance, tangent: [dx / length, dy / length], angle: Math.atan2(dy, dx), routeId: route.id, segment: index - 1, t };
    }
  }
  return nearest;
}

/** Lamps borrow only a local tangent, never the orientation of a remote path. */
export function lampSurfaceFrame(point, routeList = routes, aprons = parkingAreas, maxDistance = 14) {
  const nearest = nearestRoutePoint(point, routeList);
  if (nearest && nearest.distance <= maxDistance) return { ...nearest, kind: 'route' };
  const apronEdges = aprons.map(apron => ({ id: apron.id, points: [...apron.polygon, apron.polygon[0]] }));
  const apron = nearestRoutePoint(point, apronEdges);
  if (apron && apron.distance <= 8) return { ...apron, kind: 'apron' };
  return { angle: 0, distance: Infinity, routeId: null, kind: 'local' };
}

// Receiver masks reviewed against the retained map, 2026-10-23. These extend
// the visible paving beside existing actor paths; they do not change routes,
// parking slots or official geometry. They are artwork, not surveyed footprints.
export const lightReceivingAprons = [
  { id: 'library-west-light-apron', polygon: [[558,251],[575,251],[612,264],[620,272],[624,285],[635,293],[630,296],[607,287],[581,276],[558,266]] },
  { id: 'library-east-light-apron', polygon: [[717,282],[732,288],[718,310],[700,330],[690,327],[703,309]] },
  { id: 'central-entry-light-apron', polygon: [[578,405],[590,397],[611,405],[619,409],[613,419],[605,420],[584,413]] },
].map(region => ({ ...region, provenance: { kind: 'manual-illustrative-light-receiver', basis: 'visible-paving-review', surveyed: false } }));

// Small visible planting islands in the west plaza remain dark. They are soft
// artistic exclusions and do not participate in actor collision or occlusion.
const plantingIslands = [
  [[559,260],[567,262],[571,266],[569,270],[561,267]],
  [[577,270],[582,270],[585,274],[583,279],[578,277]],
  [[596,277],[601,278],[605,282],[604,287],[599,286],[595,283]],
];
const receivingRegions = [...roadRegions, ...parkingAreas, ...lightReceivingAprons];

function bounds(points, padding = 0) {
  return {
    minX: Math.min(...points.map(p => p[0])) - padding,
    minY: Math.min(...points.map(p => p[1])) - padding,
    maxX: Math.max(...points.map(p => p[0])) + padding,
    maxY: Math.max(...points.map(p => p[1])) + padding,
  };
}
const containsBounds = (x, y, box) => x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;
function segments(points, closed = false) {
  const chain = closed ? [...points, points[0]] : points;
  return chain.slice(1).map(([bx, by], index) => {
    const [ax, ay] = chain[index], dx = bx - ax, dy = by - ay;
    return { ax, ay, dx, dy, lengthSquared: dx * dx + dy * dy };
  }).filter(segment => segment.lengthSquared > 0);
}
function edgeDistance(x, y, edges) {
  let distanceSquared = Infinity;
  for (const edge of edges) {
    const t = clamp01(((x - edge.ax) * edge.dx + (y - edge.ay) * edge.dy) / edge.lengthSquared);
    const dx = x - edge.ax - t * edge.dx, dy = y - edge.ay - t * edge.dy;
    distanceSquared = Math.min(distanceSquared, dx * dx + dy * dy);
  }
  return Math.sqrt(distanceSquared);
}
function compilePolygon(polygon) { return { polygon, bounds: bounds(polygon), edges: segments(polygon, true) }; }
function compileRoute(route) {
  const halfWidth = corridorHalfWidth(route);
  return { halfWidth, bounds: bounds(route.points, halfWidth), edges: segments(route.points) };
}
function bucketKey(x, y) { return `${Math.floor(x / CELL_SIZE)},${Math.floor(y / CELL_SIZE)}`; }
function addToBuckets(map, item) {
  for (let cy = Math.floor(item.bounds.minY / CELL_SIZE); cy <= Math.floor(item.bounds.maxY / CELL_SIZE); cy += 1) {
    for (let cx = Math.floor(item.bounds.minX / CELL_SIZE); cx <= Math.floor(item.bounds.maxX / CELL_SIZE); cx += 1) {
      const key = `${cx},${cy}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    }
  }
}
const receiverBuckets = new Map(), occluderBuckets = new Map(), plantingBuckets = new Map();
for (const region of receivingRegions) addToBuckets(receiverBuckets, compilePolygon(region.polygon));
for (const route of routes) if (!route.regionId) addToBuckets(receiverBuckets, compileRoute(route));
for (const building of buildings) addToBuckets(occluderBuckets, compilePolygon(building.polygon));
for (const polygon of plantingIslands) addToBuckets(plantingBuckets, compilePolygon(polygon));

function registeredCoverage(x, y, key = bucketKey(x, y)) {
  const receivers = receiverBuckets.get(key);
  if (!receivers) return 0;
  const point = [x, y];
  for (const building of occluderBuckets.get(key) ?? []) {
    if (containsBounds(x, y, building.bounds) && pointInPolygon(point, building.polygon)) return 0;
  }
  let coverage = 0;
  for (const receiver of receivers) {
    if (!containsBounds(x, y, receiver.bounds)) continue;
    if (receiver.polygon) {
      if (pointInPolygon(point, receiver.polygon)) coverage = Math.max(coverage, smooth(edgeDistance(x, y, receiver.edges) / 1.8));
    } else {
      coverage = Math.max(coverage, smooth((receiver.halfWidth - edgeDistance(x, y, receiver.edges)) / 1.8));
    }
    if (coverage === 1) break;
  }
  if (!coverage) return 0;
  for (const island of plantingBuckets.get(key) ?? []) {
    if (!containsBounds(x, y, island.bounds)) continue;
    if (pointInPolygon(point, island.polygon)) coverage *= 1 - smooth(edgeDistance(x, y, island.edges) / 1.5);
  }
  return coverage;
}

/** Pure receiver oracle shared by the atlas and actor sampler. Projected
 * building silhouettes mask the image; this is not a physical shadow solver.
 * Custom geometry stays supported for the geometry checks and local tooling.
 */
export function surfaceCoverage(point, options) {
  const [x, y] = xy(point);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  if (!options) return registeredCoverage(x, y);
  const { routeList = routes, regions = receivingRegions, occluders = buildings, feather = 1.4 } = options;
  if (occluders.some(building => pointInPolygon(point, building.polygon))) return 0;
  let coverage = 0;
  for (const region of regions) {
    if (pointInPolygon(point, region.polygon)) coverage = Math.max(coverage, clamp01(edgeDistance(x, y, segments(region.polygon, true)) / feather));
  }
  for (const route of routeList) {
    if (route.regionId) continue;
    const nearest = nearestRoutePoint(point, [route]);
    if (nearest) coverage = Math.max(coverage, clamp01((corridorHalfWidth(route) - nearest.distance) / feather));
  }
  return coverage;
}

// Additional soft entry spill is decorative facade/entrance bounce, tied to
// the already reviewed window-bearing buildings. No measured fixtures, sensor
// observations, photometric calibration or true building depth are implied.
export const entranceLightSources = [
  { id: 'library-west-entry-spill', buildingId: 'library-main', x: 611, y: 263, centerX: 599, centerY: 270, angle: .35, length: 35, breadth: 16, power: 1.05, warmth: .72 },
  { id: 'library-canopy-entry-spill', buildingId: 'library-main', x: 625, y: 291, centerX: 616, centerY: 288, angle: .35, length: 21, breadth: 10, power: .72, warmth: .68 },
  { id: 'library-east-entry-spill', buildingId: 'library-main', x: 708, y: 308, centerX: 713, centerY: 310, angle: -.88, length: 26, breadth: 12, power: 1.05, warmth: .74 },
  { id: 'central-front-entry-spill', buildingId: 'central-front-building-manual', x: 600, y: 402, centerX: 597, centerY: 410, angle: .35, length: 24, breadth: 11, power: .92, warmth: .73 },
].map(source => ({ ...source, provenance: { kind: 'manual-decorative-entrance-spill', surveyed: false } }));

function compileSource(source) {
  const cos = Math.cos(source.angle), sin = Math.sin(source.angle);
  const lobes = source.lobes.map(lobe => {
    const rx = Math.hypot(lobe.length * cos, lobe.breadth * sin);
    const ry = Math.hypot(lobe.length * sin, lobe.breadth * cos);
    return { ...lobe, inverseLengthSquared: 1 / lobe.length ** 2, inverseBreadthSquared: 1 / lobe.breadth ** 2,
      bounds: { minX: lobe.x - rx, maxX: lobe.x + rx, minY: lobe.y - ry, maxY: lobe.y + ry } };
  });
  return { ...source, cos, sin, lobes, bounds: {
    minX: Math.min(...lobes.map(lobe => lobe.bounds.minX)), maxX: Math.max(...lobes.map(lobe => lobe.bounds.maxX)),
    minY: Math.min(...lobes.map(lobe => lobe.bounds.minY)), maxY: Math.max(...lobes.map(lobe => lobe.bounds.maxY)),
  } };
}
const sources = [
  ...lampPoints.map((lamp, index) => {
    const frame = lampSurfaceFrame(lamp), strength = lamp.strength ?? .7;
    return compileSource({ id: `retained-lamp-${index}`, x: lamp.x, y: lamp.y, angle: frame.angle, warmth: .84,
      lobes: [
        { x: lamp.x, y: lamp.y, length: frame.kind === 'local' ? 19 : 30 + strength * 5, breadth: frame.kind === 'local' ? 10 : 12, power: .82 * strength },
        { x: lamp.x, y: lamp.y, length: 10, breadth: 5, power: .55 * strength },
        { x: lamp.x, y: lamp.y, length: 2.4, breadth: 1.5, power: .3 * strength },
      ] });
  }),
  ...entranceLightSources.map(source => compileSource({ ...source,
    lobes: [{ x: source.centerX, y: source.centerY, length: source.length, breadth: source.breadth, power: source.power * 1.1 }],
  })),
];
const sourceBuckets = new Map();
for (const source of sources) addToBuckets(sourceBuckets, source);

// Compact-support smooth inverse-square-like falloff: broad near-source fill,
// a soft roll-off and exact zero outside each reviewed source extent. This one
// equation is used by both baked pixels and live actor material sampling.
function sourceEnergy(x, y, source) {
  if (!containsBounds(x, y, source.bounds)) return 0;
  let energy = 0;
  for (const lobe of source.lobes) {
    if (!containsBounds(x, y, lobe.bounds)) continue;
    const dx = x - lobe.x, dy = y - lobe.y;
    const along = dx * source.cos + dy * source.sin, across = -dx * source.sin + dy * source.cos;
    const radiusSquared = along * along * lobe.inverseLengthSquared + across * across * lobe.inverseBreadthSquared;
    if (radiusSquared < 1) {
      const edge = 1 - radiusSquared;
      energy += lobe.power * edge * edge / (1 + 1.8 * radiusSquared);
    }
  }
  return energy;
}
function localLight(x, y, coverage, candidates, includeDirection) {
  if (!coverage || !candidates?.length) return DARK_SAMPLE();
  let energy = 0, warmEnergy = 0, directionX = 0, directionY = 0;
  for (const source of candidates) {
    const contribution = sourceEnergy(x, y, source);
    if (!contribution) continue;
    energy += contribution; warmEnergy += contribution * source.warmth;
    if (includeDirection) {
      const dx = source.x - x, dy = source.y - y, distance = Math.hypot(dx, dy);
      if (distance > .001) { directionX += dx / distance * contribution; directionY += dy / distance * contribution; }
    }
  }
  if (!energy) return DARK_SAMPLE();
  const length = Math.hypot(directionX, directionY);
  return { intensity: clamp01((1 - Math.exp(-energy)) * coverage), warmth: clamp01(warmEnergy / energy),
    direction: length > .00001 ? { x: directionX / length, y: directionY / length } : { x: 0, y: 0 } };
}

/** Night-local light at a ground/tyre anchor. Direction points TOWARD the
 * weighted source in map screen coordinates. No DOM, day state or global tint;
 * callers keep their original material in daylight or original-light mode.
 */
export function sampleLocalLight(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return DARK_SAMPLE();
  const key = bucketKey(x, y), candidates = sourceBuckets.get(key);
  if (!candidates) return DARK_SAMPLE();
  return localLight(x, y, registeredCoverage(x, y, key), candidates, true);
}

let cachedAtlas;
let cachedSurfaceMask;

/** Final shared alpha mask for GPU effects, applied after blur/bloom. */
export function groundSurfaceMask() {
  if (!cachedSurfaceMask) groundLightAtlas();
  return cachedSurfaceMask;
}

/** Bake only occupied receiver cells, once. The source field and exact feather
 * oracle are the same as sampleLocalLight; no school-raster pixels are read.
 * A bounded translucent warm diffuse layer retains underlying paving texture.
 */
export function groundLightAtlas() {
  if (cachedAtlas) return cachedAtlas;
  const resolution = 2, width = MAP_WIDTH * resolution, height = MAP_HEIGHT * resolution;
  const field = document.createElement('canvas'), mask = document.createElement('canvas');
  field.width = mask.width = width; field.height = mask.height = height;
  const fieldContext = field.getContext('2d'), maskContext = mask.getContext('2d');
  const fieldPixels = fieldContext.createImageData(width, height), maskPixels = maskContext.createImageData(width, height);
  for (const key of receiverBuckets.keys()) {
    const [cx, cy] = key.split(',').map(Number), candidates = sourceBuckets.get(key);
    const minX = Math.max(0, cx * CELL_SIZE * resolution), minY = Math.max(0, cy * CELL_SIZE * resolution);
    const maxX = Math.min(width, (cx + 1) * CELL_SIZE * resolution), maxY = Math.min(height, (cy + 1) * CELL_SIZE * resolution);
    for (let py = minY; py < maxY; py += 1) for (let px = minX; px < maxX; px += 1) {
      const x = (px + .5) / resolution, y = (py + .5) / resolution;
      const coverage = registeredCoverage(x, y, key);
      if (!coverage) continue;
      const offset = (py * width + px) * 4;
      maskPixels.data[offset] = maskPixels.data[offset + 1] = maskPixels.data[offset + 2] = 255;
      maskPixels.data[offset + 3] = Math.round(coverage * 255);
      const light = localLight(x, y, coverage, candidates, false);
      if (!light.intensity) continue;
      fieldPixels.data[offset] = 255;
      fieldPixels.data[offset + 1] = Math.round(236 - light.warmth * 26);
      fieldPixels.data[offset + 2] = Math.round(206 - light.warmth * 45);
      fieldPixels.data[offset + 3] = Math.round(255 * GROUND_DIFFUSE_OPACITY * light.intensity);
    }
  }
  fieldContext.putImageData(fieldPixels, 0, 0); maskContext.putImageData(maskPixels, 0, 0);
  cachedAtlas = field; cachedSurfaceMask = mask;
  return cachedAtlas;
}
