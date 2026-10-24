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
 test('explicit detail legibility reaches desktop and narrow-phone glyph sizes without changing physical height',()=>{
  const frame={width:24,height:60};
  const desktop=actorDimensions({kind:'walk'},frame,10.452/4.8,{readable:true,viewWidth:394});
  const phone=actorDimensions({kind:'walk'},frame,6.708/4.8,{readable:true,viewWidth:350});
  expect(desktop.height).toBeCloseTo(16,8);expect(phone.height).toBeCloseTo(13,8);
  expect(desktop.physicalHeight).toBeCloseTo(10.452,8);expect(phone.physicalHeight).toBeCloseTo(6.708,8);
  expect(desktop.width/desktop.height).toBeCloseTo(.4,8);expect(phone.width/phone.height).toBeCloseTo(.4,8);
  expect(desktop.presentationScale).toBeGreaterThan(1);expect(phone.presentationScale).toBeLessThanOrEqual(2);
 });
 test('the same detail glyph factor preserves walker, rider and parked-vehicle proportions',()=>{
  const options={readable:true,viewWidth:394},scale=2;
  const walk=actorDimensions({kind:'walk'},{width:24,height:60},scale,options);
  const ride=actorDimensions({kind:'ride'},{width:60,height:64},scale,options);
  const parked=actorDimensions({kind:'ride',parked:true},{width:60,height:64},scale,options);
  expect(walk.presentationScale).toBe(ride.presentationScale);expect(ride.presentationScale).toBe(parked.presentationScale);
  expect(ride.height).toBe(walk.height);expect(parked.height/walk.height).toBeCloseTo(.75,8);
  expect(ride.width/ride.height).toBeCloseTo(60/64,8);
  expect(parked.physicalHeight/ride.physicalHeight).toBeCloseTo(.75,8);
 });
 test('ROI presentation feathers continuously while physical shadows retain the original world-size proxy',()=>{
  const frame={width:24,height:60},scale=2;
  const physical=actorDimensions({kind:'walk'},frame,scale);
  for(const amount of [0,.01,.05,.25,.5,.75,1]){
   const glyph=actorDimensions({kind:'walk'},frame,scale,{readable:true,viewWidth:394,amount});
   expect(glyph.height).toBeCloseTo(physical.height+(16-physical.height)*amount,8);
   expect(glyph.physicalHeight).toBe(physical.height);expect(glyph.physicalWidth).toBe(physical.width);
   expect(glyph.presentationScale).toBeGreaterThanOrEqual(1);expect(glyph.presentationScale).toBeLessThanOrEqual(2);
  }
 });
 test('presentation never shrinks, stays capped and leaves default world sizing exact',()=>{
  const frame={width:24,height:60};
  for(const scale of [.5,1.31,2.71,4,10]){
   const normal=actorDimensions({kind:'walk'},frame,scale);
   const disabled=actorDimensions({kind:'walk'},frame,scale,{readable:false,viewWidth:350});
   expect(normal.height).toBe(4.8*scale);expect(normal.width).toBe(4.8*scale*24/60);
   expect(disabled).toEqual(normal);
   const detail=actorDimensions({kind:'walk'},frame,scale,{readable:true,viewWidth:394});
   expect(detail.height).toBeGreaterThanOrEqual(normal.height);expect(detail.presentationScale).toBeLessThanOrEqual(2);
   if(normal.height>=16)expect(detail).toEqual(normal);
  }
  const capped=actorDimensions({kind:'walk'},frame,.5,{readable:true,viewWidth:350});
  expect(capped.presentationScale).toBe(2);expect(capped.height).toBe(4.8);
  const invalid=actorDimensions({kind:'walk'},frame,NaN,{readable:true,viewWidth:350});
  expect(invalid.height).toBe(0);expect(invalid.presentationScale).toBe(1);
 });
});
