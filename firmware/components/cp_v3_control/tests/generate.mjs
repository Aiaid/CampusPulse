// Synthetic policy/capability fixtures built by the actual local core.
import { build } from 'esbuild';
const bundle = await build({ stdin: { contents: `export { capabilityDigestV3,freezeDeviceConfigV3,negotiateDeviceConfigV3 } from './worker/device-v3-config.ts';
export {supportsV3IngestPolicy} from './worker/device-v3-ingest-validation.ts';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const caps = { schema:'device-capabilities/1',capability_id:'synthetic-caps',node_id:'synthetic-node',boot_id:'11111111-1111-4111-8111-111111111111',
  producer_version:'cp-v3-producer/1',policy_schemas:['device-config/3'],issued_at:'2026-10-30T00:00:00.000Z',expires_at:'2026-10-30T01:00:00.000Z',
  scanner:{modes:['passive'],phys:['1m'],duplicate_filter:[false],min_interval_units:4,max_interval_units:16384},
  summary:{max_addresses:16,max_bins:10,max_window_ms:10000},features:{schemas:['ble-feature-evidence/1'],extractor_versions:['cp-v3-ad/1'],fields:['company_ids','appearance'],populations:['all_worker_reports'],max_reports_per_window:10000,max_bytes_per_window:65536},
  local_raw:null,uplink:{transports:['https'],streams:['feature_summaries','node_status'],max_batch_items:1,max_body_bytes:4096,max_sample_reports_per_window:0,cpraw_archive:false},
  queue:{media:[{medium:'tf_journal',usable_bytes:49152,max_items:12,power_loss_recovery:true}]},resources:{max_working_bytes:2097152,max_storage_write_bytes_per_day:16777216,tf_usable_bytes:262144}};
const policy = { schema:'device-config/3',protocol:'campuspulse/3',policy_id:'synthetic-policy',node_id:caps.node_id,revision:1,assignment_generation:1,
  collection:{enabled:true,mode:'fixed_point',scan:{mode:'passive',interval_units:160,window_units:160,duplicate_filter:false,phys:['1m']},summary:{enabled:true,window_ms:10000,bin_ms:1000,max_addresses:16}},
  local_raw:{mode:'off'},evidence:{mode:'features',schema:'ble-feature-evidence/1',extractor_version:'cp-v3-ad/1',population:'all_worker_reports',sample_every_n:null,fields:[{kind:'company_ids',max_values_per_identifier:4},{kind:'appearance',max_values_per_identifier:2}],max_reports_per_window:10000,max_bytes_per_window:65536,overflow:'count_and_mark_partial'},
  uplink:{enabled:true,transport:'https',streams:['feature_summaries','node_status'],max_batch_items:1,max_body_bytes:4096,retry:{min_delay_ms:1000,max_delay_ms:5000,max_attempts:3},raw_sample:{mode:'off'},archive:{mode:'off'}},
  local_queue:{mode:'durable',medium:'tf_journal',max_bytes:49152,max_items:12,control_reserve_bytes:8192,control_reserve_items:2,stream_reserves:[{stream:'feature_summaries',bytes:32768,items:8},{stream:'node_status',bytes:8192,items:2}],high_water_percent:80,full_behavior:'pause_collection',recovery:'exact_frozen_batches'},
  resources:{working_bytes:1048576,storage_write_bytes_per_day:1048576},custody:{dataset:'controlled_test',purpose:'controlled_test',placement_id:'synthetic-placement',association_scope:'window',source_retention_hours:1,derived_retention_hours:1,accept_until:'2026-10-30T02:00:00.000Z',max_upload_bytes_per_day:262144},
  control:{capability_sha256:await api.capabilityDigestV3(caps),activation:{boot_id:caps.boot_id,boundary:'closed_window_and_segment',after_window_seq:0,after_segment_seq:0,not_before:'2026-10-30T00:00:30.000Z',expires_at:'2026-10-30T00:30:00.000Z'},lease:{duration_ms:600000,on_collection_expiry:'pause',on_raw_expiry:'stop_recording',on_uplink_expiry:'pause'}}};
const context={node_id:caps.node_id,boot_id:caps.boot_id,now:'2026-10-30T00:01:00.000Z',last_assignment_generation:0,closed_window_seq:0,closed_segment_seq:0,window_open:false,segment_open:false};
const cases=[];
async function add(name, mutate, expected='trial') {
  const c=structuredClone(caps),p=structuredClone(policy);mutate?.(c,p);
  const capHash=await api.capabilityDigestV3(c);
  if(!['binding','changed-caps'].includes(name))p.control.capability_sha256=capHash;
  let frozen,compatible=false;
  try { frozen=await api.freezeDeviceConfigV3(p);const n=await api.negotiateDeviceConfigV3(frozen,c,context);compatible=n.state==='compatible'&&api.supportsV3IngestPolicy(p); }
  catch { frozen={schema:'device-config-envelope/3',policy:p,policy_sha256:'0'.repeat(64)}; }
  if(name==='wrong-hash')frozen.policy_sha256='0'.repeat(64);
  if(expected==='trial'&&!compatible)throw Error(`Invalid positive fixture ${name}`);
  if(expected==='reject'&&compatible&&name!=='wrong-hash')throw Error(`Invalid negative fixture ${name}`);
  cases.push({name,expected,caps:c,cap_hash:capHash,policy_hash:frozen.policy_sha256,response:{protocol:'campuspulse/3',server_time:context.now,data_ingestion_available:true,requires_device_ack:true,config:frozen,reason:null,applied_generation:null,activation_not_before:p.control.activation.not_before}});
}
await add('baseline');
await add('reordered',(c,p)=>{c.uplink.streams.reverse();c.features.fields.reverse();p.evidence.fields.reverse();p.uplink.streams.reverse();p.local_queue.stream_reserves.reverse();});
await add('flash',(c,p)=>{c.local_raw=null;c.resources.tf_usable_bytes=null;c.queue.media[0].medium='flash_journal';p.local_queue.medium='flash_journal';});
await add('wrong-hash',null,'reject');
await add('binding',(_c,p)=>{p.control.capability_sha256='b'.repeat(64);},'reject');
await add('changed-caps',(c)=>{c.summary.max_addresses=8;},'reject');
await add('unknown-root',(_c,p)=>{p.unrecognized=true;},'reject');
await add('wrong-node',(_c,p)=>{p.node_id='different-node';},'reject');
await add('wrong-boot',(_c,p)=>{p.control.activation.boot_id='22222222-2222-4222-8222-222222222222';},'reject');
await add('bad-reserves',(_c,p)=>{p.local_queue.stream_reserves[0].bytes=50000;},'reject');
await add('bad-bin',(_c,p)=>{p.collection.summary.bin_ms=3000;},'reject');
await add('unsupported-field',(_c,p)=>{p.evidence.fields[0].kind='service_uuids';},'reject');
await add('expired',(_c,p)=>{p.control.activation.expires_at='2026-10-30T00:00:59.000Z';},'reject');
const stale=structuredClone(cases[0]);stale.name='stale-applied';stale.expected='reject';stale.response.applied_generation=2;
if((await api.negotiateDeviceConfigV3(stale.response.config,stale.caps,{...context,last_assignment_generation:2})).state!=='rejected')throw Error('Stale fixture failed');
cases.push(stale);
process.stdout.write(JSON.stringify(cases));
