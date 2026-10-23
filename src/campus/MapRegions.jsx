import { useEffect, useMemo, useRef } from 'react';
import { buildings } from './spatial-scene';
import { MAP_HEIGHT, MAP_WIDTH } from './scene-data';

// This alpha mask is generated from registered GIS polygons, not new map art.
// It reveals no imagined ground/interior: faded pixels expose the map surface.
export function useBuildingMask(xray, selectedId) {
  return useMemo(() => {
    if (!xray) return undefined;
    const regions = buildings.filter(b => b.placeId === selectedId);
    if (!regions.length) return undefined;
    const canvas = document.createElement('canvas');
    canvas.width = MAP_WIDTH * 2; canvas.height = MAP_HEIGHT * 2;
    const context = canvas.getContext('2d');
    context.scale(2, 2);
    context.fillStyle = '#fff'; context.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    context.globalCompositeOperation = 'destination-out';
    context.fillStyle = 'rgba(0,0,0,.84)';
    // A single compound fill avoids multiplying opacity across overlapping parts.
    context.beginPath();
    for (const region of regions) {
      region.polygon.forEach(([x, y], i) => i ? context.lineTo(x, y) : context.moveTo(x, y));
      context.closePath();
    }
    context.fill();
    return `url(${canvas.toDataURL('image/png')})`;
  }, [xray, selectedId]);
}

export default function MapRegions({ project, viewWidth, viewHeight, selectedId, xray }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current, ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(viewWidth * ratio); canvas.height = Math.round(viewHeight * ratio);
    const context = canvas.getContext('2d');
    context.scale(ratio, ratio);
    context.clearRect(0, 0, viewWidth, viewHeight);
    const selected = buildings.filter(b => b.placeId === selectedId);
    for (const region of selected) {
      context.beginPath();
      region.polygon.forEach(([x, y], i) => { const p = project(x, y); if (i) context.lineTo(p.left, p.top); else context.moveTo(p.left, p.top); });
      context.closePath();
      context.lineWidth = 1.25;
      context.strokeStyle = xray ? '#8ad9ed' : '#41c7db';
      context.fillStyle = xray ? '#3bc6e00a' : '#3bc6e008';
      context.setLineDash(region.provenance?.kind?.startsWith('official') ? [] : [3, 3]);
      context.fill(); context.stroke();
    }
    canvas.dataset.regionCount = String(selected.length);
    canvas.dataset.regionSource = selected.some(b => b.sourceId) ? 'official-hover' : 'illustrative';
  }, [project, viewWidth, viewHeight, selectedId, xray]);
  return <canvas ref={ref} className="cp-map__regions" aria-hidden="true" style={{ width: viewWidth, height: viewHeight }} />;
}
