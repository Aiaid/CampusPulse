import { lazy, Suspense, useCallback, useState } from 'react';
import CanvasNightLighting from './CanvasNightLighting';
import LibraryLightingLayer from './LibraryLightingLayer';
import CampusLightingLayer from './CampusLightingLayer';
import LampFixtures from './LampFixtures';
import './night-lighting.css';

// The GIS raster and actor/interaction layers stay in their existing renderers.
// Load the GPU effects only when enhanced night appearance is actually needed.
const PixiLightLayer = lazy(() => import('./PixiLightLayer').catch(() => ({
  default: props => <CanvasNightLighting {...props} renderer="canvas-fallback" />,
})));

export default function NightLighting(props) {
  const [gpuFailed, setGpuFailed] = useState(false);
  const onFailure = useCallback(() => setGpuFailed(true), []);
  const campus = props.lighting === 'campus';
  const localLibrary = props.lighting === 'library' || campus;
  const baseline = { ...props, lighting: localLibrary ? 'atmospheric' : props.lighting, suppressLibrary: localLibrary };
  const layer = !props.isDark || props.lighting === 'original' || gpuFailed
    ? <CanvasNightLighting {...baseline} renderer={gpuFailed ? 'canvas-fallback' : 'canvas-original'} />
    : <Suspense fallback={<CanvasNightLighting {...baseline} renderer="canvas-loading" />}>
      <PixiLightLayer {...baseline} onFailure={onFailure} />
    </Suspense>;
  // The campus material channels own their receivers. A second broad screen
  // glow underneath can still wash unmodeled GIS crowns through transparent
  // gaps, so this mode falls back to the graded source raster alone.
  return <>{!campus && layer}{localLibrary && props.isDark && <LibraryLightingLayer {...props} />}
    {campus && props.isDark && <CampusLightingLayer {...props} />}
    {props.isDark && props.lighting !== 'original' && <LampFixtures {...props} />}</>;
}
