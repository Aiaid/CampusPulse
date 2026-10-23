import { useEffect, useRef } from 'react';
import { getMetrics } from './scene-data';
import { routes, parkingAreas, buildings, sampleRoute, classifyOcclusion } from './spatial-scene';
import './activity-layer.css';
import { ACTOR_WORLD_HEIGHT, actorDimensions, imageFrames } from './actor-style';
import { sampleLocalLight } from './lighting-field';
import { actorLightMaterial, litActorFrame, actorLightingCacheStats } from './actor-lighting';

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
const MAX_ACTORS = 48;
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
function makeActors(minute, layers) {
  const result = [];
  // Stable IDs and phase keep the same actors in place as density changes.
  for (const route of routes) {
    if (route.points.length < 2 || !layers[route.kind === 'walk' ? 'people' : 'bikes']) continue;
    const metrics = getMetrics(route.placeId, minute);
    const count = route.kind === 'walk' ? clamp(Math.round(metrics.people / 23), 1, 4) : clamp(Math.round(metrics.bikes / 30), 1, 3);
    const length = Math.max(pathLength(route), 1);
    for (let index = 0; index < count; index += 1) {
      result.push({ id: `${route.id}-${index}`, route, length, kind: route.kind, parked: false,
        phase: (index * .381966 + routes.indexOf(route) * .173) % 1,
        speed: route.kind === 'walk' ? .95 + index * .07 : 2.6 + index * .18 });
    }
  }
  // A parking sprite contains no rider and never participates in motion.
  if (layers.bikes) for (const area of parkingAreas) {
    const metrics = getMetrics(area.placeId, minute);
    const occupied = Math.max(1, Math.round(area.slots.length * metrics.bikes / 100));
    for (const [index, slot] of area.slots.slice(0, occupied).entries()) {
      result.push({ id: `${area.id}-parked-${index}`, kind: 'ride', parked: true, ...slot });
    }
  }
  return result.slice(0, MAX_ACTORS);
}
function loadImage(src, redraw) {
  const image = new Image();
  image.onload = redraw;
  image.src = src;
  return image;
}

/** Synthetic route animation; speed and density are demonstrations, not tracking. */
export default function ActivityLayer({ project, scale, translateX, translateY, viewWidth, viewHeight,
  layers = { people: true, bikes: true }, minute = 1200, isDark = false, xray = false, moving = true,
  selectedId = 'library', demo = true, lighting = 'atmospheric',
}) {
  const canvasRef = useRef(null);
  const current = useRef(null);
  const invalidate = useRef(null);
  current.current = { project, scale, translateX, translateY, viewWidth, viewHeight, layers, minute, isDark, xray, moving, selectedId, demo, lighting };

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
      const actors = (props.demo ? makeActors(props.minute, props.layers) : []).map((actor) => actorPosition(actor, elapsed)).sort((a, b) => a.y - b.y);
      let hiddenCount = 0;
      let visibleCount = 0;
      const localLighting = props.isDark && props.lighting === 'atmospheric';
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
        const {width:spriteWidth,height:spriteHeight} = actorDimensions(actor, frame, mapScale);
        if (screen.left < -spriteWidth || screen.left > width + spriteWidth || screen.top < -spriteHeight || screen.top > height + spriteHeight) continue;
        const occludingBuilding = classifyOcclusion([actor.x, actor.y]);
        const occluded = Boolean(occludingBuilding);
        if (occluded) hiddenCount += 1;
        const revealed = occluded && props.xray && occludingBuilding.placeId === props.selectedId;
        if (occluded && !revealed) continue;
        // Even a sprite whose feet are outside a building is clipped by the
        // projected facade below. This prevents bright figures on roof pixels.
        headings.add(`${column}-${row}`);
        visibleCount += 1;
        context.save();
        context.globalAlpha = revealed ? .72 : actor.parked ? .88 : .98;
        // Sample at the unchanged world-space feet/tyres, so both map views
        // receive the same local light even at different screen zoom levels.
        let litFrame = null;
        if (localLighting) {
          const sample = sampleLocalLight(actor.x, actor.y);
          const material = actorLightMaterial(sample);
          lightingMin = Math.min(lightingMin, sample.intensity);
          lightingMax = Math.max(lightingMax, sample.intensity);
          if (sample.intensity * sample.warmth > .15) warmActorCount += 1;
          lightingBuckets.add(material.key);
          litFrame = litActorFrame(sprite, frame, material);
        }
        context.filter = litFrame ? 'none' : props.isDark ? 'brightness(1.18)' : 'none';
        if (litFrame) context.drawImage(litFrame,
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
      // Cut sprites by registered projected silhouettes without reading remote
      // school imagery into canvas. Xray keeps the selected building open.
      context.save();
      context.globalCompositeOperation = 'destination-out';
      context.globalAlpha = 1;
      context.filter = 'none';
      context.fillStyle = '#000';
      context.beginPath();
      for (const building of buildings) {
        if (props.xray && building.placeId === props.selectedId) continue;
        building.polygon.forEach(([x,y], index) => {
          const point = projectPoint(x,y);
          if (index === 0) context.moveTo(point.left,point.top);
          else context.lineTo(point.left,point.top);
        });
        context.closePath();
      }
      context.fill();
      context.restore();
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
      canvas.dataset.actorLighting = localLighting ? 'local-field-2.5d' : props.isDark ? 'original-uniform' : 'day-original';
      canvas.dataset.lightingMin = Number.isFinite(lightingMin) ? lightingMin.toFixed(3) : '0.000';
      canvas.dataset.lightingMax = Number.isFinite(lightingMax) ? lightingMax.toFixed(3) : '0.000';
      canvas.dataset.warmActorCount = String(warmActorCount);
      canvas.dataset.lightingBuckets = [...lightingBuckets].sort().join(';');
      canvas.dataset.lightingCacheFrames = String(actorLightingCacheStats().variants);
      canvas.dataset.personHeight = String(ACTOR_WORLD_HEIGHT.walk * mapScale);
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
      Object.values(assets).forEach((image) => { image.onload = null; });
    };
  }, []);
  // Props may change while paused; render that new view once without a loop.
  useEffect(() => { invalidate.current?.(); });

  return <canvas ref={canvasRef} className="cp-activity-layer" aria-hidden="true"
    data-xray={xray ? 'true' : 'false'} style={{ width: viewWidth, height: viewHeight }} />;
}
