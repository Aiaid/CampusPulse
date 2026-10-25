import type { Env } from './types';
import { IngestError, parseIngestJson } from './ingest-validation';
import { IngestStoreError } from './ingest-store';
import { archive, authorizeResearch, device, json, MAX_INGEST_BYTES, readBytes, sha256 } from './ingest';
import { validateCaptureConfigV2, validateConfigBatchV2, validateEnvelopeV2, object, string, integer, choice, UUID, ID, type CaptureConfigV2 } from './device-v2-validation';
import { commitBatchV2, findReceiptV2 } from './device-v2-store';
import { parseAdvertisement } from './ble-ad';
interface ConfigRow { config_json:string;accept_until_ms:number;raw_retention_hours:number;aggregate_retention_days:number }
interface ControlRow { node_id:string;boot_id:string;contact_seq:number;contact_sha256:string;contact_json:string;received_at:string;apply_seq:number;activation_sha256:string|null;activation_received_at:string|null;applied_config_id:string|null }
const DEFAULT_LEASE=120000;
function reject(code:string,message:string):never { throw new IngestError(409,code,message); }
async function configRow(env:Env,node:string,id?:string):Promise<ConfigRow|null> {
 return env.DB.prepare(`SELECT c.config_json,c.accept_until_ms,c.raw_retention_hours,c.aggregate_retention_days FROM capture_configs c
 JOIN config_assignments a ON a.capture_config_id=c.id AND a.node_id=c.node_id
 ${id ? '' : 'JOIN device_desired_configs d ON d.node_id=c.node_id AND d.capture_config_id=c.id'}
 WHERE c.node_id=? ${id ? 'AND c.id=?' : ''} LIMIT 1`).bind(...(id?[node,id]:[node])).first<ConfigRow>();
}
function trustedConfig(row:ConfigRow):CaptureConfigV2 {
 try { return validateCaptureConfigV2(JSON.parse(row.config_json)); }
 catch { throw new IngestError(503,'capture_config_invalid','Registered v2 policy is invalid.'); }
}
async function currentControl(env:Env,node:string) { return env.DB.prepare('SELECT * FROM device_control_v2 WHERE node_id=?').bind(node).first<ControlRow>(); }
function contactAck(node:string,boot:string,seq:number,received:string) { return { node_id:node,boot_id:boot,contact_seq:seq,received_at:received,control:{lease_ms:DEFAULT_LEASE} }; }
async function contact(request:Request,env:Env,node:string) {
 const bytes=await readBytes(request,4096),hash=await sha256(bytes);
 const o=object(parseIngestJson(bytes),'contact',['protocol','boot_id','contact_seq','firmware_version','uptime_ms','wifi_state','capture_state','applied_config_id']);
 choice(o.protocol,'contact.protocol',['campuspulse/2']);
 const boot=string(o.boot_id,'contact.boot_id',UUID),seq=integer(o.contact_seq,'contact.contact_seq',1,0xffffffff);
 const firmware=string(o.firmware_version,'contact.firmware_version',/^[^\x00-\x1f\x7f]{1,80}$/);
 const uptime=integer(o.uptime_ms,'contact.uptime_ms');
 string(o.wifi_state,'contact.wifi_state',/^[a-z][a-z0-9_]{0,63}$/);
 choice(o.capture_state,'contact.capture_state',['unassigned','running','paused','expired','failed']);
 if(o.applied_config_id!==null) string(o.applied_config_id,'contact.applied_config_id');
 const old=await currentControl(env,node);
 if(old?.boot_id===boot&&old.contact_seq===seq) {
  if(old.contact_sha256!==hash) reject('contact_conflict','Contact sequence already has different bytes.');
  return json(contactAck(node,boot,seq,old.received_at));
 }
 if(old?.boot_id===boot&&(seq<old.contact_seq||uptime<(JSON.parse(old.contact_json) as {uptime_ms:number}).uptime_ms)) reject('stale_contact','Contact ordering must advance within the current boot.');
 if(old?.boot_id!==boot && await env.DB.prepare('SELECT 1 FROM device_boots_v2 WHERE node_id=? AND boot_id=?').bind(node,boot).first()) reject('retired_boot','A retired boot cannot replace the current boot.');
 const now=new Date().toISOString(),guard=crypto.randomUUID();
 try {
  await env.DB.batch([
   env.DB.prepare(`INSERT INTO admin_write_assertions(id,ok) SELECT ?,CASE WHEN (
     (NOT EXISTS(SELECT 1 FROM device_boots_v2 WHERE node_id=? AND boot_id=?)) OR
     EXISTS(SELECT 1 FROM device_control_v2 WHERE node_id=? AND boot_id=? AND contact_seq<? AND json_extract(contact_json,'$.uptime_ms')<=?)
   ) THEN 1 ELSE 0 END`).bind(guard,node,boot,node,boot,seq,uptime),
   env.DB.prepare('INSERT INTO device_boots_v2(node_id,boot_id,first_seen_at) VALUES(?,?,?) ON CONFLICT(node_id,boot_id) DO NOTHING').bind(node,boot,now),
   env.DB.prepare(`INSERT INTO device_control_v2(node_id,boot_id,contact_seq,contact_sha256,contact_json,firmware_version,received_at) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(node_id) DO UPDATE SET boot_id=excluded.boot_id,contact_seq=excluded.contact_seq,contact_sha256=excluded.contact_sha256,contact_json=excluded.contact_json,firmware_version=excluded.firmware_version,received_at=excluded.received_at,
     apply_seq=CASE WHEN device_control_v2.boot_id=excluded.boot_id THEN device_control_v2.apply_seq ELSE 0 END,
     applied_config_id=CASE WHEN device_control_v2.boot_id=excluded.boot_id THEN device_control_v2.applied_config_id ELSE NULL END,
     activation_config_id=CASE WHEN device_control_v2.boot_id=excluded.boot_id THEN device_control_v2.activation_config_id ELSE NULL END,
     activation_state=CASE WHEN device_control_v2.boot_id=excluded.boot_id THEN device_control_v2.activation_state ELSE NULL END,
     activation_message=CASE WHEN device_control_v2.boot_id=excluded.boot_id THEN device_control_v2.activation_message ELSE NULL END,
     activation_sha256=CASE WHEN device_control_v2.boot_id=excluded.boot_id THEN device_control_v2.activation_sha256 ELSE NULL END,
     activation_received_at=CASE WHEN device_control_v2.boot_id=excluded.boot_id THEN device_control_v2.activation_received_at ELSE NULL END`)
     .bind(node,boot,seq,hash,JSON.stringify(o),firmware,now),
   env.DB.prepare('DELETE FROM admin_write_assertions WHERE id=?').bind(guard),
  ]);
 } catch(error) {
  const winner=await currentControl(env,node);
  if(winner?.boot_id===boot&&winner.contact_seq===seq&&winner.contact_sha256===hash) return json(contactAck(node,boot,seq,winner.received_at));
  if(error instanceof Error && /boot_history_full/.test(error.message)) throw new IngestError(409,'boot_history_full','Device boot history is full; operator recovery is required.');
  const changed=winner && (!old || winner.boot_id!==old.boot_id || winner.contact_seq!==old.contact_seq || winner.contact_sha256!==old.contact_sha256);
  if(changed && (winner.boot_id!==boot || winner.contact_seq>=seq ||
    uptime<(JSON.parse(winner.contact_json) as {uptime_ms:number}).uptime_ms))
    reject('stale_contact','Contact lost an ordering race; preserve the current boot.');
  throw error;
 }
 return json(contactAck(node,boot,seq,now));
}
async function activate(request:Request,env:Env,node:string) {
 const bytes=await readBytes(request,4096),hash=await sha256(bytes);
 const o=object(parseIngestJson(bytes),'activation',['capture_config_id','boot_id','apply_seq','state'],['message']);
 const id=string(o.capture_config_id,'activation.capture_config_id'),boot=string(o.boot_id,'activation.boot_id',UUID),seq=integer(o.apply_seq,'activation.apply_seq',1,0xffffffff);
 const state=choice(o.state,'activation.state',['applied','failed']);
 const message=o.message===undefined?null:string(o.message,'activation.message',/^[a-z0-9][a-z0-9_.:-]{0,79}$/);
 const old=await currentControl(env,node);
 if(!old||old.boot_id!==boot) reject('current_boot_required','Contact the server from the current boot before acknowledging activation.');
 if(old.apply_seq===seq) {
  if(old.activation_sha256!==hash) reject('activation_conflict','Apply sequence already has different bytes.');
  return json({node_id:node,...o,received_at:old.activation_received_at});
 }
 if(seq<old.apply_seq) reject('stale_activation','Apply sequence must increase within the current boot.');
 const row=await configRow(env,node,id);
 if(!row) throw new IngestError(403,'config_not_assigned','Acknowledge only a policy assigned to this device.');
 trustedConfig(row);
 if(state==='applied'&&row.accept_until_ms<Date.now()) throw new IngestError(410,'capture_config_expired','Expired policy cannot be activated.');
 const now=new Date().toISOString(),guard=crypto.randomUUID();
 try {
  await env.DB.batch([
   env.DB.prepare(`INSERT INTO admin_write_assertions(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM device_control_v2 WHERE node_id=? AND boot_id=? AND apply_seq<?) THEN 1 ELSE 0 END`).bind(guard,node,boot,seq),
   env.DB.prepare(`UPDATE device_control_v2 SET apply_seq=?,applied_config_id=CASE WHEN ?='applied' THEN ? ELSE applied_config_id END,
    activation_config_id=?,activation_state=?,activation_message=?,activation_sha256=?,activation_received_at=? WHERE node_id=? AND boot_id=?`).bind(seq,state,id,id,state,message,hash,now,node,boot),
   env.DB.prepare('INSERT INTO config_activation_events_v2(node_id,boot_id,capture_config_id,apply_seq,state,message,received_at,expires_at_ms) VALUES(?,?,?,?,?,?,?,?)').bind(node,boot,id,seq,state,message,now,Date.now()+30*86400000),
   env.DB.prepare('DELETE FROM admin_write_assertions WHERE id=?').bind(guard),
  ]);
 } catch(error) {
  const winner=await currentControl(env,node);
  if(winner?.boot_id===boot&&winner.apply_seq===seq&&winner.activation_sha256===hash) return json({node_id:node,...o,received_at:winner.activation_received_at});
  if(winner && (winner.boot_id!==boot || winner.apply_seq>=seq)) reject('stale_activation','Activation lost an ordering race.');
  throw error;
 }
 return json({node_id:node,...o,received_at:now});
}
export async function handleDeviceV2(request:Request,env:Env):Promise<Response|null> {
 const url=new URL(request.url),path=url.pathname;
 const research=/^\/api\/v2\/research\/batches\/([0-9a-f-]{36})$/.exec(path);
 if(!['/api/v2/device/config','/api/v2/device/contact','/api/v2/device/config/ack','/api/v2/ingest'].includes(path)&&!research) return null;
 try {
  const method=research||path==='/api/v2/device/config'?'GET':'POST';
  if(request.method!==method) throw new IngestError(405,'method_not_allowed',`Use ${method}.`);
  if(research) {
   await authorizeResearch(request,env);
   const node=string(url.searchParams.get('node_id'),'node_id');
   const row=await env.DB.prepare("SELECT stream,body_sha256,raw_object_key,expires_at_ms FROM ingestion_batches_v2 WHERE node_id=? AND batch_id=? AND stream IN ('address_summaries','ble_reports')").bind(node,research[1]).first<{stream:string;body_sha256:string;raw_object_key:string|null;expires_at_ms:number}>();
   if(!row) throw new IngestError(404,'batch_not_found','Unknown private batch.');
   if(row.expires_at_ms<=Date.now()) throw new IngestError(410,'evidence_expired','Private evidence retention has expired.');
   if(row.stream==='address_summaries') {
    const records=await env.DB.prepare('SELECT item_json FROM ingestion_items_v2 WHERE node_id=? AND batch_id=? ORDER BY seq').bind(node,research[1]).all<{item_json:string}>();
    return json({stream:row.stream,body_sha256:row.body_sha256,items:records.results.map(r=>JSON.parse(r.item_json))});
   }
   if(!env.RAW_BUCKET||!row.raw_object_key) throw new IngestError(503,'raw_integrity_error','Private evidence could not be verified.');
   const stored=await env.RAW_BUCKET.get(row.raw_object_key);
   if(!stored||stored.size>MAX_INGEST_BYTES) throw new IngestError(503,'raw_integrity_error','Private evidence could not be verified.');
   const bytes=new Uint8Array(await stored.arrayBuffer());
   if(await sha256(bytes)!==row.body_sha256) throw new IngestError(503,'raw_integrity_error','Private evidence could not be verified.');
   const batch=validateEnvelopeV2(parseIngestJson(bytes));
   if(batch.stream!=='ble_reports') throw new Error('Unexpected private stream');
   return json({batch,body_sha256:row.body_sha256,derived:batch.items.map(i=>({seq:i.seq,...parseAdvertisement(i.payload_hex)}))});
  }
  const node=await device(request,env);
  if(path==='/api/v2/device/contact') return await contact(request,env,node);
  if(path==='/api/v2/device/config/ack') return await activate(request,env,node);
  if(path==='/api/v2/device/config') {
   const requested=url.searchParams.get('capture_config_id');
   if(requested!==null&&!ID.test(requested)) throw new IngestError(422,'invalid_config_id','Invalid policy ID.');
   const row=await configRow(env,node,requested??undefined);
   const common={protocol:'campuspulse/2',server_time:new Date().toISOString(),server_limits:{max_items:128,max_body_bytes:MAX_INGEST_BYTES},control:{lease_ms:DEFAULT_LEASE}};
   if(!row) return json({...common,config:null,expired:false,reason:'unassigned'});
   const stored=JSON.parse(row.config_json) as {protocol?:string};
   if(stored.protocol!=='campuspulse/2') return json({...common,config:null,expired:false,reason:'protocol_mismatch'});
   const config=trustedConfig(row);
   return json({...common,config,control:config.control,expired:Date.now()>row.accept_until_ms,retention:{raw_hours:row.raw_retention_hours,aggregate_days:row.aggregate_retention_days,receipt_min_days_after_accept_until:7}});
  }
  const bytes=await readBytes(request),hash=await sha256(bytes);
  const supplied=request.headers.get('X-Body-SHA256');
  if(!supplied||!/^[0-9a-f]{64}$/.test(supplied)||supplied!==hash) throw new IngestError(400,'body_hash_mismatch','Provide SHA-256 of the exact request bytes.');
  const batch=validateEnvelopeV2(parseIngestJson(bytes));
  if(batch.node_id!==node) throw new IngestError(403,'node_not_allowed','Credential does not permit this node.');
  const receipt=await findReceiptV2(env.DB,node,batch.batch_id);
  if(receipt) { if(receipt.body_sha256!==hash) reject('batch_conflict','Batch ID already has different bytes.'); return json(receipt); }
  if(await env.DB.prepare('SELECT 1 FROM ingestion_batches WHERE node_id=? AND batch_id=?').bind(node,batch.batch_id).first()) reject('batch_conflict','Batch ID belongs to another protocol.');
  const row=await configRow(env,node,batch.capture_config_id);
  if(!row) throw new IngestError(403,'capture_config_not_allowed','No assigned capture policy.');
  const config=trustedConfig(row);
  if(bytes.byteLength>config.upload_policy.max_body_bytes) throw new IngestError(413,'payload_too_large','Request exceeds the configured byte limit.');
  validateConfigBatchV2(batch,config);
  if(Date.now()>row.accept_until_ms) throw new IngestError(410,'capture_config_expired','Capture policy expired; preserve queued data.');
  const key=batch.stream==='ble_reports'?await archive(env,node,batch.batch_id,hash,bytes):null;
  return json(await commitBatchV2(env.DB,batch,hash,key,row.raw_retention_hours,row.aggregate_retention_days,row.accept_until_ms,Date.now()));
 } catch(error) {
  if(error instanceof IngestError||error instanceof IngestStoreError) return json({error:{code:error.code,message:error.message,retryable:error.status>=500}},error.status);
  return json({error:{code:'storage_unavailable',message:'Service temporarily unavailable.',retryable:true}},503);
 }
}
