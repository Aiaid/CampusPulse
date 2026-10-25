import { describe, expect, test } from 'vitest';
import { fieldPlaceRegistry, gisAnchorToScene, scenePointToGisAnchor } from '../../src/campus/place-registry.js';

describe('official full-chart GIS coordinates with the authored scene origin', () => {
  test('projects the API library seed without substituting the authored demo label', () => {
    expect(gisAnchorToScene({ x: 15656 / 24576, y: 9059 / 24576 })).toEqual({ x: 677, y: 236.375 });
  });
  test.each([{ x: -1280, y: -896 }, { x: 1792, y: 2176 }, { x: 0, y: 0 }, { x: 1024, y: 640 }, { x: 677, y: 236.375 }])('round-trips scene point %j', point => {
    const projected = gisAnchorToScene(scenePointToGisAnchor(point));
    expect(projected.x).toBeCloseTo(point.x, 9);
    expect(projected.y).toBeCloseTo(point.y, 9);
  });
  test.each([null, {}, { x: '0.5', y: 0.4 }, { x: NaN, y: 0.4 }, { x: 0.5, y: Infinity }, { x: -1, y: 0.4 }, { x: 1.1, y: 0.4 }])('rejects malformed or outside-grid GIS input %j', anchor => {
    expect(gisAnchorToScene(anchor)).toBeNull();
  });
  test.each([null, {}, { x: '1', y: 2 }, { x: -1281, y: 2 }, { x: 1793, y: 2 }, { x: 1, y: 2177 }, { x: 1, y: NaN }])('rejects scene input outside picker bounds %j', point => {
    expect(scenePointToGisAnchor(point)).toBeNull();
  });
});

describe('field place registry', () => {
  test('uses only verified in-view API anchors, preserving API names, IDs and kinds', () => {
    const gis = { x: 15656 / 24576, y: 9059 / 24576, verified: true };
    const input = [
      { id: 'custom-parking', name: '更新后的停车点', kind: 'parking', gis_anchor: gis },
      { id: 'schematic-only', name: '示意锚点', kind: 'activity', anchor: { x: 0.5, y: 0.4 } },
      { id: 'unverified', kind: 'elevator', gis_anchor: { ...gis, verified: false } },
      { id: 'outside', kind: 'activity', gis_anchor: { x: 1.1, y: 0.1, verified: true } },
    ];
    const registry = fieldPlaceRegistry(input);
    expect(registry.mapPlaces).toEqual([{ ...input[0], x: 677, y: 236.375, subtitle: '停车观察点 · 已核验 GIS 锚点' }]);
    expect(registry.unlocatedPlaces.map(place => [place.id, place.mapUnavailableReason])).toEqual([
      ['schematic-only', 'unverified-gis'], ['unverified', 'unverified-gis'], ['outside', 'outside-map'],
    ]);
    expect(input[0]).not.toHaveProperty('x');
    expect(registry.mapPlaces[0]).not.toHaveProperty('people');
  });
  test('keeps an empty API catalog empty', () => {
    expect(fieldPlaceRegistry([])).toEqual({ mapPlaces: [], unlocatedPlaces: [] });
  });
  test('keeps verified places beyond the former crop reachable without clamping their coordinates', () => {
    const gis = { x: 0.8, y: 0.7, verified: true };
    const registry = fieldPlaceRegistry([{ id: 'wider-campus', kind: 'parking', gis_anchor: gis }]);
    expect(registry.unlocatedPlaces).toEqual([]);
    expect(registry.mapPlaces[0].x).toBeGreaterThan(1024);
    expect(registry.mapPlaces[0].y).toBeGreaterThan(640);
    const restored = scenePointToGisAnchor(registry.mapPlaces[0]);
    expect(restored.x).toBeCloseTo(gis.x, 12);
    expect(restored.y).toBeCloseTo(gis.y, 12);
  });
});
