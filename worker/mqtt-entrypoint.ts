import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './types';
import { IngestError, parseIngestJson } from './ingest-validation';
import { handleAuthenticatedDeviceV2 } from './device-v2';
import { json, MAX_INGEST_BYTES, sha256 } from './ingest';
import { MQTT_ID } from './mqtt-credentials';

export interface MqttIdentity { username:string; namespace:string }
export interface MqttDispatch extends MqttIdentity { boot:string;op:'contact'|'config'|'activation'|'ingest';rpc:number|string;body:Uint8Array }
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const paths={contact:'/api/v2/device/contact',config:'/api/v2/device/config',activation:'/api/v2/device/config/ack',ingest:'/api/v2/ingest'};
const authSql="EXISTS(SELECT 1 FROM mqtt_credentials m JOIN device_nodes n ON n.id=m.node_id WHERE m.username=? AND m.namespace=? AND m.node_id=? AND m.state='assigned' AND m.verified_at IS NOT NULL AND n.enabled=1)";
/** Service-binding RPC only. No public HTTP header can select this identity. */
export class MqttDeviceApi extends WorkerEntrypoint<Env> {
 async authorize(identity:MqttIdentity):Promise<{node_id:string}|null> {
  if(!identity||typeof identity.username!=='string'||!MQTT_ID.test(identity.username)||typeof identity.namespace!=='string'||!MQTT_ID.test(identity.namespace))return null;
  return this.env.DB.prepare("SELECT m.node_id FROM mqtt_credentials m JOIN device_nodes n ON n.id=m.node_id WHERE m.username=? AND m.namespace=? AND m.state='assigned' AND m.verified_at IS NOT NULL AND n.enabled=1")
   .bind(identity.username,identity.namespace).first<{node_id:string}>();
 }
 async dispatch(input:MqttDispatch):Promise<{status:number;body:Uint8Array}> {
  let response:Response;
  try {
   if(!input||!UUID.test(input.boot)||!Object.hasOwn(paths,input.op)||!(input.body instanceof Uint8Array)||input.body.length>MAX_INGEST_BYTES||
     !/^[1-9][0-9]{0,9}$/.test(String(input.rpc))||Number(input.rpc)>0xffffffff)
    throw new IngestError(400,'invalid_mqtt_rpc','Invalid MQTT RPC envelope.');
   const identity=await this.authorize(input);
   if(!identity)throw new IngestError(403,'mqtt_identity_not_allowed','MQTT identity is not assigned to an enabled device.');
   const node=identity.node_id;
   if(input.op==='config') {
    if(input.body.length)throw new IngestError(400,'invalid_mqtt_rpc','Configuration request must have an empty body.');
   } else {
    const payload=parseIngestJson(input.body) as Record<string,unknown>;
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||input.op!=='ingest'&&payload.boot_id!==input.boot||
      'node_id' in payload&&payload.node_id!==node)
     throw new IngestError(403,'mqtt_payload_not_allowed','MQTT request does not belong to the bound device and current boot.');
    // Ingestion preserves the frozen body boot even when the MQTT connection
    // runs on a newer boot. The normal v2 validator still enforces node ownership.
   }
   const request=new Request(`https://mqtt-device.internal${paths[input.op]}`,{
    method:input.op==='config'?'GET':'POST',headers:input.op==='config'?{}:{'Content-Type':'application/json','X-Body-SHA256':await sha256(input.body)},
    ...(input.op==='config'?{}:{body:input.body.slice()}),
   });
   response=await handleAuthenticatedDeviceV2(request,this.env,node,{sql:authSql,bindings:[input.username,input.namespace,node]});
  } catch(error) {
   response=error instanceof IngestError?json({error:{code:error.code,message:error.message,retryable:error.status>=500}},error.status):
    json({error:{code:'storage_unavailable',message:'Service temporarily unavailable.',retryable:true}},503);
  }
  return {status:response.status,body:new Uint8Array(await response.arrayBuffer())};
 }
}
