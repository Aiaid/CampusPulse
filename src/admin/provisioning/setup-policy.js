import {configurationBlockReason,startupGrantRevision} from './setup-startup.js';

const digestPattern=/^[a-f0-9]{64}$/;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const manual=message=>new Error(`${message} 请手动核对部署与策略；本次流程不会自动重发。`);

export function setupDesiredSnapshot(control,node) {
 if(control?.protocol!=='campuspulse/3'||control.node_id!==node)throw manual('无法核对发送 USB 启动材料前的期望策略。');
 if(control.desired===null)return{generation:0,digest:null};
 const p=control.desired?.policy,digest=control.desired?.policy_sha256;
 if(p?.node_id!==node||!Number.isSafeInteger(p.assignment_generation)||p.assignment_generation<1||!digestPattern.test(digest||''))throw manual('发送 USB 启动材料前的期望策略摘要无效。');
 return{generation:p.assignment_generation,digest};
}

/** A prior placement is authority only when its exact stored policy received a
 * durable device ACK. Expired time bindings can be refreshed; scope cannot. */
export function approvedSetupTemplate(control,node) {
 const p=control?.desired?.policy,ack=control?.acknowledgement,digest=control?.desired?.policy_sha256;
 const applied=control?.last_applied_policy;
 if(control?.protocol!=='campuspulse/3'||control.node_id!==node||p?.node_id!==node||!digestPattern.test(digest||'')||control.applied_generation!==p.assignment_generation||ack?.state!=='applied'||ack.durability!=='committed'||ack.evidence!=='device_ack'||ack.assignment_generation!==p.assignment_generation||ack.policy_id!==p.policy_id||ack.policy_sha256!==digest||ack.boot_id!==p.control?.activation?.boot_id||applied?.policy_sha256!==digest||applied.policy?.node_id!==node||applied.policy?.assignment_generation!==p.assignment_generation||applied.policy?.policy_id!==p.policy_id||applied.policy?.control?.activation?.boot_id!==ack.boot_id)return null;
 return structuredClone(p);
}

export function resolveSetupPlacement(details,node,template,now=Date.now()) {
 if(details?.device?.id!==node||!Array.isArray(details.placements))throw manual('无法核对设备部署。');
 const valid=details.placements.filter(p=>p.node_id===node&&typeof p.id==='string'&&Number.isSafeInteger(p.valid_from_ms)&&p.valid_from_ms<=now&&(p.effective_valid_until_ms===null||Number.isSafeInteger(p.effective_valid_until_ms)&&p.effective_valid_until_ms>now));
 if(template){const placement=valid.find(p=>p.id===template.custody?.placement_id);if(!placement)throw manual('已确认来源策略的部署已失效或不可见。');return{placement:placement.id,dataset:template.custody.dataset,template};}
 if(details.placements_truncated||valid.length!==1||valid[0].place_id!==null)throw manual('没有唯一有效的未定位部署，且没有已确认的来源策略；不会猜测公共地点。');
 return{placement:valid[0].id,dataset:'controlled_test',template:null};
}

export function rebindSetupPolicy(prepared,template) {
 if(!template)return structuredClone(prepared);
 const source=template.control?.activation,next=prepared.control?.activation;
 const ttl=Date.parse(source?.expires_at)-Date.parse(source?.not_before),grace=Date.parse(template.custody?.accept_until)-Date.parse(source?.expires_at);
 const preparedGrace=Date.parse(prepared.custody?.accept_until)-Date.parse(next?.expires_at),start=Date.parse(next?.not_before);
 if(!Number.isSafeInteger(ttl)||ttl<=0||!Number.isSafeInteger(grace)||grace<0||!Number.isSafeInteger(preparedGrace)||preparedGrace<0||!Number.isSafeInteger(start))throw manual('来源策略的期限或接收宽限无效。');
 const expires=Math.min(Date.parse(next.expires_at),start+ttl);
 if(!(expires>start))throw manual('当前能力不足以恢复已确认策略的有效期限。');
 return {...structuredClone(template),node_id:prepared.node_id,policy_id:prepared.policy_id,revision:prepared.revision,assignment_generation:prepared.assignment_generation,
  custody:{...structuredClone(template.custody),accept_until:new Date(expires+Math.min(grace,preparedGrace)).toISOString()},
  control:{...structuredClone(template.control),capability_sha256:prepared.control.capability_sha256,activation:{...structuredClone(next),expires_at:new Date(expires).toISOString()}}};
}

function policySource(control,node,boot) {
 const p=control.desired?.policy,digest=control.desired?.policy_sha256;
 if(p?.node_id!==node||p.control?.activation?.boot_id!==boot||control.desired_unavailable_reason||!(Date.parse(p.control.activation.expires_at)>Date.now())||!digestPattern.test(digest||'')||!Number.isSafeInteger(p.assignment_generation)||p.assignment_generation<1)return null;
 return{generation:p.assignment_generation,digest};
}

/** Starts only after this page submitted V3START. Every mutating request is
 * single-shot; a newer boot, manual action or CAS conflict ends this attempt. */
export function createSetupInitialPolicy({api,node,boot,revision,previous,isActive=()=>true,onState=()=>{},pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),polls=60}) {
 let cancelled=false,started=null,assigned=false;
 const active=()=>!cancelled&&isActive(),assertActive=()=>{if(!active())throw manual('本次自动下发已取消。');};
 const base=`/device-v3/nodes/${encodeURIComponent(node)}`;
 const run=async()=>{
  try {
   const baseline=setupDesiredSnapshot(previous,node);
   const requireBaseline=c=>{if(!same(setupDesiredSnapshot(c,node),baseline))throw manual('期望策略已在本次 USB 提交后被其他操作修改，停止自动下发和授权。');};
   onState('capabilities');let control;
   for(let i=0;i<polls;i++){
    assertActive();control=await api(base);assertActive();
    if(control?.node_id!==node)throw manual('云端设备身份不一致。');
    requireBaseline(control);
    if(!configurationBlockReason(control,node,boot))break;
    if(i===polls-1)throw manual('尚未收到本次 USB 启动的有效能力。');
    await pause(1000);
   }
   const existing=policySource(control,node,boot);
   if(existing){onState('ack');return{revision,source:existing};}
   const expected=baseline.generation,template=approvedSetupTemplate(previous,node);
   const details=await api(`/devices/${encodeURIComponent(node)}`);assertActive();
   const selection=resolveSetupPlacement(details,node,template);
   const before=await api(`${base}/startup-grant`);assertActive();
   if(startupGrantRevision(before,node)!==revision)throw manual('自动启动授权已被其他操作修改。');
   onState('preparing');
   const prepared=await api('/device-v3/prepare',{method:'POST',body:{node_id:node,placement_id:selection.placement,dataset:selection.dataset}});assertActive();
   if(prepared.valid!==true||prepared.expected_generation!==expected||prepared.policy?.assignment_generation!==expected+1||prepared.policy?.node_id!==node||prepared.policy?.control?.activation?.boot_id!==boot)throw manual('准备结果与本次启动或期望 generation 不一致。');
   const policy=rebindSetupPolicy(prepared.policy,selection.template);
   const checked=await api('/device-v3/validate',{method:'POST',body:{policy,expected_generation:expected}});assertActive();
   if(checked.valid!==true||checked.expected_generation!==expected||!same(checked.policy,policy)||!digestPattern.test(checked.policy_sha256||''))throw manual('当前能力不能完整承载所选策略，未下发替代参数。');
   const fresh=await api(base);assertActive();
   requireBaseline(fresh);
   if(configurationBlockReason(fresh,node,boot))throw manual('设备启动、能力或策略已变化。');
   if(assigned)throw manual('本次自动策略已经尝试下发。');
   assigned=true;onState('assigning');
   const receipt=await api('/device-v3/assignments',{method:'POST',body:{policy:checked.policy,expected_generation:expected,expected_startup_revision:revision}});assertActive();
   const revoked=before.startup_grant?.enabled===1,after=revision+(revoked?1:0);
   if(receipt?.protocol!=='campuspulse/3'||receipt.node_id!==node||receipt.assignment_generation!==policy.assignment_generation||receipt.policy_id!==policy.policy_id||receipt.policy_sha256!==checked.policy_sha256||receipt.applied!==false||receipt.requires_device_ack!==true||receipt.startup_grant_revision_before!==revision||receipt.startup_grant_revision_after!==after||receipt.startup_grant_revoked!==revoked)throw manual('策略下发或本次授权版本转换未被服务端完整确认。');
   const grant=await api(`${base}/startup-grant`);assertActive();
   if(startupGrantRevision(grant,node)!==after||grant.startup_grant?.enabled===1)throw manual('下发后授权版本已变化，停止后续自动授权。');
   onState('ack');return{revision:after,source:{generation:policy.assignment_generation,digest:checked.policy_sha256}};
  }catch(error){if(active())onState('manual',error);return{error};}
 };
 return{cancel(){cancelled=true;},run(){if(!started)started=run();return started;}};
}
