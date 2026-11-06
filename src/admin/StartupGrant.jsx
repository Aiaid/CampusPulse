import React,{useState} from 'react';
import {ErrorNotice,Field,KeyValues,Notice,Panel,Resource,fmtTime,useAdmin,useMutation,useResource} from './shared.jsx';
import {startupGrantApproval,startupGrantOffer,startupGrantRevocation,validateStartupGrantMutation} from './provisioning/startup-grant.js';

export function StartupGrantView({node,control,response,days=7,onDays=()=>{},pending=false,onEnable,onRevoke,onRefresh}) {
 const offer=startupGrantOffer(control,response),row=response?.startup_grant;
 const validRow=row&&row.node_id===node&&Number.isSafeInteger(row.revision)&&row.revision>0&&[0,1].includes(row.enabled);
 const active=validRow&&row.enabled===1&&Number.isSafeInteger(row.grant_expires_at_ms)&&row.grant_expires_at_ms>Date.now();
 return <Panel title="自动启动授权" description="设备保存启动材料与管理员批准续发策略是两个独立步骤。授权不会代替每次启动的真实能力登记、策略校验和设备 ACK。" action={<button className="cp-admin-button" onClick={onRefresh}>刷新授权</button>}>
  <KeyValues entries={[[ '授权状态',active?'已批准，尚需每次启动重新取得策略与 ACK':validRow&&row.enabled===1?'授权已过期':row===null||validRow?'未批准':'状态无效'],['授权版本',validRow?row.revision:row===null?0:'未知'],['来源 generation',validRow?row.source_generation:null],['授权截止',validRow?fmtTime(row.grant_expires_at_ms):'未授权'],['每次策略时长',validRow&&row.policy_ttl_ms!==null?`${row.policy_ttl_ms/60000} 分钟`:'未授权']]}/>
  <Notice>明确批准后，服务端可在期限内按已确认的来源策略为新启动续发策略；默认授权 7 天，每次策略 30 分钟。它不表示设备已经保存配置、已采集或已上传。手动发布新策略会撤销已有自动启动授权，需要重新核对并批准。</Notice>
  {!offer.eligible&&<Notice>{offer.reason}</Notice>}
  <div className="cp-admin-row-actions"><Field label="自动启动授权期限"><select value={days} disabled={pending} onChange={e=>onDays(Number(e.target.value))}><option value={1}>1 天</option><option value={7}>7 天（默认）</option><option value={30}>30 天（最长）</option></select></Field>
   <button className="cp-admin-button cp-admin-primary" disabled={pending||!offer.eligible} onClick={onEnable}>明确批准自动启动（{days} 天）</button>
   <button className="cp-admin-button" disabled={pending||!validRow||row.enabled!==1} onClick={onRevoke}>撤销自动启动授权</button></div>
 </Panel>;
}
export default function StartupGrant({node,control,onChange,onManualAction,refreshVersion=0}) {
 const {api,version,notify}=useAdmin(),resource=useResource(`/device-v3/nodes/${encodeURIComponent(node)}/startup-grant`,`${version}:${refreshVersion}`),mutation=useMutation();
 const [days,setDays]=useState(7);
 const change=enabled=>mutation.run(async()=>{
  onManualAction?.();
  const body=enabled?startupGrantApproval(control,resource.data,days):startupGrantRevocation(resource.data,node);
  try { const result=await api(`/device-v3/nodes/${encodeURIComponent(node)}/startup-grant`,{method:'POST',body});validateStartupGrantMutation(result,node,body);notify(enabled?'自动启动授权已批准；仍须设备每次启动取得策略并明确 ACK。':'自动启动授权已撤销；历史记录和设备队列保留。');resource.retry();onChange?.(); }
  catch(error){if(error.status===409)resource.retry();throw error;}
 });
 return <><Resource resource={resource}>{response=><StartupGrantView node={node} control={control} response={response} days={days} onDays={setDays} pending={mutation.pending} onEnable={()=>change(true)} onRevoke={()=>change(false)} onRefresh={()=>{resource.retry();onChange?.();}}/>}</Resource><ErrorNotice error={mutation.error}/></>;
}
