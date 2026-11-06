import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { createAdminSession } from '../worker/admin-auth';
import { sha256 } from '../worker/http';
import { capabilityDigestV3, freezeDeviceConfigV3, type DeviceConfigV3 } from '../worker/device-v3-config';
import { v3Ack, v3Registration } from './helpers/device-v3-fixtures';
import { statisticsCapabilities, statisticsPolicy } from './helpers/v3-statistics-policy-fixtures';
let mf:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>,cookie:string;
const ORIGIN='https://synthetic-transitions.example.test',secret='synthetic-transition-admin';
async function body(response:{status:number;json():Promise<unknown>},status=200):Promise<Record<string,any>> { const value=await response.json(); expect(response.status,JSON.stringify(value)).toBe(status); return value as Record<string,any>; }
async function request(path:string,value?:unknown,token?:string,admin=false,headers:Record<string,string>={}) {
  return mf.dispatchFetch(ORIGIN+path,{method:value===undefined?'GET':'POST',headers:{...(admin?{Cookie:cookie,Origin:ORIGIN}:token?{Authorization:`Bearer ${token}`} : {}),
    ...(value===undefined?{}:{'Content-Type':'application/json'}),...headers},...(value===undefined?{}:{body:typeof value==='string'?value:JSON.stringify(value)})});
}
beforeAll(async()=>{
  const bundle=await build({stdin:{contents:`import {handleDeviceV3Control} from './worker/device-v3-control'; import {handleDeviceV3Statistics} from './worker/device-v3-statistics'; export default {async fetch(r,e){return await handleDeviceV3Control(r,e)??await handleDeviceV3Statistics(r,e)??new Response('Not found',{status:404})}}`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'neutral',external:['node:*'],target:'es2022'});
  mf=new Miniflare(convertV4MiniflareOptions({name:'scope-transition-tests',modules:true,script:bundle.outputFiles[0].text,
    compatibilityDate:'2026-10-23',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{DEVICE_V3_CONTROL_ENABLED:'true',DEVICE_V3_STATISTICS_ENABLED:'true',DEVICE_V3_STARTUP_ENABLED:'true',DEVICE_V3_PRODUCER_VERSIONS:'["synthetic-statistics/1"]',ADMIN_TOKEN:secret},log:new Log(LogLevel.ERROR)}));
  db=await mf.getD1Database('DB');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>/^\d+.*\.sql$/.test(n)).sort())await db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8').replace(/^--.*$/gm,'').replace(/\n/g,' '));
  const now=new Date().toISOString(),session=await createAdminSession(secret);cookie=`cp_admin_session=${session.value}`;
  await db.prepare('INSERT INTO admin_accounts(id,username,display_name,password_hash,webauthn_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind('synthetic-transition-admin','synthetic-transition-admin','Synthetic admin','unused-test-hash','synthetic-transition-handle',now,now).run();
  await db.prepare("INSERT INTO admin_sessions(token_sha256,created_at,expires_at_ms,role,account_id,auth_version) VALUES(?,?,?,'admin','synthetic-transition-admin',1)").bind(session.hash,now,session.expires).run();
},30000);
afterAll(async()=>{await mf?.dispose();});
async function prepare(options:{online?:boolean,remaining?:number,ack?:boolean}={}) {
  const node='transition-'+crypto.randomUUID(),token='synthetic-token-'+crypto.randomUUID(),placement='place-'+crypto.randomUUID(),caps=statisticsCapabilities(node);
  caps.uplink!.transports=['mqtt_tls']; caps.statistics!.ruleset_versions.push('cp-v3-vehicle-candidates/1');
  if(options.online!==false)caps.online_control={schema:'online-control/1',scope_rebind:true,capability_renewal:true};
  if(options.remaining)caps.expires_at=new Date(Date.now()+options.remaining).toISOString();
  const policy=await statisticsPolicy(caps,placement);if(policy.uplink.enabled)policy.uplink.transport='mqtt_tls';
  if(options.remaining)policy.control.activation.expires_at=caps.expires_at;
  await db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').bind(node,await sha256(new TextEncoder().encode(token))).run();
  await db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,?,0)').bind(placement,node,'library').run();
  const device=(path:string,value?:unknown,headers?:Record<string,string>)=>request('/api/v3/device'+path,value,token,false,headers);
  const route=`/api/v1/admin/device-v3/nodes/${node}/transitions`,grantRoute=`/api/v1/admin/device-v3/nodes/${node}/startup-grant`;
  const grant=(value?:unknown)=>request(grantRoute,value,undefined,true),transition=(value?:unknown)=>request(route,value,undefined,true);
  await body(await device('/capabilities',v3Registration(caps)));
  await body(await request('/api/v1/admin/device-v3/assignments',{policy,expected_generation:0},undefined,true));
  if(options.ack!==false){await body(await device('/config/ack',await v3Ack(policy)));await body(await grant({expected_revision:0,enabled:true,source_generation:1,grant_expires_at:new Date(Date.now()+86400000).toISOString(),policy_ttl_ms:1200000,accept_grace_ms:3600000}));}
  const intent={request_id:crypto.randomUUID(),expected_boot_id:caps.boot_id,expected_capability_sha256:await capabilityDigestV3(caps),expected_generation:1,expected_startup_revision:1,
    target_place_id:'library',target_dataset:'field',target_ruleset:'cp-v3-vehicle-candidates/1',migrate_startup:true};
  const ready={protocol:'campuspulse/3',schema:'scope-transition-ready/1',transition_id:intent.request_id,boot_id:caps.boot_id,from_generation:1,capability_sha256:intent.expected_capability_sha256,
    closed_window_seq:3,closed_segment_seq:2,clock_epoch:1,uptime_ms:2000,observation_upper_ms:Date.now()};
  const config=()=>device('/config?boot_id='+caps.boot_id),get=(table:string)=>db.prepare(`SELECT * FROM ${table} WHERE node_id=?`).bind(node).all();
  return{node,token,placement,caps,policy,device,grant,transition,route,intent,ready,config,get};
}
async function cutover(f:Awaited<ReturnType<typeof prepare>>) {await body(await f.transition(f.intent),201);return body(await f.device('/lease',f.ready));}

describe.sequential('same-boot scope transitions in actual workerd / D1',()=>{
  it('creates only intent; preserves old assignment, placement, grant and lease until Ready',async()=>{
    const f=await prepare(),before=await Promise.all(['placements','device_assignments_v3','device_startup_grants_v3','device_statistics_lease_spans_v3'].map(f.get));
    expect(await body(await f.transition())).toMatchObject({transition:null});
    const created=await body(await f.transition(f.intent),201);expect(created.transition).toMatchObject({id:f.intent.request_id,state:'pending',applied:false,assignment_generation:null});
    expect((await Promise.all(['placements','device_assignments_v3','device_startup_grants_v3','device_statistics_lease_spans_v3'].map(f.get))).map(r=>r.results)).toEqual(before.map(r=>r.results));
    expect((await body(await f.config())).online_transition).toMatchObject({id:f.intent.request_id,phase:'pending'});
    expect(await body(await f.transition(f.intent))).toEqual(created);
    await body(await f.transition({...f.intent,request_id:crypto.randomUUID()}),409);
    await body(await f.transition({...f.intent,target_dataset:'demo'}),409);
  });
  it('commits one cutover under concurrent Ready retries and transfers grant only with real ACK',async()=>{
    const f=await prepare(),old=await f.get('device_assignments_v3'),original=(await body(await f.grant())).startup_grant;
    await body(await f.transition(f.intent),201);
    const responses=await Promise.all([f.device('/lease',f.ready),f.device('/lease',f.ready)]),receipt=await body(responses[0]);expect(await body(responses[1])).toEqual(receipt);
    expect(receipt).toMatchObject({schema:'scope-transition-ready-receipt/1',node_id:f.node,assignment_generation:2,durability:'committed',evidence:'device_pause'});
    const config=await body(await f.config()),next=config.config.policy as DeviceConfigV3;
    expect(next.control.activation.boot_id).toBe(f.caps.boot_id);expect(next.custody.dataset).toBe('field');expect(next.resources).toEqual(f.policy.resources);
    expect(next.evidence).toMatchObject({ruleset_version:'cp-v3-vehicle-candidates/1'});
    expect((await body(await f.grant())).startup_grant).toMatchObject({revision:2,enabled:0});
    expect((await f.get('device_acknowledgements_v3')).results).toHaveLength(1);
    const closure=await db.prepare('SELECT valid_until_ms FROM placement_closures WHERE node_id=?').bind(f.node).first<{valid_until_ms:number}>();
    expect((await db.prepare('SELECT valid_from_ms FROM placements WHERE id=?').bind(next.custody.placement_id).first())?.valid_from_ms).toBe(closure!.valid_until_ms);
    expect((await f.get('device_statistics_lease_spans_v3')).results[0].end_ms).toBe(closure!.valid_until_ms);
    await body(await request(f.route+'/'+f.intent.request_id+'/cancel',{},undefined,true),409);
    await body(await f.device('/config/ack',await v3Ack(next,2)));
    const moved=(await body(await f.grant())).startup_grant;
    expect(moved).toMatchObject({revision:3,enabled:1,source_generation:2,source_policy_sha256:receipt.policy_sha256,grant_expires_at_ms:original.grant_expires_at_ms,policy_ttl_ms:original.policy_ttl_ms,accept_grace_ms:original.accept_grace_ms});
    expect((await body(await f.transition())).transition).toMatchObject({state:'applied',startup_grant_migrated:true});
    expect((await f.get('device_assignments_v3')).results[0]).toEqual(old.results[0]);
    expect(await body(await f.device('/lease',f.ready,{'X-Receipt-Only':'1'}))).toEqual(receipt);
  });
  it('requires current identity, supported metadata, real applied source and enough remaining lifetime',async()=>{
    for(const options of [{online:false},{remaining:100000},{ack:false}]){
      const f=await prepare(options);await body(await f.transition(f.intent),options.online===false?422:409);expect((await f.get('device_scope_transitions_v3')).results).toHaveLength(0);
    }
    const f=await prepare();
    for(const patch of [{expected_boot_id:crypto.randomUUID()},{expected_capability_sha256:'0'.repeat(64)},{expected_generation:2},{expected_startup_revision:2}])await body(await f.transition({...f.intent,...patch}),409);
    await body(await request(f.route,f.intent,f.token,false,{Origin:ORIGIN}),401);
    for(const patch of [{migrate_startup:false},{target_place_id:'missing-place'},{target_ruleset:'unknown-rules'},{resources:{working_bytes:1}}])await body(await f.transition({...f.intent,...patch}),422);
  });
  it('rejects future, regressing, malformed and wrong-node Ready without mutating scope',async()=>{
    const f=await prepare(),other=await prepare();await body(await f.transition(f.intent),201);
    await body(await f.device('/lease',f.ready,{'X-Receipt-Only':'1'}),409);
    for(const patch of [{boot_id:crypto.randomUUID()},{from_generation:2},{capability_sha256:'0'.repeat(64)},{observation_upper_ms:Date.now()+60000},{closed_window_seq:2},{closed_segment_seq:1},{uptime_ms:999}])await body(await f.device('/lease',{...f.ready,...patch}),409);
    for(const patch of [{clock_epoch:0},{uptime_ms:1.5},{observation_upper_ms:-1},{extra:true}])await body(await f.device('/lease',{...f.ready,...patch}),422);
    await body(await other.device('/lease',f.ready),409);
    expect((await f.get('placements')).results).toHaveLength(1);expect((await body(await f.grant())).startup_grant).toMatchObject({enabled:1,revision:1});
  });
  it('pending cancellation wins without closing old authority; cancelled intents cannot become assignments',async()=>{
    const f=await prepare();await body(await f.transition(f.intent),201);
    await body(await request(f.route+'/'+f.intent.request_id+'/cancel',{},undefined,true));await body(await f.device('/lease',f.ready),409);
    expect((await f.get('placement_closures')).results).toHaveLength(0);expect((await f.get('device_assignments_v3')).results).toHaveLength(1);
    expect((await body(await f.config())).online_transition).toBeUndefined();
  });
  it('failed ACK retains ready evidence but never migrates the disabled grant',async()=>{
    const f=await prepare(),receipt=await cutover(f),next=(await body(await f.config())).config.policy;
    await body(await f.device('/config/ack',{...await v3Ack(next,2),state:'failed',error_code:'storage_failed'}));
    expect((await body(await f.grant())).startup_grant).toMatchObject({revision:2,enabled:0});
    expect((await body(await f.transition())).transition).toMatchObject({state:'failed',startup_grant_migrated:false});
    expect((await f.get('device_statistics_authorizations_v3')).results).toHaveLength(1);
    expect(await body(await f.device('/lease',f.ready))).toEqual(receipt);
  });
  it('operator revocation after Ready blocks new ACK but exact cached Ready remains recoverable',async()=>{
    const f=await prepare(),receipt=await cutover(f),next=(await body(await f.config())).config.policy;
    await body(await f.grant({expected_revision:2,enabled:false}));
    await body(await f.device('/config/ack',await v3Ack(next,2)),409);
    expect((await body(await f.config())).config).toBeNull();expect(await body(await f.device('/lease',f.ready,{'X-Receipt-Only':'1'}))).toEqual(receipt);
    await body(await f.device('/lease',{...f.ready,uptime_ms:2001}),409);
    expect((await body(await f.grant())).startup_grant).toMatchObject({revision:3,enabled:0});
  });
  it('rolls back Ready if node authority or target scope changes inside the cutover transaction',async()=>{
    const f=await prepare();await body(await f.transition(f.intent),201);
    await db.exec(`CREATE TRIGGER transition_test_revoke AFTER INSERT ON placement_closures WHEN NEW.node_id='${f.node}' BEGIN UPDATE device_nodes SET enabled=0 WHERE id=NEW.node_id; END`);
    try{await body(await f.device('/lease',f.ready),409);}finally{await db.exec('DROP TRIGGER transition_test_revoke');}
    expect((await f.get('placement_closures')).results).toHaveLength(0);expect((await f.get('device_scope_transition_receipts_v3')).results).toHaveLength(0);
    expect((await body(await f.grant())).startup_grant).toMatchObject({enabled:1,revision:1});
    await db.exec(`CREATE TRIGGER transition_test_target AFTER INSERT ON placement_closures WHEN NEW.node_id='${f.node}' BEGIN UPDATE places SET observation_kinds_json='["parking"]',kind='parking' WHERE id='library'; END`);
    try{await body(await f.device('/lease',f.ready),409);}finally{await db.exec('DROP TRIGGER transition_test_target');}
    expect((await f.get('placement_closures')).results).toHaveLength(0);
  });
  it('rolls back real ACK if an external revocation races grant transfer',async()=>{
    const f=await prepare();await cutover(f);const next=(await body(await f.config())).config.policy;
    await db.exec(`CREATE TRIGGER transition_test_ack AFTER INSERT ON device_statistics_authorizations_v3 WHEN NEW.node_id='${f.node}' AND NEW.generation=2 BEGIN INSERT INTO device_startup_grants_v3(node_id,revision,enabled,created_at) VALUES(NEW.node_id,3,0,'synthetic'); UPDATE device_startup_state_v3 SET revision=3 WHERE node_id=NEW.node_id; END`);
    try{await body(await f.device('/config/ack',await v3Ack(next,2)),409);}finally{await db.exec('DROP TRIGGER transition_test_ack');}
    expect((await f.get('device_acknowledgements_v3')).results).toHaveLength(1);expect((await body(await f.grant())).startup_grant).toMatchObject({revision:2,enabled:0});
  });
  it('boot/capability changes and pending grant revocation invalidate an unconsumed intent',async()=>{
    for(const kind of ['boot','capability','revoke']){
      const f=await prepare();await body(await f.transition(f.intent),201);
      if(kind==='revoke')await body(await f.grant({expected_revision:1,enabled:false}));
      else {const caps={...f.caps,capability_id:'fresh-'+crypto.randomUUID(),...(kind==='boot'?{boot_id:crypto.randomUUID()}: {})};await body(await f.device('/capabilities',v3Registration(caps,kind==='boot'?1:2,3000)));}
      await body(await f.device('/lease',f.ready),409);expect((await f.get('placement_closures')).results).toHaveLength(0);
    }
  });
  it('rejects an expired retained intent at the database clock without changing the old placement',async()=>{
    const f=await prepare();await body(await f.transition(f.intent),201);
    await body(await request(f.route+'/'+f.intent.request_id+'/cancel',{},undefined,true));
    const expired=crypto.randomUUID();
    // Explicit historical fixture: immutable retained intent, already expired.
    await db.prepare(`INSERT INTO device_scope_transitions_v3 SELECT ?,node_id,request_sha256,boot_id,capability_sha256,from_generation,source_policy_sha256,
      expected_startup_revision,old_placement_id,target_place_id,target_dataset,target_ruleset,target_kinds_json,grant_expires_at_ms,policy_ttl_ms,accept_grace_ms,
      created_at_ms-600000,expires_at_ms-600000 FROM device_scope_transitions_v3 WHERE id=?`).bind(expired,f.intent.request_id).run();
    await db.prepare("INSERT INTO device_scope_transition_state_v3(id,node_id,phase) VALUES(?,?,'pending')").bind(expired,f.node).run();
    await body(await f.device('/lease',{...f.ready,transition_id:expired}),409);
    expect((await f.get('placement_closures')).results).toHaveLength(0);expect((await f.get('device_assignments_v3')).results).toHaveLength(1);
  });
  it('checks administrator authorization again inside the intent transaction',async()=>{
    const f=await prepare();
    await db.exec(`CREATE TRIGGER transition_test_admin AFTER INSERT ON device_scope_transitions_v3 WHEN NEW.node_id='${f.node}' BEGIN UPDATE admin_accounts SET auth_version=auth_version+1 WHERE id='synthetic-transition-admin'; END`);
    try{await body(await f.transition(f.intent),409);}finally{await db.exec('DROP TRIGGER transition_test_admin');}
    expect((await f.get('device_scope_transitions_v3')).results).toHaveLength(0);expect((await f.get('placement_closures')).results).toHaveLength(0);
  });
  it('reports an expired assigned transition and blocks new ACK while preserving its Ready receipt',async()=>{
    const f=await prepare(),receipt=await cutover(f),next=(await body(await f.config())).config.policy;
    // Move only this isolated test fixture into historical time. Production
    // intent immutability is restored before exercising HTTP behavior.
    await db.exec('DROP TRIGGER device_scope_transitions_v3_immutable_update');
    try{await db.prepare('UPDATE device_scope_transitions_v3 SET created_at_ms=created_at_ms-600000,expires_at_ms=expires_at_ms-600000 WHERE id=?').bind(f.intent.request_id).run();}
    finally{await db.exec("CREATE TRIGGER device_scope_transitions_v3_immutable_update BEFORE UPDATE ON device_scope_transitions_v3 BEGIN SELECT RAISE(ABORT,'v3_immutable'); END");}
    expect((await body(await f.transition())).transition).toMatchObject({state:'expired',startup_grant_migrated:false});
    await body(await f.device('/config/ack',await v3Ack(next,2)),409);
    expect((await body(await f.grant())).startup_grant).toMatchObject({revision:2,enabled:0});
    expect(await body(await f.device('/lease',f.ready,{'X-Receipt-Only':'1'}))).toEqual(receipt);
  });
  it('preserves original old-scope status custody and bytes after cutover',async()=>{
    const f=await prepare(),frozen=await freezeDeviceConfigV3(f.policy),time=Date.now();
    const old={p:3,z:'statistics/1',b:crypto.randomUUID(),n:f.node,o:f.caps.boot_id,c:f.policy.policy_id,h:frozen.policy_sha256,g:1,d:'controlled_test',k:'node_status',
      x:[{q:1,t:[1500,time,1,0],u:1500,s:'running',r:[100000,90000,50000,null,4000],j:[1,512,0,0,1,512],l:[0,0,0,0,0,0]}]};
    const bytes=JSON.stringify(old),headers={'X-Body-SHA256':await sha256(new TextEncoder().encode(bytes))};
    f.ready.observation_upper_ms=time;await cutover(f);
    const receipt=await body(await request('/api/v3/statistics/ingest',bytes,f.token,false,headers));
    expect(receipt).toMatchObject({durability:'committed',accepted_count:1});
    expect(await body(await request('/api/v3/statistics/ingest',bytes,f.token,false,headers))).toEqual(receipt);
    expect((await f.get('statistics_batches_v3')).results[0]).toMatchObject({generation:1,body_sha256:headers['X-Body-SHA256']});
    expect((await f.get('device_assignments_v3')).results[0].placement_id).toBe(f.placement);
  });
});
