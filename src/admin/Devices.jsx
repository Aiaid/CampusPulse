import React, { useState } from 'react';
import HelpTip from './HelpTip.jsx';
import { mqttSettings } from './provisioning/mqtt.js';
import MqttCredentials from './MqttCredentials.jsx';
import Provisioning from './Provisioning.jsx';
import DeviceDiagnostics from './DeviceDiagnostics.jsx';
import UploadedBatches from './UploadedBatches.jsx';
import { V3Configuration } from './Configs.jsx';
import { ArrowLeft, ArrowRight, Cpu, Key, MapPin, PencilSimple, Plus, Power, MagnifyingGlass } from '@phosphor-icons/react';
import { Badge, Confirm, Dialog, DirectoryMore, Empty, ErrorNotice, Field, FormActions, KeyValues, Notice, PageHeader, Panel, Resource, fmtNumber, fmtTime, idPattern, localTime, useAdmin, useDevices, useMutation, useResource } from './shared.jsx';

import { observationKinds, formatObservationKinds } from '../shared/observation-kinds.js';
import WorkPurposes from './WorkPurposes.jsx';
import { availableWorkPurposes, validateWorkPurposes } from './work-purposes.js';

export default function Devices() {
  const { version } = useAdmin();
  const resource = useDevices(version);
  const [selected, setSelected] = useState(null);
  const [registering, setRegistering] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [search, setSearch] = useState('');
  return <>{selected ? <DeviceDetail id={selected} onBack={() => setSelected(null)} /> : <><PageHeader eyebrow="WORKSPACE / DEVICES" title="设备管理" description="登记、部署并检查每台设备；以服务端回执和设备上报区分已知与未知。"><button className="cp-admin-button cp-admin-primary" onClick={() => setRegistering(true)}><Plus size={18} />登记设备</button><HelpTip topic="device.register" label="登记设备说明" /><button className="cp-admin-button" onClick={() => setProvisioning(true)}>连接并部署设备</button><HelpTip topic="device.provision" label="连接并部署设备说明" /></PageHeader><Panel title="设备目录" action={<label className="cp-admin-search"><MagnifyingGlass size={18} /><input aria-label="搜索设备" placeholder="搜索名称、ID 或板型" value={search} onChange={e => setSearch(e.target.value)} /></label>}><Resource resource={resource}>{data => { const devices = data.devices.filter(d => `${d.id} ${d.name} ${d.board}`.toLowerCase().includes(search.toLowerCase())); return devices.length ? <div className="cp-admin-table-scroll"><table><thead><tr><th><span>设备</span><HelpTip topic="设备 ID" label="设备说明" /></th><th><span>板型</span><HelpTip topic="device.board" label="板型说明" /></th><th><span>联系状态</span><HelpTip topic="device.contact" label="联系状态说明" /></th><th><span>最近回执</span><HelpTip topic="device.contact" label="最近回执说明" /></th><th><span>配置状态</span><HelpTip topic="device.configState" label="配置状态说明" /></th><th><span>MQTT 授权</span><HelpTip topic="MQTT 授权" label="MQTT 授权说明" /></th><th><span className="cp-admin-sr-only">操作</span></th></tr></thead><tbody>{devices.map(device => <tr key={device.id}><td><button className="cp-admin-entity-button" onClick={() => setSelected(device.id)}><span className="cp-admin-device-icon"><Cpu size={20} /></span><span><strong>{device.name || device.id}</strong><small>{device.id}</small></span></button></td><td>{device.board || '未填写'}</td><td><Badge state={device.enabled ? device.contact_state : 'disabled'} help /></td><td className="cp-admin-nowrap">{fmtTime(device.last_seen_at)}</td><td><Badge state={device.config_state} help /></td><td>{mqttAssignmentLabel(device.mqtt_assignment)}</td><td><button className="cp-admin-icon-button" aria-label={`查看设备 ${device.id}`} onClick={() => setSelected(device.id)}><ArrowRight size={20} /></button></td></tr>)}</tbody></table></div> : <Empty title={search ? '没有匹配的设备' : '尚未登记设备'}>{search ? '请尝试其他名称、ID 或板型。' : '登记后将生成一次性凭证。设备需要自行联网并上传数据，登记不代表已经完成硬件验收。'}</Empty>; }}</Resource><DirectoryMore resource={resource} /></Panel><MqttCredentials /><Notice>最近联系根据云端收到数据的时间判断。它不能替代对固件、扫描状态或无线覆盖的实际验证。</Notice></>}{registering && <DeviceForm onClose={() => setRegistering(false)} />}{provisioning && <Provisioning onClose={() => setProvisioning(false)} />}</>;
}

function mqttAssignmentLabel(assignment) {
  if (!assignment) return '授权状态未加载';
  return ({ unconfigured: '待迁移 / 未分配', pending_broker: '待 Broker 验证', ready: '待分配', assigned: '已分配（服务端）' })[assignment.state] || '授权状态未知';
}

function DeviceForm({ device, onClose }) {
  const { api, notify, revealCredential, sensitiveAction } = useAdmin();
  const [form, setForm] = useState({ id: device?.id || '', name: device?.name || '', board: device?.board || '' });
  const mutation = useMutation();
  const update = key => e => setForm(v => ({ ...v, [key]: e.target.value }));
  return <Dialog title={device ? '编辑设备资料' : '登记新设备'} onClose={onClose} pending={mutation.pending}><form onSubmit={e => { e.preventDefault(); mutation.run(async () => { const save = () => api(device ? `/devices/${encodeURIComponent(device.id)}` : '/devices', { method: device ? 'PATCH' : 'POST', body: device ? { name: form.name, board: form.board } : form }); const result = device ? await save() : await sensitiveAction(save); if (!device) result.mqtt = mqttSettings(result.mqtt); notify(device ? '设备资料已更新。' : '设备已登记并分配已验证的 MQTT 授权，请安全保存本次材料。'); onClose(); if (result.credential) revealCredential(form.id, result.credential, result.mqtt); }); }}><div className="cp-admin-form-grid"><Field label="设备 ID" hint="唯一标识。登记后不能修改。" className="cp-admin-full"><input required pattern={idPattern} maxLength={64} value={form.id} onChange={update('id')} disabled={!!device} autoComplete="off" placeholder="例如 passport-01" /></Field><Field label="设备名称" className="cp-admin-full"><input required maxLength={80} value={form.name} onChange={update('name')} placeholder="例如 图书馆入口节点" /></Field><Field label="板型 / 硬件版本" hint="填写实际核验的板型和版本，不能用构建成功代替硬件验证。" className="cp-admin-full"><input required maxLength={80} value={form.board} onChange={update('board')} placeholder="例如 FoloToy AI Passport / ESP32-C3" /></Field></div>{!device && <Notice>登记会自动分配已验证的独立 MQTT 授权，凭证池未就绪会明确失败；部署位置、采集配置与设备固件仍需分别配置。</Notice>}<ErrorNotice error={mutation.error} /><FormActions pending={mutation.pending} label={device ? '保存资料' : '登记并生成凭证'} onCancel={onClose} /></form></Dialog>;
}

function DeviceDetail({ id, onBack }) {
  const { api, version, notify, revealCredential, navigate, sensitiveAction } = useAdmin();
  const resource = useResource(`/devices/${encodeURIComponent(id)}`, version);
  const [modal, setModal] = useState(null);
  return <><button className="cp-admin-back" onClick={onBack}><ArrowLeft size={17}/>全部设备</button><Resource resource={resource}>{data=>{const {device}=data;return <>
    <PageHeader eyebrow={`DEVICE / ${id}`} title={device.name||id} description={`${device.board||'板型未填写'} · 固件 ${device.firmware_version||'未登记 V3 能力'}`}>
      <button className="cp-admin-button" onClick={()=>setModal('edit')}><PencilSimple/>编辑资料</button><button className="cp-admin-button" onClick={()=>setModal('wifi')}>连接 V3 USB</button>
      <button className="cp-admin-button" onClick={()=>setModal('rotate')}><Key/>轮换设备凭证</button><button className="cp-admin-button" onClick={()=>setModal('toggle')}><Power/>{device.enabled?'停用设备':'启用设备'}</button>
    </PageHeader><div className="cp-admin-detail-strip"><Badge state={device.enabled?device.contact_state:'disabled'}/><span>最近 V3 联系 {fmtTime(device.last_seen_at)}</span></div>
    <Panel title="MQTT 授权"><KeyValues entries={[[ '授权状态',mqttAssignmentLabel(device.mqtt_assignment)],['命名空间',device.mqtt_assignment?.namespace],['Broker 验证',device.mqtt_assignment?.broker_verified?'已验证':'未验证']]}/><Notice>授权分配不表示已写入设备，也不表示已成功上传。</Notice></Panel>
    <V3Configuration node={id}/><DeviceDiagnostics device={device}/><UploadedBatches id={id}/>
    <Panel title="部署历史" description="地点、工作用途和历史采集归属独立保留。" action={<button className="cp-admin-button" onClick={()=>setModal('placement')}><MapPin/>登记位置变更</button>}><PlacementTable placements={data.placements||[]}/><Notice>登记位置后，在 V3 配置中选择新部署并发布 assignment；设备 ACK 前不代表已切换。</Notice></Panel>
    {modal==='wifi'&&<Provisioning initialNodeId={id} onClose={()=>setModal(null)}/>}
    {modal==='edit'&&<DeviceForm device={device} onClose={()=>setModal(null)}/>}
    {modal==='placement'&&<PlacementForm device={device} onClose={()=>setModal(null)}/>}
    {modal==='toggle'&&<Confirm title={device.enabled?'停用这台设备？':'启用这台设备？'} onClose={()=>setModal(null)} action={async()=>{await api(`/devices/${encodeURIComponent(id)}`,{method:'PATCH',body:{enabled:!device.enabled}});notify('设备授权状态已更新；历史数据保留。');}}>只改变后续设备认证；已有历史记录保留。</Confirm>}
    {modal==='rotate'&&<Confirm title="轮换设备凭证？" danger onClose={()=>setModal(null)} action={async()=>{const r=await sensitiveAction(()=>api(`/devices/${encodeURIComponent(id)}/rotate-credential`,{method:'POST',body:{}}));notify('设备凭证已轮换，MQTT 授权不变。');revealCredential(id,r.credential);}}>旧设备 HTTP 凭证立即失效；MQTT 用户、密码与命名空间不变。此处不重置设备存储。</Confirm>}
  </>;}}</Resource></>;
}

function PlacementTable({ placements }) {
  if (!placements.length) return <Empty title="尚未登记部署">设备采集前需要登记部署，并发布引用该部署 ID 的配置。</Empty>;
  return <div className="cp-admin-table-scroll"><table><thead><tr><th><span>部署 ID</span><HelpTip topic="device.placementId" label="部署 ID说明" /></th><th><span>地点</span><HelpTip topic="device.placementPlace" label="地点说明" /></th><th><span>工作用途</span><HelpTip topic="device.placementPlace" label="工作用途说明" /></th><th><span>生效时间</span><HelpTip topic="device.placementTime" label="生效时间说明" /></th><th><span>有效结束</span><HelpTip topic="device.placementTime" label="有效结束说明" /></th><th><span>历史窗口检查</span><HelpTip topic="device.placementCheck" label="历史窗口检查说明" /></th></tr></thead><tbody>{placements.map(p => <tr key={p.id}><td className="cp-admin-mono">{p.id}</td><td>{p.place_name || p.place_id || '未定位 / 移动中'}</td><td>{formatObservationKinds(p)}</td><td>{fmtTime(p.valid_from_ms)}</td><td>{p.effective_valid_until_ms == null ? '持续有效' : fmtTime(p.effective_valid_until_ms)}</td><td>{p.incompatible_window_count > 0 ? <span className="cp-admin-badge cp-admin-badge-amber">{p.incompatible_window_count} 个窗口超出区间</span> : p.incompatible_window_count === 0 ? '未发现区间冲突' : '未提供检查结果'}</td></tr>)}</tbody></table></div>;
}

function PlacementForm({ device, onClose }) {
  const { api, version, notify } = useAdmin();
  const resource = useResource('/places', version);
  const [form, setForm] = useState({ id: `${device.id.slice(0, 40)}-${Date.now().toString(36)}`, place_id: '', valid_from: localTime(), valid_until: '', observation_kinds: ['activity'] });
  const [confirming, setConfirming] = useState(false);
  const targetPlace = resource.data?.places.find(p => p.id === form.place_id);
  const allowedPurposes = availableWorkPurposes(targetPlace);
  const mutation = useMutation();
  const update = key => e => setForm(v => ({ ...v, [key]: e.target.value }));
  return <Dialog title="登记位置变更" onClose={onClose} pending={mutation.pending}><form onSubmit={e => { e.preventDefault(); if (!form.observation_kinds.length || form.observation_kinds.some(kind => !allowedPurposes.includes(kind))) { mutation.run(() => validateWorkPurposes(form.observation_kinds, allowedPurposes)); return; } if (form.valid_until && new Date(form.valid_until).getTime() <= new Date(form.valid_from).getTime()) { mutation.run(() => { throw new Error('结束时间必须晚于生效时间。'); }); return; } setConfirming(true); }}><div className="cp-admin-form-grid"><Field label="新部署 ID" help="device.placementNewId" className="cp-admin-full" hint="独立于设备 ID；每次位置变更使用新部署 ID。"><input required pattern={idPattern} maxLength={64} value={form.id} onChange={update('id')} /></Field><Field label="目标地点" help="device.placementTarget" className="cp-admin-full"><Resource resource={resource}>{data => <select value={form.place_id} onChange={e => { const next = e.target.value; setForm(v => ({ ...v, place_id: next, observation_kinds: next ? observationKinds(resource.data?.places.find(p => p.id === next) || { kind: 'activity' }) : ['activity'] })); }}><option value="">未定位 / 移动中</option>{data.places.map(p => <option key={p.id} value={p.id}>{p.name}（{p.id}）</option>)}</select>}</Resource></Field><Field label="生效时间（本地时间）"><input required type="datetime-local" value={form.valid_from} onChange={update('valid_from')} /></Field><Field label="结束时间（可选）"><input type="datetime-local" value={form.valid_until} onChange={update('valid_until')} /></Field></div><WorkPurposes value={form.observation_kinds} allowed={allowedPurposes} onChange={value => setForm(v => ({ ...v, observation_kinds: value }))} /><Notice>保存时会按生效时间关闭原来仍开放的部署区间。需随后发布新采集配置，并由固件完成窗口切分和实际切换。</Notice><ErrorNotice error={mutation.error} /><FormActions pending={mutation.pending || resource.loading || !!resource.error} label="检查并登记" onCancel={onClose} /></form>{confirming && <Confirm title="确认部署变更" label="确认登记位置" onClose={() => setConfirming(false)} action={async () => { await api(`/devices/${encodeURIComponent(device.id)}/placements`, { method: 'POST', body: { id: form.id, place_id: form.place_id || null, observation_kinds: form.observation_kinds, valid_from_ms: new Date(form.valid_from).getTime(), valid_until_ms: form.valid_until ? new Date(form.valid_until).getTime() : null } }); notify('部署变更已登记。请继续发布新配置并完成固件切换。'); onClose(); }}>这将为 {device.name || device.id} 创建新的部署区间，并可能结束原来的开放区间。服务端登记不会自动移动设备或更改其正在采集的部署 ID。</Confirm>}</Dialog>;
}
