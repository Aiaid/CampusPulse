import { describe, expect, test } from 'vitest';
import {
  libraryCanopyDownlights, libraryLights, librarySurfaces, libraryGroundBounce,
  worldToScreen, screenToWorld, resolveLibrarySurface, sampleLibraryLight, sampleLibraryActor,
} from '../../src/campus/library-lighting.js';

const unit = values => values.map(value => value / Math.hypot(...values));

describe('three illustrative canopy downlights', () => {
  test('lenses hang below the exact retained front arc without adding receiver geometry', () => {
    expect(libraryCanopyDownlights).toHaveLength(3);
    expect(libraryLights).toHaveLength(13);
    expect(librarySurfaces).toHaveLength(9);
    expect(libraryCanopyDownlights.map(light => light.angleDegrees)).toEqual([30, 90, 150]);
    const roof = librarySurfaces.find(surface => surface.id === 'library-entry-canopy');
    expect(roof.polygon).toHaveLength(32);
    roof.polygon.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(635 + Math.cos(i * Math.PI / 16) * 17.5, 10);
      expect(y).toBeCloseTo(276 + Math.sin(i * Math.PI / 16) * 11.5, 10);
    });
    for (const light of libraryCanopyDownlights) {
      expect(libraryLights.includes(light)).toBe(true);
      expect(light.fixtureType).toBe('canopy-downlight');
      expect(light.height).toBe(7.1);
      expect(light.provenance.fixture).toContain('not-observed');
      const lens = worldToScreen(light.position);
      const roofPoint = worldToScreen([light.position[0], light.position[1], 7.5]);
      expect(((roofPoint.x - 635) / 17.5) ** 2 + ((roofPoint.y - 276) / 11.5) ** 2).toBeCloseTo(1, 10);
      expect(lens.x).toBeCloseTo(roofPoint.x, 10);
      expect(lens.y - roofPoint.y).toBeCloseTo(.4, 10);
      expect(light.ground.y - roofPoint.y).toBeCloseTo(7.5, 10);
      expect(Number.isFinite(light.screenTangentAngle)).toBe(true);
    }
  });

  test('downward emission illuminates below, fades at its edge and never leaks upward/outside', () => {
    for (const light of libraryCanopyDownlights) {
      const atAngle = angle => {
        const radians = angle * Math.PI / 180;
        const position = [light.position[0] + 8 * Math.sin(radians), light.position[1], light.position[2] - 8 * Math.cos(radians)];
        const facing = unit(light.position.map((value, axis) => value - position[axis]));
        return sampleLibraryLight(position, facing, { lights: [light], occlusion: false });
      };
      const inside = atAngle(55), edge = atAngle(63), outside = atAngle(70), above = atAngle(180);
      expect(inside.directIrradiance).toBeGreaterThan(.4);
      expect(edge.directIrradiance).toBeGreaterThan(0);
      expect(edge.directIrradiance).toBeLessThan(inside.directIrradiance);
      expect(outside.directIrradiance).toBe(0);
      expect(above.directIrradiance).toBe(0);
    }
  });

  test('existing omnidirectional fixtures retain upward emission and their original configuration', () => {
    const existing = libraryLights.filter(light => light.fixtureType !== 'canopy-downlight');
    expect(existing).toHaveLength(10);
    expect(existing.every(light => light.emissionDirection === undefined)).toBe(true);
    const entry = existing.find(light => light.id === 'library-canopy-entry');
    expect(entry).toMatchObject({ height: 4, power: 1.8, radius: 26, ground: { x: 634, y: 290 } });
    const above = [entry.position[0], entry.position[1], entry.position[2] + 2];
    expect(sampleLibraryLight(above, [0, 0, -1], { lights: [entry], occlusion: false }).directIrradiance).toBeGreaterThan(1);
  });

  test('ground reflection derives the same full-cone energy directly beneath every downlight', () => {
    const reflected = libraryGroundBounce(libraryCanopyDownlights);
    expect(reflected).toHaveLength(3);
    reflected.forEach((patch, index) => {
      const light = libraryCanopyDownlights[index];
      const floor = [light.position[0], light.position[1], .12];
      const direct = sampleLibraryLight(floor, [0, 0, 1], { lights: [light] });
      expect(patch.groundIrradiance).toBeCloseTo(direct.directIrradiance, 10);
      expect(patch.power).toBeGreaterThan(0);
      expect(patch.power).toBeLessThan(patch.groundIrradiance * .3);
      expect(patch.ground).toEqual(light.ground);
    });
  });

  test('visible front paving gains warm light while canopy and high roof stay unlit by these fixtures', () => {
    for (const point of [[635, 296], [625, 294], [645, 293]]) {
      const ground = resolveLibrarySurface(...point);
      expect(ground.kind).toBe('ground');
      const sample = sampleLibraryLight(ground.position, ground.normal, { lights: libraryCanopyDownlights });
      expect(sample.directIrradiance).toBeGreaterThan(.4);
      expect(sample.warmth).toBeGreaterThan(.7);
    }
    for (const point of [[635, 277], [635, 211]]) {
      const roof = resolveLibrarySurface(...point);
      expect(['canopy', 'roof']).toContain(roof.kind);
      expect(sampleLibraryLight(roof.position, roof.normal, { lights: libraryCanopyDownlights, indirect: true }).intensity).toBe(0);
    }
  });

  test('actor reception and ground-shadow metadata remain tied to the same actual lamp footprint', () => {
    const light = libraryCanopyDownlights[1];
    const point = [light.ground.x, light.ground.y - 2], torso = screenToWorld(...point); torso[2] = 1.8;
    const isolated = sampleLibraryLight(torso, [0, 0, 1], { lights: [light], upright: true, receiverKind: 'actor' });
    expect(isolated.direction.y).toBeLessThan(0);
    expect(isolated.groundDirection.x).toBeCloseTo(0, 10);
    expect(isolated.groundDirection.y).toBeCloseTo(1, 10);
    expect(isolated.sourceHeight).toBeCloseTo(7.1, 10);
    expect(isolated.dominantSourceId).toBe(light.id);
    const shared = sampleLibraryLight(torso, [0, 0, 1], { upright: true, receiverKind: 'actor', indirect: true, emissive: true });
    expect(sampleLibraryActor(...point)).toEqual(shared);
  });
});
