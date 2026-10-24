import { describe, expect, test } from 'vitest';
import { boundedMapView, fitMapFrame, libraryDetailFrame } from '../../src/campus/map-framing.js';
import { MAP_WIDTH, MAP_HEIGHT } from '../../src/campus/scene-data.js';

describe('map navigation bounds', () => {
  const viewports = [[1280, 800], [390, 844], [340, 135]];
  const corners = [[0, 0], [MAP_WIDTH, 0], [0, MAP_HEIGHT], [MAP_WIDTH, MAP_HEIGHT]];

  test.each(viewports)('allows all corners to reach the center of a %ix%i viewport', (width, height) => {
    for (const zoom of [1, 1.7, 4, 12]) {
      const scale = Math.max(width / MAP_WIDTH, height / MAP_HEIGHT) * zoom;
      for (const [mapX, mapY] of corners) {
        const target = { zoom, x: (MAP_WIDTH / 2 - mapX) * scale, y: (MAP_HEIGHT / 2 - mapY) * scale };
        const view = boundedMapView(target, { width, height });
        const screenX = width / 2 + view.x + (mapX - MAP_WIDTH / 2) * scale;
        const screenY = height / 2 + view.y + (mapY - MAP_HEIGHT / 2) * scale;
        expect(screenX).toBeCloseTo(width / 2, 8);
        expect(screenY).toBeCloseTo(height / 2, 8);
        expect(view).toEqual(target);
      }
    }
  });

  test.each(viewports)('clamps excessive dragging at the map corners in a %ix%i viewport', (width, height) => {
    for (const zoom of [1, 1.7, 4, 12]) {
      const scale = Math.max(width / MAP_WIDTH, height / MAP_HEIGHT) * zoom;
      for (const [signX, signY] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const view = boundedMapView({ zoom, x: signX * 1e8, y: signY * 1e8 }, { width, height });
        expect(view.x).toBe(signX * MAP_WIDTH * scale / 2);
        expect(view.y).toBe(signY * MAP_HEIGHT * scale / 2);
        // The viewport center stays on the map; blank margin cannot consume
        // more than half of the viewport along either axis.
        const centerX = MAP_WIDTH / 2 - view.x / scale;
        const centerY = MAP_HEIGHT / 2 - view.y / scale;
        expect(centerX).toBeCloseTo(signX > 0 ? 0 : MAP_WIDTH, 8);
        expect(centerY).toBeCloseTo(signY > 0 ? 0 : MAP_HEIGHT, 8);
      }
    }
  });

  test('preserves intermediate positions and clamps zoom before computing pan bounds', () => {
    const dimensions = { width: 1280, height: 800 };
    expect(boundedMapView({ zoom: 2, x: 123, y: -45 }, dimensions)).toEqual({ zoom: 2, x: 123, y: -45 });
    for (const [requestedZoom, zoom] of [[0.2, 1], [20, 4]]) {
      const scale = Math.max(dimensions.width / MAP_WIDTH, dimensions.height / MAP_HEIGHT) * zoom;
      expect(boundedMapView({ zoom: requestedZoom, x: 1e8, y: -1e8 }, dimensions, 4)).toEqual({
        zoom, x: MAP_WIDTH * scale / 2, y: -MAP_HEIGHT * scale / 2,
      });
    }
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
