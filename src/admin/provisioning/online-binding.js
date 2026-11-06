export const VEHICLE_RULESET='cp-v3-vehicle-candidates/1';
import {startupGrantOffer} from './startup-grant.js';
const STATES=['pending','assigned','applied','failed','cancelled','expired','conflicted'];
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const ID=/^[a-z0-9][a-z0-9_-]{0,63}$/;
export function onlineBindingOffer(control,response,now=Date.now()) {
 const deny=reason=>({eligible:false,reason});
 const cap=control?.capabilities,p=control?.desired?.policy,ack=control?.acknowledgement,g=response?.startup_grant;
 if(cap?.online_control?.schema!=='online-control/1'||cap.online_control.scope_rebind!==true)return deny('当前固件尚未声明在线切换能力，需要先升级固件。');
 if(response?.protocol!=='campuspulse/3'||response.node_id!==control.node_id||response.service_enabled!==true||g?.node_id!==control.node_id||g.enabled!==1||!Number.isSafeInteger(g.revision)||g.revision<1||!(g.grant_expires_at_ms>now))return deny('需要有效的自动启动授权；在线切换会保留原授权截止时间。');
 const generation=p?.assignment_generation;
 if(!Number.isSafeInteger(generation)||generation<1||control.applied_generation!==generation||ack?.assignment_generation!==generation||ack.state!=='applied'||ack.durability!=='committed'||ack.evidence!=='device_ack'||ack.boot_id!==cap.boot_id||p.control?.activation?.boot_id!==cap.boot_id||control.desired_unavailable_reason)return deny('等待当前策略的真实 applied ACK，并刷新设备状态。');
 const remaining=Math.min(Date.parse(cap.expires_at),Date.parse(p.control.activation.expires_at),g.grant_expires_at_ms)-now;
 if(!(remaining>2*p.collection?.summary?.window_ms+10000))return deny('当前策略接近到期，等待设备在线续期后刷新。');
 if(!/^[a-f0-9]{64}$/.test(p.control?.capability_sha256||''))return deny('当前能力摘要不可用，请刷新设备状态。');
 const rules=cap.statistics?.ruleset_versions?.filter(r=>['unclassified-v1',VEHICLE_RULESET].includes(r))||[];
 if(!rules.length)return deny('设备未声明受支持的统计规则。');
 const source=startupGrantOffer(control,response,now);
 if(!source.eligible)return deny(source.reason);
 return {eligible:true,rules,expected_boot_id:cap.boot_id,expected_capability_sha256:p.control.capability_sha256,expected_generation:generation,expected_startup_revision:g.revision,grant_expires_at_ms:g.grant_expires_at_ms};
}
export function onlineBindingRequest(control,response,target,requestId,now=Date.now()) {
 const offer=onlineBindingOffer(control,response,now);
 if(!offer.eligible)throw new Error(offer.reason);
 if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(target.place)||!['field','controlled_test','demo'].includes(target.dataset)||!offer.rules.includes(target.rules)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId))throw new Error('请选择有效地点、数据集和设备支持的规则。');
 return {request_id:requestId,expected_boot_id:offer.expected_boot_id,expected_capability_sha256:offer.expected_capability_sha256,expected_generation:offer.expected_generation,expected_startup_revision:offer.expected_startup_revision,target_place_id:target.place,target_dataset:target.dataset,target_ruleset:target.rules,migrate_startup:true};
}
export function validateOnlineBinding(response,node,expected) {
 const t=response?.transition;
 if(!t||!UUID.test(t.id)||!UUID.test(t.boot_id)||!HASH.test(t.capability_sha256)||!Number.isSafeInteger(t.from_generation)||t.from_generation<1||!Number.isSafeInteger(t.expected_startup_revision)||t.expected_startup_revision<1||!ID.test(t.target_place_id)||!['field','controlled_test','demo'].includes(t.target_dataset)||!['unclassified-v1',VEHICLE_RULESET].includes(t.target_ruleset))throw new Error('在线切换状态格式无效，请刷新核对。');
 if(response?.protocol!=='campuspulse/3'||response.node_id!==node||!t||!STATES.includes(t.state)||typeof t.id!=='string'||!Number.isFinite(Date.parse(t.expires_at))||expected&&(t.id!==expected.request_id||t.boot_id!==expected.expected_boot_id||t.from_generation!==expected.expected_generation||t.capability_sha256!==expected.expected_capability_sha256||t.expected_startup_revision!==expected.expected_startup_revision||t.target_place_id!==expected.target_place_id||t.target_dataset!==expected.target_dataset||t.target_ruleset!==expected.target_ruleset))throw new Error('在线切换回执与当前操作不一致，请刷新核对。');
 if(t.applied!==(t.state==='applied')||t.requires_device_ack!==['pending','assigned'].includes(t.state))throw new Error('在线切换状态与设备确认标记不一致。');
 if(['assigned','applied'].includes(t.state)&&t.assignment_generation!==t.from_generation+1||t.state==='applied'&&t.startup_grant_migrated!==true)throw new Error('服务端尚未确认新策略及授权迁移。');
 return t;
}
