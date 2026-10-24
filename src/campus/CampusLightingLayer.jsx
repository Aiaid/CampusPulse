import { useEffect, useRef, useState } from 'react';
import { visibleGisTiles } from './gis-tiles.js';
import { campusSurfaces, campusTrees, campusLights } from './campus-scene-data.js';
import { buildings as campusBuildingRegions } from './spatial-scene.js';
import { loadTreeMaterial } from './tree-material.js';
import { loadBuildingMaterial } from './building-material.js';
import { CAMPUS_MATERIAL_HALO, visibleCampusChunks, campusChunkResolution,
  createCampusChunkCache, createCampusImageCache } from './campus-material-cache.js';
import { requestLightingComputation, lightingComputeState } from './lighting-compute-client.js';
import { awaitLightingInput } from './lighting-task-scheduler.js';
import { lightingQualityProfile } from './lighting-quality.js';
import { useLightingQuality, getLightingQuality, subscribeLightingQuality } from './lighting-quality-store.js';
import './campus-lighting.css';

const TILE_ORIGIN = (import.meta.env?.VITE_GIS_TILE_ORIGIN || 'https://gis.ccnu.edu.cn').replace(/\/$/, '');
const CHANNELS = ['ground', 'tree', 'building', 'normals'];
// The retained pixels describe crown tops, above the seven-unit path fixtures.
// A top-facing leaf receiver must not borrow the ellipsoid underside's wrapped
// lobe or be placed below the lamp, which creates yellow ground-light blobs.
const NATIVE_CANOPY_HEIGHT = 11;
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

async function sourceMaterial(chunk, signal) {
  // Retain the existing official source LOD even when receiver/output pixels
  // are reduced. Quality affects the lighting overlay, not source imagery.
  const resolution = chunk.sourceResolution ?? chunk.resolution, halo = CAMPUS_MATERIAL_HALO;
  const bounds = { left: chunk.left - halo, top: chunk.top - halo,
    width: chunk.width + halo * 2, height: chunk.height + halo * 2 };
  const width = bounds.width * resolution, height = bounds.height * resolution;
  const tiles = visibleGisTiles({ level: resolution === 2 ? 2 : 3, width, height, scale: resolution,
    translateX: -bounds.left * resolution, translateY: -bounds.top * resolution, overscan: 0 });
  const loaded = await awaitLightingInput(Promise.all(tiles.map(tile => images.get(tile))), signal);
  if (!loaded.length || loaded.some(image => !image)) return null;
  if (signal?.aborted) return null;
  const canvas = canvasOf(width, height), context = canvas.getContext('2d', { willReadFrequently: true });
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    context.drawImage(loaded[i], (tile.x - bounds.left) * resolution, (tile.y - bounds.top) * resolution,
      tile.size * resolution, tile.size * resolution);
  }
  await yieldToBrowser();
  // Eight map units exceed the six-unit normalization radius. Adjacent chunks
  // therefore see the same source neighborhood at every retained border pixel.
  const source = context.getImageData(0, 0, width, height);
  return { width, height, data: source.data, bounds, resolution };
}

async function compileChunk(chunk, { signal } = {}) {
  await awaitLightingInput(prepareAssets(), signal);
  if (signal?.aborted) return null;
  const started = performance.now(), source = await sourceMaterial(chunk, signal);
  if (!source || signal?.aborted) return null;
  const sourceMs = performance.now() - started;
  const result = await requestLightingComputation('campus', { chunk, source }, { signal });
  const { pixels, nativePixels, ...material } = result;
  const { widthPixels: width, heightPixels: height } = material;
  return { ...material,
    canvases: Object.fromEntries(Object.entries(pixels).map(([channel, data]) => [channel, canvasOf(width, height, data)])),
    nativeCanopyCanvas: nativePixels ? canvasOf(material.nativeWidth, material.nativeHeight, nativePixels) : null,
    // Only building/normal bytes survive canvas creation, for selected-building
    // xray. Ground/tree/native masks live solely in their bounded canvas cache.
    buildingPixels: pixels.building, normalPixels: pixels.normals ?? null, faded: null,
    stats: { ...material.stats, sourceMs: sourceMs + material.stats.sourceMs } };
}

const chunks = createCampusChunkCache({ compile: compileChunk, maxEntries: 64, concurrency: 2 });
const updateChunkBudget = () => {
  const profile = lightingQualityProfile(getLightingQuality());
  chunks.setQualityBudget(profile.id, profile.campusResolutionLimit);
};
updateChunkBudget();
subscribeLightingQuality(updateChunkBudget);

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
  // Both cameras share these immutable loads. Await them before first compile
  // so startup never computes fallback chunks only to invalidate them again.
  assetLoads = Promise.all([loadTreeMaterial(), loadBuildingMaterial()]);
  return assetLoads;
}

function buildingCanvas(chunk, selectedId, normalMode) {
  if (normalMode && !chunk.normalPixels) return null;
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
  const quality = useLightingQuality(), profile = lightingQualityProfile(quality);
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
    const sourceResolution = campusChunkResolution(scale * Math.min(window.devicePixelRatio || 1, 2));
    const resolution = Math.min(sourceResolution, profile.campusResolutionLimit);
    chunks.setViewport(owner.current, isDark || normalMode ? visible : [], resolution,
      { diagnostic: normalMode, quality: profile.id, sourceResolution });
  }, [origin.left, origin.top, scale, viewWidth, viewHeight, isDark, normalMode, quality]);
  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    const frame = requestAnimationFrame(() => {
      const ratio = Math.min(window.devicePixelRatio || 1, profile.pixelRatioLimit), width = Math.max(1, viewWidth), height = Math.max(1, viewHeight);
      const visible = visibleCampusChunks({ width, height, scale, translateX: origin.left, translateY: origin.top });
      const materials = visible.map(chunk => chunks.get(chunk.key)).filter(Boolean);
      for (const channel of CHANNELS) {
        const canvas = element.querySelector(`[data-campus-channel="${channel}"]`);
        canvas.hidden = !(isDark || normalMode) || (normalMode ? channel !== 'normals' : channel === 'normals');
        if (canvas.hidden) { if (canvas.width) canvas.width = 0; if (canvas.height) canvas.height = 0; continue; }
        if (canvas.width !== Math.ceil(width * ratio)) canvas.width = Math.ceil(width * ratio);
        if (canvas.height !== Math.ceil(height * ratio)) canvas.height = Math.ceil(height * ratio);
        canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
        const context = canvas.getContext('2d'); context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, width, height); context.imageSmoothingEnabled = true;
        for (const material of materials) {
          const image = xray && (channel === 'building' || channel === 'normals')
            ? buildingCanvas(material, selectedId, channel === 'normals') : material.canvases[channel];
          if (!image) continue;
          context.drawImage(image, origin.left + material.left * scale, origin.top + material.top * scale,
            material.width * scale, material.height * scale);
        }
      }
      const state = chunks.snapshot();
      Object.assign(element.dataset, { lighting: 'illustrative', renderer: 'cpu-shared-viewport-chunks', computeBackend: lightingComputeState().fallback ? 'cooperative-main' : 'worker-pool',
        model: 'campus-shared-linear-2.5d', renderLoop: 'on-demand', renderFrame: String(++frames.current),
        materialStatus: state.ready === state.visible && state.visible ? 'ready' : state.running ? 'loading' : 'fallback',
        sourceMaterial: 'runtime-official-gis-approximate-reflectance', sourceMaterialReady: String(materials.length > 0),
        chunkCount: String(state.entries), visibleChunks: String(visible.length), readyChunks: String(materials.length),
        quality: profile.id, pixelRatio: String(ratio),
        chunkResolution: String(Math.min(campusChunkResolution(scale * Math.min(window.devicePixelRatio || 1, 2)), profile.campusResolutionLimit)),
        detailChunks: String(state.detail),
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
  }, [revision, origin.left, origin.top, scale, viewWidth, viewHeight, isDark, xray, selectedId, normalMode, quality]);
  return <div ref={host} className="cp-campus-light-host" aria-hidden="true">
    {CHANNELS.map(channel => <canvas key={channel} hidden className="cp-campus-light" data-campus-channel={channel} />)}
  </div>;
}
