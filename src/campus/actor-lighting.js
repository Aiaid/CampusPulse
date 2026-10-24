// Cached sprite materials. Library mode adds an approximate capsule normal to
// the illustration; neither normals nor fixture heights are surveyed geometry.
import { shadeSceneSurface } from './surface-lighting.js';
const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const clampByte = value => Math.max(0, Math.min(255, Math.round(value)));
const LEVELS = 8;
const DIRECTIONS = 4;
const MAX_FRAME_HEIGHT = 128;
const MAX_FRAME_WIDTH = 160;
const MAX_BASE_FRAMES = 24;
const MAX_VARIANTS = 128;
const MAX_VARIANT_PIXELS = 1800000;
const RAW_ENERGY_LEVELS = [0, .025, .07, .18, .42, .95, 2.2, 5.2];
const READABLE_WALK_PROFILE = 'readable-walk-blue-v1';
const smooth01 = value => { const t = clamp01(value); return t * t * (3 - 2 * t); };

/** A bounded albedo palette for tiny detail-view walking figures. Only bright,
 * strongly blue pixels gain green; dark seams, warm features and neutral detail
 * retain their source RGB. Lighting, tone mapping and alpha stay independent.
 */
export function readableWalkAlbedo(rgb) {
  const [red, green, blue] = rgb;
  const blueMask = smooth01((blue - Math.max(red, green) - 32) / 112);
  const brightMask = smooth01((blue - 48) / 176);
  const lift = Math.min(42 * blueMask * brightMask, Math.max(0, blue * .58 - green));
  return lift > 0 ? [red, clampByte(green + lift), blue] : [red, green, blue];
}

function quantizeIrradiance(value) {
  const target = Math.log1p(Number.isFinite(value) ? Math.max(0, value) : 0);
  let bin = 0;
  for (let index = 1; index < RAW_ENERGY_LEVELS.length; index++) {
    if (Math.abs(Math.log1p(RAW_ENERGY_LEVELS[index]) - target) < Math.abs(Math.log1p(RAW_ENERGY_LEVELS[bin]) - target)) bin = index;
  }
  return bin;
}

function quantizeLightDirection(vector, groundDirection, elevation) {
  let world = vector;
  if (!Array.isArray(world) || world.length !== 3 || !world.every(Number.isFinite)) {
    const horizontal = Math.sqrt(1 - elevation * elevation);
    world = Math.hypot(groundDirection.x, groundDirection.y) > .001
      ? [(.839 * groundDirection.x + .545 * groundDirection.y) * horizontal,
        (-.545 * groundDirection.x + .839 * groundDirection.y) * horizontal, elevation] : [0, 0, 0];
  }
  const length = Math.hypot(...world);
  if (!Number.isFinite(length) || length < 1e-9) return { key: 'none', vector: [0, 0, 0] };
  // Negative elevations retain ground-bounce directions below an actor's torso.
  const vertical = Math.round(Math.max(-1, Math.min(1, world[2] / length)) * 4);
  const azimuth = Math.abs(vertical) === 4 ? 0
    : ((Math.round(Math.atan2(world[1], world[0]) / (Math.PI / 4)) % 8) + 8) % 8;
  const z = vertical / 4, horizontal = Math.sqrt(1 - z * z), angle = azimuth * Math.PI / 4;
  return { key: `${azimuth}:${vertical}`, vector: [Math.cos(angle) * horizontal, Math.sin(angle) * horizontal, z] };
}

/** Runtime samples provide raw energy. Small manual/legacy samples can invert
 * the field's intensity curve, but never feed compressed intensity to shading.
 */
function rawActorLight(sample) {
  const names = ['directIrradiance', 'indirectIrradiance', 'facadeIrradiance'];
  if (names.some(name => sample[name] !== undefined)) return names.map(name => sample[name] ?? 0);
  const intensity = Math.min(.999, clamp01(sample.surfaceFallbackIntensity ?? sample.intensity));
  const total = -Math.log1p(-intensity) / 1.25;
  const parts = (sample.surfaceFallbackParts ?? [sample.directIntensity, sample.indirectIntensity, sample.facadeIntensity]).map(value => clamp01(value));
  const sum = parts.reduce((energy, value) => energy + value, 0);
  return sum ? parts.map(value => total * value / sum) : [total, 0, 0];
}

/** Cross-fade incident energy and source direction at the prototype boundary. */
export function blendActorLight(previous, local, amount) {
  const blend = clamp01(amount), oldEnergy = clamp01(previous.intensity) * (1 - blend);
  const newEnergy = clamp01(local.intensity) * blend, intensity = oldEnergy + newEnergy;
  const dx = (previous.direction?.x || 0) * oldEnergy + (local.direction?.x || 0) * newEnergy;
  const dy = (previous.direction?.y || 0) * oldEnergy + (local.direction?.y || 0) * newEnergy;
  const length = Math.hypot(dx, dy);
  // Broad window/ground fill shades the capsule, while only direct fixtures
  // determine a sharp cast shadow. Keep both direction fields independent.
  const oldDirect = clamp01(previous.directIntensity ?? previous.intensity) * (1 - blend);
  const newDirect = clamp01(local.directIntensity ?? local.intensity) * blend;
  const groundX = (previous.groundDirection?.x ?? previous.direction?.x ?? 0) * oldDirect + (local.groundDirection?.x ?? local.direction?.x ?? 0) * newDirect;
  const groundY = (previous.groundDirection?.y ?? previous.direction?.y ?? 0) * oldDirect + (local.groundDirection?.y ?? local.direction?.y ?? 0) * newDirect;
  const groundLength = Math.hypot(groundX, groundY);
  const oldSurface = previous.surfaceGroundDirection ?? previous.groundDirection ?? previous.direction;
  const newSurface = local.surfaceGroundDirection ?? local.groundDirection ?? local.direction;
  const surfaceX = (Number.isFinite(oldSurface?.x) ? oldSurface.x : 0) * oldEnergy + (Number.isFinite(newSurface?.x) ? newSurface.x : 0) * newEnergy;
  const surfaceY = (Number.isFinite(oldSurface?.y) ? oldSurface.y : 0) * oldEnergy + (Number.isFinite(newSurface?.y) ? newSurface.y : 0) * newEnergy;
  const surfaceLength = Math.hypot(surfaceX, surfaceY);
  const surfaceElevation = intensity ? (clamp01(previous.surfaceElevation ?? previous.elevation ?? .6) * oldEnergy
    + clamp01(local.surfaceElevation ?? local.elevation ?? .6) * newEnergy) / intensity : 0;
  return { ...local, intensity, warmth: intensity ? (clamp01(previous.warmth) * oldEnergy + clamp01(local.warmth) * newEnergy) / intensity : 0,
    direction: length > .0001 ? { x: dx / length, y: dy / length } : { x: 0, y: 0 },
    groundDirection: groundLength > .0001 ? { x: groundX / groundLength, y: groundY / groundLength } : { x: 0, y: 0 },
    directIntensity: oldDirect + newDirect,
    surfaceGroundDirection: surfaceLength > .0001 ? { x: surfaceX / surfaceLength, y: surfaceY / surfaceLength } : { x: 0, y: 0 },
    surfaceElevation,
    // The ROI mixes completed material outputs. Keep the old source material
    // and the full local raw field, rather than attenuating local energy twice.
    legacyIntensity: previous.intensity, legacyWarmth: previous.warmth, legacyDirection: previous.direction,
    surfaceFallbackIntensity: local.intensity,
    surfaceFallbackParts: [local.directIntensity, local.indirectIntensity, local.facadeIntensity],
    surfaceShading: blend > 0, surfaceMix: blend };
}

/** Pure, quantized material shared by people, riding and parked vehicles.
 * Direction points from the feet/tyres toward the dominant local light.
 */
export function actorLightMaterial(sample = {}, { kind, readable = false } = {}) {
  const surfaceShading = Boolean(sample.surfaceShading);
  const readableWalk = surfaceShading && kind === 'walk' && Boolean(readable);
  const surfaceMix = surfaceShading ? Math.round(clamp01(sample.surfaceMix ?? 1) * 4) / 4 : 0;
  const level = Math.round(clamp01(sample.intensity) * (LEVELS - 1));
  const warmthLevel = Math.round(clamp01(sample.warmth) * 2);
  const sourceDirection = surfaceShading ? sample.surfaceGroundDirection ?? sample.groundDirection ?? sample.direction : sample.direction;
  const sourceX = Number.isFinite(sourceDirection?.x) ? sourceDirection.x : 0;
  const sourceY = Number.isFinite(sourceDirection?.y) ? sourceDirection.y : 0;
  const directionCount = surfaceShading ? 8 : DIRECTIONS;
  const directionBin = level && Math.hypot(sourceX, sourceY) > .001
    ? ((Math.round(Math.atan2(sourceY, sourceX) / (Math.PI * 2 / directionCount)) % directionCount) + directionCount) % directionCount
    : directionCount;
  const angle = directionBin * Math.PI * 2 / directionCount;
  const direction = directionBin === directionCount ? { x: 0, y: 0 } : surfaceShading
    ? { x: Math.cos(angle), y: Math.sin(angle) }
    : { x: Math.round(Math.cos(angle)), y: Math.round(Math.sin(angle)) };
  const elevationLevel = surfaceShading ? Math.round(clamp01(sample.surfaceElevation ?? sample.elevation ?? .6) * 4) : 0;
  const intensity = level / (LEVELS - 1), warmth = warmthLevel / 2;
  const energyBins = surfaceShading ? rawActorLight(sample).map(quantizeIrradiance) : null;
  const lightDirection = surfaceShading ? quantizeLightDirection(sample.surfaceLightDirection, direction, elevationLevel / 4) : null;
  const surfaceLight = energyBins ? { directIrradiance: RAW_ENERGY_LEVELS[energyBins[0]],
    indirectIrradiance: RAW_ENERGY_LEVELS[energyBins[1]], facadeIrradiance: RAW_ENERGY_LEVELS[energyBins[2]],
    surfaceLightDirection: lightDirection.vector } : null;
  const legacy = surfaceShading ? actorLightMaterial({ intensity: sample.legacyIntensity ?? sample.intensity,
    warmth: sample.legacyWarmth ?? sample.warmth, direction: sample.legacyDirection ?? sample.direction }) : null;
  // A cool, still readable unlit figure gains restrained warm exposure. Channel
  // multiplication retains the original blue/orange material identities.
  const exposure = .74 + intensity * .38;
  const warm = intensity * warmth;
  return {
    key: surfaceShading ? `surface:${level}:${warmthLevel}:${directionBin}:${elevationLevel}:${surfaceMix}:${energyBins.join(',')}:${lightDirection.key}:${legacy.key}${readableWalk ? `:${READABLE_WALK_PROFILE}` : ''}` : `${level}:${warmthLevel}:${directionBin}`,
    level, warmthLevel, directionBin, direction, intensity, warmth, exposure,
    surfaceShading, surfaceMix, readableWalk, elevation: elevationLevel / 4,
    surfaceLight, legacy,
    channels: [.84 + warm * .24, .94 + warm * .07, 1.08 - warm * .15],
    rimStrength: warm * (.105 - .03 * surfaceMix),
  };
}

/** Billboard capsule: x is left/right, y is up, z faces the viewer. Source
 * alpha row bounds supply u, preserving the original figure and bicycle art.
 */
export function actorSurfaceNormal(u, v) {
  const x = (clamp01(u) * 2 - 1) * .94;
  const cap = v < .2 ? (1 - clamp01(v / .2)) : v > .84 ? -(clamp01((v - .84) / .16)) : 0;
  const y = cap * Math.sqrt(1 - x * x) * .88;
  return { x, y, z: Math.sqrt(Math.max(0, 1 - x * x - y * y)) };
}

/** Billboard right/viewer/up axes mapped to the shared world-Z-up shader. */
export function actorWorldNormal(normal) {
  const vector = [.839 * normal.x + .545 * normal.z, -.545 * normal.x + .839 * normal.z, normal.y];
  const length = Math.hypot(...vector) || 1;
  return vector.map(value => value / length);
}

/** Dot product against the shared source. Map +y is towards the viewer; source
 * elevation supplies the vertical component rather than a screen-space glow.
 */
export function actorSurfaceFacing(normal, material) {
  const elevation = clamp01(material.elevation);
  const horizontal = Math.sqrt(1 - elevation * elevation);
  // Elevation is sin(altitude). Ground direction carries only the horizontal
  // source component, so height is applied once in this billboard basis.
  return clamp01(normal.x * material.direction.x * horizontal + normal.y * elevation + normal.z * material.direction.y * horizontal);
}

/** Shadow vector stays registered to the tyre/foot anchor and points away from
 * direct fixtures only; broad window/bounce fill adds no hard shadow. Existing
 * fields remain the fallback. Heights/distances are illustrative map units.
 */
export function actorShadow(sample, actorHeight) {
  const direction = sample.groundDirection ?? sample.direction;
  const dx = Number.isFinite(direction?.x) ? direction.x : 0;
  const dy = Number.isFinite(direction?.y) ? direction.y : 0;
  const directionLength = Math.hypot(dx, dy);
  const intensity = clamp01(sample.directIntensity ?? sample.intensity);
  if (directionLength < .001 || intensity < .025) return null;
  const sourceHeight = Math.max(actorHeight * 1.2, Number.isFinite(sample.sourceHeight) ? sample.sourceHeight : 9);
  const distance = Number.isFinite(sample.groundSourceDistance) ? Math.max(0, sample.groundSourceDistance)
    : Number.isFinite(sample.sourceDistance) ? Math.max(0, sample.sourceDistance) : 8;
  const length = Math.max(actorHeight * .24, Math.min(actorHeight * 2.1, actorHeight * distance / sourceHeight));
  return { x: -dx / directionLength * length, y: -dy / directionLength * length,
    length, alpha: .11 + intensity * .19 };
}

/** Ground contact is a small ambient-occlusion proxy, not another light/cast
 * direction. Dimensions come from the existing alpha-cropped sprite in world
 * units; contacts stay at feet/tyres even when only broad facade fill remains.
 */
export function actorGroundShadows(sample, actorWidth, actorHeight, {
  blend = 1, coverage = 1, kind = 'walk', heading = 0, parked = false,
} = {}) {
  const amount = clamp01(blend), ground = clamp01(coverage);
  if (![actorWidth, actorHeight].every(value => Number.isFinite(value) && value > 0)
      || amount < .03 || !ground) return { cast: null, contacts: [] };
  const cast = actorShadow(sample ?? {}, actorHeight);
  const opacity = (kind === 'walk' ? .26 : parked ? .22 : .24) * amount * ground;
  if (kind === 'walk') return { cast, contacts: [{ x: 0, y: 0,
    radiusX: Math.max(actorHeight * .1, Math.min(actorWidth * .31, actorHeight * .22)),
    radiusY: actorHeight * .052, alpha: opacity }] };
  const angle = (Number.isFinite(heading) ? heading : 0) * Math.PI / 180;
  const span = Math.min(actorWidth * .55, actorHeight * .8);
  const dx = Math.cos(angle) * span / 2, dy = Math.sin(angle) * span / 2;
  // The lower tyre touches the alpha-cropped image's bottom. Its partner is
  // further up the projected wheel axis, never beneath the ground anchor.
  return { cast, contacts: [-1, 1].map(side => ({ x: dx * side, y: dy * side - Math.abs(dy),
    radiusX: actorHeight * .08, radiusY: actorHeight * .035, alpha: opacity })) };
}

/** Pure RGB mapping. Alpha is intentionally handled separately and unchanged.
 * edge and facing are 0..1, derived from the source silhouette and light side.
 */
export function toneActorPixel(rgb, material, edge = 0, facing = .5, legacyEdge = edge, legacyFacing = facing, normal = { x: 0, y: 0, z: 1 }) {
  if (material.surfaceShading) {
    if (!material.surfaceMix) return toneActorPixel(rgb, material.legacy, legacyEdge, legacyFacing);
    const albedo = material.readableWalk ? readableWalkAlbedo(rgb) : rgb;
    const shared = shadeSceneSurface(albedo, actorWorldNormal(normal), material.surfaceLight, {
      // The field already averages upright incidence. This restrained capsule
      // variation is material orientation, not a second normal-dot-light term.
      facing: .55 + .45 * clamp01(facing), ambientScale: 1.2, roughness: .75, dielectricF0: .04,
    });
    if (material.surfaceMix === 1) return shared;
    const oldRgb = toneActorPixel(rgb, material.legacy, legacyEdge, legacyFacing);
    return oldRgb.map((value, axis) => clampByte(value * (1 - material.surfaceMix) + shared[axis] * material.surfaceMix));
  }
  const originalSide = 1 - material.intensity * .045 + material.intensity * .09 * clamp01(facing);
  const rim = material.rimStrength * clamp01(edge);
  const warmEdge = [255, 190, 106];
  return rgb.slice(0, 3).map((value, channel) => clampByte(
    value * material.exposure * material.channels[channel] * originalSide * (1 - rim) + warmEdge[channel] * rim,
  ));
}

const baseFrames = new Map();
const variants = new Map();
let variantPixels = 0;
function rememberBase(key, entry) {
  baseFrames.set(key, entry);
  while (baseFrames.size > MAX_BASE_FRAMES) baseFrames.delete(baseFrames.keys().next().value);
}
function sourceFrame(image, frame) {
  const key = `${image.currentSrc || image.src}|${image.naturalWidth}x${image.naturalHeight}|${frame.x},${frame.y},${frame.width},${frame.height}`;
  if (baseFrames.has(key)) {
    const entry = baseFrames.get(key);
    baseFrames.delete(key); baseFrames.set(key, entry);
    return entry;
  }
  const factor = Math.min(1, MAX_FRAME_HEIGHT / frame.height, MAX_FRAME_WIDTH / frame.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(frame.width * factor));
  canvas.height = Math.max(1, Math.round(frame.height * factor));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, frame.x, frame.y, frame.width, frame.height, 0, 0, canvas.width, canvas.height);
  // The only pixel read is once per small source frame, never in the draw loop.
  let pixels;
  try { pixels = context.getImageData(0, 0, canvas.width, canvas.height).data; }
  catch { return null; }
  const rowBounds = [];
  for (let y = 0; y < canvas.height; y += 1) {
    let left = canvas.width, right = -1;
    for (let x = 0; x < canvas.width; x += 1) if (pixels[(y * canvas.width + x) * 4 + 3] > 24) {
      left = Math.min(left, x); right = Math.max(right, x);
    }
    rowBounds.push([left, right]);
  }
  const entry = { key, width: canvas.width, height: canvas.height, pixels, rowBounds };
  rememberBase(key, entry);
  return entry;
}

/** Return a small cached frame for both independently zoomed map canvases.
 * URL/frame identity and material buckets, never map zoom, define the cache.
 */
export function litActorFrame(image, frame, material) {
  if (typeof document === 'undefined') return null;
  const base = sourceFrame(image, frame);
  if (!base) return null;
  const key = `${base.key}|${material.key}`;
  if (variants.has(key)) {
    const canvas = variants.get(key);
    variants.delete(key); variants.set(key, canvas);
    return canvas;
  }
  const canvas = document.createElement('canvas');
  canvas.width = base.width; canvas.height = base.height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const output = context.createImageData(base.width, base.height);
  const { x: dx, y: dy } = material.direction;
  const alphaAt = (x, y) => x < 0 || x >= base.width || y < 0 || y >= base.height ? 0 : base.pixels[(y * base.width + x) * 4 + 3];
  for (let y = 0; y < base.height; y += 1) for (let x = 0; x < base.width; x += 1) {
    const index = (y * base.width + x) * 4, alpha = base.pixels[index + 3];
    output.data[index + 3] = alpha;
    if (!alpha) continue;
    const edge = Math.max(0, alpha - alphaAt(x + Math.round(dx * 2), y + Math.round(dy * 2))) / 255;
    const [left, right] = base.rowBounds[y];
    const normal = material.surfaceShading ? actorSurfaceNormal((x - left) / Math.max(1, right - left), y / Math.max(1, base.height - 1)) : undefined;
    const facing = material.surfaceShading
      ? actorSurfaceFacing(normal, material)
      : clamp01(.5 + .5 * ((x / Math.max(1, base.width - 1) - .5) * dx * 2 + (y / Math.max(1, base.height - 1) - .5) * dy * 2));
    const legacy = material.legacy;
    const legacyEdge = legacy && material.surfaceMix < 1
      ? Math.max(0, alpha - alphaAt(x + Math.round(legacy.direction.x * 2), y + Math.round(legacy.direction.y * 2))) / 255 : edge;
    const legacyFacing = legacy && material.surfaceMix < 1
      ? clamp01(.5 + .5 * ((x / Math.max(1, base.width - 1) - .5) * legacy.direction.x * 2 + (y / Math.max(1, base.height - 1) - .5) * legacy.direction.y * 2)) : facing;
    const rgb = toneActorPixel([base.pixels[index], base.pixels[index + 1], base.pixels[index + 2]], material, edge, facing, legacyEdge, legacyFacing, normal);
    output.data[index] = rgb[0]; output.data[index + 1] = rgb[1]; output.data[index + 2] = rgb[2];
  }
  context.putImageData(output, 0, 0);
  variants.set(key, canvas); variantPixels += canvas.width * canvas.height;
  while (variants.size > MAX_VARIANTS || variantPixels > MAX_VARIANT_PIXELS) {
    const oldest = variants.keys().next().value, entry = variants.get(oldest);
    variantPixels -= entry.width * entry.height; variants.delete(oldest);
  }
  return canvas;
}

export function actorLightingCacheStats() {
  return { baseFrames: baseFrames.size, variants: variants.size, variantPixels, maxVariants: MAX_VARIANTS, maxVariantPixels: MAX_VARIANT_PIXELS };
}
