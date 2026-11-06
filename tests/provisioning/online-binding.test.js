import {describe,expect,it} from 'vitest';
import {onlineBindingOffer,onlineBindingRequest,validateOnlineBinding,VEHICLE_RULESET} from '../../src/admin/provisioning/online-binding.js';
import {statisticsCapabilities,statisticsPolicy} from '../helpers/v3-statistics-policy-fixtures';
import {v3Ack} from '../helpers/device-v3-fixtures';

const node='synthetic-online-ui-notregister';
const requestId='00000000-0000-4000-8000-000000000001';
const clone=value=>structuredClone(value);
async function fixture(){
 const now=Date.now(),capabilities=statisticsCapabilities(node,now);
 capabilities.online_control={schema:'online-control/1',scope_rebind:true,capability_renewal:true};
 capabilities.statistics.ruleset_versions=['unclassified-v1',VEHICLE_RULESET];
 capabilities.uplink.transports=['mqtt_tls'];
 const policy=await statisticsPolicy(capabilities,'synthetic-old-place',4,now);
 policy.uplink.transport='mqtt_tls';
 const control={node_id:node,capabilities,desired:{policy},applied_generation:4,
  acknowledgement:{...await v3Ack(policy),durability:'committed',evidence:'device_ack'},desired_unavailable_reason:null};
 const response={protocol:'campuspulse/3',node_id:node,service_enabled:true,startup_grant:{node_id:node,revision:3,enabled:1,
  source_generation:4,grant_expires_at_ms:now+86400000,policy_ttl_ms:1800000,accept_grace_ms:86400000}};
 const target={place:'synthetic-new-place',dataset:'field',rules:VEHICLE_RULESET};
 return{now,control,response,target};
}
function receipt(body,state='pending'){
 return{protocol:'campuspulse/3',node_id:node,transition:{id:body.request_id,boot_id:body.expected_boot_id,
  capability_sha256:body.expected_capability_sha256,from_generation:body.expected_generation,
  expected_startup_revision:body.expected_startup_revision,target_place_id:body.target_place_id,
  target_dataset:body.target_dataset,target_ruleset:body.target_ruleset,state,phase:state,
  expires_at:new Date(Date.now()+300000).toISOString(),assignment_generation:['assigned','applied','failed'].includes(state)?body.expected_generation+1:null,
  startup_grant_migrated:state==='applied',applied:state==='applied',requires_device_ack:['pending','assigned'].includes(state)}};
}
async function requested(){const f=await fixture();return{...f,body:onlineBindingRequest(f.control,f.response,f.target,requestId,f.now)};}

describe('same-boot online binding browser contract',()=>{
 it('pins authority and target without extending or reissuing the startup grant',async()=>{
  const f=await fixture(),before=clone(f.response);
  expect(onlineBindingOffer(f.control,f.response,f.now)).toMatchObject({eligible:true,rules:['unclassified-v1',VEHICLE_RULESET],grant_expires_at_ms:f.response.startup_grant.grant_expires_at_ms});
  const body=onlineBindingRequest(f.control,f.response,f.target,requestId,f.now);
  expect(body).toEqual({request_id:requestId,expected_boot_id:f.control.capabilities.boot_id,
   expected_capability_sha256:f.control.desired.policy.control.capability_sha256,expected_generation:4,expected_startup_revision:3,
   target_place_id:f.target.place,target_dataset:'field',target_ruleset:VEHICLE_RULESET,migrate_startup:true});
  expect(body).not.toHaveProperty('grant_expires_at');expect(f.response).toEqual(before);
 });
 it('permits another same-boot switch after the selected vehicle ruleset is already applied',async()=>{
  const f=await fixture();f.control.desired.policy.evidence.ruleset_version=VEHICLE_RULESET;
  expect(onlineBindingOffer(f.control,f.response,f.now).eligible).toBe(true);
  expect(onlineBindingRequest(f.control,f.response,{...f.target,rules:'unclassified-v1'},requestId,f.now).target_ruleset).toBe('unclassified-v1');
 });
 it('requires current committed real applied ACK and matching same-boot authority',async()=>{
  const f=await fixture();
  for(const alter of [c=>c.applied_generation=3,c=>c.acknowledgement.state='assigned',c=>c.acknowledgement.durability='pending',
   c=>c.acknowledgement.evidence='server',c=>c.acknowledgement.boot_id='other',c=>c.desired.policy.control.activation.boot_id='other',
   c=>c.desired_unavailable_reason='capability_expired',c=>c.capabilities.online_control.scope_rebind=false]){
   const control=clone(f.control);alter(control);expect(onlineBindingOffer(control,f.response,f.now).eligible).toBe(false);
   expect(()=>onlineBindingRequest(control,f.response,f.target,requestId,f.now)).toThrow();
  }
 });
 it('does not offer a switch for an HTTPS, raw-enabled or non-statistics source',async()=>{
  const f=await fixture();
  for(const alter of [p=>p.uplink.transport='https',p=>p.uplink.raw_sample.mode='all',p=>p.uplink.archive.mode='enabled',p=>p.evidence.mode='off']){
   const control=clone(f.control);alter(control.desired.policy);
   expect(onlineBindingOffer(control,f.response,f.now).eligible).toBe(false);
  }
 });
 it('requires enough remaining authority for two windows and the server guard',async()=>{
  const f=await fixture(),window=f.control.desired.policy.collection.summary.window_ms;
  for(const extra of [0,-1]){
   const response=clone(f.response);response.startup_grant.grant_expires_at_ms=f.now+2*window+10000+extra;
   expect(onlineBindingOffer(f.control,response,f.now).eligible).toBe(false);
  }
  const response=clone(f.response);response.startup_grant.grant_expires_at_ms=f.now+2*window+10001;
  expect(onlineBindingOffer(f.control,response,f.now).eligible).toBe(true);
 });
 it('rejects expired or mismatched grant and unsupported target choices before POST',async()=>{
  const f=await fixture();
  for(const alter of [r=>r.service_enabled=false,r=>r.node_id='other',r=>r.startup_grant.node_id='other',r=>r.startup_grant.enabled=0,
   r=>r.startup_grant.revision=0,r=>r.startup_grant.grant_expires_at_ms=f.now]){
   const response=clone(f.response);alter(response);expect(onlineBindingOffer(f.control,response,f.now).eligible).toBe(false);
  }
  for(const target of [{...f.target,place:''},{...f.target,dataset:'live'},{...f.target,rules:'unsupported/1'}]){
   expect(()=>onlineBindingRequest(f.control,f.response,target,requestId,f.now)).toThrow();
  }
  expect(()=>onlineBindingRequest(f.control,f.response,f.target,'not-a-uuid',f.now)).toThrow();
 });
 it.each(['pending','assigned','applied','failed','cancelled','expired','conflicted'])('accepts matching backend %s receipt without inventing application',async state=>{
  const {body}=await requested(),reply=receipt(body,state);
  expect(validateOnlineBinding(reply,node,body)).toEqual(reply.transition);
 });
 it('rejects receipts from another protocol, node, request, boot, source or target',async()=>{
  const {body}=await requested(),reply=receipt(body);
  for(const alter of [r=>r.protocol='campuspulse/2',r=>r.node_id='other',r=>r.transition.id='other',r=>r.transition.boot_id='other',
   r=>r.transition.from_generation=3,r=>r.transition.target_place_id='other',r=>r.transition.target_dataset='demo',
   r=>r.transition.target_ruleset='unclassified-v1',r=>r.transition.expires_at='invalid',r=>r.transition.state='unknown']){
   const response=clone(reply);alter(response);expect(()=>validateOnlineBinding(response,node,body)).toThrow();
  }
 });
 it('matches capability digest and startup revision, not only the source generation',async()=>{
  const {body}=await requested(),reply=receipt(body);
  for(const alter of [r=>r.transition.capability_sha256='b'.repeat(64),r=>r.transition.expected_startup_revision=body.expected_startup_revision+1]){
   const response=clone(reply);alter(response);expect(()=>validateOnlineBinding(response,node,body)).toThrow();
  }
 });
 it('rejects malformed history rows before adopting them as a pinned request',async()=>{
  const {body}=await requested(),reply=receipt(body);
  for(const alter of [r=>r.transition.id='not-a-uuid',r=>r.transition.boot_id='not-a-uuid',r=>r.transition.capability_sha256='invalid',
   r=>r.transition.from_generation=0,r=>r.transition.expected_startup_revision=0,r=>r.transition.target_place_id='',
   r=>r.transition.target_dataset='live',r=>r.transition.target_ruleset='unsupported/1']){
   const response=clone(reply);alter(response);expect(()=>validateOnlineBinding(response,node)).toThrow();
  }
 });
 it('requires an assigned generation and atomic grant migration before accepting applied',async()=>{
  const {body}=await requested(),reply=receipt(body,'applied');
  for(const alter of [r=>r.transition.assignment_generation=null,r=>r.transition.assignment_generation=body.expected_generation,
   r=>r.transition.assignment_generation=body.expected_generation+2,
   r=>r.transition.startup_grant_migrated=false]){
   const response=clone(reply);alter(response);expect(()=>validateOnlineBinding(response,node,body)).toThrow();
  }
 });
 it('requires receipt application flags to agree with the transition phase',async()=>{
  const {body}=await requested();
  for(const [state,alter] of [['pending',r=>r.transition.applied=true],['assigned',r=>r.transition.requires_device_ack=false],
   ['applied',r=>r.transition.applied=false],['applied',r=>r.transition.requires_device_ack=true]]){
   const response=receipt(body,state);alter(response);expect(()=>validateOnlineBinding(response,node,body)).toThrow();
  }
 });
});
