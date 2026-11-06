import {startupGrantApproval,startupGrantOffer,validateStartupGrantMutation} from './startup-grant.js';

export function startupGrantRevision(response,node) {
 const row=response?.startup_grant;
 if(response?.protocol!=='campuspulse/3'||response.node_id!==node||response.service_enabled!==true||!(row===null||row?.node_id===node&&Number.isSafeInteger(row.revision)&&row.revision>0&&[0,1].includes(row.enabled)))throw new Error('无法核对本次自动启动授权版本，请刷新后手动核对授权。');
 return row?.revision??0;
}

/** An expired desired policy can be replaced, but expired device capabilities
 * cannot safely seed a new policy. USB setup additionally binds the actual boot. */
export function configurationBlockReason(control,node,expectedBoot,now=Date.now()) {
 if(control?.protocol!=='campuspulse/3'||control.node_id!==node||!control.capabilities)return '尚无当前设备的 V3 能力，请刷新并等待设备重新登记。';
 if(expectedBoot&&control.capabilities.boot_id!==expectedBoot)return '云端能力与本次 USB 启动标识不一致。请刷新并等待当前 USB 设备登记新能力，再准备策略。';
 if(!(Date.parse(control.capabilities.expires_at)>now))return '设备能力已过期。请刷新并等待设备重新登记有效能力，再准备策略；刷新页面不会延长旧能力。';
 return null;
}

export function setupSource(control,node,boot,now=Date.now()) {
 const reason=configurationBlockReason(control,node,boot,now);
 if(reason)throw new Error(reason);
 const p=control.desired?.policy,ack=control.acknowledgement,digest=control.desired?.policy_sha256;
 if(p?.node_id!==node||p?.control?.activation?.boot_id!==boot||ack?.boot_id!==boot||!/^([a-f0-9]{64})$/.test(digest||'')||ack?.policy_id!==p.policy_id||ack.policy_sha256!==digest||control.last_applied_policy?.policy_sha256!==digest||control.last_applied_policy?.policy?.assignment_generation!==p.assignment_generation)throw new Error('当前 USB 启动的期望策略、已应用策略与设备 ACK 摘要尚未一致，请刷新并核对。');
 return {generation:p.assignment_generation,digest};
}

/** Created only by a new user-submitted USB save flow. The one-shot latch also
 * covers sensitiveAction implementations that might invoke their callback twice. */
export function createSetupStartupGrant({api,sensitiveAction,node,boot,revision,policyReady,isActive=()=>true,onState=()=>{},pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),polls=30}) {
 let cancelled=false,running=false,attempted=false,source=null;
 const active=()=>!cancelled&&isActive();
 const assertActive=()=>{if(!active())throw new Error('本次自动启动授权流程已取消；启动配置保存结果与授权结果独立。');};
 const base=`/device-v3/nodes/${encodeURIComponent(node)}`;
 return {
  cancel(){cancelled=true;},
  policyChanged(){if(source||attempted){cancelled=true;return true;}return false;},
  async saved(){
   if(running||attempted||!active())return;
   running=true;
   try {
    const setup=policyReady?await policyReady:null;assertActive();
    if(setup?.error)throw setup.error;
    if(setup){revision=setup.revision;source=setup.source;}
    onState('checking');
    let control;
    for(let i=0;i<polls;i++){
     assertActive();control=await api(base);assertActive();
     if(control.node_id!==node||control.capabilities?.boot_id!==boot)throw new Error('云端设备启动标识与本次 USB 不一致，未申请自动启动授权。');
     if(control.applied_generation===control.desired?.policy?.assignment_generation&&control.acknowledgement?.state==='applied')break;
     if(i===polls-1)throw new Error('尚未取得本次 USB 启动的持久 applied ACK，请刷新后手动核对授权。');
     await pause(1000);
    }
    const applied=setupSource(control,node,boot);
    if(source&&(source.generation!==applied.generation||source.digest!==applied.digest))throw new Error('自动下发的来源策略已变化，停止自动授权。');
    source=applied;
    const baseline=await api(`${base}/startup-grant`);assertActive();
    if(startupGrantRevision(baseline,node)!==revision)throw new Error('授权版本已变更，本次自动申请已停止；请手动核对，避免覆盖撤销或其他管理员操作。');
    const offer=startupGrantOffer(control,baseline);
    if(!offer.eligible)throw new Error(offer.reason);
    const result=await sensitiveAction(async()=>{
     assertActive();
     if(attempted)throw new Error('本次自动启动授权已尝试，不会自动重发。');
     // Re-read after authentication; never authorize a newer/manual policy by
     // silently substituting it for the acknowledged setup snapshot.
     const fresh=await api(base);assertActive();
     const latest=setupSource(fresh,node,boot);
     if(latest.generation!==source.generation||latest.digest!==source.digest)throw new Error('来源策略已变更，本次自动申请已停止，请手动核对授权。');
     const body=startupGrantApproval(fresh,baseline,7);
     if(attempted)throw new Error('本次自动启动授权已尝试，不会自动重发。');
     attempted=true;onState('authorizing');assertActive();
     const response=await api(`${base}/startup-grant`,{method:'POST',body});
     validateStartupGrantMutation(response,node,body);
     return response;
    },{retry:false});
    assertActive();
    if(!result||result.reauthOnly)throw new Error('身份验证后尚未提交自动启动授权，请手动核对并批准；本流程不会自动重发。');
    onState('approved');
   }catch(error){if(active())onState('incomplete',error);}
  },
 };
}
