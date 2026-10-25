/** Runtime-only approximate reflectance from official ungraded GIS tiles.
 * No historical tile is imported, downloaded to disk, or bundled. Broad source
 * lighting and material color cannot be separated exactly from one image;
 * bounded local luminance normalization preserves source detail, not truth.
 */
import { visibleGisTiles } from './gis-tiles.js';
import { LIBRARY_BOUNDS } from './library-lighting.js';
import { decodeSceneColor } from './surface-lighting.js';

const RESOLUTION = 3;
const LOAD_TIMEOUT_MS = 8000;
const TILE_ORIGIN = (import.meta.env?.VITE_GIS_TILE_ORIGIN || 'https://gis.ccnu.edu.cn').replace(/\/$/, '');
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
const linearSrgb = value => value <= .0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - .055;
const luminance = color => .2126 * color[0] + .7152 * color[1] + .0722 * color[2];
export const GIS_MATERIAL_PROFILES = Object.freeze({
  roof: Object.freeze({ targetY: .34, normalizationStrength: .72, blueNeutralization: .16, coolNeutralization: 0 }),
  canopy: Object.freeze({ targetY: .30, normalizationStrength: .68, blueNeutralization: .13, coolNeutralization: 0 }),
  wall: Object.freeze({ targetY: .32, normalizationStrength: .65, blueNeutralization: .08, coolNeutralization: .6 }),
});
let state = Object.freeze({ ready: false, status: 'idle', revision: 0, width: 0, height: 0,
  resolution: RESOLUTION, tileCount: 0, provenance: 'runtime-official-gis-approximate-reflectance' });
let prepared = null, loading = null;
const listeners = new Set();

export function gisMaterialState() { return state; }
/** Structured-cloneable CPU state. Artwork stays on the main thread. The
 * executor copies these arrays once per worker/revision, never transfers the
 * live samplers' buffers away from actors or subsequent renders. */
export function gisMaterialSnapshot() { return { state, prepared }; }
export function installGisMaterialSnapshot(snapshot) {
  state = Object.freeze({ ...snapshot.state }); prepared = snapshot.prepared;
}
export function subscribeGisMaterial(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function publish(next) {
  state = Object.freeze({ ...state, ...next });
  for (const listener of listeners) listener(state);
}

/** Exact existing GIS registration; zoom2 gives 4 source pixels/map unit. */
export function gisMaterialTiles() {
  const { left, top, width, height } = LIBRARY_BOUNDS;
  return visibleGisTiles({ level: 2, width: width * RESOLUTION, height: height * RESOLUTION,
    scale: RESOLUTION, translateX: -left * RESOLUTION, translateY: -top * RESOLUTION, overscan: 0 });
}

/** Alpha-weighted summed-area mean keeps the preparation linear in ROI size.
 * The radius is deliberately much wider than roof ribs/door seams. Clipped
 * edge windows are normalized by their actual covered area, without wrapping.
 */
function lowFrequencyLuminance(linear, alpha, width, height, radius) {
  const stride = width + 1;
  const sum = new Float64Array(stride * (height + 1)), weight = new Float64Array(sum.length);
  for (let y = 0; y < height; y++) {
    let rowSum = 0, rowWeight = 0;
    for (let x = 0; x < width; x++) {
      const index = y * width + x, offset = index * 3, a = alpha[index];
      rowSum += (.2126 * linear[offset] + .7152 * linear[offset + 1] + .0722 * linear[offset + 2]) * a;
      rowWeight += a;
      const target = (y + 1) * stride + x + 1;
      sum[target] = sum[target - stride] + rowSum;
      weight[target] = weight[target - stride] + rowWeight;
    }
  }
  const result = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const left = Math.max(0, x - radius), right = Math.min(width, x + radius + 1);
    const top = Math.max(0, y - radius), bottom = Math.min(height, y + radius + 1);
    const a = top * stride + left, b = top * stride + right, c = bottom * stride + left, d = bottom * stride + right;
    const covered = weight[d] - weight[b] - weight[c] + weight[a];
    result[y * width + x] = covered > 1e-9 ? (sum[d] - sum[b] - sum[c] + sum[a]) / covered : 0;
  }
  return result;
}

/** Pure preparation for the one decoded ROI; no browser or network required. */
export function prepareGisMaterial({ width, height, data }, { bounds = LIBRARY_BOUNDS, resolution = RESOLUTION } = {}) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2
    || !data || data.length !== width * height * 4 || !Number.isFinite(resolution) || resolution <= 0
    || !bounds || ![bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0
    || Math.abs(width - bounds.width * resolution) > 1 || Math.abs(height - bounds.height * resolution) > 1) return null;
  const linear = new Float32Array(width * height * 3), alpha = new Float32Array(width * height);
  let covered = 0;
  for (let index = 0; index < width * height; index++) {
    const source = index * 4;
    const color = decodeSceneColor([data[source], data[source + 1], data[source + 2]]);
    linear.set(color, index * 3); alpha[index] = data[source + 3] / 255; covered += alpha[index];
  }
  if (covered < 1) return null;
  const lowFrequency = lowFrequencyLuminance(linear, alpha, width, height, Math.max(2, Math.round(resolution * 6)));
  return { width, height, resolution, bounds: { ...bounds }, linear, alpha, lowFrequency };
}

/** Sample original detail in linear RGB, then remove only part of broad source
 * illumination. Near-black lines cannot gain exposure. A small optional blue
 * reduction only affects blue-biased pixels, preserving hue order and Y.
 */
export function samplePreparedGisMaterial(material, x, y, options = {}) {
  if (!material || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const { width, height, bounds, resolution, linear, alpha, lowFrequency } = material;
  if (x < bounds.left || y < bounds.top || x >= bounds.left + bounds.width || y >= bounds.top + bounds.height) return null;
  const px = clamp((x - bounds.left) * resolution - .5, 0, width - 1);
  const py = clamp((y - bounds.top) * resolution - .5, 0, height - 1);
  const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0;
  let a = 0, broad = 0;
  const color = [0, 0, 0];
  for (let row = 0; row < 2; row++) for (let column = 0; column < 2; column++) {
    const index = Math.min(height - 1, y0 + row) * width + Math.min(width - 1, x0 + column);
    const weight = (column ? fx : 1 - fx) * (row ? fy : 1 - fy) * alpha[index];
    a += weight; broad += lowFrequency[index] * weight;
    for (let axis = 0; axis < 3; axis++) color[axis] += linear[index * 3 + axis] * weight;
  }
  if (a < 1 / 255) return { linearAlbedo: [0, 0, 0], baseColorRGB: [0, 0, 0], alpha: 0 };
  for (let axis = 0; axis < 3; axis++) color[axis] /= a;
  broad /= a;
  const profile = GIS_MATERIAL_PROFILES[options.kind] ?? GIS_MATERIAL_PROFILES.roof;
  const targetY = Number.isFinite(options.targetY) ? clamp(options.targetY, .05, .8) : profile.targetY;
  const strength = Number.isFinite(options.normalizationStrength) ? clamp(options.normalizationStrength) : profile.normalizationStrength;
  const neutralization = Number.isFinite(options.blueNeutralization) ? clamp(options.blueNeutralization, 0, .3) : profile.blueNeutralization;
  const coolNeutralization = Number.isFinite(options.coolNeutralization) ? clamp(options.coolNeutralization, 0, .8) : profile.coolNeutralization;
  const sourceY = luminance(color);
  const rawGain = clamp((targetY / Math.max(.035, broad)) ** strength, .55, 2.2);
  // Preserve dark roof ribs, door seams and occlusion lines. Normalization is
  // not permission to turn a dark feature into a mid-gray reflective surface.
  const gain = rawGain <= 1 ? rawGain : 1 + (rawGain - 1) * smooth((sourceY - .006) / .054);
  const blueBias = Math.max(0, color[2] - Math.max(color[0], color[1]) * 1.08);
  const blueMix = neutralization * clamp(blueBias / Math.max(.025, sourceY));
  // Preserved door/glass bands contain baked sky reflection as cyan as well
  // as blue. Require BOTH cool channels to dominate red and remain reasonably
  // balanced: pure green paint/foliage and warm masonry must not be grayed out.
  // This is a material-specific source-cast approximation, not albedo recovery.
  const coolMean = (color[1] + color[2]) * .5;
  const coolExcess = smooth(((coolMean - color[0]) / Math.max(.025, color[0]) - .08) / .6);
  const pairedCool = Math.min(color[1], color[2]) > color[0] * 1.02
    ? smooth((Math.min(color[1], color[2]) / Math.max(.025, color[1], color[2]) - .5) / .3) : 0;
  const coolMix = coolNeutralization * coolExcess * pairedCool * smooth((sourceY - .006) / .04);
  // Both operations mix toward the ORIGINAL linear luminance. Combining the
  // weights this way preserves Y and existing normalization/detail contrast.
  const neutralMix = coolMix > 0 ? 1 - (1 - blueMix) * (1 - coolMix) : blueMix;
  const linearAlbedo = color.map(value => clamp((value * (1 - neutralMix) + sourceY * neutralMix) * gain, 0, .92));
  return { linearAlbedo, baseColorRGB: linearAlbedo.map(value => Math.round(255 * clamp(linearSrgb(value)))), alpha: clamp(a) };
}

export function sampleGisMaterial(x, y, options = {}) {
  return samplePreparedGisMaterial(prepared, x, y, options);
}

/** Independent anonymous image requests never mutate ordinary map images.
 * The whole load has one 8-second deadline. Only after every minimal ROI tile
 * succeeds is the bounded canvas read once; failed/CORS-tainted loads settle
 * to fallback without pixel output, retries, files or partial material state.
 */
export function loadGisMaterial() {
  if (loading) return loading;
  if (typeof Image === 'undefined' || typeof document === 'undefined') return Promise.resolve(state);
  const tiles = gisMaterialTiles();
  publish({ status: 'loading', tileCount: tiles.length });
  loading = new Promise(resolve => {
    const images = [];
    let finished = false, loaded = 0;
    const finish = material => {
      if (finished) return;
      finished = true; clearTimeout(deadline);
      for (const image of images) { image.onload = null; image.onerror = null; }
      if (material) {
        prepared = material;
        publish({ ready: true, status: 'ready', revision: state.revision + 1, width: material.width, height: material.height });
      } else publish({ ready: false, status: 'fallback' });
      resolve(state);
    };
    const deadline = setTimeout(() => finish(null), LOAD_TIMEOUT_MS);
    const compose = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(LIBRARY_BOUNDS.width * RESOLUTION);
        canvas.height = Math.ceil(LIBRARY_BOUNDS.height * RESOLUTION);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return finish(null);
        context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
        tiles.forEach((tile, index) => context.drawImage(images[index],
          (tile.x - LIBRARY_BOUNDS.left) * RESOLUTION, (tile.y - LIBRARY_BOUNDS.top) * RESOLUTION,
          tile.size * RESOLUTION, tile.size * RESOLUTION));
        finish(prepareGisMaterial(context.getImageData(0, 0, canvas.width, canvas.height)));
      } catch { finish(null); }
    };
    if (!tiles.length) return finish(null);
    try {
      for (const tile of tiles) {
        if (finished) break;
        const image = new Image(); images.push(image);
        image.crossOrigin = 'anonymous'; image.decoding = 'async';
        image.onerror = () => finish(null);
        image.onload = () => {
          if (finished) return;
          if (!image.naturalWidth || !image.naturalHeight) return finish(null);
          if (++loaded === tiles.length) compose();
        };
        image.src = `${TILE_ORIGIN}/mapdata/zoom${tile.key}.jpg`;
      }
    } catch { finish(null); }
  });
  return loading;
}
