import { describe, test, expect, vi } from 'vitest';
import { createRenderCache, nativeMaskDependencies, createActorLightSampler } from '../../src/campus/render-cache.js';

describe('bounded exact render dependencies', () => {
  test('uses identity, handles cached null, and evicts least recently used entries', () => {
    const cache = createRenderCache(2), compute = vi.fn(() => null), object = {};
    expect(cache.resolve('a', [object, 1], compute)).toBeNull();
    cache.resolve('b', [2], compute);
    cache.resolve('a', [object, 1], compute);
    expect(compute).toHaveBeenCalledTimes(2);
    cache.resolve('c', [], compute);
    expect(cache.size).toBe(2);
    cache.resolve('a', [object, 1], compute);
    expect(compute).toHaveBeenCalledTimes(3);
    cache.resolve('b', [2], compute);
    expect(compute).toHaveBeenCalledTimes(4);
    cache.resolve('b', [{}], compute);
    expect(compute).toHaveBeenCalledTimes(5);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  test('native wrappers retain a hit but replacement canvases and registrations invalidate', () => {
    const cache = createRenderCache(2), compute = vi.fn(() => ({}));
    const mask = { canvas: {}, left: 1, top: 2, width: 128, height: 128, heightProxy: 18 };
    const resolve = masks => cache.resolve('lamp', [1, ...nativeMaskDependencies(masks)], compute);
    const original = resolve([mask]);
    expect(resolve([{ ...mask }])).toBe(original);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(resolve([{ ...mask, canvas: {} }])).not.toBe(original);
    expect(resolve([{ ...mask, top: 3 }])).not.toBe(original);
    expect(resolve([])).not.toBe(original);
    expect(compute).toHaveBeenCalledTimes(4);
  });
});

describe('exact actor lighting reuse', () => {
  const samplers = () => ({ sampleLocal: vi.fn((x, y) => ({ intensity: x, y })),
    sampleLibrary: vi.fn((x, y) => ({ intensity: y, x })),
    sampleCampus: vi.fn((x, y) => ({ intensity: x + y })),
    blend: vi.fn((a, b, amount) => ({ a, b, amount })) });

  test('campus samples bypass local light, share an exact pose, and invalidate on material or coordinate changes', () => {
    const functions = samplers(), sampler = createActorLightSampler(functions);
    const actor = { id: 'parked', x: 100.123456, y: 200.987654 };
    const options = { campus: true, libraryAmount: 1, treeRevision: 0 };
    const first = sampler.sample(actor, options);
    expect(first).toEqual(functions.sampleCampus.mock.results[0].value);
    expect(sampler.sample({ ...actor }, options)).toBe(first);
    expect(functions.sampleCampus).toHaveBeenCalledTimes(1);
    expect(functions.sampleLocal).not.toHaveBeenCalled();
    expect(functions.sampleLibrary).not.toHaveBeenCalled();
    sampler.sample({ ...actor, x: actor.x + 1e-10 }, options);
    sampler.sample(actor, { ...options, treeRevision: 1 });
    expect(functions.sampleCampus).toHaveBeenCalledTimes(3);
  });

  test('library blending matches uncached semantics and exact blend changes invalidate', () => {
    const functions = samplers(), sampler = createActorLightSampler(functions);
    const actor = { id: 'walk', x: 1, y: 2 };
    const options = { campus: false, libraryAmount: .3, treeRevision: 1 };
    expect(sampler.sample(actor, options)).toEqual({ a: { intensity: 1, y: 2 }, b: { intensity: 2, x: 1 }, amount: .3 });
    sampler.sample(actor, options);
    expect(functions.sampleLocal).toHaveBeenCalledTimes(1);
    sampler.sample(actor, { ...options, libraryAmount: .3000001 });
    expect(functions.blend).toHaveBeenCalledTimes(2);
    expect(sampler.sample(actor, { ...options, libraryAmount: 0 })).toEqual({ intensity: 1, y: 2 });
    expect(functions.sampleLibrary).toHaveBeenCalledTimes(2);
  });

  test('moving poses replace an actor entry and actor populations stay bounded', () => {
    const sampler = createActorLightSampler(samplers(), 2);
    const options = { campus: true, libraryAmount: 1, treeRevision: 0 };
    for (let x = 0; x < 100; x++) sampler.sample({ id: 'moving', x, y: 0 }, options);
    expect(sampler.size).toBe(1);
    for (let x = 0; x < 100; x++) sampler.sample({ id: `actor-${x}`, x, y: 0 }, options);
    expect(sampler.size).toBe(2);
  });
});
