import { createLightingTaskScheduler } from './lighting-task-scheduler.js';
import { lightingMaterialSnapshot } from './lighting-material-snapshot.js';

const tasks = createLightingTaskScheduler({
  createWorker: typeof Worker === 'undefined' ? null
    : () => new Worker(new URL('./lighting-compute.worker.js', import.meta.url), { type: 'module', name: 'campus-lighting' }),
  async fallback(kind, payload, options) {
    if (kind === 'campus') {
      const { compileCampusChunk } = await import('./campus-light-compiler.js');
      return compileCampusChunk(payload, options);
    }
    const { compileLibraryLightAtlas } = await import('./library-light-compiler.js');
    return compileLibraryLightAtlas({ ...payload, ...options });
  },
});

export function requestLightingComputation(kind, payload, { signal } = {}) {
  return tasks.request(kind, payload, { signal, assets: lightingMaterialSnapshot() });
}
export const lightingComputeState = () => tasks.snapshot();
