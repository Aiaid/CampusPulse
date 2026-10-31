import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {authState,Client,ORIGIN} from './admin-auth-helpers';
import {handleDeviceV3Control,type DeviceV3ControlEnv} from '../worker/device-v3-control';
import {handleDeviceV3Statistics} from '../worker/device-v3-statistics';
import {DEVICE_TOKEN} from './helpers/ingestion';
import {seedStatistics,statisticsFixture,statisticsBatch,statisticsStatus,STATISTICS_FLAGS} from './helpers/v3-statistics-fixtures';
import {sha256} from '../worker/ingest';
let state:Awaited<ReturnType<typeof authState>>,env:DeviceV3ControlEnv,client:Client,f:Awaited<ReturnType<typeof statisticsFixture>>;
const cookie=()=>[...client.cookies].map(([k,v])=>k+'='+v).join('; ');
const path=()=>ORIGIN+'/api/v1/admin/device-v3/nodes/'+state.config.node_id+'/evidence';
const read=(query='',headers:Record<string,string>={},method='GET')=>handleDeviceV3Control(new Request(path()+query,{method,headers:{Cookie:cookie(),...headers}}),env).then(r=>r!);
async function ingest(body:unknown){const bytes=new TextEncoder().encode(JSON.stringify(body));return handleDeviceV3Statistics(new Request(ORIGIN+'/api/v3/statistics/ingest',{method:'POST',headers:{Authorization:'Bearer '+DEVICE_TOKEN,'Content-Type':'application/json','X-Body-SHA256':await sha256(bytes)},body:bytes}),env);}
beforeEach(async()=>{state=await authState();client=new Client(state);await client.initialize();env={...state.env,...STATISTICS_FLAGS};f=await statisticsFixture(state.config.node_id,state.config.placement_id);});
afterEach(()=>{vi.restoreAllMocks();state.db.close();});
it('requires signed administrator session and read Origin checks, never alternate principals',async()=>{
 const attempts:Record<string,string>[]=[{Cookie:'',Authorization:'Bearer '+DEVICE_TOKEN},{Cookie:'',Authorization:'Bearer '+state.env.OPERATOR_TOKEN},{Cookie:'','X-Authenticated-Node':state.config.node_id}, {Cookie:cookie()+'tamper'}];
 for(const headers of attempts)expect((await read('',headers)).status).toBe(401);
 expect((await read('',{Origin:'https://other.example.test'})).status).toBe(403);
 expect((await read('',{'Sec-Fetch-Site':'cross-site'})).status).toBe(403);
 expect((await read('',{},'POST')).status).toBe(405);
});
it('returns bounded allowlist evidence, exact receipt tuples and original transport without exposing opaque JSON',async()=>{
 await seedStatistics(env.DB,f);expect((await ingest(await statisticsBatch(f)))?.status).toBe(200);expect((await ingest(await statisticsStatus(f)))?.status).toBe(200);
 const before=state.db.prepare('SELECT total_changes() n').get()?.n,response=await read(),body=await response.json() as any;
 expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store');
 expect(body).toMatchObject({schema:'admin-device-v3-evidence/1',read_only:true,snapshot:'single-d1-batch',original_request_bytes_rehashed:false,
 counts:{batches:2,windows:1,statuses:1,latest_events:0,legacy_public_projection_rows:0},assignments:{truncated:false,rows:[{generation:1,policy_transport:'https',capability:{uplink_transports:['https']}}]},
 windows:{rows:[{generation:1,seq:1,duration_ms:1000,uncertainty_ms:0,reports:{worker:4},losses:{callback_drops:0}}]},
 statuses:{rows:[{memory:{internal_free:100000},queue:{window_statistics:{pending_items:1}},losses:{window_drops:0},raw_recording:null}]}});
 expect(body.batches.rows).toHaveLength(2);for(const b of body.batches.rows)expect(b).toMatchObject({receipt_shape_valid:true,receipt_tuple_match:true,source_rows_match:true,original_request_bytes_rehashed:false});
 for(const forbidden of ['item_json','envelope_json','capability_json','bins','credential_sha256','password_ciphertext',DEVICE_TOKEN])expect(JSON.stringify(body)).not.toContain(forbidden);
 expect(state.db.prepare('SELECT total_changes() n').get()?.n).toBe(before);
});
it('makes truncation explicit, filters generations and keeps node-wide legacy public counts distinct',async()=>{
 await seedStatistics(env.DB,f);for(let seq=1;seq<=3;seq++)expect((await ingest(await statisticsBatch(f,seq)))?.status).toBe(200);
 const body=await (await read('?limit=1&generation=1')).json() as any;
 expect(body.bounds).toMatchObject({limit:1,generation:1,max_limit:50,lists_independently_bounded:true});
 expect(body.counts.windows).toBe(3);expect(body.windows).toMatchObject({returned:1,limit:1,truncated:true,has_more:true});expect(body.windows.rows[0].seq).toBe(3);
 const empty=await (await read('?generation=2')).json() as any;expect(empty.windows.rows).toEqual([]);expect(empty.assignments.rows).toEqual([]);expect(empty.counts.windows).toBe(0);
 expect(empty.counts.legacy_public_projection_scope).toBe('this_node_all_legacy_generations');expect(empty.control).not.toBeNull();
});
it('retains private summary metadata when the statistics gate is disabled and never alters controller inspection',async()=>{
 await seedStatistics(env.DB,f);env.DEVICE_V3_CONTROL_ENABLED='false';env.DEVICE_V3_STATISTICS_ENABLED='false';expect((await read()).status).toBe(200);
 env.DEVICE_V3_CONTROL_ENABLED='true';const inspect=await handleDeviceV3Control(new Request(path().replace('/evidence',''),{headers:{Cookie:cookie()}}),env);
 expect(inspect?.status).toBe(200);expect(await inspect?.json()).toHaveProperty('last_applied_policy');
});
it.each(['?limit=0','?limit=51','?limit=01','?limit=2&limit=3','?generation=0','?generation=9007199254740992','?generation=1&generation=2','?unexpected=1'])(
 'rejects invalid evidence query %s',async query=>{expect((await read(query)).status).toBe(422);});
it.each(['before','after'])('denies a revoked session %s the SELECT batch',async phase=>{
 await seedStatistics(env.DB,f);const batch=env.DB.batch.bind(env.DB);
 vi.spyOn(env.DB,'batch').mockImplementation(async statements=>{if(phase==='before')state.db.exec('DELETE FROM admin_sessions');const rows=await batch(statements);if(phase==='after')state.db.exec('DELETE FROM admin_sessions');return rows;});
 expect((await read()).status).toBe(401);
});
it('binds every query to the requested node and returns 404 for unknown devices',async()=>{
 await seedStatistics(env.DB,f);const missing=await handleDeviceV3Control(new Request(path().replace(state.config.node_id,'unknown-node'),{headers:{Cookie:cookie()}}),env);
 expect(missing?.status).toBe(404);
 const other=await statisticsFixture('other-evidence-node','other-evidence-place');
 state.db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').run(other.policy.node_id,'f'.repeat(64));state.db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,NULL,0)').run(other.policy.custody.placement_id,other.policy.node_id);
 await seedStatistics(env.DB,other);const body=await (await read()).json() as any;expect(body.assignments.rows).toHaveLength(1);expect(JSON.stringify(body)).not.toContain('other-evidence-node');
});
