const DAY=86400000;
const RULESETS=['unclassified-v1','cp-v3-vehicle-candidates/1'];
/** UI admission uses actual inspect/GET values. The server revalidates the full
 * policy, placement, capability, ACK and revision in its atomic write. */
export function startupGrantOffer(control,response,now=Date.now()) {
 const denied=reason=>({eligible:false,reason});
 if(!response||response.protocol!=='campuspulse/3'||response.node_id!==control?.node_id||!(response.startup_grant===null||response.startup_grant&&Number.isSafeInteger(response.startup_grant.revision)&&response.startup_grant.revision>0&&response.startup_grant.node_id===control.node_id&&[0,1].includes(response.startup_grant.enabled)))return denied('自动启动授权状态无效，请刷新后核对。');
 if(response.service_enabled!==true)return denied('服务端尚未启用自动启动授权。');
 const p=control.desired?.policy,generation=p?.assignment_generation,ack=control.acknowledgement;
 if(!Number.isSafeInteger(generation)||generation<1||control.applied_generation!==generation||ack?.state!=='applied'||ack.assignment_generation!==generation||ack.durability!=='committed'||ack.evidence!=='device_ack')return denied('先发布策略，并等待本设备明确 applied ACK；当前尚不能批准自动启动。');
 if(control.desired_unavailable_reason||ack.boot_id!==control.capabilities?.boot_id||p.control?.activation?.boot_id!==control.capabilities?.boot_id||!(Date.parse(control.capabilities?.expires_at)>now)||!(Date.parse(p.control?.activation?.expires_at)>now))return denied('当前启动、能力或策略已不可用，请刷新并取得新策略 ACK。');
 const u=p.uplink,s=p.collection?.summary,e=p.evidence;
 if(!p.collection?.enabled||!s?.enabled||!Number.isSafeInteger(s.window_ms)||s.window_ms<=0||!p.temporal||e?.mode!=='statistics'||e.schema!=='window-statistics/1'||e.extractor_version!=='cp-v3-stats/1'||!RULESETS.includes(e.ruleset_version)||u?.enabled!==true||u.transport!=='mqtt_tls'||!Array.isArray(u.streams)||!u.streams.includes('window_statistics')||!u.streams.includes('node_status')||u.streams.some(v=>!['window_statistics','candidate_events','node_status'].includes(v))||u.raw_sample?.mode!=='off'||u.archive?.mode!=='off'||!['off','tf_cpraw'].includes(p.local_raw?.mode)||p.local_queue?.mode!=='durable')return denied('只有当前已确认的原生 MQTT 小统计策略可以作为自动启动来源。');
 const grace=Date.parse(p.custody?.accept_until)-Date.parse(p.control.activation.expires_at);
 if(!Number.isSafeInteger(grace)||grace<0||Math.max(60000,s.window_ms*2)>1800000)return denied('来源策略的期限或接收宽限无效，不能生成自动启动授权。');
 return {eligible:true,revision:response.startup_grant?.revision??0,source_generation:generation,policy_ttl_ms:1800000,accept_grace_ms:Math.min(grace,DAY)};
}
export function startupGrantApproval(control,response,days=7,now=Date.now()) {
 if(![1,7,30].includes(days)||!Number.isSafeInteger(now))throw new Error('请选择 1、7 或 30 天的授权期限。');
 const offer=startupGrantOffer(control,response,now);
 if(!offer.eligible)throw new Error(offer.reason);
 return {expected_revision:offer.revision,enabled:true,source_generation:offer.source_generation,grant_expires_at:new Date(now+days*DAY).toISOString(),policy_ttl_ms:offer.policy_ttl_ms,accept_grace_ms:offer.accept_grace_ms};
}
export function startupGrantRevocation(response,node) {
 const row=response?.startup_grant;
 if(response?.protocol!=='campuspulse/3'||response.node_id!==node||row?.node_id!==node||!Number.isSafeInteger(row.revision)||row.revision<1||row.enabled!==1)throw new Error('没有可撤销的当前授权，请先刷新。');
 return {expected_revision:row.revision,enabled:false};
}
export function validateStartupGrantMutation(response,node,request) {
 const row=response?.startup_grant;
 if(response?.protocol!=='campuspulse/3'||response.node_id!==node||response.applied!==false||response.requires_device_ack!==true||row?.node_id!==node||row.revision!==request.expected_revision+1||row.enabled!==(request.enabled?1:0)||request.enabled&&(row.source_generation!==request.source_generation||row.grant_expires_at_ms!==Date.parse(request.grant_expires_at)||row.policy_ttl_ms!==request.policy_ttl_ms||row.accept_grace_ms!==request.accept_grace_ms))throw new Error('服务端未确认本次自动启动授权变更，请刷新后核对。');
 return row;
}
