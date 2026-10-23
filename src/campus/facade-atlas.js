import { facadeSurfaces } from './facade-surfaces.js';
import { MAP_WIDTH, MAP_HEIGHT } from './scene-data.js';

const RESOLUTION = 2;
function trace(context, polygon) {
  context.beginPath();
  polygon.forEach(([x,y],index) => index ? context.lineTo(x,y) : context.moveTo(x,y));
  context.closePath();
}
function canvas(width,height,left=0,top=0) {
  const image=document.createElement('canvas');
  image.width=Math.ceil(width*RESOLUTION);image.height=Math.ceil(height*RESOLUTION);
  const context=image.getContext('2d');
  context.scale(RESOLUTION,RESOLUTION);context.translate(-left,-top);
  return {image,context};
}
let cached;
/** Procedural light receivers, not map-image copies. Surface masks are registered
 * to visible wall planes rather than entire building silhouettes or roof grids.
 * Both map views reuse these CPU textures; each renderer owns its GPU upload.
 */
export function facadeArtwork() {
  if(cached)return cached;
  const mask=canvas(MAP_WIDTH,MAP_HEIGHT);
  const groups=new Map();
  for(const surface of facadeSurfaces){
    if(!groups.has(surface.buildingId))groups.set(surface.buildingId,[]);
    groups.get(surface.buildingId).push(surface);
    trace(mask.context,surface.polygon);mask.context.fillStyle='#fff';mask.context.fill();
  }
  const artwork=[];
  for(const [buildingId,surfaces] of groups){
    const points=surfaces.flatMap(surface=>surface.polygon);
    const left=Math.floor(Math.min(...points.map(p=>p[0])))-1,top=Math.floor(Math.min(...points.map(p=>p[1])))-1;
    const width=Math.ceil(Math.max(...points.map(p=>p[0])))-left+1;
    const height=Math.ceil(Math.max(...points.map(p=>p[1])))-top+1;
    const diffuse=canvas(width,height,left,top),emission=canvas(width,height,left,top);
    const windows=[];
    for(const surface of surfaces){
      const strength=surface.strength??.6;
      const ys=surface.polygon.map(p=>p[1]),minY=Math.min(...ys),maxY=Math.max(...ys);
      diffuse.context.save();trace(diffuse.context,surface.polygon);diffuse.context.clip();
      const bounce=diffuse.context.createLinearGradient(0,minY,0,maxY);
      bounce.addColorStop(0,`rgba(203,181,143,${.08*strength})`);
      bounce.addColorStop(.55,`rgba(245,185,101,${.32*strength})`);
      bounce.addColorStop(1,`rgba(255,192,106,${.65*strength})`);
      diffuse.context.fillStyle=bounce;diffuse.context.fillRect(left,top,width,height);
      emission.context.save();trace(emission.context,surface.polygon);emission.context.clip();
      for(const window of surface.windows??[]){
        if(window.lit===false)continue;
        const polygon=window.polygon;
        const center=polygon.reduce((p,v)=>[p[0]+v[0]/polygon.length,p[1]+v[1]/polygon.length],[0,0]);
        // Stable room exposure, independent of replay/camera. A facade is not
        // a uniform luminous grid: retain dim rooms alongside the unlit panes.
        const roomHash=[...(window.id??'room')].reduce((hash,char)=>(hash*31+char.charCodeAt(0))>>>0,0);
        const roomExposure=[.38,.58,.76,1,1][roomHash%5];
        const power=(window.strength??.7)*roomExposure;
        const radius=Math.max(2.3,Math.hypot(polygon[1][0]-polygon[0][0],polygon[1][1]-polygon[0][1])*2);
        const halo=diffuse.context.createRadialGradient(center[0],center[1],0,center[0],center[1],radius);
        halo.addColorStop(0,`rgba(255,181,81,${.22*power})`);
        halo.addColorStop(.6,`rgba(255,176,77,${.065*power})`);
        halo.addColorStop(1,'rgba(255,176,77,0)');
        diffuse.context.fillStyle=halo;diffuse.context.fillRect(center[0]-radius,center[1]-radius,radius*2,radius*2);
        trace(emission.context,polygon);
        emission.context.fillStyle=`rgba(255,210,145,${Math.min(.9,.14+.82*power)})`;
        emission.context.fill();
        windows.push({x:center[0],y:center[1]});
      }
      emission.context.restore();diffuse.context.restore();
    }
    artwork.push({buildingId,left,top,width,height,diffuse:diffuse.image,emission:emission.image,windows});
  }
  cached={groups:artwork,mask:mask.image,surfaceCount:facadeSurfaces.length};
  return cached;
}
