import { useEffect, useRef } from 'react';
import { buildings, facadeLights, lampPoints, pointInPolygon } from './spatial-scene';
import { campusLightLamps } from './campus-lighting-layout';
import { groundLightAtlas } from './lighting-field';
import { facadeArtwork } from './facade-atlas';
import { MAP_WIDTH, MAP_HEIGHT } from './scene-data';
import { withoutLibraryLight } from './library-baseline-mask';
import { lightingQualityProfile } from './lighting-quality.js';
import { useLightingQuality } from './lighting-quality-store.js';
import './night-lighting.css';

function traceBuilding(context, polygon, project) {
  polygon.forEach(([x, y], index) => {
    const point = project(x, y);
    if (index === 0) context.moveTo(point.left, point.top);
    else context.lineTo(point.left, point.top);
  });
  context.closePath();
}

function drawSurfaceLighting(context, project, scale, viewWidth, viewHeight, xray, selectedId, suppressLibrary) {
  const origin = project(0, 0);
  context.save();
  context.globalCompositeOperation = 'screen';
  const ground = groundLightAtlas();
  context.drawImage(suppressLibrary ? withoutLibraryLight(ground) : ground, origin.left, origin.top, MAP_WIDTH * scale, MAP_HEIGHT * scale);
  let windowCount = 0;
  for (const item of facadeArtwork().groups) {
    if(suppressLibrary && item.buildingId==='library-main')continue;
    const building=buildings.find(b=>b.id===item.buildingId);
    const opacity=xray&&building?.placeId===selectedId ? .25 : 1;
    context.globalAlpha=opacity;
    for(const image of [item.diffuse,item.emission])context.drawImage(image,
      origin.left+item.left*scale,origin.top+item.top*scale,item.width*scale,item.height*scale);
    windowCount+=item.windows.filter(light=>{const point=project(light.x,light.y);return point.left>=0&&point.left<=viewWidth&&point.top>=0&&point.top<=viewHeight;}).length;
  }
  context.restore();
  return windowCount;
}

/** Artistic lighting anchors, unrelated to the school's actual lighting state. */
export default function NightLighting({ project, scale, viewWidth, viewHeight, isDark = false,
  xray = false, selectedId = 'library', lighting = 'atmospheric', renderer = 'canvas-original', suppressLibrary = false,
}) {
  const canvasRef = useRef(null);
  const quality = useLightingQuality();
  const profile = lightingQualityProfile(quality);
  const textureRef = useRef(null);
  const requestRef = useRef(0);
  const drawRef = useRef(null);
  drawRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, profile.pixelRatioLimit);
    const width = Math.max(1, Math.round(viewWidth * dpr));
    const height = Math.max(1, Math.round(viewHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext('2d');
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, viewWidth, viewHeight);
    canvas.dataset.lampCount = '0';
    canvas.dataset.windowCount = '0';
    canvas.dataset.quality = profile.id;
    canvas.dataset.pixelRatio = String(dpr);
    canvas.dataset.surfaceMask = lighting === 'atmospheric' ? 'reviewed-paving-minus-buildings' : 'buildings-only';
    canvas.dataset.lightAtlas = lighting === 'atmospheric' ? '2048x1280-world' : 'viewport-original';
    canvas.dataset.surfaceWidths = lighting === 'atmospheric' ? 'artistic-bounded-corridors' : 'unbounded-pools';
    if (!isDark || !project) return;
    if (lighting === 'atmospheric') {
      const count=drawSurfaceLighting(context,project,scale,viewWidth,viewHeight,xray,selectedId,suppressLibrary);
      canvas.dataset.windowCount=String(count);
      canvas.dataset.lampCount=String([...lampPoints,...campusLightLamps].filter(lamp=>{ const point=project(lamp.x,lamp.y); return point.left>=-70*scale&&point.left<=viewWidth+70*scale&&point.top>=-30*scale&&point.top<=viewHeight+30*scale; }).length);
      return;
    }
    const texture = textureRef.current;
    if (!texture?.complete || !texture.naturalWidth) return;
    const enhanced = false;
    context.save();
    context.globalCompositeOperation = 'screen';
    // Ground light cannot spill onto the projected roofs or facades. Only the
    // generated glow texture is stretched into a pavement pool.
    context.save();
    let lampsDrawn = 0;
    for (const lamp of lampPoints) {
      const point = project(lamp.x, lamp.y);
      const strength = lamp.strength ?? .7;
      const poolWidth = (lamp.radius ? lamp.radius * 3.8 : enhanced ? 58 + 22 * strength : 46) * scale;
      const poolHeight = poolWidth * (enhanced ? .5 : .46);
      if (point.left < -poolWidth || point.left > viewWidth + poolWidth || point.top < -poolHeight || point.top > viewHeight + poolHeight) continue;
      context.save();
      context.translate(point.left, point.top);
      if (enhanced) context.rotate(18 * Math.PI / 180);
      // The same retained artwork supplies both the broad amber pavement wash
      // and the brighter source. No new fixture positions are inferred.
      context.globalAlpha = enhanced ? .66 + .2 * strength : .62 + .12 * strength;
      context.drawImage(texture, -poolWidth / 2, -poolHeight / 2, poolWidth, poolHeight);
      // A restrained wider entrance wash reuses the strongest existing lamp
      // anchors; it introduces no invented lighting position or geometry.
      if (strength >= .8) {
        const entranceWidth = poolWidth * 1.35;
        context.globalAlpha = enhanced ? .26 : .14;
        context.drawImage(texture, -entranceWidth / 2, -poolHeight * .65, entranceWidth, poolHeight * 1.3);
      }
      // Amber source cores avoid cold white pinpoints on the dark campus.
      context.globalAlpha = .92;
      const sourceSize = Math.max(6, (enhanced ? 13 : 10) * scale);
      context.drawImage(texture, -sourceSize / 2, -sourceSize / 2, sourceSize, sourceSize);
      context.globalAlpha = .9;
      context.fillStyle = '#ffd190';
      context.beginPath();
      context.arc(0, 0, Math.max(.7, .9 * scale), 0, Math.PI * 2);
      context.fill();
      context.restore();
      lampsDrawn += 1;
    }
    // Subtract each complete building silhouette. Unlike even-odd clipping,
    // overlapping polygons cannot reopen a patch of roof to ground lighting.
    context.globalCompositeOperation = 'destination-out';
    context.globalAlpha = 1;
    for (const building of buildings) {
      context.beginPath();
      traceBuilding(context, building.polygon, project);
      context.fill();
    }
    context.restore();
    let windowsDrawn = 0;
    // Facade anchors are deliberately sparse, checked against their own source
    // building polygon, and faded with that building when xray is selected.
    for (const building of buildings) {
      const windows = facadeLights.filter((light) => light.buildingId === building.id && pointInPolygon([light.x, light.y], building.polygon));
      if (!windows.length) continue;
      context.save();
      context.beginPath();
      traceBuilding(context, building.polygon, project);
      context.clip();
      const buildingOpacity = xray && building.placeId === selectedId ? .25 : 1;
      for (const light of windows) {
        const point = project(light.x, light.y);
        if (point.left < -10 || point.left > viewWidth + 10 || point.top < -10 || point.top > viewHeight + 10) continue;
        context.save();
        context.translate(point.left, point.top);
        context.rotate((light.angle ?? 18) * Math.PI / 180);
        const width = Math.max(.8, (light.width ?? 1.3) * scale) * (enhanced ? 1.12 : 1);
        const height = Math.max(.7, (light.height ?? 1.1) * scale) * (enhanced ? 1.12 : 1);
        const strength = (light.strength ?? .7) * buildingOpacity;
        context.globalAlpha = (enhanced ? .98 : .78) * strength;
        context.drawImage(texture, -width * 3.1, -height * 3, width * 6.2, height * 6);
        context.globalAlpha = Math.min(1, (enhanced ? 1.2 : .94) * strength);
        context.fillStyle = enhanced ? '#ffe0a3' : '#ffc779';
        context.fillRect(-width / 2, -height / 2, width, height);
        context.restore();
        windowsDrawn += 1;
      }
      context.restore();
    }
    context.restore();
    canvas.dataset.lampCount = String(lampsDrawn);
    canvas.dataset.windowCount = String(windowsDrawn);
  };
  const invalidate = () => {
    if (requestRef.current) cancelAnimationFrame(requestRef.current);
    requestRef.current = requestAnimationFrame(() => {
      requestRef.current = 0;
      drawRef.current?.();
    });
  };
  useEffect(() => {
    const texture = new Image();
    textureRef.current = texture;
    texture.onload = invalidate;
    texture.src = '/assets/light-glow.png';
    return () => {
      texture.onload = null;
      cancelAnimationFrame(requestRef.current);
    };
  }, []);
  // Project is affine in CampusMap. Compare its transform, not its function
  // identity, so an unrelated clock/selection render cannot redraw static light.
  const origin = project?.(0, 0);
  useEffect(invalidate, [origin?.left, origin?.top, scale, viewWidth, viewHeight, isDark, xray, selectedId, lighting, suppressLibrary, quality]);
  return <canvas ref={canvasRef} className="cp-night-lighting" aria-hidden="true"
    data-lighting="illustrative" data-lighting-mode={lighting} data-renderer={renderer} style={{ width: viewWidth, height: viewHeight }} />;
}
