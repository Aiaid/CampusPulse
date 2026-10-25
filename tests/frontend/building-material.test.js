import { afterEach, describe, expect, test, vi } from 'vitest';
import { facadeUv, prepareBuildingMaterial, samplePreparedBuildingMaterial } from '../../src/campus/building-material.js';
import { librarySurfaces } from '../../src/campus/library-lighting.js';
import { libraryBuildingMaterialColor } from '../../src/campus/library-light-atlas.js';

const bitmap = (width, height, color) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(color(x, y), (y * width + x) * 4);
  return { width, height, data };
};
const pointAt = (quad, u, v) => [0, 1].map(axis => quad[0][axis] * (1 - u) * (1 - v)
  + quad[1][axis] * u * (1 - v) + quad[2][axis] * u * v + quad[3][axis] * (1 - u) * v);

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('registered wall material coordinates', () => {
  test('all real wall corners and interior points invert the actual window quad', () => {
    const grid = { 'library-west-glass': [18, 9], 'library-south-glass': [7, 7], 'library-east-glass': [9, 12] };
    for (const surface of librarySurfaces.filter(item => item.kind === 'wall')) {
      const { windowQuad, columns, rows } = surface.mapping;
      expect([columns, rows]).toEqual(grid[surface.id]);
      for (const uv of [[0, 0], [1, 0], [1, 1], [0, 1], [.23, .74], [.6, 1.18]]) {
        const result = facadeUv(windowQuad, ...pointAt(windowQuad, ...uv));
        expect(result[0]).toBeCloseTo(uv[0], 10);
        expect(result[1]).toBeCloseTo(uv[1], 10);
      }
    }
  });

  test('tapered convex quads invert bilinear coordinates without flattening perspective', () => {
    const quad = [[2, 4], [19, 7], [16, 25], [-1, 21]];
    for (const uv of [[0, 0], [1, 0], [1, 1], [0, 1], [.21, .84], [.76, .17]]) {
      const result = facadeUv(quad, ...pointAt(quad, ...uv));
      expect(result[0]).toBeCloseTo(uv[0], 8);
      expect(result[1]).toBeCloseTo(uv[1], 8);
    }
  });

  test('invalid, degenerate and folded quads fail instead of emitting invalid UVs', () => {
    for (const quad of [null, [], [[0, 0], [1, 0], [2, 0], [3, 0]],
      [[0, 0], [1, 1], [0, 1], [1, 0]], [[0, 0], [1, 0], [1, Infinity], [0, 1]]]) {
      expect(facadeUv(quad, .5, .5)).toBeNull();
    }
    expect(facadeUv([[0, 0], [1, 0], [1, 1], [0, 1]], NaN, 0)).toBeNull();
  });
});

describe('authored cold/warm facade cells', () => {
  test('zero-energy neutral walls stay cool, shared direct or facade light warms them, and tone mapping stays bounded', () => {
    const base = [160, 160, 160], normal = [0, 1, 0];
    const dark = libraryBuildingMaterialColor(base, normal, { directIrradiance: 0, indirectIrradiance: 0, facadeIrradiance: 0 });
    expect(dark[2]).toBeGreaterThan(dark[1]); expect(dark[1]).toBeGreaterThan(dark[0]);
    for (const energy of [{ directIrradiance: .7 }, { facadeIrradiance: .7 }]) {
      const warm = libraryBuildingMaterialColor(base, normal, energy);
      expect(warm[0]).toBeGreaterThan(warm[2]);
      expect(warm[0]).toBeGreaterThan(dark[0]);
    }
    const strong = libraryBuildingMaterialColor(base, normal,
      { directIrradiance: 1e12, indirectIrradiance: 1e12, facadeIrradiance: 1e12 }, { emission: 1e12 });
    expect(strong.every(value => Number.isInteger(value) && value >= 0 && value <= 255)).toBe(true);
  });

  test('repeating UVs stay inside the selected half, including wrap boundaries', () => {
    const material = prepareBuildingMaterial(bitmap(8, 4, x => x < 4 ? [15, 45, 90, 255] : [230, 160, 70, 255]));
    for (const uv of [[0, 0], [1, 1], [-.001, .999], [.001, 1.001], [13.2, -8.7]]) {
      expect(samplePreparedBuildingMaterial(material, ...uv, 'unlit')).toEqual({ alpha: 1, baseColor: [15, 45, 90] });
      expect(samplePreparedBuildingMaterial(material, ...uv, 'warm')).toMatchObject({ alpha: 1, baseColor: [230, 160, 70] });
    }
    expect(samplePreparedBuildingMaterial(material, NaN, 0)).toBeNull();
    expect(samplePreparedBuildingMaterial(material, 0, Infinity)).toBeNull();
    expect(samplePreparedBuildingMaterial(material, 0, 0, 'missing')).toBeNull();
  });

  test('bilinear RGB preserves local detail and transparent texels cannot pollute its color', () => {
    const material = prepareBuildingMaterial(bitmap(4, 2, x => x % 2 ? [30, 100, 60, 255] : [255, 255, 255, 0]));
    const sample = samplePreparedBuildingMaterial(material, .5, .5);
    expect(sample.alpha).toBeCloseTo(.5, 10);
    expect(sample.baseColor).toEqual([30, 100, 60]);
    expect(samplePreparedBuildingMaterial(material, 2.5, -3.5)).toEqual(sample);
    expect(samplePreparedBuildingMaterial(material, .25, .5).alpha).toBe(0);
    expect(samplePreparedBuildingMaterial(material, .75, .5).alpha).toBe(1);
  });

  test('malformed images or empty cells preserve the fallback path', () => {
    expect(prepareBuildingMaterial(bitmap(5, 2, () => [50, 60, 70, 255]))).toBeNull();
    expect(prepareBuildingMaterial(bitmap(4, 2, () => [0, 0, 0, 0]))).toBeNull();
    expect(prepareBuildingMaterial(bitmap(4, 2, x => [50, 60, 70, x < 2 ? 255 : 0]))).toBeNull();
    expect(prepareBuildingMaterial({ width: 4, height: 2, data: [] })).toBeNull();
  });

  test('loading reads pixels once at bounded size and exposes original artwork bounds', async () => {
    const canvases = [], read = vi.fn((x, y, width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) }));
    vi.stubGlobal('document', { createElement: () => {
      const canvas = { getContext: () => ({ drawImage: vi.fn(), getImageData: read }) };
      canvases.push(canvas); return canvas;
    } });
    vi.stubGlobal('Image', class {
      naturalWidth = 2048; naturalHeight = 1024;
      set src(value) { this.url = value; queueMicrotask(() => this.onload()); }
    });
    const material = await import('../../src/campus/building-material.js');
    const changes = [], unsubscribe = material.subscribeBuildingMaterial(next => changes.push(next.status));
    const first = material.loadBuildingMaterial();
    expect(material.loadBuildingMaterial()).toBe(first);
    await first;
    expect(changes).toEqual(['loading', 'ready']);
    expect(material.buildingMaterialState()).toMatchObject({ ready: true, revision: 1, width: 1024, height: 512 });
    expect(canvases[0].width / 2).toBeLessThanOrEqual(512);
    expect(canvases[0].height).toBeLessThanOrEqual(512);
    expect(read).toHaveBeenCalledTimes(1);
    expect(material.buildingMaterialArtwork().cells).toEqual({ unlit: { x: 0, y: 0, width: 1024, height: 1024 },
      warm: { x: 1024, y: 0, width: 1024, height: 1024 } });
    expect(material.sampleBuildingMaterial(.5, .5, 'warm').baseColor).toEqual([255, 255, 255]);
    unsubscribe();
  });

  test('image failure publishes fallback at revision zero and exposes no partial material', async () => {
    vi.stubGlobal('document', { createElement: vi.fn() });
    vi.stubGlobal('Image', class { set src(value) { queueMicrotask(() => this.onerror()); } });
    const material = await import('../../src/campus/building-material.js');
    const changes = [], unsubscribe = material.subscribeBuildingMaterial(next => changes.push([next.status, next.revision]));
    await material.loadBuildingMaterial();
    expect(changes).toEqual([['loading', 0], ['fallback', 0]]);
    expect(material.buildingMaterialState()).toMatchObject({ ready: false, status: 'fallback', revision: 0 });
    expect(material.sampleBuildingMaterial(.5, .5)).toBeNull();
    expect(material.buildingMaterialArtwork()).toBeNull();
    unsubscribe();
  });
});
