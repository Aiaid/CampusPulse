import { useEffect, useMemo, useRef } from 'react';
import { Crosshair, CornersOut, Minus, Plus } from '@phosphor-icons/react';
import CampusMap from '../campus/CampusMap.jsx';
import { gisAnchorToScene } from '../campus/place-registry.js';
import './gis-place-map.css';

/** The same remote GIS raster/camera used by the public map; no demo activity. */
export default function GisPlaceMap({ places = [], value, onChange, onSelect }) {
  const ref = useRef(null);
  const point = gisAnchorToScene(value);
  const mapPlaces = useMemo(() => onChange
    ? (point ? [{ id: 'picked-location', name: '所选位置', ...point }] : [])
    : places, [places, point?.x, point?.y, !!onChange]);
  useEffect(() => {
    if (mapPlaces.length) ref.current?.focusPlace(mapPlaces[0].id, 1.5);
  }, [!!onChange]);
  return <div className="cp-location-map-wrap">
    <div className="cp-location-map" data-picker={onChange ? 'true' : 'false'}>
      <CampusMap ref={ref} mapPlaces={mapPlaces} selectedId={onChange ? 'picked-location' : null}
        onSelect={onSelect} onPickGisAnchor={onChange} renderScene={false} demo={false} moving={false} lighting="original" maxZoom={12} />
      <div className="cp-location-map-tools" role="group" aria-label="位置地图操作">
        <button type="button" aria-label="放大位置地图" onClick={() => ref.current?.zoomIn()}><Plus size={17} /></button>
        <button type="button" aria-label="缩小位置地图" onClick={() => ref.current?.zoomOut()}><Minus size={17} /></button>
        <button type="button" aria-label="重置位置地图" onClick={() => ref.current?.reset()}><CornersOut size={17} /></button>
        {point && <button type="button" aria-label="定位所选锚点" onClick={() => ref.current?.focusPlace('picked-location', 3)}><Crosshair size={17} /></button>}
      </div>
    </div>
    <p className="cp-location-map-help">{onChange ? '点击底图选点；拖动平移，滚轮或加减按钮缩放。键盘可用方向键移动、Enter 选择地图中心。' : '与前台 GIS 使用相同底图和坐标；点击地点标记可编辑。'}</p>
  </div>;
}
