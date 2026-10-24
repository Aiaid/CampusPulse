/** Authored paving texture registered to the existing map's paving directions.
 * This does not inspect, fetch or reproduce GIS raster pixels.
 */
const ASSET_URL = '/assets/library-paving-v1.png';
const MAX_TEXTURE_SIZE = 512;
const wrap = (value, size) => ((value % size) + size) % size;
export const PAVING_REGISTRATION = Object.freeze({ anchor: Object.freeze([600, 270]),
  u: Object.freeze([11, 3.6]), v: Object.freeze([-5.5, 7.5]) });
let state = Object.freeze({ ready: false, status: 'idle', revision: 0, width: 0, height: 0 });
let prepared = null, loading = null;
const listeners = new Set();

export function pavingMaterialState() { return state; }
export function subscribePavingMaterial(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function publish(next) {
  state = Object.freeze({ ...state, ...next });
  for (const listener of listeners) listener(state);
}

/** Unwrapped grid coordinates; only texture sampling repeats them. */
export function pavingUv(mapX, mapY) {
  if (!Number.isFinite(mapX) || !Number.isFinite(mapY)) return null;
  const { anchor, u, v } = PAVING_REGISTRATION;
  const x = mapX - anchor[0], y = mapY - anchor[1], determinant = u[0] * v[1] - u[1] * v[0];
  return [(x * v[1] - y * v[0]) / determinant, (u[0] * y - u[1] * x) / determinant];
}

export function preparePavingMaterial({ width, height, data }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2
    || !data || data.length !== width * height * 4) return null;
  const pixels = new Uint8ClampedArray(data);
  let visible = false;
  for (let offset = 3; offset < pixels.length; offset += 4) if (pixels[offset]) { visible = true; break; }
  return visible ? { width, height, pixels } : null;
}

export function samplePreparedPavingMaterial(material, u, v) {
  if (!material || !Number.isFinite(u) || !Number.isFinite(v)) return null;
  const { width, height, pixels } = material;
  const x = wrap(u, 1) * width - .5, y = wrap(v, 1) * height - .5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  let alpha = 0, red = 0, green = 0, blue = 0;
  for (let row = 0; row < 2; row++) for (let column = 0; column < 2; column++) {
    const offset = (wrap(y0 + row, height) * width + wrap(x0 + column, width)) * 4;
    const weight = (column ? fx : 1 - fx) * (row ? fy : 1 - fy) * pixels[offset + 3] / 255;
    alpha += weight; red += pixels[offset] * weight; green += pixels[offset + 1] * weight; blue += pixels[offset + 2] * weight;
  }
  return alpha < 1 / 255 ? { alpha: 0, baseColor: [0, 0, 0] }
    : { alpha: Math.max(0, Math.min(1, alpha)), baseColor: [red / alpha, green / alpha, blue / alpha] };
}

export function samplePavingMaterial(mapX, mapY) {
  const uv = pavingUv(mapX, mapY);
  return uv ? samplePreparedPavingMaterial(prepared, ...uv) : null;
}

export function loadPavingMaterial() {
  if (loading) return loading;
  if (typeof Image === 'undefined' || typeof document === 'undefined') return Promise.resolve(state);
  publish({ status: 'loading' });
  loading = new Promise(resolve => {
    const source = new Image(); source.decoding = 'async';
    const fallback = () => { publish({ status: 'fallback' }); resolve(state); };
    source.onerror = fallback;
    source.onload = () => {
      try {
        if (source.naturalWidth < 2 || source.naturalHeight < 2) return fallback();
        const ratio = Math.min(1, MAX_TEXTURE_SIZE / Math.max(source.naturalWidth, source.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(2, Math.round(source.naturalWidth * ratio));
        canvas.height = Math.max(2, Math.round(source.naturalHeight * ratio));
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return fallback();
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        const material = preparePavingMaterial(context.getImageData(0, 0, canvas.width, canvas.height));
        if (!material) return fallback();
        prepared = material;
        publish({ ready: true, status: 'ready', revision: state.revision + 1, width: material.width, height: material.height });
        resolve(state);
      } catch { fallback(); }
    };
    source.src = ASSET_URL;
  });
  return loading;
}
