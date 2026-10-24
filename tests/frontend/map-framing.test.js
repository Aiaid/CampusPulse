import { describe, expect, test } from 'vitest';
import { fitMapFrame, libraryDetailFrame } from '../../src/campus/map-framing.js';
import { MAP_WIDTH, MAP_HEIGHT } from '../../src/campus/scene-data.js';

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
