/** Read-only administrator evidence. No device credentials or opaque source JSON. */
import type {Env} from './types';
import type {AuthAssertion} from './admin-auth';
import {IngestError} from './ingest-validation';
import {json} from './ingest';
type Row=Record<string,unknown>;
const ID=/^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH=/^[0-9a-f]{64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const num=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:null;
const str=(v:unknown,re:RegExp)=>typeof v==='string'&&re.test(v)?v:null;
const obj=(v:unknown):Row|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Row:null;
const parse=(v:unknown):Row|null=>{try{return typeof v==='string'?obj(JSON.parse(v)):null;}catch{return null;}};
const bool=(v:unknown)=>typeof v==='boolean'?v:null;
const time=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))?v:null;
const numbers=(r:Row,keys:readonly string[])=>Object.fromEntries(keys.map(k=>[k,num(r[k])]));
const choice=(v:unknown,values:readonly string[])=>typeof v==='string'&&values.includes(v)?v:null;
const SUMMARY_MEMORY=['internal_free','internal_min','largest_internal_block','psram_free','stack_min'];
const SUMMARY_LOSS=['window_drops','event_drops','status_coalesced','upload_failures','ack_failures','retries'];
const RAW=['enqueued','written','synced','queue_drops','storage_failures','space_stops'];
const STREAMS=['window_statistics','candidate_events','node_status'];
const LABEL=/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}$/;
async function authorized(env:Env,a:AuthAssertion){
 const r=await env.DB.prepare(`SELECT CASE WHEN (${a.sql}) THEN 1 ELSE 0 END AS ok`).bind(...a.bindings).first<{ok:number}>();
 if(r?.ok!==1)throw new IngestError(401,'unauthorized','Administrator session is no longer valid.');
}
function controls(r:Row){return {boot_id:str(r.boot_id,UUID),registration_seq:num(r.registration_seq),uptime_ms:num(r.uptime_ms),
 registered_at:time(r.registered_at),state_version:num(r.state_version),desired_generation:num(r.desired_generation),applied_generation:num(r.applied_generation),apply_seq:num(r.apply_seq)};}
function acknowledgement(r:Row){const j=parse(r.acknowledgement_json);return {generation:num(r.generation),boot_id:str(r.boot_id,UUID),apply_seq:num(r.apply_seq),
 state:choice(r.state,['applied','failed']),body_sha256:str(r.body_sha256,HASH),received_at:time(r.received_at),
 policy_id:str(j?.policy_id,ID),policy_sha256:str(j?.policy_sha256,HASH),closed_window_seq:num(j?.closed_window_seq),closed_segment_seq:num(j?.closed_segment_seq),
 window_open:bool(j?.window_open),segment_open:bool(j?.segment_open),server_time:time(j?.server_time),lease_until_ms:num(j?.lease_until_ms),contact_seq:num(j?.contact_seq),
 tuple_match:!!j&&j.node_id===r.node_id&&j.boot_id===r.boot_id&&j.assignment_generation===r.generation&&j.apply_seq===r.apply_seq&&j.state===r.state&&
  j.policy_id===r.policy_id&&j.policy_sha256===r.policy_sha256&&(j.body_sha256===undefined||j.body_sha256===r.body_sha256)};}
function assignment(r:Row){const p=obj(parse(r.envelope_json)?.policy),c=parse(r.capability_json),u=obj(c?.uplink),pu=obj(p?.uplink),custody=obj(p?.custody);
 const transports=Array.isArray(u?.transports)&&u.transports.every(x=>x==='https'||x==='mqtt_tls')&&u.transports.length<=2?u.transports:null;
 return {generation:num(r.generation),boot_id:str(r.boot_id,UUID),policy_id:str(r.policy_id,ID),policy_sha256:str(r.policy_sha256,HASH),
  assigned_at:time(r.assigned_at),placement_id:str(r.placement_id,ID),assigned_place_id:str(r.assigned_place_id,ID),
  policy_transport:choice(pu?.transport,['https','mqtt_tls']),policy_uplink_enabled:bool(pu?.enabled),
  dataset:choice(custody?.dataset,['field','controlled_test','demo','research_unassigned']),
  capability:{producer_version:str(c?.producer_version,LABEL),uplink_transports:transports,max_body_bytes:num(u?.max_body_bytes),max_batch_items:num(u?.max_batch_items)},
  original_authority_tuple_match:!!p&&!!c&&p.node_id===r.node_id&&p.assignment_generation===r.generation&&p.policy_id===r.policy_id&&c.node_id===r.node_id&&c.boot_id===r.boot_id};}
function window(r:Row){return {generation:num(r.generation),boot_id:str(r.boot_id,UUID),seq:num(r.seq),window_seq:num(r.window_seq),clock_epoch:num(r.clock_epoch),
 batch_id:str(r.batch_id,UUID),placement_id:str(r.placement_id,ID),assigned_place_id:str(r.assigned_place_id,ID),
 dataset:choice(r.dataset,['field','controlled_test','demo']),collection_mode:choice(r.collection_mode,['fixed_point','mobile_research']),
 ...numbers(r,['duration_ms','end_utc_ms','end_mono_ms','uncertainty_ms','received_at_ms','quality_mask','expires_at_ms','retain_until_ms']),
 payload_available:r.payload_available===1,bin_ms:num(r.bin_ms),visible_identifiers:num(r.visible_identifiers),estimated_total:null,
 reports:{received:num(r.report_received),worker:num(r.report_worker),adv:num(r.report_adv),scan_response:num(r.report_scan_response)},
 losses:{scan_coverage_ms:num(r.scan_coverage_ms),callback_drops:num(r.callback_drops),aggregation_drops:num(r.aggregation_drops),address_overflow_reports:num(r.address_overflow_reports)},
 versions:{extractor_version:str(r.extractor_version,LABEL),ruleset_version:str(r.ruleset_version,LABEL)}};}
function status(r:Row){return {generation:num(r.generation),boot_id:str(r.boot_id,UUID),seq:num(r.seq),batch_id:str(r.batch_id,UUID),
 ...numbers(r,['uptime_ms','clock_epoch','expires_at_ms','retain_until_ms','time_utc_ms','time_mono_ms','time_uncertainty_ms']),
 payload_available:r.payload_available===1,collection_state:choice(r.collection_state,['running','paused','failed']),
 memory:numbers(r,SUMMARY_MEMORY),queue:Object.fromEntries(STREAMS.map(s=>[s,{pending_items:num(r[s+'_items']),pending_bytes:num(r[s+'_bytes'])}])),
 losses:numbers(r,SUMMARY_LOSS),raw_recording:r.raw_available===1?Object.fromEntries(RAW.map(k=>[k,num(r['raw_'+k])])):null};}
function batch(r:Row){const j=parse(r.receipt_json);const receipt=j?{
 protocol:choice(j.protocol,['campuspulse/3']),schema:choice(j.schema,['device-statistics-receipt/3']),node_id:str(j.node_id,ID),boot_id:str(j.boot_id,UUID),
 stream:choice(j.stream,STREAMS),batch_id:str(j.batch_id,UUID),body_sha256:str(j.body_sha256,HASH),policy_id:str(j.policy_id,ID),policy_sha256:str(j.policy_sha256,HASH),
 ...numbers(j,['assignment_generation','seq_first','seq_last','accepted_count']),receipt_id:str(j.receipt_id,UUID),received_at:time(j.received_at),expires_at:time(j.expires_at),retain_until:time(j.retain_until),
 durability:choice(j.durability,['committed']),custody:choice(j.custody,['small_statistics'])}:null;
 const shape=!!j&&!!receipt&&Object.keys(j).length===Object.keys(receipt).length&&Object.keys(j).every(k=>Object.hasOwn(receipt,k))&&Object.values(receipt).every(v=>v!==null)&&
  [j.assignment_generation,j.seq_first,j.seq_last,j.accepted_count].every(v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=1)&&
  Number(j.seq_last)>=Number(j.seq_first)&&Number(j.seq_last)<=0xffffffff&&Number(j.accepted_count)<=128;
 const tuple=shape&&j.node_id===r.node_id&&j.boot_id===r.boot_id&&j.stream===r.stream&&j.batch_id===r.batch_id&&j.body_sha256===r.body_sha256&&
  j.policy_id===r.policy_id&&j.policy_sha256===r.policy_sha256&&j.assignment_generation===r.generation&&j.seq_first===r.seq_first&&j.seq_last===r.seq_last&&
  Date.parse(String(j.expires_at))===r.expires_at_ms&&Date.parse(String(j.retain_until))===r.retain_until_ms;
 const sourceMatch=r.stream==='candidate_events'?null:tuple&&j.accepted_count===r.source_count&&j.seq_first===r.source_seq_first&&j.seq_last===r.source_seq_last;
 return {generation:num(r.generation),boot_id:str(r.boot_id,UUID),stream:choice(r.stream,STREAMS),batch_id:str(r.batch_id,UUID),body_sha256:str(r.body_sha256,HASH),
 seq_first:num(r.seq_first),seq_last:num(r.seq_last),receipt,receipt_shape_valid:shape,receipt_tuple_match:tuple,source_rows_match:sourceMatch,
 source_count:num(r.source_count),original_request_bytes_rehashed:false};}

/** Caller authenticates the signed administrator session; no alternate principal. */
export async function readAdminDeviceV3Evidence(request:Request,env:Env,node:string,authorization:AuthAssertion):Promise<Response>{
 const q=new URL(request.url).searchParams;
 if([...q.keys()].some(k=>!['limit','generation'].includes(k))||q.getAll('limit').length>1||q.getAll('generation').length>1)
  throw new IngestError(422,'invalid_v3_evidence_query','Use only one limit and optional generation.');
 const limitText=q.get('limit')??'20',generationText=q.get('generation');
 if(!/^[1-9][0-9]*$/.test(limitText)||Number(limitText)>50||generationText!==null&&(!/^[1-9][0-9]*$/.test(generationText)||!Number.isSafeInteger(Number(generationText))))
  throw new IngestError(422,'invalid_v3_evidence_query','Limit must be 1–50 and generation a positive safe integer.');
 const limit=Number(limitText),generation=generationText===null?null:Number(generationText),take=limit+1;
 await authorized(env,authorization);
 const filters=(alias:string)=>`${alias}.node_id=?${generation===null?'':` AND ${alias}.generation=?`}`;
 const args=generation===null?[node]:[node,generation];
 const read=(sql:string,values:(string|number)[]=args)=>env.DB.prepare(sql).bind(...values);
 const guard=()=>env.DB.prepare(`SELECT CASE WHEN (${authorization.sql}) THEN 1 ELSE 0 END AS ok`).bind(...authorization.bindings);
 const lists={
  assignments:read(`SELECT a.node_id,a.generation,a.boot_id,a.policy_id,a.policy_sha256,a.placement_id,a.assigned_at,a.envelope_json,c.capability_json,p.place_id AS assigned_place_id
   FROM device_assignments_v3 a JOIN device_capabilities_v3 c ON c.node_id=a.node_id AND c.capability_sha256=a.capability_sha256
   LEFT JOIN placements p ON p.id=a.placement_id AND p.node_id=a.node_id WHERE ${filters('a')} ORDER BY a.generation DESC LIMIT ?`,[...args,take]),
  acknowledgements:read(`SELECT k.node_id,k.generation,k.boot_id,k.apply_seq,k.state,k.body_sha256,k.acknowledgement_json,k.received_at,a.policy_id,a.policy_sha256
   FROM device_acknowledgements_v3 k JOIN device_assignments_v3 a ON a.node_id=k.node_id AND a.generation=k.generation
   WHERE ${filters('k')} ORDER BY k.generation DESC LIMIT ?`,[...args,take]),
  leases:read(`SELECT a.generation,a.boot_id,a.policy_sha256,a.accept_until_ms,a.lease_until_ms,a.contact_seq,a.uptime_ms,a.state_version,a.span_count,a.body_sha256,
   json_extract(a.receipt_json,'$.server_time') AS server_time,json_extract(a.receipt_json,'$.span_seq') AS receipt_span_seq,
   json_extract(a.receipt_json,'$.contiguous') AS contiguous FROM device_statistics_authorizations_v3 a WHERE ${filters('a')} ORDER BY a.generation DESC LIMIT ?`,[...args,take]),
  lease_spans:read(`SELECT s.generation,s.span_seq,s.start_ms,s.end_ms,s.accept_until_ms FROM device_statistics_lease_spans_v3 s WHERE ${filters('s')} ORDER BY s.generation DESC,s.span_seq DESC LIMIT ?`,[...args,take]),
  windows:read(`SELECT w.generation,w.boot_id,w.seq,w.window_seq,w.clock_epoch,w.batch_id,w.placement_id,w.dataset,w.collection_mode,w.duration_ms,w.end_utc_ms,w.end_mono_ms,w.uncertainty_ms,
   w.received_at_ms,w.quality_mask,w.extractor_version,w.ruleset_version,w.expires_at_ms,w.retain_until_ms,p.place_id AS assigned_place_id,
   CASE WHEN w.item_json IS NULL THEN 0 ELSE 1 END AS payload_available,
   ${['bin_ms','visible_identifiers','reports.received','reports.worker','reports.adv','reports.scan_response','losses.scan_coverage_ms','losses.callback_drops','losses.aggregation_drops','losses.address_overflow_reports'].map((k,i)=>`json_extract(w.item_json,'$.${k}') AS ${['bin_ms','visible_identifiers','report_received','report_worker','report_adv','report_scan_response','scan_coverage_ms','callback_drops','aggregation_drops','address_overflow_reports'][i]}`).join(',')}
   FROM statistics_windows_v3 w LEFT JOIN placements p ON p.id=w.placement_id AND p.node_id=w.node_id WHERE ${filters('w')} ORDER BY w.generation DESC,w.seq DESC LIMIT ?`,[...args,take]),
  statuses:read(`SELECT b.generation,s.boot_id,s.seq,s.batch_id,s.uptime_ms,s.clock_epoch,s.expires_at_ms,s.retain_until_ms,${SUMMARY_LOSS.map(k=>'s.'+k).join(',')},${RAW.map(k=>'s.raw_'+k).join(',')},
   CASE WHEN s.item_json IS NULL THEN 0 ELSE 1 END AS payload_available,CASE WHEN json_type(s.item_json,'$.raw_recording')='object' THEN 1 ELSE 0 END AS raw_available,
   json_extract(s.item_json,'$.collection_state') AS collection_state,
   ${SUMMARY_MEMORY.map(k=>`json_extract(s.item_json,'$.memory.${k}') AS ${k}`).join(',')},
   ${STREAMS.flatMap(k=>['items','bytes'].map(t=>`json_extract(s.item_json,'$.queue.${k}.pending_${t}') AS ${k}_${t}`)).join(',')},
   json_extract(s.item_json,'$.time.utc_ms') AS time_utc_ms,json_extract(s.item_json,'$.time.mono_ms') AS time_mono_ms,json_extract(s.item_json,'$.time.uncertainty_ms') AS time_uncertainty_ms
   FROM statistics_status_v3 s JOIN statistics_batches_v3 b ON b.node_id=s.node_id AND b.batch_id=s.batch_id WHERE ${filters('b')} ORDER BY b.generation DESC,s.seq DESC LIMIT ?`,[...args,take]),
  batches:read(`SELECT b.node_id,b.generation,b.boot_id,b.stream,b.batch_id,b.body_sha256,b.policy_sha256,b.seq_first,b.seq_last,b.receipt_json,b.expires_at_ms,b.retain_until_ms,a.policy_id,
   CASE b.stream WHEN 'window_statistics' THEN (SELECT COUNT(*) FROM statistics_windows_v3 w WHERE w.node_id=b.node_id AND w.batch_id=b.batch_id)
    WHEN 'node_status' THEN (SELECT COUNT(*) FROM statistics_status_v3 s WHERE s.node_id=b.node_id AND s.batch_id=b.batch_id) END AS source_count,
   CASE b.stream WHEN 'window_statistics' THEN (SELECT MIN(seq) FROM statistics_windows_v3 w WHERE w.node_id=b.node_id AND w.batch_id=b.batch_id)
    WHEN 'node_status' THEN (SELECT MIN(seq) FROM statistics_status_v3 s WHERE s.node_id=b.node_id AND s.batch_id=b.batch_id) END AS source_seq_first,
   CASE b.stream WHEN 'window_statistics' THEN (SELECT MAX(seq) FROM statistics_windows_v3 w WHERE w.node_id=b.node_id AND w.batch_id=b.batch_id)
    WHEN 'node_status' THEN (SELECT MAX(seq) FROM statistics_status_v3 s WHERE s.node_id=b.node_id AND s.batch_id=b.batch_id) END AS source_seq_last
   FROM statistics_batches_v3 b JOIN device_assignments_v3 a ON a.node_id=b.node_id AND a.generation=b.generation WHERE ${filters('b')}
   ORDER BY b.generation DESC,b.seq_first DESC,b.stream,b.batch_id LIMIT ?`,[...args,take]),
 };
 const counts=read(`SELECT
  (SELECT COUNT(*) FROM statistics_batches_v3 b WHERE ${filters('b')}) AS batches,
  (SELECT COUNT(*) FROM statistics_windows_v3 w WHERE ${filters('w')}) AS windows,
  (SELECT COUNT(*) FROM statistics_status_v3 s JOIN statistics_batches_v3 b ON b.node_id=s.node_id AND b.batch_id=s.batch_id WHERE ${filters('b')}) AS statuses,
  (SELECT COUNT(*) FROM statistics_events_v3 e WHERE ${filters('e')}) AS latest_events,
  (SELECT COUNT(*) FROM public_sensor_projection_v2 WHERE node_id=?) AS legacy_public_projection_rows`,[...args,...args,...args,...args,node]);
 const names=Object.keys(lists);
 const results=await env.DB.batch<Row>([guard(),read('SELECT id,enabled FROM device_nodes WHERE id=?',[node]),
  read('SELECT boot_id,registration_seq,uptime_ms,registered_at,state_version,desired_generation,applied_generation,apply_seq FROM device_control_v3 WHERE node_id=?',[node]),
  ...Object.values(lists),counts,guard()]);
 if(results[0].results[0]?.ok!==1||results.at(-1)?.results[0]?.ok!==1)throw new IngestError(401,'unauthorized','Administrator session changed during evidence read.');
 await authorized(env,authorization);
 if(results[1].results.length!==1)throw new IngestError(404,'device_not_found','Unknown device.');
 const rows=Object.fromEntries(names.map((k,i)=>[k,results[i+3].results]));
 const bounded=(name:string,mapper:(r:Row)=>unknown)=>({rows:rows[name].slice(0,limit).map(mapper),returned:Math.min(rows[name].length,limit),limit,truncated:rows[name].length>limit,has_more:rows[name].length>limit});
 return json({schema:'admin-device-v3-evidence/1',node_id:node,enabled:results[1].results[0].enabled===1,read_only:true,
  snapshot:'single-d1-batch',as_of:new Date().toISOString(),original_request_bytes_rehashed:false,
  bounds:{default_limit:20,max_limit:50,limit,generation,ordering:'generation_desc_then_stream_sequence_desc',lists_independently_bounded:true},
  control:results[2].results[0]?controls(results[2].results[0]):null,
  counts:{...numbers(results[3+names.length].results[0],['batches','windows','statuses','latest_events']),
   legacy_public_projection_rows:num(results[3+names.length].results[0].legacy_public_projection_rows),legacy_public_projection_scope:'this_node_all_legacy_generations'},
  assignments:bounded('assignments',assignment),acknowledgements:bounded('acknowledgements',acknowledgement),
  leases:bounded('leases',r=>({...numbers(r,['generation','accept_until_ms','lease_until_ms','contact_seq','uptime_ms','state_version','span_count','receipt_span_seq']),
   boot_id:str(r.boot_id,UUID),policy_sha256:str(r.policy_sha256,HASH),body_sha256:str(r.body_sha256,HASH),server_time:time(r.server_time),contiguous:r.contiguous===null?null:r.contiguous===1})),
  lease_spans:bounded('lease_spans',r=>numbers(r,['generation','span_seq','start_ms','end_ms','accept_until_ms'])),
  windows:bounded('windows',window),statuses:bounded('statuses',status),batches:bounded('batches',batch)});
}
