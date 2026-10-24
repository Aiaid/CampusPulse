import { describe, expect, test } from 'vitest';
import { facadeSurfaces, facadeCell, pointOnFacade } from '../../src/campus/facade-surfaces.js';
import { officialBuildings, pointInPolygon } from '../../src/campus/spatial-scene.js';

const area = polygon => Math.abs(polygon.reduce((sum, point, i) => {
  const next = polygon[(i + 1) % polygon.length];
  return sum + point[0] * next[1] - next[0] * point[1];
}, 0)) / 2;

describe('registered visible facade light masks', () => {
  test('pane corners preserve the two projected wall directions', () => {
    const wall = [[10, 20], [30, 30], [30, 50], [10, 40]];
    expect(facadeCell(wall, .25, .25, .75, .75))
      .toEqual([[15, 27.5], [25, 32.5], [25, 42.5], [15, 37.5]]);
    expect(pointOnFacade([[10, 20], [30, 30], [34, 62], [12, 50]], .5, .5))
      .toEqual([21.5, 40.5]);
  });

  test('every complete pane stays inside its visible wall, including roof cuts', () => {
    const ids = new Set();
    for (const surface of facadeSurfaces) {
      expect(ids.has(surface.id)).toBe(false);
      ids.add(surface.id);
      expect(surface.polygon).toHaveLength(4);
      expect(area(surface.polygon)).toBeGreaterThan(10);
      expect(surface.provenance).toMatchObject({
        kind: 'manual-illustrative-facade-mask',
        accuracy: 'visual-registration-only-not-surveyed',
        illumination: 'stable-synthetic-room-pattern-not-live-observation',
      });
      for (const window of surface.windows) {
        expect(window.polygon).toHaveLength(4);
        expect(area(window.polygon)).toBeGreaterThan(.1);
        expect(window.polygon.every(point => pointInPolygon(point, surface.polygon))).toBe(true);
        expect(window.strength).toBeGreaterThan(0);
        expect(window.strength).toBeLessThanOrEqual(1);
        expect(typeof window.lit).toBe('boolean');
      }
    }
    const panes = facadeSurfaces.flatMap(surface => surface.windows);
    expect(panes.filter(pane => pane.lit).length).toBeGreaterThan(100);
    expect(panes.filter(pane => !pane.lit).length).toBeGreaterThan(30);
  });

  test('reviewed roof, circular canopy and foreground tree samples receive no wall light', () => {
    const samples = [
      [635, 211], // Library main roof.
      [673, 260], [678, 280], // Sloping library roof, in front of glass.
      [635, 277], // Circular entrance canopy.
      [520, 169], // Teaching 8 roof.
      [499, 338], // Literature tiled roof.
      [580, 360], // H-building west roof.
      [655, 410], // Tree obscuring H-building east wing.
    ];
    for (const point of samples) {
      expect(facadeSurfaces.some(surface => pointInPolygon(point, surface.polygon)), String(point)).toBe(false);
    }
  });

  test('reviewed visible walls across the campus receive a connected surface', () => {
    for (const point of [[640, 241], [674, 300], [700, 285], [610, 322],
      [500, 196], [500, 353], [578, 377]]) {
      expect(facadeSurfaces.some(surface => pointInPolygon(point, surface.polygon)), String(point)).toBe(true);
    }
  });

  test('the sloping library roof clips regular floor bands instead of fanning them', () => {
    const surface = facadeSurfaces.find(face => face.id === 'library-east-glass');
    const first = surface.windows[0].polygon;
    const axis = [first[1][0] - first[0][0], first[1][1] - first[0][1]];
    for (const { polygon } of surface.windows) {
      const edge = [polygon[1][0] - polygon[0][0], polygon[1][1] - polygon[0][1]];
      expect(Math.abs(axis[0] * edge[1] - axis[1] * edge[0])).toBeLessThan(1e-8);
    }
  });

  test('expanded campus walls retain their reviewed official building association', () => {
    const expanded = facadeSurfaces.filter(surface => surface.sourceId);
    expect(new Set(expanded.map(surface => surface.buildingId)).size).toBeGreaterThanOrEqual(9);
    for (const surface of expanded) {
      const building = officialBuildings.find(candidate => candidate.sourceId === surface.sourceId);
      expect(building?.id).toBe(surface.buildingId);
      expect(surface.polygon.every(point => pointInPolygon(point, building.polygon))).toBe(true);
      expect(surface.provenance.roomLayout).toBe('manual-illustrative-visible-wall-bands');
    }
    const panes = expanded.flatMap(surface => surface.windows);
    expect(panes.filter(pane => !pane.lit).length / panes.length).toBeGreaterThan(.35);
  });

  test('expanded campus reception stays below representative roof and cornice samples', () => {
    for (const point of [[480,76], [520,0], [455,213], [850,445], [140,555], [237,172], [370,76]]) {
      expect(facadeSurfaces.some(surface => pointInPolygon(point, surface.polygon)), String(point)).toBe(false);
    }
    for (const point of [[450,228], [477,111], [520,48], [235,194], [845,482],
      [438,390], [120,599], [350,110], [370,89]]) {
      expect(facadeSurfaces.some(surface => pointInPolygon(point, surface.polygon)), String(point)).toBe(true);
    }
  });
});
