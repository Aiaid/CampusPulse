import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Buildings, MapPin, MagnifyingGlass, Moon, Sun, CaretDown, X, Play, Pause, PersonSimpleWalk, Moped, Elevator, Plus, Minus, CornersOut, Crosshair, ArrowUpRight, ArrowDownRight, ArrowRight, Clock, Info, ArrowLeft, Check, SlidersHorizontal, Radio } from '@phosphor-icons/react';
import CampusMap from './CampusMap';
import { places, getMetrics, simulationScenarios, simulationTimes } from './scene-data';
import SimulationControls from './SimulationControls';
import { buildings } from './spatial-scene';
import { libraryDetailFrame } from './map-framing';
import { campusPlaceFrames } from './campus-scene-data';
import './scene-controls.css';
import Observations from './Observations';
import { fieldPlaceRegistry } from './place-registry';
import { useLightingQuality, setLightingQuality } from './lighting-quality-store';

const timeText = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const band = value => value >= 75 ? '密集' : value >= 55 ? '较密' : value >= 30 ? '中等' : '稀疏';
const layerDefs = [{ key: 'people', label: '行人活动', Icon: PersonSimpleWalk }, { key: 'bikes', label: '电动车活动', Icon: Moped }, { key: 'waits', label: '候梯', Icon: Elevator }];
const dateText = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric' }).format(new Date());
const yearText = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date());
const presets = [{ label: '上午', minute: 540 }, { label: '课间', minute: 600 }, { label: '午餐', minute: 720 }, { label: '晚间', minute: 1200 }];
function TrendIcon({ trend }) { return trend === 'up' ? <ArrowUpRight /> : trend === 'down' ? <ArrowDownRight /> : <ArrowRight />; }

export function App({ defaultMode = 'demo', siteName = 'CampusPulse' } = {}) {
  const lightingQuality = useLightingQuality();
  const [requestedPlaceId] = useState(() => typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('place') || '');
  const [demo, setDemo] = useState(() => !requestedPlaceId && defaultMode === 'demo');
  const [fieldCatalog, setFieldCatalog] = useState({ places: [], loading: true, error: '' });
  const fieldRegistry = useMemo(() => fieldPlaceRegistry(fieldCatalog.places), [fieldCatalog.places]);
  const mapPlaces = demo ? places : fieldRegistry.mapPlaces;
  const [lighting, setLighting] = useState('campus');
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [clockMinute, setClockMinute] = useState(() => new Date().getHours() * 60 + new Date().getMinutes());
  const closeRecords = useCallback(() => setRecordsOpen(false), []);
  const openRecords = () => { changeMode(false); setSceneSettingsOpen(false); setRecordsOpen(true); };
  const changeMode = value => {
    selectionByMode.current[demo ? 'demo' : 'field'] = selectedId;
    setSelectedId(selectionByMode.current[value ? 'demo' : 'field']);
    setDemo(value); setPlaying(false); setTrendOpen(false);
  };
  const [selectedId, setSelectedId] = useState(requestedPlaceId || 'library');
  const selectionByMode = useRef({ demo: 'library', field: requestedPlaceId || '' });
  const [detailOpen, setDetailOpen] = useState(true);
  const [theme, setTheme] = useState('auto');
  const [minute, setMinute] = useState(1200);
  const [scenarioId, setScenarioId] = useState('weekday');
  const scenario = simulationScenarios.find(item => item.id === scenarioId) ?? simulationScenarios[0];
  const changeScenario = id => { setScenarioId(id); setPlaying(false); };
  const parkingBand = value => value >= 75 ? '较满' : value >= 45 ? '适中' : '较少';
  const [layers, setLayers] = useState({ people: true, bikes: true, waits: true });
  const [playing, setPlaying] = useState(false);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [trendOpen, setTrendOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [detailZoom, setDetailZoom] = useState(6);
  const [xray, setXray] = useState(false);
  const [motionEnabled, setMotionEnabled] = useState(true);
  const [sceneSettingsOpen, setSceneSettingsOpen] = useState(false);
  const sceneSettingsRef = useRef(null), sceneSettingsButtonRef = useRef(null);
  const mapRef = useRef(null), detailRef = useRef(null), searchRef = useRef(null), dialogRef = useRef(null);
  const pendingRequestedPlace = useRef(requestedPlaceId);
  const selected = mapPlaces.find(p => p.id === selectedId) || (demo ? places[0] : null);
  const metrics = demo ? getMetrics((selected || places[0]).id, minute, scenarioId) : null;
  const canXray = demo && buildings.some(building => building.placeId === selectedId);
  const isDark = theme === 'dark' || (theme === 'auto' && ((demo ? minute : clockMinute) >= 1080 || (demo ? minute : clockMinute) < 420));
  const searchResults = mapPlaces.filter(p => !query.trim() || `${p.name} ${p.id} ${p.subtitle}`.toLowerCase().includes(query.trim().toLowerCase()));
  const outsideMapCount = fieldRegistry.unlocatedPlaces.filter(place => place.mapUnavailableReason === 'outside-map').length;
  const fieldStatus = fieldCatalog.loading ? '正在读取现场地点…' : fieldCatalog.error || `已定位 ${fieldRegistry.mapPlaces.length} 个现场地点 · ${fieldRegistry.unlocatedPlaces.length} 个地点未显示${outsideMapCount ? `（其中 ${outsideMapCount} 个超出当前地图范围）` : ''}`;
  useEffect(() => {
    if (demo) return;
    let controller;
    const refresh = async () => {
      controller?.abort();
      controller = new AbortController();
      const requestController = controller;
      try {
        const response = await fetch('/api/v1/places', { signal: requestController.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('Places service unavailable');
        const body = await response.json();
        if (!Array.isArray(body.places)) throw new Error('Invalid places response');
        if (!requestController.signal.aborted) setFieldCatalog({ places: body.places, loading: false, error: '' });
      } catch (problem) {
        if (!requestController.signal.aborted) setFieldCatalog({ places: [], loading: false, error: '现场地点服务暂不可用，请稍后重试；地图未使用演示地点替代。' });
      }
    };
    setFieldCatalog(current => ({ ...current, loading: true, error: '' }));
    refresh();
    const timer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => { controller?.abort(); clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [demo]);
  useEffect(() => {
    if (!demo && (fieldCatalog.loading || fieldCatalog.error)) return;
    const requested = !demo ? pendingRequestedPlace.current : '';
    setSelectedId(current => mapPlaces.some(place => place.id === requested) ? requested : mapPlaces.some(place => place.id === current) ? current : mapPlaces[0]?.id || '');
    if (!demo) pendingRequestedPlace.current = '';
  }, [mapPlaces, demo, fieldCatalog.loading, fieldCatalog.error]);
  useEffect(() => {
    if (!demo && selected) mapRef.current?.focusPlace(selected.id, 1.35);
  }, [demo, selected?.id, selected?.x, selected?.y]);
  useEffect(() => {
    if (!selected) return;
    const id = setTimeout(() => {
      if (demo && lighting === 'campus' && campusPlaceFrames[selectedId]) detailRef.current?.frameScene(campusPlaceFrames[selectedId]);
      else if (demo && selectedId === 'library') detailRef.current?.frameScene(libraryDetailFrame);
      else detailRef.current?.focusPlace(selectedId, 6, { x: -20, y: 35 });
    }, 80);
    return () => clearTimeout(id);
  }, [selectedId, selected?.x, selected?.y, detailOpen, trendOpen, lighting, demo]);
  useEffect(() => { const id = setInterval(() => setClockMinute(new Date().getHours() * 60 + new Date().getMinutes()), 30000); return () => clearInterval(id); }, []);
  useEffect(() => { if (!demo || !playing) return; const id = setInterval(() => setMinute(m => m >= 1320 ? 420 : m + 5), 1000); return () => clearInterval(id); }, [playing, demo]);
  useEffect(() => {
    if (!sceneSettingsOpen) return;
    const closeOutside = event => { if (!sceneSettingsRef.current?.contains(event.target)) setSceneSettingsOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [sceneSettingsOpen]);
  useEffect(() => { if (noticeOpen) setSceneSettingsOpen(false); }, [noticeOpen]);
  useEffect(() => {
    if (!noticeOpen) return;
    const previous = document.activeElement;
    const dialog = dialogRef.current;
    dialog?.querySelector('button')?.focus();
    const keepFocus = event => {
      if (event.key !== 'Tab') return;
      const buttons = dialog?.querySelectorAll('button');
      if (!buttons?.length) return;
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    dialog?.addEventListener('keydown', keepFocus);
    return () => { dialog?.removeEventListener('keydown', keepFocus); previous?.focus(); };
  }, [noticeOpen]);
  useEffect(() => { const keydown = e => { if (e.key === 'Escape') { setSearchOpen(false); setNoticeOpen(false); } if (!document.querySelector('[role=dialog]') && (e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); searchRef.current?.focus(); } }; window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown); }, []);
  const selectPlace = id => { setSelectedId(id); setDetailOpen(true); setTrendOpen(false); setSearchOpen(false); setQuery(''); mapRef.current?.focusPlace(id, 1.35); };
  const zoom = change => change > 0 ? mapRef.current?.zoomIn() : mapRef.current?.zoomOut();
  return <main className={`campus-app ${isDark ? 'dark' : 'light'}`}>
    <div className="app-content" inert={noticeOpen || recordsOpen ? true : undefined}><div className={`map-layout ${detailOpen ? "detail-visible" : ""}`}><div className="overview-map" aria-label="校园总览地图"><CampusMap ref={mapRef} selectedId={selectedId} mapPlaces={mapPlaces} onSelect={selectPlace} layers={layers} minute={demo ? minute : clockMinute} scenarioId={scenarioId} isDark={isDark} xray={canXray && xray} moving={demo && motionEnabled} demo={demo} lighting={lighting} /></div></div>
    <header className="topbar">
      <a className="brand" href="#" aria-label={`${siteName} 全校总览`} onClick={e => { e.preventDefault(); mapRef.current?.reset(); }}><img className="brand-mark" src="/icons/campuspulse-192.png" width="35" height="35" alt="" style={{ height: 'auto', borderRadius: 8 }} /><span>{siteName}</span></a>
      <div className="campus-name"><span className="header-divider" /><MapPin size={18} weight="fill" /><span>华中师范大学</span><CaretDown size={12} /></div>
      <div className="search-wrap" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setSearchOpen(false); }}><div className={`search-box ${searchOpen ? 'focused' : ''}`}><MagnifyingGlass size={20} /><input ref={searchRef} value={query} onChange={e => { setQuery(e.target.value); setSearchOpen(true); }} onFocus={() => setSearchOpen(true)} onKeyDown={e => { if (e.key === 'Enter' && searchResults.length) selectPlace(searchResults[0].id); }} placeholder="搜索建筑或地点" aria-label="搜索建筑或地点" aria-expanded={searchOpen} aria-controls="place-results" />{query ? <button className="icon-button" aria-label="清空搜索" onClick={() => setQuery('')}><X size={15} /></button> : <kbd>⌘ K</kbd>}</div>
      {searchOpen && <div className="search-results" id="place-results" aria-label="地点搜索结果"><div className="results-caption">{query ? '搜索结果' : demo ? '探索校园' : '现场地点'}</div>{searchResults.length ? searchResults.map(place => <button key={place.id} onMouseDown={e => e.preventDefault()} onClick={() => selectPlace(place.id)}><MapPin size={18} /><span>{place.name}<small>{place.subtitle}</small></span><ArrowUpRight size={16} /></button>) : <p>{demo ? `没有找到“${query}”，试试图书馆或教学楼。` : query ? `没有找到已定位的现场地点“${query}”。` : '当前没有可显示的现场地点。'}</p>}{!demo && <p role="status">{fieldStatus}。未核验 GIS 坐标的地点可在「现场记录」中选择。</p>}</div>}</div>
      <a className="admin-entry" href="/admin" aria-label="管理后台">管理</a><div className="theme-tools"><span className="theme-state">{isDark ? <Moon size={17} weight="fill" /> : <Sun size={18} weight="fill" />}<span>{isDark ? '夜间' : '日间'}</span></span><div className="theme-switch" role="group" aria-label="地图外观">{[['auto', '跟随时间'], ['light', '浅色'], ['dark', '深色']].map(([key, text]) => <button key={key} aria-pressed={theme === key} className={theme === key ? 'active' : ''} title={key === 'auto' ? '根据时间轴所选时段切换昼夜' : `始终使用${text}外观`} onClick={() => setTheme(key)}>{text}</button>)}</div></div>
      <div className="data-mode-switch" role="group" aria-label="数据模式"><button className={demo ? 'active' : ''} aria-pressed={demo} onClick={() => changeMode(true)}><span className="status-dot" />模拟演示</button><button className={!demo ? 'active' : ''} aria-pressed={!demo} onClick={() => changeMode(false)}>现场观察</button></div>
    </header>
    <div className={`scene-controls ${detailOpen ? 'with-detail' : 'without-detail'}`} ref={sceneSettingsRef}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setSceneSettingsOpen(false); }}
      onKeyDown={event => { if (event.key === 'Escape' && sceneSettingsOpen) { event.stopPropagation(); setSceneSettingsOpen(false); sceneSettingsButtonRef.current?.focus(); } }}>
      <div className="scene-controls-bar"><span className="scene-source"><span className="status-dot" />{demo ? '官方轮廓 · 模拟活动' : '官方轮廓 · 现场模式'}</span><button className="field-record-trigger" onClick={openRecords}><Plus size={13} />现场记录</button><button ref={sceneSettingsButtonRef} type="button" className="scene-settings-trigger" aria-expanded={sceneSettingsOpen} aria-controls="scene-settings" onClick={() => setSceneSettingsOpen(open => !open)}><SlidersHorizontal size={15} /><span>场景设置</span><CaretDown size={10} /></button></div>
      {demo && !sceneSettingsOpen && <SimulationControls scenarioId={scenarioId} onChange={changeScenario} />}
      {sceneSettingsOpen && <section className="scene-settings-popover" id="scene-settings" aria-labelledby="scene-settings-title"><div className="scene-settings-heading"><h2 id="scene-settings-title">场景设置</h2><button type="button" className="icon-button" aria-label="关闭场景设置" onClick={() => { setSceneSettingsOpen(false); sceneSettingsButtonRef.current?.focus(); }}><X size={15} /></button></div><div className="night-lighting-control"><span>夜景光照<small>校园光照统一建筑、地面、树木与行人受光；灯光均为示意</small></span><div role="group" aria-label="夜景光照">{[['campus', '校园光照'], ['library', '入口实验'], ['atmospheric', '暖光增强'], ['original', '原始效果']].map(([value, label]) => <button key={value} aria-pressed={lighting === value} className={lighting === value ? 'active' : ''} onClick={() => setLighting(value)}>{label}</button>)}</div></div><div className="night-lighting-control"><span>光照精度<small>轻量更省资源；精细保留更多材质细节</small></span><div role="group" aria-label="光照精度">{[['efficient', '轻量'], ['full', '精细']].map(([value, label]) => <button key={value} aria-pressed={lightingQuality === value} className={lightingQuality === value ? 'active' : ''} onClick={() => setLightingQuality(value)}>{label}</button>)}</div></div><button type="button" className="scene-option" disabled={!canXray} aria-pressed={canXray && xray} aria-describedby="scene-xray-help" onClick={() => setXray(value => !value)}><Buildings size={21} /><span>建筑透视<small id="scene-xray-help">{canXray ? '淡化楼体，查看后方活动示意' : '此地点没有可透视楼体'}</small></span><span className="scene-switch" aria-hidden="true"><span /></span></button><button type="button" className="scene-option" disabled={!demo} aria-pressed={demo && motionEnabled} aria-describedby="scene-motion-help" onClick={() => setMotionEnabled(value => !value)}>{motionEnabled ? <Play size={21} /> : <Pause size={21} />}<span>动态演示<small id="scene-motion-help">{demo ? '仅控制人物与骑乘车辆的移动' : '现场模式不显示合成活动'}</small></span><span className="scene-switch" aria-hidden="true"><span /></span></button><p>下方播放键单独控制模拟时段；现场模式停止回放。</p><a className="scene-admin-entry" href="/admin" aria-label="管理后台">管理后台 ↗</a></section>}
    </div>
    <div className={`map-actions ${detailOpen ? 'with-detail' : ''}`}><div className="zoom-controls" role="group" aria-label="地图缩放"><button aria-label="放大地图" onClick={() => zoom(1)}><Plus size={19} /></button><span /><button aria-label="缩小地图" onClick={() => zoom(-1)}><Minus size={19} /></button></div><button className="map-tool" title="回到全校视野" aria-label="回到全校视野" onClick={() => mapRef.current?.reset()}><CornersOut size={20} /></button><button className="map-tool" title="定位所选地点" aria-label="定位所选地点" disabled={!selected} onClick={() => mapRef.current?.focusPlace(selectedId, 1.65)}><Crosshair size={20} /></button></div>
    {!detailOpen && <button className="reopen-detail" onClick={() => setDetailOpen(true)}><MapPin size={17} weight="fill" /><span>{selected?.name || '现场地点'}</span><span className="reopen-hint">局部视图</span><ArrowUpRight size={16} /></button>}
    <aside className={`detail-panel ${detailOpen ? 'open' : ''}`} aria-label="所选地点详情" aria-hidden={!detailOpen} inert={!detailOpen ? true : undefined}>
      <div className="detail-heading"><div className="detail-eyebrow"><span className="detail-eyebrow-line" />地点详情 <span>LOCAL VIEW</span></div><div className="detail-title-row"><h1>{selected?.name || '现场地点'}</h1><button className="close-detail" onClick={() => setDetailOpen(false)} aria-label="收起局部详情"><span>收起</span><X size={18} /></button></div><p>{selected?.subtitle || '仅展示已核验且在当前地图范围内的现场地点'}</p></div>
      {!trendOpen ? <>{selected && <div className="detail-scene"><CampusMap compactSelected maxZoom={12} onZoomChange={setDetailZoom} ref={detailRef} selectedId={selectedId} mapPlaces={mapPlaces} onSelect={selectPlace} layers={layers} minute={demo ? minute : clockMinute} scenarioId={scenarioId} isDark={isDark} xray={canXray && xray} moving={demo && motionEnabled} demo={demo} lighting={lighting} /><div className="detail-scene-label"><CornersOut size={12} />局部放大</div><span className="detail-scale">{detailZoom.toFixed(1)}×</span>{demo && <div className="scene-vehicle-key" aria-label="电动车示意：骑乘行驶，无人停放"><span><span className="scene-riding-icons" aria-hidden="true"><Moped size={14} /><ArrowRight size={10} /></span>骑乘行驶</span><span><Moped size={14} aria-hidden="true" />无人停放</span></div>}</div>}<div className="scene-caption"><Info size={12} />{demo ? lighting === 'campus' ? '校园统一光照 · 近似几何与示意灯光' : lighting === 'library' && selectedId === 'library' ? '入口光照实验 · 近似几何与示意灯光' : '道路活动示意 · 非个体定位' : '现场模式 · 合成活动已隐藏'}</div>{demo ? <><div className="metric-list" aria-live="polite"><div className={`metric-row people ${!layers.people ? 'muted' : ''}`}><PersonSimpleWalk size={29} weight="duotone" /><div className="metric-label">行人活动<small>{layers.people ? '区域相对活跃程度' : '地图图层已隐藏'}</small></div><strong>{band(metrics.people)}</strong><span className={`trend-icon ${metrics.peopleTrend}`}><TrendIcon trend={metrics.peopleTrend} /></span></div><div className={`metric-row bikes ${!layers.bikes ? 'muted' : ''}`}><Moped size={29} weight="duotone" /><div className="metric-label">电动车活动<small>{layers.bikes ? '区域相对活跃程度' : '地图图层已隐藏'}</small></div><strong>{band(metrics.bikes)}</strong><span className={`trend-icon ${metrics.bikesTrend}`}><TrendIcon trend={metrics.bikesTrend} /></span></div><div className={`metric-row waits ${!layers.waits ? 'muted' : ''}`}><Elevator size={27} /><div className="metric-label">候梯<small>模拟等候时间</small></div><strong>{metrics.wait == null ? '暂无数据' : <>约 <b>{metrics.wait}</b> 分钟</>}</strong></div></div><p className="simulation-parking"><span>停放占用示意 · 非实际容量</span><strong>{layers.bikes ? parkingBand(metrics.parking) : '图层已隐藏'}</strong></p></> : <div className="live-mode-summary"><Radio size={24} /><strong>{selected ? '现场地点，已核验 GIS 锚点' : fieldCatalog.loading ? '正在加载现场地点' : '暂无可定位的现场地点'}</strong><p role="status">{fieldStatus}。未核验坐标的地点保留在现场记录目录，活动、停车与候梯不以模拟数值补齐。</p><button onClick={openRecords}>查看现场记录<ArrowUpRight size={14} /></button></div>}</> : <div className="trend-view"><button className="back-to-scene" onClick={() => setTrendOpen(false)}><ArrowLeft size={15} />返回局部视图</button><h2>这个地点，一天的变化</h2><p>{scenario.label} · 相同时段，三类信息一起看。</p><div className="history-head"><span>模拟时段</span><span>行人</span><span>电动车</span><span>候梯</span></div>{simulationTimes.map(time => { const data = getMetrics(selectedId, time, scenarioId); return <button className={`history-row ${minute === time ? 'selected' : ''}`} key={time} onClick={() => { setMinute(time); setPlaying(false); }}><span><Clock size={14} />{timeText(time)}</span><span className="people">{band(data.people)}</span><span className="bikes">{band(data.bikes)}</span><span>{data.wait == null ? '—' : `${data.wait}分钟`}</span></button>; })}<p className="trend-note">点击时段，同步查看地图。数值来自合成场景，不代表测量结果或预测。</p></div>}
      <div className="detail-footer"><button className="primary-button" disabled={!selected} onClick={() => demo ? setTrendOpen(value => !value) : openRecords()}>{!demo ? <><Plus size={18} />{selected?.kind === 'activity' ? '查看现场记录' : '添加现场记录'}<ArrowUpRight size={18} /></> : trendOpen ? <><ArrowLeft size={18} />返回局部视图</> : <><Clock size={18} />查看时段变化<ArrowUpRight size={18} /></>}</button><div className="data-meta"><span><span className="status-dot" />{demo ? scenario.label : '现场视图'}</span><span>{demo ? `所选时段 ${timeText(minute)}` : '不显示合成指标'}</span></div></div>
    </aside>
    <footer className="bottom-dock"><div className="timeline-main"><div className="timeline-label"><Clock size={19} /><div><strong>{yearText}{dateText}</strong><span>{timeText(demo ? minute : clockMinute)} <span className="time-label-tag">{demo ? '模拟回放' : '当前时间'}</span></span></div></div><button disabled={!demo} className={`play-button ${playing ? 'playing' : ''}`} aria-label={playing ? '暂停时段回放' : '播放时段回放'} title="控制所选时段的变化；人物与车辆的移动由场景设置单独控制" onClick={() => setPlaying(p => !p)}>{playing ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}</button><div className="timeline-track"><div className="range-current" style={{ left: `${((demo ? minute : Math.min(1320, Math.max(420, clockMinute))) - 420) / 900 * 100}%` }}>{demo ? timeText(minute) : '现场'}</div><input disabled={!demo} type="range" min="420" max="1320" step="5" value={demo ? minute : Math.min(1320, Math.max(420, clockMinute))} onChange={e => { setMinute(Number(e.target.value)); setPlaying(false); }} aria-label="模拟回放时间" aria-valuetext={demo ? timeText(minute) : '现场模式不回放'} /><div className="time-ticks">{[420, 600, 780, 960, 1140, 1320].map(t => <span key={t}>{timeText(t)}</span>)}</div></div><div className="time-presets" role="group" aria-label="模拟时段快捷选择">{presets.map(p => <button disabled={!demo} key={p.minute} className={minute === p.minute ? 'active' : ''} onClick={() => { setMinute(p.minute); setPlaying(false); }}>{p.label}</button>)}</div></div><div className="dock-bottom"><div className="layer-controls" role="group" aria-label="地图信息图层">{layerDefs.map(({ key, label, Icon }) => <button key={key} className={`layer-toggle ${key} ${layers[key] ? 'enabled' : ''}`} aria-pressed={layers[key]} onClick={() => setLayers(l => ({ ...l, [key]: !l[key] }))}><span className="layer-check">{layers[key] && <Check size={10} weight="bold" />}</span><Icon size={21} weight="duotone" /><span>{label}</span></button>)}</div><button className="data-notice" onClick={() => setNoticeOpen(true)}><Info size={13} /><span>{demo ? '模拟数据 · 非个体定位' : '现场数据 · 独立记录'}</span></button><span className="map-attribution">底图：华师公开 GIS · 官方在线瓦片</span></div></footer>
    </div>{noticeOpen && <div className="modal-backdrop" onClick={() => setNoticeOpen(false)}><section ref={dialogRef} className="notice-dialog" role="dialog" aria-modal="true" aria-labelledby="notice-title" onClick={e => e.stopPropagation()}><button className="icon-button modal-close" aria-label="关闭数据说明" onClick={() => setNoticeOpen(false)}><X size={20} /></button><span className="notice-icon"><Info size={27} weight="duotone" /></span><h2 id="notice-title">这张地图展示了什么？</h2><p>校园底图、已核对的建筑轮廓与地点锚点来自华师公开 GIS。模拟模式下，人物、电动车、活跃程度、变化趋势、停放占用和候梯时间均为合成示意；现场模式隐藏这些示意指标。教学日、周末与雨天场景是独立编写的全天演示曲线，不表示实际天气或日程。</p><p>示意人物不对应真实个人或车辆，也不表示精确位置和数量；未核实各楼栋的电梯设施。暂无测量数据的区域不能解释为无人或空闲。</p><p>骑乘车辆表示行驶示意，无人车辆表示停放示意，不代表实际通行方向或停车范围。夜间灯光为视觉示意，建筑透视用于查看后方活动，均不表示现场照明或建筑内部情况。</p><p>地图使用华师官方在线瓦片，仅显示当前有限视口；局部道路与场景活动仍需逐项核对，不提供真实导航，未验证经纬度配准。</p><p>现场模式从服务端读取地点，仅把已核验且在当前视图范围内的 GIS 锚点放到地图，每 30 秒及返回页面时更新。示意锚点不用于官方地图定位；其余地点仍可在现场记录目录中选择。人工候梯记录不是当前预测。</p><button className="primary-button" onClick={() => setNoticeOpen(false)}>了解，继续探索</button></section></div>}
    <Observations open={recordsOpen} onClose={closeRecords} initialPlaceId={!demo ? selected?.id : undefined} />
    <div className="sr-only" role="status">当前{isDark ? '夜间' : '日间'}模式，{demo ? `模拟场景 ${scenario.label}，模拟时间 ${timeText(minute)}` : '现场观察，合成活动已隐藏'}，地点 {selected?.name || '暂无已定位的现场地点'}</div>
  </main>;
}
