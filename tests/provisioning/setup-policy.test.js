import {describe,expect,it,vi} from 'vitest';
import {createSetupInitialPolicy,approvedSetupTemplate,rebindSetupPolicy,resolveSetupPlacement} from '../../src/admin/provisioning/setup-policy.js';
import {statisticsCapabilities,statisticsPolicy} from '../helpers/v3-statistics-policy-fixtures';
import {v3Ack} from '../helpers/device-v3-fixtures';
import {freezeDeviceConfigV3} from '../../worker/device-v3-config';

const node='cp_001122aabbcc',boot='22222222-2222-4222-8222-222222222222';
async function fixture({approved=true,mapped=true,enabled=true}={}) {
 const now=Date.now(),caps=statisticsCapabilities(node,now),p=await statisticsPolicy(caps,'synthetic-placement',5,now);p.uplink.transport='mqtt_tls';p.custody.dataset='field';p.custody.purpose='site_observation';
 const desired=await freezeDeviceConfigV3(p),ack={...await v3Ack(p),durability:'committed',evidence:'device_ack'};
 const previous={protocol:'campuspulse/3',node_id:node,capabilities:caps,desired,acknowledgement:ack,applied_generation:5,last_applied_policy:desired};
 const freshCaps={...caps,boot_id:boot,capability_id:'synthetic-fresh-capability'},prepared=await statisticsPolicy(freshCaps,'synthetic-placement',approved?6:1,now+1000);prepared.uplink.transport='mqtt_tls';
 let grant={protocol:'campuspulse/3',node_id:node,service_enabled:true,startup_grant:{node_id:node,revision:2,enabled:enabled?1:0}};
 let control={...structuredClone(previous),capabilities:freshCaps,...(approved?{}:{desired:null,acknowledgement:null,applied_generation:null,last_applied_policy:null})};
 const state={previous:approved?previous:{protocol:'campuspulse/3',node_id:node,desired:null},control,prepared,details:{device:{id:node},placements:[{id:'synthetic-placement',node_id:node,place_id:mapped?'library':null,valid_from_ms:0,effective_valid_until_ms:null}]},states:[],assignments:[],committed:[],revokeOnAssign:false,prepares:[],validations:[],capDelay:0,omitMetadata:false,failAssign:false};
 const api=vi.fn(async(path,options)=>{
  if(path.endsWith('/startup-grant'))return structuredClone(grant);
  if(path==='/device-v3/nodes/'+node){const c=structuredClone(state.control);if(state.capDelay-->0)c.capabilities.boot_id='old-cloud-boot';return c;}
  if(path==='/devices/'+node)return structuredClone(state.details);
  if(path==='/device-v3/prepare'){state.prepares.push(options.body);return{valid:true,policy:structuredClone(state.prepared),expected_generation:approved?5:0};}
  if(path==='/device-v3/validate'){state.validations.push(options.body);const frozen=await freezeDeviceConfigV3(options.body.policy);return{...frozen,valid:true,expected_generation:approved?5:0};}
  if(path==='/device-v3/assignments'){state.assignments.push(options.body);if(state.revokeOnAssign)grant={...grant,startup_grant:{node_id:node,revision:grant.startup_grant.revision+1,enabled:0}};if(options.body.expected_startup_revision!==grant.startup_grant.revision||state.failAssign){const e=new Error('Synthetic CAS conflict');e.status=409;throw e;}state.committed.push(options.body);const frozen=await freezeDeviceConfigV3(options.body.policy),revoked=grant.startup_grant.enabled===1,before=grant.startup_grant.revision,after=before+(revoked?1:0);grant={...grant,startup_grant:{node_id:node,revision:after,enabled:0}};state.control.desired=frozen;return{protocol:'campuspulse/3',node_id:node,assignment_generation:frozen.policy.assignment_generation,policy_id:frozen.policy.policy_id,policy_sha256:frozen.policy_sha256,applied:false,requires_device_ack:true,...(state.omitMetadata?{}:{startup_grant_revision_before:before,startup_grant_revision_after:after,startup_grant_revoked:revoked})};}
  throw new Error('Unexpected synthetic route');
 });
 state.args={api,node,boot,revision:2,previous:state.previous,pause:vi.fn(async()=>{}),polls:4,onState:(phase,error)=>state.states.push({phase,error})};return state;
}

describe('automatic initial USB policy',()=>{
 it('waits for this boot and automatically prepares/validates/assigns the exact approved template once',async()=>{
  const f=await fixture();f.capDelay=2;const flow=createSetupInitialPolicy(f.args),result=await flow.run();await flow.run();expect(result.error).toBeUndefined();expect(f.assignments).toHaveLength(1);expect(f.args.pause).toHaveBeenCalledTimes(2);expect(f.prepares).toEqual([{node_id:node,placement_id:'synthetic-placement',dataset:'field'}]);
  const p=f.assignments[0].policy,old=f.previous.desired.policy;for(const key of ['collection','evidence','temporal','uplink','local_raw','local_queue','resources'])expect(p[key]).toEqual(old[key]);
  expect(p.custody).toMatchObject({...old.custody,accept_until:p.custody.accept_until});expect(p.control.activation.boot_id).toBe(boot);expect(p.control.capability_sha256).toBe(f.prepared.control.capability_sha256);expect(p.assignment_generation).toBe(6);expect(result.revision).toBe(3);expect(result.source.generation).toBe(6);
  const ttl=p=>Date.parse(p.control.activation.expires_at)-Date.parse(p.control.activation.not_before),grace=p=>Date.parse(p.custody.accept_until)-Date.parse(p.control.activation.expires_at);expect(ttl(p)).toBeLessThanOrEqual(ttl(old));expect(grace(p)).toBeLessThanOrEqual(grace(old));
 });
 it('uses only the sole valid unlocated deployment for a new conservative controlled test',async()=>{
  const f=await fixture({approved:false,mapped:false,enabled:false}),result=await createSetupInitialPolicy(f.args).run();expect(result.error).toBeUndefined();expect(f.prepares[0].dataset).toBe('controlled_test');expect(result.revision).toBe(2);expect(f.assignments).toHaveLength(1);
 });
 it('requires manual intervention for absent, ambiguous or mapped-unapproved deployment and truncated directories',async()=>{
  for(const change of [f=>f.details.placements=[],f=>f.details.placements.push({...f.details.placements[0],id:'another'}),f=>f.details.placements[0].place_id='public-place',f=>f.details.placements_truncated=true]){const f=await fixture({approved:false,mapped:false});change(f);const result=await createSetupInitialPolicy(f.args).run();expect(result.error).toBeInstanceOf(Error);expect(f.prepares).toHaveLength(0);expect(f.assignments).toHaveLength(0);}
 });
 it('does not infer approval from a mismatched old boot, digest or non-durable ACK',async()=>{
  const f=await fixture();for(const change of [c=>c.acknowledgement.boot_id=boot,c=>c.acknowledgement.policy_sha256='b'.repeat(64),c=>c.acknowledgement.durability='pending',c=>c.applied_generation=4]){const c=structuredClone(f.previous);change(c);expect(approvedSetupTemplate(c,node)).toBeNull();expect(()=>resolveSetupPlacement(f.details,node,approvedSetupTemplate(c,node))).toThrow('不会猜测公共地点');}
 });
 it('never overwrites an existing valid same-boot desired policy while waiting for its ACK',async()=>{
  const f=await fixture();f.control.desired=await freezeDeviceConfigV3(f.prepared);f.control.acknowledgement=null;f.control.applied_generation=null;f.args.previous=structuredClone(f.control);const result=await createSetupInitialPolicy(f.args).run();expect(result.source.generation).toBe(6);expect(f.prepares).toHaveLength(0);expect(f.assignments).toHaveLength(0);
 });
 it('does not replay a CAS conflict and refuses missing mutation-only grant transition metadata',async()=>{
  const f=await fixture();f.failAssign=true;const flow=createSetupInitialPolicy(f.args);expect((await flow.run()).error.status).toBe(409);await flow.run();expect(f.assignments).toHaveLength(1);
  const g=await fixture();g.omitMetadata=true;expect((await createSetupInitialPolicy(g.args).run()).error.message).toContain('版本转换');expect(g.assignments).toHaveLength(1);
 });
 it('never adopts or overwrites another administrator policy added after the pre-USB snapshot',async()=>{
  for(const changedBoot of [boot,'33333333-3333-4333-8333-333333333333']){
   const f=await fixture({enabled:false});const other=structuredClone(f.prepared);other.control.activation.boot_id=changedBoot;f.control.desired=await freezeDeviceConfigV3(other);
   const result=await createSetupInitialPolicy(f.args).run();expect(result.error.message).toContain('USB 提交后被其他操作修改');expect(f.prepares).toHaveLength(0);expect(f.assignments).toHaveLength(0);expect(f.committed).toHaveLength(0);
  }
  const f=await fixture({approved:false,mapped:false,enabled:false});f.control.desired=await freezeDeviceConfigV3(f.prepared);expect((await createSetupInitialPolicy(f.args).run()).error).toBeInstanceOf(Error);expect(f.assignments).toHaveLength(0);
 });
 it('compares baseline digest again before assignment even if generation is unchanged',async()=>{
  const f=await fixture({enabled:false}),api=f.args.api;f.args.api=async(path,options)=>{const result=await api(path,options);if(path==='/device-v3/validate')f.control.desired.policy_sha256='f'.repeat(64);return result;};
  expect((await createSetupInitialPolicy(f.args).run()).error.message).toContain('USB 提交后被其他操作修改');expect(f.assignments).toHaveLength(0);
 });
 it('pins the startup revision in the atomic assignment and never retries a revoke during POST',async()=>{
  const f=await fixture();f.revokeOnAssign=true;const flow=createSetupInitialPolicy(f.args),result=await flow.run();await flow.run();expect(result.error.status).toBe(409);expect(f.assignments).toHaveLength(1);expect(f.assignments[0].expected_startup_revision).toBe(2);expect(f.committed).toHaveLength(0);expect(f.args.api.mock.calls.filter(([path,options])=>path.endsWith('/startup-grant')&&options?.method==='POST')).toHaveLength(0);
 });
 it('cancels before any assignment if closed during preparation and refuses a changed boot',async()=>{
  const f=await fixture();const base=f.args.api;let flow;f.args.api=async(path,options)=>{const result=await base(path,options);if(path==='/device-v3/prepare')flow.cancel();return result;};flow=createSetupInitialPolicy(f.args);await flow.run();expect(f.assignments).toHaveLength(0);
  const g=await fixture();const api=g.args.api;g.args.api=async(path,options)=>{const result=await api(path,options);if(path==='/device-v3/validate')g.control.capabilities.boot_id='another-boot';return result;};expect((await createSetupInitialPolicy(g.args).run()).error).toBeInstanceOf(Error);expect(g.assignments).toHaveLength(0);
 });
 it('rejects malformed source time bounds without inventing a longer policy',async()=>{const f=await fixture(),p=structuredClone(f.previous.desired.policy);p.control.activation.not_before='invalid';expect(()=>rebindSetupPolicy(f.prepared,p)).toThrow('期限');});
});
