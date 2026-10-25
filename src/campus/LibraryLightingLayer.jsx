import { useEffect, useRef, useState } from 'react';
import { requestLibraryLightAtlas } from './library-light-atlas.js';
import { LIBRARY_BOUNDS } from './library-lighting.js';
import { libraryLightViewport } from './library-light-viewport.js';
import { lightingQualityProfile } from './lighting-quality.js';
import { useLightingQuality } from './lighting-quality-store.js';
import { lightingComputeState } from './lighting-compute-client.js';
import './library-lighting.css';
import { loadTreeMaterial, subscribeTreeMaterial, treeMaterialState } from './tree-material.js';
import { loadBuildingMaterial, subscribeBuildingMaterial, buildingMaterialState } from './building-material.js';
import { loadPavingMaterial, subscribePavingMaterial, pavingMaterialState } from './paving-material.js';
import { loadGisMaterial, subscribeGisMaterial, gisMaterialState } from './gis-material.js';

const LAYERS = [
  ['groundShade', 'shade'], ['buildingShade', 'shade'],
  ['groundTint', 'tint'], ['buildingTint', 'tint'],
  ['groundDiffuse', 'diffuse'], ['buildingDiffuse', 'diffuse'],
  ['groundMaterial', 'material'], ['treeMaterial', 'material'], ['buildingMaterial', 'material'],
  ['buildingFixtureMaterial', 'material'], ['buildingGlazing', 'material'],
  ['emission', 'emission'], ['normals', 'normals'],
];

/** Viewport crops of one static, shared world atlas. Camera updates schedule a
 * single frame; replay does not recompile lighting or start an animation loop.
 */
export default function LibraryLightingLayer({ project, scale, viewWidth, viewHeight,
  isDark = false, xray = false, selectedId = 'library', diagnostic = false }) {
  const host = useRef(null);
  const quality = useLightingQuality();
  const profile = lightingQualityProfile(quality);
  const [materialState, setMaterialState] = useState(treeMaterialState);
  const [facadeState, setFacadeState] = useState(buildingMaterialState);
  const [pavingState, setPavingState] = useState(pavingMaterialState);
  const [gisState, setGisState] = useState(gisMaterialState);
  useEffect(() => {
    const element = host.current;
    const unsubscribe = subscribeTreeMaterial(setMaterialState);
    const unsubscribeFacade = subscribeBuildingMaterial(setFacadeState);
    const unsubscribePaving = subscribePavingMaterial(setPavingState);
    const unsubscribeGis = subscribeGisMaterial(setGisState);
    // Catch a completed load between render and subscription, including when
    // a second map mounts after the first has prepared the shared material.
    setMaterialState(treeMaterialState());
    setFacadeState(buildingMaterialState());
    setPavingState(pavingMaterialState());
    setGisState(gisMaterialState());
    void Promise.all([loadTreeMaterial(), loadBuildingMaterial(), loadPavingMaterial(), loadGisMaterial()]);
    return () => {
      unsubscribe(); unsubscribeFacade(); unsubscribePaving(); unsubscribeGis();
      // Release promptly on day/mode switches instead of waiting for detached
      // canvas objects to be collected after the component has unmounted.
      element?.querySelectorAll('canvas').forEach(canvas => { canvas.width = 0; canvas.height = 0; });
    };
  }, []);
  const frames = useRef(0);
  const origin = project?.(0, 0) ?? { left: 0, top: 0 };
  const normalMode = diagnostic === true || diagnostic === 'normals';
  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    const ratio = Math.min(window.devicePixelRatio || 1, profile.pixelRatioLimit);
    const viewport = libraryLightViewport(LIBRARY_BOUNDS, origin, scale, viewWidth, viewHeight, ratio);
    Object.assign(element.dataset, {
      worldX: String(origin.left), worldY: String(origin.top), worldScale: String(scale),
      quality: profile.id, pixelRatio: String(ratio),
      viewport: viewport ? `${viewport.left},${viewport.top},${viewport.width},${viewport.height}` : 'offscreen',
    });
    // Hidden diagnostic channels and offscreen maps should not retain a display-
    // sized backing store. A zero-sized canvas also avoids the default 300x150
    // allocation before the first atlas becomes ready.
    for (const [name] of LAYERS) {
      const canvas = element.querySelector(`[data-library-channel="${name}"]`);
      const show = Boolean(viewport) && (isDark || normalMode)
        && (normalMode ? name === 'normals' : name !== 'normals');
      canvas.hidden = !show;
      if (!show) {
        if (canvas.width) canvas.width = 0;
        if (canvas.height) canvas.height = 0;
      }
    }
    if (!viewport || (!isDark && !normalMode)) return undefined;
    // Keep the GIS visible while the local asset loads. Compiling a complete
    // fallback here would immediately repeat the same expensive atlas work on
    // success. Failure has revision 0 too, so observe status independently.
    const settled = state => state.status === 'ready' || state.status === 'fallback';
    if (!settled(materialState) || !settled(facadeState) || !settled(pavingState) || !settled(gisState)) return undefined;
    const controller = new AbortController();
    element.dataset.atlasStatus = 'loading';
    let frame = 0;
    // Subscribe in this effect turn, before the prior camera's cancellation
    // microtask runs. Moving the camera must not restart the same world atlas.
    requestLibraryLightAtlas({ quality, diagnostic: normalMode, signal: controller.signal }).then(atlas => {
      if (!element.isConnected || controller.signal.aborted) return;
      frame = requestAnimationFrame(() => {
        if (!element.isConnected || controller.signal.aborted) return;
        element.dataset.atlasStatus = 'ready';
        const { left, top, width, height, pixelWidth, pixelHeight, destination } = viewport;
        const faded = xray && selectedId === 'library';
        for (const [name] of LAYERS) {
          const canvas = element.querySelector(`[data-library-channel="${name}"]`);
          if (canvas.hidden) continue;
          if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
          if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
          canvas.style.left = `${left}px`; canvas.style.top = `${top}px`;
          canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
          const context = canvas.getContext('2d');
          context.setTransform(ratio, 0, 0, ratio, 0, 0);
          context.clearRect(0, 0, width, height);
          // Preserve the global draw rectangle and its sampling phase; the local
          // canvas origin differs by an exact integer number of device pixels.
          context.setTransform(ratio, 0, 0, ratio, -left * ratio, -top * ratio);
          context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
          context.globalAlpha = faded && (name.startsWith('building') || name === 'emission') ? .22 : 1;
          context.drawImage(atlas[name], destination.left, destination.top,
            destination.width, destination.height);
        }
        Object.assign(element.dataset, {
          model: atlas.stats.model, lighting: 'illustrative', renderer: 'cpu-shared-atlas',
          computeBackend: lightingComputeState().fallback ? 'cooperative-main' : 'worker-pool',
          surfaceCount: String(atlas.stats.surfaceCount), treeCount: String(atlas.stats.treeCount),
          receiverCounts: JSON.stringify(atlas.stats.receiverPixels), shadowPixels: String(atlas.stats.shadowPixels),
          indirectPixels: String(atlas.stats.indirectPixels), foliageBouncePixels: String(atlas.stats.foliageBouncePixels),
          maxIndirect: String(atlas.stats.maxIndirect),
          facadePixels: String(atlas.stats.facadePixels), foliageFacadePixels: String(atlas.stats.foliageFacadePixels),
          maxFacade: String(atlas.stats.maxFacade),
          windowCount: String(atlas.stats.windowCount), compileMs: String(atlas.stats.compileMs),
          roomTiers: JSON.stringify(atlas.stats.roomTiers),
          buildingMaterial: atlas.stats.buildingMaterial,
          buildingMaterialPixels: String(atlas.stats.buildingMaterialPixels),
          groundMaterialPixels: String(atlas.stats.groundMaterialPixels), pavingReady: String(atlas.stats.pavingReady),
          pavingMaterial: atlas.stats.pavingMaterial, commonPipeline: atlas.stats.commonPipeline,
          baseDoorPreserved: String(atlas.stats.baseDoorPreserved),
          baseDoorPreservedPixels: String(atlas.stats.baseDoorPreservedPixels),
          preservedDoorReceptionPixels: String(atlas.stats.preservedDoorReceptionPixels),
          sourceMaterialPixels: JSON.stringify(atlas.stats.sourceMaterialPixels),
          sourceMaterial: atlas.stats.sourceMaterial, sourceMaterialReady: String(atlas.stats.sourceMaterialReady),
          sourceSamples: JSON.stringify(atlas.stats.sourceSamples),
          canopyDownlightCount: String(atlas.stats.canopyDownlightCount),
          registeredPaneCount: String(atlas.stats.registeredPaneCount),
          atlas: `${atlas.stats.width}x${atlas.stats.height}`, normal: 'registered-2.5d-screen-projected-diagnostic',
          occlusion: 'ray-tested-height-and-tree-volumes', canopy: atlas.stats.treeMaterial, materialExposure: 'irradiance-driven-warm-absorption-and-reception',
          renderLoop: 'on-demand', renderFrame: String(++frames.current),
          worldX: String(origin.left), worldY: String(origin.top), worldScale: String(scale),
          diagnostic: normalMode ? 'normals' : 'off',
          materialRevision: String(atlas.materialRevision), buildingMaterialRevision: String(facadeState.revision),
          pavingMaterialRevision: String(pavingState.revision),
          gisMaterialRevision: String(gisState.revision),
        });
      });
    }).catch(() => {
      if (!controller.signal.aborted) element.dataset.atlasStatus = 'error';
    });
    return () => { controller.abort(); cancelAnimationFrame(frame); };
  }, [origin.left, origin.top, scale, viewWidth, viewHeight, isDark, xray, selectedId, normalMode, quality,
    materialState.status, materialState.revision, facadeState.status, facadeState.revision, pavingState.status, pavingState.revision,
    gisState.status, gisState.revision]);
  return <div ref={host} className="cp-library-light-host" aria-hidden="true"
    data-material-status={materialState.status} data-building-material-status={facadeState.status}
    data-paving-material-status={pavingState.status} data-gis-material-status={gisState.status}>
    {LAYERS.map(([name, blend]) => <canvas key={name} width={0} height={0} hidden className={`cp-library-light cp-library-light--${blend}`}
      data-library-channel={name} />)}
  </div>;
}
