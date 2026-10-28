import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { authState,Client,json } from './admin-auth-helpers';
import { MQTT_TEST_KEY,seedMqtt } from './helpers/mqtt';
import { decryptMqtt,encryptMqttPassword,MQTT_BROKER_URI,type MqttRow } from '../worker/mqtt-credentials';
import { MqttProbeError,verifyMqttBroker } from '../worker/mqtt-probe';
vi.mock('../worker/mqtt-probe',()=>({MqttProbeError:class extends Error {constructor(public code:string){super(code);}},verifyMqttBroker:vi.fn()}));
let state:Awaited<ReturnType<typeof authState>>,client:Client;
beforeEach(async()=>{state=await authState();state.env.MQTT_PROVISIONING_KEY=MQTT_TEST_KEY;client=new Client(state);await client.initialize();vi.mocked(verifyMqttBroker).mockResolvedValue();});
afterEach(()=>{vi.restoreAllMocks();state.db.close();});
const registration=(id:string)=>client.call('/devices','POST',{id,name:id,board:'synthetic'});
it('generates independent encrypted identities with one-time Cloud-console material and no ready allocation',async()=>{
 const generated=await json(await client.call('/mqtt/pool','POST',{count:2}),201);
 expect(generated.entries).toHaveLength(2);expect(new Set(generated.entries.map((e:MqttRow)=>e.username)).size).toBe(2);
 expect(generated.material.authentication_csv).toMatch(/^"username","password"\r\n/);
 expect(generated.material.authorization_csv).toMatch(/^"username","topic","action","access"\r\n/);
 const aclLines=generated.material.authorization_csv.trim().split('\r\n').slice(1);
 expect(aclLines).toHaveLength(6);
 expect(aclLines.every((line:string)=>/^"[a-z0-9_-]+","[^"]+","(?:pub|sub|pubsub)","(?:allow|deny)"$/.test(line))).toBe(true);
 const aclRows=aclLines.map((line:string)=>JSON.parse(`[${line}]`) as string[]);
 expect(new Set(aclRows.map((row:string[])=>`${row[0]}\n${row[1]}`)).size).toBe(aclRows.length);
 expect(aclRows.filter((row:string[])=>row[1]==='#').every((row:string[])=>row[2]==='pubsub'&&row[3]==='deny')).toBe(true);
 expect(generated.material.authorization_csv).not.toContain('"publish"');
 expect(generated.material.authorization_csv).not.toContain('"subscribe"');
 for(const e of generated.entries){expect(e.username).toMatch(/^[a-z0-9_-]{1,15}$/);expect(e.namespace).toBe(e.username);expect(e.state).toBe('pending_broker');expect(e.password_ciphertext).toBeUndefined();}
 const saved=state.db.prepare('SELECT * FROM mqtt_credentials ORDER BY id').all() as unknown as MqttRow[];
 const mqtt=await decryptMqtt(state.env,saved[0]);expect(mqtt.password).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(generated.material.authentication_csv).toContain(mqtt.password);
 expect(JSON.stringify(saved)).not.toContain(mqtt.password);
 const listing=await json(await client.call('/mqtt/pool'));expect(listing.ready_count).toBe(0);expect(JSON.stringify(listing)).not.toContain(mqtt.password);expect(JSON.stringify(await json(await client.call('/audit')))).not.toContain(mqtt.password);
 await json(await registration('no-broker-yet'),503);expect(state.db.prepare("SELECT 1 FROM device_nodes WHERE id='no-broker-yet'").get()).toBeUndefined();
 expect((await client.call('/mqtt/pool','POST',{count:33})).status).toBe(422);
});
it('binds AES-GCM ciphertext to its exact identity and fails closed on missing or replaced keys',async()=>{
 const [row]=await seedMqtt(state);const mqtt=await decryptMqtt(state.env,row);
 await expect(decryptMqtt(state.env,{...row,namespace:'another'})).rejects.toMatchObject({code:'mqtt_credential_unavailable'});
 const encrypted=await encryptMqttPassword(state.env,row,mqtt.password);expect(encrypted).not.toBe(row.password_ciphertext);
 state.env.MQTT_PROVISIONING_KEY='AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE';
 await expect(decryptMqtt(state.env,row)).rejects.toMatchObject({code:'mqtt_credential_unavailable'});
 delete state.env.MQTT_PROVISIONING_KEY;await json(await registration('no-key'),503);expect(state.db.prepare("SELECT 1 FROM device_nodes WHERE id='no-key'").get()).toBeUndefined();
});
it('requires real verification before atomic enrollment and preserves assignment through reauthenticated recovery',async()=>{
 const generated=await json(await client.call('/mqtt/pool','POST',{count:1}),201),entry=generated.entries[0];
 await json(await client.call(`/mqtt/pool/${entry.id}/verify`,'POST',{}));expect(verifyMqttBroker).toHaveBeenCalledOnce();
 expect((await json(await client.call('/mqtt/pool'))).ready_count).toBe(1);
 const created=await json(await registration('registered'),201);expect(created.mqtt).toMatchObject({uri:MQTT_BROKER_URI,username:entry.username,namespace:entry.namespace});
 expect(created.credential).toMatch(/^cpd_/);expect((await json(await client.call('/mqtt/pool'))).ready_count).toBe(0);
 const recovered=await json(await client.call('/devices/registered/mqtt','POST',{}));expect(recovered.mqtt).toEqual(created.mqtt);
 const listing=JSON.stringify(await json(await client.call('/devices/registered')));expect(listing).not.toContain(created.mqtt.password);expect(listing).not.toContain(created.credential);
 await json(await client.call('/devices/registered','PATCH',{enabled:false}));await json(await client.call('/devices/registered/mqtt','POST',{}),409);
 await json(await client.call('/devices/registered','PATCH',{enabled:true}));
 state.db.prepare('UPDATE admin_sessions SET reauthenticated_at_ms=?').run(Date.now()-6*60000);
 expect((await client.call('/devices/registered/mqtt','POST',{})).status).toBe(403);expect((await client.call('/mqtt/pool','POST',{count:1})).status).toBe(403);
});
it('keeps failed broker probes unavailable and allows explicit imported legacy adoption only after verification',async()=>{
 const password='synthetic-imported-broker-password';
 const imported=await json(await client.call('/mqtt/pool','POST',{entries:[{username:'cp-device-test',namespace:'cp-demo-01',password,node_id:'cp-demo-01'}]}),201);
 const entry=imported.entries[0];expect((await client.call('/devices/cp-demo-01/mqtt','POST',{})).status).toBe(409);
 vi.mocked(verifyMqttBroker).mockRejectedValueOnce(new MqttProbeError('mqtt_probe_acl_not_isolated'));
 expect((await client.call(`/mqtt/pool/${entry.id}/verify`,'POST',{})).status).toBe(502);
 expect((await json(await client.call('/mqtt/pool'))).entries[0]).toMatchObject({state:'pending_broker',verification_error:'mqtt_probe_acl_not_isolated',verified_at:null});
 await json(await client.call(`/mqtt/pool/${entry.id}/verify`,'POST',{}));
 const recovered=await json(await client.call('/devices/cp-demo-01/mqtt','POST',{}));expect(recovered.mqtt).toMatchObject({username:'cp-device-test',password,namespace:'cp-demo-01'});
 vi.mocked(verifyMqttBroker).mockRejectedValueOnce(new MqttProbeError('mqtt_probe_login_rejected'));
 expect((await client.call(`/mqtt/pool/${entry.id}/verify`,'POST',{})).status).toBe(502);
 expect(state.db.prepare('SELECT state,node_id,verified_at FROM mqtt_credentials WHERE id=?').get(entry.id)).toMatchObject({state:'pending_broker',node_id:'cp-demo-01',verified_at:null});
 expect((await client.call('/devices/cp-demo-01/mqtt','POST',{})).status).toBe(409);
});
it('allocates one ready identity to only one concurrent registration without orphan devices or audits',async()=>{
 await seedMqtt(state);
 const replies=await Promise.all([registration('racer-a'),registration('racer-b')]);expect(replies.map(r=>r.status).sort()).toEqual([201,503]);
 expect(state.db.prepare("SELECT COUNT(*) n FROM device_nodes WHERE id IN ('racer-a','racer-b')").get()?.n).toBe(1);
 expect(state.db.prepare("SELECT COUNT(*) n FROM mqtt_credentials WHERE state='assigned'").get()?.n).toBe(1);
 expect(state.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='device.register'").get()?.n).toBe(1);
 expect(state.db.prepare('SELECT COUNT(*) n FROM admin_write_assertions').get()?.n).toBe(0);
});
it('rolls back pool assignment and node creation when the audit cannot commit',async()=>{
 await seedMqtt(state);state.db.exec("CREATE TRIGGER fail_mqtt_audit BEFORE INSERT ON admin_audit WHEN NEW.action='device.register' BEGIN SELECT RAISE(ABORT,'synthetic unavailable'); END;");
 expect((await registration('no-orphan')).status).toBe(503);
 expect(state.db.prepare("SELECT 1 FROM device_nodes WHERE id='no-orphan'").get()).toBeUndefined();expect(state.db.prepare("SELECT state,node_id FROM mqtt_credentials").get()).toMatchObject({state:'ready',node_id:null});
});
it('rejects untrusted origin, unauthenticated and stale pool mutations before changing state',async()=>{
 const stranger=new Client(state);expect((await stranger.call('/mqtt/pool')).status).toBe(401);
 expect((await client.call('/mqtt/pool','POST',{count:1},{Origin:'https://evil.invalid'})).status).toBe(403);
 state.db.prepare('UPDATE admin_sessions SET reauthenticated_at_ms=?').run(Date.now()-6*60000);expect((await client.call('/mqtt/pool','POST',{count:1})).status).toBe(403);
 expect(state.db.prepare('SELECT COUNT(*) n FROM mqtt_credentials').get()?.n).toBe(0);
});
