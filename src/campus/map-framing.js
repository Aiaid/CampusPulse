import { MAP_WIDTH, MAP_HEIGHT } from './scene-data.js';
import { GIS_SCENE_BOUNDS } from './gis-geometry.js';

/** Reach the coarsest tile's native scale without zooming small panels in. */
export function minimumMapZoom(dimensions) {
  const base = Math.max(dimensions.width / MAP_WIDTH, dimensions.height / MAP_HEIGHT);
  return base > 0 ? Math.min(1, 1 / base) : 1;
}

/** Clamp to the complete official raster grid, preserving scene coordinates.
 * If a viewport axis exceeds the grid, center that axis instead of inventing
 * more map data. Otherwise neither real grid edge can be dragged into blank.
 */
export function boundedMapView(next, dimensions, maxZoom = 12) {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const zoom = clamp(next.zoom, minimumMapZoom(dimensions), maxZoom);
  const scale = Math.max(dimensions.width / MAP_WIDTH, dimensions.height / MAP_HEIGHT) * zoom;
  const boundAxis = (value, start, end, viewportSize, sceneSize) => {
    const center = sceneSize / 2;
    if ((end - start) * scale < viewportSize) return (center - (start + end) / 2) * scale;
    return clamp(value, viewportSize / 2 + (center - end) * scale,
      -viewportSize / 2 + (center - start) * scale);
  };
  return { zoom,
    x: boundAxis(next.x, GIS_SCENE_BOUNDS.left, GIS_SCENE_BOUNDS.right, dimensions.width, MAP_WIDTH),
    y: boundAxis(next.y, GIS_SCENE_BOUNDS.top, GIS_SCENE_BOUNDS.bottom, dimensions.height, MAP_HEIGHT) };
}

/** Authored display bounds in the existing GIS chart, not surveyed extents.
 * A tall panel shows the roof, facade and forecourt together. A wide phone
 * strip keeps the entrance legible rather than shrinking the whole campus.
 */
export const libraryDetailFrame = Object.freeze({
  bounds: { left: 554, top: 190, width: 169, height: 134 },
  wideBounds: { left: 571, top: 235, width: 147, height: 78 },
  padding: 12,
});

export function fitMapFrame(frame, viewport, maxZoom = 12) {
  const { width, height } = viewport;
  if (!(width > 0 && height > 0)) return null;
  const bounds = width / height > 1.8 && frame.wideBounds ? frame.wideBounds : frame.bounds;
  if (!(bounds?.width > 0 && bounds?.height > 0)) return null;
  const padding = Math.max(0, Math.min(frame.padding ?? 12, width / 4, height / 4));
  const base = Math.max(width / MAP_WIDTH, height / MAP_HEIGHT);
  const zoom = Math.max(1, Math.min(maxZoom,
    Math.min((width - 2 * padding) / bounds.width, (height - 2 * padding) / bounds.height) / base));
  const scale = base * zoom;
  return { zoom, x: (MAP_WIDTH / 2 - bounds.left - bounds.width / 2) * scale,
    y: (MAP_HEIGHT / 2 - bounds.top - bounds.height / 2) * scale };
}
