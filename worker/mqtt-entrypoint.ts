import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './types';
import { IngestError, parseIngestJson } from './strict-json';
import { json, sha256 } from './http';
import { MQTT_ID } from './mqtt-credentials';
import { handleAuthenticatedDeviceV3Control } from './device-v3-control';
import { handleAuthenticatedDeviceV3Statistics } from './device-v3-statistics';

export interface MqttIdentity { username:string; namespace:string }
export interface MqttV3Operation { subop:1|2|3|4|5; receiptOnly:boolean }
export interface MqttDispatch extends MqttIdentity { boot:string;op:'ingest';rpc:number|string;body:Uint8Array;v3:MqttV3Operation }
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const v3Paths={1:'/api/v3/device/capabilities',2:'/api/v3/device/config',3:'/api/v3/device/config/ack',4:'/api/v3/device/lease',5:'/api/v3/statistics/ingest'};
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
   if(!input||!UUID.test(input.boot)||input.op!=='ingest'||!(input.body instanceof Uint8Array)||input.body.length>8192||
     !/^[1-9][0-9]{0,9}$/.test(String(input.rpc))||Number(input.rpc)>0xffffffff)
    throw new IngestError(400,'invalid_mqtt_rpc','Invalid MQTT RPC envelope.');
   const identity=await this.authorize(input);
   if(!identity)throw new IngestError(403,'mqtt_identity_not_allowed','MQTT identity is not assigned to an enabled device.');
   const node=identity.node_id;
   {
    const v3=input.v3;
    if(!v3||typeof v3!=='object'||Object.keys(v3).length!==2||!Object.hasOwn(v3Paths,v3.subop)||
      !Number.isInteger(v3.subop)||typeof v3.receiptOnly!=='boolean'||input.op!=='ingest'||
      v3.receiptOnly&&v3.subop!==3&&v3.subop!==4)
     throw new IngestError(400,'invalid_mqtt_v3_rpc','Invalid MQTT V3 operation.');
    if(v3.subop===2) {
     if(input.body.length)throw new IngestError(400,'invalid_mqtt_v3_rpc','Configuration request must have an empty body.');
    } else {
     const payload=parseIngestJson(input.body) as Record<string,unknown>;
     if(!payload||typeof payload!=='object'||Array.isArray(payload))
      throw new IngestError(403,'mqtt_payload_not_allowed','MQTT V3 payload must belong to the bound principal.');
     const caps=payload.capabilities as Record<string,unknown>|undefined;
     if('node_id' in payload&&payload.node_id!==node||
       v3.subop===1&&(!caps||typeof caps!=='object'||Array.isArray(caps)||caps.node_id!==node||caps.boot_id!==input.boot)||
       (v3.subop===3||v3.subop===4)&&!v3.receiptOnly&&payload.boot_id!==input.boot||
       v3.subop===5&&payload.n!==node)
      throw new IngestError(403,'mqtt_payload_not_allowed','MQTT V3 payload does not belong to the bound device and current boot.');
    }
    // Header-free registry principal; this assertion is rechecked in final D1
    // transactions and committed-receipt reads by the internal module helpers.
    const authorization={sql:authSql,bindings:[input.username,input.namespace,node]};
    const request=new Request(`https://mqtt-device.internal${v3Paths[v3.subop]}${v3.subop===2?'?boot_id='+input.boot:''}`,{
     method:v3.subop===2?'GET':'POST',headers:{...(v3.subop===2?{}:{'Content-Type':'application/json','X-Body-SHA256':await sha256(input.body)}),
       ...(v3.receiptOnly?{'X-Receipt-Only':'1'}:{})},...(v3.subop===2?{}:{body:input.body.slice()}),
    });
    response=v3.subop===5?await handleAuthenticatedDeviceV3Statistics(request,this.env,node,authorization):
      await handleAuthenticatedDeviceV3Control(request,this.env,node,authorization);
    const body=new Uint8Array(await response.arrayBuffer()),limit=v3.subop===2?8192:2048;
    if(body.length>limit)return {status:503,body:new TextEncoder().encode(JSON.stringify({error:{code:'mqtt_response_too_large',retryable:true}}))};
    return {status:response.status,body};
   }
  } catch(error) {
   response=error instanceof IngestError?json({error:{code:error.code,message:error.message,retryable:error.status>=500}},error.status):
    json({error:{code:'storage_unavailable',message:'Service temporarily unavailable.',retryable:true}},503);
  }
  return {status:response.status,body:new Uint8Array(await response.arrayBuffer())};
 }
}
