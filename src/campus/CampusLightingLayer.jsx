import { useEffect, useRef, useState } from 'react';
import { visibleGisTiles } from './gis-tiles.js';
import { prepareGisMaterial, samplePreparedGisMaterial } from './gis-material.js';
import { libraryBlend, LIBRARY_BOUNDS, screenToWorld } from './library-lighting.js';
import { resolveCampusSurface, sampleCampusLight } from './campus-scene-lighting.js';
import { campusSurfaces, campusTrees, campusLights, campusVegetationZones } from './campus-scene-data.js';
import { buildings as campusBuildingRegions } from './spatial-scene.js';
import { shadeLinearSceneSurface, shadeSceneSurface } from './surface-lighting.js';
import { loadTreeMaterial, sampleTreeMaterial, subscribeTreeMaterial } from './tree-material.js';
import { loadBuildingMaterial, sampleBuildingMaterial, subscribeBuildingMaterial,
  buildingMaterialState } from './building-material.js';
import { CAMPUS_MATERIAL_HALO, visibleCampusChunks, campusChunkResolution,
  createCampusChunkCache, createCampusImageCache } from './campus-material-cache.js';
import { nativeCanopyExclusion, prepareNativeCanopyMask, sampleNativeCanopyMask } from './native-canopy.js';
import './campus-lighting.css';

const TILE_ORIGIN = (import.meta.env?.VITE_GIS_TILE_ORIGIN || 'https://gis.ccnu.edu.cn').replace(/\/$/, '');
const CHANNELS = ['ground', 'tree', 'building', 'normals'];
// The retained pixels describe crown tops, above the seven-unit path fixtures.
// A top-facing leaf receiver must not borrow the ellipsoid underside's wrapped
// lobe or be placed below the lamp, which creates yellow ground-light blobs.
const NATIVE_CANOPY_HEIGHT = 11;
const nativeExclusionPolygons = [
  [[LIBRARY_BOUNDS.left, LIBRARY_BOUNDS.top], [LIBRARY_BOUNDS.left + LIBRARY_BOUNDS.width, LIBRARY_BOUNDS.top],
    [LIBRARY_BOUNDS.left + LIBRARY_BOUNDS.width, LIBRARY_BOUNDS.top + LIBRARY_BOUNDS.height], [LIBRARY_BOUNDS.left, LIBRARY_BOUNDS.top + LIBRARY_BOUNDS.height]],
  ...campusSurfaces.filter(surface => surface.kind !== 'ground' || ['grass', 'water'].includes(surface.material) || /sports|courts/.test(surface.id)).map(surface => surface.polygon),
  ...campusBuildingRegions.map(building => building.polygon),
];
const clamp01 = value => Math.max(0, Math.min(1, value));
const yieldToBrowser = () => new Promise(resolve => setTimeout(resolve, 0));
const images = createCampusImageCache({ maxEntries: 64, load: tile => new Promise(resolve => {
  const image = new Image();
  let finished = false;
  const done = value => {
    if (finished) return; finished = true; clearTimeout(deadline);
    image.onload = null; image.onerror = null; resolve(value);
  };
  const deadline = setTimeout(() => done(null), 8000);
  image.crossOrigin = 'anonymous'; image.decoding = 'async';
  image.onload = () => done(image.naturalWidth && image.naturalHeight ? image : null);
  image.onerror = () => done(null);
  image.src = `${TILE_ORIGIN}/mapdata/zoom${tile.key}.jpg`;
}) });

function canvasOf(width, height, pixels) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas unavailable');
  if (pixels) context.putImageData(new ImageData(pixels, width, height), 0, 0);
  return canvas;
}

async function sourceMaterial(chunk) {
  const { resolution } = chunk, halo = CAMPUS_MATERIAL_HALO;
  const bounds = { left: chunk.left - halo, top: chunk.top - halo,
    width: chunk.width + halo * 2, height: chunk.height + halo * 2 };
  const width = bounds.width * resolution, height = bounds.height * resolution;
  const tiles = visibleGisTiles({ level: resolution === 2 ? 2 : 3, width, height, scale: resolution,
    translateX: -bounds.left * resolution, translateY: -bounds.top * resolution, overscan: 0 });
  const loaded = await Promise.all(tiles.map(tile => images.get(tile)));
  if (!loaded.length || loaded.some(image => !image)) return null;
  const canvas = canvasOf(width, height), context = canvas.getContext('2d', { willReadFrequently: true });
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    context.drawImage(loaded[i], (tile.x - bounds.left) * resolution, (tile.y - bounds.top) * resolution,
      tile.size * resolution, tile.size * resolution);
  }
  await yieldToBrowser();
  // Eight map units exceed the six-unit normalization radius. Adjacent chunks
  // therefore see the same source neighborhood at every retained border pixel.
  return prepareGisMaterial(context.getImageData(0, 0, width, height), { bounds, resolution });
}

async function compileChunk(chunk) {
  const sourceStarted = performance.now(), material = await sourceMaterial(chunk);
  if (!material) return null;
  const started = performance.now(), sourceMs = started - sourceStarted;
  const { resolution } = chunk, width = chunk.width * resolution, height = chunk.height * resolution;
  const pixels = Object.fromEntries(CHANNELS.map(channel => [channel, new Uint8ClampedArray(width * height * 4)]));
  const nativeMask = prepareNativeCanopyMask(material, {
    excludedAt: nativeCanopyExclusion(nativeExclusionPolygons, material.bounds),
    vegetationAt: nativeCanopyExclusion(campusVegetationZones, material.bounds),
  });
  const nativePixels = new Uint8ClampedArray(width * height * 4);
  const buildingIds = new Uint16Array(width * height), buildings = [''];
  const surfaceIds = new Set(), receiverPixels = { ground: 0, tree: 0, roof: 0, wall: 0 };
  let sourcePixels = 0, emissionPixels = 0, nativeCanopyPixels = 0, batchStart = performance.now();
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const x = chunk.left + (px + .5) / resolution, y = chunk.top + (py + .5) / resolution;
      const retained = 1 - libraryBlend(x, y);
      if (retained <= 0) continue;
      let hit = resolveCampusSurface(x, y);
      const native = (!hit || hit.kind === 'ground') && sampleNativeCanopyMask(nativeMask, x, y);
      if (native) hit = { id: 'runtime-native-canopy', kind: 'tree', native: true, coverage: native.coverage,
        normal: native.normal, position: screenToWorld(x, y, NATIVE_CANOPY_HEIGHT) };
      if (!hit || !hit.coverage) continue;
      const channel = hit.kind === 'tree' ? 'tree' : hit.kind === 'ground' ? 'ground' : 'building';
      const light = sampleCampusLight(hit.position, hit.normal, {
        excludeId: hit.id, indirect: true, emissive: true, receiverKind: hit.native ? 'native-canopy' : hit.kind,
      });
      const roughness = hit.kind === 'roof' ? .82 : hit.kind === 'wall' ? .72 : hit.kind === 'tree' ? .5 : .78;
      let alpha = retained * clamp01(hit.coverage), rgb;
      const options = { roughness };
      if (hit.emission?.strength > 0) {
        const warm = hit.emission.uv && sampleBuildingMaterial(...hit.emission.uv, 'warm');
        options.emissionColorRGB = warm?.baseColor ?? hit.emission.color ?? [246, 186, 105];
        options.emissionStrength = hit.emission.strength * (warm?.emissionMask ?? 1);
        options.emissionNormalization = warm ? buildingMaterialState().warmEmissionNormalization
          : hit.emission.normalization ?? 1;
        emissionPixels++;
      }
      if (hit.native) {
        const source = samplePreparedGisMaterial(material, x, y, { kind: 'canopy', targetY: .16, normalizationStrength: .4 });
        if (!source || source.alpha <= 0) continue;
        alpha *= source.alpha;
        rgb = shadeLinearSceneSurface(source.linearAlbedo, hit.normal, light, options); sourcePixels++; nativeCanopyPixels++;
        nativePixels.set([255, 255, 255, Math.round(alpha * 255)], (py * width + px) * 4);
      } else if (channel === 'tree') {
        const texture = hit.materialUV && sampleTreeMaterial(...hit.materialUV);
        rgb = shadeSceneSurface(hit.baseColor ?? texture?.baseColor ?? [56, 91, 62], hit.normal, light, options);
      } else {
        const source = samplePreparedGisMaterial(material, x, y, hit.kind === 'ground'
          ? { kind: 'roof', targetY: .24, normalizationStrength: .48, blueNeutralization: .1 }
          : { kind: hit.kind });
        if (!source || source.alpha <= 0) continue;
        alpha *= source.alpha;
        rgb = shadeLinearSceneSurface(source.linearAlbedo, hit.normal, light, options); sourcePixels++;
      }
      const index = py * width + px, offset = index * 4;
      pixels[channel].set([...rgb, Math.round(alpha * 255)], offset);
      pixels.normals.set([...hit.normal.map(value => Math.round((value * .5 + .5) * 255)), Math.round(alpha * 255)], offset);
      if (channel === 'building') {
        const id = hit.surface?.buildingId ?? hit.buildingId ?? hit.id;
        let buildingIndex = buildings.indexOf(id);
        if (buildingIndex < 0) { buildings.push(id); buildingIndex = buildings.length - 1; }
        buildingIds[index] = buildingIndex;
      }
      surfaceIds.add(hit.id); receiverPixels[hit.kind] = (receiverPixels[hit.kind] ?? 0) + 1;
    }
    if (performance.now() - batchStart > 7) { await yieldToBrowser(); batchStart = performance.now(); }
  }
  const canvases = Object.fromEntries(CHANNELS.map(channel => [channel, canvasOf(width, height, pixels[channel])]));
  return { ...chunk, widthPixels: width, heightPixels: height, canvases, buildingIds, buildings,
    nativeCanopyCanvas: nativeCanopyPixels ? canvasOf(width, height, nativePixels) : null,
    buildingPixels: pixels.building, normalPixels: pixels.normals, faded: null,
    stats: { sourcePixels, emissionPixels, nativeCanopyPixels, receiverPixels, surfaceCount: surfaceIds.size, sourceMs,
      compileMs: Math.round((performance.now() - started) * 10) / 10 } };
}

const chunks = createCampusChunkCache({ compile: compileChunk, maxEntries: 64, concurrency: 2 });

/** Read-only prepared masks for actor/contact-shadow compositing. No readback or
 * source request occurs here; returned canvases share bounded chunk residency. */
export function getCampusNativeCanopyMasks(bounds) {
  if (!bounds) return [];
  return chunks.values().filter(chunk => chunk.nativeCanopyCanvas && chunk.left < bounds.left + bounds.width
    && chunk.left + chunk.width > bounds.left && chunk.top < bounds.top + bounds.height
    && chunk.top + chunk.height > bounds.top).map(chunk => ({ canvas: chunk.nativeCanopyCanvas,
      left: chunk.left, top: chunk.top, width: chunk.width, height: chunk.height, heightProxy: NATIVE_CANOPY_HEIGHT }));
}
export function subscribeCampusNativeCanopy(listener) { return chunks.subscribe(listener); }

let assetLoads;
function prepareAssets() {
  if (assetLoads) return assetLoads;
  // Revision changes replace visible chunks while keeping their last material
  // available. A second map shares this load and the same prepared chunk data.
  subscribeTreeMaterial(state => { if (state.status === 'ready') chunks.invalidate(); });
  subscribeBuildingMaterial(state => { if (state.status === 'ready') chunks.invalidate(); });
  assetLoads = Promise.all([loadTreeMaterial(), loadBuildingMaterial()]);
  return assetLoads;
}

function buildingCanvas(chunk, selectedId, normalMode) {
  // UI places and source building IDs use the existing reviewed association.
  const selectedBuildings = new Set(campusBuildingRegions.filter(building => building.placeId === selectedId).map(building => building.id));
  if (selectedId) selectedBuildings.add(selectedId);
  const selectedIndices = new Set(chunk.buildings.map((id, index) => selectedBuildings.has(id) ? index : -1).filter(index => index > 0));
  if (!selectedIndices.size) return chunk.canvases[normalMode ? 'normals' : 'building'];
  const key = `${selectedId}:${normalMode}`;
  if (chunk.faded?.key === key) return chunk.faded.canvas;
  const pixels = new Uint8ClampedArray(normalMode ? chunk.normalPixels : chunk.buildingPixels);
  for (let pixel = 0; pixel < chunk.buildingIds.length; pixel++) {
    if (selectedIndices.has(chunk.buildingIds[pixel])) pixels[pixel * 4 + 3] = Math.round(pixels[pixel * 4 + 3] * .22);
  }
  const canvas = canvasOf(chunk.widthPixels, chunk.heightPixels, pixels);
  chunk.faded = { key, canvas }; return canvas;
}

/** On-demand viewport material, with shared 128-unit chunks across both maps.
 * Every prepared color uses the accepted scene-linear lighting response. */
export default function CampusLightingLayer({ project, scale, viewWidth, viewHeight,
  isDark = false, xray = false, selectedId, diagnostic = false }) {
  const host = useRef(null), owner = useRef(Symbol('campus-map')), frames = useRef(0);
  const [revision, setRevision] = useState(0);
  const origin = project?.(0, 0) ?? { left: 0, top: 0 };
  const normalMode = diagnostic === true || diagnostic === 'normals';
  useEffect(() => {
    const unsubscribe = chunks.subscribe(() => setRevision(chunks.snapshot().revision));
    void prepareAssets();
    return () => { unsubscribe(); chunks.removeViewport(owner.current); };
  }, []);
  useEffect(() => {
    const visible = visibleCampusChunks({ width: viewWidth, height: viewHeight, scale,
      translateX: origin.left, translateY: origin.top });
    const density = scale * Math.min(window.devicePixelRatio || 1, 2);
    chunks.setViewport(owner.current, isDark || normalMode ? visible : [], campusChunkResolution(density));
  }, [origin.left, origin.top, scale, viewWidth, viewHeight, isDark, normalMode]);
  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    const frame = requestAnimationFrame(() => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2), width = Math.max(1, viewWidth), height = Math.max(1, viewHeight);
      const visible = visibleCampusChunks({ width, height, scale, translateX: origin.left, translateY: origin.top });
      const materials = visible.map(chunk => chunks.get(chunk.key)).filter(Boolean);
      for (const channel of CHANNELS) {
        const canvas = element.querySelector(`[data-campus-channel="${channel}"]`);
        canvas.hidden = !(isDark || normalMode) || (normalMode ? channel !== 'normals' : channel === 'normals');
        if (canvas.hidden) continue;
        if (canvas.width !== Math.ceil(width * ratio)) canvas.width = Math.ceil(width * ratio);
        if (canvas.height !== Math.ceil(height * ratio)) canvas.height = Math.ceil(height * ratio);
        canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
        const context = canvas.getContext('2d'); context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, width, height); context.imageSmoothingEnabled = true;
        for (const material of materials) {
          const image = xray && (channel === 'building' || channel === 'normals')
            ? buildingCanvas(material, selectedId, channel === 'normals') : material.canvases[channel];
          context.drawImage(image, origin.left + material.left * scale, origin.top + material.top * scale,
            material.width * scale, material.height * scale);
        }
      }
      const state = chunks.snapshot();
      Object.assign(element.dataset, { lighting: 'illustrative', renderer: 'cpu-shared-viewport-chunks',
        model: 'campus-shared-linear-2.5d', renderLoop: 'on-demand', renderFrame: String(++frames.current),
        materialStatus: state.ready === state.visible && state.visible ? 'ready' : state.running ? 'loading' : 'fallback',
        sourceMaterial: 'runtime-official-gis-approximate-reflectance', sourceMaterialReady: String(materials.length > 0),
        chunkCount: String(state.entries), visibleChunks: String(visible.length), readyChunks: String(materials.length),
        chunkResolution: String(campusChunkResolution(scale * ratio)), detailChunks: String(state.detail),
        imageCacheCount: String(images.snapshot().entries), runningJobs: String(state.running),
        failedChunks: String(state.failed), viewportOwners: String(state.owners),
        surfaceCount: String(campusSurfaces.length), treeCount: String(campusTrees.length), lightCount: String(campusLights.length),
        sourcePixels: String(materials.reduce((sum, material) => sum + material.stats.sourcePixels, 0)),
        nativeCanopyPixels: String(materials.reduce((sum, material) => sum + material.stats.nativeCanopyPixels, 0)),
        nativeCanopyModel: 'source-green-or-zone-textured-crown-proxy',
        emissionPixels: String(materials.reduce((sum, material) => sum + material.stats.emissionPixels, 0)),
        receiverCounts: JSON.stringify(materials.reduce((counts, material) => {
          for (const [kind, count] of Object.entries(material.stats.receiverPixels)) counts[kind] = (counts[kind] ?? 0) + count;
          return counts;
        }, {})),
        compileMs: String(Math.round(materials.reduce((sum, material) => sum + material.stats.compileMs, 0))),
        maxCompileMs: String(Math.round(Math.max(0, ...materials.map(material => material.stats.compileMs)))),
        worldX: String(origin.left), worldY: String(origin.top), worldScale: String(scale),
        diagnostic: normalMode ? 'normals' : 'off', libraryProfile: 'preserved-separate-layer',
        xrayBuilding: xray ? selectedId ?? '' : '',
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [revision, origin.left, origin.top, scale, viewWidth, viewHeight, isDark, xray, selectedId, normalMode]);
  return <div ref={host} className="cp-campus-light-host" aria-hidden="true">
    {CHANNELS.map(channel => <canvas key={channel} hidden className="cp-campus-light" data-campus-channel={channel} />)}
  </div>;
}
