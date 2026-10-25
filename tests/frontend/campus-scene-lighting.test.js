import { describe, expect, test } from 'vitest';
import {
  createCampusSceneField, resolveCampusSurface, sampleCampusLight, sampleCampusActor,
  campusTreeOpacityAt, getCampusTreesInBounds, campusSpatialQueryStats,
} from '../../src/campus/campus-scene-lighting.js';
import { campusSurfaces, campusTrees, campusLights } from '../../src/campus/campus-scene-data.js';
import {
  screenToWorld, worldToScreen, libraryBlend, resolveLibrarySurface,
  sampleLibraryLight, sampleLibraryActor, treeOpacityAt,
} from '../../src/campus/library-lighting.js';

const plus = (p, n, distance) => p.map((v, i) => v + n[i] * distance);
const ground = { id: 'ground', kind: 'ground', height: 0, material: 'paving',
  polygon: [[90, 90], [310, 90], [310, 310], [90, 310]] };
const roof = { id: 'roof', buildingId: 'test-building', kind: 'roof', height: 30, material: 'roof',
  polygon: [[190, 140], [260, 140], [260, 190], [190, 190]] };
const wall = { id: 'wall', buildingId: 'test-building', kind: 'wall', height: 20, material: 'wall',
  polygon: [[200, 150], [240, 164], [240, 184], [200, 170]],
  windows: [{ id: 'room-0-0', lit: true, polygon: [[209, 157], [219, 160.5], [219, 167.5], [209, 164]] }] };
const light = { id: 'fixture', x: 120, y: 145, height: 7, power: 2.2, radius: 48 };
const tree = { id: 'tree', x: 160, y: 260, height: 10, radii: [6, 5, 8] };
const field = (extra = {}) => createCampusSceneField({ surfaces: [ground], lights: [light], delegateLibrary: false, ...extra });

describe('indexed campus receiver geometry', () => {
  test('paving never paints an unmodeled part of a registered building silhouette', () => {
    const model = field({ surfaces: [ground, roof], silhouettes: [
      { polygon: [[180, 130], [280, 130], [280, 220], [180, 220]] },
    ] });
    expect(model.resolveCampusSurface(190, 210)).toBeNull();
    expect(model.resolveCampusSurface(220, 160).kind).toBe('roof');
    expect(model.resolveCampusSurface(120, 120).kind).toBe('ground');
  });
  test('ground requires an explicit receiver and roof normals supersede overlapping paving', () => {
    const model = field({ surfaces: [ground, roof] });
    expect(model.resolveCampusSurface(10, 10)).toBeNull();
    expect(model.resolveCampusSurface(120, 120).kind).toBe('ground');
    const hit = model.resolveCampusSurface(220, 160);
    expect(hit.id).toBe('roof');
    expect(hit.material).toBe('roof');
    expect(hit.normal).toEqual([0, 0, 1]);
    expect(hit.position[2]).toBeCloseTo(30, 9);
    expect(hit.surface.buildingId).toBe('test-building');
    const roofLight = model.sampleCampusLight(hit.position, hit.normal, { indirect: true, occlusion: false });
    expect(roofLight.intensity).toBe(0);
    expect(roofLight.indirectIrradiance).toBe(0);
  });

  test('wall positions and camera-facing normals use the true top/bottom plane', () => {
    const model = field({ surfaces: [ground, wall] });
    const hit = model.resolveCampusSurface(220, 167);
    expect(hit.kind).toBe('wall');
    expect(Math.hypot(...hit.normal)).toBeCloseTo(1, 10);
    expect(hit.normal[2]).toBeCloseTo(0, 10);
    expect(hit.position[2]).toBeCloseTo(10, 10);
    expect(worldToScreen(hit.position).x).toBeCloseTo(220, 10);
    expect(worldToScreen(hit.position).y).toBeCloseTo(167, 10);
    const start = plus(hit.position, hit.normal, 8), end = plus(hit.position, hit.normal, -8);
    expect(model.campusSegmentVisibility(start, end)).toBeLessThan(.1);
    expect(model.campusSegmentVisibility(start, end, { excludeId: 'wall' })).toBe(1);
    expect(model.campusSegmentVisibility(start, end, { excludeId: 'test-building' })).toBe(1);
  });

  test('nested authored ground materials follow painter order without replacing roofs', () => {
    const pond = { ...ground, id: 'pond', material: 'water', polygon: [[180, 160], [240, 160], [240, 210], [180, 210]] };
    expect(field({ surfaces: [ground, pond] }).resolveCampusSurface(200, 180).material).toBe('water');
    expect(field({ surfaces: [ground, pond, roof] }).resolveCampusSurface(220, 170).kind).toBe('roof');
    expect(resolveCampusSurface(565, 448).material).toBe('water');
  });

  test('stable room emission exists only within retained panes on the visible wall', () => {
    const model = field({ surfaces: [ground, wall] });
    const pane = model.resolveCampusSurface(214, 162.25);
    expect(pane.kind).toBe('wall');
    expect(pane.emission).toEqual(model.resolveCampusSurface(214, 162.25).emission);
    expect(pane.emission.uv[0]).toBeCloseTo(.5);
    expect(pane.emission.uv[1]).toBeCloseTo(.5);
    expect(pane.emission.room.tier).toMatch(/bright|ordinary|dim/);
    expect(pane.emission.color).toEqual([255, 213, 162]);
    expect(model.resolveCampusSurface(202, 159).emission).toBeNull();
    const covered = field({ surfaces: [ground, wall, roof] }).resolveCampusSurface(214, 162.25);
    expect(covered.kind).toBe('roof');
    expect(covered.emission).toBeNull();
  });

  test('crown volume normals, foliage coverage and painter-depth opacity agree', () => {
    const model = field({ trees: [tree] });
    const [proxy] = model.getCampusTreesInBounds({ left: 140, top: 230, width: 40, height: 40 });
    expect(proxy.base).toEqual({ x: tree.x, y: tree.y });
    expect(proxy.screenBounds.width).toBeGreaterThan(10);
    expect(proxy.projection.determinant).toBeGreaterThan(0);
    const { x, y } = proxy.projection.center;
    const hit = model.resolveCampusSurface(x, y);
    expect(hit.kind).toBe('tree');
    expect(hit.tree).toBe(proxy);
    expect(hit.materialUV.every(v => v >= 0 && v <= 1)).toBe(true);
    expect(Math.hypot(...hit.normal)).toBeCloseTo(1, 10);
    expect(hit.position.reduce((sum, v, i) => sum + ((v - proxy.ellipsoid.center[i]) / proxy.ellipsoid.radii[i]) ** 2, 0)).toBeCloseTo(1, 10);
    expect(model.campusTreeOpacityAt(x, y, tree.y - 1)).toBeCloseTo(hit.coverage * .92, 10);
    expect(model.campusTreeOpacityAt(x, y, tree.y + 1)).toBe(0);
    expect(model.campusTreeOpacityAt(proxy.screenBounds.left - 1, y)).toBe(0);
    const start = plus(proxy.ellipsoid.center, [0, 0, 1], 15), end = plus(proxy.ellipsoid.center, [0, 0, 1], -15);
    expect(model.campusSegmentVisibility(start, end)).toBeGreaterThan(0);
    expect(model.campusSegmentVisibility(start, end)).toBeLessThan(.15);
    expect(model.campusSegmentVisibility(start, end, { excludeId: tree.id })).toBe(1);
  });
});

describe('shared campus light and actor field', () => {
  test('facade patches retain real pane area and emit only through their outward hemisphere', () => {
    const model = field({ surfaces: [ground, wall], lights: [] });
    const [patch] = model.campusFacadeEmitters();
    expect(model.campusFacadeEmitters()).toBe(model.campusFacadeEmitters());
    expect(patch.paneIds).toEqual(['room-0-0']);
    expect(patch.area).toBeCloseTo(70, 9);
    expect(patch.radius).toBeLessThanOrEqual(76);
    const front = plus(patch.position, patch.normal, 8), back = plus(patch.position, patch.normal, -8);
    const options = { emissive: true, occlusion: false };
    const facing = model.sampleCampusLight(front, patch.normal.map(v => -v), options);
    expect(facing.facadeIrradiance).toBeGreaterThan(.1);
    expect(facing.facadeWarmth).toBe(.84);
    expect(model.sampleCampusLight(back, patch.normal, options).facadeIrradiance).toBe(0);
    expect(facing.directIrradiance).toBe(0);
    expect(facing.directIntensity).toBe(0);
    expect(facing.groundDirection).toEqual({ x: 0, y: 0 });
    expect(facing.dominantSourceId).toBeNull();
    expect(Math.hypot(facing.surfaceGroundDirection.x, facing.surfaceGroundDirection.y)).toBeCloseTo(1, 10);
  });

  test('actual rooms supply nearby ground and actor fill without adding shadow-casting sources', () => {
    const model = field({ surfaces: [ground, wall], lights: [] });
    const [patch] = model.campusFacadeEmitters(), position = plus(patch.position, patch.normal, 8); position[2] = 0;
    const without = model.sampleCampusLight(position, [0, 0, 1]);
    const withRooms = model.sampleCampusLight(position, [0, 0, 1], { emissive: true });
    expect(without.intensity).toBe(0);
    expect(withRooms.facadeIrradiance).toBeGreaterThan(.03);
    expect(withRooms.facadeIntensity).toBe(withRooms.intensity);
    expect(withRooms.sourceHeight).toBe(0);
    expect(withRooms.sourceDistance).toBe(0);
    const foot = worldToScreen(position), actor = model.sampleCampusActor(foot.x, foot.y);
    expect(actor.facadeIrradiance).toBeGreaterThan(0);
    expect(actor.directIntensity + actor.indirectIntensity + actor.facadeIntensity).toBeCloseTo(actor.intensity, 12);
    const upwardRoof = plus(patch.position, patch.normal, 8); upwardRoof[2] = 30;
    expect(model.sampleCampusLight(upwardRoof, [0, 0, 1], { emissive: true, indirect: true }).intensity).toBe(0);
  });

  test('switching all actual panes off or supplying no emitters removes all facade energy', () => {
    const offWall = { ...wall, windows: wall.windows.map(pane => ({ ...pane, lit: false })) };
    const off = field({ surfaces: [ground, offWall], lights: [] });
    expect(off.campusFacadeEmitters()).toEqual([]);
    const point = screenToWorld(210, 182);
    expect(off.sampleCampusLight(point, [0, 0, 1], { emissive: true, indirect: true }).intensity).toBe(0);
    const on = field({ surfaces: [ground, wall], lights: [] });
    expect(on.campusFacadeEmitters().length).toBeGreaterThan(0);
    expect(on.sampleCampusLight(point, [0, 0, 1], { emissive: true, facadeEmitters: [] }).intensity).toBe(0);
  });

  test('zero sources give zero energy and invalid/outside inputs stay finite', () => {
    const model = field();
    const point = screenToWorld(130, 145); point[2] = 1.8;
    const off = model.sampleCampusLight(point, [0, 0, 1], { lights: [], indirect: true, emissive: true, upright: true });
    expect(off.intensity).toBe(0);
    expect(off.directIrradiance + off.indirectIrradiance + off.facadeIrradiance).toBe(0);
    expect(off.groundDirection).toEqual({ x: 0, y: 0 });
    expect(model.sampleCampusLight([NaN, 1, 0], [0, 0, 1]).intensity).toBe(0);
    expect(model.sampleCampusLight(point, [0, Infinity, 1]).intensity).toBe(0);
    expect(sampleCampusActor(-100, -100).intensity).toBe(0);
    expect(resolveCampusSurface(NaN, 100)).toBeNull();
    expect(campusTreeOpacityAt(100, Infinity)).toBe(0);
    expect(getCampusTreesInBounds({ left: NaN, top: 0, width: 1, height: 1 })).toEqual([]);
  });

  test('point-source incidence and radius use the same bounded response as the library', () => {
    const model = field();
    const source = screenToWorld(light.x, light.y); source[2] = light.height;
    const near = plus(source, [1, 0, 0], 5), far = plus(source, [1, 0, 0], 22);
    const front = model.sampleCampusLight(near, [-1, 0, 0], { occlusion: false });
    expect(front.intensity).toBeGreaterThan(model.sampleCampusLight(far, [-1, 0, 0], { occlusion: false }).intensity * 2);
    expect(model.sampleCampusLight(near, [1, 0, 0]).intensity).toBe(0);
    expect(model.sampleCampusLight(plus(source, [1, 0, 0], 49), [-1, 0, 0]).intensity).toBe(0);
    expect(front.dominantSourceId).toBe(light.id);
  });

  test('one ground bounce is cached, energy-losing and absent without an explicit ground', () => {
    const model = field(), patches = model.campusGroundBounce();
    expect(model.campusGroundBounce()).toBe(patches);
    expect(patches).toHaveLength(1);
    expect(patches[0].ground).toEqual({ x: light.x, y: light.y });
    expect(patches[0].power).toBeGreaterThan(0);
    expect(patches[0].power).toBeCloseTo(patches[0].groundIrradiance * .28, 10);
    expect(patches[0].radius).toBeLessThan(light.radius);
    expect(field({ surfaces: [] }).campusGroundBounce()[0].power).toBe(0);
    const off = field({ lights: [{ ...light, power: 0 }] });
    expect(off.campusGroundBounce()[0].power).toBe(0);
  });

  test('actor sampling is an identity wrapper and bounce never changes shadow metadata', () => {
    const model = field(), position = screenToWorld(130, 145); position[2] = 1.8;
    const direct = model.sampleCampusLight(position, [0, 0, 1], { upright: true });
    const material = model.sampleCampusLight(position, [0, 0, 1], { upright: true, indirect: true, emissive: true, receiverKind: 'actor' });
    expect(model.sampleCampusActor(130, 145)).toEqual(material);
    expect(material.indirectIrradiance).toBeGreaterThan(0);
    expect(material.directIrradiance).toBe(direct.directIrradiance);
    expect(material.directIntensity + material.indirectIntensity + material.facadeIntensity).toBeCloseTo(material.intensity, 12);
    for (const key of ['groundDirection', 'sourceHeight', 'sourceDistance', 'groundSourceDistance', 'dominantSourceId', 'elevation']) expect(material[key]).toEqual(direct[key]);
  });

  test('wall geometry blocks direct reception as well as a crossing visibility segment', () => {
    const wallField = field({ surfaces: [ground, wall], lights: [] });
    const hit = wallField.resolveCampusSurface(220, 167);
    const source = plus(hit.position, hit.normal, 8), position = plus(hit.position, hit.normal, -8);
    const fixture = { id: 'wall-test-source', position: source, power: 3, radius: 40, height: source[2] };
    const options = { lights: [fixture] };
    const blocked = wallField.sampleCampusLight(position, hit.normal, options);
    const clear = wallField.sampleCampusLight(position, hit.normal, { ...options, occlusion: false });
    expect(clear.intensity).toBeGreaterThan(.1);
    expect(blocked.directIrradiance).toBeLessThan(clear.directIrradiance * .1);
  });

  test('direct shadow direction uses the lamp ground footprint rather than elevated screen lens', () => {
    const model = field();
    const torso = screenToWorld(light.x, light.y - 2); torso[2] = 1.8;
    const result = model.sampleCampusLight(torso, [0, 0, 1], { upright: true, occlusion: false });
    expect(result.direction.y).toBeLessThan(0);
    expect(result.groundDirection.x).toBeCloseTo(0, 10);
    expect(result.groundDirection.y).toBeCloseTo(1, 10);
    expect(result.groundSourceDistance).toBeCloseTo(2, 10);
  });
});

describe('campus coverage and accepted library boundary', () => {
  test('the accepted library continues to own receiver, light, actor and crown samples', () => {
    for (const [x, y] of [[613, 278], [599, 291], [635, 211], [552, 260]]) {
      const accepted = resolveLibrarySurface(x, y), campus = resolveCampusSurface(x, y);
      if (accepted) {
        expect(campus).toMatchObject(accepted);
        expect(campus.libraryBlend).toBe(libraryBlend(x, y));
        expect(sampleCampusLight(accepted.position, accepted.normal, { indirect: true, emissive: true }))
          .toEqual(sampleLibraryLight(accepted.position, accepted.normal, { indirect: true, emissive: true }));
      } else expect(campus).toBeNull();
      expect(sampleCampusActor(x, y)).toEqual(sampleLibraryActor(x, y));
      expect(campusTreeOpacityAt(x, y, y - 1)).toBe(treeOpacityAt(x, y, y - 1));
    }
  });

  test('registered roof and facade receivers span the visible campus', () => {
    const found = new Set(), kinds = new Set();
    let count = 0;
    for (let y = 4; y < 640; y += 8) for (let x = 4; x < 1024; x += 8) {
      const hit = resolveCampusSurface(x, y);
      if (!hit || hit.libraryBlend > 0) continue;
      count++; kinds.add(hit.kind); found.add(`${Math.floor(x / 256)}:${Math.floor(y / 160)}`);
      expect(Math.hypot(...hit.normal)).toBeCloseTo(1, 7);
      expect(hit.position.every(Number.isFinite)).toBe(true);
    }
    expect(count).toBeGreaterThan(1000);
    expect(found.size).toBe(16);
    expect(kinds).toEqual(new Set(['roof', 'wall', 'ground', 'tree']));
  });

  test('point queries bound work to local source/surface/tree cells', () => {
    let surfaceMax = 0, treeMax = 0, lightMax = 0, facadeMax = 0, facadeCount = 0;
    for (let y = 16; y < 640; y += 32) for (let x = 16; x < 1024; x += 32) {
      const stats = campusSpatialQueryStats(x, y);
      surfaceMax = Math.max(surfaceMax, stats.surfaceCandidates);
      treeMax = Math.max(treeMax, stats.treeCandidates);
      lightMax = Math.max(lightMax, stats.lightCandidates);
      facadeMax = Math.max(facadeMax, stats.facadeCandidates); facadeCount = stats.facadeCount;
    }
    expect(surfaceMax).toBeLessThan(campusSurfaces.length / 5);
    expect(treeMax).toBeLessThan(campusTrees.length / 5);
    expect(lightMax).toBeLessThan(campusLights.length / 5);
    expect(facadeCount).toBeGreaterThan(0);
    expect(facadeMax).toBeLessThan(facadeCount / 2);
    expect(getCampusTreesInBounds({ left: 0, top: 0, width: 1024, height: 640 }).length).toBeGreaterThanOrEqual(campusTrees.length);
    expect(getCampusTreesInBounds({ left: 100, top: 100, width: 32, height: 32 }).length).toBeLessThan(campusTrees.length / 10);
  });

  test('all sampled actor/material energies and direction metadata stay finite', () => {
    let illuminated = 0;
    for (let y = 12; y < 640; y += 32) for (let x = 12; x < 1024; x += 32) {
      const hit = resolveCampusSurface(x, y);
      const samples = [sampleCampusActor(x, y)];
      if (hit) samples.push(sampleCampusLight(hit.position, hit.normal, { excludeId: hit.id, indirect: true, emissive: true, receiverKind: hit.kind }));
      for (const sample of samples) {
        if (sample.intensity > .05) illuminated++;
        for (const key of ['intensity', 'directIntensity', 'indirectIntensity', 'facadeIntensity', 'warmth', 'visibility', 'elevation', 'surfaceElevation']) {
          expect(sample[key]).toBeGreaterThanOrEqual(0); expect(sample[key]).toBeLessThanOrEqual(1);
        }
        for (const key of ['directIrradiance', 'indirectIrradiance', 'facadeIrradiance', 'sourceHeight', 'sourceDistance', 'groundSourceDistance']) expect(Number.isFinite(sample[key])).toBe(true);
        for (const vector of [sample.direction, sample.groundDirection, sample.directDirection, sample.indirectDirection, sample.surfaceGroundDirection]) {
          const length = Math.hypot(vector.x, vector.y);
          expect(length === 0 || Math.abs(length - 1) < 1e-9).toBe(true);
        }
        expect(sample.directIntensity + sample.indirectIntensity + sample.facadeIntensity).toBeCloseTo(sample.intensity, 12);
      }
    }
    expect(illuminated).toBeGreaterThan(100);
  });
});
