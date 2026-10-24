// The complete official raster tile grid, not a surveyed campus footprint.
// Preserve the authored scene's origin and eight-original-pixels/unit mapping.
// Existing API anchors normalize both axes by this value, independently of
// the displayed image height. Keep that wire-coordinate denominator stable.
export const GIS_IMAGE_SIZE = 24576;
export const GIS_IMAGE_WIDTH = 24576;
export const GIS_IMAGE_HEIGHT = 24576;
export const GIS_ORIGINAL_PIXELS_PER_SCENE_UNIT = 8;
export const GIS_SCENE_ORIGIN = Object.freeze({ x: 10240, y: 7168 });
export const GIS_SCENE_BOUNDS = Object.freeze({
  left: -GIS_SCENE_ORIGIN.x / GIS_ORIGINAL_PIXELS_PER_SCENE_UNIT,
  top: -GIS_SCENE_ORIGIN.y / GIS_ORIGINAL_PIXELS_PER_SCENE_UNIT,
  right: (GIS_IMAGE_WIDTH - GIS_SCENE_ORIGIN.x) / GIS_ORIGINAL_PIXELS_PER_SCENE_UNIT,
  bottom: (GIS_IMAGE_HEIGHT - GIS_SCENE_ORIGIN.y) / GIS_ORIGINAL_PIXELS_PER_SCENE_UNIT,
  width: GIS_IMAGE_WIDTH / GIS_ORIGINAL_PIXELS_PER_SCENE_UNIT,
  height: GIS_IMAGE_HEIGHT / GIS_ORIGINAL_PIXELS_PER_SCENE_UNIT,
});

export function originalToScenePoint(point) {
  return { x: (point.x - GIS_SCENE_ORIGIN.x) / GIS_ORIGINAL_PIXELS_PER_SCENE_UNIT,
    y: (point.y - GIS_SCENE_ORIGIN.y) / GIS_ORIGINAL_PIXELS_PER_SCENE_UNIT };
}

export function sceneToOriginalPoint(point) {
  return { x: GIS_SCENE_ORIGIN.x + point.x * GIS_ORIGINAL_PIXELS_PER_SCENE_UNIT,
    y: GIS_SCENE_ORIGIN.y + point.y * GIS_ORIGINAL_PIXELS_PER_SCENE_UNIT };
}
