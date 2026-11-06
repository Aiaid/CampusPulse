import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {authState,Client,json} from './admin-auth-helpers';
import {seedMqtt} from './helpers/mqtt';
import {DEVICE_TOKEN} from './helpers/ingestion';
import {handleDeviceV3Control} from '../worker/device-v3-control';
import {v3Registration,v3Ack} from './helpers/device-v3-fixtures';
import {statisticsCapabilities,statisticsPolicy} from './helpers/v3-statistics-policy-fixtures';
import {DEVICE_SELECT} from '../worker/admin-device-query';
import {freezeDeviceConfigV3,negotiateDeviceConfigV3,type DeviceCapabilitiesV3,type DeviceConfigV3} from '../worker/device-v3-config';
let state:Awaited<ReturnType<typeof authState>>,client:Client;
beforeEach(async()=>{state=await authState();await seedMqtt(state,4);client=new Client(state);await client.initialize();Object.assign(state.env,{DEVICE_V3_CONTROL_ENABLED:'true',DEVICE_V3_STATISTICS_ENABLED:'true',DEVICE_V3_PRODUCER_VERSIONS:'["synthetic-statistics/1"]'});});
afterEach(()=>{vi.restoreAllMocks();state.db.close();});
const requestDevice=(path:string,body:unknown)=>handleDeviceV3Control(new Request('https://admin.example.test/api/v3/device/'+path,{method:'POST',headers:{Authorization:`Bearer ${DEVICE_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(body)}),state.env);
async function register(capacity=512){const caps=statisticsCapabilities(state.config.node_id);caps.uplink!.transports=['mqtt_tls'];caps.summary!.max_addresses=capacity;expect((await requestDevice('capabilities',v3Registration(caps)))?.status).toBe(200);return caps;}
const prepare=()=>client.call('/device-v3/prepare','POST',{node_id:state.config.node_id,placement_id:state.config.placement_id});
// Synthetic identities with the exact declarations emitted by the board firmware.
async function registerBoard(board:'waveshare'|'tenergy',change?:(caps:DeviceCapabilitiesV3)=>void){
 const caps=statisticsCapabilities(state.config.node_id),wave=board==='waveshare';
 caps.producer_version='cp-v3-small/1';
 caps.temporal!.slice_ms=[2000];caps.temporal!.report_modes=wave?['off','terminal_only']:['off'];
 caps.uplink!.transports=['mqtt_tls'];caps.uplink!.max_body_bytes=wave?2048:1024;
 caps.uplink!.streams=wave?['window_statistics','node_status','candidate_events']:['window_statistics','node_status'];
 caps.queue={media:[{medium:wave?'tf_journal':'flash_journal',usable_bytes:wave?24576:3072,max_items:wave?12:3,power_loss_recovery:true}]};
 caps.resources={max_working_bytes:4194304,max_storage_write_bytes_per_day:wave?67108864:1048576,tf_usable_bytes:wave?34627584:null};
 if(!wave)caps.local_raw=null;
 change?.(caps);Object.assign(state.env,{DEVICE_V3_PRODUCER_VERSIONS:'["cp-v3-small/1"]'});
 expect((await requestDevice('capabilities',v3Registration(caps)))?.status).toBe(200);return caps;
}
const validatePolicy=(policy:DeviceConfigV3)=>client.call('/device-v3/validate','POST',{policy,expected_generation:0});
describe('V3 administrator management',()=>{
 it.each(['waveshare','tenergy'] as const)('prepares and negotiates the actual %s queue geometry without fabricating an applied ACK',async board=>{
  const caps=await registerBoard(board),wave=board==='waveshare';
  const result=await json(await prepare()),p=result.policy as DeviceConfigV3;
  expect(result).toMatchObject({valid:true,issues:[],applied:false,requires_device_ack:true});
  expect(p.local_queue).toMatchObject({medium:wave?'tf_journal':'flash_journal',max_bytes:wave?24576:3072,max_items:wave?12:3,
   control_reserve_bytes:wave?4096:1024,control_reserve_items:wave?2:1,
   stream_reserves:[{stream:'window_statistics',bytes:wave?8192:1024,items:wave?4:1},{stream:'node_status',bytes:wave?4096:1024,items:wave?2:1}]});
  expect(p.uplink).toMatchObject({max_body_bytes:wave?2048:1024,streams:['window_statistics','node_status']});
  expect(p.custody.max_upload_bytes_per_day).toBe(wave?8388608:131072);
  expect(p.resources.storage_write_bytes_per_day).toBeLessThanOrEqual(wave?67108864:1048576);
  expect(await negotiateDeviceConfigV3(await freezeDeviceConfigV3(p),caps,{node_id:caps.node_id,boot_id:caps.boot_id,now:new Date().toISOString(),
   last_assignment_generation:0,closed_window_seq:0,closed_segment_seq:0,window_open:false,segment_open:false})).toMatchObject({state:'compatible',issues:[],applied:false});
  expect(await json(await validatePolicy(p))).toMatchObject({valid:true,issues:[]});
  expect(state.db.prepare('SELECT COUNT(*) n FROM device_assignments_v3').get()?.n).toBe(0);
  expect(state.db.prepare('SELECT COUNT(*) n FROM device_acknowledgements_v3').get()?.n).toBe(0);
 });
 it('rejects an excessive T-Energy uplink budget in management and direct new assignment',async()=>{
  await registerBoard('tenergy');const {policy}=await json(await prepare()),p=policy as DeviceConfigV3;
  expect(await json(await validatePolicy(p))).toMatchObject({valid:true,issues:[]});
  p.custody.max_upload_bytes_per_day=131073;
  expect(await json(await validatePolicy(p))).toMatchObject({valid:false,issues:expect.arrayContaining([
   {code:'unsupported_capability',path:'custody.max_upload_bytes_per_day'}])});
  expect((await client.call('/device-v3/assignments','POST',{policy:p,expected_generation:0})).status).toBe(422);
  p.custody.max_upload_bytes_per_day=8388608;
  expect((await client.call('/device-v3/assignments','POST',{policy:p,expected_generation:0})).status).toBe(422);
  expect(state.db.prepare('SELECT COUNT(*) n FROM device_assignments_v3').get()?.n).toBe(0);
 });
 it('reports expired capabilities before constructing invalid activation dates',async()=>{
  const caps=await registerBoard('waveshare');
  vi.spyOn(Date,'now').mockReturnValue(Date.parse(caps.expires_at));
  const response=await prepare();expect(response.status).toBe(409);
  expect(await json(response,409)).toMatchObject({error:{code:'v3_capabilities_expired'}});
  expect(state.db.prepare('SELECT COUNT(*) n FROM device_assignments_v3').get()?.n).toBe(0);
 });
 it('rejects the old Waveshare generation-6 reserves and each changed fixed reservation',async()=>{
  await registerBoard('waveshare');const {policy}=await json(await prepare());
  const old=structuredClone(policy) as DeviceConfigV3;
  if(old.local_queue.mode==='disabled')throw new Error('queue missing');
  old.local_queue.control_reserve_bytes=2048;old.local_queue.control_reserve_items=1;
  old.local_queue.stream_reserves.forEach(r=>{r.bytes=2048;r.items=1;});
  const rejected=await json(await validatePolicy(old));expect(rejected.valid).toBe(false);expect(rejected.issues).toHaveLength(6);
  expect((await client.call('/device-v3/assignments','POST',{policy:old,expected_generation:0})).status).toBe(422);
  const changes:[string,(p:DeviceConfigV3)=>void][]=[
   ['local_queue.max_bytes',p=>{if(p.local_queue.mode!=='disabled')p.local_queue.max_bytes=20000;}],
   ['local_queue.max_items',p=>{if(p.local_queue.mode!=='disabled')p.local_queue.max_items=10;}],
   ['local_queue.control_reserve_bytes',p=>{if(p.local_queue.mode!=='disabled')p.local_queue.control_reserve_bytes=2048;}],
   ['local_queue.control_reserve_items',p=>{if(p.local_queue.mode!=='disabled')p.local_queue.control_reserve_items=1;}],
   ['local_queue.stream_reserves.window_statistics.bytes',p=>{if(p.local_queue.mode!=='disabled')p.local_queue.stream_reserves[0].bytes=4096;}],
   ['local_queue.stream_reserves.window_statistics.items',p=>{if(p.local_queue.mode!=='disabled')p.local_queue.stream_reserves[0].items=2;}],
   ['local_queue.stream_reserves.node_status.bytes',p=>{if(p.local_queue.mode!=='disabled')p.local_queue.stream_reserves[1].bytes=2048;}],
   ['local_queue.stream_reserves.node_status.items',p=>{if(p.local_queue.mode!=='disabled')p.local_queue.stream_reserves[1].items=1;}],
   ['uplink.max_body_bytes',p=>{if(p.uplink.enabled)p.uplink.max_body_bytes=1024;}],
  ];
  for(const [path,change] of changes){const p=structuredClone(policy);change(p);expect(await json(await validatePolicy(p))).toMatchObject({valid:false,issues:expect.arrayContaining([{code:'unsupported_capability',path}])});}
  expect(state.db.prepare('SELECT COUNT(*) n FROM device_assignments_v3').get()?.n).toBe(0);
 });
 it('preserves exact replay of a retained unsupported Waveshare assignment and failed ACK',async()=>{
  await registerBoard('waveshare');const {policy}=await json(await prepare()),p=policy as DeviceConfigV3;
  if(p.local_queue.mode==='disabled')throw new Error('queue missing');
  p.local_queue.control_reserve_bytes=2048;p.local_queue.control_reserve_items=1;
  p.local_queue.stream_reserves.forEach(r=>{r.bytes=2048;r.items=1;});
  // Seed an immutable assignment from before this compatibility repair.
  const frozen=await freezeDeviceConfigV3(p),stamp=new Date().toISOString();
  state.db.prepare('INSERT INTO device_assignments_v3(node_id,generation,policy_id,revision,boot_id,capability_sha256,policy_sha256,envelope_json,placement_id,not_before_ms,expires_at_ms,assigned_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
   .run(p.node_id,p.assignment_generation,p.policy_id,p.revision,p.control.activation.boot_id,p.control.capability_sha256,frozen.policy_sha256,JSON.stringify(frozen),p.custody.placement_id,Date.parse(p.control.activation.not_before),Date.parse(p.control.activation.expires_at),stamp);
  state.db.prepare('UPDATE device_control_v3 SET desired_generation=? WHERE node_id=?').run(p.assignment_generation,p.node_id);
  expect((await requestDevice('config/ack',{...await v3Ack(p),state:'failed',error_code:'unsupported_config'}))?.status).toBe(200);
  const assignments=state.db.prepare('SELECT * FROM device_assignments_v3').all(),acks=state.db.prepare('SELECT * FROM device_acknowledgements_v3').all();
  const receipt=await json(await client.call('/device-v3/assignments','POST',{policy:p,expected_generation:0}));
  expect(receipt).toMatchObject({assignment_generation:1,policy_sha256:frozen.policy_sha256,state:'assigned',applied:false});
  expect(state.db.prepare('SELECT * FROM device_assignments_v3').all()).toEqual(assignments);
  expect(state.db.prepare('SELECT * FROM device_acknowledgements_v3').all()).toEqual(acks);
 });
 it('requires the exact Waveshare event reservation when candidate events are enabled',async()=>{
  await registerBoard('waveshare');const {policy}=await json(await prepare()),p=policy as DeviceConfigV3;
  if(!p.uplink.enabled||p.local_queue.mode==='disabled'||p.temporal?.mode!=='rolling')throw new Error('profile missing');
  p.uplink.streams.push('candidate_events');p.temporal.report_mode='terminal_only';
  p.local_queue.stream_reserves.push({stream:'candidate_events',bytes:8192,items:4});
  expect(await json(await validatePolicy(p))).toMatchObject({valid:true,issues:[]});
  const event=p.local_queue.stream_reserves[2];event.bytes=2048;event.items=1;
  expect(await json(await validatePolicy(p))).toMatchObject({valid:false,issues:[
   {code:'unsupported_capability',path:'local_queue.stream_reserves.candidate_events.bytes'},
   {code:'unsupported_capability',path:'local_queue.stream_reserves.candidate_events.items'}]});
 });
 it.each(['bytes','items','body'] as const)('fails closed for unsupported small-producer TF %s declarations',async field=>{
  await registerBoard('waveshare',c=>{
   if(field==='bytes')c.queue!.media[0].usable_bytes=32768;if(field==='items')c.queue!.media[0].max_items=16;if(field==='body')c.uplink!.max_body_bytes=4096;});
  expect((await prepare()).status).toBe(422);
  expect(state.db.prepare('SELECT COUNT(*) n FROM device_assignments_v3').get()?.n).toBe(0);
 });
 it('keeps unrelated producer TF policies compatible with manual validation and assignment',async()=>{
  const caps=statisticsCapabilities(state.config.node_id);caps.uplink!.transports=['mqtt_tls'];
  caps.queue={media:[{medium:'tf_journal',usable_bytes:32768,max_items:16,power_loss_recovery:true}]};
  expect((await requestDevice('capabilities',v3Registration(caps)))?.status).toBe(200);
  expect(await json(await prepare())).toMatchObject({valid:true,issues:[]});
  const p=await statisticsPolicy(caps,state.config.placement_id);
  if(!p.uplink.enabled||p.local_queue.mode==='disabled')throw new Error('profile missing');
  p.uplink.transport='mqtt_tls';p.local_queue.medium='tf_journal';
  expect(await json(await validatePolicy(p))).toMatchObject({valid:true,issues:[]});
  expect(await json(await client.call('/device-v3/assignments','POST',{policy:p,expected_generation:0}))).toMatchObject({state:'assigned',applied:false});
 });
 it('retires old configuration and diagnostics routes while preserving historical records',async()=>{
  const old=state.db.prepare('SELECT * FROM capture_configs').all();
  for(const path of ['/configs','/configs/old/publish',`/devices/${state.config.node_id}/batches`])expect((await client.call(path,path.includes('publish')?'POST':'GET',path.includes('publish')?{}:undefined)).status).toBe(404);
  expect(state.db.prepare('SELECT * FROM capture_configs').all()).toEqual(old);
  expect(await json(await client.call('/overview'))).toMatchObject({devices_unknown:1,devices_recent:0});
  const d=await json(await client.call('/devices'));expect(d.devices[0]).toMatchObject({protocol:'campuspulse/3',config_state:'unassigned',last_seen_at:null,latest_status:null});
 });
 it('requires real capability registration and publishes pending until exact device ACK',async()=>{
  expect((await prepare()).status).toBe(409);await register();
  const preflight=await json(await prepare());expect(preflight).toMatchObject({valid:true,applied:false,requires_device_ack:true,expected_generation:0});
  expect(preflight.policy).toMatchObject({protocol:'campuspulse/3',local_raw:{mode:'off'},uplink:{transport:'mqtt_tls'},evidence:{ruleset_version:'unclassified-v1'},custody:{dataset:'controlled_test'}});
  expect(state.db.prepare('SELECT COUNT(*) n FROM device_assignments_v3').get()?.n).toBe(0);
  expect((await client.call('/device-v3/validate','POST',{policy:preflight.policy,expected_generation:0})).status).toBe(200);
  await json(await client.call('/device-v3/assignments','POST',{policy:preflight.policy,expected_generation:0}));
  let detail=await json(await client.call(`/devices/${state.config.node_id}`));expect(detail.device).toMatchObject({config_state:'pending',desired_generation:1,applied_generation:null});
  expect((await requestDevice('config/ack',await v3Ack(preflight.policy)))?.status).toBe(200);
  detail=await json(await client.call(`/devices/${state.config.node_id}`));expect(detail.device).toMatchObject({config_state:'applied',desired_generation:1,applied_generation:1});
  const evidence=await json(await client.call(`/device-v3/nodes/${state.config.node_id}/evidence`));expect(evidence.read_only).toBe(true);expect(evidence.acknowledgements.rows[0].state).toBe('applied');expect(evidence.leases.rows).toHaveLength(1);
 });
 it('rejects capability mismatch, foreign placement, stale generation and legacy input without assignments',async()=>{
  await register(256);const {policy}=await json(await prepare());policy.collection.summary.max_addresses=512;
  const rejected=await json(await client.call('/device-v3/validate','POST',{policy,expected_generation:0}));expect(rejected.valid).toBe(false);expect(rejected.issues.some((i:{path:string})=>i.path==='collection.summary.max_addresses')).toBe(true);
  expect((await client.call('/device-v3/assignments','POST',{policy,expected_generation:0})).status).toBe(422);
  expect((await client.call('/device-v3/validate','POST',{policy:state.config,expected_generation:0})).status).toBe(422);
  const {policy:other}=await json(await prepare());other.custody.placement_id='unregistered-placement';expect((await json(await client.call('/device-v3/validate','POST',{policy:other,expected_generation:0}))).valid).toBe(false);
  expect((await client.call('/device-v3/validate','POST',{policy:other,expected_generation:1})).status).toBe(409);
  expect(state.db.prepare('SELECT COUNT(*) n FROM device_assignments_v3').get()?.n).toBe(0);
 });
 it('uses indexed V3 latest probes and never joins historical protocol activity into current state',async()=>{
  await register();const plan=state.db.prepare(`EXPLAIN QUERY PLAN ${DEVICE_SELECT} WHERE n.id=?`).all(state.config.node_id).map(r=>r.detail).join('\n');
  expect(plan).toContain('statistics_batches_v3_admin_latest');expect(plan).toContain('statistics_batches_v3_admin_stream_latest');expect(plan).toContain('statistics_status_v3_admin_batch');expect(plan).not.toMatch(/MATERIALIZE|USE TEMP B-TREE/);
  const overview=await json(await client.call('/overview'));expect(overview).toMatchObject({devices_total:1,devices_recent:1,config_pending:0});
 });
 it('keeps cookie auth, credential ownership and secret-free registry metadata',async()=>{
  const anonymous=new Client(state);expect((await anonymous.call('/devices','GET',undefined,{Authorization:`Bearer ${DEVICE_TOKEN}`})).status).toBe(401);
  expect((await client.call('/devices','POST',{id:'synthetic-v3-new',name:'Synthetic new node',board:'Synthetic only'})).status).toBe(201);
  const all=await json(await client.call('/devices'));expect(JSON.stringify(all)).not.toMatch(/credential_sha256|password|cpd_/);
  expect((await client.call(`/devices/${state.config.node_id}`,'PATCH',{enabled:false})).status).toBe(200);expect((await requestDevice('capabilities',v3Registration(statisticsCapabilities(state.config.node_id))))?.status).toBe(401);
  const session=await client.call('/session');expect(session.status).toBe(200);
 });
 it('preserves settings revisions, placement purposes and audit atomicity',async()=>{
  const settings=await json(await client.call('/settings'));
  await json(await client.call('/settings','PUT',{settings:{...settings.settings,site_name:'Synthetic V3 campus'},revision:settings.revision}));
  expect((await client.call('/settings','PUT',{settings:settings.settings,revision:settings.revision})).status).toBe(409);
  const at=Date.now();await json(await client.call(`/devices/${state.config.node_id}/placements`,'POST',{id:'v3-next-placement',place_id:'library',valid_from_ms:at,valid_until_ms:null,observation_kinds:['activity']}),201);
  expect(state.db.prepare('SELECT observation_kinds_json FROM placements WHERE id=?').get('v3-next-placement')?.observation_kinds_json).toBe('["activity"]');
  state.db.exec("CREATE TRIGGER synthetic_admin_audit_outage BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'synthetic_outage'); END");
  expect((await client.call(`/devices/${state.config.node_id}`,'PATCH',{name:'Must roll back'})).status).toBe(503);expect(state.db.prepare('SELECT name FROM device_nodes WHERE id=?').get(state.config.node_id)?.name).not.toBe('Must roll back');
 });
 it('preserves signed cookie tamper, expiry, logout replay and signing-key revocation boundaries',async()=>{
  const login=await client.call('/session','POST',{username:'qa-admin',password:' synthetic long password for auth tests '});
  expect(login.status).toBe(200);const header=login.headers.get('Set-Cookie')!;
  for(const flag of ['HttpOnly','SameSite=Strict','Secure','Path=/api/v1/admin'])expect(header).toContain(flag);
  const current=client.cookies.get('cp_admin_session')!,tampered=client.clone(),at=current.length-10;
  tampered.cookies.set('cp_admin_session',current.slice(0,at)+(current[at]==='a'?'b':'a')+current.slice(at+1));
  expect((await tampered.call('/devices')).status).toBe(401);
  const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+9*3600000);expect((await client.call('/devices')).status).toBe(401);vi.restoreAllMocks();
  const replay=client.clone();await client.call('/session','DELETE');expect((await replay.call('/devices')).status).toBe(401);
  await client.login();state.env.ADMIN_TOKEN='synthetic-rotated-admin-signing-key';expect((await client.call('/devices')).status).toBe(401);
 });
 it('rotates device HTTP credentials immediately without changing its MQTT identity',async()=>{
  const before=await json(await client.call(`/devices/${state.config.node_id}/mqtt`,'POST',{}));
  const {credential}=await json(await client.call(`/devices/${state.config.node_id}/rotate-credential`,'POST',{}));
  const after=await json(await client.call(`/devices/${state.config.node_id}/mqtt`,'POST',{}));expect(after.mqtt).toEqual(before.mqtt);
  const caps=statisticsCapabilities(state.config.node_id);caps.uplink!.transports=['mqtt_tls'];
  expect((await requestDevice('capabilities',v3Registration(caps)))?.status).toBe(401);
  const response=await handleDeviceV3Control(new Request('https://admin.example.test/api/v3/device/capabilities',{method:'POST',headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},body:JSON.stringify(v3Registration(caps))}),state.env);expect(response?.status).toBe(200);
 });

});
