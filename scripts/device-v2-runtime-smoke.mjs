// Ephemeral local workerd + real D1/R2. Never deploys or reads production secrets.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fixture=name=>JSON.parse(readFileSync(`docs/specs/examples/${name}.json`,'utf8'));
export async function runDeviceV2RuntimeSmoke({fixtureDir}={}) {
 const source=await build({entryPoints:['worker/index.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*']});
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'device-v2-smoke',modules:true,script:source.outputFiles[0].text,
  compatibilityDate:'2026-10-23',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['RAW_BUCKET'],
  bindings:{RESEARCH_TOKEN:'synthetic-runtime-v2-research-token',OPERATOR_TOKEN:'synthetic-runtime-v2-operator-token'}}]}));
 const loadBytes=name=>readFileSync(fixtureDir?resolve(fixtureDir,`${name}.json`):`docs/specs/examples/${name}.json`);
 const load=name=>JSON.parse(loadBytes(name).toString('utf8'));
 const token='synthetic-runtime-v2-device-token';
 const call=(path,body,auth=token)=>mf.dispatchFetch(`https://runtime.test${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${auth}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const result=async(response,status=200)=>{const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));return body;};
 const upload=(value,version=2,exactBytes)=>{const body=exactBytes??JSON.stringify(value);return mf.dispatchFetch(`https://runtime.test/api/v${version}/ingest`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Body-SHA256':hash(body)},body});};
 try {
  const db=await mf.getD1Database('DB');
  for(const name of readdirSync('migrations').filter(n=>/^\d+.*\.sql$/.test(n)).sort())await db.exec(readFileSync(`migrations/${name}`,'utf8').replace(/^--.*$/gm,'').replace(/\n/g,' '));
  const config=load('capture-config-v2.fixture');config.accept_until=new Date(Date.now()+86400000).toISOString();
  await db.prepare('INSERT INTO device_nodes(id,credential_sha256) VALUES(?,?)').bind(config.node_id,hash(token)).run();
  await db.prepare('INSERT INTO placements(id,node_id,place_id,valid_from_ms) VALUES(?,?,?,?)').bind(config.placement_id,config.node_id,'library',0).run();
  assert.equal((await result(await call('/api/v2/device/config'))).config,null);
  const windows=load('ble-windows-v2.request'),summaries=load('address-summaries-v2.request');
  const statusSource=fixtureDir&&existsSync(resolve(fixtureDir,'node-status-v2.request.json'))?'provided-fixture':'synthetic-reference';
  const status=statusSource==='synthetic-reference'?fixture('node-status-v2.request'):load('node-status-v2.request');
  // Fallback status remains explicitly synthetic; only provenance is remapped.
  if(statusSource==='synthetic-reference')Object.assign(status,{node_id:config.node_id,placement_id:config.placement_id,capture_config_id:config.capture_config_id,boot_id:windows.boot_id});
  const contact={protocol:'campuspulse/2',boot_id:windows.boot_id,contact_seq:1,firmware_version:'campuspulse-passport-v2',uptime_ms:31000,wifi_state:'connected',capture_state:'unassigned',applied_config_id:null};
  const contacts=await Promise.all([call('/api/v2/device/contact',contact),call('/api/v2/device/contact',contact)]);
  const contactAcks=await Promise.all(contacts.map(r=>result(r)));assert.deepEqual(contactAcks[0],contactAcks[1]);
  const seed=async c=>{
   await db.batch([
    db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)').bind(c.capture_config_id,c.node_id,c.placement_id,c.dataset,JSON.stringify(c),Date.parse(c.accept_until)),
    db.prepare('INSERT INTO config_assignments(node_id,capture_config_id,assigned_at) VALUES(?,?,?)').bind(c.node_id,c.capture_config_id,new Date().toISOString()),
    db.prepare('INSERT INTO device_desired_configs(node_id,capture_config_id,assigned_at) VALUES(?,?,?) ON CONFLICT(node_id) DO UPDATE SET capture_config_id=excluded.capture_config_id').bind(c.node_id,c.capture_config_id,new Date().toISOString()),
   ]);
  };
  await seed(config);assert.equal((await result(await call('/api/v2/device/config'))).config.capture_config_id,config.capture_config_id);
  const activation={capture_config_id:config.capture_config_id,boot_id:windows.boot_id,apply_seq:1,state:'applied'};
  const activations=await Promise.all([call('/api/v2/device/config/ack',activation),call('/api/v2/device/config/ack',activation)]);
  const activationAcks=await Promise.all(activations.map(r=>result(r)));assert.deepEqual(activationAcks[0],activationAcks[1]);
  const frozenInputs=[[windows,loadBytes('ble-windows-v2.request')],[summaries,loadBytes('address-summaries-v2.request')],
   [status,statusSource==='provided-fixture'?loadBytes('node-status-v2.request'):Buffer.from(JSON.stringify(status))]];
  for(const [batch,exactBytes] of frozenInputs) {
   // Exercise the producer's exact persisted bytes, including original whitespace
   // and numeric spelling. Parsing is for assertions only, never the upload body.
   assert.deepEqual(JSON.parse(exactBytes.toString('utf8')),batch);
   const replies=await Promise.all([upload(batch,2,exactBytes),upload(batch,2,exactBytes)]),acks=await Promise.all(replies.map(r=>result(r)));
   assert.deepEqual(acks[0],acks[1]);assert.equal(acks[0].body_sha256,hash(exactBytes));assert.equal(acks[0].accepted_count,batch.items.length);assert.equal(acks[0].durability,'committed');
   await result(await upload({...batch,batch_id:randomUUID()}),409);
   // Identical JSON values with changed bytes must not receive a duplicate ACK.
   await result(await upload(batch,2,Buffer.concat([exactBytes,Buffer.from('\n')])),409);
  }
  const privatePath=`/api/v2/research/batches/${summaries.batch_id}?node_id=${config.node_id}`;
  await result(await call(privatePath),401);
  const research=await result(await call(privatePath,undefined,'synthetic-runtime-v2-research-token'));assert.deepEqual(research.items,summaries.items);
  const publicSummary=await result(await call('/api/v1/places/library/summary'));assert.equal(publicSummary.sensor,null);
  const rawConfig={...config,capture_config_id:'runtime-v2-raw',allowed_streams:[...config.allowed_streams,'ble_reports'],raw_capture:{mode:'sampled',sample_every_n:1,selection:'seq_mod_n_eq_0',max_reports_per_window:1}};
  await seed(rawConfig);
  const raw=fixture('ble-reports.request');Object.assign(raw,{protocol:'campuspulse/2',node_id:config.node_id,placement_id:config.placement_id,capture_config_id:rawConfig.capture_config_id,dataset:config.dataset,boot_id:windows.boot_id,batch_id:randomUUID()});raw.items=raw.items.slice(0,1);
  const raws=await Promise.all([upload(raw),upload(raw)]);assert.deepEqual(await result(raws[0]),await result(raws[1]));
  const extra=structuredClone(raw);extra.batch_id=randomUUID();extra.items[0].seq++;await result(await upload(extra),409);
  const rawRead=await result(await call(`/api/v2/research/batches/${raw.batch_id}?node_id=${config.node_id}`,undefined,'synthetic-runtime-v2-research-token'));assert.deepEqual(rawRead.batch,raw);
  // A new boot invalidates old activation/contact. Receipt retries still work.
  await result(await call('/api/v2/device/contact',{...contact,boot_id:randomUUID(),uptime_ms:1}));
  await result(await call('/api/v2/device/config/ack',{...activation,apply_seq:2}),409);
  await result(await call('/api/v2/device/contact',{...contact,contact_seq:2}),409);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM ingestion_batches_v2').first()).n,4);
  const committed=await db.prepare('SELECT COUNT(*) n FROM ingestion_items_v2').first();
  const report={runtime:'workerd',storage:'real ephemeral D1/R2',default_streams:3,concurrent_retry_checks:6,committed_receipts:4,committed_items:committed.n,
   firmware_upload_bytes:fixtureDir?'literal-files':'literal-reference-files',
   windows_source:fixtureDir?'provided-fixture':'synthetic-reference',summaries_source:fixtureDir?'provided-fixture':'synthetic-reference',status_source:statusSource,
   checks:['unassigned contact','current-boot activation','exact ACK retries','sequence conflict','private summaries','sample budget','R2 integrity','demo isolation','retired boot rejection']};
  console.log(JSON.stringify(report));return report;
 } finally {await mf.dispose();}
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){const flag=process.argv.indexOf('--firmware-fixtures');await runDeviceV2RuntimeSmoke({fixtureDir:flag>=0?process.argv[flag+1]:undefined});}
