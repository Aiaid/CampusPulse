import { describe, expect, test } from 'vitest';
import { campusLightLamps, campusLightReceivers } from '../../src/campus/campus-lighting-layout.js';
import { sampleLocalLight, surfaceCoverage } from '../../src/campus/lighting-field.js';
import { buildings, pointInPolygon } from '../../src/campus/spatial-scene.js';

describe('map-wide illustrative paving light', () => {
  test('keeps authored lighting distinct from observations and physical fixtures', () => {
    expect(campusLightReceivers.length).toBeGreaterThanOrEqual(8);
    expect(campusLightReceivers.length).toBeLessThanOrEqual(14);
    expect(campusLightLamps.length).toBeGreaterThanOrEqual(40);
    expect(campusLightLamps.length).toBeLessThanOrEqual(60);
    for (const item of [...campusLightReceivers, ...campusLightLamps]) {
      expect(item.provenance.surveyed).toBe(false);
      expect(item.provenance.kind).toBe('manual-illustrative-campus-lighting');
    }
    for (const lamp of campusLightLamps) {
      expect([lamp.x, lamp.y, lamp.strength, lamp.angle].every(Number.isFinite)).toBe(true);
      expect(lamp.x).toBeGreaterThan(0); expect(lamp.x).toBeLessThan(1024);
      expect(lamp.y).toBeGreaterThan(0); expect(lamp.y).toBeLessThan(640);
      expect(buildings.some(building => pointInPolygon([lamp.x, lamp.y], building.polygon))).toBe(false);
      expect(surfaceCoverage([lamp.x, lamp.y])).toBeGreaterThan(.9);
      expect(sampleLocalLight(lamp.x, lamp.y).intensity).toBeGreaterThan(.3);
    }
  });

  test('joins pools into broad warm pavement instead of isolated source dots', () => {
    // Several samples fall between lamps on the reviewed southeast crossroad.
    for (const [x, y] of [[790,512.7],[820,522.9],[850,533.2],[880,543.3],[910,553.1],[940,562.8],[970,572]]) {
      const light = sampleLocalLight(x, y);
      expect(light.intensity).toBeGreaterThan(.09);
      expect(light.warmth).toBeGreaterThan(.75);
      expect(surfaceCoverage([x, y])).toBeGreaterThan(.8);
    }
    expect(sampleLocalLight(850, 550).intensity).toBe(0);
    // The field covers separated west, north, south, and east paving areas.
    for (const point of [[95,318],[419,95],[677,571],[453,481],[540,429],[858,119],[306,295]]) {
      expect(sampleLocalLight(...point).intensity).toBeGreaterThan(.1);
    }
  });

  test('projected roofs always win over overlapping authored receiver strips', () => {
    let overlaps = 0;
    for (let y = 0; y <= 640; y += 2) for (let x = 0; x <= 1024; x += 2) {
      const point = [x, y];
      if (!campusLightReceivers.some(receiver => pointInPolygon(point, receiver.polygon))) continue;
      if (!buildings.some(building => pointInPolygon(point, building.polygon))) continue;
      expect(surfaceCoverage(point)).toBe(0);
      expect(sampleLocalLight(x, y).intensity).toBe(0);
      overlaps++;
    }
    expect(overlaps).toBeGreaterThan(10);
  });

  test('keeps new source samples bounded and rejects non-finite coordinates', () => {
    for (const lamp of campusLightLamps) for (const offset of [-12, 0, 12]) {
      const light = sampleLocalLight(lamp.x + offset, lamp.y + offset);
      expect(light.intensity).toBeGreaterThanOrEqual(0); expect(light.intensity).toBeLessThanOrEqual(1);
      expect(light.warmth).toBeGreaterThanOrEqual(0); expect(light.warmth).toBeLessThanOrEqual(1);
      const length = Math.hypot(light.direction.x, light.direction.y);
      expect(length === 0 || Math.abs(length - 1) < 1e-10).toBe(true);
    }
    for (const point of [[Infinity,500],[500,-Infinity],[NaN,100]]) {
      expect(surfaceCoverage(point)).toBe(0);
      expect(sampleLocalLight(...point)).toEqual({ intensity: 0, warmth: 0, direction: { x: 0, y: 0 } });
    }
  });
});
