/** Local illustrative foliage material. Never reads or fetches GIS imagery. */
const ASSET_URL = '/assets/library-tree-canopy-v1.png';
const MAX_TEXTURE_SIZE = 512;
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
let state = Object.freeze({ ready: false, status: 'idle', revision: 0, width: 0, height: 0 });
let prepared = null;
let artwork = null;
let loading = null;
const listeners = new Set();

export function treeMaterialState() { return state; }
/** Cropped same-origin leaf alpha for fast canvas depth masks. Prepared once,
 * never reads GIS pixels or creates a per-frame pixel buffer. */
export function treeMaterialArtwork() { return artwork; }

export function subscribeTreeMaterial(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next) {
  state = Object.freeze({ ...state, ...next });
  for (const listener of listeners) listener(state);
}

/** Prepare alpha, RGB and a restrained leaf-detail normal once. The luminance
 * derivatives suggest local leaf relief; they are not measured surface normals.
 * Exported separately so alpha/fringe behavior can be checked without a browser.
 */
export function prepareTreeMaterial({ width, height, data }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2
    || !data || data.length !== width * height * 4) return null;
  const pixels = new Uint8ClampedArray(data);
  const normalDetail = new Float32Array(width * height * 2);
  let left = width, right = -1, top = height, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (pixels[(y * width + x) * 4 + 3] > 8) {
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (right <= left || bottom <= top) return null;
  // Remove generator padding, keeping one transparent texel around the crown.
  left = Math.max(0, left - 1); right = Math.min(width - 1, right + 1);
  top = Math.max(0, top - 1); bottom = Math.min(height - 1, bottom + 1);
  const luminance = (x, y, fallback) => {
    const offset = (clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)) * 4;
    if (pixels[offset + 3] < 128) return fallback;
    return (.2126 * pixels[offset] + .7152 * pixels[offset + 1] + .0722 * pixels[offset + 2]) / 255;
  };
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
    const offset = (y * width + x) * 4;
    if (pixels[offset + 3] < 128) continue;
    const center = luminance(x, y, 0);
    const detail = (y * width + x) * 2;
    normalDetail[detail] = clamp((luminance(x - 2, y, center) - luminance(x + 2, y, center)) * .8, -.28, .28);
    normalDetail[detail + 1] = clamp((luminance(x, y - 2, center) - luminance(x, y + 2, center)) * .8, -.28, .28);
  }
  return { width, height, pixels, normalDetail, bounds: { left, top, right, bottom } };
}

/** Bilinear sampling uses premultiplied RGB so transparent padding cannot
 * introduce a black/white rim. No canvas or pixel read occurs while sampling.
 */
export function samplePreparedTreeMaterial(material, u, v) {
  if (!material || !Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) return null;
  const { width, pixels, normalDetail, bounds } = material;
  const x = bounds.left + u * (bounds.right - bounds.left);
  const y = bounds.top + v * (bounds.bottom - bounds.top);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, bounds.right), y1 = Math.min(y0 + 1, bounds.bottom);
  const fx = x - x0, fy = y - y0;
  const indices = [y0 * width + x0, y0 * width + x1, y1 * width + x0, y1 * width + x1];
  const weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
  let alpha = 0, red = 0, green = 0, blue = 0, nx = 0, ny = 0;
  for (let i = 0; i < 4; i++) {
    const index = indices[i], offset = index * 4;
    const weight = weights[i] * pixels[offset + 3] / 255;
    alpha += weight;
    red += pixels[offset] * weight; green += pixels[offset + 1] * weight; blue += pixels[offset + 2] * weight;
    nx += normalDetail[index * 2] * weight; ny += normalDetail[index * 2 + 1] * weight;
  }
  if (alpha < 1 / 255) return { alpha: 0, baseColor: [0, 0, 0], normalDetail: [0, 0] };
  return { alpha: clamp(alpha), baseColor: [red / alpha, green / alpha, blue / alpha], normalDetail: [nx / alpha, ny / alpha] };
}

export function sampleTreeMaterial(u, v) {
  return samplePreparedTreeMaterial(prepared, u, v);
}

/** Idempotent browser preload. Missing or unreadable assets retain the existing
 * procedural crown and raster treatment; importing geometry is DOM-free.
 */
export function loadTreeMaterial() {
  if (loading) return loading;
  if (typeof Image === 'undefined' || typeof document === 'undefined') return Promise.resolve(state);
  publish({ status: 'loading' });
  loading = new Promise(resolve => {
    const source = new Image();
    source.decoding = 'async';
    const fallback = () => {
      publish({ status: 'fallback' });
      resolve(state);
    };
    source.onerror = fallback;
    source.onload = () => {
      try {
        const ratio = Math.min(1, MAX_TEXTURE_SIZE / Math.max(source.naturalWidth, source.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(2, Math.round(source.naturalWidth * ratio));
        canvas.height = Math.max(2, Math.round(source.naturalHeight * ratio));
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return fallback();
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        const material = prepareTreeMaterial(context.getImageData(0, 0, canvas.width, canvas.height));
        if (!material) return fallback();
        prepared = material;
        const crop = document.createElement('canvas');
        const { left, top, right, bottom } = material.bounds;
        crop.width = right - left + 1; crop.height = bottom - top + 1;
        const cropContext = crop.getContext('2d');
        if (cropContext) {
          cropContext.drawImage(canvas, left, top, crop.width, crop.height, 0, 0, crop.width, crop.height);
          artwork = crop;
        }
        publish({ ready: true, status: 'ready', revision: state.revision + 1, width: material.width, height: material.height });
        resolve(state);
      } catch {
        fallback();
      }
    };
    source.src = ASSET_URL;
  });
  return loading;
}
