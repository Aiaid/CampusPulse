import { useEffect, useMemo, useRef } from 'react';
import { buildings } from './spatial-scene';
import { GIS_SCENE_BOUNDS } from './gis-geometry';

// This alpha mask is generated from registered GIS polygons, not new map art.
// It reveals no imagined ground/interior: faded pixels expose the map surface.
export function useBuildingMask(xray, selectedId, bounds = GIS_SCENE_BOUNDS) {
  const { left, top, width, height } = bounds;
  return useMemo(() => {
    if (!xray) return undefined;
    const regions = buildings.filter(b => b.placeId === selectedId);
    if (!regions.length) return undefined;
    // Match the visible raster surface without allocating a full-grid bitmap.
    // A compound path keeps overlapping building surfaces at the same opacity.
    const path = regions.map(region => region.polygon.map(([x, y], i) =>
      `${i ? 'L' : 'M'}${x - left},${y - top}`).join(' ') + 'Z').join(' ');
    // Use a luminance mask inside the SVG to subtract opacity (black RGB alone
    // does not erase alpha in the CSS image mask).
    const maskSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><mask id="fade" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}" style="mask-type:luminance"><rect width="100%" height="100%" fill="white"/><path d="${path}" fill="black" fill-opacity=".84"/></mask></defs><rect width="100%" height="100%" fill="white" mask="url(#fade)"/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(maskSvg)}")`;
  }, [xray, selectedId, left, top, width, height]);
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
