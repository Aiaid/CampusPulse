import React, { useState } from 'react';
import { ArrowClockwise, CheckCircle, PaperPlaneTilt } from '@phosphor-icons/react';
import { Badge, Dialog, DirectoryMore, Empty, ErrorNotice, Field, KeyValues, Notice, PageHeader, Panel, Resource, fmtTime, useAdmin, useDevices, useMutation, useResource } from './shared.jsx';

export default function Configs() {
 const { version }=useAdmin(), devices=useDevices(version);
 const [node,setNode]=useState('');
 return <><PageHeader eyebrow="WORKSPACE / V3 CONTROL" title="采集配置" description="读取设备能力，校验策略，发布不可变 V3 assignment，等待设备明确 ACK。" />
  <Notice>默认使用原生 MQTT 小统计、unclassified-v1；云端原始报告与本地原始记录均关闭。可见标识不等于人数。旧采集历史保留，旧协议配置入口已退役。</Notice>
  <Field label="选择设备"><select value={node} onChange={e=>setNode(e.target.value)}><option value="">选择已登记设备</option>{devices.data?.devices.map(d=><option key={d.id} value={d.id}>{d.name}（{d.id}）</option>)}</select></Field>
  <ErrorNotice error={devices.error} retry={devices.retry}/><DirectoryMore resource={devices}/>{node?<V3Configuration key={node} node={node}/>:<Empty title="先选择设备">设备必须先自行登记 V3 capabilities，才能准备策略。</Empty>}</>;
}

export function V3Configuration({node,embedded=false}) {
 const {api,version,notify}=useAdmin();
 const control=useResource(`/device-v3/nodes/${encodeURIComponent(node)}`,version), details=useResource(`/devices/${encodeURIComponent(node)}`,version);
 const [placement,setPlacement]=useState(''),[dataset,setDataset]=useState('controlled_test'),[draft,setDraft]=useState(null),[check,setCheck]=useState(null),[view,setView]=useState(false);
 const mutation=useMutation();
 const refresh=()=>{control.retry();details.retry();setDraft(null);setCheck(null);};
 return <><Resource resource={control}>{c=><>
  <Panel title="V3 能力与应用状态" action={<button className="cp-admin-button" onClick={refresh}><ArrowClockwise/>刷新设备状态</button>}>
   <KeyValues entries={[[ '当前状态',<Badge state={c.state}/> ],['设备能力来源','设备声明；不是硬件验收'],['能力登记',fmtTime(c.registered_at)],['能力有效截止',fmtTime(c.capabilities?.expires_at)],['固件生产者',c.capabilities?.producer_version],['期望 generation',c.desired?.policy.assignment_generation],['已应用 generation',c.applied_generation],['期望策略',c.desired?.policy.policy_id],['设备启动标识',c.capabilities?.boot_id],['期望不可用原因',c.desired_unavailable_reason||'无']]} />
   {c.acknowledgement&&<details><summary>设备 ACK 回执</summary><pre className="cp-admin-json">{JSON.stringify(c.acknowledgement,null,2)}</pre></details>}
   {c.desired&&<button className="cp-admin-button" onClick={()=>setView(true)}>查看不可变策略</button>}
   {!c.capabilities&&<Notice>尚无 V3 能力登记。连接 USB 并启动 V3 固件后，刷新此页。</Notice>}
  </Panel>
  {c.capabilities&&<Panel title="准备下一代策略" description="策略绑定本次能力摘要与启动标识；设备重启或能力刷新后需要重新准备。">
   <div className="cp-admin-form-grid"><Field label="部署位置"><Resource resource={details}>{d=><select value={placement} onChange={e=>{setPlacement(e.target.value);setDraft(null);setCheck(null);}}><option value="">选择有效部署</option>{d.placements.filter(p=>p.valid_from_ms<=Date.now()&&(p.effective_valid_until_ms===null||p.effective_valid_until_ms>Date.now())).map(p=><option key={p.id} value={p.id}>{p.place_name||p.place_id||'未定位'}（{p.id}）</option>)}</select>}</Resource></Field>
    <Field label="数据集"><select value={dataset} onChange={e=>{setDataset(e.target.value);setDraft(null);setCheck(null);}}><option value="controlled_test">受控测试</option><option value="field">现场观测</option><option value="demo">演示</option></select></Field></div>
   <button className="cp-admin-button" disabled={!placement||mutation.pending} onClick={()=>mutation.run(async()=>{const r=await api('/device-v3/prepare',{method:'POST',body:{node_id:node,placement_id:placement,dataset}});setDraft(JSON.stringify(r.policy,null,2));setCheck(null);})}>根据当前能力准备 V3 策略</button>
   {draft!==null&&<><Field label="V3 策略 JSON" hint="可调整窗口、容量和资源预算；必须通过服务端校验。已发布策略不可改写。"><textarea rows={18} value={draft} spellCheck={false} onChange={e=>{setDraft(e.target.value);setCheck(null);}}/></Field>
    <div className="cp-admin-row-actions"><button className="cp-admin-button" disabled={mutation.pending} onClick={()=>mutation.run(async()=>{const r=await api('/device-v3/validate',{method:'POST',body:{policy:JSON.parse(draft),expected_generation:c.desired?.policy.assignment_generation||0}});setCheck(r);})}><CheckCircle/>校验能力与策略</button>
     <button className="cp-admin-button cp-admin-primary" disabled={mutation.pending||!check?.valid} onClick={()=>mutation.run(async()=>{await api('/device-v3/assignments',{method:'POST',body:{policy:check.policy,expected_generation:check.expected_generation}});setDraft(null);setCheck(null);if(!embedded)notify('V3 assignment 已发布，等待设备明确 ACK；发布不等于已应用。');control.retry();})}><PaperPlaneTilt/>发布不可变 V3 assignment</button></div>
    {check&&<div role="status"><Notice>{check.valid?'静态能力校验通过。发布后仍需设备在关闭窗口边界确认；尚未应用。':'能力或策略不兼容，发布已禁用。'}</Notice>{check.issues.length>0&&<pre className="cp-admin-json">{JSON.stringify(check.issues,null,2)}</pre>}</div>}
   </>}
  </Panel>}
  {view&&<Dialog title="不可变 V3 策略" wide onClose={()=>setView(false)}><pre className="cp-admin-json">{JSON.stringify(c.desired,null,2)}</pre></Dialog>}
 </>}</Resource><ErrorNotice error={mutation.error}/></>;
}
