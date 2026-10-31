import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {capabilityDigestV3} from '../worker/device-v3-config';
import {sha256} from '../worker/ingest';
import {seedStatistics,statisticsBatch,statisticsFixture,statisticsStatus,STATISTICS_FLAGS} from './helpers/v3-statistics-fixtures';
import {v3Ack,v3Registration} from './helpers/device-v3-fixtures';
let mf:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>;
const replies:Uint8Array[]=[],key='k'.repeat(43),newBoot='22222222-2222-4222-8222-222222222222';
const bytes=(v:unknown)=>new TextEncoder().encode(typeof v==='string'?v:JSON.stringify(v));
const frame=(op:number,body:unknown='',flags=0)=>Buffer.concat([Buffer.from([67,80,86,51,1,op,flags,0]),Buffer.from(bytes(body))]);
async function fixture(label:string,transport:'https'|'mqtt_tls'='mqtt_tls'){
 const f=await statisticsFixture('synthetic-mqtt-v3-'+label,'synthetic-mqtt-place-'+label);f.caps.uplink!.transports=[transport];
 if(f.policy.uplink.enabled)f.policy.uplink.transport=transport;f.policy.control.capability_sha256=await capabilityDigestV3(f.caps);
 await db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').bind(f.policy.node_id,await sha256(bytes('synthetic-http-bearer-'+label))).run();
 await db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,NULL,0)').bind(f.policy.custody.placement_id,f.policy.node_id).run();
 const identity={username:'mqtt-'+label,namespace:'scope-'+label};
 await db.prepare("INSERT INTO mqtt_credentials(id,username,namespace,password_ciphertext,state,node_id,created_at,verified_at) VALUES(?,?,?,'synthetic-encrypted','assigned',?,?,?)")
 .bind('mqtt-map-'+label,identity.username,identity.namespace,f.policy.node_id,new Date().toISOString(),new Date().toISOString()).run();
 let rpc=0;
 async function send(op:number,body:unknown='',boot=f.caps.boot_id,flags=0,wire?:Uint8Array){
  const before=replies.length;const result=await mf.dispatchFetch('https://synthetic.example.test/emqx',{method:'POST',headers:{'Content-Type':'application/json','X-CP-Webhook-Key':key},
   body:JSON.stringify({username:identity.username,qos:1,retain:false,published_at_ms:Date.now(),topic:`cp/v1/${identity.namespace}/${boot}/req/ingest/${++rpc}`,
    payload_b64:Buffer.from(wire??frame(op,body,flags)).toString('base64')})});
  const reply=replies.length>before?replies.at(-1)!:null;
  return {httpStatus:result.status,status:reply?new DataView(reply.buffer,reply.byteOffset,reply.byteLength).getUint16(0):null,
   body:reply?JSON.parse(new TextDecoder().decode(reply.subarray(2))):null,replyBytes:reply?.length??0};
 }
 return {f,identity,send};
}
beforeAll(async()=>{
 const [relay,api]=await Promise.all([
  build({entryPoints:['relay/emqx-cloud/worker.mjs'],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers','cloudflare:sockets','node:crypto'],
   plugins:[{name:'synthetic-publisher-only',setup(b){b.onResolve({filter:/^\.\/mqtt-publish\.mjs$/},()=>({path:resolve('relay/emqx-cloud/test/publisher-fixture.mjs')}));}}]}),
  build({entryPoints:['tests/helpers/mqtt-v3-api.ts'],bundle:true,write:false,format:'esm',platform:'neutral',external:['cloudflare:workers','node:*'],target:'es2022'}),
 ]);
 mf=new Miniflare(convertV4MiniflareOptions({workers:[{
  name:'mqtt-v3-relay',modules:true,script:relay.outputFiles[0].text,compatibilityDate:'2026-10-23',compatibilityFlags:['nodejs_compat'],
  bindings:{WEBHOOK_KEY:key,BROKER_HOST:'synthetic.example.invalid',MQTT_USERNAME:'synthetic-relay',MQTT_PASSWORD:'synthetic-password'},
  durableObjects:{RPC_GUARDS:{className:'EmqxRpc',useSQLite:true}},serviceBindings:{INGEST_SERVICE:{name:'mqtt-v3-api',entrypoint:'MqttDeviceApi'}},
  outboundService:async request=>{expect(new URL(request.url).hostname).toBe('synthetic-reply.invalid');replies.push(new Uint8Array(await request.arrayBuffer()));return new Response(null,{status:204});},
 },{name:'mqtt-v3-api',modules:true,script:api.outputFiles[0].text,compatibilityDate:'2026-10-23',compatibilityFlags:['nodejs_compat'],
  d1Databases:['DB'],bindings:STATISTICS_FLAGS}],log:new Log(LogLevel.ERROR)}));
 db=await mf.getD1Database('DB','mqtt-v3-api');for(const n of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>/^\d+.*\.sql$/.test(n)).sort())
 await db.exec(readFileSync(new URL('../migrations/'+n,import.meta.url),'utf8').replace(/^--.*$/gm,'').replace(/\n/g,' '));
},30000);
afterAll(async()=>{await mf?.dispose();});
describe.sequential('real CPV3 relay/DO/service-binding/D1 custody',()=>{
 it('binds caps/config/ACK/lease and recovers only committed old-boot control receipts',async()=>{
  const {f,send}=await fixture('control');const registration=bytes(` \n${JSON.stringify(v3Registration(f.caps),null,2)}\n`);
  expect(await send(1,'',f.caps.boot_id,0,frame(1,new TextDecoder().decode(registration)))).toMatchObject({httpStatus:204,status:200});
  expect(await db.prepare('SELECT registration_sha256 FROM device_control_v3 WHERE node_id=?').bind(f.policy.node_id).first())
   .toMatchObject({registration_sha256:await sha256(registration)});
  await seedStatistics(db as unknown as D1Database,f,false);
  const config=await send(2);expect(config).toMatchObject({httpStatus:204,status:200,body:{config:{policy:{uplink:{transport:'mqtt_tls'}}}}});
  expect(config.replyBytes).toBeGreaterThan(2050);expect(config.replyBytes).toBeLessThanOrEqual(8194);
  const ack=await v3Ack(f.policy),first=await send(3,ack);expect(first.status).toBe(200);
  expect((await send(3,ack,newBoot)).status).toBe(403);
  const retry=await send(3,ack,newBoot,1);expect(retry.body).toEqual(first.body);
  const lease={protocol:'campuspulse/3',boot_id:f.caps.boot_id,policy_id:f.policy.policy_id,policy_sha256:ack.policy_sha256,assignment_generation:1,contact_seq:1,uptime_ms:12000};
  const leaseReceipt=await send(4,lease);expect(leaseReceipt).toMatchObject({status:200,body:{schema:'device-lease/3',durability:'committed'}});
  expect((await send(4,lease,newBoot,1)).body).toEqual(leaseReceipt.body);
  expect(await send(4,{...lease,contact_seq:2},newBoot,1)).toMatchObject({status:409,body:{error:{code:'v3_receipt_not_committed'}}});
  expect(await db.prepare('SELECT span_count,contact_seq FROM device_statistics_authorizations_v3 WHERE node_id=?').bind(f.policy.node_id).first()).toMatchObject({span_count:1,contact_seq:1});
 });
 it('deduplicates original statistics and status bodies through the real relay and MQTT principal',async()=>{
  const {f,send}=await fixture('stats');await seedStatistics(db as unknown as D1Database,f);
  const b=await statisticsBatch(f),body=` \n${JSON.stringify(b,null,2)}\n`;
  const first=await send(5,body,newBoot);expect(first).toMatchObject({httpStatus:204,status:200,body:{body_sha256:await sha256(bytes(body)),boot_id:f.caps.boot_id,durability:'committed'}});
  expect((await send(5,body,newBoot)).body).toEqual(first.body);
  expect(await db.prepare('SELECT used_bytes FROM statistics_quota_v3 WHERE node_id=?').bind(f.policy.node_id).first()).toMatchObject({used_bytes:bytes(body).length});
  expect((await send(5,await statisticsStatus(f),newBoot)).status).toBe(200);
  expect(await db.prepare('SELECT COUNT(*) n FROM statistics_windows_v3 WHERE node_id=?').bind(f.policy.node_id).first()).toMatchObject({n:1});
  expect(await db.prepare('SELECT COUNT(*) n FROM statistics_status_v3 WHERE node_id=?').bind(f.policy.node_id).first()).toMatchObject({n:1});
  expect(await db.prepare('SELECT COUNT(*) n FROM public_sensor_projection_v2 WHERE node_id=?').bind(f.policy.node_id).first()).toMatchObject({n:0});
 });
 it('accepts original HTTP frozen statistics under original authority and denies changed owners',async()=>{
  const {f,send}=await fixture('http','https');await seedStatistics(db as unknown as D1Database,f);const b=await statisticsBatch(f);
  expect((await send(5,b,newBoot)).status).toBe(200);expect((await send(5,{...b,n:'other-node'},newBoot)).status).toBe(403);
  expect((await send(1,v3Registration({...f.caps,node_id:'other-node'}))).status).toBe(403);
 });
 it('revalidates registry on exact retries and does not expose a public-header authentication bypass',async()=>{
  const {f,send}=await fixture('revoke');await seedStatistics(db as unknown as D1Database,f);const b=await statisticsBatch(f);expect((await send(5,b)).status).toBe(200);
  await db.prepare("UPDATE mqtt_credentials SET state='pending_broker',verified_at=NULL WHERE node_id=?").bind(f.policy.node_id).run();
  // Relay admission itself re-authorizes and refuses forwarding/replaying.
  expect((await send(5,b)).httpStatus).toBe(403);
  const api=await mf.getWorker('mqtt-v3-api');const response=await api.fetch('https://synthetic.example.test/api/v3/device/config?boot_id='+f.caps.boot_id,{headers:{'X-Authenticated-Node':f.policy.node_id,'X-Mqtt-Username':'mqtt-revoke'}});
  expect(response.status).toBe(401);
 });
});
