import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {build} from 'esbuild';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {createAdminSession} from '../worker/admin-auth';
import {sha256} from '../worker/http';
import {seedStatistics,statisticsFixture,statisticsBatch,statisticsStatus,STATISTICS_FLAGS} from './helpers/v3-statistics-fixtures';
let mf:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>,cookie:string,sessionHash:string;
const origin='https://admin-evidence.example.test',secret='synthetic-evidence-admin-secret',token='synthetic-evidence-device-token';
let f:Awaited<ReturnType<typeof statisticsFixture>>;
const uri=(q='')=>origin+'/api/v1/admin/device-v3/nodes/'+f.policy.node_id+'/evidence'+q;
const request=(q='',headers:Record<string,string>={})=>mf.dispatchFetch(uri(q),{headers:{Cookie:cookie,...headers}});
async function ingest(value:unknown){const body=JSON.stringify(value);const r=await mf.dispatchFetch(origin+'/api/v3/statistics/ingest',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Body-SHA256':await sha256(new TextEncoder().encode(body))},body});expect(r.status).toBe(200);}
beforeAll(async()=>{
 const bundle=await build({entryPoints:['tests/helpers/mqtt-v3-api.ts'],bundle:true,write:false,format:'esm',platform:'neutral',target:'es2022',external:['cloudflare:workers','node:*']});
 mf=new Miniflare(convertV4MiniflareOptions({name:'v3-admin-evidence',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-23',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],
 bindings:{...STATISTICS_FLAGS,ADMIN_TOKEN:secret,OPERATOR_TOKEN:'synthetic-operator'},log:new Log(LogLevel.ERROR)}));
 db=await mf.getD1Database('DB');for(const n of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>/^\d+.*\.sql$/.test(n)).sort())
 await db.exec(readFileSync(new URL('../migrations/'+n,import.meta.url),'utf8').replace(/^--.*$/gm,'').replace(/\n/g,' '));
 const session=await createAdminSession(secret),now=new Date().toISOString();cookie='cp_admin_session='+session.value;sessionHash=session.hash;
 await db.prepare('INSERT INTO admin_accounts(id,username,display_name,password_hash,webauthn_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
 .bind('evidence-admin','evidence-admin','Synthetic evidence admin','unused-test-hash','synthetic-handle',now,now).run();
 await db.prepare("INSERT INTO admin_sessions(token_sha256,created_at,expires_at_ms,role,account_id,auth_version) VALUES(?,?,?,'admin','evidence-admin',1)").bind(session.hash,now,session.expires).run();
 f=await statisticsFixture('synthetic-admin-evidence','synthetic-admin-evidence-place');
 await db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').bind(f.policy.node_id,await sha256(new TextEncoder().encode(token))).run();
 await db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,NULL,0)').bind(f.policy.custody.placement_id,f.policy.node_id).run();
 await seedStatistics(db as unknown as D1Database,f);
 for(let seq=1;seq<=3;seq++)await ingest(await statisticsBatch(f,seq));await ingest(await statisticsStatus(f));
},30000);
afterAll(async()=>{await mf?.dispose();});
describe.sequential('administrator V3 evidence in actual workerd/D1',()=>{
 it('returns one consistent bounded read-only snapshot and complete durable tuples',async()=>{
  const before=await db.prepare('SELECT COUNT(*) n FROM admin_audit').first();const beforeControl=await db.prepare('SELECT * FROM device_control_v3').first();
  const r=await request('?limit=2&generation=1'),v=await r.json() as any;expect(r.status).toBe(200);expect(r.headers.get('Cache-Control')).toBe('no-store');
  expect(v).toMatchObject({schema:'admin-device-v3-evidence/1',snapshot:'single-d1-batch',read_only:true,original_request_bytes_rehashed:false,
   bounds:{limit:2,generation:1,max_limit:50},counts:{batches:4,windows:3,statuses:1,legacy_public_projection_rows:0},
   windows:{returned:2,truncated:true,has_more:true},assignments:{rows:[{generation:1,policy_transport:'https',assigned_place_id:null}]}});
  expect(v.windows.rows.map((w:any)=>w.seq)).toEqual([3,2]);expect(v.statuses.rows[0]).toMatchObject({generation:1,memory:{internal_free:100000},queue:{window_statistics:{pending_items:1}},losses:{window_drops:0}});
  for(const b of v.batches.rows)expect(b).toMatchObject({receipt_shape_valid:true,receipt_tuple_match:true,source_rows_match:true,original_request_bytes_rehashed:false});
  expect(await db.prepare('SELECT COUNT(*) n FROM admin_audit').first()).toEqual(before);expect(await db.prepare('SELECT * FROM device_control_v3').first()).toEqual(beforeControl);
  for(const value of ['bins','item_json','envelope_json','capability_json',token,secret])expect(JSON.stringify(v)).not.toContain(value);
 });
 it('enforces administrator cookie/origin and never promotes operator/device/header identities',async()=>{
  const attempts:Record<string,string>[]=[{Cookie:'',Authorization:'Bearer synthetic-operator'},{Cookie:'',Authorization:'Bearer '+token},{Cookie:'','X-Authenticated-Node':f.policy.node_id},{Cookie:cookie+'changed'}];
  for(const headers of attempts)expect((await request('',headers)).status).toBe(401);
  expect((await request('',{Origin:'https://other.example.test'})).status).toBe(403);expect((await request('',{'Sec-Fetch-Site':'cross-site'})).status).toBe(403);
  expect((await request('?limit=51')).status).toBe(422);expect((await request('?generation=2')).status).toBe(200);
 });
 it('returns 404 for unknown nodes and denies a database-revoked administrator session',async()=>{
  expect((await mf.dispatchFetch(origin+'/api/v1/admin/device-v3/nodes/unknown-node/evidence',{headers:{Cookie:cookie}})).status).toBe(404);
  await db.prepare('DELETE FROM admin_sessions WHERE token_sha256=?').bind(sessionHash).run();expect((await request()).status).toBe(401);
 });
});
