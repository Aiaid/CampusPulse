import { lightingMaterialSnapshot } from './lighting-material-snapshot.js';
import { requestLightingComputation } from './lighting-compute-client.js';
import { lightingAbortError } from './lighting-task-scheduler.js';
import { lightingQualityProfile } from './lighting-quality.js';
import { getLightingQuality, subscribeLightingQuality } from './lighting-quality-store.js';
export { libraryMaterialResponse, libraryBuildingMaterialColor,
  libraryPreservedWallReception } from './library-light-compiler.js';

/** Share the atlas across both cameras. Cancelling a camera only releases that
 * subscriber. A camera rerender can reacquire in the same turn; unused work is
 * cancelled before it occupies CPU for a hidden/unmounted view. */
export function createLibraryAtlasCache({ compile, revision }) {
  let cached = null, pending = null;
  const cache = {
    peek: () => cached,
    setResolutionBudget(resolution) {
      // Drop only the cache's ownership. A caller may still hold an atlas for
      // its scheduled draw, so closing its shared ImageBitmaps here is unsafe.
      if (cached && cached.resolution > resolution) cached = null;
      if (pending && pending.resolution > resolution) { pending.controller.abort(); pending = null; }
    },
    request({ diagnostic = false, resolution = 3, signal } = {}) {
      if (signal?.aborted) return Promise.reject(lightingAbortError());
      resolution = resolution === 2 ? 2 : 3;
      const materialRevision = revision(), key = `${materialRevision}:${resolution}`;
      // Cancel a superseded quality request even when the newly selected
      // quality already has a cached result. Otherwise an unwanted full atlas
      // can finish later and replace the lighter result again.
      if (pending && pending.key !== key) {
        pending.controller.abort(); pending = null;
      }
      if (cached?.key === key && (!diagnostic || cached.value.normals)) return Promise.resolve(cached.value);
      if (pending?.key === key && diagnostic && !pending.diagnostic) {
        return cache.request({ resolution, signal }).then(() => cache.request({ diagnostic, resolution, signal }));
      }
      if (!pending) {
        const task = { key, diagnostic, resolution, controller: new AbortController(), subscribers: new Set() };
        pending = task;
        task.promise = Promise.resolve().then(() => compile({ diagnostic, resolution, signal: task.controller.signal })).then(value => {
          if (task.controller.signal.aborted) throw lightingAbortError();
          if (revision() === materialRevision) cached = { key, resolution, value };
          return value;
        }).finally(() => { if (pending === task) pending = null; });
      }
      const task = pending;
      return new Promise((resolve, reject) => {
        const subscriber = {};
        const release = () => { task.subscribers.delete(subscriber); signal?.removeEventListener('abort', abort); };
        const abort = () => {
          release(); reject(lightingAbortError());
          queueMicrotask(() => {
            if (pending === task && !task.subscribers.size) { task.controller.abort(); pending = null; }
          });
        };
        task.subscribers.add(subscriber); signal?.addEventListener('abort', abort, { once: true });
        task.promise.then(value => { release(); resolve(value); }, error => { release(); reject(error); });
      });
    },
  };
  return cache;
}

const atlases = createLibraryAtlasCache({
  revision: () => lightingMaterialSnapshot().revision,
  compile: ({ diagnostic, resolution, signal }) => requestLightingComputation('library', { diagnostic, resolution }, { signal }),
});
const updateAtlasBudget = () => atlases.setResolutionBudget(lightingQualityProfile(getLightingQuality()).libraryResolution);
updateAtlasBudget();
subscribeLightingQuality(updateAtlasBudget);

/** Nonblocking read: production rendering requests preparation asynchronously. */
export function libraryLightAtlas() { return atlases.peek()?.value ?? null; }
export function requestLibraryLightAtlas({ quality = 'efficient', diagnostic = false, signal } = {}) {
  const resolution = diagnostic ? 3 : lightingQualityProfile(quality).libraryResolution;
  return atlases.request({ resolution, diagnostic, signal });
}
