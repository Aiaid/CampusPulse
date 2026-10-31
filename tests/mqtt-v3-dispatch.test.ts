import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import worker,{MqttDeviceApi} from '../worker/index';
import {setup} from './helpers/ingestion';
import {seedMqtt} from './helpers/mqtt';
import {capabilityDigestV3} from '../worker/device-v3-config';
import {sha256} from '../worker/http';
import {v3Ack,v3Registration} from './helpers/device-v3-fixtures';
import {seedStatistics,statisticsBatch,statisticsFixture,STATISTICS_FLAGS} from './helpers/v3-statistics-fixtures';
import type {MqttDispatch,MqttV3Operation} from '../worker/mqtt-entrypoint';
let state:Awaited<ReturnType<typeof setup>>,api:MqttDeviceApi,identity:{username:string;namespace:string},f:Awaited<ReturnType<typeof statisticsFixture>>;
const bytes=(v:unknown)=>new TextEncoder().encode(typeof v==='string'?v:JSON.stringify(v));
const decode=(v:{status:number;body:Uint8Array})=>({status:v.status,body:JSON.parse(new TextDecoder().decode(v.body))});
const newer='22222222-2222-4222-8222-222222222222';
const dispatch=(subop:MqttV3Operation['subop'],body:unknown='',boot=f.caps.boot_id,receiptOnly=false)=>api.dispatch({...identity,boot,op:'ingest',rpc:1,body:bytes(body),v3:{subop,receiptOnly}});
beforeEach(async()=>{
 state=await setup();const [mapping]=await seedMqtt(state,1,state.config.node_id);identity={username:mapping.username,namespace:mapping.namespace};
 api=new MqttDeviceApi({} as ExecutionContext,{...state.env,...STATISTICS_FLAGS});f=await statisticsFixture(state.config.node_id,state.config.placement_id);
 f.caps.uplink!.transports=['mqtt_tls'];if(f.policy.uplink.enabled)f.policy.uplink.transport='mqtt_tls';f.policy.control.capability_sha256=await capabilityDigestV3(f.caps);
});
afterEach(()=>{vi.restoreAllMocks();state.db.close();});
it('keeps frozen MQTT statistics bytes, hashes, original boot and receipts across newer topic boots',async()=>{
 await seedStatistics(state.env.DB,f);const b=await statisticsBatch(f),body=` \n${JSON.stringify(b,null,2)}\n`;
 const first=decode(await dispatch(5,body,newer));expect(first).toMatchObject({status:200,body:{boot_id:f.caps.boot_id,body_sha256:await sha256(bytes(body)),durability:'committed'}});
 expect(decode(await dispatch(5,body,newer))).toEqual(first);expect(state.db.prepare('SELECT COUNT(*) n FROM statistics_windows_v3').get()?.n).toBe(1);
 expect((await dispatch(5,{...b,n:'different-owner'},newer)).status).toBe(403);
});
it('recovers an original HTTP policy over MQTT without relabeling authority or receipts',async()=>{
 f=await statisticsFixture(state.config.node_id,state.config.placement_id);await seedStatistics(state.env.DB,f);
 const b=await statisticsBatch(f);expect(decode(await dispatch(5,b,newer))).toMatchObject({status:200,body:{policy_id:f.policy.policy_id}});
});
it('binds nested capability ownership and live boot while retaining empty config semantics',async()=>{
 expect((await dispatch(1,v3Registration({...f.caps,node_id:'unrelated'}))).status).toBe(403);
 expect((await dispatch(1,v3Registration(f.caps),newer)).status).toBe(403);
 expect((await dispatch(1,v3Registration(f.caps))).status).toBe(200);
 expect(decode(await dispatch(2))).toMatchObject({status:200,body:{config:null,reason:'unassigned'}});
 expect((await dispatch(2,{})).status).toBe(400);expect((await dispatch(2,'',newer)).status).toBe(409);
});
it('permits receipt-only old ACK recovery but never manufactures capture authority',async()=>{
 await seedStatistics(state.env.DB,f,false);const original=await v3Ack(f.policy);
 expect((await dispatch(3,original)).status).toBe(200);
 expect((await dispatch(3,original,newer,false)).status).toBe(403);
 expect((await dispatch(3,original,newer,true)).status).toBe(200);
 const count=state.db.prepare('SELECT COUNT(*) n FROM device_statistics_lease_spans_v3').get()?.n;
 const missing={protocol:'campuspulse/3',boot_id:f.caps.boot_id,policy_id:f.policy.policy_id,policy_sha256:'a'.repeat(64),assignment_generation:2,contact_seq:1,uptime_ms:12000};
 expect(decode(await dispatch(4,missing,newer,true))).toMatchObject({status:409,body:{error:{code:'v3_receipt_not_committed'}}});
 expect(state.db.prepare('SELECT COUNT(*) n FROM device_statistics_lease_spans_v3').get()?.n).toBe(count);
});
it('rejects malformed private metadata and exact frame/body size violations',async()=>{
 const base={...identity,boot:f.caps.boot_id,op:'ingest',rpc:1,body:bytes('{}')};
 for(const v3 of [null,{subop:0,receiptOnly:false},{subop:6,receiptOnly:false},{subop:2,receiptOnly:true},{subop:5,receiptOnly:true},{subop:2,receiptOnly:false,extra:1}])
  expect((await api.dispatch({...base,v3} as MqttDispatch)).status).toBe(400);
 expect((await api.dispatch({...base,v3:{subop:1,receiptOnly:false},body:new Uint8Array(8193)} as MqttDispatch)).status).toBe(400);
 expect((await api.dispatch({...base,op:'config',v3:{subop:2,receiptOnly:false}} as unknown as MqttDispatch)).status).toBe(400);
});
it.each(["UPDATE mqtt_credentials SET state='pending_broker',verified_at=NULL","UPDATE mqtt_credentials SET state='ready',node_id=NULL","UPDATE mqtt_credentials SET namespace='changed'","UPDATE device_nodes SET enabled=0"])(
 'rechecks registry authorization inside the final statistics transaction: %s',async sql=>{
 await seedStatistics(state.env.DB,f);const batch=state.env.DB.batch.bind(state.env.DB);let fired=false;
 vi.spyOn(state.env.DB,'batch').mockImplementation(async writes=>{if(!fired){fired=true;state.db.exec(sql);}return batch(writes);});
 expect((await dispatch(5,await statisticsBatch(f))).status).toBe(401);
 expect(state.db.prepare('SELECT COUNT(*) n FROM statistics_batches_v3').get()?.n).toBe(0);
 expect(state.db.prepare('SELECT COUNT(*) n FROM admin_write_assertions').get()?.n).toBe(0);
});
it('rechecks registry at capability commit and denies revoked receipt retries',async()=>{
 const batch=state.env.DB.batch.bind(state.env.DB);vi.spyOn(state.env.DB,'batch').mockImplementation(async writes=>{state.db.exec("UPDATE mqtt_credentials SET state='pending_broker',verified_at=NULL");return batch(writes);});
 expect((await dispatch(1,v3Registration(f.caps))).status).toBe(401);expect(state.db.prepare('SELECT COUNT(*) n FROM device_control_v3').get()?.n).toBe(0);
 vi.restoreAllMocks();state.db.exec("UPDATE mqtt_credentials SET state='assigned',verified_at='2026-10-31T00:00:00.000Z'");await seedStatistics(state.env.DB,f);
 const b=await statisticsBatch(f);expect((await dispatch(5,b)).status).toBe(200);state.db.exec("UPDATE mqtt_credentials SET state='pending_broker',verified_at=NULL");expect((await dispatch(5,b)).status).toBe(403);
});
it.each(['ack','lease'])('rechecks registry at the final %s write without creating authority',async operation=>{
 await seedStatistics(state.env.DB,f,operation==='lease');const ack=await v3Ack(f.policy);
 const body=operation==='ack'?ack:{protocol:'campuspulse/3',boot_id:f.caps.boot_id,policy_id:f.policy.policy_id,policy_sha256:ack.policy_sha256,
  assignment_generation:1,contact_seq:1,uptime_ms:12000};
 const before=state.db.prepare('SELECT COUNT(*) n FROM device_acknowledgements_v3').get()?.n;
 const batch=state.env.DB.batch.bind(state.env.DB);vi.spyOn(state.env.DB,'batch').mockImplementation(async writes=>{
  state.db.exec("UPDATE mqtt_credentials SET namespace='changed'");return batch(writes);});
 expect((await dispatch(operation==='ack'?3:4,body)).status).toBe(401);
 expect(state.db.prepare('SELECT COUNT(*) n FROM device_acknowledgements_v3').get()?.n).toBe(before);
 expect(state.db.prepare('SELECT contact_seq FROM device_statistics_authorizations_v3').get()?.contact_seq??0).toBe(0);
});
it('never trusts public MQTT headers for either V3 route',async()=>{
 for(const [path,method]of [['/api/v3/device/config','GET'],['/api/v3/statistics/ingest','POST']]){
 const r=await worker.fetch(new Request('https://example.test'+path,{method,headers:{'X-Mqtt-Username':identity.username,'X-Mqtt-Namespace':identity.namespace,'X-Authenticated-Node':state.config.node_id}}),{...state.env,...STATISTICS_FLAGS});expect(r.status).toBe(401);}
});
