import { GIS_IMAGE_SIZE, GIS_SCENE_BOUNDS, originalToScenePoint, sceneToOriginalPoint } from './gis-geometry.js';
import { formatObservationKinds } from '../shared/observation-kinds.js';

// The API stores coordinates normalized against the complete official GIS
// chart. Keep the authored scene origin while accepting the complete grid.
const finitePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);
const inside = (value, min, max) => value >= min && value <= max;

export function gisAnchorToScene(anchor) {
  if (!finitePoint(anchor) || !inside(anchor.x, 0, 1) || !inside(anchor.y, 0, 1)) return null;
  return originalToScenePoint({ x: anchor.x * GIS_IMAGE_SIZE, y: anchor.y * GIS_IMAGE_SIZE });
}

export function scenePointToGisAnchor(point) {
  if (!finitePoint(point) || !inside(point.x, GIS_SCENE_BOUNDS.left, GIS_SCENE_BOUNDS.right)
    || !inside(point.y, GIS_SCENE_BOUNDS.top, GIS_SCENE_BOUNDS.bottom)) return null;
  const original = sceneToOriginalPoint(point);
  return { x: original.x / GIS_IMAGE_SIZE, y: original.y / GIS_IMAGE_SIZE };
}

export const fieldPlaceKinds = { activity: '活动观察点', parking: '停车观察点', elevator: '候梯观察点' };

export function fieldPlaceRegistry(apiPlaces) {
  const mapPlaces = [], unlocatedPlaces = [];
  for (const place of apiPlaces) {
    const point = place.gis_anchor?.verified === true ? gisAnchorToScene(place.gis_anchor) : null;
    if (!point) {
      unlocatedPlaces.push({ ...place, mapUnavailableReason: place.gis_anchor?.verified === true ? 'outside-map' : 'unverified-gis' });
      continue;
    }
    mapPlaces.push({ ...place, ...point, subtitle: `${formatObservationKinds(place) || '现场观察点'} · 已核验 GIS 锚点` });
  }
  return { mapPlaces, unlocatedPlaces };
}
