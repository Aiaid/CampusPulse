import { afterEach, describe, expect, test, vi } from 'vitest';
import { gisMaterialTiles, prepareGisMaterial, samplePreparedGisMaterial } from '../../src/campus/gis-material.js';
import { decodeSceneColor } from '../../src/campus/surface-lighting.js';
import { LIBRARY_BOUNDS } from '../../src/campus/library-lighting.js';

const luminance = rgb => .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
const encode = value => Math.round(255 * (value <= .0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - .055));
const bitmap = (width, height, color) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(color(x, y), (y * width + x) * 4);
  return { width, height, data };
};
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); vi.resetModules(); });

describe('source-preserving approximate GIS reflectance', () => {
  test('uses only zoom2 tiles intersecting the exact existing library registration', () => {
    const tiles = gisMaterialTiles();
    expect(tiles).toHaveLength(16);
    expect(tiles[0]).toMatchObject({ key: '2/28_16', x: 512, y: 128, size: 64 });
    expect(tiles.at(-1)).toMatchObject({ key: '2/31_19', x: 704, y: 320, size: 64 });
    for (const tile of tiles) {
      expect(tile.level).toBe(2);
      expect(tile.x).toBeLessThan(LIBRARY_BOUNDS.left + LIBRARY_BOUNDS.width);
      expect(tile.x + tile.size).toBeGreaterThan(LIBRARY_BOUNDS.left);
      expect(tile.y).toBeLessThan(LIBRARY_BOUNDS.top + LIBRARY_BOUNDS.height);
      expect(tile.y + tile.size).toBeGreaterThan(LIBRARY_BOUNDS.top);
      expect(tile.col * 512).toBe(10240 + tile.x * 8);
      expect(tile.row * 512).toBe(7168 + tile.y * 8);
    }
  });

  test('partially resists broad illumination gradients while retaining narrow roof ribs', () => {
    const image = bitmap(96, 48, x => {
      const daylight = .08 + .48 * x / 95, rib = x % 12 === 0 ? .16 : 1;
      const gray = encode(daylight * rib); return [gray, gray, gray, 255];
    });
    const material = prepareGisMaterial(image, { bounds: { left: 0, top: 0, width: 32, height: 16 }, resolution: 3 });
    const at = pixelX => samplePreparedGisMaterial(material, (pixelX + .5) / 3, 8, { kind: 'roof' });
    const dark = luminance(at(25).linearAlbedo), bright = luminance(at(73).linearAlbedo);
    const rawDark = luminance(decodeSceneColor(Array.from(image.data.slice(25 * 4, 25 * 4 + 3))));
    const rawBright = luminance(decodeSceneColor(Array.from(image.data.slice(73 * 4, 73 * 4 + 3))));
    expect(rawBright / rawDark).toBeGreaterThan(2);
    expect(bright / dark).toBeLessThan(rawBright / rawDark * .75);
    expect(bright).toBeGreaterThan(dark); // Partial normalization, not one gray fill.
    expect(luminance(at(48).linearAlbedo)).toBeLessThan(luminance(at(49).linearAlbedo) * .35);
  });

  test('warm, green and blue material hue differences survive and black seams never become gray', () => {
    for (const rgb of [[170, 100, 45], [45, 145, 80], [65, 110, 180], [2, 3, 4], [0, 0, 0]]) {
      const material = prepareGisMaterial(bitmap(8, 8, () => [...rgb, 255]),
        { bounds: { left: 0, top: 0, width: 8, height: 8 }, resolution: 1 });
      for (const kind of ['roof', 'canopy', 'wall']) {
        const sample = samplePreparedGisMaterial(material, 4, 4, { kind });
        expect(sample.linearAlbedo.every(value => Number.isFinite(value) && value >= 0 && value <= .92)).toBe(true);
        expect(sample.baseColorRGB.every(value => Number.isInteger(value) && value >= 0 && value <= 255)).toBe(true);
        if (rgb[0] === 170) expect(sample.linearAlbedo[0]).toBeGreaterThan(sample.linearAlbedo[1]);
        if (rgb[1] === 145) expect(sample.linearAlbedo[1]).toBeGreaterThan(sample.linearAlbedo[2]);
        if (rgb[2] === 180) {
          expect(sample.linearAlbedo[2]).toBeGreaterThan(sample.linearAlbedo[1]);
          expect(sample.linearAlbedo[1]).toBeGreaterThan(sample.linearAlbedo[0]);
        }
        if (rgb[0] < 3) expect(luminance(sample.linearAlbedo)).toBeLessThanOrEqual(luminance(decodeSceneColor(rgb)) + 1e-7);
      }
    }
  });

  test('wall-only cyan source-cast reduction preserves luminance, warm hues, greens and black detail', () => {
    const materialFor = rgb => prepareGisMaterial(bitmap(8, 8, () => [...rgb, 255]),
      { bounds: { left: 0, top: 0, width: 8, height: 8 }, resolution: 1 });
    const cyan = materialFor([100, 170, 170]);
    const uncorrected = samplePreparedGisMaterial(cyan, 4, 4, { kind: 'wall', normalizationStrength: 0, coolNeutralization: 0 });
    const corrected = samplePreparedGisMaterial(cyan, 4, 4, { kind: 'wall', normalizationStrength: 0 });
    const cast = sample => (sample.linearAlbedo[1] + sample.linearAlbedo[2]) / 2 - sample.linearAlbedo[0];
    expect(cast(corrected)).toBeLessThan(cast(uncorrected) * .45);
    expect(cast(corrected)).toBeGreaterThan(0); // Partial correction retains material hue.
    expect(luminance(corrected.linearAlbedo)).toBeCloseTo(luminance(uncorrected.linearAlbedo), 10);
    for (const kind of ['roof', 'canopy']) {
      expect(samplePreparedGisMaterial(cyan, 4, 4, { kind }))
        .toEqual(samplePreparedGisMaterial(cyan, 4, 4, { kind, coolNeutralization: 0 }));
    }
    for (const rgb of [[170, 100, 45], [130, 85, 60], [45, 145, 80], [0, 0, 0], [2, 3, 4]]) {
      const material = materialFor(rgb);
      const before = samplePreparedGisMaterial(material, 4, 4, { kind: 'wall', coolNeutralization: 0 });
      const after = samplePreparedGisMaterial(material, 4, 4, { kind: 'wall' });
      expect(after).toEqual(before);
      if (rgb[0] < 3) expect(luminance(after.linearAlbedo)).toBeLessThanOrEqual(luminance(decodeSceneColor(rgb)) + 1e-7);
    }
  });

  test('registration samples pixel centers and bilinear detail without wrapping outside the ROI', () => {
    const colors = [[64, 32, 16], [32, 64, 16], [16, 32, 64], [64, 64, 64]];
    const material = prepareGisMaterial(bitmap(2, 2, (x, y) => [...colors[y * 2 + x], 255]),
      { bounds: { left: 100, top: 200, width: 2, height: 2 }, resolution: 1 });
    const options = { normalizationStrength: 0, blueNeutralization: 0 };
    const first = samplePreparedGisMaterial(material, 100.5, 200.5, options);
    first.linearAlbedo.forEach((value, axis) => expect(value).toBeCloseTo(decodeSceneColor(colors[0])[axis], 8));
    const middle = samplePreparedGisMaterial(material, 101, 201, options);
    const expected = colors.map(decodeSceneColor).reduce((sum, rgb) => sum.map((value, axis) => value + rgb[axis] / 4), [0, 0, 0]);
    middle.linearAlbedo.forEach((value, axis) => expect(value).toBeCloseTo(expected[axis], 8));
    for (const point of [[99.999, 201], [102, 201], [101, 199.99], [101, 202], [NaN, 201]]) expect(samplePreparedGisMaterial(material, ...point)).toBeNull();
    expect(first.alpha).toBe(1);
  });

  test('invalid data and empty alpha keep fallback available', () => {
    const options = { bounds: { left: 0, top: 0, width: 2, height: 2 }, resolution: 1 };
    expect(prepareGisMaterial({ width: 2, height: 2, data: [] }, options)).toBeNull();
    expect(prepareGisMaterial(bitmap(2, 2, () => [255, 255, 255, 0]), options)).toBeNull();
    expect(prepareGisMaterial(bitmap(2, 2, () => [20, 30, 40, 255]), { ...options, resolution: 0 })).toBeNull();
  });
});

describe('bounded independent official-tile loading', () => {
  test('sets anonymous CORS before each URL and reads one registered 573x441 canvas after all tiles', async () => {
    vi.stubEnv('VITE_GIS_TILE_ORIGIN', 'https://official-proxy.invalid/');
    const requests = [], draw = vi.fn();
    const read = vi.fn((x, y, width, height) => bitmap(width, height, () => [100, 110, 120, 255]));
    const create = vi.fn(() => ({ getContext: () => ({ drawImage: draw, getImageData: read }) }));
    vi.stubGlobal('document', { createElement: create });
    vi.stubGlobal('Image', class {
      naturalWidth = 256; naturalHeight = 256;
      set src(url) { requests.push({ url, crossOrigin: this.crossOrigin }); queueMicrotask(() => this.onload?.()); }
    });
    const module = await import('../../src/campus/gis-material.js');
    const changes = [], unsubscribe = module.subscribeGisMaterial(next => changes.push(next.status));
    const first = module.loadGisMaterial(); expect(module.loadGisMaterial()).toBe(first);
    await first;
    expect(changes).toEqual(['loading', 'ready']); expect(requests).toHaveLength(16);
    expect(requests.every(item => item.crossOrigin === 'anonymous' && item.url.startsWith('https://official-proxy.invalid/mapdata/zoom2/'))).toBe(true);
    expect(create).toHaveBeenCalledTimes(1); expect(draw).toHaveBeenCalledTimes(16);
    expect(draw.mock.calls[0].slice(1)).toEqual([-108, -180, 192, 192]);
    expect(read).toHaveBeenCalledExactlyOnceWith(0, 0, 573, 441);
    expect(module.gisMaterialState()).toMatchObject({ ready: true, revision: 1, width: 573, height: 441, tileCount: 16 });
    expect(module.sampleGisMaterial(635, 211, { kind: 'roof' }).alpha).toBe(1);
    unsubscribe();
  });

  test('CORS-tainted canvas reading settles to fallback without a partial material', async () => {
    const read = vi.fn(() => { throw new Error('SecurityError'); });
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ drawImage: vi.fn(), getImageData: read }) }) });
    vi.stubGlobal('Image', class {
      naturalWidth = 256; naturalHeight = 256;
      set src(value) { queueMicrotask(() => this.onload?.()); }
    });
    const module = await import('../../src/campus/gis-material.js');
    await module.loadGisMaterial();
    expect(read).toHaveBeenCalledTimes(1);
    expect(module.gisMaterialState()).toMatchObject({ ready: false, status: 'fallback', revision: 0 });
    expect(module.sampleGisMaterial(635, 211)).toBeNull();
  });

  test('one failed tile prevents any partial ROI pixel read', async () => {
    const create = vi.fn();
    vi.stubGlobal('document', { createElement: create });
    vi.stubGlobal('Image', class {
      naturalWidth = 256; naturalHeight = 256;
      set src(value) { queueMicrotask(() => this.onerror?.()); }
    });
    const module = await import('../../src/campus/gis-material.js');
    await module.loadGisMaterial();
    expect(create).not.toHaveBeenCalled();
    expect(module.gisMaterialState()).toMatchObject({ status: 'fallback', revision: 0 });
  });

  test('the shared eight-second deadline cannot publish late tile results', async () => {
    vi.useFakeTimers();
    const images = [], create = vi.fn();
    vi.stubGlobal('document', { createElement: create });
    vi.stubGlobal('Image', class {
      naturalWidth = 256; naturalHeight = 256;
      constructor() { images.push(this); }
      set src(value) { this.url = value; }
    });
    const module = await import('../../src/campus/gis-material.js');
    const changes = [], unsubscribe = module.subscribeGisMaterial(next => changes.push(next.status));
    const result = module.loadGisMaterial(), late = images.map(image => image.onload);
    await vi.advanceTimersByTimeAsync(7999);
    expect(module.gisMaterialState().status).toBe('loading');
    await vi.advanceTimersByTimeAsync(1); await result;
    for (const callback of late) callback();
    expect(changes).toEqual(['loading', 'fallback']); expect(create).not.toHaveBeenCalled();
    expect(images.every(image => image.onload === null && image.onerror === null)).toBe(true);
    expect(module.gisMaterialState()).toMatchObject({ ready: false, revision: 0 });
    unsubscribe();
  });
});
