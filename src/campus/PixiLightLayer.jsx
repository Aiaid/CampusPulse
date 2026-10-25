import { useEffect, useRef } from 'react';
import { Application, BlurFilter, CanvasSource, Container, Rectangle, Sprite, Texture } from 'pixi.js';
import { AdvancedBloomFilter } from 'pixi-filters/advanced-bloom';
import { buildings, lampPoints } from './spatial-scene';
import { campusLightLamps } from './campus-lighting-layout';
import { facadeArtwork } from './facade-atlas';
import { groundLightAtlas, groundSurfaceMask, lampSurfaceFrame } from './lighting-field';
import { MAP_HEIGHT, MAP_WIDTH } from './scene-data';
import { libraryBlend } from './library-lighting';
import { withoutLibraryLight } from './library-baseline-mask';
import { lightingQualityProfile } from './lighting-quality.js';
import { useLightingQuality } from './lighting-quality-store.js';
import './night-lighting.css';

const sceneLamps = [...lampPoints, ...campusLightLamps];

function localTexture(canvas, resolution = 1) {
  // Each mounted map owns its GPU source. Shared CPU atlases remain reusable
  // when an independent detail pane is opened or destroyed.
  return new Texture({ source: new CanvasSource({ resource: canvas, resolution, autoDensity: false }) });
}
function radialCanvas() {
  const canvas = document.createElement('canvas'); canvas.width=64;canvas.height=64;
  const context=canvas.getContext('2d');
  const gradient=context.createRadialGradient(32,32,0,32,32,32);
  gradient.addColorStop(0,'rgba(255,255,255,1)');
  gradient.addColorStop(.18,'rgba(255,255,255,.72)');
  gradient.addColorStop(.5,'rgba(255,255,255,.17)');
  gradient.addColorStop(1,'rgba(255,255,255,0)');
  context.fillStyle=gradient;context.fillRect(0,0,64,64);return canvas;
}
function worldSprite(texture) {
  const sprite=new Sprite(texture);sprite.width=MAP_WIDTH;sprite.height=MAP_HEIGHT;return sprite;
}
function glow(texture,x,y,width,height,alpha,color=0xffcc88,angle=0){
  const sprite=new Sprite({texture,anchor:.5,x,y,alpha,tint:color,rotation:angle});
  sprite.width=width;sprite.height=height;return sprite;
}

function releaseTransientBindings(filters){
  // Pixi's filter pool is shared by independent renderers. Do not pin a pooled
  // target between frames: resizing either map may legitimately reclaim it.
  for(const filter of filters){
    const inputs=filter.groups?.[0];
    if(inputs){
      inputs.setResource(Texture.EMPTY.source,1);
      inputs.setResource(Texture.EMPTY.source.style,2);
      if(inputs.getResource(3))inputs.setResource(Texture.EMPTY.source,3);
    }
    if(filter instanceof AdvancedBloomFilter && filter.resources){
      filter.resources.uMapTexture=Texture.EMPTY.source;
    }
  }
}

/** Transparent, on-demand GPU light overlay. It never reads or fetches GIS pixels. */
export default function PixiLightLayer({ project,scale,viewWidth,viewHeight,isDark=false,
  xray=false,selectedId='library',lighting='atmospheric',onFailure,suppressLibrary=false,
}){
  const hostRef=useRef(null);
  const quality=useLightingQuality();
  const runtimeRef=useRef(null);
  const current=useRef(null);
  current.current={project,scale,viewWidth,viewHeight,isDark,xray,selectedId,lighting,onFailure,suppressLibrary,quality};
  const origin=project?.(0,0);

  useEffect(()=>{
    const host=hostRef.current;
    let cancelled=false,initialized=false,destroyed=false,frame=0,runtime=null;
    const app=new Application();
    const textures=[],filters=[],effects=[];
    let canvas=null;
    const contextLost=event=>{
      event.preventDefault();
      if(!cancelled)current.current.onFailure?.(new Error('WebGL lighting context lost'));
    };
    const dispose=()=>{
      if(destroyed)return;destroyed=true;
      cancelAnimationFrame(frame);canvas?.removeEventListener('webglcontextlost',contextLost);
      // Stage sprites do not own shared Texture.WHITE or our explicitly tracked
      // textures. Destroy each local GPU allocation exactly once below.
      for(const node of effects){node.mask=null;node.filters=[];}
      // The renderer shares filter input bind groups. Rebind temporary inputs
      // before screen removal prunes the library's pooled render textures.
      releaseTransientBindings(filters);
      // Detach filter bind groups before the renderer frees its temporary
      // render textures. Otherwise the library detects still-bound resources.
      filters.forEach(filter=>{
        // Filters 6.1.x owns these two child shaders but its inherited destroy
        // only releases the parent shader. Release the children as well.
        if(filter instanceof AdvancedBloomFilter){
          filter._extractFilter?.destroy();
          filter._blurFilter?.destroy();
        }
        if(filter instanceof BlurFilter){
          filter.blurXFilter?.destroy();
          filter.blurYFilter?.destroy();
        }
        filter.destroy();
      });
      // Pixi 8.22's FilterSystem.destroy does not release this shared group
      // before ViewSystem removes pooled screen textures. Detach its listeners
      // here; this application will never render again after disposal.
      app.renderer?.filter?._globalFilterBindGroup?.destroy();
      if(initialized)app.destroy({removeView:true},{children:true,texture:false,textureSource:false});
      textures.forEach(texture=>texture.destroy(true));
      // StrictMode can finish a cancelled async initialization after its
      // replacement has mounted. That older renderer must not clear the new
      // renderer's invalidate callback, or lights freeze at the old camera.
      if(runtimeRef.current===runtime)runtimeRef.current=null;
    };
    const fail=error=>{
      if(!cancelled)current.current.onFailure?.(error instanceof Error?error:new Error(String(error)));
    };
    const initialize=async()=>{
      try{
        if(cancelled||!host?.isConnected)return;
        await app.init({
          preference:'webgl',backgroundAlpha:0,autoStart:false,sharedTicker:false,
          width:Math.max(1,current.current.viewWidth),height:Math.max(1,current.current.viewHeight),
          resolution:Math.min(window.devicePixelRatio||1,1.5,lightingQualityProfile(current.current.quality).pixelRatioLimit),autoDensity:true,
          antialias:false,powerPreference:'low-power',eventMode:'none',
          eventFeatures:{move:false,globalMove:false,click:false,wheel:false},
          preserveDrawingBuffer:false,
        });
        initialized=true;
        if(cancelled||!host.isConnected){dispose();return;}
        app.stop();app.stage.eventMode='none';app.stage.interactiveChildren=false;
        canvas=app.canvas;canvas.className='cp-night-lighting';canvas.setAttribute('aria-hidden','true');
        canvas.style.pointerEvents='none';canvas.addEventListener('webglcontextlost',contextLost);
        Object.assign(canvas.dataset,{
          lighting:'illustrative',renderer:'pixi-webgl',filters:'AdvancedBloomFilter+BlurFilter',
          filterQuality:'3',surfaceMask:'reviewed-paving-minus-buildings',
          surfaceWidths:'artistic-bounded-corridors',lightAtlas:'2048x1280-world',
          renderLoop:'on-demand',renderFrame:'0',
        });host.appendChild(canvas);
        const world=new Container({eventMode:'none'});app.stage.addChild(world);
        const atlasTexture=localTexture(groundLightAtlas(),2);
        const maskTexture=localTexture(groundSurfaceMask(),2);
        const localAtlasTexture=localTexture(withoutLibraryLight(groundLightAtlas()),2);
        const localMaskTexture=localTexture(withoutLibraryLight(groundSurfaceMask()),2);
        const radialTexture=localTexture(radialCanvas());
        const artwork=facadeArtwork();
        const facadeTexture=localTexture(artwork.mask,2);
        textures.push(atlasTexture,maskTexture,localAtlasTexture,localMaskTexture,radialTexture,facadeTexture);
        const groundClip=new Container({eventMode:'none'});
        // This CPU atlas is already surface-masked. Apply that alpha once;
        // only the new GPU emission needs an additional post-filter mask.
        const diffuse=worldSprite(atlasTexture);diffuse.alpha=1;
        const emission=new Container({eventMode:'none'});
        groundClip.addChild(emission);world.addChild(diffuse,groundClip);
        effects.push(groundClip,emission);
        const surfaceMask=worldSprite(maskTexture);world.addChild(surfaceMask);
        groundClip.setMask({mask:surfaceMask,channel:'alpha'});
        // A Gaussian prefilter softens emission, then real thresholded Kawase
        // bloom supplies restrained optical spread. The OUTER surface mask is
        // evaluated after this chain, preventing spill onto buildings or lawns.
        const groundBlur=new BlurFilter({strength:.4,quality:2,resolution:1});
        const groundBloom=new AdvancedBloomFilter({threshold:.14,bloomScale:.42,brightness:1,blur:3,quality:3});
        groundBloom.resolution=1;filters.push(groundBlur,groundBloom);emission.filters=[groundBlur,groundBloom];
        const lampGroups=[];
        for(const lamp of sceneLamps){
          const group=new Container({eventMode:'none'});emission.addChild(group);
          lampGroups.push({lamp,group});
          const strength=lamp.strength??.7,frame=Number.isFinite(lamp.angle)?{angle:lamp.angle,kind:'paving'}:lampSurfaceFrame(lamp);
          group.addChild(glow(radialTexture,lamp.x,lamp.y,frame.kind==='local'?9:24,frame.kind==='local'?5:7,.3*strength,0xffc27d,frame.angle));
          group.addChild(glow(radialTexture,lamp.x,lamp.y,3.5,2.2,.88*strength,0xffdba3,frame.angle));
          group.addChild(glow(radialTexture,lamp.x,lamp.y,1.1,.75,.94,0xffe1b0,frame.angle));
        }
        const facadeClip=new Container({eventMode:'none'}),windowEmission=new Container({eventMode:'none'});
        effects.push(facadeClip,windowEmission);
        facadeClip.addChild(windowEmission);world.addChild(facadeClip);
        const facadeMask=worldSprite(facadeTexture);world.addChild(facadeMask);
        facadeClip.setMask({mask:facadeMask,channel:'alpha'});
        const windowBloom=new AdvancedBloomFilter({threshold:.26,bloomScale:.28,brightness:1,blur:1.3,quality:3});
        windowBloom.resolution=1;filters.push(windowBloom);windowEmission.filters=[windowBloom];
        const windowGroups=[];
        for(const item of artwork.groups){
          const building=buildings.find(b=>b.id===item.buildingId);
          if(!building)continue;
          const group=new Container({eventMode:'none'}),lightGroup=new Container({eventMode:'none'});
          world.addChild(group);windowEmission.addChild(lightGroup);
          const wallTexture=localTexture(item.diffuse,2),coreTexture=localTexture(item.emission,2);
          textures.push(wallTexture,coreTexture);
          const wall=new Sprite({texture:wallTexture,x:item.left,y:item.top});
          const core=new Sprite({texture:coreTexture,x:item.left,y:item.top});
          wall.width=core.width=item.width;wall.height=core.height=item.height;
          group.addChild(wall);lightGroup.addChild(core);
          windowGroups.push({building,group,lightGroup,lights:item.windows});
        }
        canvas.dataset.facadeSurfaceCount=String(artwork.surfaceCount);
        canvas.dataset.facadeRegistration='visible-wall-planes';
        let renderFrame=0;
        const render=()=>{
          frame=0;if(cancelled||destroyed)return;
          try{
            const props=current.current;
            const width=Math.max(1,props.viewWidth),height=Math.max(1,props.viewHeight);
            const profile=lightingQualityProfile(props.quality);
            const resolution=Math.min(window.devicePixelRatio||1,1.5,profile.pixelRatioLimit);
            if(app.screen.width!==width||app.screen.height!==height||app.renderer.resolution!==resolution)app.renderer.resize(width,height,resolution);
            canvas.style.width=`${width}px`;canvas.style.height=`${height}px`;
            const point=props.project?.(0,0)??{left:0,top:0};
            world.position.set(point.left,point.top);world.scale.set(props.scale);
            world.visible=props.isDark&&props.lighting==='atmospheric';
            diffuse.texture=props.suppressLibrary?localAtlasTexture:atlasTexture;
            surfaceMask.texture=props.suppressLibrary?localMaskTexture:maskTexture;
            for(const {lamp,group} of lampGroups)group.visible=!props.suppressLibrary||libraryBlend(lamp.x,lamp.y)===0;
            // Pixi filterArea is in viewport/screen coordinates, never scaled
            // world coordinates. It bounds intermediate render textures.
            const viewport=new Rectangle(0,0,width,height);
            emission.filterArea=viewport;windowEmission.filterArea=viewport;
            groundClip.filterArea=viewport;facadeClip.filterArea=viewport;
            groundBloom.blur=Math.min(4,Math.max(1.7,props.scale*1.1));
            windowBloom.blur=Math.min(3,Math.max(1.2,props.scale*.7));
            for(const {building,group,lightGroup} of windowGroups){
              group.visible=lightGroup.visible=!(props.suppressLibrary&&building.id==='library-main');
              group.alpha=lightGroup.alpha=props.xray&&building.placeId===props.selectedId ? .25 : 1;
            }
            const visible=({x,y},padding)=>{const p=props.project(x,y);return p.left>=-padding&&p.left<=width+padding&&p.top>=-padding&&p.top<=height+padding;};
            canvas.dataset.lightingMode=props.lighting;
            canvas.dataset.quality=profile.id;
            canvas.dataset.pixelRatio=String(resolution);
            canvas.dataset.librarySuppressed=String(props.suppressLibrary);
            canvas.dataset.worldX=String(point.left);
            canvas.dataset.worldY=String(point.top);
            canvas.dataset.worldScale=String(props.scale);
            canvas.dataset.lampCount=world.visible?String(lampGroups.filter(({lamp,group})=>group.visible&&visible(lamp,45*props.scale)).length):'0';
            canvas.dataset.windowCount=world.visible?String(windowGroups.reduce((count,{lights,group})=>count+(group.visible?lights.filter(light=>visible(light,10*props.scale)).length:0),0)):'0';
            canvas.dataset.renderFrame=String(++renderFrame);
            canvas.dataset.tickerRunning=String(app.ticker.started);
            app.render();
            releaseTransientBindings(filters);
          }catch(error){fail(error);}
        };
        const invalidate=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(render);};
        runtime={invalidate};runtimeRef.current=runtime;invalidate();
      }catch(error){
        // init can reject before the renderer exists. Only destroy an initialized
        // application; otherwise disposal follows its successful async resolve.
        if(initialized)dispose();
        fail(error);
      }
    };
    initialize();
    return()=>{cancelled=true;cancelAnimationFrame(frame);if(initialized)dispose();};
  },[]);
  useEffect(()=>{runtimeRef.current?.invalidate();},[origin?.left,origin?.top,scale,viewWidth,viewHeight,isDark,xray,selectedId,lighting,suppressLibrary,quality]);
  return <div ref={hostRef} className="cp-pixi-light-host" aria-hidden="true" />;
}
