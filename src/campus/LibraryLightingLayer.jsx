import { useEffect, useRef, useState } from 'react';
import { libraryLightAtlas } from './library-light-atlas.js';
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
  const [materialState, setMaterialState] = useState(treeMaterialState);
  const [facadeState, setFacadeState] = useState(buildingMaterialState);
  const [pavingState, setPavingState] = useState(pavingMaterialState);
  const [gisState, setGisState] = useState(gisMaterialState);
  useEffect(() => {
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
    return () => { unsubscribe(); unsubscribeFacade(); unsubscribePaving(); unsubscribeGis(); };
  }, []);
  const frames = useRef(0);
  const origin = project?.(0, 0) ?? { left: 0, top: 0 };
  const normalMode = diagnostic === true || diagnostic === 'normals';
  useEffect(() => {
    const element = host.current;
    // Keep the GIS visible while the local asset loads. Compiling a complete
    // fallback here would immediately repeat the same expensive atlas work on
    // success. Failure has revision 0 too, so observe status independently.
    const settled = state => state.status === 'ready' || state.status === 'fallback';
    if (!element || !settled(materialState) || !settled(facadeState) || !settled(pavingState) || !settled(gisState)) return undefined;
    const frame = requestAnimationFrame(() => {
      if (!element.isConnected) return;
      const atlas = libraryLightAtlas();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, viewWidth), height = Math.max(1, viewHeight);
      const faded = xray && selectedId === 'library';
      for (const [name] of LAYERS) {
        const canvas = element.querySelector(`[data-library-channel="${name}"]`);
        const show = (isDark || normalMode) && (normalMode ? name === 'normals' : name !== 'normals');
        canvas.hidden = !show;
        if (!show) continue;
        if (canvas.width !== Math.ceil(width * ratio)) canvas.width = Math.ceil(width * ratio);
        if (canvas.height !== Math.ceil(height * ratio)) canvas.height = Math.ceil(height * ratio);
        canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
        const context = canvas.getContext('2d');
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, width, height);
        context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
        context.globalAlpha = faded && (name.startsWith('building') || name === 'emission') ? .22 : 1;
        const { bounds } = atlas;
        context.drawImage(atlas[name], origin.left + bounds.left * scale, origin.top + bounds.top * scale,
          bounds.width * scale, bounds.height * scale);
      }
      Object.assign(element.dataset, {
        model: atlas.stats.model, lighting: 'illustrative', renderer: 'cpu-shared-atlas',
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
    return () => cancelAnimationFrame(frame);
  }, [origin.left, origin.top, scale, viewWidth, viewHeight, isDark, xray, selectedId, normalMode,
    materialState.status, materialState.revision, facadeState.status, facadeState.revision, pavingState.status, pavingState.revision,
    gisState.status, gisState.revision]);
  return <div ref={host} className="cp-library-light-host" aria-hidden="true"
    data-material-status={materialState.status} data-building-material-status={facadeState.status}
    data-paving-material-status={pavingState.status} data-gis-material-status={gisState.status}>
    {LAYERS.map(([name, blend]) => <canvas key={name} hidden className={`cp-library-light cp-library-light--${blend}`}
      data-library-channel={name} />)}
  </div>;
}
