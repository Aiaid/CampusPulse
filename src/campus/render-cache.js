/** Small LRU for exact render inputs. Dependencies retain object identity;
 * coordinates are never rounded and undefined/null are valid cached results.
 */
export function createRenderCache(maxEntries = 512) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('Invalid render cache capacity');
  const entries = new Map();
  return {
    get size() { return entries.size; },
    clear: () => entries.clear(),
    resolve(key, dependencies, compute) {
      const previous = entries.get(key);
      if (previous && previous.dependencies.length === dependencies.length
        && dependencies.every((value, index) => Object.is(value, previous.dependencies[index]))) {
        entries.delete(key); entries.set(key, previous);
        return previous.value;
      }
      const value = compute();
      entries.delete(key);
      entries.set(key, { dependencies: dependencies.slice(), value });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return value;
    },
  };
}

/** Queries return fresh wrapper objects, but their prepared canvas identity is
 * stable until a resident chunk is replaced. Include geometry and crop depth
 * as well so neither a replacement nor a changed registration can stay stale.
 */
export function nativeMaskDependencies(masks) {
  return masks.flatMap(mask => [mask.canvas, mask.left, mask.top, mask.width, mask.height, mask.heightProxy]);
}

/** Shared exact-coordinate actor samples serve parked poses and both cameras.
 * Authored lighting depends on the tree artwork, not native chunk progress.
 */
export function createActorLightSampler({ sampleLocal, sampleLibrary, sampleCampus, blend }, maxEntries = 600) {
  const cache = createRenderCache(maxEntries);
  return {
    get size() { return cache.size; },
    sample(actor, { campus, libraryAmount, treeRevision }) {
      const mode = campus ? 'campus' : libraryAmount > 0 ? 'library' : 'local';
      return cache.resolve(`${mode}:${actor.id}`, [actor.x, actor.y, treeRevision, libraryAmount], () => {
        // Campus owns the full result. Sampling the old local field here was
        // expensive work whose value was immediately discarded.
        if (campus) return sampleCampus(actor.x, actor.y);
        const previous = sampleLocal(actor.x, actor.y);
        return libraryAmount > 0 ? blend(previous, sampleLibrary(actor.x, actor.y), libraryAmount) : previous;
      });
    },
  };
}
