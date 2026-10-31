import type { Env } from './types';
import { base64url, decode64, type AuthAssertion } from './admin-auth';
import { IngestError } from './strict-json';

export const MQTT_BROKER_HOST = 'q9a692f8.ala.cn-hangzhou.emqxsl.cn';
export const MQTT_BROKER_URI = `mqtts://${MQTT_BROKER_HOST}:8883`;
export const MQTT_ID = /^[a-z0-9_-]{1,15}$/;
export interface MqttCredentials { uri: string; username: string; password: string; namespace: string }
export interface MqttRow {
 id:string;username:string;namespace:string;password_ciphertext:string;
 state:'pending_broker'|'ready'|'assigned';node_id:string|null;created_at:string;verified_at:string|null;verification_error:string|null;
}
const encoder = new TextEncoder();
async function key(env: Env) {
 if (!env.MQTT_PROVISIONING_KEY || !/^[A-Za-z0-9_-]{43}$/.test(env.MQTT_PROVISIONING_KEY))
  throw new IngestError(503,'mqtt_provisioning_not_configured','MQTT provisioning encryption is not configured.');
 const bytes=decode64(env.MQTT_PROVISIONING_KEY);
 if(bytes.length!==32) throw new IngestError(503,'mqtt_provisioning_not_configured','MQTT provisioning encryption is not configured.');
 return crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']);
}
const aad = (row: Pick<MqttRow,'id'|'username'|'namespace'>) => encoder.encode(`campuspulse/mqtt/1\n${row.id}\n${row.username}\n${row.namespace}\n${MQTT_BROKER_URI}`);
export async function encryptMqttPassword(env:Env,row:Pick<MqttRow,'id'|'username'|'namespace'>,password:string) {
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(row)},await key(env),encoder.encode(password));
 return `v1.${base64url(iv)}.${base64url(new Uint8Array(ciphertext))}`;
}
export async function decryptMqtt(env:Env,row:MqttRow):Promise<MqttCredentials> {
 const encryptionKey=await key(env);
 try {
  const parts=row.password_ciphertext.split('.');
  if(parts.length!==3||parts[0]!=='v1') throw new Error();
  const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode64(parts[1]),additionalData:aad(row)},encryptionKey,decode64(parts[2]));
  const password=new TextDecoder('utf-8',{fatal:true}).decode(clear);
  if(!/^[!-~]{16,96}$/.test(password)) throw new Error();
  return {uri:MQTT_BROKER_URI,username:row.username,password,namespace:row.namespace};
 } catch { throw new IngestError(503,'mqtt_credential_unavailable','MQTT credentials could not be recovered.'); }
}
export function safeMqttRow({password_ciphertext: _secret,...row}:MqttRow) { return row; }
export async function readyMqtt(env:Env):Promise<MqttRow> {
 const row=await env.DB.prepare("SELECT * FROM mqtt_credentials WHERE state='ready' AND node_id IS NULL AND verified_at IS NOT NULL ORDER BY created_at,id LIMIT 1").first<MqttRow>();
 if(!row) throw new IngestError(503,'mqtt_pool_empty','No broker-verified MQTT identity is ready. Prepare and verify the MQTT pool before registering a device.');
 return row;
}
export const mqttReadyAssertion=(row:MqttRow):AuthAssertion=>({sql:"EXISTS(SELECT 1 FROM mqtt_credentials WHERE id=? AND state='ready' AND node_id IS NULL AND verified_at IS NOT NULL)",bindings:[row.id]});
export function assignMqtt(env:Env,row:MqttRow,node:string) {
 return env.DB.prepare("UPDATE mqtt_credentials SET state='assigned',node_id=? WHERE id=? AND state='ready' AND node_id IS NULL AND verified_at IS NOT NULL").bind(node,row.id);
}
export async function mqttForNode(env:Env,node:string):Promise<MqttRow|null> {
 return env.DB.prepare("SELECT * FROM mqtt_credentials WHERE node_id=? AND state='assigned' AND verified_at IS NOT NULL").bind(node).first<MqttRow>();
}
