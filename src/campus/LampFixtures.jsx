import { useEffect, useRef, useState } from 'react';
import { buildings, lampPoints, pointInPolygon } from './spatial-scene';
import { campusLightLamps } from './campus-lighting-layout';
import { libraryBlend, libraryLights, libraryTrees, treeOpacityAt } from './library-lighting';
import { subscribeTreeMaterial, treeMaterialState } from './tree-material';
import { campusLights } from './campus-scene-data';
import { campusTreeOpacityAt, getCampusTreesInBounds } from './campus-scene-lighting';
import { getCampusNativeCanopyMasks, subscribeCampusNativeCanopy } from './CampusLightingLayer';
import { drawNativeCanopyMasks } from './campus-tree-masks';
import './lamp-fixtures.css';

const FIXTURE_URL = '/assets/campus-lamp-v1.png';
let fixtureMaterial = null;
let fixtureLoading = null;

/** Read the authored fixture only, once. Never inspect the GIS. The transparent
 * padding is excluded from scale, and the lower pole determines the foot anchor
 * rather than the wider arm/head. Heights below use illustration map units.
 */
function prepareFixture(source) {
  const ratio = Math.min(1, 768 / Math.max(source.naturalWidth, source.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.naturalWidth * ratio));
  canvas.height = Math.max(1, Math.round(source.naturalHeight * ratio));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let left = canvas.width, right = -1, top = canvas.height, bottom = -1;
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    if (data[(y * canvas.width + x) * 4 + 3] <= 16) continue;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (right < left || bottom <= top) return null;
  let footWeight = 0, footX = 0;
  const footTop = Math.max(top, bottom - Math.max(2, Math.round((bottom - top) * .06)));
  for (let y = footTop; y <= bottom; y++) for (let x = left; x <= right; x++) {
    const alpha = data[(y * canvas.width + x) * 4 + 3] / 255;
    if (alpha <= .06) continue;
    footWeight += alpha; footX += (x + .5) * alpha;
  }
  const anchorX = footWeight > 0 ? footX / footWeight : (left + right + 1) / 2;
  // Locate the authored warm lens (the head's cap sits slightly above it).
  // Alpha weighting ignores faint embedded optical fringe around the lens.
  let lensWeight = 0, lensX = 0, lensY = 0;
  for (let y = top; y <= top + (bottom - top) * .3; y++) for (let x = left; x <= right; x++) {
    const offset = (y * canvas.width + x) * 4;
    if (data[offset] < 220 || data[offset + 1] < 165 || data[offset + 2] < 80) continue;
    const weight = data[offset + 3] / 255 * (data[offset + 1] / 255) ** 4;
    lensWeight += weight; lensX += (x + .5) * weight; lensY += (y + .5) * weight;
  }
  // Preserve one antialias texel without restoring the generator's padding.
  left = Math.max(0, left - 1); right = Math.min(canvas.width - 1, right + 1);
  top = Math.max(0, top - 1); bottom = Math.min(canvas.height - 1, bottom + 1);
  const cropped = document.createElement('canvas');
  cropped.width = right - left + 1; cropped.height = bottom - top + 1;
  const croppedContext = cropped.getContext('2d');
  if (!croppedContext) return null;
  croppedContext.drawImage(canvas, left, top, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
  const lensFraction = lensWeight > 0 ? Math.max(.7, Math.min(1, (bottom - lensY / lensWeight) / cropped.height)) : 1;
  return { image: cropped, anchorX: (anchorX - left) / cropped.width, width: cropped.width,
    height: cropped.height, lensFraction,
    lensAnchorX: ((lensWeight > 0 ? lensX / lensWeight : anchorX) - left) / cropped.width };
}

function loadFixture() {
  if (fixtureMaterial) return Promise.resolve(fixtureMaterial);
  if (fixtureLoading) return fixtureLoading;
  fixtureLoading = new Promise(resolve => {
    const source = new Image();
    source.decoding = 'async';
    source.onerror = () => resolve(null);
    source.onload = () => {
      try { fixtureMaterial = prepareFixture(source); }
      catch { fixtureMaterial = null; }
      resolve(fixtureMaterial);
    };
    source.src = FIXTURE_URL;
  });
  return fixtureLoading;
}

const campusFixtures = [...lampPoints, ...campusLightLamps].map((source, index) => ({
  x: source.x, y: source.y, height: 7 + (index % 3),
  id: source.id ?? `retained-lamp-${index}`,
}));
// Ceiling fixtures have their own small material in the shared world atlas.
// They must never acquire a second, ground-standing pole sprite.
const localFixtures = libraryLights.filter(source => source.fixtureType !== 'canopy-downlight').map(source => ({
  ...source.ground, height: source.height, id: source.id,
}));
const outsideBuildings = source => !buildings.some(building => pointInPolygon([source.x, source.y], building.polygon));
const treeMaskedFixtures = new Map();
let treeMaskRevision = -1;

/** Static world-space alpha crops, shared by both cameras. Only nearby fixtures
 * behind a crown are sampled. The exact same leaf gaps and painter ground depth
 * as actors decide opacity; a foreground pole remains intact above foliage.
 */
function fixtureWithTreeOcclusion(source, material, revision, campus = false) {
  const worldHeight = source.height / material.lensFraction;
  const worldWidth = worldHeight * material.width / material.height;
  const left = source.x - material.lensAnchorX * worldWidth, top = source.y - worldHeight;
  const trees = campus ? getCampusTreesInBounds({left, top, width:worldWidth, height:worldHeight}) : libraryTrees;
  const nativeCrowns = campus ? getCampusNativeCanopyMasks({left, top, width:worldWidth, height:worldHeight}) : [];
  const overlaps = trees.some(tree => source.y < tree.base.y
    && left < tree.screenBounds.left + tree.screenBounds.width
    && left + worldWidth > tree.screenBounds.left
    && top < tree.screenBounds.top + tree.screenBounds.height
    && source.y > tree.screenBounds.top);
  if (!overlaps && !nativeCrowns.length) return { image: material.image, masked: false };
  if (treeMaskRevision !== revision) {
    treeMaskedFixtures.clear(); treeMaskRevision = revision;
  }
  const key = `${campus ? 'campus' : 'library'}:${source.id}`;
  if (treeMaskedFixtures.has(key)) return treeMaskedFixtures.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(worldWidth * 8));
  canvas.height = Math.max(1, Math.ceil(worldHeight * 8));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return { image: material.image, masked: false };
  context.drawImage(material.image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const alpha = (y * canvas.width + x) * 4 + 3;
    if (!pixels.data[alpha]) continue;
    const worldX = left + (x + .5) / canvas.width * worldWidth;
    const worldY = top + (y + .5) / canvas.height * worldHeight;
    pixels.data[alpha] *= 1 - (campus ? campusTreeOpacityAt : treeOpacityAt)(worldX, worldY, source.y);
  }
  context.putImageData(pixels, 0, 0);
  if (nativeCrowns.length) {
    context.save(); context.globalCompositeOperation = 'destination-out';
    context.setTransform(canvas.width / worldWidth, 0, 0, canvas.height / worldHeight,
      -left * canvas.width / worldWidth, -top * canvas.height / worldHeight);
    drawNativeCanopyMasks(context, nativeCrowns, {groundY:source.y}); context.restore();
  }
  const result = { image: canvas, masked: true };
  treeMaskedFixtures.set(key, result);
  return result;
}

/** Physical-looking illustrative objects for the existing artistic light list.
 * This layer neither adds light sources nor claims actual campus lamp locations.
 * An unavailable asset leaves the layer empty; the optical field stays separate.
 */
export default function LampFixtures({ project, scale, viewWidth, viewHeight,
  isDark = false, lighting = 'atmospheric', xray = false, selectedId = 'library' }) {
  const canvasRef = useRef(null);
  const [material, setMaterial] = useState(fixtureMaterial);
  const [status, setStatus] = useState(fixtureMaterial ? 'ready' : 'idle');
  const [treeRevision, setTreeRevision] = useState(() => treeMaterialState().revision);
  const [nativeRevision, setNativeRevision] = useState(0);
  useEffect(() => subscribeTreeMaterial(state => setTreeRevision(state.revision)), []);
  useEffect(() => lighting === 'campus' ? subscribeCampusNativeCanopy(() => setNativeRevision(value => value + 1)) : undefined, [lighting]);
  const enabled = isDark && ['atmospheric', 'enhanced', 'library', 'campus'].includes(lighting);
  const origin = project?.(0, 0) ?? { left: 0, top: 0 };
  useEffect(() => {
    if (!enabled || material) return undefined;
    let active = true;
    setStatus('loading');
    void loadFixture().then(next => {
      if (!active) return;
      setMaterial(next); setStatus(next ? 'ready' : 'unavailable');
    });
    return () => { active = false; };
  }, [enabled, material]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const request = requestAnimationFrame(() => {
      if (!canvas.isConnected) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, viewWidth), height = Math.max(1, viewHeight);
      canvas.width = Math.ceil(width * ratio); canvas.height = Math.ceil(height * ratio);
      canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
      const context = canvas.getContext('2d');
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      let count = 0, maskedCount = 0;
      if (enabled && material && scale > 0) {
        const sources = lighting === 'campus' ? [...campusLights, ...localFixtures] : lighting === 'library'
          ? [...campusFixtures.filter(source => !libraryBlend(source.x, source.y)), ...localFixtures]
          : campusFixtures;
        context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
        for (const source of sources) {
          if (!outsideBuildings(source)) continue;
          const footX = origin.left + source.x * scale, footY = origin.top + source.y * scale;
          const drawnHeight = source.height * scale / material.lensFraction;
          const drawnWidth = drawnHeight * material.width / material.height;
          // The source ground anchor is the bulb's plumb projection; the arm
          // naturally places the pole foot a little to its left.
          const left = footX - material.lensAnchorX * drawnWidth, top = footY - drawnHeight;
          if (left + drawnWidth < 0 || left > width || footY < 0 || top > height) continue;
          const fixture = fixtureWithTreeOcclusion(source, material, `${treeRevision}:${nativeRevision}`, lighting === 'campus');
          context.drawImage(fixture.image, left, top, drawnWidth, drawnHeight);
          if (fixture.masked) maskedCount += 1;
          count += 1;
        }
        // Cut all projected architecture, also in xray. A lamp outside a source
        // footprint can still overlap a tall roof in this orthographic view.
        context.globalCompositeOperation = 'destination-out';
        context.fillStyle = '#000';
        for (const building of buildings) {
          context.beginPath();
          building.polygon.forEach(([x, y], index) => {
            const px = origin.left + x * scale, py = origin.top + y * scale;
            if (index) context.lineTo(px, py); else context.moveTo(px, py);
          });
          context.closePath(); context.fill();
        }
        context.globalCompositeOperation = 'source-over';
      }
      Object.assign(canvas.dataset, {
        fixtureCount: String(count), asset: status, renderer: 'single-on-demand-canvas',
        source: 'existing-illustrative-light-anchors-not-observed-campus-fixtures',
        anchor: 'trimmed-alpha-emitting-lens-x-and-pole-foot-y', heights: 'illustrative-map-units-library-shared-source-height',
        occlusion: 'all-projected-building-silhouettes-and-shared-tree-alpha-by-ground-depth',
        treeMaskedFixtureCount: String(maskedCount), treeMaterialRevision: String(treeRevision),
        xray: xray ? 'building-clipping-preserved' : 'off',
        selectedId, worldX: String(origin.left), worldY: String(origin.top), worldScale: String(scale),
      });
    });
    return () => cancelAnimationFrame(request);
  }, [origin.left, origin.top, scale, viewWidth, viewHeight, enabled, lighting, material, status, treeRevision, nativeRevision, xray, selectedId]);
  return <canvas ref={canvasRef} className="cp-lamp-fixtures" hidden={!enabled || !material} aria-hidden="true" />;
}
