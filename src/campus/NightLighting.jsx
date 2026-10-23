import { lazy, Suspense, useCallback, useState } from 'react';
import CanvasNightLighting from './CanvasNightLighting';
import './night-lighting.css';

// The GIS raster and actor/interaction layers stay in their existing renderers.
// Load the GPU effects only when enhanced night appearance is actually needed.
const PixiLightLayer = lazy(() => import('./PixiLightLayer').catch(() => ({
  default: props => <CanvasNightLighting {...props} renderer="canvas-fallback" />,
})));

export default function NightLighting(props) {
  const [gpuFailed, setGpuFailed] = useState(false);
  const onFailure = useCallback(() => setGpuFailed(true), []);
  if (!props.isDark || props.lighting === 'original' || gpuFailed) {
    return <CanvasNightLighting {...props} renderer={gpuFailed ? 'canvas-fallback' : 'canvas-original'} />;
  }
  return <Suspense fallback={<CanvasNightLighting {...props} renderer="canvas-loading" />}>
    <PixiLightLayer {...props} onFailure={onFailure} />
  </Suspense>;
}
