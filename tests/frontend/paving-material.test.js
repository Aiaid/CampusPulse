import { afterEach, describe, expect, test, vi } from 'vitest';
import { PAVING_REGISTRATION, pavingUv, preparePavingMaterial, samplePreparedPavingMaterial } from '../../src/campus/paving-material.js';

const fixture = () => ({ width: 2, height: 2, data: new Uint8ClampedArray([
  110, 110, 110, 255, 130, 90, 80, 255, 150, 150, 150, 255, 170, 170, 170, 255,
]) });
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('registered authored paving', () => {
  test('map anchor and both paving directions remain fixed as the camera changes', () => {
    const { anchor, u, v } = PAVING_REGISTRATION;
    for (const expected of [[0, 0], [1, 0], [0, 1], [13.2, -7.5], [-.5, .27]]) {
      const point = anchor.map((value, axis) => value + u[axis] * expected[0] + v[axis] * expected[1]);
      const actual = pavingUv(...point);
      expect(actual[0]).toBeCloseTo(expected[0], 10); expect(actual[1]).toBeCloseTo(expected[1], 10);
    }
    expect(pavingUv(NaN, 270)).toBeNull(); expect(pavingUv(600, Infinity)).toBeNull();
  });

  test('bilinear repetition preserves texture detail and closes tile boundaries', () => {
    const material = preparePavingMaterial(fixture());
    expect(samplePreparedPavingMaterial(material, .25, .25).baseColor).toEqual([110, 110, 110]);
    expect(samplePreparedPavingMaterial(material, .75, .25).baseColor).toEqual([130, 90, 80]);
    expect(samplePreparedPavingMaterial(material, .5, .5).baseColor).toEqual([140, 130, 127.5]);
    expect(samplePreparedPavingMaterial(material, 0, .5)).toEqual(samplePreparedPavingMaterial(material, 1, .5));
    expect(samplePreparedPavingMaterial(material, -.25, 2.25)).toEqual(samplePreparedPavingMaterial(material, .75, .25));
    expect(samplePreparedPavingMaterial(material, NaN, 0)).toBeNull();
  });

  test('invalid or fully transparent bitmaps retain fallback rather than inventing a paving surface', () => {
    expect(preparePavingMaterial({ width: 2, height: 2, data: [] })).toBeNull();
    expect(preparePavingMaterial({ width: 2, height: 2, data: new Uint8ClampedArray(16) })).toBeNull();
  });

  test('shared asynchronous loading reads once and samples in map coordinates', async () => {
    const read = vi.fn(() => fixture());
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ drawImage: vi.fn(), getImageData: read }) }) });
    vi.stubGlobal('Image', class {
      naturalWidth = 2; naturalHeight = 2;
      set src(value) { queueMicrotask(() => this.onload()); }
    });
    const material = await import('../../src/campus/paving-material.js');
    const changes = [], unsubscribe = material.subscribePavingMaterial(next => changes.push(next.status));
    const first = material.loadPavingMaterial(); expect(material.loadPavingMaterial()).toBe(first);
    await first;
    expect(changes).toEqual(['loading', 'ready']); expect(read).toHaveBeenCalledTimes(1);
    expect(material.pavingMaterialState()).toMatchObject({ ready: true, revision: 1 });
    const point = [600 + 11 * .25 - 5.5 * .25, 270 + 3.6 * .25 + 7.5 * .25];
    const sample = material.samplePavingMaterial(...point);
    for (const value of sample.baseColor) expect(value).toBeCloseTo(110, 9);
    unsubscribe();
  });

  test('asset failure publishes fallback at unchanged revision', async () => {
    vi.stubGlobal('document', { createElement: vi.fn() });
    vi.stubGlobal('Image', class { set src(value) { queueMicrotask(() => this.onerror()); } });
    const material = await import('../../src/campus/paving-material.js');
    const changes = [], unsubscribe = material.subscribePavingMaterial(next => changes.push([next.status, next.revision]));
    await material.loadPavingMaterial();
    expect(changes).toEqual([['loading', 0], ['fallback', 0]]);
    expect(material.samplePavingMaterial(600, 270)).toBeNull();
    expect(material.pavingMaterialState()).toMatchObject({ ready: false, status: 'fallback' });
    unsubscribe();
  });
});
