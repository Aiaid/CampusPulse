import { afterEach, describe, expect, test, vi } from 'vitest';
import { prepareTreeMaterial, samplePreparedTreeMaterial } from '../../src/campus/tree-material.js';
import { libraryTrees, treeMaterialUV } from '../../src/campus/library-lighting.js';

function texture(width, height, color) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(color(x, y), (y * width + x) * 4);
  return { width, height, data };
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('local foliage material', () => {
  test('transparent padding cannot create a white or black fringe at a leaf edge', () => {
    const image = texture(4, 4, (x, y) => x >= 1 && x <= 2 && y >= 1 && y <= 2 ? [25, 110, 55, 255] : [255, 255, 255, 0]);
    const material = prepareTreeMaterial(image);
    const edge = samplePreparedTreeMaterial(material, 1 / 6, .5);
    expect(edge.alpha).toBeCloseTo(.5);
    expect(edge.baseColor).toEqual([25, 110, 55]);
    expect(samplePreparedTreeMaterial(material, 0, 0).alpha).toBe(0);
    expect(samplePreparedTreeMaterial(material, .5, .5).alpha).toBe(1);
  });

  test('empty/invalid images fail closed and sampling stays finite at the bounds', () => {
    expect(prepareTreeMaterial(texture(4, 4, () => [0, 0, 0, 0]))).toBeNull();
    expect(prepareTreeMaterial({ width: 4, height: 4, data: [] })).toBeNull();
    const material = prepareTreeMaterial(texture(9, 7, (x, y) => [x * 20, y * 28, 40, 255]));
    for (const uv of [[0, 0], [1, 1], [.5, .5], [.15, .85]]) {
      const sample = samplePreparedTreeMaterial(material, ...uv);
      expect(sample.alpha).toBe(1);
      expect(sample.baseColor.every(value => Number.isFinite(value) && value >= 0 && value <= 255)).toBe(true);
      expect(sample.normalDetail.every(value => Number.isFinite(value) && Math.abs(value) <= .281)).toBe(true);
    }
    for (const uv of [[NaN, .5], [.5, Infinity], [-.1, .5], [.5, 1.1]]) expect(samplePreparedTreeMaterial(material, ...uv)).toBeNull();
  });

  test('each tree maps its covariance center and interior into valid local UVs', () => {
    for (const tree of libraryTrees) {
      const p = tree.projection;
      expect(treeMaterialUV(tree, p.center.x, p.center.y)).toEqual([.5, .5]);
      for (const angle of [0, .7, 1.8, 3.1, 5.5]) {
        const u = Math.cos(angle) * .95, v = Math.sin(angle) * .95;
        const uv = treeMaterialUV(tree, p.center.x + Math.sqrt(p.xx) * u,
          p.center.y + p.xy / Math.sqrt(p.xx) * u + Math.sqrt(p.determinant / p.xx) * v);
        expect(uv.every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
      }
      expect(treeMaterialUV(tree, tree.screenBounds.left - 1, p.center.y)).toBeNull();
      expect(treeMaterialUV(tree, NaN, p.center.y)).toBeNull();
    }
  });

  test('readiness publishes once and the loaded leaf gaps also open the actor depth mask', async () => {
    const source = texture(9, 9, (x, y) => {
      const radius = Math.hypot(x - 4, y - 4);
      return [35, 135, 60, radius <= 3.6 && radius > 1.1 ? 255 : 0];
    });
    const read = vi.fn(() => source);
    const draw = vi.fn();
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ drawImage: draw, getImageData: read }) }) });
    vi.stubGlobal('Image', class {
      naturalWidth = 9; naturalHeight = 9;
      set src(value) { this.url = value; queueMicrotask(() => this.onload()); }
    });
    const material = await import('../../src/campus/tree-material.js');
    const geometry = await import('../../src/campus/library-lighting.js');
    const tree = geometry.libraryTrees.find(item => item.id === 'library-tree-outer-path');
    const p = tree.projection;
    expect(geometry.treeOpacityAt(p.center.x, p.center.y, tree.base.y - 1)).toBeCloseTo(.92, 10);
    const changes = [];
    const unsubscribe = material.subscribeTreeMaterial(next => changes.push(next.status));
    const first = material.loadTreeMaterial();
    expect(material.loadTreeMaterial()).toBe(first);
    await first;
    expect(material.treeMaterialState()).toMatchObject({ ready: true, revision: 1 });
    expect(changes).toEqual(['loading', 'ready']);
    expect(read).toHaveBeenCalledTimes(1);
    expect(geometry.treeOpacityAt(p.center.x, p.center.y, tree.base.y - 1)).toBe(0);
    const x = p.center.x + Math.sqrt(p.xx) * .5;
    const y = p.center.y + p.xy / Math.sqrt(p.xx) * .5;
    const hit = geometry.resolveLibrarySurface(x, y);
    expect(hit.id).toBe(tree.id);
    expect(hit.baseColor).toEqual([35, 135, 60]);
    expect(hit.materialUV).toHaveLength(2);
    expect(Math.hypot(...hit.normal)).toBeCloseTo(1, 10);
    expect(hit.coverage).toBe(1);
    expect(geometry.treeOpacityAt(x, y, tree.base.y - 1)).toBe(1);
    expect(geometry.treeOpacityAt(x, y, tree.base.y + 1)).toBe(0);
    // Ground shadows always use all crowns, even when the casting actor is
    // in front of the tree; this is the mask consumed by the shadow canvas.
    expect(geometry.treeOpacityAt(x, y)).toBe(1);
    unsubscribe();
  });

  test('failed image loading leaves deterministic fallback geometry available', async () => {
    vi.stubGlobal('document', { createElement: vi.fn() });
    vi.stubGlobal('Image', class { set src(value) { queueMicrotask(() => this.onerror()); } });
    const material = await import('../../src/campus/tree-material.js');
    const geometry = await import('../../src/campus/library-lighting.js');
    const tree = geometry.libraryTrees.find(item => item.id === 'library-tree-outer-path');
    const { x, y } = tree.projection.center;
    const before = geometry.treeOpacityAt(x, y, tree.base.y - 1);
    expect(before).toBeCloseTo(.92, 10);
    const changes = [];
    const unsubscribe = material.subscribeTreeMaterial(next => changes.push({ status: next.status, revision: next.revision }));
    await material.loadTreeMaterial();
    expect(material.treeMaterialState()).toMatchObject({ ready: false, status: 'fallback', revision: 0 });
    expect(geometry.treeOpacityAt(x, y, tree.base.y - 1)).toBe(before);
    expect(geometry.resolveLibrarySurface(x, y).baseColor).toBeUndefined();
    expect(changes).toEqual([{ status: 'loading', revision: 0 }, { status: 'fallback', revision: 0 }]);
    unsubscribe();
  });
});
