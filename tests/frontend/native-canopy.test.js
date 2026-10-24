import { describe, expect, test } from 'vitest';
import { nativeCanopyExclusion, prepareNativeCanopyMask, sampleNativeCanopyMask } from '../../src/campus/native-canopy.js';
import { createCampusSceneField } from '../../src/campus/campus-scene-lighting.js';
import { screenToWorld } from '../../src/campus/library-lighting.js';
import { prepareGisMaterial } from '../../src/campus/gis-material.js';

const image = (color, { left = 0, top = 0, width = 24, height = 24, resolution = 1 } = {}) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    data.set([...color(left + x / resolution, top + y / resolution), 255], (y * width + x) * 4);
  }
  return prepareGisMaterial({ width, height, data }, { bounds: { left, top, width: width / resolution, height: height / resolution }, resolution });
};
const quad = (left, top, right, bottom) => [[left, top], [right, top], [right, bottom], [left, bottom]];

describe('source-preserving native canopy inference', () => {
  test('crown tops reject path lights below them while retaining light from above', () => {
    const position = screenToWorld(120, 145); position[2] = 11;
    const sample = height => createCampusSceneField({ delegateLibrary: false, lights: [
      {id:'lamp',x:120,y:145,height,power:2,radius:33},
    ] }).sampleCampusLight(position,[0,0,1],{receiverKind:'native-canopy'});
    expect(sample(7).directIrradiance).toBe(0);
    expect(sample(16).directIrradiance).toBeGreaterThan(0);
  });
  test('dark/olive source foliage is opaque and produces finite restrained leaf normals', () => {
    const material = image((x, y) => [48 + (x % 3) * 4, 65 + (y % 3) * 6, 27]);
    const original = new Float32Array(material.linear);
    const mask = prepareNativeCanopyMask(material);
    expect(mask.count).toBe(24 * 24);
    const sample = sampleNativeCanopyMask(mask, 12.5, 12.5);
    expect(sample.coverage).toBe(1); // Ground light must not leak through a partial overlay.
    expect(Math.hypot(...sample.normal)).toBeCloseTo(1, 8);
    expect(sample.normal[2]).toBeGreaterThan(.9);
    expect(material.linear).toEqual(original); // Classification never washes the source RGB.
    expect(sampleNativeCanopyMask(mask, -1, 10)).toBeNull();
  });

  test('building, roof, grass and court exclusions override even strongly green pixels', () => {
    const material = image(() => [38, 89, 27]);
    const excludedAt = nativeCanopyExclusion([quad(0, 0, 12, 24)], material.bounds);
    const mask = prepareNativeCanopyMask(material, { excludedAt });
    expect(sampleNativeCanopyMask(mask, 5.5, 5.5)).toBeNull();
    expect(sampleNativeCanopyMask(mask, 18.5, 5.5)?.coverage).toBe(1);
    const allExcluded = prepareNativeCanopyMask(material, { excludedAt: () => true });
    expect(allExcluded.count).toBe(0);
  });

  test('smooth bright grass/paint, neutral roofs and red paving are not globally promoted to trees', () => {
    for (const color of [[50, 160, 40], [125, 128, 125], [142, 40, 28], [200, 170, 120]]) {
      expect(prepareNativeCanopyMask(image(() => color)).count).toBe(0);
    }
  });

  test('textured pink/gray crowns require a vegetation zone and red road remains excluded', () => {
    for (const color of [[135, 98, 121], [112, 115, 112]]) {
      const material = image((x, y) => color.map(value => value + ((x + y) % 2 ? 18 : -18)));
      expect(prepareNativeCanopyMask(material).count).toBe(0);
      expect(prepareNativeCanopyMask(material, { vegetationAt: () => true }).count).toBeGreaterThan(0);
      expect(prepareNativeCanopyMask(material, { vegetationAt: () => true, excludedAt: () => true }).count).toBe(0);
    }
    const road = image((x, y) => [145 + ((x + y) % 2 ? 18 : -18), 40, 28]);
    expect(prepareNativeCanopyMask(road, { vegetationAt: () => true }).count).toBe(0);
  });

  test('a vegetation-zone prior does not turn smooth gray paving into crown material', () => {
    expect(prepareNativeCanopyMask(image(() => [97, 99, 97]), { vegetationAt: () => true }).count).toBe(0);
  });

  test('chunk-halo sampling gives the same classification and normal at a retained border', () => {
    const source = (x, y) => [50 + (x % 5) * 3, 76 + (y % 4) * 5, 30];
    const whole = prepareNativeCanopyMask(image(source, { width: 48 }));
    const crop = prepareNativeCanopyMask(image(source, { left: 16, width: 24 }));
    expect(sampleNativeCanopyMask(crop, 24.5, 12.5)).toEqual(sampleNativeCanopyMask(whole, 24.5, 12.5));
    expect(prepareNativeCanopyMask(null)).toBeNull();
  });
});
