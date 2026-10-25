import { describe, expect, test } from 'vitest';
import { campusCoverage, campusDemoRoutes, campusLights, campusPlaceFrames,
  campusSurfaces, campusTrees } from '../../src/campus/campus-scene-data.js';
import { buildings, pointInPolygon, routes, sampleRoute } from '../../src/campus/spatial-scene.js';
import { places } from '../../src/campus/scene-data.js';
import { libraryDetailFrame } from '../../src/campus/map-framing.js';
import { facadeSurfaces } from '../../src/campus/facade-surfaces.js';

const roofs = campusSurfaces.filter(surface => surface.kind === 'roof');
const grounds = campusSurfaces.filter(surface => surface.kind === 'ground');
const insideLibrary = (x, y) => x >= 548 && x <= 739 && y >= 188 && y <= 335;
const validPoint = point => point.length === 2 && point.every(Number.isFinite)
  && point[0] >= 0 && point[0] <= 1024 && point[1] >= 0 && point[1] <= 640;
const area = polygon => Math.abs(polygon.reduce((sum, p, i) => {
  const q = polygon[(i + 1) % polygon.length];
  return sum + p[0] * q[1] - q[0] * p[1];
}, 0)) / 2;

describe('full-campus authored painter chart', () => {
  test('covers the visible campus and outer housing with explicit evidence bounds', () => {
    expect(campusCoverage.fullVisibleCampus).toBe(true);
    expect(campusCoverage.approximate).toBe(true);
    expect(campusCoverage.painterChart).toBe(true);
    expect(campusCoverage.surveyed).toBe(false);
    expect(campusCoverage.fixturesObserved).toBe(false);
    expect(campusCoverage.containsRasterPixels).toBe(false);
    expect(campusCoverage.includesHousingAndOuterEdges).toBe(true);
    expect(campusCoverage.surfaceCount).toBe(campusSurfaces.length);
    expect(campusCoverage.treeCount).toBe(campusTrees.length);
    expect(roofs.length).toBeGreaterThan(85);
    // Coverage assertions use positional regions rather than guessed names.
    for (const [left, top, right, bottom] of [[0,0,350,220],[600,0,1024,200],
      [0,250,240,460],[260,300,560,480],[0,480,450,640],[500,480,1024,640]]) {
      expect(roofs.filter(surface => surface.polygon.some(([x,y]) => x >= left && x <= right && y >= top && y <= bottom)).length).toBeGreaterThan(3);
    }
  });

  test('has unique finite nondegenerate material geometry and retains wall windows', () => {
    const allIds = [...campusSurfaces, ...campusTrees, ...campusLights, ...campusDemoRoutes].map(item => item.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    for (const surface of campusSurfaces) {
      expect(['roof','wall','ground']).toContain(surface.kind);
      expect(['roof','wall','paving','grass','water']).toContain(surface.material);
      expect(surface.polygon.length).toBeGreaterThanOrEqual(3);
      expect(surface.polygon.every(validPoint)).toBe(true);
      expect(area(surface.polygon)).toBeGreaterThan(.1);
      expect(Number.isFinite(surface.height)).toBe(true);
      expect(surface.height).toBeGreaterThanOrEqual(0);
      expect(surface.provenance.surveyed).toBe(false);
    }
    const walls = campusSurfaces.filter(surface => surface.kind === 'wall');
    expect(walls.map(surface => surface.id)).toEqual(facadeSurfaces.filter(surface => surface.buildingId !== 'library-main').map(surface => surface.id));
    for (const wall of walls) {
      const old = facadeSurfaces.find(surface => surface.id === wall.id);
      expect(wall.polygon).toBe(old.polygon);
      expect(wall.windows).toBe(old.windows);
    }
    expect(grounds.every(surface => surface.height === 0 && surface.exclusions === 'buildings-and-roofs')).toBe(true);
  });

  test('bounds vegetation to reviewed zones and avoids rooftops, paving and the accepted library', () => {
    expect(campusTrees.length).toBeGreaterThanOrEqual(200);
    expect(campusTrees.length).toBeLessThanOrEqual(400);
    expect(new Set(campusTrees.map(tree => tree.zoneId)).size).toBeGreaterThan(30);
    for (const tree of campusTrees) {
      expect(validPoint([tree.x, tree.y])).toBe(true);
      expect(tree.radii.length).toBe(3);
      expect(tree.radii.every(value => Number.isFinite(value) && value > 0)).toBe(true);
      expect(tree.height).toBeGreaterThan(tree.radii[2]);
      for (const point of [[tree.x,tree.y],[tree.x,tree.y-tree.height]]) {
        expect(insideLibrary(...point)).toBe(false);
        expect(roofs.some(roof => pointInPolygon(point, roof.polygon))).toBe(false);
        expect(grounds.some(ground => pointInPolygon(point, ground.polygon))).toBe(false);
        expect(buildings.some(building => pointInPolygon(point, building.polygon))).toBe(false);
      }
    }
  });

  test('keeps illustrative lamps off roofs and the library with bounded common exposure', () => {
    expect(campusLights.length).toBeGreaterThan(70);
    for (const light of campusLights) {
      expect(validPoint([light.x,light.y])).toBe(true);
      expect([light.height,light.power,light.radius].every(Number.isFinite)).toBe(true);
      expect(light.power).toBeGreaterThan(0); expect(light.power).toBeLessThan(4);
      expect(light.radius).toBeGreaterThan(0); expect(light.radius).toBeLessThan(60);
      expect(insideLibrary(light.x,light.y)).toBe(false);
      expect(roofs.some(roof => pointInPolygon([light.x,light.y],roof.polygon))).toBe(false);
      expect(light.provenance.illumination).toBe('synthetic-illustration-not-live-observation');
    }
  });

  test('frames every place while preserving the accepted library object exactly', () => {
    expect(campusPlaceFrames.library).toBe(libraryDetailFrame);
    expect(Object.keys(campusPlaceFrames).sort()).toEqual(places.map(place => place.id).sort());
    for (const place of places) {
      const frame = campusPlaceFrames[place.id];
      const { left,top,width,height } = frame.bounds;
      expect([left,top,width,height].every(Number.isFinite)).toBe(true);
      expect(width).toBeGreaterThan(100); expect(height).toBeGreaterThan(100);
      expect(place.x).toBeGreaterThanOrEqual(left); expect(place.x).toBeLessThanOrEqual(left+width);
      expect(place.y).toBeGreaterThanOrEqual(top); expect(place.y).toBeLessThanOrEqual(top+height);
      expect(frame.padding).toBe(12);
    }
  });

  test('adds activity only to previously empty places on visible unoccluded paving', () => {
    const previouslyActive = new Set(routes.map(route => route.placeId));
    const newlyActive = new Set(campusDemoRoutes.map(route => route.placeId));
    expect([...newlyActive].sort()).toEqual(places.filter(place => !previouslyActive.has(place.id)).map(place => place.id).sort());
    for (const route of campusDemoRoutes) {
      expect(previouslyActive.has(route.placeId)).toBe(false);
      expect(['walk','ride']).toContain(route.kind);
      expect(route.width).toBeGreaterThan(0);
      expect(route.points.length).toBeGreaterThanOrEqual(2);
      expect(route.points.every(validPoint)).toBe(true);
      for (let i = 0; i <= 40; i++) {
        const point = sampleRoute(route,i/40);
        expect(roofs.some(roof => pointInPolygon(point,roof.polygon))).toBe(false);
        expect(buildings.some(building => pointInPolygon(point,building.polygon))).toBe(false);
      }
    }
  });
});
