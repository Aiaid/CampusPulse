/** Authored illustrative facade bitmap, never sampled from the school GIS. */
import { decodeSceneColor } from './surface-lighting.js';
const ASSET_URL = '/assets/library-facade-material-v1.png';
const MAX_CELL_SIZE = 512;
const clamp01 = value => Math.max(0, Math.min(1, value));
const wrap = (value, size) => ((value % size) + size) % size;
let state = Object.freeze({ ready: false, status: 'idle', revision: 0, width: 0, height: 0, warmEmissionNormalization: 1 });
let prepared = null, artwork = null, loading = null;
const listeners = new Set();

export function buildingMaterialState() { return state; }
export function buildingMaterialArtwork() { return artwork; }
export function subscribeBuildingMaterial(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function publish(next) {
  state = Object.freeze({ ...state, ...next });
  for (const listener of listeners) listener(state);
}

/** Pane-local interior emission excludes the generated frame. This mask never
 * changes the actual registered pane polygon or turns structural bands on.
 */
export function buildingEmissionMask(u, v) {
  if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) return 0;
  const distance = Math.min(u, v, 1 - u, 1 - v);
  const t = clamp01((distance - .025) / .025);
  return t * t * (3 - 2 * t);
}

/** Invert the true ordered quad (top-left, top-right, bottom-right, bottom-left).
 * Registered orthographic walls take the exact affine path. Slightly tapered
 * convex quads use a bounded bilinear solve. Return unclamped coordinates so
 * callers can identify and preserve door/sill details outside the window band.
 */
export function facadeUv(quad, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Array.isArray(quad) || quad.length !== 4
    || !quad.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) return null;
  const [a, b, c, d] = quad;
  const bx = b[0] - a[0], by = b[1] - a[1], cx = d[0] - a[0], cy = d[1] - a[1];
  const dx = a[0] - b[0] + c[0] - d[0], dy = a[1] - b[1] + c[1] - d[1];
  const determinant = bx * cy - by * cx;
  const scale = Math.max(1, Math.hypot(bx, by) * Math.hypot(cx, cy));
  if (Math.abs(determinant) < 1e-10 * scale) return null;
  let u = ((x - a[0]) * cy - (y - a[1]) * cx) / determinant;
  let v = (bx * (y - a[1]) - by * (x - a[0])) / determinant;
  if (Math.hypot(dx, dy) < 1e-10) return [u, v];
  // Reject folded or singular cells before the Newton iteration.
  for (const [cu, cv] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const jacobian = (bx + dx * cv) * (cy + dy * cu) - (by + dy * cv) * (cx + dx * cu);
    if (jacobian * determinant <= 0 || Math.abs(jacobian) < 1e-10 * scale) return null;
  }
  for (let iteration = 0; iteration < 10; iteration++) {
    const rx = a[0] + bx * u + cx * v + dx * u * v - x;
    const ry = a[1] + by * u + cy * v + dy * u * v - y;
    if (Math.hypot(rx, ry) < 1e-8) return [u, v];
    const ux = bx + dx * v, uy = by + dy * v, vx = cx + dx * u, vy = cy + dy * u;
    const jacobian = ux * vy - uy * vx;
    if (Math.abs(jacobian) < 1e-10 * scale) return null;
    u -= (rx * vy - ry * vx) / jacobian;
    v -= (ux * ry - uy * rx) / jacobian;
    if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  }
  return null;
}

/** Two equal horizontal cells: neutral unlit glazing, then warm room glazing. */
export function prepareBuildingMaterial({ width, height, data }) {
  if (!Number.isInteger(width) || width < 4 || width % 2 || !Number.isInteger(height) || height < 2
    || !data || data.length !== width * height * 4) return null;
  const pixels = new Uint8ClampedArray(data), cellWidth = width / 2;
  const cells = { unlit: { x: 0, y: 0, width: cellWidth, height }, warm: { x: cellWidth, y: 0, width: cellWidth, height } };
  for (const cell of Object.values(cells)) {
    let visible = false;
    for (let y = 0; y < height && !visible; y++) for (let x = 0; x < cellWidth; x++) {
      if (pixels[(y * width + cell.x + x) * 4 + 3]) { visible = true; break; }
    }
    if (!visible) return null;
  }
  let weightedLuminance = 0, interiorWeight = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < cellWidth; x++) {
    const offset = (y * width + cellWidth + x) * 4;
    const weight = buildingEmissionMask((x + .5) / cellWidth, (y + .5) / height) * pixels[offset + 3] / 255;
    if (!weight) continue;
    const linear = decodeSceneColor([pixels[offset], pixels[offset + 1], pixels[offset + 2]]);
    weightedLuminance += (.2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2]) * weight;
    interiorWeight += weight;
  }
  // The warm photograph describes relative room radiance, not glass albedo.
  // Normalize its interior mean linear Y to one; the authored room strength
  // then controls energy independently of how dark that photograph is.
  const warmEmissionNormalization = weightedLuminance > 1e-12 ? interiorWeight / weightedLuminance : 0;
  return { width, height, pixels, cells, warmEmissionNormalization };
}

/** Repeat within a selected cell. Bilinear taps wrap INSIDE that cell, never
 * across the cold/warm boundary; premultiplied color avoids transparent rims.
 */
export function samplePreparedBuildingMaterial(material, u, v, kind = 'unlit') {
  if (!material || !Number.isFinite(u) || !Number.isFinite(v) || !Object.hasOwn(material.cells, kind)) return null;
  const { pixels, width } = material, cell = material.cells[kind];
  const x = wrap(u, 1) * cell.width - .5, y = wrap(v, 1) * cell.height - .5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  let alpha = 0, red = 0, green = 0, blue = 0;
  for (let row = 0; row < 2; row++) for (let column = 0; column < 2; column++) {
    const offset = ((cell.y + wrap(y0 + row, cell.height)) * width + cell.x + wrap(x0 + column, cell.width)) * 4;
    const weight = (column ? fx : 1 - fx) * (row ? fy : 1 - fy) * pixels[offset + 3] / 255;
    alpha += weight;
    red += pixels[offset] * weight; green += pixels[offset + 1] * weight; blue += pixels[offset + 2] * weight;
  }
  const sample = alpha < 1 / 255 ? { alpha: 0, baseColor: [0, 0, 0] }
    : { alpha: clamp01(alpha), baseColor: [red / alpha, green / alpha, blue / alpha] };
  if (kind === 'warm') sample.emissionMask = buildingEmissionMask(wrap(u, 1), wrap(v, 1));
  return sample;
}

export function sampleBuildingMaterial(u, v, kind = 'unlit') {
  return samplePreparedBuildingMaterial(prepared, u, v, kind);
}

/** The single local image read is bounded to 512px per half. Source artwork is
 * also retained for affine Canvas pane draws without any further pixel reads.
 */
export function loadBuildingMaterial() {
  if (loading) return loading;
  if (typeof Image === 'undefined' || typeof document === 'undefined') return Promise.resolve(state);
  publish({ status: 'loading' });
  loading = new Promise(resolve => {
    const source = new Image(); source.decoding = 'async';
    const fallback = () => { publish({ status: 'fallback' }); resolve(state); };
    source.onerror = fallback;
    source.onload = () => {
      try {
        if (source.naturalWidth < 4 || source.naturalHeight < 2) return fallback();
        const ratio = Math.min(1, MAX_CELL_SIZE / Math.max(source.naturalWidth / 2, source.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(4, Math.round(source.naturalWidth / 2 * ratio) * 2);
        canvas.height = Math.max(2, Math.round(source.naturalHeight * ratio));
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return fallback();
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        const material = prepareBuildingMaterial(context.getImageData(0, 0, canvas.width, canvas.height));
        if (!material) return fallback();
        prepared = material;
        const half = source.naturalWidth / 2;
        artwork = { image: source, warmEmissionNormalization: material.warmEmissionNormalization,
          cells: { unlit: { x: 0, y: 0, width: half, height: source.naturalHeight },
          warm: { x: half, y: 0, width: half, height: source.naturalHeight } } };
        publish({ ready: true, status: 'ready', revision: state.revision + 1, width: material.width, height: material.height,
          warmEmissionNormalization: material.warmEmissionNormalization });
        resolve(state);
      } catch { fallback(); }
    };
    source.src = ASSET_URL;
  });
  return loading;
}
