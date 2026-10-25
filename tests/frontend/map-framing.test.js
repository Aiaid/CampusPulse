import { describe, expect, test } from 'vitest';
import { boundedMapView, minimumMapZoom, fitMapFrame, libraryDetailFrame } from '../../src/campus/map-framing.js';
import { MAP_WIDTH, MAP_HEIGHT } from '../../src/campus/scene-data.js';
import { GIS_SCENE_BOUNDS as grid } from '../../src/campus/gis-geometry.js';

describe('full official raster navigation bounds', () => {
  const viewports = [[1280, 800], [390, 844], [340, 135]];
  const project = (point, view, width, height) => {
    const scale = Math.max(width / MAP_WIDTH, height / MAP_HEIGHT) * view.zoom;
    return { x: width / 2 + view.x + (point.x - MAP_WIDTH / 2) * scale,
      y: height / 2 + view.y + (point.y - MAP_HEIGHT / 2) * scale };
  };

  test.each(viewports)('allows the authored crop corners to reach the center of a %ix%i viewport', (width, height) => {
    for (const zoom of [1, 1.7, 4, 12]) {
      const scale = Math.max(width / MAP_WIDTH, height / MAP_HEIGHT) * zoom;
      for (const [x, y] of [[0, 0], [MAP_WIDTH, 0], [0, MAP_HEIGHT], [MAP_WIDTH, MAP_HEIGHT]]) {
        const target = { zoom, x: (MAP_WIDTH / 2 - x) * scale, y: (MAP_HEIGHT / 2 - y) * scale };
        const view = boundedMapView(target, { width, height });
        expect(view).toEqual(target);
        expect(project({ x, y }, view, width, height).x).toBeCloseTo(width / 2, 8);
        expect(project({ x, y }, view, width, height).y).toBeCloseTo(height / 2, 8);
      }
    }
  });

  test.each(viewports)('keeps the real grid edges at the viewport edges when dragging in %ix%i', (width, height) => {
    for (const zoom of [minimumMapZoom({ width, height }), 1, 1.7, 4, 12]) {
      for (const [signX, signY] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const view = boundedMapView({ zoom, x: signX * 1e8, y: signY * 1e8 }, { width, height });
        const edge = project({ x: signX > 0 ? grid.left : grid.right, y: signY > 0 ? grid.top : grid.bottom }, view, width, height);
        expect(edge.x).toBeCloseTo(signX > 0 ? 0 : width, 8);
        expect(edge.y).toBeCloseTo(signY > 0 ? 0 : height, 8);
        const opposite = project({ x: signX > 0 ? grid.right : grid.left, y: signY > 0 ? grid.bottom : grid.top }, view, width, height);
        expect(signX > 0 ? opposite.x >= width : opposite.x <= 0).toBe(true);
        expect(signY > 0 ? opposite.y >= height : opposite.y <= 0).toBe(true);
      }
    }
  });

  test('permits moving into genuine chart content beyond the former crop', () => {
    const dimensions = { width: 1280, height: 800 };
    const scale = 1.25;
    for (const [x, y] of [[-600, -400], [1200, 1000]]) {
      const target = { zoom: 1, x: (MAP_WIDTH / 2 - x) * scale, y: (MAP_HEIGHT / 2 - y) * scale };
      expect(boundedMapView(target, dimensions)).toEqual(target);
    }
  });

  test('preserves intermediate positions and clamps zoom before computing pan bounds', () => {
    const dimensions = { width: 1280, height: 800 };
    expect(boundedMapView({ zoom: 2, x: 123, y: -45 }, dimensions)).toEqual({ zoom: 2, x: 123, y: -45 });
    expect(minimumMapZoom(dimensions)).toBe(0.8);
    expect(minimumMapZoom({ width: 340, height: 135 })).toBe(1);
    expect(boundedMapView({ zoom: 0.2, x: 0, y: 0 }, dimensions, 4).zoom).toBe(0.8);
    expect(boundedMapView({ zoom: 20, x: 0, y: 0 }, dimensions, 4).zoom).toBe(4);
  });

  test('centers an oversized viewport axis on the real chart', () => {
    const width = 5000, height = 4000;
    const view = boundedMapView({ zoom: 0, x: 1e8, y: -1e8 }, { width, height });
    const center = project({ x: (grid.left + grid.right) / 2, y: (grid.top + grid.bottom) / 2 }, view, width, height);
    expect(center.x).toBeCloseTo(width / 2, 8);
    expect(center.y).toBeCloseTo(height / 2, 8);
  });
});

describe('library entrance camera framing', () => {
  test.each([[394, 355], [394, 410], [340, 135]])('keeps the responsive scene inside a %ix%i panel', (width, height) => {
    const view = fitMapFrame(libraryDetailFrame, { width, height });
    const bounds = width / height > 1.8 ? libraryDetailFrame.wideBounds : libraryDetailFrame.bounds;
    const scale = Math.max(width / MAP_WIDTH, height / MAP_HEIGHT) * view.zoom;
    const x = (width - MAP_WIDTH * scale) / 2 + view.x + bounds.left * scale;
    const y = (height - MAP_HEIGHT * scale) / 2 + view.y + bounds.top * scale;
    expect(x).toBeGreaterThanOrEqual(12 - 1e-8);
    expect(y).toBeGreaterThanOrEqual(12 - 1e-8);
    expect(x + bounds.width * scale).toBeLessThanOrEqual(width - 12 + 1e-8);
    expect(y + bounds.height * scale).toBeLessThanOrEqual(height - 12 + 1e-8);
  });
  test('rejects unmeasured containers and respects the interactive zoom limit', () => {
    expect(fitMapFrame(libraryDetailFrame, { width: 0, height: 0 })).toBeNull();
    expect(fitMapFrame(libraryDetailFrame, { width: 400, height: 350 }, 2).zoom).toBe(2);
  });
});
