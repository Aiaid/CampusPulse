import { describe, expect, test } from 'vitest';
import { lightingPixelRatio, lightingQualityProfile } from '../../src/campus/lighting-quality.js';

describe('lighting quality budget', () => {
  test('defaults to lower computation and display resolution', () => {
    expect(lightingQualityProfile()).toEqual({ id: 'efficient', pixelRatioLimit: 1,
      campusResolutionLimit: 1, libraryResolution: 2 });
    expect(lightingQualityProfile('corrupt preference')).toBe(lightingQualityProfile());
    for (const value of ['constructor', 'toString', '__proto__']) expect(lightingQualityProfile(value)).toBe(lightingQualityProfile());
    expect(lightingPixelRatio(2, 'efficient')).toBe(1);
  });
  test('full quality preserves the original display/material ceilings', () => {
    expect(lightingQualityProfile('full')).toEqual({ id: 'full', pixelRatioLimit: 2,
      campusResolutionLimit: 2, libraryResolution: 3 });
    expect(lightingPixelRatio(3, 'full')).toBe(2);
    expect(lightingPixelRatio(.8, 'full')).toBe(.8);
  });
  test('invalid browser ratios cannot create unbounded or invalid buffers', () => {
    for (const ratio of [NaN, Infinity, -1, 0, undefined]) expect(lightingPixelRatio(ratio, 'efficient')).toBe(1);
  });
});
