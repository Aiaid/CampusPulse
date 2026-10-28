import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import worker,{ MqttDeviceApi } from '../worker/index';
import { fixture,setup } from './helpers/ingestion';
import { seedMqtt } from './helpers/mqtt';
import { sha256 } from '../worker/ingest';
import type { CaptureConfigV2 } from '../worker/device-v2-validation';
import type { MqttDispatch } from '../worker/mqtt-entrypoint';
let state:Awaited<ReturnType<typeof setup>>,api:MqttDeviceApi,identity:{username:string;namespace:string},config:CaptureConfigV2;
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
const decode=(reply:{status:number;body:Uint8Array})=>({status:reply.status,body:JSON.parse(new TextDecoder().decode(reply.body))});
const rpc=(op:MqttDispatch['op'],body:Uint8Array=new Uint8Array(),boot='11111111-1111-4111-8111-111111111111')=>api.dispatch({...identity,boot,op,rpc:1,body});
beforeEach(async()=>{
 state=await setup();const [pool]=await seedMqtt(state,1,state.config.node_id);identity={username:pool.username,namespace:pool.namespace};api=new MqttDeviceApi({} as ExecutionContext,state.env);
 config=fixture('capture-config-v2.fixture');config.accept_until=new Date(Date.now()+86400000).toISOString();
 state.db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)').run(config.capture_config_id,config.node_id,config.placement_id,config.dataset,JSON.stringify(config),Date.parse(config.accept_until));
 state.db.prepare('INSERT INTO config_assignments(node_id,capture_config_id,assigned_at) VALUES(?,?,?)').run(config.node_id,config.capture_config_id,new Date().toISOString());
 state.db.prepare('INSERT INTO device_desired_configs(node_id,capture_config_id,assigned_at) VALUES(?,?,?)').run(config.node_id,config.capture_config_id,new Date().toISOString());
});
afterEach(()=>{vi.restoreAllMocks();state.db.close();});
it('resolves independent namespace to actual node, retrieves full v2 policy and leaves public bearer authentication strict',async()=>{
 expect(await api.authorize(identity)).toEqual({node_id:config.node_id});expect(identity.namespace).not.toBe(config.node_id);
 expect(decode(await rpc('config'))).toMatchObject({status:200,body:{config,control:config.control}});
 const publicReply=await worker.fetch(new Request('https://device.test/api/v2/device/config',{headers:{'X-Mqtt-Username':identity.username,'X-Mqtt-Namespace':identity.namespace,'X-Authenticated-Node':config.node_id}}),state.env);
 expect(publicReply.status).toBe(401);
 for(const change of [{username:'other'},{namespace:'other'}])expect(await api.authorize({...identity,...change})).toBeNull();
 state.db.prepare('UPDATE device_nodes SET enabled=0 WHERE id=?').run(config.node_id);expect(await api.authorize(identity)).toBeNull();expect((await rpc('config')).status).toBe(403);
});
it('reuses v2 exact control ordering and binds contact/activation to the current MQTT boot',async()=>{
 const contact=fixture('device-contact-v2.request'),activation=fixture('device-activation-v2.request');
 expect((await rpc('contact',bytes(contact),'26000000-0000-4000-8000-000000000002')).status).toBe(403);
 const first=decode(await rpc('contact',bytes(contact)));expect(first.status).toBe(200);expect(decode(await rpc('contact',bytes(contact)))).toEqual(first);
 expect((await rpc('activation',bytes(activation))).status).toBe(200);
 expect((await rpc('contact',bytes({...contact,wifi_state:'changed'}))).status).toBe(409);
 expect(state.db.prepare('SELECT applied_config_id,boot_id FROM device_control_v2').get()).toMatchObject({applied_config_id:config.capture_config_id,boot_id:contact.boot_id});
});
it('preserves exact frozen ingest bytes, original body boot and receipt when MQTT uses a newer boot',async()=>{
 const batch=fixture('address-summaries-v2.request');const body=new TextEncoder().encode(` \n${JSON.stringify(batch,null,2)}\n`),newBoot='26000000-0000-4000-8000-000000000002';
 const first=decode(await rpc('ingest',body,newBoot));expect(first).toMatchObject({status:200,body:{node_id:config.node_id,boot_id:batch.boot_id,body_sha256:await sha256(body),durability:'committed'}});
 expect(decode(await rpc('ingest',body,newBoot))).toEqual(first);
 expect((await rpc('ingest',bytes({...batch,node_id:'unrelated'}),newBoot)).status).toBe(403);
 expect(state.db.prepare('SELECT COUNT(*) n FROM ingestion_batches_v2').get()?.n).toBe(1);
});
it('rejects pending, unverified, disabled and changed mappings on every dispatch without retaining upload tokens',async()=>{
 for(const sql of ["UPDATE mqtt_credentials SET state='pending_broker',verified_at=NULL","UPDATE device_nodes SET enabled=0","UPDATE mqtt_credentials SET namespace='changed'"]){
  state.db.exec(sql);expect((await rpc('config')).status).toBe(403);
  state.db.prepare("UPDATE mqtt_credentials SET state='assigned',verified_at=?,namespace=?").run(new Date().toISOString(),identity.namespace);state.db.exec('UPDATE device_nodes SET enabled=1');
 }
 const columns=state.db.prepare('PRAGMA table_info(mqtt_credentials)').all().map(r=>r.name);expect(columns.some(c=>String(c).includes('token'))).toBe(false);
});
it('reasserts device authorization in the ingestion transaction after slow raw archival',async()=>{
 config={...config,capture_config_id:'mqtt-raw-v2',raw_capture:{mode:'sampled',sample_every_n:1,selection:'seq_mod_n_eq_0',max_reports_per_window:4},allowed_streams:[...config.allowed_streams,'ble_reports']};
 state.db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)').run(config.capture_config_id,config.node_id,config.placement_id,config.dataset,JSON.stringify(config),Date.parse(config.accept_until));
 state.db.prepare('INSERT INTO config_assignments(node_id,capture_config_id,assigned_at) VALUES(?,?,?)').run(config.node_id,config.capture_config_id,new Date().toISOString());
 const batch=fixture('ble-reports.request');batch.protocol='campuspulse/2';batch.capture_config_id=config.capture_config_id;batch.items=batch.items.slice(0,1);const bucket=state.env.RAW_BUCKET!;
 state.env.RAW_BUCKET={...bucket,put:async(...args:Parameters<R2Bucket['put']>)=>{const result=await bucket.put(...args);state.db.exec('UPDATE device_nodes SET enabled=0');return result;}} as R2Bucket;
 const reply=decode(await rpc('ingest',bytes(batch)));expect(reply.status).toBe(503);
 expect(state.db.prepare('SELECT COUNT(*) n FROM ingestion_batches_v2').get()?.n).toBe(0);expect(state.db.prepare('SELECT COUNT(*) n FROM admin_write_assertions').get()?.n).toBe(0);
});
it('rejects invalid RPC envelopes and config bodies before storage changes',async()=>{
 expect((await rpc('config',bytes({}))).status).toBe(400);
 for(const patch of [{boot:'invalid'},{rpc:0},{rpc:'01'},{rpc:4294967296},{op:'unknown'},{body:new Uint8Array(65537)}])expect((await api.dispatch({...identity,boot:'26000000-0000-4000-8000-000000000001',op:'config',rpc:1,body:new Uint8Array(),...patch} as MqttDispatch)).status).toBe(400);
 expect(state.db.prepare('SELECT COUNT(*) n FROM device_control_v2').get()?.n).toBe(0);
});
