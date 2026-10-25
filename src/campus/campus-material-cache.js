/** Viewport-owned material work: stable world keys, one replaceable resolution
 * per key, bounded residency and two cooperative CPU jobs shared by both maps. */
export const CAMPUS_CHUNK_SIZE = 128;
export const CAMPUS_BOUNDS = Object.freeze({ left: 0, top: 0, width: 1024, height: 640 });
export const CAMPUS_MATERIAL_HALO = 8;
export const campusChunkResolution = density => density > 1.8 ? 2 : 1;

export function visibleCampusChunks({ width, height, scale, translateX, translateY, overscan = 0 }) {
  if (![width, height, scale, translateX, translateY, overscan].every(Number.isFinite)
    || width <= 0 || height <= 0 || scale <= 0) return [];
  const left = Math.max(0, (-translateX - overscan) / scale);
  const top = Math.max(0, (-translateY - overscan) / scale);
  const right = Math.min(1024, (width - translateX + overscan) / scale);
  const bottom = Math.min(640, (height - translateY + overscan) / scale);
  if (right <= left || bottom <= top) return [];
  const chunks = [];
  for (let row = Math.floor(top / 128); row < Math.ceil(bottom / 128); row++) {
    for (let column = Math.floor(left / 128); column < Math.ceil(right / 128); column++) {
      chunks.push({ key: `${column}:${row}`, left: column * 128, top: row * 128, width: 128, height: 128 });
    }
  }
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  return chunks.sort((a, b) => Math.hypot(a.left + 64 - cx, a.top + 64 - cy)
    - Math.hypot(b.left + 64 - cx, b.top + 64 - cy));
}

/** Compile is injected so scheduler guarantees can be exercised without a DOM,
 * texture mocks, network or implementation-shaped browser fixtures. */
export function createCampusChunkCache({ compile, maxEntries = 64, concurrency = 2,
  now = () => Date.now(), retryMs = 30_000 } = {}) {
  const entries = new Map(), owners = new Map(), listeners = new Set();
  let running = 0, revision = 0, generation = 0, tick = 0, qualityBudget = null;
  const notify = () => { revision++; for (const listener of listeners) listener(); };
  const demands = () => {
    const union = new Map();
    for (const viewport of owners.values()) for (const chunk of viewport.chunks) {
      const prior = union.get(chunk.key);
      union.set(chunk.key, { ...chunk, resolution: Math.max(prior?.resolution ?? 0, viewport.resolution),
        sourceResolution: Math.max(prior?.sourceResolution ?? 0, viewport.sourceResolution),
        quality: prior?.quality === 'full' || viewport.quality === 'full' ? 'full' : 'efficient',
        diagnostic: Boolean(prior?.diagnostic || viewport.diagnostic) });
    }
    return union;
  };
  const trim = () => {
    const pinned = demands();
    for (const entry of [...entries.values()].sort((a, b) => a.used - b.used)) {
      if (entries.size <= maxEntries) break;
      if (!pinned.has(entry.key) && !entry.running) entries.delete(entry.key);
    }
  };
  const pump = () => {
    const wanted = demands();
    for (const entry of entries.values()) {
      const demand = wanted.get(entry.key);
      if (entry.running && (!demand || entry.targetGeneration !== generation
        || entry.targetQuality !== demand.quality || entry.targetResolution > demand.resolution
        || entry.targetSourceResolution > demand.sourceResolution)) entry.controller.abort();
      // Switching all cameras to the lighter profile also releases high-detail
      // chunks that have left the viewport instead of retaining them forever.
      if (!demand && !entry.running && entry.quality === 'full'
        && (qualityBudget?.quality === 'efficient'
          || owners.size && [...owners.values()].every(viewport => viewport.quality === 'efficient'))) entries.delete(entry.key);
    }
    for (const chunk of wanted.values()) {
      if (running >= concurrency) break;
      let entry = entries.get(chunk.key);
      if (!entry) {
        trim();
        if (entries.size >= maxEntries) {
          const oldest = [...entries.values()].find(value => !wanted.has(value.key) && !value.running);
          if (oldest) entries.delete(oldest.key); else continue;
        }
        entry = { ...chunk, value: null, resolution: 0, generation: -1, used: ++tick, running: false, failedAt: -Infinity };
        entries.set(chunk.key, entry);
      }
      const adequate = entry.value && entry.resolution === chunk.resolution && entry.generation === generation
        && entry.quality === chunk.quality && entry.sourceResolution === chunk.sourceResolution
        && (!chunk.diagnostic || entry.diagnostic);
      const signature = `${chunk.quality}:${chunk.resolution}:${chunk.sourceResolution}`;
      if (entry.running || adequate || entry.failedSignature === signature && now() - entry.failedAt < retryMs) continue;
      const targetGeneration = generation, targetResolution = chunk.resolution;
      const diagnostic = Boolean(chunk.diagnostic || entry.diagnostic && entry.quality === chunk.quality
        && entry.resolution === targetResolution), controller = new AbortController();
      entry.running = true; entry.controller = controller; entry.targetGeneration = targetGeneration;
      entry.targetQuality = chunk.quality; entry.targetResolution = targetResolution;
      entry.targetSourceResolution = chunk.sourceResolution; running++; notify();
      Promise.resolve().then(() => compile({ ...chunk, resolution: targetResolution, diagnostic }, { signal: controller.signal })).then(value => {
        if (controller.signal.aborted || targetGeneration !== generation) return;
        if (!value) throw new Error('Material unavailable');
        entry.value = value; entry.resolution = targetResolution; entry.generation = targetGeneration;
        entry.diagnostic = diagnostic; entry.quality = chunk.quality; entry.sourceResolution = chunk.sourceResolution;
        entry.failedAt = -Infinity; entry.used = ++tick;
      }).catch(() => { if (!controller.signal.aborted) { entry.failedAt = now(); entry.failedSignature = signature; } }).finally(() => {
        entry.running = false; running--; trim(); notify(); pump();
      });
    }
  };
  return {
    setViewport(owner, chunks, resolution = 1, { diagnostic = false, quality = 'full', sourceResolution = resolution } = {}) {
      if (qualityBudget) { quality = qualityBudget.quality; resolution = Math.min(resolution, qualityBudget.resolutionLimit); }
      owners.set(owner, { chunks, resolution: Math.max(1, Math.min(2, resolution)), diagnostic,
        quality, sourceResolution: Math.max(1, Math.min(2, sourceResolution)) });
      for (const chunk of chunks) { const entry = entries.get(chunk.key); if (entry) entry.used = ++tick; }
      trim(); pump();
    },
    removeViewport(owner) { owners.delete(owner); trim(); pump(); },
    setQualityBudget(quality, resolutionLimit) {
      qualityBudget = { quality, resolutionLimit: Math.max(1, Math.min(2, resolutionLimit)) };
      for (const viewport of owners.values()) {
        viewport.quality = quality;
        viewport.resolution = Math.min(viewport.sourceResolution, qualityBudget.resolutionLimit);
      }
      // This is also called with zero owners, so unmounted maps cannot keep an
      // obsolete high-resolution allocation alive until their next render.
      pump(); notify();
    },
    get(key) { return entries.get(key)?.value ?? null; },
    values() { return [...entries.values()].map(entry => entry.value).filter(Boolean); },
    invalidate() { generation++; for (const entry of entries.values()) entry.failedAt = -Infinity; pump(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot() {
      const wanted = demands();
      return { revision, generation, running, owners: owners.size, entries: entries.size, visible: wanted.size,
        ready: [...wanted.values()].filter(chunk => {
          const entry = entries.get(chunk.key);
          return entry?.value && entry.generation === generation && entry.resolution === chunk.resolution
            && entry.quality === chunk.quality && entry.sourceResolution === chunk.sourceResolution
            && (!chunk.diagnostic || entry.diagnostic);
        }).length,
        failed: [...entries.values()].filter(entry => Number.isFinite(entry.failedAt)).length,
        detail: [...entries.values()].filter(entry => entry.resolution === 2).length };
    },
  };
}

/** Bounded anonymous source-image cache. Failed images are released and retried
 * only after a cooldown; no historical GIS files or browser map image mutation. */
export function createCampusImageCache({ load, maxEntries = 64, now = () => Date.now(), retryMs = 30_000 }) {
  const entries = new Map();
  let tick = 0;
  return {
    get(tile) {
      const previous = entries.get(tile.key);
      if (previous && (previous.status !== 'failed' || now() - previous.failedAt < retryMs)) {
        previous.used = ++tick; return previous.promise;
      }
      if (previous) entries.delete(tile.key);
      while (entries.size >= maxEntries) {
        const oldest = [...entries.values()].sort((a, b) => a.used - b.used)[0];
        entries.delete(oldest.key);
      }
      const entry = { key: tile.key, used: ++tick, status: 'loading', failedAt: -Infinity, promise: null };
      entry.promise = Promise.resolve().then(() => load(tile)).then(value => {
        if (!value) throw new Error('Source unavailable'); entry.status = 'ready'; return value;
      }).catch(() => { entry.status = 'failed'; entry.failedAt = now(); return null; });
      entries.set(tile.key, entry);
      return entry.promise;
    },
    snapshot: () => ({ entries: entries.size, pending: [...entries.values()].filter(entry => entry.status === 'loading').length }),
  };
}
