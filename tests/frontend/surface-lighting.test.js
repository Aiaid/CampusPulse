import { describe, expect, test } from 'vitest';
import { decodeSceneColor, shadeSceneSurface, shadeLinearSceneSurface } from '../../src/campus/surface-lighting.js';
import { buildingEmissionMask, prepareBuildingMaterial } from '../../src/campus/building-material.js';
import { libraryBuildingMaterialColor, libraryPreservedWallReception } from '../../src/campus/library-light-atlas.js';

describe('shared scene-linear surface response', () => {
  test('preserved doors receive bounded shared reflection, never ambient glow or opaque paint', () => {
    const normal = [0, 1, 0];
    expect(libraryPreservedWallReception(normal, {})).toEqual({ color: [0, 0, 0], alpha: 0 });
    for (const light of [{ directIrradiance: .7 }, { indirectIrradiance: .7 }, { facadeIrradiance: .7 }]) {
      const reception = libraryPreservedWallReception(normal, light);
      expect(reception.color[0]).toBeGreaterThan(reception.color[2]);
      expect(reception.alpha).toBeGreaterThan(0);
      expect(reception.alpha).toBeLessThan(.8);
      expect(reception.color).toEqual(shadeSceneSurface([255, 255, 255], normal, light, { ambientScale: 0 }));
      // Screen blending keeps a nonzero contribution from the source pixel,
      // so genuine door/sill edges survive even at the strongest channel.
      expect(1 - reception.alpha * Math.max(...reception.color) / 255).toBeGreaterThan(.6);
    }
  });

  test('an unlit neutral material retains cool sky ambient across all receiver kinds', () => {
    const base = [150, 150, 150], normal = [0, 0, 1];
    const dark = shadeSceneSurface(base, normal, {});
    expect(dark[2]).toBeGreaterThan(dark[1]); expect(dark[1]).toBeGreaterThan(dark[0]);
    for (const receiverKind of ['wall', 'tree', 'ground', 'actor']) {
      expect(shadeSceneSurface(base, normal, { receiverKind })).toEqual(dark);
    }
    expect(shadeSceneSurface(base, normal, {}, { ambientScale: 0 })).toEqual([0, 0, 0]);
  });

  test('each shared source family warms reflectance without applying visibility twice', () => {
    const base = [150, 150, 150], normal = [0, 1, 0], dark = shadeSceneSurface(base, normal, {});
    for (const key of ['directIrradiance', 'indirectIrradiance', 'facadeIrradiance']) {
      const light = { [key]: .8, visibility: .1 };
      const warm = shadeSceneSurface(base, normal, light);
      expect(warm[0]).toBeGreaterThan(warm[2]);
      expect(warm[0]).toBeGreaterThan(dark[0]);
      expect(warm).toEqual(shadeSceneSurface(base, normal, { ...light, visibility: 1 }));
      expect(shadeSceneSurface(base, normal, light, { facing: 0 })).toEqual(dark);
    }
  });

  test('emission remains additive through black glass and does not depend on capsule facing', () => {
    const options = { emissionColorRGB: [180, 105, 48], emissionStrength: 1.4, emissionNormalization: 3, ambientScale: 0 };
    const emitted = shadeSceneSurface([0, 0, 0], [0, 1, 0], {}, options);
    expect(emitted[0]).toBeGreaterThan(150);
    expect(emitted[0]).toBeGreaterThan(emitted[1]);
    expect(emitted[1]).toBeGreaterThan(emitted[2]);
    expect(shadeSceneSurface([0, 0, 0], [0, 1, 0], {}, { ...options, facing: 0 })).toEqual(emitted);
    expect(shadeSceneSurface([0, 0, 0], [0, 1, 0], {}, { ...options, emissionStrength: 0 })).toEqual([0, 0, 0]);
  });

  test('cached linear colors and the building wrapper use exactly the common response', () => {
    const base = [101.3, 153.8, 81.2], normal = [.2, -.4, .8];
    const light = { directIrradiance: .43, indirectIrradiance: .08, facadeIrradiance: .21 };
    const expected = shadeSceneSurface(base, normal, light);
    expect(shadeLinearSceneSurface(decodeSceneColor(base), normal, light)).toEqual(expected);
    expect(libraryBuildingMaterialColor(base, normal, light)).toEqual(expected);
    const options = { emissionColorRGB: [150, 90, 40], emissionStrength: .6, emissionNormalization: 4 };
    expect(shadeLinearSceneSurface(decodeSceneColor(base), normal, light, options)).toEqual(shadeSceneSurface(base, normal, light, options));
  });

  test('tone mapping remains finite and bounded for dark, bright and malformed inputs', () => {
    for (const energy of [0, .01, 1, 50, 1e12, 1e308, Infinity, NaN, -5]) {
      const result = shadeSceneSurface([0, 170, 255], [0, 1, 0],
        { directIrradiance: energy, indirectIrradiance: energy, facadeIrradiance: energy },
        { emissionColorRGB: [255, 120, 40], emissionStrength: energy, emissionNormalization: energy });
      expect(result.every(value => Number.isInteger(value) && value >= 0 && value <= 255)).toBe(true);
    }
  });
});

describe('room image radiance normalization', () => {
  test('warm image exposure does not multiply room energy by dark glass albedo', () => {
    const render = gray => {
      const width = 16, height = 8, data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([x < 8 ? 20 : gray, x < 8 ? 20 : gray, x < 8 ? 20 : gray, 255], (y * width + x) * 4);
      const material = prepareBuildingMaterial({ width, height, data });
      const y = decodeSceneColor([gray, gray, gray])[0];
      expect(y * material.warmEmissionNormalization).toBeCloseTo(1, 10);
      return shadeSceneSurface([0, 0, 0], [0, 1, 0], {}, { emissionColorRGB: [gray, gray, gray],
        emissionStrength: 1, emissionNormalization: material.warmEmissionNormalization });
    };
    expect(render(32)).toEqual(render(128));
  });

  test('the local frame stays nonemissive while only the pane interior reaches full radiance', () => {
    for (const uv of [[0, .5], [1, .5], [.02, .5], [.5, .98], [NaN, .5], [-.1, .5]]) expect(buildingEmissionMask(...uv)).toBe(0);
    expect(buildingEmissionMask(.05, .5)).toBe(1);
    expect(buildingEmissionMask(.5, .5)).toBe(1);
    expect(buildingEmissionMask(.0375, .5)).toBeCloseTo(.5, 10);
  });
});
