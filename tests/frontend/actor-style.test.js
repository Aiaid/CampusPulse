import {describe,test,expect} from 'vitest';
import {alphaFrames,actorDimensions} from '../../src/campus/actor-style.js';

describe('scene actor proportions',()=>{
 test('directional cells keep their own alpha bounds without neighbouring artwork',()=>{
  const data=new Uint8ClampedArray(12*12*4);
  for(let y=1;y<5;y++)for(let x=2;x<4;x++)data[(y*12+x)*4+3]=255;
  for(let y=7;y<11;y++)for(let x=9;x<11;x++)data[(y*12+x)*4+3]=255;
  const frames=alphaFrames({data,width:12,height:12});
  expect(frames[0]).toEqual({x:1,y:0,width:4,height:6,empty:false});
  expect(frames[1].empty).toBe(true);
  expect(frames[2].empty).toBe(true);
  expect(frames[3]).toEqual({x:8,y:6,width:4,height:6,empty:false});
 });
 test('the same visible frame preserves its aspect ratio at every map zoom',()=>{
  const frame={width:24,height:60};
  const small=actorDimensions({kind:'walk'},frame,.5),large=actorDimensions({kind:'walk'},frame,4);
  expect(small.width/small.height).toBeCloseTo(.4);
  expect(large.width/large.height).toBeCloseTo(.4);
  expect(large.height/small.height).toBeCloseTo(8);
 });
 test('overview and local views share world sizes instead of separate pixel clamps',()=>{
  const frame={width:32,height:64};
  const overview=actorDimensions({kind:'walk'},frame,1.31),local=actorDimensions({kind:'walk'},frame,2.71);
  expect(overview.height/1.31).toBeCloseTo(local.height/2.71);
  expect(local.height).toBeLessThan(16);
  expect(overview.height).toBeLessThan(8);
 });
 test('parked vehicles retain a comparable vehicle scale without a rider',()=>{
  const frame={width:60,height:64};
  const riding=actorDimensions({kind:'ride',parked:false},frame,2),parked=actorDimensions({kind:'ride',parked:true},frame,2);
  expect(parked.height/riding.height).toBeGreaterThan(.6);
  expect(parked.height/riding.height).toBeLessThan(.85);
 });
});
