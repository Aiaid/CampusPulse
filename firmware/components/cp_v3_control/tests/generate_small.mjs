// Synthetic parser fixtures; no registration, radio or network operations.
import { build } from 'esbuild';
const bundle = await build({ stdin: { contents: `export { capabilityDigestV3,freezeDeviceConfigV3,negotiateDeviceConfigV3 } from './worker/device-v3-config.ts';
export {supportsV3StatisticsPolicy} from './worker/device-v3-statistics-policy.ts';
export {statisticsCapabilities,statisticsPolicy} from './tests/helpers/v3-statistics-policy-fixtures.ts';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
const api=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const caps=api.statisticsCapabilities('synthetic-node',1793318460000);
const policy=await api.statisticsPolicy(caps,'synthetic-place-notregister',1,1793318460000);
caps.node_id='synthetic-node';caps.producer_version='cp-v3-small/1';caps.capability_id='synthetic-small-caps';
caps.issued_at='2026-10-30T00:00:00.000Z';caps.expires_at='2026-10-30T01:00:00.000Z';
policy.node_id=caps.node_id;policy.policy_id='synthetic-small-policy';
policy.control.activation.not_before='2026-10-30T00:00:30.000Z';policy.control.activation.expires_at='2026-10-30T00:30:00.000Z';
policy.custody.accept_until='2026-10-30T02:00:00.000Z';
policy.control.activation.after_window_seq=0;policy.control.activation.after_segment_seq=0;
const context={node_id:caps.node_id,boot_id:caps.boot_id,now:'2026-10-30T00:01:00.000Z',last_assignment_generation:0,closed_window_seq:0,closed_segment_seq:0,window_open:false,segment_open:false};
const response=frozen=>({protocol:'campuspulse/3',server_time:context.now,data_ingestion_available:true,requires_device_ack:true,config:frozen,reason:null,applied_generation:null,activation_not_before:frozen.policy.control.activation.not_before});
const cases=[];
async function add(name,mutate,expected='small'){
 const c=structuredClone(caps),p=structuredClone(policy);mutate?.(c,p);const cap_hash=await api.capabilityDigestV3(c);
 p.control.capability_sha256=cap_hash;
 let frozen,compatible=false;try{frozen=await api.freezeDeviceConfigV3(p);const n=await api.negotiateDeviceConfigV3(frozen,c,context);compatible=n.state==='compatible'&&api.supportsV3StatisticsPolicy(p);}catch{frozen={schema:'device-config-envelope/3',policy:p,policy_sha256:'0'.repeat(64)};}
 if(expected==='small'&&!compatible)throw Error('Bad positive '+name);
 if(expected==='reject'&&compatible)throw Error('Bad negative '+name);
 const next=structuredClone(p);next.assignment_generation=2;next.revision=2;next.policy_id='synthetic-small-next';
 let nextResponse=null,thirdResponse=null;if(expected==='small'){
  nextResponse=response(await api.freezeDeviceConfigV3(next));nextResponse.applied_generation=1;
  const third=structuredClone(next);third.assignment_generation=3;third.revision=3;third.policy_id='synthetic-small-third';
  thirdResponse=response(await api.freezeDeviceConfigV3(third));thirdResponse.applied_generation=1;
 }
 cases.push({name,expected,caps:c,cap_hash,policy_hash:frozen.policy_sha256,response:response(frozen),next_response:nextResponse,third_response:thirdResponse});
}
await add('small-512');
await add('small-mqtt',(c,p)=>{c.uplink.transports=['mqtt_tls'];p.uplink.transport='mqtt_tls';});
await add('small-mqtt-policy-https-cap',(_c,p)=>{p.uplink.transport='mqtt_tls';},'reject');
await add('small-https-policy-mqtt-cap',(c)=>{c.uplink.transports=['mqtt_tls'];},'reject');
await add('small-mobile-256-1024',(c,p)=>{p.collection.mode='mobile_research';p.collection.summary.window_ms=30000;p.collection.summary.max_addresses=256;c.uplink.max_body_bytes=p.uplink.max_body_bytes=1024;});
await add('small-temporal-off',(c,p)=>{p.temporal={mode:'off'};delete c.temporal;});
await add('small-tf-raw',(c,p)=>{p.local_raw={mode:'tf_cpraw',format:'cpraw/1',max_segment_bytes:1048576,max_total_bytes:16777216,min_free_bytes:1048576,sync_interval_ms:1000,full_behavior:'stop_recording'};});
await add('small-events',(c,p)=>{p.temporal.report_mode='terminal_only';p.uplink.streams.push('candidate_events');p.local_queue.max_bytes=8192;p.local_queue.max_items=4;p.local_queue.stream_reserves.push({stream:'candidate_events',bytes:2048,items:1});});
await add('small-no-raw-cap',(c)=>{c.local_raw=null;c.resources.tf_usable_bytes=null;});
await add('small-over-capacity',(c,p)=>{p.collection.summary.max_addresses=513;},'reject');
await add('small-bad-version',(c,p)=>{p.evidence.extractor_version='unknown/1';},'reject');
await add('small-missing-temporal',(_c,p)=>{delete p.temporal;},'reject');
await add('small-no-temporal-cap',(c)=>{delete c.temporal;},'reject');
await add('small-events-without-cap',(c,p)=>{c.uplink.streams=c.uplink.streams.filter(s=>s!=='candidate_events');p.temporal.report_mode='terminal_only';p.uplink.streams.push('candidate_events');p.local_queue.max_bytes=8192;p.local_queue.max_items=4;p.local_queue.stream_reserves.push({stream:'candidate_events',bytes:2048,items:1});},'reject');
await add('small-budget-overflow',(_c,p)=>{p.local_queue.stream_reserves[0].bytes=8192;},'reject');
await add('small-history-budget',(_c,p)=>{p.resources.working_bytes=1024;},'reject');
await add('small-unknown-field',(_c,p)=>{p.temporal.future_field=1;},'reject');
process.stdout.write(JSON.stringify(cases));
