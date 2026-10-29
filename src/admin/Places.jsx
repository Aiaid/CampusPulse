import React, { useMemo, useState } from 'react';
import { MapPin, PencilSimple, Plus } from '@phosphor-icons/react';
import { Dialog, Empty, ErrorNotice, Field, FormActions, Notice, PageHeader, Panel, Resource, idPattern, useAdmin, useMutation, useResource } from './shared.jsx';
import GisPlaceMap from './GisPlaceMap.jsx';
import { fieldPlaceRegistry, gisAnchorToScene } from '../campus/place-registry.js';
import { observationKinds, formatObservationKinds } from '../shared/observation-kinds.js';
import WorkPurposes from './WorkPurposes.jsx';
import HelpTip from './HelpTip.jsx';
import { validateWorkPurposes } from './work-purposes.js';

const mapLink = id => `/?place=${encodeURIComponent(id)}`;

export default function Places() {
  const { version } = useAdmin();
  const resource = useResource('/places', version);
  const [editing, setEditing] = useState(null);
  return <><PageHeader eyebrow="WORKSPACE / PLACES" title="地点与部署" description="在官方 GIS 底图上维护地点位置；保存并核对后，与前台现场地图同步。设备部署历史仍在设备详情中管理。"><button className="cp-admin-button cp-admin-primary" onClick={() => setEditing({})}><Plus />新建地点</button></PageHeader>
    <Resource resource={resource}>{data => <PlaceDirectory data={data} onEdit={setEditing} />}</Resource>
    <Notice>同一地点可支持多种观测。修改地点用途不会重写历史部署；请在设备详情中「修改地点与工作方式」为设备选择用途并发布新版本。</Notice>
    {editing && <PlaceForm place={editing.id ? editing : null} onClose={() => setEditing(null)} />}
  </>;
}

function PlaceDirectory({ data, onEdit }) {
  const registry = useMemo(() => fieldPlaceRegistry(data.places), [data.places]);
  const located = new Set(registry.mapPlaces.map(place => place.id));
  return <div className="cp-admin-places-grid">
    <Panel title="地点目录" description={`${data.places.length} 个已加载地点 · ${registry.mapPlaces.length} 个可在 GIS 显示${data.truncated ? ' · 已达单次展示上限' : ''}`}>
      {data.places.length ? <div className="cp-admin-place-list">{data.places.map(place => <div key={place.id}>
        <span className="cp-admin-device-icon"><MapPin size={20} /></span>
        <div><strong>{place.name}</strong><small>{place.id} · {formatObservationKinds(place)}</small><span className="cp-admin-coordinate">{located.has(place.id) ? '已登记 GIS 位置 · 与前台同步' : place.gis_anchor ? 'GIS 坐标在当前底图范围外或尚未核对' : '待定位 · 尚未登记 GIS 位置'}</span></div>
        <div className="cp-location-actions">{located.has(place.id) && <a href={mapLink(place.id)} target="_blank" rel="noreferrer" aria-label={`在前台地图查看 ${place.name}`}>查看地图 ↗</a>}<button type="button" className="cp-admin-icon-button" aria-label={`编辑地点 ${place.name}`} onClick={() => onEdit(place)}><PencilSimple size={20} /></button></div>
      </div>)}</div> : <Empty title="尚无地点">新建地点后，可在设备详情中登记部署关联。</Empty>}
      {data.truncated && <Notice>本次仅展示前 500 个地点，列表和预览不包含全部登记地点。</Notice>}
    </Panel>
    <Panel title="校园 GIS 位置" description="已核对的位置将出现在前台现场地图，模拟演示保留独立的示意地点。">
      <GisPlaceMap places={registry.mapPlaces} onSelect={id => onEdit(data.places.find(place => place.id === id))} />
      {!!registry.unlocatedPlaces.length && <Notice>{registry.unlocatedPlaces.length} 个地点尚不能显示在当前 GIS 范围内；请编辑地点，在底图上选点并核对。</Notice>}
    </Panel>
  </div>;
}

function PlaceForm({ place, onClose }) {
  const { api, notify } = useAdmin();
  const [form, setForm] = useState({ id: place?.id || '', name: place?.name || '', observation_kinds: observationKinds(place || { kind: 'activity' }), x: place?.anchor.x ?? 0.5, y: place?.anchor.y ?? 0.5, gis: !!place?.gis_anchor, confirmed: !!place?.gis_anchor?.verified, gx: place?.gis_anchor?.x ?? '', gy: place?.gis_anchor?.y ?? '' });
  const mutation = useMutation();
  const update = key => e => setForm(v => ({ ...v, [key]: e.target.value }));
  const changeGis = key => e => setForm(v => ({ ...v, [key]: e.target.value, gis: true, confirmed: false }));
  const gisValue = form.gis && form.gx !== '' && form.gy !== '' ? { x: Number(form.gx), y: Number(form.gy) } : null;
  return <Dialog title={place ? '编辑地点' : '新建地点'} wide onClose={onClose} pending={mutation.pending}>
    <form onSubmit={e => { e.preventDefault(); mutation.run(async () => {
      validateWorkPurposes(form.observation_kinds);
      const body = { name: form.name, kind: form.observation_kinds.includes(place?.kind) ? place.kind : form.observation_kinds[0], observation_kinds: form.observation_kinds, anchor: { x: Number(form.x), y: Number(form.y) }, ...(form.gis ? { gis_anchor: { x: Number(form.gx), y: Number(form.gy), verified: true } } : place?.gis_anchor ? { gis_anchor: null } : {}) };
      if (!place) body.id = form.id;
      await api(place ? `/places/${encodeURIComponent(place.id)}` : '/places', { method: place ? 'PATCH' : 'POST', body });
      notify(place ? '地点资料与位置已更新；前台现场地图会自动刷新。' : '新地点已创建；已核对的 GIS 位置会同步到前台。'); onClose();
    }); }}>
      <div className="cp-admin-form-grid"><Field label="地点 ID"><input required pattern={idPattern} maxLength={64} disabled={!!place} value={form.id} onChange={update('id')} placeholder="例如 library-entry" /></Field><Field label="地点名称"><input required maxLength={120} value={form.name} onChange={update('name')} /></Field></div>
      <WorkPurposes title="地点支持的观测（可多选）" value={form.observation_kinds} onChange={value => setForm(v => ({ ...v, observation_kinds: value }))} />
      <fieldset className="cp-admin-fieldset" aria-label="GIS 地图位置"><legend><span>GIS 地图位置</span><HelpTip topic="GIS 地图位置" label="了解 GIS 地图位置" /></legend>
        <GisPlaceMap value={gisValue} onChange={point => setForm(v => ({ ...v, gx: point.x, gy: point.y, gis: true, confirmed: false }))} />
        {form.gis ? <><div className="cp-admin-form-grid"><Field label="GIS x（0–1）"><input required type="number" min="0" max="1" step="any" value={form.gx} onChange={changeGis('gx')} /></Field><Field label="GIS y（0–1）"><input required type="number" min="0" max="1" step="any" value={form.gy} onChange={changeGis('gy')} /></Field></div>
          {!gisAnchorToScene(gisValue) && <Notice>此坐标在当前校园底图范围外或尚未完整填写，前台不会放置标记。可在上方底图重新选点。</Notice>}
          <label className="cp-admin-checkbox cp-location-confirm"><input type="checkbox" required checked={form.confirmed} onChange={e => setForm(v => ({ ...v, confirmed: e.target.checked }))} />我已核对所选 GIS 位置与此地点相符</label><HelpTip topic="核对 GIS 位置" label="了解 GIS 位置核对的作用" />
          <button type="button" className="cp-admin-text-button" onClick={() => setForm(v => ({ ...v, gis: false, confirmed: false, gx: '', gy: '' }))}>移除 GIS 位置，保留为待定位地点</button>
        </> : <p className="cp-admin-muted">尚未选点。可先保存地点资料，稍后定位；未定位地点不会放入前台 GIS。</p>}
        <p className="cp-location-map-help">坐标沿用学校完整图像的归一化位置；选点会自动转换。它不是经纬度，也不代表设备覆盖范围。</p>
      </fieldset>
      <details className="cp-location-legacy" open={!place}><summary>兼容的示意锚点（独立于 GIS 位置）</summary><HelpTip topic="兼容的示意锚点" label="了解兼容示意锚点与 GIS 位置的区别" /><div className="cp-admin-form-grid"><Field label="锚点 x（0–1）"><input required type="number" min="0" max="1" step="0.0001" value={form.x} onChange={update('x')} /></Field><Field label="锚点 y（0–1）"><input required type="number" min="0" max="1" step="0.0001" value={form.y} onChange={update('y')} /></Field></div><p className="cp-admin-muted">保留既有示意坐标，不用于官方 GIS 定位。</p></details>
      <ErrorNotice error={mutation.error} /><FormActions pending={mutation.pending} label="保存地点" onCancel={onClose} />
    </form>
  </Dialog>;
}
