import { prepareGisMaterial, samplePreparedGisMaterial } from './gis-material.js';
import { libraryBlend, LIBRARY_BOUNDS, screenToWorld } from './library-lighting.js';
import { resolveCampusSurface, sampleCampusLight } from './campus-scene-lighting.js';
import { campusSurfaces, campusVegetationZones } from './campus-scene-data.js';
import { buildings as campusBuildingRegions } from './spatial-scene.js';
import { shadeLinearSceneSurface, shadeSceneSurface } from './surface-lighting.js';
import { sampleTreeMaterial } from './tree-material.js';
import { sampleBuildingMaterial, buildingMaterialState } from './building-material.js';
import { nativeCanopyExclusion, prepareNativeCanopyMask, sampleNativeCanopyMask } from './native-canopy.js';
import { createLightingCheckpoint } from './lighting-task-scheduler.js';
export const NATIVE_CANOPY_HEIGHT = 11;
const nativeExclusionPolygons = [
  [[LIBRARY_BOUNDS.left, LIBRARY_BOUNDS.top], [LIBRARY_BOUNDS.left + LIBRARY_BOUNDS.width, LIBRARY_BOUNDS.top],
    [LIBRARY_BOUNDS.left + LIBRARY_BOUNDS.width, LIBRARY_BOUNDS.top + LIBRARY_BOUNDS.height], [LIBRARY_BOUNDS.left, LIBRARY_BOUNDS.top + LIBRARY_BOUNDS.height]],
  ...campusSurfaces.filter(surface => surface.kind !== 'ground' || ['grass', 'water'].includes(surface.material) || /sports|courts/.test(surface.id)).map(surface => surface.polygon),
  ...campusBuildingRegions.map(building => building.polygon),
];
const clamp01 = value => Math.max(0, Math.min(1, value));

export async function compileCampusChunk({ chunk, source }, { signal, budgetMs = 5 } = {}) {
  const checkpoint = createLightingCheckpoint({ signal, budgetMs });
  checkpoint();
  const sourceStarted = performance.now(), material = prepareGisMaterial(source, source);
  if (!material) return null;
  const started = performance.now(), sourceMs = started - sourceStarted;
  const { resolution } = chunk, width = chunk.width * resolution, height = chunk.height * resolution;
  const channels = chunk.diagnostic ? ['ground', 'tree', 'building', 'normals'] : ['ground', 'tree', 'building'];
  const pixels = Object.fromEntries(channels.map(channel => [channel, new Uint8ClampedArray(width * height * 4)]));
  const nativeMask = prepareNativeCanopyMask(material, {
    excludedAt: nativeCanopyExclusion(nativeExclusionPolygons, material.bounds),
    vegetationAt: nativeCanopyExclusion(campusVegetationZones, material.bounds),
  });
  const nativeResolution = material.resolution;
  const nativeWidth = chunk.width * nativeResolution, nativeHeight = chunk.height * nativeResolution;
  const nativePixels = new Uint8ClampedArray(nativeWidth * nativeHeight * 4);
  const buildingIds = new Uint16Array(width * height), buildings = [''];
  const surfaceIds = new Set(), receiverPixels = { ground: 0, tree: 0, roof: 0, wall: 0 };
  let sourcePixels = 0, emissionPixels = 0, nativeCanopyPixels = 0, nativeMaskPixels = 0;
  for (let py = 0; py < height; py++) {
    const pause = checkpoint(); if (pause) await pause;
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
        if (nativeResolution === resolution) {
          nativePixels.set([255, 255, 255, Math.round(alpha * 255)], (py * width + px) * 4);
          nativeMaskPixels++;
        }
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
      if (pixels.normals) pixels.normals.set([...hit.normal.map(value => Math.round((value * .5 + .5) * 255)), Math.round(alpha * 255)], offset);
      if (channel === 'building') {
        const id = hit.surface?.buildingId ?? hit.buildingId ?? hit.id;
        let buildingIndex = buildings.indexOf(id);
        if (buildingIndex < 0) { buildings.push(id); buildingIndex = buildings.length - 1; }
        buildingIds[index] = buildingIndex;
      }
      surfaceIds.add(hit.id); receiverPixels[hit.kind] = (receiverPixels[hit.kind] ?? 0) + 1;
    }
  }
  // Actor/fixture occlusion retains the original source-resolution alpha even
  // when the color lighting uses fewer receiver pixels. Resolve only positive
  // native candidates; this pass does no irradiance, shadows or color shading.
  if (nativeResolution !== resolution) for (let py = 0; py < nativeHeight; py++) {
    const pause = checkpoint(); if (pause) await pause;
    for (let px = 0; px < nativeWidth; px++) {
      const x = chunk.left + (px + .5) / nativeResolution, y = chunk.top + (py + .5) / nativeResolution;
      const native = sampleNativeCanopyMask(nativeMask, x, y);
      if (!native?.coverage) continue;
      const retained = 1 - libraryBlend(x, y);
      if (retained <= 0) continue;
      const hit = resolveCampusSurface(x, y);
      if (hit && hit.kind !== 'ground') continue;
      const sample = samplePreparedGisMaterial(material, x, y, { kind: 'canopy', targetY: .16, normalizationStrength: .4 });
      if (!sample || sample.alpha <= 0) continue;
      const alpha = retained * clamp01(native.coverage) * sample.alpha;
      nativePixels.set([255, 255, 255, Math.round(alpha * 255)], (py * nativeWidth + px) * 4);
      nativeMaskPixels++;
    }
  }
  return { ...chunk, widthPixels: width, heightPixels: height, pixels, buildingIds, buildings,
    nativeWidth, nativeHeight, nativePixels: nativeMaskPixels ? nativePixels : null,
    stats: { sourcePixels, emissionPixels, nativeCanopyPixels, nativeMaskPixels, receiverPixels, surfaceCount: surfaceIds.size, sourceMs,
      compileMs: Math.round((performance.now() - started) * 10) / 10 } };
}
