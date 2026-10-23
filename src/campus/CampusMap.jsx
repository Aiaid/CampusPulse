import { MapPin, Elevator } from "@phosphor-icons/react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { getMetrics, MAP_HEIGHT, MAP_WIDTH, places, sceneAttribution } from './scene-data';
import { buildings, pointInPolygon } from './spatial-scene';
import ActivityLayer from './ActivityLayer';
import NightLighting from './NightLighting';
import MapRegions, { useBuildingMask } from './MapRegions';
import './campus-map.css';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const DEFAULT_VIEW = { zoom: 1, x: 0, y: 0 };
const TILE_ORIGIN = (import.meta.env.VITE_GIS_TILE_ORIGIN || 'https://gis.ccnu.edu.cn').replace(/\/$/, '');
// 256px zoom-3 originals occupy 128px in this registered 1024x640 extent.
const TILES = Array.from({ length: 40 }, (_, index) => ({
  col: 10 + index % 8, row: 7 + Math.floor(index / 8),
  x: (index % 8) * 128, y: Math.floor(index / 8) * 128,
}));

/** Independently pannable official remote tiles with registered mock activity. */
export const CampusMap = forwardRef(function CampusMap({
  selectedId = 'library', onSelect = () => {},
  layers = { people: true, bikes: true, waits: true }, minute = 1200, isDark = false, onZoomChange, maxZoom = 4, xray = false, moving = true, demo = true, lighting = 'atmospheric',
}, ref) {
  const container = useRef(null);
  const drag = useRef(null);
  const suppressClick = useRef(false);
  const [size, setSize] = useState({ width: 1024, height: 640 });
  const [view, setView] = useState(DEFAULT_VIEW);
  const [dragging, setDragging] = useState(false);
  const [failedTiles, setFailedTiles] = useState(() => new Set());
  const [tileAttempt, setTileAttempt] = useState(0);
  const viewRef = useRef(view);
  const sizeRef = useRef(size);
  const focusedPlace = useRef(null);
  const buildingMask = useBuildingMask(xray, selectedId);
  viewRef.current = view;
  sizeRef.current = size;
  useEffect(() => { onZoomChange?.(view.zoom); }, [view.zoom, onZoomChange]);

  const bounded = useCallback((next, dimensions = sizeRef.current) => {
    const zoom = clamp(next.zoom, 1, maxZoom);
    const base = Math.max(dimensions.width / MAP_WIDTH, dimensions.height / MAP_HEIGHT);
    const limitX = Math.max(0, (MAP_WIDTH * base * zoom - dimensions.width) / 2);
    const limitY = Math.max(0, (MAP_HEIGHT * base * zoom - dimensions.height) / 2);
    return { zoom, x: clamp(next.x, -limitX, limitX), y: clamp(next.y, -limitY, limitY) };
  }, [maxZoom]);

  const centerPlace = useCallback((placeId, zoom = 1.7, dimensions = sizeRef.current, offset = { x: 0, y: 0 }) => {
    const place = places.find((item) => item.id === placeId);
    if (!place) return;
    const safeZoom = clamp(zoom, 1, maxZoom);
    const scale = Math.max(dimensions.width / MAP_WIDTH, dimensions.height / MAP_HEIGHT) * safeZoom;
    focusedPlace.current = { id: placeId, offset };
    setView(bounded({ zoom: safeZoom, x: (MAP_WIDTH / 2 - place.x - offset.x) * scale, y: (MAP_HEIGHT / 2 - place.y - offset.y) * scale }, dimensions));
  }, [bounded, maxZoom]);

  useLayoutEffect(() => {
    const element = container.current;
    const resize = () => {
      const dimensions = { width: Math.max(element.clientWidth, 1), height: Math.max(element.clientHeight, 1) };
      sizeRef.current = dimensions;
      setSize(dimensions);
      if (focusedPlace.current) centerPlace(focusedPlace.current.id, viewRef.current.zoom, dimensions, focusedPlace.current.offset);
      else setView((current) => bounded(current, dimensions));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [bounded, centerPlace]);

  const changeZoom = useCallback((factor, screenX, screenY) => {
    focusedPlace.current = null;
    setView((current) => {
      const { width, height } = sizeRef.current;
      const zoom = clamp(current.zoom * factor, 1, maxZoom);
      const ratio = zoom / current.zoom;
      const dx = (screenX ?? width / 2) - width / 2;
      const dy = (screenY ?? height / 2) - height / 2;
      return bounded({ zoom, x: dx - (dx - current.x) * ratio, y: dy - (dy - current.y) * ratio });
    });
  }, [bounded, maxZoom]);

  useImperativeHandle(ref, () => ({
    zoomIn: () => changeZoom(1.25),
    zoomOut: () => changeZoom(.8),
    reset: () => { focusedPlace.current = null; setView(DEFAULT_VIEW); },
    focusPlace: (id, zoom, offset) => centerPlace(id, zoom, sizeRef.current, offset),
  }), [centerPlace, changeZoom]);

  useEffect(() => {
    const element = container.current;
    const wheel = (event) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      changeZoom(Math.exp(-clamp(event.deltaY, -120, 120) * .0025), event.clientX - rect.left, event.clientY - rect.top);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [changeZoom]);

  const startPan = (event) => {
    if (event.button !== 0 || event.target.closest('button')) return;
    focusedPlace.current = null;
    suppressClick.current = false;
    drag.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, start: viewRef.current };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const movePan = (event) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - current.clientX, event.clientY - current.clientY) > 5) suppressClick.current = true;
    setView(bounded({ ...current.start, x: current.start.x + event.clientX - current.clientX, y: current.start.y + event.clientY - current.clientY }));
  };
  const endPan = (event) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const keyboardPan = (event) => {
    if (event.target !== event.currentTarget) return;
    const delta = { ArrowLeft: [65, 0], ArrowRight: [-65, 0], ArrowUp: [0, 65], ArrowDown: [0, -65] }[event.key];
    if (delta) {
      event.preventDefault();
      focusedPlace.current = null;
      setView((current) => bounded({ ...current, x: current.x + delta[0], y: current.y + delta[1] }));
    } else if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(1.25); }
    else if (event.key === '-') { event.preventDefault(); changeZoom(.8); }
    else if (event.key === 'Home') { event.preventDefault(); focusedPlace.current = null; setView(DEFAULT_VIEW); }
  };

  const scale = Math.max(size.width / MAP_WIDTH, size.height / MAP_HEIGHT) * view.zoom;
  const translateX = (size.width - MAP_WIDTH * scale) / 2 + view.x;
  const translateY = (size.height - MAP_HEIGHT * scale) / 2 + view.y;
  const project = (x, y) => ({ left: x * scale + translateX, top: y * scale + translateY });
  const selectRegion = event => {
    if (suppressClick.current || event.target.closest('button')) return;
    const box = container.current.getBoundingClientRect();
    const point = [(event.clientX - box.left - translateX) / scale, (event.clientY - box.top - translateY) / scale];
    const hit = buildings.find(b => b.placeId && pointInPolygon(point, b.polygon));
    if (hit && places.some(p => p.id === hit.placeId)) onSelect(hit.placeId);
  };

  return (
    <div ref={container} className={`cp-map ${isDark ? 'cp-map--night' : 'cp-map--day'} ${dragging ? 'cp-map--dragging' : ''} cp-map--lighting-${lighting}`} data-lighting-mode={lighting} data-demo={demo ? 'true' : 'false'}
      tabIndex={0} role="region" aria-label="华中师范大学校园活动示意地图，可拖动或用方向键平移，加减键缩放"
      onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onClick={selectRegion}
      onLostPointerCapture={() => { drag.current = null; setDragging(false); }} onKeyDown={keyboardPan}>
      <div className="cp-map__raster" role="img" aria-label="华中师范大学公开校园 GIS 在线图块"
        style={{ width: MAP_WIDTH, height: MAP_HEIGHT, transform: `translate3d(${translateX}px, ${translateY}px, 0) scale(${scale})`, maskImage: buildingMask, WebkitMaskImage: buildingMask, maskSize: '100% 100%', WebkitMaskSize: '100% 100%' }}>
        {TILES.filter(tile => (tile.x + 128) * scale + translateX >= -128 && tile.x * scale + translateX <= size.width + 128 && (tile.y + 128) * scale + translateY >= -128 && tile.y * scale + translateY <= size.height + 128).map(tile => {
          const key = `${tile.col}_${tile.row}`;
          return <img key={`${tileAttempt}-${key}`} className="cp-map__tile" src={`${TILE_ORIGIN}/mapdata/zoom3/${key}.jpg`} alt="" draggable={false}
            onError={() => setFailedTiles(current => new Set(current).add(key))}
            onLoad={() => setFailedTiles(current => { if (!current.has(key)) return current; const next = new Set(current); next.delete(key); return next; })}
            style={{ left: tile.x, top: tile.y, visibility: failedTiles.has(key) ? 'hidden' : 'visible' }} />;
        })}
      </div>
      <div className="cp-map__atmosphere" aria-hidden="true" />
      <ActivityLayer project={project} scale={scale} translateX={translateX} translateY={translateY} viewWidth={size.width} viewHeight={size.height} layers={layers} minute={minute} isDark={isDark} xray={xray} moving={moving} selectedId={selectedId} demo={demo} />
      <NightLighting project={project} scale={scale} viewWidth={size.width} viewHeight={size.height} isDark={isDark} xray={xray} selectedId={selectedId} lighting={lighting} />
      <MapRegions project={project} viewWidth={size.width} viewHeight={size.height} selectedId={selectedId} xray={xray} />
      <div className="cp-map__landmarks">
        {places.map((place) => {
          const selected = selectedId === place.id;
          const metrics = getMetrics(place.id, minute);
          const screen = project(place.x, place.y);
          const visible = screen.left >= 12 && screen.left <= size.width - 12 && screen.top >= 25 && screen.top <= size.height - 65;
          const labelShift = clamp(screen.left, 75, size.width - 75) - screen.left;
          return <div className={`cp-map__anchor ${selected ? 'cp-map__anchor--selected' : ''}`} key={place.id} style={screen} data-source-id={place.sourceId} aria-hidden={!visible}>
            {selected && <span className="cp-map__selection" aria-hidden="true"><MapPin size={31} weight="fill" /></span>}
            <button className="cp-map__label" type="button" tabIndex={visible ? 0 : -1} style={{ left: visible ? labelShift : 0 }} onClick={() => onSelect(place.id)} aria-pressed={selected} aria-label={`${place.name}，查看区域活动${selected ? '，已选择' : ''}`}>
              {selected && <span className="cp-map__label-dot" aria-hidden="true" />}{place.name}
            </button>
            {demo && layers.waits && metrics.wait !== null && (selected || place.id === 'tianjiabing' || place.id === 'teaching-9') && <span className="cp-map__wait" title="候梯为合成示意，未核实楼栋是否有电梯"><Elevator size={14} aria-hidden="true" /> 候梯 约{metrics.wait}分钟 <small>模拟</small></span>}
          </div>;
        })}
      </div>
      {failedTiles.size > 0 && <div className="cp-map__tile-notice" role="status">部分学校 GIS 图块暂不可用，地点与图层操作仍可使用。<button type="button" onClick={() => { setFailedTiles(new Set()); setTileAttempt(value => value + 1); }}>重试图块</button></div>}
      <span className="cp-map__source" title={sceneAttribution.notice}>底图：华师校园 GIS 在线图块　/　{demo ? '活动合成示意' : '无实时活动数据'}</span>
    </div>
  );
});
export default CampusMap;
