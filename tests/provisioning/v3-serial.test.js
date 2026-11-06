import {readFileSync} from 'node:fs';
import {describe,expect,it,vi} from 'vitest';
import {buildV3Start,fetchV3ClockKey,openV3Serial,validateV3ClockKey,validateV3Hello,V3_ORIGIN} from '../../src/admin/provisioning/v3-serial.js';
import {MQTT_BROKER_URI,mqttSettings} from '../../src/admin/provisioning/mqtt.js';
const node='cp_001122aabbcc',boot='11111111-1111-4111-8111-111111111111',nonce='a'.repeat(32);
const identity={node_id:node,boot_id:boot,request_id:nonce,mono_ms:1234};
const input={identity,nonce,expectedNode:node,token:'synthetic_device_token_32_characters',mqtt:{uri:MQTT_BROKER_URI,username:'synthetic_user',password:'synthetic_private_broker_key',namespace:'synthetic_ns'},ssid:'Synthetic WiFi',password:'synthetic_wifi_password',windows:1,sentWall:1800000000000,sentMono:100,receivedWall:1800000000020,receivedMono:120};
const caPem=readFileSync(new URL('../../firmware/certs/digicert-global-root-g2.crt',import.meta.url),'utf8');
const peap={security:'enterprise_peap',password:'',eapUsername:'synthetic_username',eapIdentity:'synthetic_outer_identity',eapPassword:'synthetic_eap_password',eapCaPem:caPem,eapDomain:'radius.example.test'};
const spki=Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5','hex');
const clockKey={schema:'cp-v3-signed-clock-key/1',audience:V3_ORIGIN,key_id:'synthetic-key-1',public_key_spki:spki.toString('base64url')};
function portFixture(onWrite){let controller;const writes=[];return{writes,readable:new ReadableStream({start(c){controller=c;}}),writable:new WritableStream({write(bytes){const line=new TextDecoder().decode(bytes);writes.push(line);onWrite(line,text=>controller.enqueue(new TextEncoder().encode(text)));}}),async open(){},async setSignals(){},async close(){}};}
describe('native V3 USB bootstrap',()=>{
 it('matches native V3START and conservative MQTT/raw-off onboarding without legacy fields',()=>{const frame=buildV3Start(input);expect(frame.startsWith('V3START ')).toBe(true);const body=JSON.parse(frame.slice(8));expect(body).toMatchObject({node_id:node,boot_id:boot,security:'personal',uplink_transport:'mqtt_tls',max_windows:1,utc_ms:1800000000010,uncertainty_ms:261,anchor_mono_ms:1234});expect(body).not.toHaveProperty('capture_config');expect(body).not.toHaveProperty('reuse_saved_credential');});
 it('allows explicit or inferred unverified PEAP without trust fields, never downgrades supplied CA',()=>{
  const {eapCaPem,eapDomain,...unverified}=peap;
  for(const eapServerVerification of [undefined,'none']){const body=JSON.parse(buildV3Start({...input,...unverified,eapServerVerification}).slice(8));expect(body.eap_server_verification).toBe('none');expect(body).not.toHaveProperty('eap_ca_pem');expect(body).not.toHaveProperty('eap_domain');}
  expect(JSON.parse(buildV3Start({...input,...peap}).slice(8)).eap_server_verification).toBe('ca');
  for(const extra of [{eapServerVerification:'none'},{eapCaPem:'invalid'},{eapServerVerification:'invalid'},{eapServerVerification:null}])expect(()=>buildV3Start({...input,...peap,...extra})).toThrow();
  for(const security of ['open','personal'])expect(()=>buildV3Start({...input,security,password:security==='open'?'':input.password,eapServerVerification:'none'})).toThrow();
 });
 it('accepts only bounded optional readiness states without requiring new fields from old firmware',()=>{
  expect(validateV3Hello(identity,nonce,node)).toEqual(identity);
  for(const state of ['ready','missing','unavailable'])expect(validateV3Hello({...identity,credential_state:state,mqtt_state:state},nonce,node).credential_state).toBe(state);
  for(const state of [null,true,'unknown','corrupt',1])for(const key of ['credential_state','mqtt_state'])expect(()=>validateV3Hello({...identity,[key]:state},nonce,node)).toThrow();
 });
 it('normalizes only absent or exactly empty PEAP trust inputs before emitting explicit none',()=>{
  for(const eapServerVerification of [undefined,'none'])for(const eapCaPem of [undefined,''])for(const eapDomain of [undefined,'']){
   const body=JSON.parse(buildV3Start({...input,...peap,eapServerVerification,eapCaPem,eapDomain}).slice(8));
   expect(body.eap_server_verification).toBe('none');expect(body).not.toHaveProperty('eap_ca_pem');expect(body).not.toHaveProperty('eap_domain');
  }
 });
 it('never treats malformed or nonempty PEAP trust as absent, including explicit none',()=>{
  for(const eapServerVerification of [undefined,'none'])for(const value of [null,' ','\n','invalid PEM',42,false,{}])for(const field of ['eapCaPem','eapDomain'])expect(()=>buildV3Start({...input,...peap,eapCaPem:'',eapDomain:'',eapServerVerification,[field]:value})).toThrow();
  expect(()=>buildV3Start({...input,...peap,eapServerVerification:'ca',eapCaPem:'',eapDomain:''})).toThrow();
 });
 it('reuses local credentials without exporting secret fields and rejects mixed, unavailable or unbound reuse',()=>{
  const saved={...input,identity:{...identity,credential_state:'ready',mqtt_state:'ready'},bootId:boot,token:undefined,mqtt:undefined,reuseSavedCredential:true,reuseSavedMqtt:true};
  const body=JSON.parse(buildV3Start(saved).slice(8));expect(body).toMatchObject({reuse_saved_credential:true,reuse_saved_mqtt:true});
  for(const key of ['device_token','mqtt_uri','mqtt_username','mqtt_password','mqtt_namespace'])expect(body).not.toHaveProperty(key);
  for(const extra of [{token:input.token},{mqtt:input.mqtt},{expectedNode:undefined},{bootId:undefined},{bootId:'22222222-2222-4222-8222-222222222222'},{reuseSavedCredential:1}])expect(()=>buildV3Start({...saved,...extra})).toThrow();
  for(const state of [undefined,'missing','unavailable'])for(const key of ['credential_state','mqtt_state'])expect(()=>buildV3Start({...saved,identity:{...saved.identity,[key]:state}})).toThrow();
  const mixed=JSON.parse(buildV3Start({...saved,reuseSavedMqtt:false,mqtt:input.mqtt}).slice(8));expect(mixed.reuse_saved_credential).toBe(true);expect(mixed.mqtt_password).toBe(input.mqtt.password);expect(mixed).not.toHaveProperty('device_token');
 });
 it('requires readiness to remain ready in fresh same-boot HELLO before reuse START',async()=>{
  for(const state of [undefined,'missing','unavailable']){const port=portFixture((line,emit)=>{if(line.startsWith('HELLO '))emit('V3 HELLO '+JSON.stringify({...identity,credential_state:state,mqtt_state:'ready',request_id:line.trim().slice(6)})+'\n');});const client=await openV3Serial(port);await expect(client.start({...input,bootId:boot,token:undefined,mqtt:undefined,reuseSavedCredential:true,reuseSavedMqtt:true})).rejects.toThrow();expect(port.writes.some(line=>line.startsWith('V3START '))).toBe(false);await client.close();}
 });
 it('rejects changed node/boot nonce, restart state, clock jump and unsupported broker',()=>{expect(()=>validateV3Hello({...identity,node_id:'cp_ffeeddccbbaa'},nonce,node)).toThrow();expect(()=>validateV3Hello(identity,'b'.repeat(32),node)).toThrow();expect(()=>validateV3Hello({...identity,restart_required:true},nonce,node)).toThrow();expect(()=>buildV3Start({...input,receivedMono:2201})).toThrow();expect(()=>buildV3Start({...input,receivedWall:1800000000100})).toThrow();expect(()=>mqttSettings({...input.mqtt,uri:'mqtts://other.invalid'})).toThrow();});
 it('does not downgrade absent personal passwords or enable unbounded manual runs',()=>{for(const password of ['', 'short','z'.repeat(64)])expect(()=>buildV3Start({...input,password})).toThrow();expect(()=>buildV3Start({...input,windows:0})).toThrow();expect(()=>buildV3Start({...input,ssid:'中'.repeat(11)})).toThrow();});
 it('writes exactly the selected authentication mode and keeps open passwords empty',()=>{
  const open=JSON.parse(buildV3Start({...input,security:'open',password:''}).slice(8));expect(open).toMatchObject({security:'open',password:''});expect(Object.keys(open).some(key=>key.startsWith('eap_'))).toBe(false);
  for(const windows of [1,2,3]){const body=JSON.parse(buildV3Start({...input,...peap,windows}).slice(8));expect(body).toMatchObject({security:'enterprise_peap',password:'',eap_username:peap.eapUsername,eap_identity:peap.eapIdentity,eap_password:peap.eapPassword,eap_ca_pem:caPem,eap_domain:peap.eapDomain,max_windows:windows});expect(body).not.toHaveProperty('save_startup');}
  expect(JSON.parse(buildV3Start({...input,security:'personal',password:'a'.repeat(64)}).slice(8)).password).toBe('a'.repeat(64));
 });
 it('rejects unknown modes, cross-mode material, missing credentials and byte/control violations',()=>{
  for(const invalid of [{security:'other'},{security:'open',password:'nonempty'},{security:'personal',eapUsername:''},{security:'open',password:'',eapCaPem:caPem},{...peap,password:'nonempty'},...['eapUsername','eapPassword','eapCaPem','eapDomain'].flatMap(field=>[{...peap,[field]:undefined},{...peap,[field]:''}]),...['eapUsername','eapIdentity','eapPassword'].flatMap(field=>[{...peap,[field]:'中'.repeat(43)},{...peap,[field]:'synthetic\nvalue'}])])expect(()=>buildV3Start({...input,...invalid})).toThrow();
  for(const password of ['a'.repeat(8),'a'.repeat(63)])expect(JSON.parse(buildV3Start({...input,password}).slice(8)).password).toBe(password);
  expect(()=>buildV3Start({...input,password:'中'.repeat(22)})).toThrow();
  for(const field of ['eapUsername','eapIdentity','eapPassword'])expect(()=>buildV3Start({...input,...peap,[field]:'a'.repeat(128)})).not.toThrow();
 });
 it.each([
  ...[{security:'open',password:''},{security:'personal',password:input.password},peap].map(wifi=>({label:wifi.security+' SSID',wifi,field:'ssid',value:'Synthetic中文'})),
  {label:'personal password',wifi:{security:'personal'},field:'password',value:'synthetic_中文_password'},
  ...['eapUsername','eapIdentity','eapPassword'].map(field=>({label:'PEAP '+field,wifi:peap,field,value:'synthetic_中文_value'}))
 ])('rejects non-ASCII $label before writing any serial bytes',async({wifi,field,value})=>{
  const port=portFixture(()=>{}),client=await openV3Serial(port),invalid={...input,...wifi,[field]:value};
  expect(()=>buildV3Start(invalid)).toThrow('ASCII');await expect(client.start(invalid)).rejects.toThrow('ASCII');expect(port.writes).toEqual([]);await client.close();
 });
 it('requires a bounded single CA PEM and an explicit DNS server name without claiming browser X509 verification',()=>{
  for(const eapDomain of ['127.0.0.1','127.1','123','https://radius.example.test','*.example.test','a.example,b.example','a.example b.example','a..example','-a.example','a-.example','a_1.example','a.'.repeat(128),'a'.repeat(64)+'.example','radius.example.'])expect(()=>buildV3Start({...input,...peap,eapDomain})).toThrow();
  for(const eapCaPem of [caPem+caPem,caPem+'private trailing data',caPem.replace('CERTIFICATE','PRIVATE KEY'),'-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----','x'.repeat(4097)])expect(()=>buildV3Start({...input,...peap,eapCaPem})).toThrow();
  expect(JSON.parse(buildV3Start({...input,...peap,eapDomain:'radius'}).slice(8)).eap_domain).toBe('radius');
  // This remains a structural precheck: X.509 parsing and trust are firmware responsibilities.
  expect(()=>buildV3Start({...input,...peap,eapCaPem:'-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n'})).not.toThrow();
 });
 it('keeps the full escaped frame below the native 8192-byte boundary',()=>{
  const eapCaPem='-----BEGIN CERTIFICATE-----\nAAAA'+'\n'.repeat(4000)+'-----END CERTIFICATE-----';
  expect(new TextEncoder().encode(eapCaPem).length).toBeLessThanOrEqual(4096);
  expect(()=>buildV3Start({...input,...peap,eapCaPem})).toThrow('固件上限');
 });
 it('allows explicit PEAP NONE persistence while keeping CA manual and fully validated',()=>{
  for(const windows of [0,1,2,3])expect(()=>buildV3Start({...input,...peap,windows,saveStartup:true,clockKey})).toThrow('PEAP CA 验证');
  expect(()=>buildV3Start({...input,...peap,windows:0})).toThrow('1–3');
  expect(()=>buildV3Start({...input,...peap,startupReconfigure:true})).toThrow();
  expect(()=>buildV3Start({...input,...peap,clockKey})).toThrow();
  expect(JSON.parse(buildV3Start({...input,security:'open',password:'',saveStartup:true,clockKey,windows:0}).slice(8))).toMatchObject({security:'open',password:'',save_startup:true,max_windows:0});
  const unverified={...peap,eapServerVerification:'none',eapCaPem:undefined,eapDomain:undefined};
  for(const windows of [0,1,2,3])expect(JSON.parse(buildV3Start({...input,...unverified,windows,saveStartup:true,clockKey}).slice(8))).toMatchObject({security:'enterprise_peap',eap_server_verification:'none',save_startup:true,max_windows:windows});
 });
 it('uses the fresh identity and bounded USB host clock exchange for PEAP as for personal',()=>{
  expect(()=>buildV3Start({...input,...peap,receivedMono:2201})).toThrow('超时');expect(()=>buildV3Start({...input,...peap,receivedWall:1800000000100})).toThrow('跳变');expect(()=>buildV3Start({...input,...peap,nonce:'b'.repeat(32)})).toThrow('nonce');
 });
 it.each([{security:'personal',password:input.password},{security:'open',password:''},peap])('rechecks fresh nonce before $security credential transfer and accepts only exact START receipt',async wifi=>{const port=portFixture((line,emit)=>{if(line.startsWith('HELLO ')){const fresh=line.trim().slice(6);emit('ignored private console text\nV3 HELLO '+JSON.stringify({...identity,request_id:'f'.repeat(32)})+'\nV3 HELLO '+JSON.stringify({...identity,request_id:fresh})+'\n');}if(line.startsWith('V3START '))emit('V3 START ACCEPTED\n');});const client=await openV3Serial(port);await client.hello(node);expect(port.writes.every(s=>!s.includes(input.token))).toBe(true);expect(await client.start({...input,...wifi,bootId:boot})).toMatchObject({accepted:true,node_id:node});expect(port.writes.filter(s=>s.startsWith('HELLO '))).toHaveLength(2);expect(port.writes.filter(s=>s.startsWith('V3START '))).toHaveLength(1);await client.close();});
 it('rejects a reboot before sending any credential frame',async()=>{const port=portFixture((line,emit)=>{if(line.startsWith('HELLO '))emit('V3 HELLO '+JSON.stringify({...identity,boot_id:'22222222-2222-4222-8222-222222222222',request_id:line.trim().slice(6)})+'\n');});const client=await openV3Serial(port);await expect(client.start({...input,bootId:boot})).rejects.toThrow('重新连接');expect(port.writes.every(s=>!s.includes(input.token))).toBe(true);await client.close();});
 it('rejects malformed fresh nonce and unknown HELLO keys before transferring credentials',()=>{for(const value of ['',nonce.toUpperCase(),'a'.repeat(31),42])expect(()=>validateV3Hello({...identity,request_id:value},value,node)).toThrow();expect(()=>validateV3Hello({...identity,unexpected:true},nonce,node)).toThrow();});
 it('keeps ephemeral frames unchanged and permits zero windows only after explicit save approval',()=>{const ephemeral=JSON.parse(buildV3Start(input).slice(8));for(const key of ['save_startup','startup_reconfigure','clock_key_id','clock_public_spki'])expect(ephemeral).not.toHaveProperty(key);expect(()=>buildV3Start({...input,windows:0})).toThrow();expect(()=>buildV3Start({...input,startupReconfigure:true})).toThrow();expect(()=>buildV3Start({...input,clockKey})).toThrow();const saved=JSON.parse(buildV3Start({...input,windows:0,saveStartup:true,clockKey}).slice(8));expect(saved).toMatchObject({max_windows:0,save_startup:true,startup_reconfigure:false,clock_key_id:clockKey.key_id,clock_public_spki:clockKey.public_key_spki});for(const windows of [1,2,3])expect(JSON.parse(buildV3Start({...input,windows,saveStartup:true,startupReconfigure:true,clockKey}).slice(8))).toMatchObject({max_windows:windows,startup_reconfigure:true});expect(()=>buildV3Start({...input,windows:4,saveStartup:true,clockKey})).toThrow();});
 it('validates exact production clock metadata and canonical DER without accepting unknown keys',()=>{expect(validateV3ClockKey(clockKey)).toEqual(clockKey);for(const key of [{...clockKey,extra:1},{...clockKey,audience:'https://other.invalid'},{...clockKey,schema:'other'},{...clockKey,key_id:'bad\nkey'},{...clockKey,key_id:'a'.repeat(33)},{...clockKey,public_key_spki:clockKey.public_key_spki+'='},{...clockKey,public_key_spki:'A'.repeat(122)}])expect(()=>validateV3ClockKey(key)).toThrow();const bad=Buffer.from(spki);bad[1]=0x58;expect(()=>validateV3ClockKey({...clockKey,public_key_spki:bad.toString('base64url')})).toThrow();});
 it('fetches the public production key without cookies/auth and checks the actual P256 point',async()=>{const fetcher=vi.fn(async()=>new Response(JSON.stringify(clockKey)));expect(await fetchV3ClockKey(fetcher)).toEqual(clockKey);expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${V3_ORIGIN}/api/v3/clock/key`,{credentials:'omit',cache:'no-store',redirect:'error'});await expect(fetchV3ClockKey(async()=>new Response('{}',{status:503}))).rejects.toThrow();const invalid=Buffer.from(spki);invalid[30]^=1;await expect(fetchV3ClockKey(async()=>new Response(JSON.stringify({...clockKey,public_key_spki:invalid.toString('base64url')})))).rejects.toThrow('曲线');});
 it('does not interpret START ACCEPTED or similar text as startup-save confirmation',async()=>{const port=portFixture((line,emit)=>{if(line.startsWith('HELLO '))emit('V3 HELLO '+JSON.stringify({...identity,request_id:line.trim().slice(6)})+'\n');if(line.startsWith('V3START '))emit('V3 START ACCEPTED\nV3 STARTUP SAVED extra\nprivate unknown console line\n');});const client=await openV3Serial(port);expect(await client.start({...input,saveStartup:true,clockKey})).toEqual({accepted:true,node_id:node,boot_id:boot});await expect(client.waitStartupSaved(15)).rejects.toThrow('状态未知');await client.close();});
 it('confirms only exact SAVED after acceptance and keeps a verified result for a later wait',async()=>{const port=portFixture((line,emit)=>{if(line.startsWith('HELLO '))emit('V3 HELLO '+JSON.stringify({...identity,request_id:line.trim().slice(6)})+'\n');if(line.startsWith('V3START '))emit('V3 START ACCEPTED\nV3 STARTUP SAVED\n');});const client=await openV3Serial(port);await client.start({...input,saveStartup:true,clockKey});expect(await client.waitStartupSaved(50)).toEqual({saved:true});expect(await client.waitStartupSaved(50)).toEqual({saved:true});await client.close();});
 it('reports failed save as uncertain without asserting which selector survived',async()=>{const port=portFixture((line,emit)=>{if(line.startsWith('HELLO '))emit('V3 HELLO '+JSON.stringify({...identity,request_id:line.trim().slice(6)})+'\n');if(line.startsWith('V3START '))emit('V3 START ACCEPTED\nV3 STARTUP SAVE FAILED\n');});const client=await openV3Serial(port);await client.start({...input,saveStartup:true,clockKey});await expect(client.waitStartupSaved(50)).rejects.toThrow('保存未确认');await client.close();});
 it('requires explicit allow to inspect a safe restart identity and rechecks a fresh nonce before RESTART',async()=>{expect(()=>validateV3Hello({...identity,restart_required:true},nonce,node)).toThrow();expect(validateV3Hello({...identity,restart_required:true},nonce,node,{allowRestartRequired:true}).restart_required).toBe(true);const port=portFixture((line,emit)=>{if(line.startsWith('HELLO '))emit('V3 HELLO '+JSON.stringify({...identity,restart_required:true,request_id:line.trim().slice(6)})+'\n');});const client=await openV3Serial(port);expect((await client.hello(node,{allowRestartRequired:true})).identity.restart_required).toBe(true);expect(await client.restart(node)).toMatchObject({restart_requested:true,node_id:node});expect(port.writes.filter(line=>line.startsWith('HELLO '))).toHaveLength(2);expect(port.writes.at(-1)).toBe('RESTART\n');expect(port.writes.every(line=>!line.includes(input.token))).toBe(true);await client.close();});
 it('never restarts a normal or mismatched-node device and never transfers credentials from restart-required state',async()=>{for(const actual of [{...identity},{...identity,node_id:'cp_ffeeddccbbaa',restart_required:true}]){const port=portFixture((line,emit)=>{if(line.startsWith('HELLO '))emit('V3 HELLO '+JSON.stringify({...actual,request_id:line.trim().slice(6)})+'\n');});const client=await openV3Serial(port);await expect(client.restart(node)).rejects.toThrow();expect(port.writes.some(line=>line==='RESTART\n')).toBe(false);await client.close();}expect(()=>buildV3Start({...input,identity:{...identity,restart_required:true},saveStartup:true,clockKey})).toThrow();});
});

it('defaults only an omitted or empty PEAP outer identity to the username on the wire',()=>{
 for(const eapIdentity of [undefined,'']){
  const verified=JSON.parse(buildV3Start({...input,...peap,eapIdentity}).slice(8));
  expect(verified.eap_identity).toBe(peap.eapUsername);
  const unverified=JSON.parse(buildV3Start({...input,...peap,eapIdentity,eapCaPem:undefined,eapDomain:undefined,eapServerVerification:'none'}).slice(8));
  expect(unverified.eap_identity).toBe(peap.eapUsername);
 }
 expect(JSON.parse(buildV3Start({...input,...peap,eapIdentity:'anonymous@synthetic.invalid'}).slice(8)).eap_identity).toBe('anonymous@synthetic.invalid');
 for(const eapIdentity of [null,17,false])expect(()=>buildV3Start({...input,...peap,eapIdentity})).toThrow();
});
