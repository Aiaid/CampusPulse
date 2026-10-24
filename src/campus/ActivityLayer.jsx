import { useEffect, useRef } from 'react';
import { getMetrics } from './scene-data';
import { routes, parkingAreas, buildings, sampleRoute, classifyOcclusion } from './spatial-scene';
import './activity-layer.css';
import { ACTOR_WORLD_HEIGHT, actorDimensions, imageFrames } from './actor-style';
import { sampleLocalLight, surfaceCoverage } from './lighting-field';
import { actorLightMaterial, litActorFrame, actorLightingCacheStats, blendActorLight, actorGroundShadows } from './actor-lighting';
import { libraryBlend, sampleLibraryActor, libraryTrees, treeOpacityAt } from './library-lighting';
import { treeMaterialState, subscribeTreeMaterial } from './tree-material';
import { campusDemoRoutes } from './campus-scene-data';
import { sampleCampusActor } from './campus-scene-lighting';
import { campusCrownMasks, drawCampusCrownMasks, drawNativeCanopyMasks } from './campus-tree-masks';
import { getCampusNativeCanopyMasks, subscribeCampusNativeCanopy } from './CampusLightingLayer';
import { createActorLightSampler, createRenderCache } from './render-cache';

const actorDefinitions = createRenderCache(8);
const actorOcclusion = createRenderCache(200);
const actorCoverage = createRenderCache(200);
const actorLightSamples = createActorLightSampler({ sampleLocal: sampleLocalLight,
  sampleLibrary: sampleLibraryActor, sampleCampus: sampleCampusActor, blend: blendActorLight });

const EPOCH = typeof performance === 'undefined' ? 0 : performance.now();
// Every mounted map reads this one clock, including panes opened later. Root
// supplies the same playback flag to both panes, so pausing freezes one scene.
const sceneClock = { seconds: 0, previous: EPOCH, running: true };
function sceneTime(now, running) {
  if (sceneClock.running) sceneClock.seconds += Math.max(0, now - sceneClock.previous) / 1000;
  sceneClock.previous = now;
  sceneClock.running = running;
  return sceneClock.seconds;
}
const MAX_ACTORS = 200;
const sceneRoutes = [...routes, ...campusDemoRoutes];
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const normalizedHeading = (heading) => ((heading % 360) + 360) % 360;
// Sheet cells: NE, NW / SE, SW. The object stays upright; its view changes.
function directionCell(heading) {
  const angle = normalizedHeading(heading);
  return angle < 90 ? [0, 1] : angle < 180 ? [1, 1] : angle < 270 ? [1, 0] : [0, 0];
}
function pathLength(route) {
  return route.points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point[0] - route.points[index][0], point[1] - route.points[index][1]), 0);
}
function isClosed(route) {
  const first = route.points[0];
  const last = route.points.at(-1);
  return route.closed || Math.hypot(first[0] - last[0], first[1] - last[1]) < .1;
}
function actorPosition(actor, elapsed) {
  if (actor.parked) return actor;
  const distance = (elapsed * actor.speed + actor.phase * actor.length) / actor.length;
  const cycle = ((distance % 2) + 2) % 2;
  const closed = isClosed(actor.route);
  const returning = !closed && cycle > 1;
  const progress = closed ? distance % 1 : returning ? 2 - cycle : cycle;
  const position = sampleRoute(actor.route, progress);
  return { ...actor, ...position, heading: position.heading + (returning ? 180 : 0) };
}
function makeActors(minute, layers, scenarioId) {
  const result = [];
  // Stable IDs and phase keep the same actors in place as density changes.
  for (const route of sceneRoutes) {
    if (route.points.length < 2 || !layers[route.kind === 'walk' ? 'people' : 'bikes']) continue;
    const metrics = getMetrics(route.placeId, minute, scenarioId);
    // Higher peak pedestrian density follows the selected concept in EVERY
    // lighting mode. It is illustrative activity, never a field people count.
    const count = route.kind === 'walk' ? clamp(Math.round(metrics.people / 10), 1, 10) : clamp(Math.round(metrics.bikes / 24), 1, 4);
    const length = Math.max(pathLength(route), 1);
    for (let index = 0; index < count; index += 1) {
      result.push({ id: `${route.id}-${index}`, route, length, kind: route.kind, parked: false,
        phase: (index * .381966 + sceneRoutes.indexOf(route) * .173) % 1,
        speed: route.kind === 'walk' ? .95 + index * .07 : 2.6 + index * .18 });
    }
  }
  // A parking sprite contains no rider and never participates in motion.
  if (layers.bikes) for (const area of parkingAreas) {
    const metrics = getMetrics(area.placeId, minute, scenarioId);
    const occupied = Math.round(area.slots.length * metrics.parking / 100);
    for (const [index, slot] of area.slots.slice(0, occupied).entries()) {
      result.push({ id: `${area.id}-parked-${index}`, kind: 'ride', parked: true, ...slot });
    }
  }
  // The extended chart has fewer than 200 actors even at peak density; every
  // place retains its route allocation and fixed parking comes after no cutoff.
  return result.slice(0, MAX_ACTORS);
}
function loadImage(src, redraw) {
  const image = new Image();
  image.onload = redraw;
  image.src = src;
  return image;
}

// Each exact tree-depth band gets one small, reusable map-space alpha mask.
// Moving actors never require raster/GIS reads or a per-frame pixel operation.
const treeDepthMasks = new Map();
let treeDepthRevision = -1;
function treeMaskBehind(groundY) {
  const revision = treeMaterialState().revision;
  if (revision !== treeDepthRevision) {
    treeDepthMasks.clear();
    treeDepthRevision = revision;
  }
  const foreground = libraryTrees.filter(tree => groundY < tree.base.y);
  if (!foreground.length) return null;
  const key = foreground.map(tree => tree.id).join('|');
  if (treeDepthMasks.has(key)) return treeDepthMasks.get(key);
  const left = Math.floor(Math.min(...foreground.map(tree => tree.screenBounds.left)) - 1);
  const top = Math.floor(Math.min(...foreground.map(tree => tree.screenBounds.top)) - 1);
  const right = Math.ceil(Math.max(...foreground.map(tree => tree.screenBounds.left + tree.screenBounds.width)) + 1);
  const bottom = Math.ceil(Math.max(...foreground.map(tree => tree.screenBounds.top + tree.screenBounds.height)) + 1);
  const resolution = 3, mask = document.createElement('canvas');
  mask.width = Math.max(1, (right - left) * resolution); mask.height = Math.max(1, (bottom - top) * resolution);
  const context = mask.getContext('2d');
  if (!context) return null;
  const pixels = context.createImageData(mask.width, mask.height);
  for (let y = 0; y < mask.height; y += 1) for (let x = 0; x < mask.width; x += 1) {
    pixels.data[(y * mask.width + x) * 4 + 3] = Math.round(255 * treeOpacityAt(left + (x + .5) / resolution, top + (y + .5) / resolution, groundY));
  }
  context.putImageData(pixels, 0, 0);
  const entry = { canvas: mask, left, top, width: right - left, height: bottom - top, trees: foreground };
  treeDepthMasks.set(key, entry);
  return entry;
}

function groundClipPaths(project, width, height) {
  return buildings.map(building => {
    const path = new Path2D();
    path.rect(0, 0, width, height);
    building.polygon.forEach(([x, y], index) => {
      const point = project(x, y);
      if (index) path.lineTo(point.left, point.top); else path.moveTo(point.left, point.top);
    });
    path.closePath();
    return path;
  });
}

let contactShadowStamp;
function actorContactStamp() {
  if (contactShadowStamp) return contactShadowStamp;
  const stamp = document.createElement('canvas');
  stamp.width = stamp.height = 32;
  const context = stamp.getContext('2d');
  if (!context) return null;
  const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, 'rgba(2,5,9,.95)');
  gradient.addColorStop(.3, 'rgba(2,5,9,.8)');
  gradient.addColorStop(.68, 'rgba(2,5,9,.3)');
  gradient.addColorStop(1, 'rgba(2,5,9,0)');
  context.fillStyle = gradient; context.fillRect(0, 0, 32, 32);
  contactShadowStamp = stamp;
  return stamp;
}

function drawActorShadows(context, screen, spriteWidth, spriteHeight, mapScale, sample, blend, clip, actor, coverage,
  physicalWidth = spriteWidth, physicalHeight = spriteHeight) {
  const options = { blend, coverage, kind: actor.kind, heading: actor.heading, parked: actor.parked };
  const physical = actorGroundShadows(sample, physicalWidth / mapScale, physicalHeight / mapScale, options);
  const shadow = physical.cast;
  // Detail symbols can be easier to read without inventing taller casters.
  // Only their local contact footprint follows the displayed feet/tyres.
  const contacts = physicalWidth === spriteWidth && physicalHeight === spriteHeight ? physical.contacts
    : actorGroundShadows(null, spriteWidth / mapScale, spriteHeight / mapScale, options).contacts;
  if (!shadow && !contacts.length) return { cast: false, contact: false };
  context.save();
  // Intersect each complement separately: overlapping silhouettes must not
  // cancel out and admit a shadow on a roof, including an opened xray roof.
  for (const buildingClip of clip) context.clip(buildingClip, 'evenodd');
  context.filter = 'none';
  context.fillStyle = '#030a15';
  if (shadow) {
    context.globalAlpha = shadow.alpha * blend;
    const dx = shadow.x * mapScale, dy = shadow.y * mapScale;
    context.beginPath();
    context.ellipse(screen.left + dx * .46, screen.top + dy * .46,
      Math.max(mapScale * .35, shadow.length * mapScale * .6), Math.max(mapScale * .18, physicalWidth * .16), Math.atan2(dy, dx), 0, Math.PI * 2);
    context.fill();
  }
  const stamp = contacts.length ? actorContactStamp() : null;
  if (stamp) for (const contact of contacts) {
    context.globalAlpha = contact.alpha;
    context.drawImage(stamp,
      screen.left + (contact.x - contact.radiusX) * mapScale, screen.top + (contact.y - contact.radiusY) * mapScale,
      contact.radiusX * mapScale * 2, contact.radiusY * mapScale * 2);
  }
  context.restore();
  return { cast: Boolean(shadow), contact: Boolean(stamp) };
}

/** Synthetic route animation; speed and density are demonstrations, not tracking. */
export default function ActivityLayer({ project, scale, translateX, translateY, viewWidth, viewHeight,
  layers = { people: true, bikes: true }, minute = 1200, scenarioId = 'weekday', isDark = false, xray = false, moving = true,
  selectedId = 'library', demo = true, lighting = 'atmospheric', detailView = false,
}) {
  const canvasRef = useRef(null);
  const current = useRef(null);
  const invalidate = useRef(null);
  current.current = { project, scale, translateX, translateY, viewWidth, viewHeight, layers, minute, scenarioId, isDark, xray, moving, selectedId, demo, lighting, detailView };

  useEffect(() => {
    let request = 0;
    let disposed = false;
    let lastDraw = -Infinity;
    let dirty = true;
    let frame = 0;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const canMove = () => current.current.demo && current.current.moving && (current.current.layers.people || current.current.layers.bikes) && !media.matches && !document.hidden;
    const redraw = () => {
      dirty = true;
      if (!request && !disposed) request = requestAnimationFrame(draw);
    };
    const assets = {
      person: loadImage('/assets/person-directions.png', redraw),
      movingBike: loadImage('/assets/ebike-moving-directions.png', redraw),
      parkedBike: loadImage('/assets/ebike-parked-directions.png', redraw),
    };
    const unsubscribeTreeMaterial = subscribeTreeMaterial(redraw);
    const unsubscribeNativeCanopy = subscribeCampusNativeCanopy(redraw);
    const actorCanvas = document.createElement('canvas');
    const shadowCanvas = document.createElement('canvas');
    const projectedPaths = createRenderCache(2);
    const playbackChanged = () => {
      sceneTime(performance.now(), canMove());
      redraw();
    };
    media.addEventListener('change', playbackChanged);
    document.addEventListener('visibilitychange', playbackChanged);

    const draw = (now) => {
      request = 0;
      if (disposed) return;
      const props = current.current;
      const canvas = canvasRef.current;
      if (!canvas || !props.project) return;
      const animated = canMove();
      const elapsed = sceneTime(now, animated);
      if (animated) request = requestAnimationFrame(draw);
      if (now - lastDraw < 1000 / 30 && !dirty) return;
      lastDraw = now;
      dirty = false;
      const { viewWidth: width, viewHeight: height, project: projectPoint, scale: mapScale } = props;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      const context = canvas.getContext('2d');
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
      const definitions = props.demo ? actorDefinitions.resolve(props.scenarioId,
        [props.minute, props.layers.people, props.layers.bikes], () => makeActors(props.minute, props.layers, props.scenarioId)) : [];
      const actors = definitions.map((actor) => actorPosition(actor, elapsed)).sort((a, b) => a.y - b.y);
      const treeRevision = treeMaterialState().revision;
      let hiddenCount = 0;
      let visibleCount = 0;
      const campusLighting = props.isDark && props.lighting === 'campus';
      const libraryLighting = props.isDark && (props.lighting === 'library' || campusLighting);
      const localLighting = props.isDark && (props.lighting === 'atmospheric' || libraryLighting);
      const readableDetail = props.demo && props.detailView && (campusLighting || libraryLighting && props.selectedId === 'library');
      const shadowClip = libraryLighting && actors.length ? projectedPaths.resolve('ground',
        [projectPoint, width, height], () => groundClipPaths(projectPoint, width, height)) : null;
      let shadowContext = null;
      if (shadowClip) {
        if (shadowCanvas.width !== pixelWidth || shadowCanvas.height !== pixelHeight) {
          shadowCanvas.width = pixelWidth; shadowCanvas.height = pixelHeight;
        }
        shadowContext = shadowCanvas.getContext('2d');
        shadowContext?.setTransform(dpr, 0, 0, dpr, 0, 0);
        shadowContext?.clearRect(0, 0, width, height);
      }
      let libraryActorCount = 0, actorShadowCount = 0, actorContactCount = 0, readableActorCount = 0, treeClippedCount = 0, bounceActorCount = 0, facadeActorCount = 0;
      let lightingMin = Infinity, lightingMax = -Infinity, warmActorCount = 0;
      const lightingBuckets = new Set();
      const headings = new Set();
      for (const actor of actors) {
        const screen = projectPoint(actor.x, actor.y);
        const sprite = actor.kind === 'walk' ? assets.person : actor.parked ? assets.parkedBike : assets.movingBike;
        if (!sprite.complete || !sprite.naturalWidth) continue;
        const [column, row] = directionCell(actor.heading ?? 0);
        const frame = imageFrames(sprite)?.[row * 2 + column];
        if (!frame || frame.empty) continue;
        const libraryAmount = campusLighting ? 1 : libraryLighting ? libraryBlend(actor.x, actor.y) : 0;
        const dimensions = actorDimensions(actor, frame, mapScale,
          { readable: readableDetail, viewWidth: width, amount: libraryAmount });
        const {width:spriteWidth,height:spriteHeight,physicalWidth,physicalHeight,presentationScale} = dimensions;
        if (screen.left < -spriteWidth || screen.left > width + spriteWidth || screen.top < -spriteHeight || screen.top > height + spriteHeight) continue;
        const occludingBuilding = actorOcclusion.resolve(actor.id, [actor.x, actor.y],
          () => classifyOcclusion([actor.x, actor.y]));
        const occluded = Boolean(occludingBuilding);
        if (occluded) hiddenCount += 1;
        const revealed = occluded && props.xray && occludingBuilding.placeId === props.selectedId;
        if (occluded && !revealed) continue;
        // Even a sprite whose feet are outside a building is clipped by the
        // projected facade below. This prevents bright figures on roof pixels.
        headings.add(`${column}-${row}`);
        visibleCount += 1;
        if (presentationScale > 1.001) readableActorCount += 1;
        context.save();
        context.globalAlpha = revealed ? .72 : actor.parked ? .88 : .98;
        // Sample at the unchanged world-space feet/tyres, so both map views
        // receive the same local light even at different screen zoom levels.
        let litFrame = null;
        let lightSample = null;
        if (localLighting) {
          const sample = actorLightSamples.sample(actor, { campus: campusLighting, libraryAmount, treeRevision });
          lightSample = sample;
          if (libraryAmount > .05) libraryActorCount += 1;
          if (libraryAmount > .05 && (sample.indirectIntensity ?? 0) > .015) bounceActorCount += 1;
          if (libraryAmount > .05 && (sample.facadeIntensity ?? 0) > .015) facadeActorCount += 1;
          const material = readableDetail && libraryAmount > .05 && actor.kind === 'walk'
            ? actorLightMaterial(sample, { kind: 'walk', readable: true }) : actorLightMaterial(sample);
          lightingMin = Math.min(lightingMin, sample.intensity);
          lightingMax = Math.max(lightingMax, sample.intensity);
          if (sample.intensity * sample.warmth > .15) warmActorCount += 1;
          lightingBuckets.add(material.key);
          litFrame = litActorFrame(sprite, frame, material);
        }
        if (shadowContext) {
          const shadows = drawActorShadows(shadowContext, screen, spriteWidth, spriteHeight, mapScale, lightSample, libraryAmount, shadowClip, actor,
            occluded ? 0 : actorCoverage.resolve(actor.id, [actor.x, actor.y],
              () => surfaceCoverage([actor.x, actor.y])), physicalWidth, physicalHeight);
          if (shadows.cast) actorShadowCount += 1;
          if (shadows.contact) actorContactCount += 1;
        }
        context.filter = litFrame ? 'none' : props.isDark ? 'brightness(1.18)' : 'none';
        let drawFrame = litFrame;
        const treeMask = libraryLighting ? treeMaskBehind(actor.y) : null;
        const actorLeft = actor.x - spriteWidth / mapScale / 2, actorTop = actor.y - spriteHeight / mapScale;
        const overlapsTree = treeMask?.trees.some(tree => actorLeft < tree.screenBounds.left + tree.screenBounds.width && actorLeft + spriteWidth / mapScale > tree.screenBounds.left && actorTop < tree.screenBounds.top + tree.screenBounds.height && actor.y > tree.screenBounds.top);
        const campusCrowns = campusLighting ? campusCrownMasks({ left: actorLeft, top: actorTop,
          width: spriteWidth / mapScale, height: spriteHeight / mapScale }, actor.y) : [];
        const nativeCrowns = campusLighting ? getCampusNativeCanopyMasks({ left: actorLeft, top: actorTop,
          width: spriteWidth / mapScale, height: spriteHeight / mapScale }) : [];
        if (overlapsTree || campusCrowns.length || nativeCrowns.length) {
          // Mask an isolated sprite, never the shared actor canvas. A canopy
          // must not erase a foreground actor already drawn at another depth.
          actorCanvas.width = Math.max(1, Math.ceil(spriteWidth * dpr));
          actorCanvas.height = Math.max(1, Math.ceil(spriteHeight * dpr));
          const actorContext = actorCanvas.getContext('2d');
          if (actorContext) {
            if (litFrame) actorContext.drawImage(litFrame, 0, 0, actorCanvas.width, actorCanvas.height);
            else actorContext.drawImage(sprite, frame.x, frame.y, frame.width, frame.height, 0, 0, actorCanvas.width, actorCanvas.height);
            actorContext.globalCompositeOperation = 'destination-out';
            if (overlapsTree) actorContext.drawImage(treeMask.canvas,
              (treeMask.left - actorLeft) * mapScale * dpr, (treeMask.top - actorTop) * mapScale * dpr,
              treeMask.width * mapScale * dpr, treeMask.height * mapScale * dpr);
            drawCampusCrownMasks(actorContext, campusCrowns, { scale: mapScale * dpr,
              offsetX: -actorLeft * mapScale * dpr, offsetY: -actorTop * mapScale * dpr });
            drawNativeCanopyMasks(actorContext, nativeCrowns, { groundY: actor.y, scale: mapScale * dpr,
              offsetX: -actorLeft * mapScale * dpr, offsetY: -actorTop * mapScale * dpr });
            drawFrame = actorCanvas;
            treeClippedCount += 1;
          }
        }
        if (drawFrame) context.drawImage(drawFrame,
          screen.left - spriteWidth / 2, screen.top - spriteHeight, spriteWidth, spriteHeight);
        else context.drawImage(sprite, frame.x, frame.y, frame.width, frame.height,
          screen.left - spriteWidth / 2, screen.top - spriteHeight, spriteWidth, spriteHeight);
        if (revealed) {
          context.filter = 'none';
          context.globalAlpha = .48;
          context.strokeStyle = actor.kind === 'walk' ? '#75baff' : '#ffb264';
          context.lineWidth = 1;
          context.setLineDash([2, 2]);
          context.beginPath();
          context.ellipse(screen.left, screen.top - .25 * mapScale, spriteWidth * .3, .45 * mapScale, 0, 0, Math.PI * 2);
          context.stroke();
        }
        context.restore();
      }
      if (shadowContext) {
        // Ground shadows cannot sit on top of elevated crowns. The shadow
        // canvas shares the actors' z-index, so remove ALL crown silhouettes
        // before compositing it; actor masks still use each figure's depth.
        const crownMask = treeMaskBehind(-Infinity);
        if (crownMask) {
          const corner = projectPoint(crownMask.left, crownMask.top);
          shadowContext.save();
          shadowContext.globalCompositeOperation = 'destination-out';
          shadowContext.globalAlpha = 1;
          shadowContext.drawImage(crownMask.canvas, corner.left, corner.top,
            crownMask.width * mapScale, crownMask.height * mapScale);
          shadowContext.restore();
        }
        if (campusLighting) {
          const origin = projectPoint(0, 0);
          const crowns = campusCrownMasks({ left: -origin.left / mapScale, top: -origin.top / mapScale,
            width: width / mapScale, height: height / mapScale });
          shadowContext.save(); shadowContext.globalCompositeOperation = 'destination-out'; shadowContext.globalAlpha = 1;
          drawCampusCrownMasks(shadowContext, crowns, { scale: mapScale, offsetX: origin.left, offsetY: origin.top });
          const nativeCrowns = getCampusNativeCanopyMasks({ left: -origin.left / mapScale, top: -origin.top / mapScale,
            width: width / mapScale, height: height / mapScale });
          drawNativeCanopyMasks(shadowContext, nativeCrowns, { scale: mapScale, offsetX: origin.left, offsetY: origin.top });
          shadowContext.restore();
        }
        // Composite ground shadows beneath every figure, independent of actor
        // draw order, so a later shadow cannot shade another upright sprite.
        context.save();
        context.globalCompositeOperation = 'destination-over';
        context.globalAlpha = 1; context.filter = 'none';
        context.drawImage(shadowCanvas, 0, 0, width, height);
        context.restore();
      }
      // Cut sprites by registered projected silhouettes without reading remote
      // school imagery into canvas. Xray keeps the selected building open.
      if (actors.length) {
        context.save();
        context.globalCompositeOperation = 'destination-out';
        context.globalAlpha = 1;
        context.filter = 'none';
        context.fillStyle = '#000';
        const silhouettes = projectedPaths.resolve('silhouettes', [projectPoint, props.xray, props.selectedId], () => {
          const path = new Path2D();
          for (const building of buildings) {
            if (props.xray && building.placeId === props.selectedId) continue;
            building.polygon.forEach(([x,y], index) => {
              const point = projectPoint(x,y);
              if (index === 0) path.moveTo(point.left,point.top);
              else path.lineTo(point.left,point.top);
            });
            path.closePath();
          }
          return path;
        });
        context.fill(silhouettes);
        context.restore();
      }
      canvas.dataset.scenario = props.demo ? props.scenarioId : 'field';
      canvas.dataset.minute = props.demo ? String(props.minute) : '';
      canvas.dataset.actorCount = String(actors.length);
      canvas.dataset.parkedCount = String(actors.filter((actor) => actor.parked).length);
      canvas.dataset.personCount = String(actors.filter((actor) => actor.kind === 'walk').length);
      canvas.dataset.ridingCount = String(actors.filter((actor) => actor.kind === 'ride' && !actor.parked).length);
      canvas.dataset.parkedSignature = actors.filter((actor) => actor.parked).map((actor) => `${actor.x},${actor.y},${actor.heading}`).join(';');
      canvas.dataset.occludedCount = String(hiddenCount);
      canvas.dataset.visibleCount = String(visibleCount);
      canvas.dataset.headingCount = String(headings.size);
      canvas.dataset.motion = animated ? 'running' : 'paused';
      canvas.dataset.spriteScaleMode = 'registered-world-alpha-bounds';
      canvas.dataset.actorLighting = campusLighting ? 'campus-shared-surface-2.5d' : libraryLighting ? 'library-shared-surface-2.5d' : localLighting ? 'local-field-2.5d' : props.isDark ? 'original-uniform' : 'day-original';
      canvas.dataset.actorPlaceIds = [...new Set(actors.map(actor => actor.route?.placeId).filter(Boolean))].join(',');
      canvas.dataset.libraryActorCount = String(libraryActorCount);
      canvas.dataset.actorShadowCount = String(actorShadowCount);
      canvas.dataset.actorContactCount = String(actorContactCount);
      canvas.dataset.bounceActorCount = String(bounceActorCount);
      canvas.dataset.facadeActorCount = String(facadeActorCount);
      canvas.dataset.treeClipCandidateCount = String(treeClippedCount);
      canvas.dataset.treeMaskCount = String(treeDepthMasks.size);
      canvas.dataset.treeMaterialRevision = String(treeMaterialState().revision);
      canvas.dataset.lightingMin = Number.isFinite(lightingMin) ? lightingMin.toFixed(3) : '0.000';
      canvas.dataset.lightingMax = Number.isFinite(lightingMax) ? lightingMax.toFixed(3) : '0.000';
      canvas.dataset.warmActorCount = String(warmActorCount);
      canvas.dataset.lightingBuckets = [...lightingBuckets].sort().join(';');
      canvas.dataset.lightingCacheFrames = String(actorLightingCacheStats().variants);
      canvas.dataset.lightingSampleCacheEntries = String(actorLightSamples.size);
      canvas.dataset.personHeight = String(ACTOR_WORLD_HEIGHT.walk * mapScale);
      const presentation = actorDimensions({kind:'walk'}, {width:1,height:1}, mapScale, {readable:readableDetail,viewWidth:width});
      canvas.dataset.personPhysicalHeight = String(presentation.physicalHeight);
      canvas.dataset.personPresentationHeight = String(presentation.height);
      canvas.dataset.presentationScale = String(presentation.presentationScale);
      canvas.dataset.presentationScaleMode = readableDetail ? 'library-detail-cartographic-legibility' : 'registered-world-alpha-bounds';
      canvas.dataset.readableActorCount = String(readableActorCount);
      canvas.dataset.ridingHeight = String(ACTOR_WORLD_HEIGHT.riding * mapScale);
      canvas.dataset.parkedHeight = String(ACTOR_WORLD_HEIGHT.parked * mapScale);
      canvas.dataset.drawFrame = String(++frame);
      canvas.dataset.sceneTime = elapsed.toFixed(3);
      canvas.dataset.poseSignature = actors.filter((actor) => !actor.parked).slice(0, 4).map((actor) => `${actor.x.toFixed(2)},${actor.y.toFixed(2)}`).join(';');
    };
    invalidate.current = playbackChanged;
    playbackChanged();
    return () => {
      disposed = true;
      cancelAnimationFrame(request);
      invalidate.current = null;
      media.removeEventListener('change', playbackChanged);
      document.removeEventListener('visibilitychange', playbackChanged);
      unsubscribeTreeMaterial();
      unsubscribeNativeCanopy();
      Object.values(assets).forEach((image) => { image.onload = null; });
    };
  }, []);
  // Props may change while paused; render that new view once without a loop.
  useEffect(() => { invalidate.current?.(); });

  return <canvas ref={canvasRef} className="cp-activity-layer" aria-hidden="true"
    data-xray={xray ? 'true' : 'false'} style={{ width: viewWidth, height: viewHeight }} />;
}
