import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {authState,Client,json} from './admin-auth-helpers';
import {seedMqtt} from './helpers/mqtt';
import {DEVICE_TOKEN} from './helpers/ingestion';
import {handleDeviceV3Control} from '../worker/device-v3-control';
import {v3Registration,v3Ack} from './helpers/device-v3-fixtures';
import {statisticsCapabilities} from './helpers/v3-statistics-policy-fixtures';
import {DEVICE_SELECT} from '../worker/admin-device-query';
let state:Awaited<ReturnType<typeof authState>>,client:Client;
beforeEach(async()=>{state=await authState();await seedMqtt(state,4);client=new Client(state);await client.initialize();Object.assign(state.env,{DEVICE_V3_CONTROL_ENABLED:'true',DEVICE_V3_STATISTICS_ENABLED:'true',DEVICE_V3_PRODUCER_VERSIONS:'["synthetic-statistics/1"]'});});
afterEach(()=>{vi.restoreAllMocks();state.db.close();});
const requestDevice=(path:string,body:unknown)=>handleDeviceV3Control(new Request('https://admin.example.test/api/v3/device/'+path,{method:'POST',headers:{Authorization:`Bearer ${DEVICE_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(body)}),state.env);
async function register(capacity=512){const caps=statisticsCapabilities(state.config.node_id);caps.uplink!.transports=['mqtt_tls'];caps.summary!.max_addresses=capacity;expect((await requestDevice('capabilities',v3Registration(caps)))?.status).toBe(200);return caps;}
const prepare=()=>client.call('/device-v3/prepare','POST',{node_id:state.config.node_id,placement_id:state.config.placement_id});
describe('V3 administrator management',()=>{
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
