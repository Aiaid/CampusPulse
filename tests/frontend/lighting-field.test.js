import { describe, expect, test } from 'vitest';
import { nearestRoutePoint, lampSurfaceFrame, surfaceCoverage, sampleLocalLight } from '../../src/campus/lighting-field.js';
import { buildings, routes, roadRegions, parkingAreas, pointInPolygon } from '../../src/campus/spatial-scene.js';

const horizontal = {id:'walk',width:6,points:[[0,0],[10,0]]};
describe('registered light surface geometry', () => {
  test('nearest local segment supplies a normalized tangent and clamped projection', () => {
    const nearest = nearestRoutePoint([3,4],[horizontal,{id:'degenerate',points:[[4,4],[4,4]]}]);
    expect(nearest).toMatchObject({x:3,y:0,distance:4,tangent:[1,0],t:.3});
    expect(nearestRoutePoint([13,4],[horizontal])).toMatchObject({x:10,y:0,distance:5,t:1});
    expect(nearestRoutePoint([NaN,4],[horizontal])).toBeNull();
  });
  test('a remote road cannot orient an unrelated lamp', () => {
    expect(lampSurfaceFrame([3,4],[horizontal],[])).toMatchObject({kind:'route',angle:0});
    expect(lampSurfaceFrame([100,100],[horizontal],[])).toMatchObject({kind:'local',routeId:null});
    const apron={id:'apron',polygon:[[90,90],[110,90],[110,110],[90,110]]};
    expect(lampSurfaceFrame([100,92],[horizontal],[apron])).toMatchObject({kind:'apron',distance:2});
  });
  test('surface coverage fades inward and excludes overlapping projected buildings', () => {
    const options={routeList:[horizontal],regions:[],occluders:[],feather:2};
    expect(surfaceCoverage([5,0],options)).toBe(1);
    expect(surfaceCoverage([5,5],options)).toBeGreaterThan(0);
    expect(surfaceCoverage([5,5],options)).toBeLessThan(1);
    expect(surfaceCoverage([5,12],options)).toBe(0);
    const occluders=[{polygon:[[2,-3],[6,-3],[6,3],[2,3]]},{polygon:[[4,-3],[8,-3],[8,3],[4,3]]}];
    expect(surfaceCoverage([5,0],{...options,occluders})).toBe(0);
  });
  test('actual projected roofs always exclude ground light, including source overlaps', () => {
    let covered=0, lit=0;
    for(let y=0;y<=640;y+=4) for(let x=0;x<=1024;x+=4) {
      const point=[x,y];
      if(buildings.some(b=>pointInPolygon(point,b.polygon))) {
        expect(surfaceCoverage(point)).toBe(0);covered++;
      }
    }
    for(const route of routes) for(const point of route.points) if(surfaceCoverage(point)>0)lit++;
    expect(covered).toBeGreaterThan(500);
    expect(lit).toBeGreaterThan(10);
    expect(surfaceCoverage([0,0],{regions:[...roadRegions,...parkingAreas]})).toBe(0);
  });
});

describe('shared local light sampling', () => {
  test('retained lamps and entrance paving are warmer and brighter than a road gap', () => {
    const gap = sampleLocalLight(764,251);
    expect(gap.intensity).toBeLessThan(.25);
    for (const [x,y] of [[765,232],[599,270],[713,310]]) {
      const light = sampleLocalLight(x,y);
      expect(light.intensity).toBeGreaterThan(.6);
      expect(light.intensity).toBeGreaterThan(gap.intensity * 3);
      expect(light.warmth).toBeGreaterThan(.6);
    }
  });
  test('samples stay bounded and give a finite source-facing direction', () => {
    for (const [x,y] of [[599,270],[713,310],[764,251],[702,360],[0,0]]) {
      const light = sampleLocalLight(x,y);
      for (const value of [light.intensity,light.warmth]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
      expect(Number.isFinite(light.direction.x)).toBe(true);
      expect(Number.isFinite(light.direction.y)).toBe(true);
      const length = Math.hypot(light.direction.x,light.direction.y);
      expect(length === 0 || Math.abs(length - 1) < 1e-10).toBe(true);
    }
    const westEntry = sampleLocalLight(599,270);
    expect(westEntry.direction.x).toBeGreaterThan(0);
    expect(westEntry.direction.y).toBeLessThan(0);
    for (const [x,y] of [[NaN,270],[599,Infinity],[-Infinity,0]]) {
      expect(sampleLocalLight(x,y)).toEqual({intensity:0,warmth:0,direction:{x:0,y:0}});
    }
  });
  test('projected buildings exclude light even beside a lit entry lamp', () => {
    expect(sampleLocalLight(612,276).intensity).toBeGreaterThan(.6);
    for (const point of [[620,275],[635,280],[640,240]]) {
      expect(buildings.some(building => pointInPolygon(point,building.polygon))).toBe(true);
      expect(sampleLocalLight(...point)).toEqual({intensity:0,warmth:0,direction:{x:0,y:0}});
    }
  });
});
