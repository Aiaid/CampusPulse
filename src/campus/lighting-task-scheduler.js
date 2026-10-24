export function lightingAbortError() {
  const error = new Error('Lighting request cancelled'); error.name = 'AbortError'; return error;
}

/** Release an obsolete consumer immediately without cancelling an image/asset
 * promise shared with other views. Always remove its signal listener. */
export function awaitLightingInput(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(lightingAbortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(lightingAbortError());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', abort); resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

/** Check once per row, yield only when the time budget expires. Both worker
 * cancellation messages and browsers without Workers get regular event turns. */
export function createLightingCheckpoint({ signal, budgetMs = 5,
  now = () => performance.now(), pause = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
  let started = now();
  return () => {
    if (signal?.aborted) throw lightingAbortError();
    if (now() - started < budgetMs) return null;
    return pause().then(() => {
      if (signal?.aborted) throw lightingAbortError();
      started = now();
    });
  };
}

/** One shared bounded queue; each worker executes at most one task. Worker
 * failure retries the retained input through the cooperative main-thread path.
 * Aborted jobs never trigger fallback, and texture buffers are never detached. */
export function createLightingTaskScheduler({ createWorker, fallback, concurrency = 2,
  maxQueued = 48, timeoutMs = 60_000 } = {}) {
  const queue = [], slots = Array.from({ length: Math.max(1, Math.min(2, concurrency)) }, () => ({ worker: null, job: null, revision: null }));
  let nextId = 0, disposed = false, workerFailed = !createWorker;
  const settle = (job, error, value) => {
    if (job.settled) return;
    job.settled = true; job.signal?.removeEventListener('abort', job.abort);
    if (error) job.reject(error); else job.resolve(value);
  };
  const finish = (slot, error, value) => {
    clearTimeout(slot.deadline);
    const job = slot.job;
    if (!job) return;
    slot.job = null;
    settle(job, error, value);
    pump();
  };
  const runFallback = slot => {
    const job = slot.job;
    if (job.fallbackStarted) return;
    job.fallbackStarted = true;
    Promise.resolve().then(() => {
      if (job.controller.signal.aborted) throw lightingAbortError();
      return fallback(job.kind, job.payload, { signal: job.controller.signal });
    }).then(value => finish(slot, null, value), error => finish(slot, error));
  };
  const failWorker = slot => {
    clearTimeout(slot.deadline);
    slot.worker?.terminate(); slot.worker = null; slot.revision = null; workerFailed = true;
    if (slot.job) runFallback(slot);
  };
  const ensureWorker = slot => {
    if (slot.worker || workerFailed) return slot.worker;
    try {
      const worker = createWorker();
      if (!worker) { workerFailed = true; return null; }
      worker.onmessage = ({ data }) => {
        if (slot.worker !== worker || !slot.job || data.id !== slot.job.id) return;
        if (data.error) {
          // OffscreenCanvas support varies independently from Worker support.
          // A worker-side capability failure uses the exact same compiler in
          // the browser, with a much smaller cooperative slice.
          if (data.error.name === 'AbortError') finish(slot, lightingAbortError());
          else failWorker(slot);
        } else finish(slot, null, data.value);
      };
      worker.onerror = event => { event.preventDefault?.(); if (slot.worker === worker) failWorker(slot); };
      worker.onmessageerror = () => { if (slot.worker === worker) failWorker(slot); };
      slot.worker = worker;
      return worker;
    } catch { workerFailed = true; return null; }
  };
  const pump = () => {
    if (disposed) return;
    for (const slot of slots) {
      if (slot.job) continue;
      let job;
      while (queue.length && !job) { const candidate = queue.shift(); if (!candidate.settled) job = candidate; }
      if (!job) break;
      slot.job = job;
      const worker = ensureWorker(slot);
      if (!worker) { runFallback(slot); continue; }
      try {
        const assets = slot.revision === job.assets.revision ? undefined : job.assets;
        worker.postMessage({ id: job.id, kind: job.kind, payload: job.payload, assets });
        slot.revision = job.assets.revision;
        slot.deadline = setTimeout(() => failWorker(slot), timeoutMs);
      } catch { failWorker(slot); }
    }
  };
  return {
    request(kind, payload, { signal, assets = { revision: '' } } = {}) {
      if (disposed || signal?.aborted) return Promise.reject(lightingAbortError());
      if (queue.length >= maxQueued) return Promise.reject(new Error('Lighting work queue is full'));
      return new Promise((resolve, reject) => {
        const job = { id: ++nextId, kind, payload, assets, signal, resolve, reject, controller: new AbortController() };
        job.abort = () => {
          job.controller.abort(); settle(job, lightingAbortError());
          const index = queue.indexOf(job);
          if (index >= 0) queue.splice(index, 1);
          const slot = slots.find(item => item.job === job);
          if (slot?.worker) {
            // Termination also covers a worker that is still importing its
            // modules. Recreate lazily for the next visible request.
            slot.worker.terminate(); slot.worker = null; slot.revision = null;
            finish(slot, lightingAbortError());
          }
        };
        signal?.addEventListener('abort', job.abort, { once: true });
        queue.push(job); pump();
      });
    },
    snapshot: () => ({ queued: queue.length, running: slots.filter(slot => slot.job).length,
      workers: slots.filter(slot => slot.worker).length, fallback: workerFailed }),
    dispose() {
      disposed = true;
      for (const job of [...queue, ...slots.map(slot => slot.job).filter(Boolean)]) job.abort();
      queue.length = 0;
      for (const slot of slots) { clearTimeout(slot.deadline); slot.worker?.terminate(); slot.worker = null; }
    },
  };
}
