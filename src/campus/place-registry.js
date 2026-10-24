import { MAP_HEIGHT, MAP_WIDTH, sceneAttribution } from './scene-data.js';

// The API stores coordinates normalized against the complete official GIS
// chart. The frontend displays only this chart's cropped campus extent.
const GIS_SIZE = 24576;
const { minX, minY, maxX, maxY } = sceneAttribution.extent;
const finitePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);
const inside = (value, min, max) => value >= min && value <= max;

export function gisAnchorToScene(anchor) {
  if (!finitePoint(anchor) || !inside(anchor.x, 0, 1) || !inside(anchor.y, 0, 1)) return null;
  const worldX = anchor.x * GIS_SIZE, worldY = anchor.y * GIS_SIZE;
  if (!inside(worldX, minX, maxX) || !inside(worldY, minY, maxY)) return null;
  return { x: (worldX - minX) / (maxX - minX) * MAP_WIDTH, y: (worldY - minY) / (maxY - minY) * MAP_HEIGHT };
}

export function scenePointToGisAnchor(point) {
  if (!finitePoint(point) || !inside(point.x, 0, MAP_WIDTH) || !inside(point.y, 0, MAP_HEIGHT)) return null;
  return { x: (minX + point.x / MAP_WIDTH * (maxX - minX)) / GIS_SIZE, y: (minY + point.y / MAP_HEIGHT * (maxY - minY)) / GIS_SIZE };
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
    mapPlaces.push({ ...place, ...point, subtitle: `${fieldPlaceKinds[place.kind] || '现场观察点'} · 已核验 GIS 锚点` });
  }
  return { mapPlaces, unlocatedPlaces };
}
