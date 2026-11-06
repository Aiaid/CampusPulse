import React,{useEffect,useRef,useState} from 'react';
import {ErrorNotice,Field,KeyValues,Notice,Panel,fmtTime,useAdmin,useMutation,useResource} from './shared.jsx';
import {onlineBindingOffer,onlineBindingRequest,validateOnlineBinding,VEHICLE_RULESET} from './provisioning/online-binding.js';
const labels={pending:'等待设备安全暂停并同步旧记录',assigned:'新策略已发布，等待设备真实 ACK',applied:'设备已应用，原授权截止时间保留',cancelled:'已取消',expired:'请求已过期，请刷新核对',conflicted:'设备或授权已改变，请刷新核对',failed:'切换失败，请刷新核对'};
export default function OnlineBinding(props) {
 return <OnlineBindingSession key={props.node} {...props}/>;
}
function OnlineBindingSession({node,control,onChange}) {
 const {api,version,notify}=useAdmin(),places=useResource('/places',version),grant=useResource(`/device-v3/nodes/${encodeURIComponent(node)}/startup-grant`,version);
 const [place,setPlace]=useState(''),[dataset,setDataset]=useState('field'),[rules,setRules]=useState(VEHICLE_RULESET),[transition,setTransition]=useState(null),[pollError,setPollError]=useState(null),[request,setRequest]=useState(null),[now,setNow]=useState(Date.now());
 const mutation=useMutation(),path=`/device-v3/nodes/${encodeURIComponent(node)}/transitions`,mounted=useRef(true),operation=useRef(0);
 const history=useResource(path,version);
 const accept=t=>setTransition(old=>old?.id===t.id&&(!['pending','assigned'].includes(old.state)||old.state==='assigned'&&t.state==='pending')?old:t);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 const offer=onlineBindingOffer(control,grant.data,now),busy=!!request&&!transition||transition&&['pending','assigned'].includes(transition.state);
 useEffect(()=>{
  if(!history.data)return;
  try {
   const row=request?history.data.transitions?.find(t=>t.id===request.request_id):history.data.transition;
   if(!row)return;
   const pinned=request||{request_id:row.id,expected_boot_id:row.boot_id,expected_capability_sha256:row.capability_sha256,expected_generation:row.from_generation,expected_startup_revision:row.expected_startup_revision,target_place_id:row.target_place_id,target_dataset:row.target_dataset,target_ruleset:row.target_ruleset};
   const t=validateOnlineBinding({...history.data,transition:row},node,pinned);
   setRequest(pinned);accept(t);setPollError(null);
  }catch(e){setPollError(e);}
 },[history.data]);
 useEffect(()=>{if(!offer.eligible)return;if(!offer.rules.includes(rules))setRules(offer.rules.includes(VEHICLE_RULESET)?VEHICLE_RULESET:offer.rules[0]);},[offer.eligible,offer.rules?.join('|'),rules]);
 useEffect(()=>{
  if(!busy||!request)return;
  let active=true,timer;
  const poll=async()=>{const epoch=operation.current;try{const result=await api(path);if(!active||epoch!==operation.current)return;const row=result.transitions?.find(t=>t.id===request.request_id)||result.transition;if(!row||row.id!==request.request_id)return;const t=validateOnlineBinding({...result,transition:row},node,request);accept(t);setPollError(null);if(t.state==='applied'){onChange?.();grant.retry();notify('设备已确认在线切换；请核对新地点的现场观测回执。');}}catch(e){if(active&&epoch===operation.current)setPollError(e);}finally{if(active)timer=setTimeout(poll,3000);}};
  timer=setTimeout(poll,1000);return()=>{active=false;clearTimeout(timer);};
 },[busy,request,api,path,node]);
 const send=()=>mutation.run(async()=>{
  const body=onlineBindingRequest(control,grant.data,{place,dataset,rules},crypto.randomUUID());
  operation.current++;setRequest(body);setTransition(null);setPollError(null);
  try {const result=await api(path,{method:'POST',body});if(!mounted.current)return;
   accept(validateOnlineBinding(result,node,body));notify('在线切换请求已记录，请以设备确认进度为准。');
  }catch(e){if(mounted.current){if(e.status>=400&&e.status<500&&![408,429].includes(e.status))setRequest(null);history.retry();}throw e;}
 });
 const cancel=()=>mutation.run(async()=>{operation.current++;try{const result=await api(`${path}/${encodeURIComponent(transition.id)}/cancel`,{method:'POST',body:{}});if(mounted.current){operation.current++;accept(validateOnlineBinding(result,node,request));}}finally{if(mounted.current)history.retry();}});
 return <Panel title="在线切换地点与识别规则" description="设备在关闭窗口边界同步旧记录，再应用新策略。正常切换无需 USB 或重启。">
  <Notice>车辆规则输出电动车／汽车候选；证据不足仍是未知，可见标识不等于人数或车辆数。旧记录保留原地点、数据集和规则版本。自动启动授权保留原截止时间。</Notice>
  {!offer.eligible&&<Notice>{grant.loading?'正在读取授权…':offer.reason}</Notice>}
  {request&&!transition&&<Notice>正在核对本次请求回执；发送结果尚未确定，提交已锁定。刷新状态会继续查询同一请求，不会重复发布。</Notice>}
  <div className="cp-admin-form-grid"><Field label="目标地点"><select value={place} disabled={!!busy||mutation.pending} onChange={e=>setPlace(e.target.value)}><option value="">选择地点</option>{places.data?.places.filter(p=>p.observation_kinds?.includes('activity')).map(p=><option key={p.id} value={p.id}>{p.name}（{p.id}）</option>)}</select></Field>
   <Field label="目标数据集"><select value={dataset} disabled={!!busy||mutation.pending} onChange={e=>setDataset(e.target.value)}><option value="field">现场观测（live）</option><option value="controlled_test">受控测试</option><option value="demo">演示</option></select></Field>
   <Field label="统计规则"><select value={rules} disabled={!!busy||mutation.pending} onChange={e=>setRules(e.target.value)}>{(offer.rules||[VEHICLE_RULESET]).map(r=><option key={r} value={r}>{r===VEHICLE_RULESET?'保守车辆候选规则':'全部保留未知'}（{r}）</option>)}</select></Field></div>
  <div className="cp-admin-row-actions"><button type="button" className="cp-admin-button cp-admin-primary" disabled={!offer.eligible||!place||!!busy||mutation.pending||history.loading||!!history.error} onClick={send}>提交在线切换请求</button><button type="button" className="cp-admin-button" disabled={mutation.pending} onClick={()=>{grant.retry();places.retry();history.retry();onChange?.();}}>刷新状态</button>{transition?.state==='pending'&&<button type="button" className="cp-admin-button" disabled={mutation.pending} onClick={cancel}>取消待执行请求</button>}</div>
  {transition&&<div role="status"><KeyValues entries={[[ '切换进度',labels[transition.state]],['请求截止',fmtTime(transition.expires_at)],['新 generation',transition.assignment_generation],['原授权截止',fmtTime(grant.data?.startup_grant?.grant_expires_at_ms)]]}/></div>}
  <ErrorNotice error={mutation.error||pollError||grant.error||places.error||history.error}/>
 </Panel>;
}
