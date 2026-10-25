import { useEffect, useRef } from 'react';
import { imageFrames } from './actor-style';

/** Place-attached display sprites; neither individual locations nor headcounts. */
export default function FieldActorLayer({ illustration, point, width, height }) {
  const canvasRef = useRef(null), assets = useRef({}), redraw = useRef(() => {});
  const people = Math.min(40, (illustration?.groups.find(group => group.kind === 'people')?.figure_count || 0) * 2);
  const vehicles = Math.min(16, (illustration?.groups.filter(group => group.kind === 'bikes' || group.kind === 'cars').reduce((sum, group) => sum + group.figure_count, 0) || 0) * 2);
  useEffect(() => {
    for (const [kind, src] of Object.entries({ people: '/assets/person-directions.png', bikes: '/assets/ebike-parked-directions.png' })) {
      const image = new Image(); image.onload = () => redraw.current(); image.src = src; assets.current[kind] = image;
    }
    return () => Object.values(assets.current).forEach(image => { image.onload = null; });
  }, []);
  useEffect(() => {
    redraw.current = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(width * dpr)); canvas.height = Math.max(1, Math.round(height * dpr));
      const ctx = canvas.getContext('2d'); if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
      let visible = 0;
      const draw = (kind, count) => {
        const image = assets.current[kind];
        if (!point || !image?.complete || !image.naturalWidth) return;
        const frames = imageFrames(image); if (!frames) return;
        const padding = Math.min(117, width / 2);
        const anchorX = Math.min(width - padding, Math.max(padding, point.left));
        const minY = 36 + Math.max(0, Math.ceil(people / 5) - 1) * 32 + 36;
        const maxY = height - 37 - Math.max(0, Math.ceil(vehicles / 4) - 1) * 24;
        const anchorY = Math.min(Math.max(minY, maxY), Math.max(minY, point.top));
        for (let index = 0; index < count; index++) {
          const frame = frames[index % 4]; if (!frame || frame.empty) continue;
          const x = anchorX + (kind === 'people' ? (index % 5 - 2) * 25 : [-102, -72, 72, 102][index % 4]);
          const y = anchorY + (kind === 'people' ? -36 - Math.floor(index / 5) * 32 : 29 + Math.floor(index / 4) * 24);
          const h = kind === 'people' ? 28 : 22, w = h * frame.width / frame.height;
          if (x + w / 2 < 0 || x - w / 2 > width || y < 0 || y - h > height) continue;
          ctx.save(); ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.beginPath(); ctx.ellipse(x, y, w * .32, 2, 0, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = .94;
          ctx.drawImage(image, frame.x, frame.y, frame.width, frame.height, x - w / 2, y - h, w, h); ctx.restore(); visible++;
        }
      };
      draw('people', people); draw('bikes', vehicles); canvas.dataset.visibleCount = String(visible);
    };
    redraw.current();
  }, [point?.left, point?.top, width, height, people, vehicles]);
  return <canvas ref={canvasRef} className="cp-field-actors" aria-hidden="true" data-source="observed-activity-illustration"
    data-person-count={people} data-vehicle-count={vehicles} data-display-multiplier="2"
    style={{ position: 'absolute', inset: 0, width, height, zIndex: 3, pointerEvents: 'none' }} />;
}
