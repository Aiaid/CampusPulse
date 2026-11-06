// Small-core typed metadata/ruleset fixtures, with hashes from the TS core.
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const base=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('generate_small.mjs',import.meta.url))],{encoding:'utf8'}))[0];
const bundle=await build({stdin:{contents:"export {capabilityDigestV3,freezeDeviceConfigV3} from './worker/device-v3-config.ts';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
const api=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const cases=[];
const online={schema:'online-control/1',scope_rebind:true,capability_renewal:true};
async function add(name,change,{init=true,offer='ok',rule='unclassified-v1',rebind=false,renewal=false}={}){
 const caps=structuredClone(base.caps),response=structuredClone(base.response);change(caps,response);
 if(init){response.config.policy.control.capability_sha256=await api.capabilityDigestV3(caps);response.config=await api.freezeDeviceConfigV3(response.config.policy);}
 cases.push({name,caps,response,init,offer,rule,rebind,renewal});
}
await add('legacy-no-online',()=>{});
await add('online-null',c=>{c.online_control=null;});
await add('online-disabled',c=>{c.online_control={...online,scope_rebind:false,capability_renewal:false};});
await add('online-both',(c,r)=>{c.online_control=online;r.online_transition={schema:'synthetic-pause-intent/1'};},{rebind:true,renewal:true});
await add('online-scope-only-null-transition',(c,r)=>{c.online_control={...online,capability_renewal:false};r.online_transition=null;},{rebind:true});
await add('renewal-alone-no-transition',c=>{c.online_control={...online,scope_rebind:false};},{renewal:true});
for(const [name,value] of [['array',[]],['boolean',true],['number',1],['string','online-control/1'],['empty',{}],['wrong-schema',{...online,schema:'online-control/2'}],['string-boolean',{...online,scope_rebind:'true'}],['number-boolean',{...online,capability_renewal:1}],['null-boolean',{...online,capability_renewal:null}],['missing',{schema:online.schema,scope_rebind:true}],['unknown',{...online,extra:true}]]){
 await add('bad-online-'+name,c=>{c.online_control=value;},{init:false});
}
for(const [name,versions] of [['empty',[]],['duplicate',['unclassified-v1','unclassified-v1']],['unknown',['unknown/1']],['wrong-type','unclassified-v1'],['bad-element',['unclassified-v1',false]]]){
 await add('bad-rules-'+name,c=>{c.statistics.ruleset_versions=versions;},{init:false});
}
await add('vehicle-selected',(c,r)=>{c.statistics.ruleset_versions=['unclassified-v1','cp-v3-vehicle-candidates/1'];r.config.policy.evidence.ruleset_version='cp-v3-vehicle-candidates/1';},{rule:'cp-v3-vehicle-candidates/1'});
await add('unclaimed-vehicle',(_c,r)=>{r.config.policy.evidence.ruleset_version='cp-v3-vehicle-candidates/1';},{offer:'reject'});
await add('unclaimed-unclassified',c=>{c.statistics.ruleset_versions=['cp-v3-vehicle-candidates/1'];},{offer:'reject'});
await add('unknown-policy-rule',(_c,r)=>{r.config.policy.evidence.ruleset_version='unknown/1';},{offer:'reject'});
await add('transition-with-legacy',(_c,r)=>{r.online_transition={};},{offer:'reject'});
await add('transition-null-with-legacy',(_c,r)=>{r.online_transition=null;},{offer:'reject'});
await add('transition-with-renewal-only',(c,r)=>{c.online_control={...online,scope_rebind:false};r.online_transition={};},{offer:'reject',renewal:true});
for(const value of [true,1,'intent',[]])await add('bad-transition-'+typeof value,(c,r)=>{c.online_control=online;r.online_transition=value;},{offer:'reject',rebind:true,renewal:true});
await add('unknown-response-field',(c,r)=>{c.online_control=online;r.extra_field=true;},{offer:'reject',rebind:true,renewal:true});
await add('missing-required-response-field',(c,r)=>{c.online_control=online;delete r.requires_device_ack;},{offer:'reject',rebind:true,renewal:true});
// A valid-looking descriptor cannot replace a policy or grant authority.
await add('descriptor-without-policy',(c,r)=>{c.online_control=online;r.online_transition={schema:'synthetic-pause-intent/1'};},{offer:'wait',rebind:true,renewal:true});
const waiting=cases.at(-1);waiting.response.config=null;waiting.response.reason='online_transition_pending';waiting.response.activation_not_before=null;
process.stdout.write(JSON.stringify(cases));
