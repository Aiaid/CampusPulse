import { afterEach, describe, test, expect, vi } from 'vitest';

const scene = vi.hoisted(() => ({ trees: [], native: [], opacity: vi.fn(() => .5) }));
vi.mock('../../src/campus/campus-scene-lighting', () => ({ getCampusTreesInBounds: () => scene.trees,
  campusTreeOpacityAt: scene.opacity }));
vi.mock('../../src/campus/CampusLightingLayer', () => ({ getCampusNativeCanopyMasks: () => scene.native.map(mask => ({ ...mask })),
  subscribeCampusNativeCanopy: vi.fn() }));
import { fixtureWithTreeOcclusion } from '../../src/campus/LampFixtures.jsx';

let fixtureId = 0;
function setup() {
  const contexts = [];
  vi.stubGlobal('document', { createElement: () => {
    const canvas = { width: 0, height: 0 };
    const context = { drawImage: vi.fn(), getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(255) })),
      putImageData: vi.fn(), save: vi.fn(), restore: vi.fn(), setTransform: vi.fn() };
    canvas.getContext = () => context; contexts.push(context);
    return canvas;
  } });
  scene.trees = []; scene.native = []; scene.opacity.mockReset().mockReturnValue(.5);
  return { contexts, source: { id: `fixture-${++fixtureId}`, x: 10, y: 20, height: 2 },
    material: { image: {}, width: 1, height: 2, lensFraction: 1, lensAnchorX: .5 } };
}
afterEach(() => vi.unstubAllGlobals());

describe('fixture masks follow only their actual occluders', () => {
  test('unrelated native progress reuses pixels; replaced and removed relevant masks cannot stay stale', () => {
    const { source, material, contexts } = setup();
    const mask = { canvas: { width: 16, height: 16 }, left: 0, top: 0, width: 128, height: 128, heightProxy: 18 };
    scene.native = [mask];
    const original = fixtureWithTreeOcclusion(source, material, 0, true);
    for (let index = 0; index < 20; index++) expect(fixtureWithTreeOcclusion(source, material, 0, true)).toBe(original);
    expect(contexts).toHaveLength(1);
    // Native-only occlusion is a compositing operation, with no authored-tree
    // pixel readback or redundant all-zero opacity sampling.
    expect(contexts[0].getImageData).not.toHaveBeenCalled();
    expect(scene.opacity).not.toHaveBeenCalled();
    scene.native = [{ ...mask, canvas: { width: 32, height: 32 } }];
    expect(fixtureWithTreeOcclusion(source, material, 0, true).image).not.toBe(original.image);
    expect(contexts).toHaveLength(2);
    scene.native = [];
    expect(fixtureWithTreeOcclusion(source, material, 0, true)).toEqual({ image: material.image, masked: false });
  });

  test('authored tree alpha preserves exact sampled coordinates and refreshes on the tree material revision', () => {
    const { source, material, contexts } = setup();
    scene.trees = [{ base: { y: 21 }, screenBounds: { left: 8, top: 15, width: 4, height: 8 } }];
    const original = fixtureWithTreeOcclusion(source, material, 1, true);
    expect(scene.opacity).toHaveBeenCalledWith(9.5625, 18.0625, 20);
    expect(contexts[0].putImageData.mock.calls[0][0].data[3]).toBe(128);
    expect(fixtureWithTreeOcclusion(source, material, 1, true)).toBe(original);
    expect(contexts).toHaveLength(1);
    scene.opacity.mockReturnValue(.8);
    expect(fixtureWithTreeOcclusion(source, material, 2, true).image).not.toBe(original.image);
    expect(contexts).toHaveLength(2);
    expect(contexts[1].putImageData.mock.calls[0][0].data[3]).toBe(51);
  });
});
