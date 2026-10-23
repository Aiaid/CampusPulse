import {describe,test,expect} from 'vitest';
import {actorLightMaterial,toneActorPixel} from '../../src/campus/actor-lighting.js';
const energy=rgb=>rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;

describe('local light on synthetic actor materials',()=>{
 test('more incident light increases exposure while preserving blue/orange identity',()=>{
  const dark=actorLightMaterial({intensity:0,warmth:0});
  const lit=actorLightMaterial({intensity:1,warmth:1,direction:{x:1,y:0}});
  for(const rgb of [[20,80,210],[210,100,12]]){
   const a=toneActorPixel(rgb,dark),b=toneActorPixel(rgb,lit);
   expect(energy(b)).toBeGreaterThan(energy(a));
  }
  for(const level of [0,.25,.5,.75,1]){
   const material=actorLightMaterial({intensity:level,warmth:1,direction:{x:1,y:0}});
   const blue=toneActorPixel([20,80,210],material,1,1);
   const orange=toneActorPixel([210,100,12],material,1,1);
   expect(blue[2]).toBeGreaterThan(blue[1]);expect(blue[1]).toBeGreaterThan(blue[0]);
   expect(orange[0]).toBeGreaterThan(orange[1]);expect(orange[1]).toBeGreaterThan(orange[2]);
  }
 });
 test('a warm source changes the source-facing rim while preserving material color',()=>{
  const m=actorLightMaterial({intensity:1,warmth:1,direction:{x:1,y:0}});
  const core=toneActorPixel([20,80,210],m,0,1),rim=toneActorPixel([20,80,210],m,1,1);
  expect(rim[0]).toBeGreaterThan(core[0]);expect(rim[2]).toBeLessThan(core[2]);
  expect(toneActorPixel([20,80,210],m,0,1)[0]).toBeGreaterThanOrEqual(toneActorPixel([20,80,210],m,0,0)[0]);
 });
 test('bad or extreme samples cannot create invalid channel values or unbounded bins',()=>{
  for(const sample of [{},{intensity:NaN,warmth:Infinity},{intensity:-99,warmth:-2},{intensity:99,warmth:99}]){
   const m=actorLightMaterial(sample),rgb=toneActorPixel([255,0,128],m,1,1);
   expect(m.level).toBeGreaterThanOrEqual(0);expect(m.level).toBeLessThanOrEqual(7);
   for(const v of rgb){expect(Number.isFinite(v)).toBe(true);expect(v).toBeGreaterThanOrEqual(0);expect(v).toBeLessThanOrEqual(255);}
  }
 });
});
