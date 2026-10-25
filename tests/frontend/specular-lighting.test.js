import { describe, expect, test } from 'vitest';
import { SCENE_VIEW_DIRECTION, sceneDielectricResponse, shadeSceneSurface } from '../../src/campus/surface-lighting.js';
import { libraryLights, screenToWorld, resolveLibrarySurface, sampleLibraryLight } from '../../src/campus/library-lighting.js';

const unit = values => { const length = Math.hypot(...values); return length > 1e-9 ? values.map(value => value / length) : [0, 0, 0]; };
const view = SCENE_VIEW_DIRECTION;

describe('optional common dielectric reflection', () => {
  test('no source, missing direction or zero F0 cannot invent a highlight', () => {
    const base = [25, 100, 45], light = { directIrradiance: .7, surfaceLightDirection: view };
    const old = shadeSceneSurface(base, view, light);
    expect(shadeSceneSurface(base, view, light, { roughness: .5, dielectricF0: 0 })).toEqual(old);
    expect(shadeSceneSurface(base, view, { directIrradiance: .7 }, { roughness: .5 }))
      .toEqual(shadeSceneSurface(base, view, { directIrradiance: .7 }));
    expect(shadeSceneSurface(base, view, { surfaceLightDirection: view }, { roughness: .5 }))
      .toEqual(shadeSceneSurface(base, view, {}));
    expect(sceneDielectricResponse(view, [0, 0, 0], { roughness: .5 }).specularWeight).toBe(0);
    expect(sceneDielectricResponse(view, view.map(value => -value), { roughness: .5 }).specularWeight).toBe(0);
    expect(sceneDielectricResponse(view.map(value => -value), view, { roughness: .5 }).specularWeight).toBe(0);
  });

  test('roughness broadens the lobe while dry paving has a restrained aligned peak', () => {
    const smooth = sceneDielectricResponse(view, view, { roughness: .3 });
    const leaf = sceneDielectricResponse(view, view, { roughness: .5 });
    const paving = sceneDielectricResponse(view, view, { roughness: .78 });
    expect(smooth.specularWeight).toBeGreaterThan(leaf.specularWeight);
    expect(leaf.specularWeight).toBeGreaterThan(paving.specularWeight);
    expect(paving.specularWeight).toBeLessThan(.04);
    const tilted = [0, 0, 1];
    expect(sceneDielectricResponse(view, tilted, { roughness: .8 }).specularWeight)
      .toBeGreaterThan(sceneDielectricResponse(view, tilted, { roughness: .3 }).specularWeight);
  });

  test('dielectric highlights preserve warm incident color through green and blue diffuse albedo', () => {
    const light = { directIrradiance: .8, facadeIrradiance: .2, surfaceLightDirection: view };
    for (const [base, roughness] of [[[20, 100, 35], .5], [[20, 70, 180], .75]]) {
      const old = shadeSceneSurface(base, view, light);
      const dielectric = shadeSceneSurface(base, view, light, { roughness, dielectricF0: .04 });
      expect(dielectric[0]).toBeGreaterThan(old[0] + 15);
      expect(dielectric[0] / dielectric[2]).toBeGreaterThan(old[0] / old[2]);
    }
    const black = shadeSceneSurface([0, 0, 0], view, light, { roughness: .5, ambientScale: 0 });
    expect(black[0]).toBeGreaterThan(black[1]); expect(black[1]).toBeGreaterThan(black[2]);
  });

  test('F0 controls reflection and the average-lobe energy split remains bounded at grazing angles', () => {
    const low = sceneDielectricResponse(view, view, { roughness: .75, dielectricF0: .02 });
    const high = sceneDielectricResponse(view, view, { roughness: .75, dielectricF0: .08 });
    expect(high.specularWeight).toBeGreaterThan(low.specularWeight);
    for (const roughness of [0, .01, .3, .5, 1, 10, NaN]) for (const dielectricF0 of [0, .02, .04, 1, NaN]) {
      for (const direction of [view, [0, 0, 1], [1, 0, .00001], [NaN, 0, 1]]) {
        const result = sceneDielectricResponse([0, 0, 1], direction, { roughness, dielectricF0 });
        expect(Number.isFinite(result.specularWeight)).toBe(true);
        expect(result.specularWeight).toBeGreaterThanOrEqual(0);
        expect(result.specularWeight).toBeLessThanOrEqual(.5);
        expect(result.specularWeight + result.diffuseWeight).toBeCloseTo(1, 12);
        const color = shadeSceneSurface([20, 150, 70], [0, 0, 1], { directIrradiance: 1e12, surfaceLightDirection: direction }, { roughness, dielectricF0 });
        expect(color.every(value => Number.isInteger(value) && value >= 0 && value <= 255)).toBe(true);
      }
    }
  });

  test('capsule diffuse modulation does not attenuate the dielectric lobe a second time', () => {
    const light = { directIrradiance: .8, surfaceLightDirection: view };
    const options = { roughness: .75, ambientScale: 0 };
    expect(shadeSceneSurface([0, 0, 0], view, light, { ...options, facing: .55 }))
      .toEqual(shadeSceneSurface([0, 0, 0], view, light, { ...options, facing: 1 }));
  });
});

describe('actual world-space field direction', () => {
  test('isolated and combined lamps supply their received-energy-weighted actual 3D direction', () => {
    const position = screenToWorld(610, 269), normal = [0, 0, 1], lights = libraryLights.slice(0, 2);
    const samples = lights.map(light => sampleLibraryLight(position, normal, { lights: [light], occlusion: false }));
    samples.forEach((sample, index) => {
      const expected = unit(lights[index].position.map((value, axis) => value - position[axis]));
      sample.surfaceLightDirection.forEach((value, axis) => expect(value).toBeCloseTo(expected[axis], 10));
    });
    const combined = sampleLibraryLight(position, normal, { lights, occlusion: false });
    const expected = unit([0, 1, 2].map(axis => samples.reduce((sum, sample) => sum + sample.surfaceLightDirection[axis] * sample.directIrradiance, 0)));
    combined.surfaceLightDirection.forEach((value, axis) => expect(value).toBeCloseTo(expected[axis], 10));
    expect(Math.hypot(...combined.surfaceLightDirection)).toBeCloseTo(1, 10);
    expect(sampleLibraryLight(position, normal, { lights: [] }).surfaceLightDirection).toEqual([0, 0, 0]);
  });

  test('the existing unlit roof gains no source direction or specular light', () => {
    const roof = resolveLibrarySurface(635, 211);
    const light = sampleLibraryLight(roof.position, roof.normal, { indirect: true, emissive: true, receiverKind: 'roof' });
    expect(light.intensity).toBe(0);
    expect(light.surfaceLightDirection).toEqual([0, 0, 0]);
    expect(shadeSceneSurface([120, 130, 160], roof.normal, light, { roughness: .3 }))
      .toEqual(shadeSceneSurface([120, 130, 160], roof.normal, light));
  });
});
