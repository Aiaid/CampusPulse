import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { routes, buildings, officialBuildings, manualBuildings, roadRegions, officialRoutePreviews,
  parkingAreas, facadeLights, pointInPolygon, sampleRoute, classifyOcclusion } from '../../src/campus/spatial-scene.js';
const semantics = JSON.parse(fs.readFileSync(new URL('../../src/campus/gis-semantics.json', import.meta.url), 'utf8'));

// These checks validate retained source geometry and screen-space consistency,
// not surveyed access, real traffic rules or a complete ground collision model.
test('official building masks retain exact source vertices and provenance', () => {
  assert.ok(officialBuildings.length >= 15);
  for (const building of officialBuildings) {
    const source = semantics.sourcePolygons.find(({ sourceId }) => sourceId === building.sourceId);
    assert.ok(source);
    assert.deepEqual(building.polygon, source.vertices);
    assert.equal(building.name, source.name);
    assert.equal(building.provenance.sourceNamespace, 'ccnu_gis_tip_feature');
    assert.deepEqual(building.provenance.sourceFiles, source.sourceFiles);
    assert.equal(building.geometryRole, 'projected-screen-occluder');
    assert.equal(building.groundObstacle, false);
  }
  assert.equal(buildings.find(({ id }) => id === 'library-main').sourceId, '10644');
  assert.equal(buildings.find(({ id }) => id === 'tianjiabing-main').sourceId, '10655');
  assert.equal(buildings.some(({ id }) => id === 'library-south-annex'), false);
  for (const building of manualBuildings) {
    assert.equal(building.sourceId, null);
    assert.equal(building.placeId, null, 'unidentified nearby buildings must not acquire a guessed school name');
    assert.equal(building.provenance.kind, 'manual-illustrative');
  }
});

test('mixed-category road and park regions never become opaque building masks', () => {
  for (const sourceId of ['10703', '10754', '10759', '10762']) {
    assert.equal(buildings.some((building) => building.sourceId === sourceId), false);
  }
  const source = semantics.sourcePolygons.find(({ sourceId }) => sourceId === '10759');
  assert.deepEqual(roadRegions[0].polygon, source.vertices);
  assert.equal(roadRegions[0].geometryRole, 'reviewed-road-related-region');
});

test('point inclusion handles concavity, boundary and object coordinates', () => {
  const polygon = [[0, 0], [5, 0], [5, 2], [2, 2], [2, 5], [0, 5]];
  assert.equal(pointInPolygon([1, 4], polygon), true);
  assert.equal(pointInPolygon({ x: 4, y: 4 }, polygon), false);
  assert.equal(pointInPolygon([2, 3], polygon), true);
  assert.equal(pointInPolygon([5, 0], polygon), true);
});

test('route progress uses segment length, clamps endpoints and reports screen heading', () => {
  const route = { points: [[10, 20], [40, 20], [40, 60]] };
  assert.deepEqual(sampleRoute(route, -1), { x: 10, y: 20, heading: 0 });
  assert.deepEqual(sampleRoute(route, 1 / 7), { x: 20, y: 20, heading: 0 });
  assert.deepEqual(sampleRoute(route, .5), { x: 40, y: 25, heading: 90 });
  assert.deepEqual(sampleRoute(route, 2), { x: 40, y: 60, heading: 90 });
  assert.equal(sampleRoute({ points: [[5, 5], [5, 5], [-5, 5]] }, .5).heading, 180);
  assert.deepEqual(sampleRoute({ points: [[5, 5], [5, 5]] }, .5), { x: 5, y: 5, heading: 0 });
});

test('derived lanes stay inset inside the official road region with opposing headings', () => {
  const lanes = routes.filter(({ sourceId }) => sourceId === '10759');
  assert.equal(lanes.length, 2);
  for (const lane of lanes) {
    assert.equal(lane.provenance.kind, 'derived-illustrative-lane');
    for (let i = 0; i <= 800; i += 1) {
      assert.equal(pointInPolygon(sampleRoute(lane, i / 800), roadRegions[0].polygon), true);
    }
  }
  const [first, second] = lanes.map((lane) => sampleRoute(lane, .5));
  const angularDifference = ((first.heading - second.heading) % 360 + 360) % 360;
  assert.ok(Math.abs(angularDifference - 180) < 1e-7);
  assert.ok(Math.hypot(first.x - second.x, first.y - second.y) > 1, 'artistic lanes must be spatially separate');
});

test('moving actor feet stay on reviewed pavement except the narrow entrance canopy approach', () => {
  let coveredSamples = 0;
  for (const route of routes) {
    assert.ok(route.provenance);
    for (let index = 0; index <= 800; index += 1) {
      const point = sampleRoute(route, index / 800);
      const occluder = classifyOcclusion(point);
      assert.ok(Number.isFinite(point.heading));
      if (occluder) {
        assert.equal(occluder.id, route.coveredBy, `${route.id} crosses ${occluder.id}`);
        assert.ok(route.allowedOcclusionRegion);
        assert.equal(pointInPolygon(point, route.allowedOcclusionRegion), true, 'cover is permitted only beneath the circular entrance canopy');
        coveredSamples += 1;
      }
    }
  }
  assert.ok(coveredSamples > 0);
  assert.equal(classifyOcclusion({ x: 670.25, y: 225.25 })?.id, 'library-main', 'a roof anchor cannot become an actor ground position');
});

test('ordered parking slots remain illustrative, on their paved area and outside building silhouettes', () => {
  for (const area of parkingAreas) {
    assert.equal(area.provenance.confirmedParkingFacility, false);
    assert.equal(area.sourceId, null);
    for (const slot of area.slots) {
      assert.equal(pointInPolygon(slot, area.polygon), true, `${area.id} slot outside area`);
      assert.equal(classifyOcclusion(slot), null, `${area.id} slot on a building`);
      for (const region of roadRegions) assert.equal(pointInPolygon(slot, region.polygon), false, 'standing bikes stay on the paved edge outside the moving source corridor');
      assert.ok(slot.heading >= 0 && slot.heading < 360);
      assert.equal(slot.heading, area.slots[0].heading, 'a standing row shares a consistent heading');
    }
    for (let i = 1; i < area.slots.length; i += 1) {
      assert.ok(Math.hypot(area.slots[i].x - area.slots[i - 1].x, area.slots[i].y - area.slots[i - 1].y) >= 4);
    }
  }
});

test('source GetRoute is retained as a deduplicated preview, never as an actor route', () => {
  const preview = officialRoutePreviews[0];
  assert.equal(preview.worldPoints.length, 7);
  assert.equal(preview.points.length, 6);
  assert.equal(preview.eligibleForActors, false);
  assert.equal(preview.provenance.responseSha256, '3076f4777545d6824d43d9ce2af6ba824589b23a23e1a987b6ed29f3bd0a93c3');
  assert.equal(routes.some(({ id }) => id === preview.id), false);
  assert.ok(preview.points.some((point) => classifyOcclusion(point)), 'preview has unresolved projected building crossings');
});

test('manual facade light points stay in their named building mask after identity corrections', () => {
  for (const light of facadeLights) {
    const building = buildings.find(({ id }) => id === light.buildingId);
    assert.ok(building);
    assert.equal(pointInPolygon(light, building.polygon), true, `light outside ${building.id}`);
    assert.equal(light.provenance.kind, 'manual-artistic-light');
  }
  assert.ok(facadeLights.some(({ buildingId }) => buildingId === 'tianjiabing-main'));
});
