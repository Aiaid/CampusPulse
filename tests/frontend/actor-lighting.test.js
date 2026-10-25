import {describe,test,expect,vi} from 'vitest';
import {actorLightMaterial,toneActorPixel,readableWalkAlbedo,actorSurfaceNormal,actorWorldNormal,actorSurfaceFacing,actorShadow,actorGroundShadows,blendActorLight,litActorFrame,actorLightingCacheStats} from '../../src/campus/actor-lighting.js';
import {libraryLights,screenToWorld,sampleLibraryLight} from '../../src/campus/library-lighting.js';
import {shadeSceneSurface} from '../../src/campus/surface-lighting.js';
import {surfaceCoverage} from '../../src/campus/lighting-field.js';
const energy=rgb=>rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;

describe('local light on synthetic actor materials',()=>{
 test('retains exact original and atmospheric RGB samples',()=>{
  const cases=[
   [{intensity:0,warmth:0},[12,56,168],[131,70,10]],
   [{intensity:.42,warmth:.8,direction:{x:1,y:0}},[25,75,192],[184,92,14]],
   [{intensity:1,warmth:1,direction:{x:1,y:0}},[42,100,217],[255,122,20]],
  ];
  for(const [sample,blue,orange] of cases){
   const material=actorLightMaterial(sample);
   expect(toneActorPixel([20,80,210],material,.7,.85)).toEqual(blue);
   expect(toneActorPixel([210,100,12],material,.7,.85)).toEqual(orange);
   const fillMetadata=actorLightMaterial({...sample,surfaceGroundDirection:{x:-1,y:0},surfaceElevation:.1});
   expect(fillMetadata.key).toBe(material.key);
   expect(toneActorPixel([20,80,210],fillMetadata,.7,.85)).toEqual(blue);
   const boundary=actorLightMaterial({...sample,surfaceShading:true,surfaceMix:0});
   expect(toneActorPixel([20,80,210],boundary,.7,.85)).toEqual(blue);
  }
 });
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

describe('readable detail walking albedo',()=>{
 const sourceBlue=[0,66,244];
 const options={kind:'walk',readable:true};
 const lightSample=raw=>({surfaceShading:true,intensity:1-Math.exp(-1.25*raw),warmth:1,
  directIrradiance:raw,indirectIrradiance:0,facadeIrradiance:0,
  surfaceGroundDirection:{x:1,y:0},surfaceElevation:.5,surfaceLightDirection:[.8,.2,.5]});
 test('the bounded royal-blue palette preserves dark seams, warm and white source detail',()=>{
  const lifted=readableWalkAlbedo(sourceBlue);
  expect(lifted[0]).toBe(0);expect(lifted[2]).toBe(244);
  expect(lifted[1]).toBeGreaterThanOrEqual(100);expect(lifted[1]).toBeLessThanOrEqual(110);
  expect(energy(lifted)).toBeGreaterThan(energy(sourceBlue));
  expect(sourceBlue).toEqual([0,66,244]);
  for(const rgb of [[0,0,0],[2,8,32],[225,110,14],[230,230,240],[100,190,250],[24,150,80]]){
   expect(readableWalkAlbedo(rgb)).toEqual(rgb);
  }
  for(const red of [0,40,160,255])for(const green of [0,66,108,200,255])for(const blue of [0,48,128,244,255]){
   const rgb=readableWalkAlbedo([red,green,blue]);
   expect(rgb[0]).toBe(red);expect(rgb[2]).toBe(blue);
   expect(rgb[1]).toBeGreaterThanOrEqual(green);expect(rgb[1]).toBeLessThanOrEqual(Math.min(255,green+42));
  }
 });
 test('eligible walking figures gain luminance through the same zero/warm-light shader',()=>{
  const normal=actorSurfaceNormal(.8,.2),facing=.8;
  for(const raw of [0,.18,.95,2.2]){
   const sample=lightSample(raw),ordinary=actorLightMaterial(sample),readable=actorLightMaterial(sample,options);
   expect(readable.readableWalk).toBe(true);expect(readable.key).not.toBe(ordinary.key);
   expect(readable.surfaceLight).toEqual(ordinary.surfaceLight);
   const rgb=toneActorPixel(sourceBlue,readable,1,facing,1,facing,normal);
   const expected=shadeSceneSurface(readableWalkAlbedo(sourceBlue),actorWorldNormal(normal),readable.surfaceLight,
    {facing:.55+.45*facing,ambientScale:1.2,roughness:.75,dielectricF0:.04});
   expect(rgb).toEqual(expected);
   expect(energy(rgb)).toBeGreaterThan(energy(toneActorPixel(sourceBlue,ordinary,1,facing,1,facing,normal)));
   expect(rgb[2]).toBeGreaterThan(rgb[1]);expect(rgb[1]).toBeGreaterThan(rgb[0]);
  }
  const dark=actorLightMaterial(lightSample(0),options),warm=actorLightMaterial(lightSample(.95),options);
  expect(toneActorPixel([0,0,0],dark)).toEqual([0,0,0]);
  expect(energy(toneActorPixel(sourceBlue,warm,0,1))).toBeGreaterThan(energy(toneActorPixel(sourceBlue,warm,0,0)));
  expect(energy(toneActorPixel(sourceBlue,warm,0,0))).toBeGreaterThan(energy(toneActorPixel(sourceBlue,dark,0,1)));
 });
 test('default, vehicle, legacy and ineligible material RGB/key remain exact',()=>{
  const sample=lightSample(.95),ordinary=actorLightMaterial(sample);
  for(const option of [{},{kind:'walk'},{kind:'walk',readable:false},{kind:'ride',readable:true},
   {kind:'parked',readable:true},{readable:true}]){
   const material=actorLightMaterial(sample,option);
   expect(material.key).toBe(ordinary.key);expect(material.readableWalk).toBe(false);
   for(const rgb of [sourceBlue,[210,100,12],[230,230,240]]){
    expect(toneActorPixel(rgb,material,.5,.8)).toEqual(toneActorPixel(rgb,ordinary,.5,.8));
   }
  }
  const legacySample={intensity:.6,warmth:1,direction:{x:1,y:0}};
  const legacy=actorLightMaterial(legacySample),requested=actorLightMaterial(legacySample,options);
  expect(requested.key).toBe(legacy.key);
  expect(toneActorPixel(sourceBlue,requested,.5,.8)).toEqual(toneActorPixel(sourceBlue,legacy,.5,.8));
  const readable=actorLightMaterial(sample,options);
  for(const rgb of [[210,100,12],[230,230,240],[2,8,32]]){
   expect(toneActorPixel(rgb,readable,.5,.8)).toEqual(toneActorPixel(rgb,ordinary,.5,.8));
  }
 });
 test('ROI applies the readable material once and retains the exact original endpoint',()=>{
  const previous={intensity:.2,warmth:.4,direction:{x:1,y:0}};
  const local={intensity:1-Math.exp(-1.25*.95),warmth:1,direction:{x:1,y:0}};
  const old=toneActorPixel(sourceBlue,actorLightMaterial(previous),.4,.8);
  const full=toneActorPixel(sourceBlue,actorLightMaterial({...local,surfaceShading:true},options),.4,.8);
  for(const mix of [0,.25,.5,.75,1]){
   const material=actorLightMaterial(blendActorLight(previous,local,mix),options);
   expect(toneActorPixel(sourceBlue,material,.4,.8)).toEqual(old.map((value,axis)=>Math.round(value*(1-mix)+full[axis]*mix)));
  }
  const zeroMix=actorLightMaterial({...local,surfaceShading:true,surfaceMix:0},options);
  expect(toneActorPixel(sourceBlue,zeroMix,.4,.8)).toEqual(toneActorPixel(sourceBlue,zeroMix.legacy,.4,.8));
 });
 test('profile variants preserve RGBA alpha, cache separately and stay inside shared cache bounds',()=>{
  const original=new Uint8ClampedArray([0,66,244,0,0,66,244,42,0,66,244,255,210,100,12,128]);
  vi.stubGlobal('document',{createElement:()=>{
   const canvas={width:0,height:0,pixels:null};
   canvas.getContext=()=>({drawImage:()=>{},getImageData:()=>({data:original}),
    createImageData:(width,height)=>({data:new Uint8ClampedArray(width*height*4)}),putImageData:data=>{canvas.pixels=data.data;}});
   return canvas;
  }});
  try{
   const image={src:'readable-cache-proof',naturalWidth:2,naturalHeight:2},frame={x:0,y:0,width:2,height:2};
   const material=actorLightMaterial(lightSample(.95),options);
   const readable=litActorFrame(image,frame,material),ordinary=litActorFrame(image,frame,actorLightMaterial(lightSample(.95)));
   expect(readable).not.toBe(ordinary);expect(litActorFrame(image,frame,material)).toBe(readable);
   expect([3,7,11,15].map(index=>readable.pixels[index])).toEqual([0,42,255,128]);
   expect(Array.from(readable.pixels.slice(12,16))).toEqual(Array.from(ordinary.pixels.slice(12,16)));
   const values=[0,.025,.07,.18,.42,.95,2.2,5.2],keys=new Set();
   for(let index=0;index<192;index++)for(const readable of [false,true]){
    const sample={...lightSample(.95),directIrradiance:values[index%8],
     indirectIrradiance:values[Math.floor(index/8)%8],facadeIrradiance:values[Math.floor(index/64)%8]};
    const variant=actorLightMaterial(sample,{kind:'walk',readable});keys.add(variant.key);
    litActorFrame(image,frame,variant);
   }
   const stats=actorLightingCacheStats();
   expect(keys.size).toBeGreaterThan(stats.maxVariants);
   expect(stats.variants).toBeLessThanOrEqual(stats.maxVariants);
   expect(stats.variantPixels).toBeLessThanOrEqual(stats.maxVariantPixels);
  }finally{vi.unstubAllGlobals();}
 });
});

describe('grounded actor ambient contact',()=>{
 test('broad fill retains foot contact without inventing a directional cast',()=>{
  const fill={intensity:1,directIntensity:0,facadeIntensity:.8,indirectIntensity:.2,groundDirection:{x:1,y:0}};
  const shadows=actorGroundShadows(fill,1.8,4.8);
  expect(shadows.cast).toBeNull();expect(shadows.contacts).toHaveLength(1);
  expect(shadows.contacts[0]).toMatchObject({x:0,y:0});
  expect(shadows.contacts[0].alpha).toBeGreaterThan(.15);expect(shadows.contacts[0].alpha).toBeLessThan(.3);
  expect(actorGroundShadows({...fill,intensity:0,groundDirection:{x:-1,y:0}},1.8,4.8).contacts).toEqual(shadows.contacts);
  expect(actorGroundShadows({...fill,directIntensity:.6,sourceHeight:9},1.8,4.8).cast).not.toBeNull();
 });
 test('AO footprint scales with the existing cropped world dimensions, independent of camera or light',()=>{
  const small=actorGroundShadows({},1.8,4.8).contacts[0];
  const large=actorGroundShadows({},3.6,9.6).contacts[0];
  expect(large.radiusX).toBeCloseTo(small.radiusX*2,8);expect(large.radiusY).toBeCloseTo(small.radiusY*2,8);
  expect(large.alpha).toBe(small.alpha);
  const faded=actorGroundShadows({},1.8,4.8,{blend:.5,coverage:.4}).contacts[0];
  expect(faded.alpha).toBeCloseTo(small.alpha*.2,8);
 });
 test('tyre contacts follow the wheel axis and meet the alpha-cropped lower tyre anchor',()=>{
  const contacts=actorGroundShadows({},5,4.8,{kind:'ride',heading:45}).contacts;
  expect(contacts).toHaveLength(2);
  expect(contacts[0].x).toBeLessThan(0);expect(contacts[1].x).toBeGreaterThan(0);
  expect(Math.max(...contacts.map(contact=>contact.y))).toBe(0);
  expect(contacts.every(contact=>contact.y<=0&&contact.radiusY<contact.radiusX)).toBe(true);
  const reversed=actorGroundShadows({},5,4.8,{kind:'ride',heading:225}).contacts;
  const footprint=list=>list.map(contact=>[+contact.x.toFixed(7),+contact.y.toFixed(7)]).sort((a,b)=>a[0]-b[0]);
  expect(footprint(contacts)).toEqual(footprint(reversed));
 });
 test('contacts require library blend and actual receiving ground, never an opened roof',()=>{
  const fill={intensity:1,directIntensity:0};
  expect(actorGroundShadows(fill,1.8,4.8,{coverage:surfaceCoverage([599,270])}).contacts).toHaveLength(1);
  for(const coverage of [0,surfaceCoverage([635,211]),NaN]){
   expect(actorGroundShadows(fill,1.8,4.8,{coverage})).toEqual({cast:null,contacts:[]});
  }
  expect(actorGroundShadows(fill,1.8,4.8,{blend:0})).toEqual({cast:null,contacts:[]});
  for(const dimensions of [[0,4.8],[1.8,Infinity],[NaN,4.8]]){
   expect(actorGroundShadows(fill,...dimensions)).toEqual({cast:null,contacts:[]});
  }
 });
});

describe('shared library actor surface and ground shadows',()=>{
 test('facade area reception changes material normals without changing the direct lamp shadow',()=>{
  const lamp={intensity:.2,directIntensity:.2,warmth:1,direction:{x:1,y:0},groundDirection:{x:1,y:0},
   elevation:.75,sourceHeight:9,sourceDistance:12,groundSourceDistance:12,surfaceShading:true};
  const filled={...lamp,intensity:.9,facadeIntensity:.7,surfaceGroundDirection:{x:-1,y:0},surfaceElevation:.25};
  const material=actorLightMaterial(filled);
  expect(material.direction.x).toBeCloseTo(-1,8);expect(material.elevation).toBe(.25);
  const left=actorSurfaceNormal(.15,.5),right=actorSurfaceNormal(.85,.5);
  const shaded=normal=>toneActorPixel([20,80,210],material,.3,actorSurfaceFacing(normal,material));
  expect(energy(shaded(left))).toBeGreaterThan(energy(shaded(right)));
  expect(actorShadow(filled,4.8)).toEqual(actorShadow(lamp,4.8));
  expect(actorShadow(filled,4.8).alpha).toBeCloseTo(.148,8);
  expect(actorShadow({...filled,directIntensity:0,intensity:1},4.8)).toBeNull();
 });
 test('ROI cross-fade mixes surface reception by total energy and shadow direction by direct energy',()=>{
  const previous={intensity:.5,warmth:.5,direction:{x:1,y:0},elevation:.6};
  const local={intensity:.3,directIntensity:.2,warmth:1,direction:{x:0,y:1},groundDirection:{x:0,y:1},
   surfaceGroundDirection:{x:-1,y:0},surfaceElevation:.25,sourceHeight:9,sourceDistance:12};
  const weak=blendActorLight(previous,local,.5);
  const strong=blendActorLight(previous,{...local,intensity:.9,facadeIntensity:.7},.5);
  expect(weak.surfaceGroundDirection.x).toBeCloseTo(1,8);
  expect(strong.surfaceGroundDirection.x).toBeCloseTo(-1,8);
  expect(strong.surfaceElevation).toBeCloseTo((.6*.25+.25*.45)/.7,8);
  expect(strong.groundDirection).toEqual(weak.groundDirection);
  expect(strong.directIntensity).toBeCloseTo(.35,8);
  expect(actorShadow(strong,4.8)).toEqual(actorShadow(weak,4.8));
  const start=blendActorLight(previous,local,0),end=blendActorLight(previous,local,1);
  expect(start.surfaceGroundDirection).toEqual(previous.direction);expect(start.surfaceElevation).toBe(.6);
  expect(end.surfaceGroundDirection).toEqual(local.surfaceGroundDirection);expect(end.surfaceElevation).toBe(.25);
  for(const amount of [0,.2,.5,.8,1]){
   const result=blendActorLight({intensity:0},{intensity:0,surfaceElevation:NaN},amount);
   expect(result.surfaceGroundDirection).toEqual({x:0,y:0});expect(result.surfaceElevation).toBe(0);
  }
 });
 test('shared raw light reveals source-facing material without an independent actor glow',()=>{
  const sample={intensity:.8,warmth:.8,direction:{x:1,y:0},surfaceShading:true};
  const material=actorLightMaterial(sample);
  const front=toneActorPixel([20,80,210],material,0,1);
  const back=toneActorPixel([20,80,210],material,0,0);
  expect(energy(front)).toBeGreaterThan(energy(back));
  expect(front[0]/front[2]).toBeGreaterThan(back[0]/back[2]);
  expect(toneActorPixel([20,80,210],material,1,1)).toEqual(front);
  const shadow=actorLightMaterial({...sample,intensity:0});
  const dark=toneActorPixel([20,80,210],shadow,0,1);
  expect(energy(dark)).toBeLessThan(energy(back));
  expect(dark[2]).toBeGreaterThan(dark[1]);expect(dark[1]).toBeGreaterThan(dark[0]);
  expect(dark).toEqual(toneActorPixel([20,80,210],shadow,1,0));
 });
 test('raw direct, bounce and facade energy use the shared shader and distinct cache entries',()=>{
  const previous={intensity:.2,warmth:0,direction:{x:0,y:1}};
  const local={intensity:.8,warmth:1,direction:{x:1,y:0},directIntensity:.55,indirectIntensity:.25,
   directIrradiance:.42,indirectIrradiance:.18,facadeIrradiance:.07};
  const result=blendActorLight(previous,local,1);
  expect(result.directIntensity).toBe(.55);expect(result.indirectIntensity).toBe(.25);
  const material=actorLightMaterial(result),normal=actorSurfaceNormal(.8,.1),facing=.8;
  expect(material.surfaceLight).toMatchObject({directIrradiance:.42,indirectIrradiance:.18,facadeIrradiance:.07});
  const expected=shadeSceneSurface([20,80,210],actorWorldNormal(normal),material.surfaceLight,{facing:.55+.45*facing,ambientScale:1.2,roughness:.75,dielectricF0:.04});
  expect(toneActorPixel([20,80,210],material,.5,facing,.5,facing,normal)).toEqual(expected);
  for(const name of ['directIrradiance','indirectIrradiance','facadeIrradiance']){
   const changed=actorLightMaterial({...result,[name]:.95});
   expect(changed.key).not.toBe(material.key);
   expect(changed.surfaceLight[name]).toBe(.95);
  }
  // Raw energy is authoritative even if a manual diagnostic supplies a
  // different already-compressed intensity; it is never tone-mapped twice.
  const compressed=actorLightMaterial({...result,intensity:1});
  expect(toneActorPixel([20,80,210],compressed,.5,facing,.5,facing,normal)).toEqual(expected);
 });
 test('manual intensity fallback inverts the field curve and ROI mixes final RGB outputs once',()=>{
  const previous={intensity:.2,warmth:.4,direction:{x:1,y:0}};
  const local={intensity:1-Math.exp(-1.25*.95),warmth:1,direction:{x:1,y:0}};
  const reference=actorLightMaterial({...local,surfaceShading:true});
  expect(reference.surfaceLight).toMatchObject({directIrradiance:.95,indirectIrradiance:0,facadeIrradiance:0});
  const old=toneActorPixel([20,80,210],actorLightMaterial(previous),.4,.8);
  const full=toneActorPixel([20,80,210],reference,.4,.8);
  for(const mix of [0,.25,.5,.75,1]){
   const blended=actorLightMaterial(blendActorLight(previous,local,mix));
   if(mix)expect(blended.surfaceLight).toEqual(reference.surfaceLight);
   expect(toneActorPixel([20,80,210],blended,.4,.8)).toEqual(old.map((value,axis)=>Math.round(value*(1-mix)+full[axis]*mix)));
  }
 });
 test('billboard head normals face world sky and preserve unit length',()=>{
  for(const u of [0,.5,1])for(const v of [0,.5,1]){
   const normal=actorSurfaceNormal(u,v),world=actorWorldNormal(normal);
   expect(Math.hypot(...world)).toBeCloseTo(1,8);
   expect(Math.sign(world[2])).toBe(Math.sign(normal.y));
  }
  const material=actorLightMaterial({intensity:0,surfaceShading:true});
  const top=actorSurfaceNormal(.5,0),bottom=actorSurfaceNormal(.5,1);
  expect(energy(toneActorPixel([100,100,100],material,0,0,0,0,top)))
   .toBeGreaterThan(energy(toneActorPixel([100,100,100],material,0,0,0,0,bottom)));
 });
 test('source-facing reception keeps blue and orange material identities with bounded RGB',()=>{
  for(const intensity of [0,.2,.5,.8,1])for(const facing of [0,.25,.5,1])for(const edge of [0,.4,1]){
   const material=actorLightMaterial({intensity,warmth:1,direction:{x:1,y:0},surfaceShading:true});
   const blue=toneActorPixel([20,80,210],material,edge,facing);
   const orange=toneActorPixel([210,100,12],material,edge,facing);
   expect(blue[2]).toBeGreaterThan(blue[1]);expect(blue[1]).toBeGreaterThan(blue[0]);
   expect(orange[0]).toBeGreaterThan(orange[1]);expect(orange[1]).toBeGreaterThan(orange[2]);
   for(const value of [...blue,...orange]){
    expect(Number.isInteger(value)).toBe(true);expect(value).toBeGreaterThanOrEqual(0);expect(value).toBeLessThanOrEqual(255);
   }
  }
 });
 test('capsule normals remain unit length and mirror without moving the artwork',()=>{
  for(const u of [0,.15,.5,.85,1])for(const v of [0,.1,.35,.7,.95,1]){
   const n=actorSurfaceNormal(u,v),mirror=actorSurfaceNormal(1-u,v);
   expect(Math.hypot(n.x,n.y,n.z)).toBeCloseTo(1,8);
   expect(n.x).toBeCloseTo(-mirror.x,8);expect(n.y).toBeCloseTo(mirror.y,8);expect(n.z).toBeCloseTo(mirror.z,8);
   expect(n.z).toBeGreaterThanOrEqual(0);
  }
 });
 test('the same blue material responds to a moving side source and overhead light',()=>{
  const right=actorLightMaterial({intensity:1,warmth:.8,direction:{x:1,y:0},surfaceShading:true,elevation:.5});
  const left=actorLightMaterial({intensity:1,warmth:.8,direction:{x:-1,y:0},surfaceShading:true,elevation:.5});
  const rightSide=actorSurfaceNormal(.85,.5),leftSide=actorSurfaceNormal(.15,.5),top=actorSurfaceNormal(.5,0);
  const shade=(normal,material)=>toneActorPixel([20,80,210],material,.4,actorSurfaceFacing(normal,material),.4,.5,normal);
  expect(energy(shade(rightSide,right))).toBeGreaterThan(energy(shade(leftSide,right)));
  expect(energy(shade(leftSide,left))).toBeGreaterThan(energy(shade(rightSide,left)));
  // The fixed scene viewer breaks exact mirror symmetry of dielectric
  // reflection; both illuminated sides must retain the blue material.
  const mirrored=shade(leftSide,left);expect(mirrored[2]).toBeGreaterThan(mirrored[1]);
  expect(actorSurfaceFacing(top,right)).toBeGreaterThan(actorSurfaceFacing(actorSurfaceNormal(.5,1),right));
  const blue=shade(rightSide,right);expect(blue[2]).toBeGreaterThan(blue[1]);expect(blue[1]).toBeGreaterThan(blue[0]);
 });
 test('actual shared world direction drives bounded rough-material variants without changing lamp shadows',()=>{
  const sample={intensity:.8,warmth:1,directIntensity:.3,directIrradiance:.42,facadeIrradiance:.42,
   surfaceShading:true,surfaceGroundDirection:{x:1,y:0},surfaceElevation:.5,
   groundDirection:{x:1,y:0},sourceHeight:9,sourceDistance:12};
  const front=actorLightMaterial({...sample,surfaceLightDirection:[.545,.839,.5]});
  const back=actorLightMaterial({...sample,surfaceLightDirection:[-.545,-.839,.5]});
  expect(front.key).not.toBe(back.key);
  expect(toneActorPixel([20,80,210],front,0,.8)).not.toEqual(toneActorPixel([20,80,210],back,0,.8));
  expect(actorShadow({...sample,surfaceLightDirection:[.545,.839,.5]},4.8))
   .toEqual(actorShadow({...sample,surfaceLightDirection:[-.545,-.839,.5]},4.8));
  const keys=new Set();
  for(let vertical=-4;vertical<=4;vertical++)for(let angle=0;angle<64;angle++){
   const z=vertical/4,h=Math.sqrt(1-z*z),a=angle*Math.PI/32;
   const material=actorLightMaterial({...sample,surfaceLightDirection:[Math.cos(a)*h,Math.sin(a)*h,z]});
   keys.add(material.key);
   expect(Math.hypot(...material.surfaceLight.surfaceLightDirection)).toBeCloseTo(1,8);
  }
  expect(keys.size).toBeLessThanOrEqual(72);expect(keys.size).toBeGreaterThan(10);
  const zero=actorLightMaterial({...sample,surfaceLightDirection:[0,0,0]});
  expect(zero.surfaceLight.surfaceLightDirection).toEqual([0,0,0]);
 });
 test('cross-fade preserves both incident endpoints and finite bounded transition energy',()=>{
  const old={intensity:.2,warmth:.2,direction:{x:-1,y:0}};
  const local={intensity:.8,warmth:1,direction:{x:1,y:0},sourceHeight:10};
  expect(blendActorLight(old,local,0).intensity).toBe(.2);
  expect(blendActorLight(old,local,0).direction).toEqual(old.direction);
  expect(blendActorLight(old,local,1).intensity).toBe(.8);
  expect(blendActorLight(old,local,1).direction).toEqual(local.direction);
  for(let blend=0;blend<=1;blend+=.05){
   const result=blendActorLight(old,local,blend);
   expect(result.intensity).toBeGreaterThanOrEqual(.2);expect(result.intensity).toBeLessThanOrEqual(.8);
   expect(Number.isFinite(result.direction.x)).toBe(true);expect(Number.isFinite(result.warmth)).toBe(true);
  }
 });
 test('cast shadows point away from the shared source and shorten as it rises',()=>{
  const low=actorShadow({intensity:.7,direction:{x:.6,y:.8},sourceHeight:10,sourceDistance:12},4.8);
  const high=actorShadow({intensity:.7,direction:{x:.6,y:.8},sourceHeight:20,sourceDistance:12},4.8);
  expect(low.x*.6+low.y*.8).toBeLessThan(0);
  expect(high.length).toBeLessThan(low.length);
  expect(Math.hypot(low.x,low.y)).toBeCloseTo(low.length,8);
  expect(actorShadow({intensity:0,direction:{x:1,y:0}},4.8)).toBeNull();
  expect(actorShadow({intensity:1,direction:{x:0,y:0}},4.8)).toBeNull();
 });
 test('an elevated front fixture lights the actor front and casts behind its ground anchor',()=>{
  const light=libraryLights.find(light=>light.id==='library-west-walk');
  expect(light.ground).toEqual({x:581,y:269});
  const torso=screenToWorld(581,267);torso[2]=1.8;
  const sample=sampleLibraryLight(torso,[0,0,1],{upright:true,lights:[light],occlusion:false});
  // Projection lifts the visible fixture above the torso, but the light is
  // still in front on the ground. Its height must not reverse front/back.
  expect(sample.direction.y).toBeLessThan(0);
  const material=actorLightMaterial({...sample,surfaceShading:true});
  expect(actorSurfaceFacing(actorSurfaceNormal(.5,.5),material)).toBeGreaterThan(.5);
  expect(actorShadow(sample,4.8).y).toBeLessThan(0);
 });
 test('normal shading preserves transparent and antialiased silhouette pixels exactly',()=>{
  const original=new Uint8ClampedArray([20,80,210,0,20,80,210,42,20,80,210,255,210,100,12,128]);
  vi.stubGlobal('document',{createElement:()=>{
   const canvas={width:0,height:0,pixels:null};
   canvas.getContext=()=>({drawImage:()=>{},getImageData:()=>({data:original}),
    createImageData:(width,height)=>({data:new Uint8ClampedArray(width*height*4)}),putImageData:data=>{canvas.pixels=data.data;}});
   return canvas;
  }});
  try{
   const frame=litActorFrame({src:'normal-alpha-proof',naturalWidth:2,naturalHeight:2},{x:0,y:0,width:2,height:2},actorLightMaterial({intensity:1,warmth:1,direction:{x:1,y:0},surfaceShading:true}));
   expect(frame.width).toBe(2);expect(frame.height).toBe(2);
   expect([3,7,11,15].map(i=>frame.pixels[i])).toEqual([0,42,255,128]);
  }finally{vi.unstubAllGlobals();}
 });
});
