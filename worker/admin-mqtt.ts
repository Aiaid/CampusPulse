import type { Env } from './types';
import { base64url, requireFreshSession, sessionAssertion, type AdminSession, type AuthAssertion } from './admin-auth';
import { IngestError, parseIngestJson } from './strict-json';
import { json, readBytes } from './http';
import { assignMqtt, decryptMqtt, encryptMqttPassword, mqttForNode, mqttReadyAssertion, MQTT_BROKER_URI, MQTT_ID, readyMqtt, safeMqttRow, type MqttRow } from './mqtt-credentials';
import { MqttProbeError, verifyMqttBroker } from './mqtt-probe';

type Transact=(writes:D1PreparedStatement[],action:string,target:string,detail:Record<string,unknown>,assertions?:AuthAssertion[])=>Promise<void>;
const invalid=():never=>{throw new IngestError(422,'invalid_mqtt_input','Use a bounded MQTT pool count or explicit credential entries.');};
const auditFields=['username','namespace','state','node_id'];
function object(value:unknown):Record<string,unknown> {if(!value||typeof value!=='object'||Array.isArray(value))return invalid();return value as Record<string,unknown>;}
const csv=(rows:string[][])=>rows.map(row=>row.map(value=>`"${value.replaceAll('"','""')}"`).join(',')).join('\r\n')+'\r\n';
export async function handleAdminMqtt(request:Request,env:Env,route:string,session:AdminSession,transact:Transact):Promise<Response|null> {
 const verify=/^\/mqtt\/pool\/([0-9a-f-]{36})\/verify$/.exec(route);
 const device=/^\/devices\/([a-z0-9_-]{1,64})\/mqtt$/.exec(route);
 if(route!=='/mqtt/pool'&&!verify&&!device)return null;
 if(route==='/mqtt/pool'&&request.method==='GET') {
  const rows=await env.DB.prepare('SELECT * FROM mqtt_credentials ORDER BY created_at DESC,id LIMIT 501').all<MqttRow>();
  const count=await env.DB.prepare("SELECT COUNT(*) count FROM mqtt_credentials WHERE state='ready' AND node_id IS NULL AND verified_at IS NOT NULL").first<{count:number}>();
  return json({broker_uri:MQTT_BROKER_URI,ready_count:count?.count??0,entries:rows.results.slice(0,500).map(safeMqttRow),truncated:rows.results.length>500});
 }
 if(request.method!=='POST')throw new IngestError(405,'method_not_allowed','Use POST.');
 requireFreshSession(session);
 const body=object(parseIngestJson(await readBytes(request,32768)));
 if(device) {
  if(Object.keys(body).length)invalid();
  const node=device[1];
  const registered=await env.DB.prepare('SELECT enabled FROM device_nodes WHERE id=?').bind(node).first<{enabled:number}>();
  if(!registered)throw new IngestError(404,'device_not_found','Unknown device.');
  if(!registered.enabled)throw new IngestError(409,'device_disabled','Enable the device before recovering MQTT credentials.');
  const reserved=await env.DB.prepare('SELECT state,verified_at FROM mqtt_credentials WHERE node_id=?').bind(node).first<{state:string;verified_at:string|null}>();
  if(reserved&&(reserved.state!=='assigned'||!reserved.verified_at))throw new IngestError(409,'mqtt_identity_not_ready','Verify the existing broker identity before provisioning this device.');
  const existing=await mqttForNode(env,node),row=existing??await readyMqtt(env),mqtt=await decryptMqtt(env,row);
  await transact(existing?[]:[assignMqtt(env,row,node)],existing?'mqtt.credential.recover':'mqtt.credential.assign',node,{pool_id:row.id,fields:auditFields},[
   sessionAssertion(session,true),{sql:'EXISTS(SELECT 1 FROM device_nodes WHERE id=? AND enabled=1)',bindings:[node]},
   ...(existing?[{sql:"EXISTS(SELECT 1 FROM mqtt_credentials WHERE id=? AND node_id=? AND state='assigned' AND verified_at IS NOT NULL)",bindings:[row.id,node]}]:[mqttReadyAssertion(row)]),
  ]);
  return json({mqtt});
 }
 if(verify) {
  if(Object.keys(body).length)invalid();
  const row=await env.DB.prepare('SELECT * FROM mqtt_credentials WHERE id=?').bind(verify[1]).first<MqttRow>();
  if(!row)throw new IngestError(404,'mqtt_identity_not_found','Unknown MQTT pool identity.');
  try {await verifyMqttBroker(await decryptMqtt(env,row));}
  catch(error) {
   const code=error instanceof MqttProbeError?error.code:'mqtt_probe_unavailable';
   // A failed recheck revokes readiness/binding for new RPCs without rotating it.
   await transact([env.DB.prepare("UPDATE mqtt_credentials SET state='pending_broker',verified_at=NULL,verification_error=? WHERE id=?").bind(code,row.id)],'mqtt.pool.verify_failed',row.id,{code},[sessionAssertion(session,true)]);
   throw new IngestError(502,code,'Broker login or namespace ACL verification did not pass. The identity remains unavailable.');
  }
  const now=new Date().toISOString();
  await transact([env.DB.prepare("UPDATE mqtt_credentials SET state=CASE WHEN node_id IS NULL THEN 'ready' ELSE 'assigned' END,verified_at=?,verification_error=NULL WHERE id=?").bind(now,row.id)],'mqtt.pool.verify',row.id,{checks:['tls_login','own_reply_subscribe','cross_namespace_subscribe_denied','request_subscribe_denied','own_request_publish','cross_namespace_publish_denied','reply_publish_denied']},[sessionAssertion(session,true)]);
  return json({entry:safeMqttRow({...row,state:row.node_id?'assigned':'ready',verified_at:now,verification_error:null})});
 }
 let inputs:{username:string;namespace:string;password:string;node_id:string|null}[];
 if(Object.keys(body).length===1&&Object.hasOwn(body,'count')) {
  if(!Number.isSafeInteger(body.count)||Number(body.count)<1||Number(body.count)>32)invalid();
  inputs=Array.from({length:Number(body.count)},()=>{const id=`cp${Array.from(crypto.getRandomValues(new Uint8Array(6)),b=>b.toString(16).padStart(2,'0')).join('')}`;return {username:id,namespace:id,password:base64url(crypto.getRandomValues(new Uint8Array(32))),node_id:null};});
 } else if(Object.keys(body).length===1&&Array.isArray(body.entries)&&body.entries.length>=1&&body.entries.length<=32) {
  inputs=body.entries.map(item=>{const o=object(item);if(Object.keys(o).some(k=>!['username','password','namespace','node_id'].includes(k))||typeof o.username!=='string'||!MQTT_ID.test(o.username)||typeof o.namespace!=='string'||!MQTT_ID.test(o.namespace)||typeof o.password!=='string'||!/^[!-~]{16,96}$/.test(o.password)||o.node_id!==undefined&&(typeof o.node_id!=='string'||!/^[a-z0-9_-]{1,64}$/.test(o.node_id)))return invalid();return {username:o.username,namespace:o.namespace,password:o.password,node_id:typeof o.node_id==='string'?o.node_id:null};});
 } else return invalid();
 const now=new Date().toISOString();
 const rows=await Promise.all(inputs.map(async input=>{const row:MqttRow={id:crypto.randomUUID(),username:input.username,namespace:input.namespace,password_ciphertext:'',state:'pending_broker',node_id:input.node_id,created_at:now,verified_at:null,verification_error:null};row.password_ciphertext=await encryptMqttPassword(env,row,input.password);return row;}));
 await transact(rows.map(row=>env.DB.prepare('INSERT INTO mqtt_credentials(id,username,namespace,password_ciphertext,state,node_id,created_at) VALUES(?,?,?,?,?,?,?)').bind(row.id,row.username,row.namespace,row.password_ciphertext,row.state,row.node_id,row.created_at)),'mqtt.pool.create','pool',{count:rows.length,fields:auditFields},[sessionAssertion(session,true)]);
 return json({entries:rows.map(safeMqttRow),material:{
  authentication_csv:csv([['username','password'],...inputs.map(input=>[input.username,input.password])]),
  authorization_csv:csv([['username','topic','action','access'],...inputs.flatMap(input=>[
   [input.username,`cp/v1/${input.namespace}/+/req/+/+`,'pub','allow'],
   [input.username,`cp/v1/${input.namespace}/+/rep/+/+`,'sub','allow'],
   [input.username,'#','pubsub','deny'],
  ])]),
 },notice:'Private one-time broker import material. Import authentication and ACLs into the fixed production broker, then verify each entry. Generated material alone does not establish broker readiness.'},201);
}
