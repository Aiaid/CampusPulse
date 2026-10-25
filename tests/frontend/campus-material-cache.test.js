import { describe, expect, test } from 'vitest';
import { CAMPUS_MATERIAL_HALO, visibleCampusChunks, campusChunkResolution,
  createCampusChunkCache, createCampusImageCache } from '../../src/campus/campus-material-cache.js';
import { prepareGisMaterial, samplePreparedGisMaterial } from '../../src/campus/gis-material.js';

const turn = () => new Promise(resolve => setTimeout(resolve, 0));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const chunk = key => ({ key, left: Number(key) * 128, top: 0, width: 128, height: 128 });

describe('world-registered campus material work', () => {
  test('covers all forty world chunks, clips outside views and preserves keys on camera changes', () => {
    const viewport = { width: 1024, height: 640, scale: 1, translateX: 0, translateY: 0 };
    const full = visibleCampusChunks(viewport);
    expect(full).toHaveLength(40);
    expect(new Set(full.map(value => value.key)).size).toBe(40);
    expect(visibleCampusChunks({ ...viewport, translateX: 1100 })).toEqual([]);
    const zoom = visibleCampusChunks({ ...viewport, width: 200, height: 200, scale: 2, translateX: -256, translateY: -256 });
    expect(zoom).toEqual([expect.objectContaining({ key: '1:1', left: 128, top: 128 })]);
    expect(visibleCampusChunks({ ...viewport, scale: 0 })).toEqual([]);
    expect(campusChunkResolution(1.8)).toBe(1);
    expect(campusChunkResolution(2.7)).toBe(2);
    expect(campusChunkResolution(100)).toBe(2);
  });

  test('shares viewport demand, limits jobs and prioritizes the union without duplicate compilation', async () => {
    const pending = [], calls = [];
    const cache = createCampusChunkCache({ concurrency: 2, compile: request => {
      calls.push(request); const job = deferred(); pending.push(job); return job.promise;
    } });
    cache.setViewport('overview', [chunk('0'), chunk('1')], 1);
    cache.setViewport('detail', [chunk('1'), chunk('2')], 2);
    await turn();
    expect(calls.map(value => value.key)).toEqual(['0', '1']);
    expect(cache.snapshot()).toMatchObject({ running: 2, visible: 3, owners: 2 });
    pending[0].resolve('zero'); pending[1].resolve('one'); await turn();
    // The in-flight coarse request is replaced once at detail quality; two
    // cameras do not create independent full-campus material caches.
    expect(calls.filter(value => value.key === '1').map(value => value.resolution)).toEqual([1, 2]);
    expect(cache.get('1')).toBe('one');
    expect(cache.snapshot().running).toBeLessThanOrEqual(2);
    for (let i = 2; i < pending.length; i++) pending[i].resolve(calls[i].key === '1' ? 'one-detail' : 'two-detail'); await turn();
    expect(cache.get('1')).toBe('one-detail');
    expect(cache.snapshot()).toMatchObject({ running: 0, ready: 3, entries: 3, detail: 2 });
  });

  test('keeps a coarse result through a failed upgrade and retries only after cooldown', async () => {
    let clock = 0, fail = false, attempts = 0;
    const cache = createCampusChunkCache({ now: () => clock, retryMs: 100,
      compile: async request => { attempts++; if (fail) throw new Error('CORS'); return `r${request.resolution}`; } });
    cache.setViewport('map', [chunk('0')], 1); await turn();
    expect(cache.get('0')).toBe('r1'); fail = true;
    cache.setViewport('map', [chunk('0')], 2); await turn();
    expect(cache.get('0')).toBe('r1'); expect(cache.snapshot().failed).toBe(1);
    cache.setViewport('map', [chunk('0')], 2); await turn(); expect(attempts).toBe(2);
    clock = 101; fail = false; cache.setViewport('map', [chunk('0')], 2); await turn();
    expect(cache.get('0')).toBe('r2'); expect(attempts).toBe(3);
  });

  test('never starts queued chunks after both viewports release them and evicts unpinned results', async () => {
    const first = deferred(), calls = [];
    const cache = createCampusChunkCache({ concurrency: 1, maxEntries: 2,
      compile: request => { calls.push(request.key); return calls.length === 1 ? first.promise : Promise.resolve(request.key); } });
    cache.setViewport('map', [chunk('0'), chunk('1')]); await turn();
    cache.removeViewport('map'); first.resolve('zero'); await turn();
    expect(calls).toEqual(['0']);
    cache.setViewport('other', [chunk('2'), chunk('3')]); await turn(); await turn();
    expect(cache.snapshot()).toMatchObject({ entries: 2, ready: 2 });
    expect(cache.get('0')).toBeNull();
  });

  test('invalidations replace visible material without exposing an empty result', async () => {
    const next = deferred(); let calls = 0;
    const cache = createCampusChunkCache({ compile: () => ++calls === 1 ? Promise.resolve('old') : next.promise });
    cache.setViewport('map', [chunk('0')]); await turn(); cache.invalidate(); await turn();
    expect(cache.get('0')).toBe('old'); next.resolve('fresh'); await turn();
    expect(cache.get('0')).toBe('fresh'); expect(cache.snapshot().entries).toBe(1);
  });

  test('cancels lost demand and stale generations without cooling down or exposing obsolete pixels', async () => {
    const jobs = [];
    const cache = createCampusChunkCache({ concurrency: 1, compile: (request, { signal }) => {
      const job = deferred(); jobs.push({ ...job, request, signal });
      signal.addEventListener('abort', () => job.reject(new Error('aborted')), { once: true });
      return job.promise;
    } });
    cache.setViewport('map', [chunk('0')]); await turn();
    cache.setViewport('map', [chunk('1')]); await turn();
    expect(jobs[0].signal.aborted).toBe(true); expect(jobs[1].request.key).toBe('1');
    cache.invalidate(); await turn(); expect(jobs[1].signal.aborted).toBe(true);
    jobs[2].resolve('current'); await turn();
    expect(cache.get('0')).toBeNull(); expect(cache.get('1')).toBe('current');
    expect(cache.snapshot()).toMatchObject({ running: 0, failed: 0, ready: 1 });
  });

  test('upgrades normals only for explicit diagnostic demand and reuses them after leaving diagnostics', async () => {
    const calls = [], cache = createCampusChunkCache({ compile: async request => { calls.push(request); return request; } });
    cache.setViewport('map', [chunk('0')]); await turn(); expect(calls[0].diagnostic).toBe(false);
    cache.setViewport('diagnostic', [chunk('0')], 1, { diagnostic: true }); await turn();
    expect(calls[1].diagnostic).toBe(true); expect(cache.snapshot().ready).toBe(1);
    cache.removeViewport('diagnostic'); cache.setViewport('map', [chunk('0')]); await turn();
    expect(calls).toHaveLength(2);
  });

  test('replaces full-resolution caches on a quality downgrade while retaining original source resolution', async () => {
    const calls = [], cache = createCampusChunkCache({ compile: async request => { calls.push(request); return request; } });
    cache.setViewport('map', [chunk('0'), chunk('1')], 2, { quality: 'full', sourceResolution: 2 }); await turn();
    expect(cache.snapshot()).toMatchObject({ ready: 2, detail: 2 });
    cache.setViewport('map', [chunk('0')], 1, { quality: 'efficient', sourceResolution: 2 }); await turn();
    expect(cache.get('0')).toMatchObject({ quality: 'efficient', resolution: 1, sourceResolution: 2 });
    expect(cache.get('1')).toBeNull();
    expect(cache.snapshot()).toMatchObject({ ready: 1, detail: 0, entries: 1 });
    cache.setViewport('map', [chunk('0')], 2, { quality: 'full', sourceResolution: 2 }); await turn();
    expect(cache.get('0')).toMatchObject({ quality: 'full', resolution: 2, sourceResolution: 2 });
    expect(calls.map(request => request.resolution)).toEqual([2, 2, 1, 2]);
  });

  test('an efficient quality budget releases full caches even after every viewport unmounts', async () => {
    const cache = createCampusChunkCache({ compile: async request => request });
    cache.setViewport('map', [chunk('0')], 2, { quality: 'full', sourceResolution: 2 }); await turn();
    cache.removeViewport('map'); expect(cache.snapshot()).toMatchObject({ entries: 1, owners: 0 });
    cache.setQualityBudget('efficient', 1);
    expect(cache.snapshot()).toMatchObject({ entries: 0, owners: 0, running: 0 });
    expect(cache.get('0')).toBeNull();
  });

  test('cancels obsolete high-quality compilation and accepts only the replacement quality', async () => {
    const jobs = [], cache = createCampusChunkCache({ concurrency: 1, compile: (request, { signal }) => {
      const job = deferred(); jobs.push({ ...job, request, signal });
      signal.addEventListener('abort', () => job.reject(new Error('aborted')), { once: true }); return job.promise;
    } });
    cache.setViewport('map', [chunk('0')], 2, { quality: 'full', sourceResolution: 2 }); await turn();
    cache.setViewport('map', [chunk('0')], 1, { quality: 'efficient', sourceResolution: 2 }); await turn();
    expect(jobs[0].signal.aborted).toBe(true);
    expect(jobs[1].request).toMatchObject({ quality: 'efficient', resolution: 1, sourceResolution: 2 });
    jobs[1].resolve('efficient'); await turn();
    expect(cache.get('0')).toBe('efficient'); expect(cache.snapshot()).toMatchObject({ ready: 1, running: 0, failed: 0 });
  });

  test('bounds image residency and coalesces requests across simultaneous chunks', async () => {
    let calls = 0, clock = 0;
    const imageCache = createCampusImageCache({ maxEntries: 2, now: () => clock, retryMs: 100,
      load: async tile => { calls++; if (tile.key === 'bad') throw new Error('network'); return tile.key; } });
    await Promise.all([imageCache.get({ key: 'a' }), imageCache.get({ key: 'a' })]);
    expect(calls).toBe(1);
    expect(await imageCache.get({ key: 'bad' })).toBeNull();
    expect(await imageCache.get({ key: 'bad' })).toBeNull(); expect(calls).toBe(2);
    clock = 101; await imageCache.get({ key: 'bad' }); expect(calls).toBe(3);
    await imageCache.get({ key: 'c' }); expect(imageCache.snapshot().entries).toBe(2);
  });

  test('normalization halo makes retained border samples agree with a larger source preparation', () => {
    const make = (left, width) => {
      const data = new Uint8ClampedArray(width * 24 * 4);
      for (let y = 0; y < 24; y++) for (let x = 0; x < width; x++) {
        const value = 40 + ((left + x) % 31) * 4;
        data.set([value, value * .8, value * .6, 255], (y * width + x) * 4);
      }
      return prepareGisMaterial({ width, height: 24, data },
        { bounds: { left, top: 0, width, height: 24 }, resolution: 1 });
    };
    const halo = CAMPUS_MATERIAL_HALO;
    const whole = make(0, 280), left = make(0, 128 + halo), right = make(128 - halo, 128 + halo * 2);
    for (const [x, source] of [[127.5, left], [128.5, right]]) {
      expect(samplePreparedGisMaterial(source, x, 12).linearAlbedo)
        .toEqual(samplePreparedGisMaterial(whole, x, 12).linearAlbedo);
    }
  });
});
