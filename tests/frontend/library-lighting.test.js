import { describe, expect, test } from 'vitest';
import {
  LIBRARY_BOUNDS, libraryBlend, librarySurfaces, libraryTrees, libraryLights,
  screenToWorld, worldToScreen, resolveLibrarySurface, librarySegmentVisibility,
  sampleLibraryLight, sampleLibraryActor, treeOpacityAt, libraryGroundBounce,
  libraryFacadeEmitters, compileLibraryFacadeEmitters, libraryPaneEntryIntensity,
} from '../../src/campus/library-lighting.js';
import { facadeSurfaces } from '../../src/campus/facade-surfaces.js';
import { libraryPlantingIslands } from '../../src/campus/ground-features.js';
import { chooseRoomAppearance } from '../../src/campus/room-lighting.js';

const dot = (a, b) => a.reduce((total, v, i) => total + v * b[i], 0);
const plus = (a, b, scale = 1) => a.map((v, i) => v + b[i] * scale);
const normalize = a => a.map(v => v / Math.hypot(...a));

describe('registered library 2.5D chart', () => {
  test('authored paving preserves the previously registered planting beds', () => {
    for (const polygon of libraryPlantingIslands) {
      const center = polygon.reduce((sum, point) => [sum[0] + point[0] / polygon.length,
        sum[1] + point[1] / polygon.length], [0,0]);
      expect(resolveLibrarySurface(...center)?.kind).not.toBe('ground');
    }
  });
  test('a fixed ground anchor rises vertically and its projection inverts at every height', () => {
    for (const [x, y] of [[560, 260], [635, 276], [700, 310]]) {
      for (const height of [0, 1.8, 7.5, 42]) {
        const world = screenToWorld(x, y, height);
        const projected = worldToScreen(world);
        expect(projected.x).toBeCloseTo(x, 10);
        expect(projected.y).toBeCloseTo(y, 10);
        const anchor = screenToWorld(x, y);
        anchor[2] = height;
        expect(worldToScreen(anchor).y).toBeCloseTo(y - height, 10);
      }
    }
  });

  test('walls retain existing clipping while their window quads lie in one true plane', () => {
    for (const surface of librarySurfaces.filter(surface => surface.kind === 'wall')) {
      const original = facadeSurfaces.find(face => face.id === surface.id);
      expect(surface.polygon).toEqual(original.polygon);
      expect(surface.windows).toEqual(original.windows);
      expect(Math.hypot(...surface.normal)).toBeCloseTo(1, 10);
      expect(surface.normal[2]).toBeCloseTo(0, 10);
      const { windowQuad, windowTopHeight, windowBottomHeight, constant } = surface.mapping;
      windowQuad.forEach((p, i) => {
        const position = screenToWorld(...p, i < 2 ? windowTopHeight : windowBottomHeight);
        expect(dot(position, surface.normal)).toBeCloseTo(constant, 9);
      });
      expect(surface.provenance.accuracy).toContain('not-surveyed');
    }
  });

  test('visible roofs, canopy and walls resolve independently instead of receiving pavement normals', () => {
    for (const [x, y, kind] of [[640, 241, 'wall'], [674, 300, 'wall'], [700, 285, 'wall'],
      [635, 211, 'roof'], [673, 260, 'roof'], [678, 280, 'roof'], [635, 277, 'canopy'], [613, 278, 'ground']]) {
      const hit = resolveLibrarySurface(x, y);
      expect(hit?.kind).toBe(kind);
      const projected = worldToScreen(hit.position);
      expect(projected.x).toBeCloseTo(x, 9);
      expect(projected.y).toBeCloseTo(y, 9);
      expect(Math.hypot(...hit.normal)).toBeCloseTo(1, 9);
    }
    expect(resolveLibrarySurface(673, 260).normal[2]).toBeGreaterThan(.8);
    expect(resolveLibrarySurface(640, 241).normal[2]).toBe(0);
  });

  test('ROI is feathered and unrelated campus pixels remain outside the model', () => {
    expect(libraryBlend(640, 260)).toBe(1);
    expect(libraryBlend(LIBRARY_BOUNDS.left + 4.5, 260)).toBeCloseTo(.5);
    expect(libraryBlend(LIBRARY_BOUNDS.left, 260)).toBe(0);
    for (const point of [[0, 0], [500, 300], [800, 300], [NaN, 280], [600, Infinity]]) {
      expect(libraryBlend(...point)).toBe(0);
      expect(resolveLibrarySurface(...point)).toBeNull();
      expect(sampleLibraryActor(...point).intensity).toBe(0);
    }
  });
});

describe('shared physical light response and blockers', () => {
  test('facade emission uses stable actual rooms and only their real pane area', () => {
    const patches = libraryFacadeEmitters();
    expect(libraryFacadeEmitters()).toBe(patches);
    expect(patches.length).toBeGreaterThan(0);
    expect(patches.length).toBeLessThanOrEqual(24);
    const expected = new Set(), tiers = { bright: 0, ordinary: 0, dim: 0, unlit: 0 };
    let panes = 0;
    for (const surface of librarySurfaces.filter(item => item.kind === 'wall')) {
      const lastRow = Math.max(...surface.windows.map(pane => Number(pane.id.split('-').at(-2))));
      for (const pane of surface.windows) {
        const entry = libraryPaneEntryIntensity(surface, pane);
        const room = chooseRoomAppearance(surface.id, pane, lastRow, entry);
        expect(chooseRoomAppearance(surface.id, pane, lastRow, entry)).toEqual(room);
        tiers[room.tier]++; panes++;
        if (!pane.lit) expect(room.emission).toBe(0);
        if (room.emission > 0) expected.add(pane.id);
      }
    }
    expect(panes).toBe(279);
    expect(tiers.unlit).toBe(64);
    const emitted = patches.flatMap(patch => patch.paneIds);
    expect(new Set(emitted)).toEqual(expected);
    expect(new Set(emitted).size).toBe(emitted.length);
    for (const patch of patches) {
      const wall = librarySurfaces.find(surface => surface.id === patch.wallId);
      expect(dot(patch.position, wall.normal)).toBeCloseTo(wall.mapping.constant, 9);
      expect(patch.area).toBeGreaterThan(0);
      expect(patch.power).toBeGreaterThan(0);
      expect(patch.radius).toBeLessThanOrEqual(76);
      expect(patch.normal).toEqual(wall.normal);
    }
  });

  test('turning all existing windows off removes facade energy rather than leaving warm points', () => {
    const off = compileLibraryFacadeEmitters(librarySurfaces.map(surface => surface.kind === 'wall'
      ? { ...surface, windows: surface.windows.map(pane => ({ ...pane, lit: false })) } : surface));
    expect(off).toEqual([]);
    const ground = screenToWorld(613, 278);
    const sample = sampleLibraryLight(ground, [0, 0, 1], { lights: [], emissive: true, facadeEmitters: off });
    expect(sample.intensity).toBe(0);
    expect(sample.facadeIrradiance).toBe(0);
    expect(sample.facadeWarmth).toBe(0);
  });

  test('window area sources emit outward and do not shine through their back faces', () => {
    const patch = libraryFacadeEmitters().find(source => source.wallId === 'library-west-glass');
    const options = { lights: [], emissive: true, facadeEmitters: [patch], occlusion: false };
    const front = sampleLibraryLight(plus(patch.position, patch.normal, 8), patch.normal.map(value => -value), options);
    const back = sampleLibraryLight(plus(patch.position, patch.normal, -8), patch.normal, options);
    expect(front.facadeIrradiance).toBeGreaterThan(.1);
    expect(front.intensity).toBeLessThan(1);
    expect(back.facadeIrradiance).toBe(0);
    expect(front.directIntensity).toBe(0);
    expect(front.groundDirection).toEqual({ x: 0, y: 0 });
    expect(Math.hypot(front.surfaceGroundDirection.x, front.surfaceGroundDirection.y)).toBeCloseTo(1, 10);
  });

  test('real geometry blocks area reception and the high main roof stays unlit', () => {
    const position = screenToWorld(644, 293); position[2] = 1.8;
    const options = { lights: [], emissive: true, upright: true, receiverKind: 'actor' };
    const blocked = sampleLibraryLight(position, [0, 0, 1], options);
    const clear = sampleLibraryLight(position, [0, 0, 1], { ...options, occlusion: false });
    expect(clear.facadeIrradiance).toBeGreaterThan(.04);
    expect(blocked.facadeIrradiance).toBeLessThan(clear.facadeIrradiance * .1);
    const roof = resolveLibrarySurface(635, 211);
    const roofLight = sampleLibraryLight(roof.position, roof.normal, { emissive: true, indirect: true, receiverKind: 'roof' });
    expect(roofLight.facadeIrradiance).toBe(0);
    expect(roofLight.intensity).toBe(0);
  });

  test('actual grove leaves and entry paving gain warm room light without changing direct lamps', () => {
    for (const [x, y, kind] of [[590, 266, 'tree'], [613, 278, 'ground']]) {
      const hit = resolveLibrarySurface(x, y);
      expect(hit.kind).toBe(kind);
      const options = { excludeId: hit.id, receiverKind: kind, indirect: true };
      const previous = sampleLibraryLight(hit.position, hit.normal, options);
      const coupled = sampleLibraryLight(hit.position, hit.normal, { ...options, emissive: true });
      expect(coupled.facadeIntensity).toBeGreaterThan(.04);
      expect(coupled.facadeWarmth).toBeGreaterThan(.8);
      expect(coupled.directIrradiance).toBe(previous.directIrradiance);
      expect(coupled.indirectIrradiance).toBe(previous.indirectIrradiance);
      expect(coupled.directIntensity + coupled.indirectIntensity + coupled.facadeIntensity).toBeCloseTo(coupled.intensity, 12);
    }
  });

  test('an isolated actual fixture illuminates its facing normal, never its reverse', () => {
    const light = libraryLights.find(light => light.id === 'library-west-door-north');
    const position = screenToWorld(610, 269);
    const facing = normalize(light.position.map((v, i) => v - position[i]));
    const options = { lights: [light], occlusion: false };
    const lit = sampleLibraryLight(position, facing, options);
    const back = sampleLibraryLight(position, facing.map(v => -v), options);
    expect(lit.intensity).toBeGreaterThan(.4);
    expect(back.intensity).toBe(0);
    expect(lit.dominantSourceId).toBe(light.id);
  });

  test('distance reduces energy and a low lamp cannot illuminate a roof facing upward', () => {
    const light = libraryLights.find(light => light.id === 'library-east-entry');
    const near = plus(light.position, [1, 0, 0], 6);
    const far = plus(light.position, [1, 0, 0], 18);
    const options = { lights: [light], occlusion: false };
    expect(sampleLibraryLight(near, [-1, 0, 0], options).intensity)
      .toBeGreaterThan(sampleLibraryLight(far, [-1, 0, 0], options).intensity * 2);
    const roof = resolveLibrarySurface(635, 211);
    expect(sampleLibraryLight(roof.position, roof.normal, { occlusion: false }).intensity).toBe(0);
    const reflected = sampleLibraryLight(roof.position, roof.normal, { occlusion: false, indirect: true, receiverKind: 'roof' });
    expect(reflected.intensity).toBe(0);
    expect(reflected.indirectIntensity).toBe(0);
  });

  test('ground reflection is cached, energy-losing and tied to actual lamp footprints', () => {
    const patches = libraryGroundBounce();
    expect(libraryGroundBounce()).toBe(patches);
    expect(patches).toHaveLength(libraryLights.length);
    for (const patch of patches) {
      const source = libraryLights.find(light => light.id === patch.sourceId);
      expect(patch.position.slice(0, 2)).toEqual(source.position.slice(0, 2));
      expect(patch.ground).toEqual(source.ground);
      expect(patch.position[2]).toBeGreaterThanOrEqual(0);
      expect(patch.position[2]).toBeLessThan(.2);
      expect(patch.groundIrradiance).toBeGreaterThan(0);
      expect(patch.power).toBeGreaterThan(0);
      expect(patch.power).toBeLessThan(patch.groundIrradiance * .3);
      expect(patch.radius).toBeLessThan(source.radius);
    }
    const hit = resolveLibrarySurface(588, 278);
    for (const lights of [[], libraryLights.map(light => ({ ...light, power: 0 }))]) {
      const sample = sampleLibraryLight(hit.position, hit.normal, { lights, receiverKind: 'tree', indirect: true });
      expect(sample.intensity).toBe(0);
      expect(sample.indirectIrradiance).toBe(0);
    }
  });

  test('the actual grove fixture supplies wrapped and reflected leaf reception', () => {
    const hit = resolveLibrarySurface(588, 278);
    expect(hit.id).toBe('library-tree-west-grove');
    // Isolate the existing grove fixture: adding another legitimate direct
    // lamp should not invalidate the wrap/bounce energy contract.
    const lights = [libraryLights.find(light => light.id === 'library-west-grove-lamp')];
    const direct = sampleLibraryLight(hit.position, hit.normal, { excludeId: hit.id, lights });
    const foliage = sampleLibraryLight(hit.position, hit.normal, { excludeId: hit.id, lights, receiverKind: 'tree', indirect: true });
    expect(foliage.directIrradiance).toBeGreaterThan(direct.directIrradiance);
    expect(foliage.intensity).toBeGreaterThan(direct.intensity);
    expect(foliage.indirectIntensity).toBeGreaterThan(.003);
    expect(foliage.indirectIrradiance).toBeLessThan(libraryGroundBounce(lights)[0].power);
    expect(foliage.indirectWarmth).toBeGreaterThan(.7);
    expect(foliage.directIntensity + foliage.indirectIntensity).toBeCloseTo(foliage.intensity, 12);
    expect(Math.hypot(foliage.indirectDirection.x, foliage.indirectDirection.y)).toBeCloseTo(1, 10);
  });

  test('thin-leaf back transmission is weak and ordinary reverse normals remain dark', () => {
    const light = libraryLights.find(source => source.id === 'library-west-door-north');
    const position = screenToWorld(610, 269);
    const facing = normalize(light.position.map((v, i) => v - position[i]));
    const reverse = facing.map(value => -value), options = { lights: [light], occlusion: false };
    const front = sampleLibraryLight(position, facing, options);
    expect(sampleLibraryLight(position, reverse, options).intensity).toBe(0);
    const leaf = sampleLibraryLight(position, reverse, { ...options, receiverKind: 'tree' });
    expect(leaf.directIrradiance).toBeGreaterThan(0);
    expect(leaf.directIrradiance).toBeLessThan(front.directIrradiance * .13);
    expect(leaf.indirectIntensity).toBe(0);
  });

  test('a real wall blocks the reflected path as well as the original source', () => {
    const wall = librarySurfaces.find(surface => surface.id === 'library-west-glass');
    const center = wall.polygon.reduce((sum, p) => [sum[0] + p[0] / 4, sum[1] + p[1] / 4], [0, 0]);
    const hit = resolveLibrarySurface(...center);
    const behind = plus(hit.position, wall.normal, -4);
    // The entrance lamps now have a shorter footprint. Keep this receiver on
    // the same true wall plane, within the low ground-reflection range.
    behind[2] = 8;
    const lights = [libraryLights.find(light => light.id === 'library-west-door-center')];
    const options = { lights, receiverKind: 'wall', indirect: true };
    const blocked = sampleLibraryLight(behind, wall.normal, options);
    const clear = sampleLibraryLight(behind, wall.normal, { ...options, occlusion: false });
    expect(clear.indirectIrradiance).toBeGreaterThan(0);
    expect(blocked.directIrradiance).toBeLessThan(clear.directIrradiance * .06);
    expect(blocked.indirectIrradiance).toBeLessThan(clear.indirectIrradiance * .06);
    expect(blocked.intensity).toBeLessThan(clear.intensity * .08);
  });

  test('actor reflection shares the field without moving its shadow-casting source', () => {
    const position = screenToWorld(599, 291); position[2] = 1.8;
    const direct = sampleLibraryLight(position, [0, 0, 1], { upright: true });
    const reflected = sampleLibraryLight(position, [0, 0, 1], { upright: true, receiverKind: 'actor', indirect: true, emissive: true });
    const actor = sampleLibraryActor(599, 291);
    expect(actor).toEqual(reflected);
    expect(actor.indirectIntensity).toBeGreaterThan(.005);
    expect(actor.directIntensity).toBe(direct.intensity);
    for (const key of ['groundDirection', 'sourceHeight', 'sourceDistance', 'groundSourceDistance', 'dominantSourceId', 'elevation']) {
      expect(actor[key]).toEqual(direct[key]);
    }
  });

  test('each real registered wall interrupts a crossing segment and can exclude itself', () => {
    for (const surface of librarySurfaces.filter(surface => surface.kind === 'wall')) {
      const point = surface.polygon.reduce((sum, p) => [sum[0] + p[0] / 4, sum[1] + p[1] / 4], [0, 0]);
      const hit = resolveLibrarySurface(...point);
      expect(hit.id).toBe(surface.id);
      const outside = plus(hit.position, surface.normal, 8), inside = plus(hit.position, surface.normal, -8);
      expect(librarySegmentVisibility(outside, inside)).toBeLessThan(.1);
      expect(librarySegmentVisibility(outside, inside, { excludeId: surface.id })).toBeGreaterThan(.95);
      expect(librarySegmentVisibility(hit.position, outside, { excludeId: surface.id })).toBeGreaterThan(.95);
    }
  });

  test('a real tree volume blocks crossing rays with finite porous transmission', () => {
    const tree = libraryTrees.find(tree => tree.id === 'library-tree-outer-path');
    const start = plus(tree.ellipsoid.center, [0, 0, 1], 20);
    const end = plus(tree.ellipsoid.center, [0, 0, 1], -14);
    const blocked = librarySegmentVisibility(start, end);
    expect(blocked).toBeGreaterThan(0);
    expect(blocked).toBeLessThan(.15);
    expect(librarySegmentVisibility(start, end, { excludeId: tree.id })).toBe(1);
    const offset = tree.ellipsoid.radii[0] * 3;
    expect(librarySegmentVisibility(plus(start, [1, 0, 0], -offset), plus(end, [1, 0, 0], -offset))).toBe(1);
  });

  test('actual source-to-receiver building occlusion reduces sampled illumination', () => {
    const position = screenToWorld(650, 260);
    const blocked = sampleLibraryLight(position, [0, 0, 1]);
    const unblocked = sampleLibraryLight(position, [0, 0, 1], { occlusion: false });
    expect(unblocked.intensity).toBeGreaterThan(.1);
    expect(blocked.intensity).toBeLessThan(unblocked.intensity * .15);
    expect(blocked.visibility).toBeLessThan(.1);
  });

  test('visible crown intersections have curved normals and feathered silhouettes', () => {
    const tree = libraryTrees.find(tree => tree.id === 'library-tree-outer-path');
    const { x, y } = worldToScreen(tree.ellipsoid.center);
    const hit = resolveLibrarySurface(x, y);
    expect(hit.id).toBe(tree.id);
    expect(hit.kind).toBe('tree');
    const implicit = hit.position.reduce((sum, value, i) => sum + ((value - tree.ellipsoid.center[i]) / tree.ellipsoid.radii[i]) ** 2, 0);
    expect(implicit).toBeCloseTo(1, 8);
    expect(hit.normal[2]).toBeGreaterThan(0);
    expect(Math.hypot(...hit.normal)).toBeCloseTo(1, 8);
    const crown = treeOpacityAt(x, y, tree.base.y - 1);
    expect(crown).toBeGreaterThan(.9);
    expect(treeOpacityAt(x, y, tree.base.y + 1)).toBe(0);
    expect(treeOpacityAt(tree.screenBounds.left - 1, y, tree.base.y - 1)).toBe(0);
    const edge = treeOpacityAt(x - tree.screenBounds.width * .41, y, tree.base.y - 1);
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(crown);
  });

  test('canopy tint edges vary around each crown while staying inside its exact projected volume', () => {
    const tree = libraryTrees.find(tree => tree.id === 'library-tree-outer-path');
    const p = tree.projection, edgeValues = [];
    for (let i = 0; i < 48; i++) {
      const angle = i * Math.PI / 24;
      const project = radius => {
        const u = Math.cos(angle) * radius, v = Math.sin(angle) * radius;
        return [p.center.x + Math.sqrt(p.xx) * u,
          p.center.y + p.xy / Math.sqrt(p.xx) * u + Math.sqrt(p.determinant / p.xx) * v];
      };
      const edge = project(.91);
      const alpha = treeOpacityAt(...edge, tree.base.y - 1);
      edgeValues.push(alpha);
      expect(treeOpacityAt(...edge, tree.base.y - 1)).toBe(alpha);
      expect(treeOpacityAt(...project(1.01), tree.base.y - 1)).toBe(0);
    }
    expect(Math.max(...edgeValues) - Math.min(...edgeValues)).toBeGreaterThan(.02);
  });

  test('actor capsules share sources and shadows while responding differently from horizontal pavement', () => {
    const actor = sampleLibraryActor(613, 278);
    const ground = sampleLibraryLight(screenToWorld(613, 278), [0, 0, 1]);
    expect(actor.intensity).toBeGreaterThan(.5);
    expect(Math.abs(actor.intensity - ground.intensity)).toBeGreaterThan(.1);
    expect(libraryLights.map(light => light.id)).toContain(actor.dominantSourceId);
    expect(actor.sourceHeight).toBeGreaterThan(actor.elevation);
    expect(actor.sourceDistance).toBeGreaterThan(0);
    expect(actor.direction.y).toBeLessThan(0);
    expect(sampleLibraryActor(664, 263).visibility).toBeLessThan(.2);
  });

  test('an elevated actual lamp cannot reverse the direction of a ground shadow', () => {
    for (const id of ['library-west-walk', 'library-east-entry']) {
      const light = libraryLights.find(source => source.id === id);
      const torso = screenToWorld(light.ground.x, light.ground.y - 2);
      torso[2] = 1.8;
      const sample = sampleLibraryLight(torso, [0, 0, 1], { upright: true, lights: [light], occlusion: false });
      // The lamp appears above the torso, but its footprint is below the feet.
      expect(sample.direction.y).toBeLessThan(0);
      expect(sample.groundDirection.x).toBeCloseTo(0, 9);
      expect(sample.groundDirection.y).toBeCloseTo(1, 9);
      expect(sample.groundSourceDistance).toBeCloseTo(2, 9);
    }
    expect(sampleLibraryActor(0, 0).groundDirection).toEqual({ x: 0, y: 0 });
  });

  test('all atlas material samples and actor samples remain finite and bounded', () => {
    let count = 0;
    for (let y = 188; y <= 335; y += 7) for (let x = 548; x <= 739; x += 7) {
      const hit = resolveLibrarySurface(x, y);
      const samples = [sampleLibraryActor(x, y)];
      if (hit) {
        samples.push(sampleLibraryLight(hit.position, hit.normal, { excludeId: hit.id }));
        samples.push(sampleLibraryLight(hit.position, hit.normal, { excludeId: hit.id, indirect: true, emissive: true, receiverKind: hit.kind }));
        count++;
      }
      for (const sample of samples) {
        for (const key of ['intensity', 'warmth', 'visibility', 'elevation', 'blend', 'directIntensity', 'indirectIntensity', 'facadeIntensity', 'directWarmth', 'indirectWarmth', 'facadeWarmth', 'surfaceElevation']) {
          expect(sample[key]).toBeGreaterThanOrEqual(0);
          expect(sample[key]).toBeLessThanOrEqual(1);
        }
        for (const value of [sample.sourceHeight, sample.sourceDistance, sample.groundSourceDistance,
          sample.direction.x, sample.direction.y, sample.groundDirection.x, sample.groundDirection.y]) expect(Number.isFinite(value)).toBe(true);
        const length = Math.hypot(sample.direction.x, sample.direction.y);
        expect(length === 0 || Math.abs(length - 1) < 1e-9).toBe(true);
        const groundLength = Math.hypot(sample.groundDirection.x, sample.groundDirection.y);
        expect(groundLength === 0 || Math.abs(groundLength - 1) < 1e-9).toBe(true);
        expect(sample.directIntensity + sample.indirectIntensity + sample.facadeIntensity).toBeCloseTo(sample.intensity, 12);
        for (const direction of [sample.directDirection, sample.indirectDirection, sample.indirectGroundDirection, sample.facadeDirection, sample.surfaceGroundDirection]) {
          const length = Math.hypot(direction.x, direction.y);
          expect(length === 0 || Math.abs(length - 1) < 1e-9).toBe(true);
        }
      }
    }
    expect(count).toBeGreaterThan(150);
    expect(sampleLibraryLight([NaN, 1, 0], [0, 0, 1]).intensity).toBe(0);
    expect(sampleLibraryLight([1, 1, 0], [0, Infinity, 1]).intensity).toBe(0);
  });
});
