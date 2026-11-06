import { useEffect, useMemo, useState } from 'react';
import { createFieldReader, FIELD_REFRESH_MS, normalizeFieldResponse } from './field-data.js';
import { fieldIllustration } from './field-illustration.js';
import { fieldPlaceRegistry } from './place-registry.js';
import { createVisiblePoller } from './visible-polling.js';

export const MAX_FIELD_MAP_PLACES = 32;
export const FIELD_MAP_CONCURRENCY = 4;

/** Only verified, in-map places qualify. Duplicate identities are ambiguous. */
export function selectFieldMapPlaces(places) {
  if (!Array.isArray(places)) return [];
  const counts = new Map();
  for (const place of places) if (typeof place?.id === 'string' && place.id) counts.set(place.id, (counts.get(place.id) || 0) + 1);
  const unique = places.filter(place => counts.get(place?.id) === 1);
  return fieldPlaceRegistry(unique).mapPlaces.slice(0, MAX_FIELD_MAP_PLACES);
}

/** A scoped, bounded read batch; source failures are independent. No writes,
 * history requests or synthetic observations enter this overview reader.
 */
export function createFieldMapReader(onState, fetcher, { visible = () => true } = {}) {
  let generation = 0;
  const active = new Set();
  const cancel = () => { generation += 1; for (const reader of active) reader.cancel(); active.clear(); };
  return {
    cancel,
    async read(places, { forceRefresh = false } = {}) {
      cancel();
      const run = generation;
      const queue = selectFieldMapPlaces(places);
      let next = 0;
      const worker = async () => {
        while (run === generation && visible() && next < queue.length) {
          const place = queue[next++];
          const reader = createFieldReader(state => {
            if (run === generation) onState(place.id, state);
          }, fetcher);
          active.add(reader);
          await reader.read({ placeId: place.id, mode: 'live', forceRefresh });
          active.delete(reader);
        }
      };
      await Promise.all(Array.from({ length: Math.min(FIELD_MAP_CONCURRENCY, queue.length) }, worker));
    },
  };
}

/** Normalization and exact-place projection are independent phases. Each scene
 * carries its own place and eligible groups; there is no nearest-place lookup.
 * The selected source is shared with the detail/session, never reread here.
 */
export function projectFieldMapScenes({ places, selectedId, selectedLive, reads = {}, now, enabled = true, layers = {} }) {
  if (!enabled || !Number.isFinite(now)) return [];
  return selectFieldMapPlaces(places).map(place => {
    const live = place.id === selectedId ? selectedLive : reads[place.id];
    let illustration = null;
    if (live?.data && !live.error) {
      try {
        const data = normalizeFieldResponse(live.data, { placeId: place.id, mode: 'live' });
        if (Date.parse(data.as_of) <= now) illustration = fieldIllustration({
          mode: 'field', live: { ...live, data }, now, enabled, layers, place,
        });
      } catch { /* Invalid sources clear only their own projection. */ }
    }
    return { place, illustration };
  });
}

export function useFieldMapObservations({ places, selectedId, selectedLive, now, enabled, layers }) {
  const eligible = useMemo(() => selectFieldMapPlaces(places), [places]);
  const otherPlaces = useMemo(() => eligible.filter(place => place.id !== selectedId), [eligible, selectedId]);
  // The scope includes source selection and verified GIS placement, so an old
  // response cannot publish into a new catalog or overwrite the selected read.
  const scope = JSON.stringify([enabled, selectedId, otherPlaces.map(place => [place.id, place.gis_anchor])]);
  const [state, setState] = useState({ scope: '', reads: {} });
  useEffect(() => {
    if (!enabled || !otherPlaces.length) return;
    let current = true;
    const reader = createFieldMapReader((placeId, read) => {
      if (!current) return;
      setState(previous => {
        const reads = previous.scope === scope ? previous.reads : {};
        return { scope, reads: { ...reads, [placeId]: {
          ...read, data: read.loading ? reads[placeId]?.data || null : read.data,
        } } };
      });
    }, undefined, { visible: () => document.visibilityState !== 'hidden' });
    const poll = createVisiblePoller(options => reader.read(otherPlaces, options), FIELD_REFRESH_MS);
    return () => { current = false; poll.stop(); reader.cancel(); };
  }, [enabled, otherPlaces, scope]);
  return useMemo(() => projectFieldMapScenes({ places: eligible, selectedId, selectedLive,
    reads: state.scope === scope ? state.reads : {}, now, enabled, layers,
  }), [eligible, selectedId, selectedLive, state, scope, now, enabled, layers]);
}
