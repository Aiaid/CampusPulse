import {describe,expect,it,vi} from 'vitest';
import {configurationBlockReason,createSetupStartupGrant,setupSource,startupGrantRevision} from '../../src/admin/provisioning/setup-startup.js';

const node='cp_001122aabbcc',boot='11111111-1111-4111-8111-111111111111',digest='a'.repeat(64);
function fixture(){
 const expiry=new Date(Date.now()+1200000).toISOString();
 const policy={node_id:node,assignment_generation:4,policy_id:'synthetic-policy',collection:{enabled:true,summary:{enabled:true,window_ms:60000}},temporal:{mode:'rolling'},evidence:{mode:'statistics',schema:'window-statistics/1',extractor_version:'cp-v3-stats/1',ruleset_version:'unclassified-v1'},local_raw:{mode:'off'},local_queue:{mode:'durable'},uplink:{enabled:true,transport:'mqtt_tls',streams:['window_statistics','node_status'],raw_sample:{mode:'off'},archive:{mode:'off'}},custody:{accept_until:new Date(Date.parse(expiry)+3600000).toISOString()},control:{activation:{boot_id:boot,expires_at:expiry}}};
 const desired={policy,policy_sha256:digest};
 const control={protocol:'campuspulse/3',node_id:node,capabilities:{boot_id:boot,expires_at:expiry},desired,last_applied_policy:desired,applied_generation:4,acknowledgement:{state:'applied',policy_id:policy.policy_id,policy_sha256:digest,assignment_generation:4,boot_id:boot,durability:'committed',evidence:'device_ack'}};
 const grant={protocol:'campuspulse/3',node_id:node,service_enabled:true,startup_grant:null};
 const posts=[],states=[];
 const api=vi.fn(async(path,options)=>{if(options?.method==='POST'){posts.push(options.body);const b=options.body;return{protocol:'campuspulse/3',node_id:node,applied:false,requires_device_ack:true,startup_grant:{node_id:node,revision:b.expected_revision+1,enabled:1,source_generation:b.source_generation,grant_expires_at_ms:Date.parse(b.grant_expires_at),policy_ttl_ms:b.policy_ttl_ms,accept_grace_ms:b.accept_grace_ms}};}return structuredClone(path.endsWith('/startup-grant')?grant:control);});
 const args={api,node,boot,revision:0,sensitiveAction:async fn=>fn(),pause:async()=>{},polls:2,onState:(state,error)=>states.push({state,error})};
 return{control,grant,api,posts,states,args};
}

describe('submitted USB setup startup authorization',()=>{
 it('does nothing before saved, then authorizes exactly once with the seven-day existing contract',async()=>{
  const f=fixture(),flow=createSetupStartupGrant(f.args);expect(f.api).not.toHaveBeenCalled();const before=Date.now();await flow.saved();await flow.saved();expect(f.posts).toHaveLength(1);expect(f.posts[0]).toMatchObject({expected_revision:0,enabled:true,source_generation:4,policy_ttl_ms:1800000,accept_grace_ms:3600000});expect(Date.parse(f.posts[0].grant_expires_at)).toBeGreaterThanOrEqual(before+7*86400000);expect(f.states.at(-1).state).toBe('approved');
 });
 it('polls only boundedly for durable applied ACK and never confuses accepted with applied',async()=>{
  const f=fixture();f.control.acknowledgement=null;f.control.applied_generation=null;const flow=createSetupStartupGrant(f.args);await flow.saved();expect(f.posts).toHaveLength(0);expect(f.api).toHaveBeenCalledTimes(2);expect(f.states.at(-1).state).toBe('incomplete');
 });
 it('rejects stale boots, expired capabilities, wrong node, ACK digests and applied-policy digests',async()=>{
  for(const mutate of [c=>c.capabilities.boot_id='different',c=>c.node_id='different',c=>c.capabilities.expires_at=new Date(0).toISOString(),c=>c.acknowledgement.policy_sha256='b'.repeat(64),c=>c.last_applied_policy={...c.desired,policy_sha256:'b'.repeat(64)},c=>c.acknowledgement.durability='pending']){const f=fixture();mutate(f.control);await createSetupStartupGrant(f.args).saved();expect(f.posts).toHaveLength(0);expect(f.states.at(-1).state).toBe('incomplete');}
 });
 it('never overwrites changed/revoked authorization or policy replaced during authentication',async()=>{
  const f=fixture();f.grant.startup_grant={node_id:node,revision:1,enabled:0};await createSetupStartupGrant(f.args).saved();expect(f.posts).toHaveLength(0);
  const g=fixture();g.args.sensitiveAction=async fn=>{g.control.desired.policy.assignment_generation=5;return fn();};await createSetupStartupGrant(g.args).saved();expect(g.posts).toHaveLength(0);expect(g.states.at(-1).error.message).toContain('来源策略已变更');
 });
 it('latches before POST, disables sensitiveAction retries and never replays a conflict',async()=>{
  const f=fixture(),base=f.api;let posted=0;f.args.api=async(path,options)=>{if(options?.method==='POST'){posted++;const e=new Error('conflict');e.status=409;throw e;}return base(path,options);};f.args.sensitiveAction=async(fn,options)=>{expect(options).toEqual({retry:false});return fn();};const flow=createSetupStartupGrant(f.args);await flow.saved();await flow.saved();expect(posted).toBe(1);expect(f.states.at(-1).state).toBe('incomplete');
 });
 it('rejects duplicate callback invocation even if authentication invokes callbacks concurrently',async()=>{
  const f=fixture();f.args.sensitiveAction=async fn=>{const results=await Promise.allSettled([fn(),fn()]);return results.find(r=>r.status==='fulfilled')?.value;};await createSetupStartupGrant(f.args).saved();expect(f.posts).toHaveLength(1);
 });
 it('accepts only its own confirmed assignment revision transition and exact assigned source',async()=>{
  const f=fixture();f.grant.startup_grant={node_id:node,revision:3,enabled:0};f.args.revision=2;f.args.policyReady=Promise.resolve({revision:3,source:{generation:4,digest}});await createSetupStartupGrant(f.args).saved();expect(f.posts).toHaveLength(1);expect(f.posts[0].expected_revision).toBe(3);
  const g=fixture();g.args.policyReady=Promise.resolve({revision:0,source:{generation:3,digest}});await createSetupStartupGrant(g.args).saved();expect(g.posts).toHaveLength(0);expect(g.states.at(-1).error.message).toContain('来源策略已变化');
  const h=fixture();h.args.policyReady=Promise.resolve({error:new Error('Missing assignment transition metadata')});await createSetupStartupGrant(h.args).saved();expect(h.api).not.toHaveBeenCalled();expect(h.states.at(-1).state).toBe('incomplete');
 });
 it('cancels on close/manual action even while waiting for authentication and handles reauth-only',async()=>{
  const f=fixture();let flow;f.args.sensitiveAction=async fn=>{flow.cancel();return fn();};flow=createSetupStartupGrant(f.args);await flow.saved();expect(f.posts).toHaveLength(0);
  const g=fixture();g.args.sensitiveAction=async()=>({reauthOnly:true});await createSetupStartupGrant(g.args).saved();expect(g.posts).toHaveLength(0);expect(g.states.at(-1).state).toBe('incomplete');
 });
 it('blocks expired capability and USB mismatch while permitting replacement of expired desired policy',()=>{
  const f=fixture();f.control.desired.policy.control.activation.expires_at=new Date(0).toISOString();expect(configurationBlockReason(f.control,node,boot)).toBeNull();expect(configurationBlockReason(f.control,node,'wrong')).toContain('USB');f.control.capabilities.expires_at=new Date(0).toISOString();expect(configurationBlockReason(f.control,node)).toContain('已过期');expect(()=>setupSource(f.control,node,boot)).toThrow();expect(startupGrantRevision(f.grant,node)).toBe(0);
 });
});
