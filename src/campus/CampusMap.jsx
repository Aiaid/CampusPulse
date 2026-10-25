import { MapPin, Elevator } from "@phosphor-icons/react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useId, useRef, useState } from 'react';
import { getMetrics, MAP_HEIGHT, MAP_WIDTH, places, sceneAttribution } from './scene-data';
import { buildings, pointInPolygon } from './spatial-scene';
import ActivityLayer from './ActivityLayer';
import NightLighting from './NightLighting';
import MapRegions, { useBuildingMask } from './MapRegions';
import { gisTileAvailability, selectTileLevel, visibleGisTiles } from './gis-tiles';
import { boundedMapView, fitMapFrame, minimumMapZoom } from './map-framing';
import { scenePointToGisAnchor } from './place-registry';
import './campus-map.css';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const DEFAULT_VIEW = { zoom: 1, x: 0, y: 0 };
const TILE_ORIGIN = (import.meta.env.VITE_GIS_TILE_ORIGIN || 'https://gis.ccnu.edu.cn').replace(/\/$/, '');

/** Independently pannable official remote tiles with registered mock activity. */
export const CampusMap = forwardRef(function CampusMap({
  selectedId = 'library', onSelect = () => {}, compactSelected = false,
  mapPlaces = places, renderScene = true, onPickGisAnchor,
  layers = { people: true, bikes: true, waits: true }, minute = 1200, scenarioId = 'weekday', isDark = false, onZoomChange, maxZoom = 4, xray = false, moving = true, demo = true, lighting = 'atmospheric',
}, ref) {
  const gradeId = useId().replace(/:/g, '');
  const container = useRef(null);
  const drag = useRef(null);
  const suppressClick = useRef(false);
  const [size, setSize] = useState({ width: 1024, height: 640 });
  const [view, setView] = useState(DEFAULT_VIEW);
  const [dragging, setDragging] = useState(false);
  const [failedTiles, setFailedTiles] = useState(() => new Set());
  const [loadedTiles, setLoadedTiles] = useState(() => new Set());
  const [pixelRatio, setPixelRatio] = useState(() => window.devicePixelRatio || 1);
  const [tileAttempt, setTileAttempt] = useState(0);
  const viewRef = useRef(view);
  const sizeRef = useRef(size);
  const focusedPlace = useRef(null);
  viewRef.current = view;
  sizeRef.current = size;
  useEffect(() => { onZoomChange?.(view.zoom); }, [view.zoom, onZoomChange]);

  const bounded = useCallback((next, dimensions = sizeRef.current) => {
    return boundedMapView(next, dimensions, maxZoom);
  }, [maxZoom]);

  const centerPlace = useCallback((placeId, zoom = 1.7, dimensions = sizeRef.current, offset = { x: 0, y: 0 }) => {
    const place = mapPlaces.find((item) => item.id === placeId);
    if (!place) return;
    const safeZoom = clamp(zoom, minimumMapZoom(dimensions), maxZoom);
    const scale = Math.max(dimensions.width / MAP_WIDTH, dimensions.height / MAP_HEIGHT) * safeZoom;
    focusedPlace.current = { id: placeId, offset };
    setView(bounded({ zoom: safeZoom, x: (MAP_WIDTH / 2 - place.x - offset.x) * scale, y: (MAP_HEIGHT / 2 - place.y - offset.y) * scale }, dimensions));
  }, [bounded, maxZoom, mapPlaces]);

  const frameScene = useCallback((frame, dimensions = sizeRef.current) => {
    const next = fitMapFrame(frame, dimensions, maxZoom);
    if (!next) return;
    focusedPlace.current = { frame };
    setView(bounded(next, dimensions));
  }, [bounded, maxZoom]);

  useLayoutEffect(() => {
    const element = container.current;
    const resize = () => {
      const dimensions = { width: Math.max(element.clientWidth, 1), height: Math.max(element.clientHeight, 1) };
      sizeRef.current = dimensions;
      setSize(dimensions);
      setPixelRatio(window.devicePixelRatio || 1);
      if (focusedPlace.current?.frame) frameScene(focusedPlace.current.frame, dimensions);
      else if (focusedPlace.current) centerPlace(focusedPlace.current.id, viewRef.current.zoom, dimensions, focusedPlace.current.offset);
      else setView((current) => bounded(current, dimensions));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    window.addEventListener('resize', resize);
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); };
  }, [bounded, centerPlace, frameScene]);

  const changeZoom = useCallback((factor, screenX, screenY) => {
    focusedPlace.current = null;
    setView((current) => {
      const { width, height } = sizeRef.current;
      const zoom = clamp(current.zoom * factor, minimumMapZoom(sizeRef.current), maxZoom);
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
    frameScene,
  }), [centerPlace, changeZoom, frameScene]);

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
    else if (event.key === 'Enter' && onPickGisAnchor) {
      event.preventDefault();
      const { width, height } = sizeRef.current;
      const current = viewRef.current;
      const scale = Math.max(width / MAP_WIDTH, height / MAP_HEIGHT) * current.zoom;
      const point = scenePointToGisAnchor({ x: MAP_WIDTH / 2 - current.x / scale, y: MAP_HEIGHT / 2 - current.y / scale });
      if (point) onPickGisAnchor(point);
    }
  };

  const scale = Math.max(size.width / MAP_WIDTH, size.height / MAP_HEIGHT) * view.zoom;
  const translateX = (size.width - MAP_WIDTH * scale) / 2 + view.x;
  const translateY = (size.height - MAP_HEIGHT * scale) / 2 + view.y;
  const tileLevel = selectTileLevel(scale, pixelRatio);
  const tileViewport = { width: size.width, height: size.height, scale, translateX, translateY };
  // Preserve a usable base while fine tiles load, including the school's
  // coarsest fourth level when viewing the wider campus image.
  const baseTiles = visibleGisTiles({ ...tileViewport, level: 4 });
  const standardTiles = tileLevel < 3 ? visibleGisTiles({ ...tileViewport, level: 3 }) : [];
  const detailTiles = tileLevel < 4 ? visibleGisTiles({ ...tileViewport, level: tileLevel }) : [];
  const tiles = [...baseTiles, ...standardTiles, ...detailTiles];
  // Size the graded/masked surface to visible tiles, not the full 24k source.
  // This keeps high-zoom filter surfaces bounded in Safari and other browsers.
  const rasterBounds = tiles.length ? {
    left: Math.min(...tiles.map(tile => tile.x)), top: Math.min(...tiles.map(tile => tile.y)),
    right: Math.max(...tiles.map(tile => tile.x + tile.size)), bottom: Math.max(...tiles.map(tile => tile.y + tile.size)),
  } : { left: 0, top: 0, right: 1, bottom: 1 };
  rasterBounds.width = rasterBounds.right - rasterBounds.left;
  rasterBounds.height = rasterBounds.bottom - rasterBounds.top;
  const buildingMask = useBuildingMask(xray, selectedId, rasterBounds);
  const tileAvailability = gisTileAvailability(
    visibleGisTiles({ ...tileViewport, level: 4, overscan: 0 }),
    [...(tileLevel < 3 ? visibleGisTiles({ ...tileViewport, level: 3, overscan: 0 }) : []),
      ...(tileLevel < 4 ? visibleGisTiles({ ...tileViewport, level: tileLevel, overscan: 0 }) : [])],
    failedTiles, loadedTiles, tileViewport,
  );
  const recordTileLoad = key => {
    setLoadedTiles(current => current.has(key) ? current : new Set(current).add(key));
    setFailedTiles(current => { if (!current.has(key)) return current; const next = new Set(current); next.delete(key); return next; });
  };
  const project = (x, y) => ({ left: x * scale + translateX, top: y * scale + translateY });
  const selectRegion = event => {
    if (suppressClick.current || event.target.closest('button')) return;
    const box = container.current.getBoundingClientRect();
    const point = [(event.clientX - box.left - translateX) / scale, (event.clientY - box.top - translateY) / scale];
    if (onPickGisAnchor) {
      const anchor = scenePointToGisAnchor({ x: point[0], y: point[1] });
      if (anchor) onPickGisAnchor(anchor);
      return;
    }
    if (!renderScene || !demo) return;
    const hit = buildings.find(b => b.placeId && pointInPolygon(point, b.polygon));
    if (hit && mapPlaces.some(p => p.id === hit.placeId)) onSelect(hit.placeId);
  };

  return (
    <div ref={container} className={`cp-map ${isDark ? 'cp-map--night' : 'cp-map--day'} ${dragging ? 'cp-map--dragging' : ''} cp-map--lighting-${lighting}`} style={{ '--cp-night-grade': `url(#${gradeId})` }} data-lighting-mode={lighting} data-demo={demo ? 'true' : 'false'}
      tabIndex={0} role="region" aria-label={onPickGisAnchor ? 'GIS 位置选点地图，点击选点，方向键平移，Enter 选择中心，加减键缩放' : '华中师范大学校园活动示意地图，可拖动或用方向键平移，加减键缩放'}
      onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onClick={selectRegion}
      onLostPointerCapture={() => { drag.current = null; setDragging(false); }} onKeyDown={keyboardPan}>
      <svg width="0" height="0" aria-hidden="true" style={{position:'absolute',pointerEvents:'none'}}>
        <defs><filter id={gradeId} colorInterpolationFilters="sRGB">
          {(lighting === 'library' || lighting === 'campus') && <>
            {/* Flatten only part of the raster's broad daylight exposure. The
                positive floor keeps inverse gamma finite; high-frequency tile
                detail and original alpha survive this compositor-only pass.
                This is approximate illumination normalization, not recovered
                albedo or a GIS pixel read. Original/enhanced stay unchanged. */}
            <feColorMatrix in="SourceGraphic" type="saturate" values="0" result="dayLuminance" />
            <feGaussianBlur in="dayLuminance" stdDeviation="4" edgeMode="duplicate" result="dayExposure" />
            <feComponentTransfer in="dayExposure" result="exposureFloor">
              <feFuncR type="linear" slope=".82" intercept=".18" />
              <feFuncG type="linear" slope=".82" intercept=".18" />
              <feFuncB type="linear" slope=".82" intercept=".18" />
            </feComponentTransfer>
            <feComponentTransfer in="exposureFloor" result="inverseExposure">
              <feFuncR type="gamma" amplitude=".18" exponent="-1" offset="0" />
              <feFuncG type="gamma" amplitude=".18" exponent="-1" offset="0" />
              <feFuncB type="gamma" amplitude=".18" exponent="-1" offset="0" />
              <feFuncA type="linear" slope="0" intercept="1" />
            </feComponentTransfer>
            <feComposite in="SourceGraphic" in2="inverseExposure" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="normalizedDetail" />
            <feColorMatrix in="normalizedDetail" type="matrix" values="4.5 0 0 0 0 0 4.5 0 0 0 0 0 4.5 0 0 0 0 0 1 0" result="normalizedExposure" />
            <feComposite in="SourceGraphic" in2="normalizedExposure" operator="arithmetic" k1="0" k2=".72" k3=".28" k4="0" />
          </>}
          {/* Match the unlit raster background to the common material sky.
              Lamp/room energy stays independent of this night-sky fill. */}
          <feColorMatrix type="matrix" values={(lighting === 'library' || lighting === 'campus')
            ? '.34 .03 .02 0 .008 .02 .38 .05 0 .014 .03 .10 .43 0 .028 0 0 0 1 0'
            : '.42 .03 .02 0 .008 .02 .46 .05 0 .014 .03 .10 .48 0 .028 0 0 0 1 0'} />
          <feComponentTransfer>
            <feFuncR type="gamma" amplitude="1" exponent="1.13" offset="0" />
            <feFuncG type="gamma" amplitude="1" exponent="1.13" offset="0" />
            <feFuncB type="gamma" amplitude="1" exponent="1.13" offset="0" />
          </feComponentTransfer>
        </filter></defs>
      </svg>
      <div className="cp-map__raster" role="img" aria-label="华中师范大学公开校园 GIS 在线图块" data-tile-level={tileLevel} data-detail-fallbacks={tileAvailability.fallback}
        data-scene-left={rasterBounds.left} data-scene-top={rasterBounds.top}
        style={{ width: rasterBounds.width, height: rasterBounds.height, transform: `translate3d(${translateX + rasterBounds.left * scale}px, ${translateY + rasterBounds.top * scale}px, 0) scale(${scale})`, maskImage: buildingMask, WebkitMaskImage: buildingMask, maskSize: '100% 100%', WebkitMaskSize: '100% 100%' }}>
        {tiles.map(tile => <img key={`${tileAttempt}-${tile.key}`} className="cp-map__tile" src={`${TILE_ORIGIN}/mapdata/zoom${tile.key}.jpg`} alt="" draggable={false} data-tile-key={tile.key}
          onError={() => { setFailedTiles(current => new Set(current).add(tile.key)); setLoadedTiles(current => { if (!current.has(tile.key)) return current; const next = new Set(current); next.delete(tile.key); return next; }); }}
          onLoad={() => recordTileLoad(tile.key)}
          style={{ left: tile.x - rasterBounds.left, top: tile.y - rasterBounds.top, width: tile.size, height: tile.size, visibility: failedTiles.has(tile.key) ? 'hidden' : 'visible' }} />)}
      </div>
      <div className="cp-map__atmosphere" aria-hidden="true" />
      {renderScene && <><ActivityLayer project={project} scale={scale} translateX={translateX} translateY={translateY} viewWidth={size.width} viewHeight={size.height} layers={layers} minute={minute} scenarioId={scenarioId} isDark={isDark} xray={xray} moving={moving} selectedId={selectedId} demo={demo} lighting={lighting} detailView={compactSelected} />
      <NightLighting project={project} scale={scale} viewWidth={size.width} viewHeight={size.height} isDark={isDark} xray={xray} selectedId={selectedId} lighting={lighting} />
      {demo && <MapRegions project={project} viewWidth={size.width} viewHeight={size.height} selectedId={selectedId} xray={xray} />}</>}
      <div className="cp-map__landmarks">
        {mapPlaces.map((place) => {
          const selected = selectedId === place.id;
          const metrics = demo ? getMetrics(place.id, minute, scenarioId) : null;
          const screen = project(place.x, place.y);
          const compact = compactSelected && selected;
          const visible = compact || (screen.left >= 12 && screen.left <= size.width - 12 && screen.top >= 25 && screen.top <= size.height - 65);
          const labelShift = clamp(screen.left, 75, size.width - 75) - screen.left;
          return <div className={`cp-map__anchor ${selected ? 'cp-map__anchor--selected' : ''} ${compact ? 'cp-map__anchor--compact' : ''}`} key={place.id} style={compact ? { left: size.width - 12, top: 12 } : screen} data-source-id={place.sourceId} aria-hidden={!visible}>
            {selected && !compact && <span className="cp-map__selection" aria-hidden="true"><MapPin size={31} weight="fill" /></span>}
            <button className="cp-map__label" type="button" tabIndex={visible ? 0 : -1} style={{ left: compact ? 0 : visible ? labelShift : 0 }} onClick={() => onSelect(place.id)} aria-pressed={selected} aria-label={`${place.name}，查看区域活动${selected ? '，已选择' : ''}`}>
              {selected && <span className="cp-map__label-dot" aria-hidden="true" />}{place.name}
            </button>
            {demo && !compactSelected && layers.waits && metrics.wait !== null && (selected || place.id === 'tianjiabing' || place.id === 'teaching-9') && <span className="cp-map__wait" title="候梯为合成示意，未核实楼栋是否有电梯"><Elevator size={14} aria-hidden="true" /> 候梯 约{metrics.wait}分钟 <small>模拟</small></span>}
          </div>;
        })}
      </div>
      {tileAvailability.unavailable > 0 && <div className="cp-map__tile-notice" role="status">部分学校 GIS 图块暂不可用，地点与图层操作仍可使用。<button type="button" onClick={() => { setFailedTiles(new Set()); setLoadedTiles(new Set()); setTileAttempt(value => value + 1); }}>重试图块</button></div>}
      <span className="cp-map__source" title={`${sceneAttribution.notice}${tileAvailability.fallback ? ' 部分精细图块暂不可用，当前区域保留标准底图。' : ''}`}>底图：华师校园 GIS 在线图块{tileAvailability.fallback > 0 ? '（标准清晰度回退）' : ''}　/　{demo ? '活动合成示意' : '无实时活动数据'}</span>
    </div>
  );
});
export default CampusMap;
