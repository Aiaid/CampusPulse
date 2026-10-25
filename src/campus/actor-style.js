// Visual reference sizes in the retained 1024x640 map coordinate system.
// These are illustration proportions, not metres or a geographic calibration.
export const ACTOR_WORLD_HEIGHT = Object.freeze({walk:4.8,riding:4.8,parked:3.6});

/** Tight per-direction alpha bounds prevent transparent padding changing size
 * or lifting feet/tyres off a route. The original sprite files remain intact.
 */
export function alphaFrames({data,width,height}, threshold=32) {
  const frames=[];
  for(let row=0;row<2;row++)for(let column=0;column<2;column++){
    const x0=Math.floor(column*width/2),x1=Math.floor((column+1)*width/2);
    const y0=Math.floor(row*height/2),y1=Math.floor((row+1)*height/2);
    let left=x1,top=y1,right=-1,bottom=-1;
    for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){
      if(data[(y*width+x)*4+3]>threshold){
        left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);
      }
    }
    if(right<left){frames.push({x:x0,y:y0,width:x1-x0,height:y1-y0,empty:true});continue;}
    // Keep one antialias pixel, without bleeding into an adjacent direction cell.
    left=Math.max(x0,left-1);top=Math.max(y0,top-1);
    right=Math.min(x1-1,right+1);bottom=Math.min(y1-1,bottom+1);
    frames.push({x:left,y:top,width:right-left+1,height:bottom-top+1,empty:false});
  }
  return frames;
}

/** Optional detail glyph sizing is cartographic presentation, not a change to
 * world height. One factor preserves people/vehicle proportions and footprint
 * anchors; the physical dimensions remain available to the light/shadow model.
 */
export function actorDimensions(actor,frame,mapScale,{readable=false,viewWidth,amount=1}={}){
  const kind=actor.kind==='walk'?'walk':actor.parked?'parked':'riding';
  const scale=Number.isFinite(mapScale)&&mapScale>0?mapScale:0;
  const physicalHeight=ACTOR_WORLD_HEIGHT[kind]*scale;
  const physicalWidth=physicalHeight*frame.width/frame.height;
  const target=Number.isFinite(viewWidth)&&viewWidth<380?13:16;
  const mix=Number.isFinite(amount)?Math.max(0,Math.min(1,amount)):0;
  const fullScale=readable&&scale>0?Math.max(1,Math.min(2,target/(ACTOR_WORLD_HEIGHT.walk*scale))):1;
  const presentationScale=1+(fullScale-1)*mix;
  return {width:physicalWidth*presentationScale,height:physicalHeight*presentationScale,
    physicalWidth,physicalHeight,presentationScale};
}

const frameCache=new Map();
export function imageFrames(image){
  const key=image.currentSrc||image.src;
  if(frameCache.has(key))return frameCache.get(key);
  const canvas=document.createElement('canvas');
  canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
  const context=canvas.getContext('2d',{willReadFrequently:true});
  if(!context)return null;
  context.drawImage(image,0,0);
  const frames=alphaFrames(context.getImageData(0,0,canvas.width,canvas.height));
  frameCache.set(key,frames);
  return frames;
}
