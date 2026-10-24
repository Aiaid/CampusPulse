import { describe, expect, test, vi } from 'vitest';
import { createLightingTaskScheduler, createLightingCheckpoint, awaitLightingInput } from '../../src/campus/lighting-task-scheduler.js';
import { createLibraryAtlasCache } from '../../src/campus/library-light-atlas.js';
import { compileCampusChunk } from '../../src/campus/campus-light-compiler.js';
import { prepareGisMaterial, samplePreparedGisMaterial } from '../../src/campus/gis-material.js';
import { resolveCampusSurface, sampleCampusLight } from '../../src/campus/campus-scene-lighting.js';
import { shadeLinearSceneSurface } from '../../src/campus/surface-lighting.js';
import { lightingMaterialSnapshot, installLightingMaterialSnapshot } from '../../src/campus/lighting-material-snapshot.js';
import { prepareTreeMaterial, sampleTreeMaterial, loadTreeMaterial } from '../../src/campus/tree-material.js';
import { loadBuildingMaterial } from '../../src/campus/building-material.js';
import { loadPavingMaterial } from '../../src/campus/paving-material.js';

const turn = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const fakeWorker = () => ({ messages: [], postMessage(message) { this.messages.push(message); },
  terminate: vi.fn(), complete(value) { this.onmessage({ data: { id: this.messages.at(-1).id, value } }); } });

describe('bounded shared lighting execution', () => {
  test('keeps two workers and a bounded queue, sends material state only on revision changes', async () => {
    const workers = [], fallback = vi.fn();
    const pool = createLightingTaskScheduler({ maxQueued: 1, createWorker: () => { const worker = fakeWorker(); workers.push(worker); return worker; }, fallback });
    const request = revision => pool.request('campus', { value: 1 }, { assets: { revision, prepared: new Float32Array([.2]) } });
    const a = request('a'), b = request('a'), c = request('a');
    await expect(request('a')).rejects.toThrow('queue is full');
    expect(pool.snapshot()).toMatchObject({ running: 2, workers: 2, queued: 1 });
    workers[0].complete('first'); await expect(a).resolves.toBe('first');
    expect(workers[0].messages[1].assets).toBeUndefined();
    workers[0].complete('third'); workers[1].complete('second');
    await Promise.all([b, c]);
    const d = request('b'); expect(workers[0].messages.at(-1).assets.revision).toBe('b');
    workers[0].complete('fourth'); await d;
    expect(fallback).not.toHaveBeenCalled(); pool.dispose();
  });

  test('cancels running and queued work without executing a fallback or accepting late worker output', async () => {
    const workers = [], fallback = vi.fn();
    const pool = createLightingTaskScheduler({ concurrency: 1, createWorker: () => { const worker = fakeWorker(); workers.push(worker); return worker; }, fallback });
    const running = new AbortController(), queued = new AbortController();
    const a = pool.request('campus', {}, { signal: running.signal });
    const aRejected = expect(a).rejects.toMatchObject({ name: 'AbortError' });
    const b = pool.request('library', {}, { signal: queued.signal });
    const bRejected = expect(b).rejects.toMatchObject({ name: 'AbortError' });
    queued.abort(); running.abort(); await Promise.all([aRejected, bRejected]);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    const c = pool.request('library', {});
    workers[0].complete('stale'); expect(pool.snapshot().running).toBe(1);
    workers[1].complete('fresh'); await expect(c).resolves.toBe('fresh');
    expect(fallback).not.toHaveBeenCalled(); pool.dispose();
  });

  test('retries unsupported/failed workers once through cooperative fallback using retained inputs', async () => {
    const worker = fakeWorker(), bytes = new Uint8ClampedArray([12, 34, 56, 255]);
    const fallback = vi.fn(async (_kind, payload) => [...payload.bytes]);
    const pool = createLightingTaskScheduler({ concurrency: 1, createWorker: () => worker, fallback });
    const result = pool.request('campus', { bytes });
    worker.onerror({ preventDefault() {} }); worker.onerror({ preventDefault() {} });
    await expect(result).resolves.toEqual([12, 34, 56, 255]);
    expect(fallback).toHaveBeenCalledOnce(); expect(bytes.byteLength).toBe(4);
    await expect(pool.request('campus', { bytes })).resolves.toEqual([...bytes]);
    expect(pool.snapshot()).toMatchObject({ workers: 0, fallback: true }); pool.dispose();
  });

  test('cooperative slices yield at their budget and observe cancellation before another row', async () => {
    let clock = 0; const pause = vi.fn(async () => {}), controller = new AbortController();
    const checkpoint = createLightingCheckpoint({ now: () => clock, budgetMs: 5, pause, signal: controller.signal });
    expect(checkpoint()).toBeNull(); clock = 6; await checkpoint(); expect(pause).toHaveBeenCalledOnce();
    expect(checkpoint()).toBeNull(); controller.abort();
    expect(checkpoint).toThrow('cancelled');
  });

  test('releases a cancelled image consumer immediately while the shared load remains usable', async () => {
    const input = deferred(), controller = new AbortController();
    const waiting = awaitLightingInput(input.promise, controller.signal);
    const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected;
    input.resolve('shared decoded image');
    await expect(awaitLightingInput(input.promise, new AbortController().signal)).resolves.toBe('shared decoded image');
  });

  test('stalled illustrative assets settle to fallback within the bounded preload deadline', async () => {
    vi.useFakeTimers(); vi.stubGlobal('Image', class {}); vi.stubGlobal('document', {});
    try {
      const loads = Promise.all([loadTreeMaterial(), loadBuildingMaterial(), loadPavingMaterial()]);
      await vi.advanceTimersByTimeAsync(8000);
      const states = await loads;
      expect(states.map(state => state.status)).toEqual(['fallback', 'fallback', 'fallback']);
    } finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
  });
});

describe('shared library atlas lifecycle', () => {
  test('an offscreen quality budget drops high-resolution ownership and cancels pending high-resolution work', async () => {
    const jobs = [], cache = createLibraryAtlasCache({ revision: () => 'same-materials', compile: options => {
      const job = deferred(); jobs.push({ ...job, options }); return job.promise;
    } });
    const full = cache.request({ resolution: 3 }); await turn();
    jobs[0].resolve({ resolution: 3, normals: null }); await full;
    cache.setResolutionBudget(2); expect(cache.peek()).toBeNull();
    const pending = cache.request({ resolution: 3 }), aborted = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await turn(); cache.setResolutionBudget(2);
    expect(jobs[1].options.signal.aborted).toBe(true);
    jobs[1].resolve({ resolution: 3, normals: null }); await aborted;
    expect(cache.peek()).toBeNull();
  });

  test('keys static atlases by resolution and replaces both finished and in-flight high-quality results', async () => {
    const jobs = [], cache = createLibraryAtlasCache({ revision: () => 'same-materials', compile: options => {
      const job = deferred(); jobs.push({ ...job, options }); return job.promise;
    } });
    const full = cache.request({ resolution: 3 }); await turn(); jobs[0].resolve({ resolution: 3, normals: null }); await full;
    const efficient = cache.request({ resolution: 2 }); await turn();
    expect(jobs[1].options.resolution).toBe(2); jobs[1].resolve({ resolution: 2, normals: null }); await efficient;
    expect(cache.peek().value.resolution).toBe(2);
    const restore = cache.request({ resolution: 3 }), aborted = expect(restore).rejects.toMatchObject({ name: 'AbortError' });
    await turn();
    // Reusing a cached efficient atlas still cancels a pending full upgrade.
    const again = await cache.request({ resolution: 2 });
    expect(again.resolution).toBe(2);
    expect(jobs[2].options.signal.aborted).toBe(true);
    jobs[2].resolve({ resolution: 3, normals: null }); await aborted;
    expect(jobs).toHaveLength(3);
    expect(cache.peek().value.resolution).toBe(2);
  });

  test('camera cancellation retains work required by another camera, caches final output and upgrades diagnostics explicitly', async () => {
    const jobs = []; let revision = 'one';
    const compile = vi.fn(options => { const job = deferred(); jobs.push({ ...job, options }); return job.promise; });
    const cache = createLibraryAtlasCache({ compile, revision: () => revision });
    const controller = new AbortController();
    const a = cache.request({ signal: controller.signal }), rejected = expect(a).rejects.toMatchObject({ name: 'AbortError' });
    const b = cache.request(); await turn(); controller.abort(); await rejected;
    expect(jobs[0].options.signal.aborted).toBe(false);
    const color = { normals: null, color: 'one' }; jobs[0].resolve(color);
    await expect(b).resolves.toBe(color); await expect(cache.request()).resolves.toBe(color);
    expect(compile).toHaveBeenCalledTimes(1);
    const diagnostic = cache.request({ diagnostic: true }); await turn();
    jobs[1].resolve({ normals: 'normals', color: 'one' }); await diagnostic;
    await cache.request(); expect(compile).toHaveBeenCalledTimes(2);
    revision = 'two'; const next = cache.request(); await turn();
    jobs[2].resolve({ normals: null, color: 'two' }); await next;
    expect(cache.peek().value.color).toBe('two');
  });

  test('reacquires during camera rerender but cancels a fully abandoned atlas', async () => {
    const jobs = [];
    const cache = createLibraryAtlasCache({ revision: () => 'one', compile: options => {
      const job = deferred(); jobs.push({ ...job, options }); return job.promise;
    } });
    const controller = new AbortController(), first = cache.request({ signal: controller.signal });
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await turn(); controller.abort(); const secondController = new AbortController();
    const second = cache.request({ signal: secondController.signal });
    await rejected; expect(jobs).toHaveLength(1); expect(jobs[0].options.signal.aborted).toBe(false);
    const secondRejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    secondController.abort(); await secondRejected; await turn();
    expect(jobs[0].options.signal.aborted).toBe(true);
    jobs[0].resolve({ normals: null }); await turn(); expect(cache.peek()).toBeNull();
  });
});

describe('worker material/compiled pixel equivalence', () => {
  test('efficient color pixels preserve the exact full-resolution native canopy alpha used by actors', async () => {
    const chunk = { key: 'canopy-fixture', left: 8, top: 8, width: 8, height: 8, sourceResolution: 2 };
    const data = new Uint8ClampedArray(48 * 48 * 4);
    for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) {
      data.set((x + y) % 3 === 0 ? [25, 65, 20, 255] : [150, 150, 150, 255], (y * 48 + x) * 4);
    }
    const source = { width: 48, height: 48, data, resolution: 2, bounds: { left: 0, top: 0, width: 24, height: 24 } };
    const full = await compileCampusChunk({ chunk: { ...chunk, resolution: 2 }, source });
    const efficient = await compileCampusChunk({ chunk: { ...chunk, resolution: 1 }, source });
    expect(full.nativePixels).not.toBeNull();
    expect(efficient.nativePixels).toEqual(full.nativePixels);
    expect(efficient).toMatchObject({ nativeWidth: 16, nativeHeight: 16, widthPixels: 8, heightPixels: 8 });
    expect(efficient.pixels.tree.length * 4).toBe(full.pixels.tree.length);
    const alpha = [...full.nativePixels].filter((_value, index) => index % 4 === 3);
    expect(alpha.some(value => value === 0)).toBe(true);
    expect(alpha.some(value => value > 0)).toBe(true);
  });

  test('round-trips structured-cloneable samplers without detaching their original textures', () => {
    const original = lightingMaterialSnapshot();
    const pixels = new Uint8ClampedArray(4 * 4 * 4).fill(255);
    const prepared = prepareTreeMaterial({ width: 4, height: 4, data: pixels });
    const source = { ...original, tree: { state: { ready: true, revision: 7, status: 'ready' }, prepared } };
    try {
      installLightingMaterialSnapshot(structuredClone(source));
      expect(sampleTreeMaterial(.5, .5)).toEqual({ alpha: 1, baseColor: [255, 255, 255], normalDetail: [0, 0] });
      expect(source.tree.prepared.pixels.byteLength).toBe(64);
      expect(lightingMaterialSnapshot().tree.prepared).not.toBe(source.tree.prepared);
    } finally { installLightingMaterialSnapshot(original); }
  });

  test('retains exact shaded roof pixels and xray IDs while allocating normals only on demand', async () => {
    const chunk = { key: 'fixture', left: 275, top: 10, width: 4, height: 4, resolution: 1 };
    const bounds = { left: 267, top: 2, width: 20, height: 20 }, data = new Uint8ClampedArray(40 * 40 * 4);
    for (let offset = 0; offset < data.length; offset += 4) data.set([120, 120, 120, 255], offset);
    // Efficient lighting may use one receiver pixel per map unit while the
    // official source input still retains its existing two-pixel resolution.
    const source = { width: 40, height: 40, data, bounds, resolution: 2 };
    const plain = await compileCampusChunk({ chunk, source });
    const diagnostic = await compileCampusChunk({ chunk: { ...chunk, diagnostic: true }, source });
    expect(plain.pixels.normals).toBeUndefined();
    for (const channel of ['ground', 'tree', 'building']) expect(plain.pixels[channel]).toEqual(diagnostic.pixels[channel]);
    expect(plain.buildingIds).toEqual(diagnostic.buildingIds);
    const prepared = prepareGisMaterial(source, source);
    let checked = 0;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const sx = chunk.left + x + .5, sy = chunk.top + y + .5, hit = resolveCampusSurface(sx, sy);
      if (hit?.kind !== 'roof') continue;
      const albedo = samplePreparedGisMaterial(prepared, sx, sy, { kind: 'roof' });
      const light = sampleCampusLight(hit.position, hit.normal, { excludeId: hit.id, indirect: true, emissive: true, receiverKind: 'roof' });
      const color = shadeLinearSceneSurface(albedo.linearAlbedo, hit.normal, light, { roughness: .82 });
      const offset = (y * 4 + x) * 4;
      expect([...plain.pixels.building.slice(offset, offset + 4)]).toEqual([...color, 255]);
      expect(plain.buildingIds[y * 4 + x]).toBeGreaterThan(0); checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
