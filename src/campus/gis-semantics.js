import semantics from './gis-semantics.json' with { type: 'json' };

export const semanticsMetadata = semantics.metadata;
export const sourcePolygons = semantics.sourcePolygons;
export const roadLabels = semantics.roadLabels;

const normalizedName = value => String(value ?? '').normalize('NFKC').replace(/\s/g, '');

// Tip feature IDs (zH) are independent of point-label gadget IDs.
export function getSourcePolygonBySourceId(sourceId) {
  return sourcePolygons.find(polygon => polygon.sourceId === String(sourceId)) ?? null;
}

export function getSourcePolygonByName(name) {
  return sourcePolygons.find(polygon => normalizedName(polygon.name) === normalizedName(name)) ?? null;
}

export function findSourcePolygon(query) {
  if (query == null) return null;
  if (typeof query === 'object') {
    return (query.sourceId != null ? getSourcePolygonBySourceId(query.sourceId) : null)
      ?? (query.name != null ? getSourcePolygonByName(query.name) : null);
  }
  return getSourcePolygonBySourceId(query) ?? getSourcePolygonByName(query);
}
