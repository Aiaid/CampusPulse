import { MAP_WIDTH, MAP_HEIGHT } from './scene-data.js';

/** Keep the camera center on the map while allowing every edge to reach the
 * viewport center. This permits up to half a viewport of blank margin, so
 * landmarks near the raster boundary remain reachable at every zoom level.
 */
export function boundedMapView(next, dimensions, maxZoom = 12) {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const zoom = clamp(next.zoom, 1, maxZoom);
  const scale = Math.max(dimensions.width / MAP_WIDTH, dimensions.height / MAP_HEIGHT) * zoom;
  const limitX = MAP_WIDTH * scale / 2;
  const limitY = MAP_HEIGHT * scale / 2;
  return { zoom, x: clamp(next.x, -limitX, limitX), y: clamp(next.y, -limitY, limitY) };
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
