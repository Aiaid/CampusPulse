import { LIBRARY_BOUNDS, libraryBlend } from './library-lighting.js';
import { MAP_WIDTH, MAP_HEIGHT } from './scene-data.js';

let mask;
const cache = new WeakMap();
/** Remove the former light contribution where the local surface model takes
 * over. Only generated textures are composited; official tiles are never read. */
export function withoutLibraryLight(source) {
  if (cache.has(source)) return cache.get(source);
  const resolution = 2;
  if (!mask) {
    mask = document.createElement('canvas');
    mask.width = MAP_WIDTH * resolution;
    mask.height = MAP_HEIGHT * resolution;
    const context = mask.getContext('2d');
    const pixels = context.createImageData(mask.width, mask.height);
    const { left, top, width, height } = LIBRARY_BOUNDS;
    for (let py = Math.max(0, Math.floor(top * resolution)); py < Math.min(mask.height, Math.ceil((top + height) * resolution)); py++) {
      for (let px = Math.max(0, Math.floor(left * resolution)); px < Math.min(mask.width, Math.ceil((left + width) * resolution)); px++) {
        pixels.data[(py * mask.width + px) * 4 + 3] = Math.round(255 * libraryBlend((px + .5) / resolution, (py + .5) / resolution));
      }
    }
    context.putImageData(pixels, 0, 0);
  }
  const result = document.createElement('canvas');
  result.width = source.width; result.height = source.height;
  const context = result.getContext('2d');
  context.drawImage(source, 0, 0);
  context.globalCompositeOperation = 'destination-out';
  context.drawImage(mask, 0, 0, result.width, result.height);
  cache.set(source, result);
  return result;
}
