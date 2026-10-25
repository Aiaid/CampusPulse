export const observationKindLabels = Object.freeze({
  activity: '活动监测',
  parking: '电动车监控',
  elevator: '电梯观测',
});

/** A place may serve several purposes; kind remains a legacy primary only. */
export function observationKinds(place) {
  const kinds = Array.isArray(place?.observation_kinds)
    ? [...new Set(place.observation_kinds.filter(kind => Object.hasOwn(observationKindLabels, kind)))] : [];
  return kinds.length ? kinds : Object.hasOwn(observationKindLabels, place?.kind) ? [place.kind] : [];
}

export function formatObservationKinds(placeOrKinds) {
  return observationKinds(Array.isArray(placeOrKinds) ? { observation_kinds: placeOrKinds } : placeOrKinds)
    .map(kind => observationKindLabels[kind]).join(' · ');
}
