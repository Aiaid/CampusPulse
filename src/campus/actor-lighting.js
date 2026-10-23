// Cached 2.5D sprite materials. These approximate local light on illustration
// pixels; they are not surface normals, physical shading, or surveyed lighting.
const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const clampByte = value => Math.max(0, Math.min(255, Math.round(value)));
const LEVELS = 8;
const DIRECTIONS = 4;
const MAX_FRAME_HEIGHT = 128;
const MAX_FRAME_WIDTH = 160;
const MAX_BASE_FRAMES = 24;
const MAX_VARIANTS = 128;
const MAX_VARIANT_PIXELS = 1800000;

/** Pure, quantized material shared by people, riding and parked vehicles.
 * Direction points from the feet/tyres toward the dominant local light.
 */
export function actorLightMaterial(sample = {}) {
  const level = Math.round(clamp01(sample.intensity) * (LEVELS - 1));
  const warmthLevel = Math.round(clamp01(sample.warmth) * 2);
  const sourceX = Number.isFinite(sample.direction?.x) ? sample.direction.x : 0;
  const sourceY = Number.isFinite(sample.direction?.y) ? sample.direction.y : 0;
  const directionBin = level && Math.hypot(sourceX, sourceY) > .001
    ? ((Math.round(Math.atan2(sourceY, sourceX) / (Math.PI * 2 / DIRECTIONS)) % DIRECTIONS) + DIRECTIONS) % DIRECTIONS
    : DIRECTIONS;
  const angle = directionBin * Math.PI * 2 / DIRECTIONS;
  const direction = directionBin === DIRECTIONS ? { x: 0, y: 0 } : { x: Math.round(Math.cos(angle)), y: Math.round(Math.sin(angle)) };
  const intensity = level / (LEVELS - 1), warmth = warmthLevel / 2;
  // A cool, still readable unlit figure gains restrained warm exposure. Channel
  // multiplication retains the original blue/orange material identities.
  const exposure = .74 + intensity * .38;
  const warm = intensity * warmth;
  return {
    key: `${level}:${warmthLevel}:${directionBin}`,
    level, warmthLevel, directionBin, direction, intensity, warmth, exposure,
    channels: [.84 + warm * .24, .94 + warm * .07, 1.08 - warm * .15],
    rimStrength: warm * .105,
  };
}

/** Pure RGB mapping. Alpha is intentionally handled separately and unchanged.
 * edge and facing are 0..1, derived from the source silhouette and light side.
 */
export function toneActorPixel(rgb, material, edge = 0, facing = .5) {
  const side = 1 - material.intensity * .045 + material.intensity * .09 * clamp01(facing);
  const rim = material.rimStrength * clamp01(edge);
  const warmEdge = [255, 190, 106];
  return rgb.slice(0, 3).map((value, channel) => clampByte(
    value * material.exposure * material.channels[channel] * side * (1 - rim) + warmEdge[channel] * rim,
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
  const entry = { key, width: canvas.width, height: canvas.height, pixels };
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
    const edge = Math.max(0, alpha - alphaAt(x + dx * 2, y + dy * 2)) / 255;
    const facing = clamp01(.5 + .5 * ((x / Math.max(1, base.width - 1) - .5) * dx * 2 + (y / Math.max(1, base.height - 1) - .5) * dy * 2));
    const rgb = toneActorPixel([base.pixels[index], base.pixels[index + 1], base.pixels[index + 2]], material, edge, facing);
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
