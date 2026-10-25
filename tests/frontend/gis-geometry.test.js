import { describe, expect, test } from 'vitest';
import { GIS_IMAGE_SIZE, GIS_IMAGE_WIDTH, GIS_IMAGE_HEIGHT, GIS_SCENE_BOUNDS,
  originalToScenePoint, sceneToOriginalPoint } from '../../src/campus/gis-geometry.js';

describe('official raster grid and authored scene registration', () => {
  test('keeps normalization and the original authored scene registration', () => {
    expect(GIS_IMAGE_SIZE).toBe(24576);
    expect(GIS_IMAGE_WIDTH).toBe(24576);
    expect(GIS_IMAGE_HEIGHT).toBe(24576);
    expect(originalToScenePoint({ x: 10240, y: 7168 })).toEqual({ x: 0, y: 0 });
    expect(originalToScenePoint({ x: 18432, y: 12288 })).toEqual({ x: 1024, y: 640 });
    expect(originalToScenePoint({ x: 15602, y: 8970 })).toEqual({ x: 670.25, y: 225.25 });
  });

  test('represents the full image grid outside the old scene rectangle', () => {
    expect(GIS_SCENE_BOUNDS).toEqual({ left: -1280, top: -896, right: 1792, bottom: 2176, width: 3072, height: 3072 });
    expect(originalToScenePoint({ x: 0, y: 0 })).toEqual({ x: GIS_SCENE_BOUNDS.left, y: GIS_SCENE_BOUNDS.top });
    expect(originalToScenePoint({ x: GIS_IMAGE_WIDTH, y: GIS_IMAGE_HEIGHT })).toEqual({ x: GIS_SCENE_BOUNDS.right, y: GIS_SCENE_BOUNDS.bottom });
  });

  test.each([{ x: 0, y: 0 }, { x: 24576, y: 18432 }, { x: 10240, y: 7168 }, { x: 15602, y: 8970 }])('round trips original pixels %j without changing anchors', point => {
    expect(sceneToOriginalPoint(originalToScenePoint(point))).toEqual(point);
  });
});
