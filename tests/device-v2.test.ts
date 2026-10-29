import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/index';
import { sha256 } from '../worker/ingest';
import { expireIngestion } from '../worker/retention';
import { validateCaptureConfigV2, validateEnvelopeV2, type CaptureConfigV2 } from '../worker/device-v2-validation';
import { DEVICE_TOKEN, fixture, setup } from './helpers/ingestion';
let state: Awaited<ReturnType<typeof setup>>;
let config: CaptureConfigV2;
const ORIGIN='https://device-v2.example.test';
const fetchWorker=(path:string,init:RequestInit={})=>worker.fetch(new Request(ORIGIN+path,init),state.env);
const device=(path:string,body?:unknown)=>fetchWorker('/api/v2/device'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${DEVICE_TOKEN}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
async function upload(body:unknown,version=2,token=DEVICE_TOKEN) { const bytes=JSON.stringify(body);return fetchWorker(`/api/v${version}/ingest`,{method:'POST',body:bytes,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Body-SHA256':await sha256(new TextEncoder().encode(bytes))}}); }
async function data(response:Response,status=200):Promise<any>{const value=await response.json();expect(response.status,JSON.stringify(value)).toBe(status);return value;}
function seed(c:CaptureConfigV2){state.db.prepare('INSERT INTO capture_configs(id,node_id,placement_id,dataset,config_json,accept_until_ms) VALUES(?,?,?,?,?,?)').run(c.capture_config_id,c.node_id,c.placement_id,c.dataset,JSON.stringify(c),Date.parse(c.accept_until));state.db.prepare('INSERT INTO config_assignments(node_id,capture_config_id,assigned_at) VALUES(?,?,?)').run(c.node_id,c.capture_config_id,new Date().toISOString());state.db.prepare('INSERT INTO device_desired_configs(node_id,capture_config_id,assigned_at) VALUES(?,?,?) ON CONFLICT(node_id) DO UPDATE SET capture_config_id=excluded.capture_config_id').run(c.node_id,c.capture_config_id,new Date().toISOString());}
function batch(name='address-summaries-v2.request'){const b=fixture(name);b.capture_config_id=config.capture_config_id;return b;}
beforeEach(async()=>{state=await setup();config=fixture('capture-config-v2.fixture');config.accept_until=new Date(Date.now()+86400000).toISOString();seed(config);});
afterEach(()=>{vi.restoreAllMocks();state.db.close();});

describe('device v2 policies and control',()=>{
 it('keeps v1 config semantics explicit and validates bounded v2 capabilities',()=>{
  expect(validateCaptureConfigV2(config)).toEqual(config);
  for(const mutate of [(c:any)=>c.protocol='campuspulse/1',(c:any)=>c.summary.max_addresses=129,(c:any)=>c.summary.bin_ms=7000,(c:any)=>c.raw_capture={mode:'all'},(c:any)=>c.allowed_streams.push('ble_reports'),(c:any)=>c.identity_scheme='none']){const c=structuredClone(config);mutate(c);expect(()=>validateCaptureConfigV2(c)).toThrow();}
 });
 it('retrieves only assigned v2 policies and authenticates unassigned contact',async()=>{
  expect((await data(await device('/config'))).config.protocol).toBe('campuspulse/2');
  state.db.prepare('DELETE FROM device_desired_configs WHERE node_id=?').run(config.node_id);
  expect(await data(await device('/config'))).toMatchObject({config:null,reason:'unassigned',expired:false});
  expect((await data(await device('/contact',fixture('device-contact-v2.request')))).contact_seq).toBe(1);
  expect((await fetchWorker('/api/v2/device/config')).status).toBe(401);
  expect((await device('/config?capture_config_id=demo-capture-raw-v1')).status).toBe(200);
 });
 it('requires current boot activation and preserves exact retry ACKs',async()=>{
  const c=fixture('device-contact-v2.request'),a=fixture('device-activation-v2.request');
  await data(await device('/config/ack',a),409);
  const first=await data(await device('/contact',c));
  expect(await data(await device('/contact',c))).toEqual(first);
  await data(await device('/contact',{...c,wifi_state:'retry'}),409);
  const applied=await data(await device('/config/ack',a));
  expect(await data(await device('/config/ack',a))).toEqual(applied);
  await data(await device('/config/ack',{...a,state:'failed'}),409);
  await data(await device('/config/ack',{...a,apply_seq:2,state:'failed',message:'scan_init_failed'}));
  expect(state.db.prepare('SELECT applied_config_id FROM device_control_v2').get()).toMatchObject({applied_config_id:config.capture_config_id});
  await data(await device('/config/ack',a),409);
  const newer={...c,boot_id:'26000000-0000-4000-8000-000000000002',uptime_ms:1};
  await data(await device('/contact',newer));
  expect(state.db.prepare('SELECT applied_config_id,apply_seq FROM device_control_v2').get()).toMatchObject({applied_config_id:null,apply_seq:0});
  await data(await device('/contact',{...c,contact_seq:20}),409);
  await data(await device('/config/ack',{...a,apply_seq:3}),409);
 });
 it('keeps transient control storage failures retryable with the existing state intact',async()=>{
  const c=fixture('device-contact-v2.request'),a=fixture('device-activation-v2.request');await data(await device('/contact',c));
  const original=state.env.DB.batch;state.env.DB.batch=async()=>{throw new Error('synthetic transient D1 outage');};
  expect(await data(await device('/contact',{...c,contact_seq:2}),503)).toMatchObject({error:{code:'storage_unavailable',retryable:true}});
  expect(await data(await device('/contact',{...c,boot_id:crypto.randomUUID()}),503)).toMatchObject({error:{code:'storage_unavailable',retryable:true}});
  expect(await data(await device('/config/ack',a),503)).toMatchObject({error:{code:'storage_unavailable',retryable:true}});
  state.env.DB.batch=original;await data(await device('/contact',{...c,contact_seq:2}));await data(await device('/config/ack',a));
  expect(state.db.prepare('SELECT contact_seq,apply_seq FROM device_control_v2').get()).toMatchObject({contact_seq:2,apply_seq:1});
 });
 it('rejects lower monotonic contact or uptime but accepts new progress',async()=>{
  const c=fixture('device-contact-v2.request');await data(await device('/contact',c));
  await data(await device('/contact',{...c,contact_seq:2,uptime_ms:0}),409);
  await data(await device('/contact',{...c,contact_seq:2,uptime_ms:40000}));
  await data(await device('/contact',c),409);
 });
});

describe('private v2 ingestion and durable receipts',()=>{
 it('rejects an inclusive partial-window end atomically and accepts a valid exclusive end',async()=>{
  // Synthetic regression for a retained historical nine-item batch. No field
  // identifiers or captured payloads belong in this fixture.
  const rejected=batch(), item=rejected.items[0];
  Object.assign(item,{duration_ms:1970,first_offset_ms:10,last_offset_ms:1969,bins:[item.reports]});
  rejected.items=Array.from({length:9},(_,n)=>({...structuredClone(item),seq:n+1,address:`02:00:00:00:00:${(n+1).toString(16).padStart(2,'0')}`}));
  rejected.items[0].last_offset_ms=1970;
  const original=JSON.stringify(rejected);
  const error=await data(await upload(rejected),422);
  expect(error).toEqual({error:{code:'invalid_device_v2',message:'Invalid field: items[0].last_offset_ms.',retryable:false}});
  expect(state.db.prepare('SELECT COUNT(*) n FROM ingestion_batches_v2').get()?.n).toBe(0);
  expect(state.db.prepare('SELECT COUNT(*) n FROM ingestion_items_v2').get()?.n).toBe(0);
  expect(JSON.stringify(rejected)).toBe(original);
  // This independent synthetic window shows the required producer boundary;
  // it is not a repair or reserialization of immutable queued data.
  const valid=structuredClone(rejected);valid.batch_id=crypto.randomUUID();
  for(const summary of valid.items)summary.duration_ms=1971;
  const ack=await data(await upload(valid));
  expect(ack).toMatchObject({stream:'address_summaries',accepted_count:9,durability:'committed'});
  expect(await data(await upload(valid))).toEqual(ack);
 });
 it.each([1000,1488,1880,4999,5000,30000])('commits a %i ms partial summary with its configured 5s bins',async duration=>{
  const b=batch(), item=b.items[0];
  item.duration_ms=duration;item.first_offset_ms=0;item.last_offset_ms=duration-1;
  item.bins=Array(Math.ceil(duration/item.bin_ms)).fill(0);item.bins[0]=item.reports;
  if(item.bins.length>1){item.bins[0]=1;item.bins[item.bins.length-1]=item.reports-1;}
  const wrong=structuredClone(b);wrong.batch_id=crypto.randomUUID();wrong.items[0].bin_ms=6000;
  if(duration<5000)expect((await upload(wrong)).status).toBe(422);
  const ack=await data(await upload(b));expect(ack).toMatchObject({stream:'address_summaries',accepted_count:1,durability:'committed'});
  expect(await data(await upload(b))).toEqual(ack);
  const stored=state.db.prepare("SELECT item_json FROM ingestion_items_v2 WHERE stream='address_summaries'").get();
  expect(JSON.parse(String(stored?.item_json))).toMatchObject({duration_ms:duration,bin_ms:5000,bins:item.bins});
 });
 it('commits all default streams and preserves exact retries after expiry',async()=>{
  for(const name of ['address-summaries-v2.request','ble-windows-v2.request','node-status-v2.request']){
   const b=batch(name),ack=await data(await upload(b));expect(ack).toMatchObject({stream:b.stream,accepted_count:b.items.length,durability:'committed'});
   expect(await data(await upload(b))).toEqual(ack);
  }
  expect(state.db.prepare('SELECT COUNT(*) n FROM ingestion_items_v2').get()?.n).toBe(3);
  const b=batch(),ack=await data(await upload(b));
  const later=Date.now()+2*86400000;vi.spyOn(Date,'now').mockReturnValue(later);await expireIngestion(state.env,later);
  expect(state.db.prepare("SELECT COUNT(*) n FROM ingestion_items_v2 WHERE stream='address_summaries'").get()?.n).toBe(0);
  expect(await data(await upload(b))).toEqual(ack);
  const altered=structuredClone(b);altered.items[0].rssi.mean_dbm=-69;await data(await upload(altered),409);
  b.batch_id=crypto.randomUUID();b.items[0].seq=2;await data(await upload(b),410);
 });
 it('fails atomically for malformed counts, node spoofing, duplicate identities and interval overlap',async()=>{
  const b=batch();const bad=structuredClone(b);bad.items[0].bins=[0,0,0,0,0,0];expect(()=>validateEnvelopeV2(bad)).toThrow();await data(await upload(bad),422);
  const spoof={...b,node_id:'another-node'};await data(await upload(spoof),403);
  const ack=await data(await upload(b));expect(ack.accepted_count).toBe(1);
  await data(await upload({...b,batch_id:crypto.randomUUID()}),409);
  const duplicate=structuredClone(b);duplicate.batch_id=crypto.randomUUID();duplicate.items[0].seq=2;await data(await upload(duplicate),409);
  expect(state.db.prepare('SELECT COUNT(*) n FROM ingestion_batches_v2').get()?.n).toBe(1);
 });
 it('enforces address budget across batches and preserves one receipt per exact body',async()=>{
  const tiny={...config,capture_config_id:'tiny-v2',summary:{...config.summary,max_addresses:1}};seed(tiny);config=tiny;
  const b=batch();await data(await upload(b));const next=structuredClone(b);next.batch_id=crypto.randomUUID();next.items[0].seq=2;next.items[0].address='02:00:00:00:00:02';await data(await upload(next),409);
  expect(state.db.prepare('SELECT COUNT(*) n FROM ingestion_batches_v2').get()?.n).toBe(1);
 });
 it('keeps address summaries private and excludes demo and unknown clocks publicly',async()=>{
  const b=batch();await data(await upload(b));
  const url=`/api/v2/research/batches/${b.batch_id}?node_id=${b.node_id}`;
  await data(await fetchWorker(url),401);await data(await fetchWorker(url,{headers:{Authorization:`Bearer ${DEVICE_TOKEN}`}}),401);
  const research=await data(await fetchWorker(url,{headers:{Authorization:`Bearer ${state.env.RESEARCH_TOKEN}`}}));expect(research.items[0].address).toBe('02:00:00:00:00:01');
  const w=batch('ble-windows-v2.request');await data(await upload(w));
  const response=await fetchWorker('/api/v1/places/library/summary');const text=await response.text();expect(text).not.toContain('02:00:00:00:00:01');expect(text).not.toContain('cp-demo-01');
 });
 it('publishes only overall field windows and retains no address in the public projection',async()=>{
  config={...config,capture_config_id:'field-v2',dataset:'field'};seed(config);
  const w=batch('ble-windows-v2.request');w.dataset='field';w.items[0].time.utc_ms=Date.now()-1000;w.items[0].time.uncertainty_ms=20;
  await data(await upload(w));
  const summary=batch();summary.dataset='field';summary.items[0].time=w.items[0].time;await data(await upload(summary));
  const visible=await data(await fetchWorker('/api/v1/places/library/summary'));expect(visible.sensor).toMatchObject({node_id:config.node_id,visible_identifiers:1});
  expect(JSON.stringify(visible)).not.toContain('02:00:00:00:00:01');expect(JSON.stringify(visible)).not.toContain('address_summaries');
  const unknown=structuredClone(w);unknown.batch_id=crypto.randomUUID();unknown.boot_id=crypto.randomUUID();unknown.items[0].time.utc_ms=null;unknown.items[0].time.uncertainty_ms=null;await data(await upload(unknown));
  const history=await data(await fetchWorker('/api/v1/places/library/history'));expect(history.sensor_windows).toHaveLength(1);
 });
 it('does not reset a per-window private budget when evidence rows expire',async()=>{
  config={...config,capture_config_id:'long-v2',accept_until:new Date(Date.now()+10*86400000).toISOString()};seed(config);
  const original=batch();await data(await upload(original));
  const later=Date.now()+2*86400000;vi.spyOn(Date,'now').mockReturnValue(later);await expireIngestion(state.env,later);
  expect(state.db.prepare('SELECT COUNT(*) n FROM ingestion_window_budgets_v2').get()?.n).toBe(1);
  const next=structuredClone(original);next.batch_id=crypto.randomUUID();next.items[0].seq=2;next.items[0].address='02:00:00:00:00:02';await data(await upload(next),409);
  await data(await upload(original));
 });
 it('enforces raw-off and a transactional sampled raw budget with private R2',async()=>{
  const raw=fixture('ble-reports.request');raw.protocol='campuspulse/2';raw.capture_config_id=config.capture_config_id;await data(await upload(raw),422);
  config={...config,capture_config_id:'sampled-v2',allowed_streams:[...config.allowed_streams,'ble_reports'],raw_capture:{mode:'sampled',sample_every_n:1,selection:'seq_mod_n_eq_0',max_reports_per_window:1}};seed(config);
  raw.capture_config_id=config.capture_config_id;raw.items=raw.items.slice(0,1);await data(await upload(raw));expect(state.raw.objects.size).toBe(1);
  const extra=structuredClone(raw);extra.batch_id=crypto.randomUUID();extra.items[0].seq++;await data(await upload(extra),409);
  expect(state.db.prepare("SELECT COUNT(*) n FROM ingestion_batches_v2 WHERE stream='ble_reports'").get()?.n).toBe(1);
  const research=await data(await fetchWorker(`/api/v2/research/batches/${raw.batch_id}?node_id=${raw.node_id}`,{headers:{Authorization:`Bearer ${state.env.RESEARCH_TOKEN}`}}));expect(research.batch).toEqual(raw);
 });
 it('rejects a new raw commit if R2 archival crosses the acceptance cutoff',async()=>{
  const started=Date.now();config={...config,capture_config_id:'near-expiry-v2',accept_until:new Date(started+1000).toISOString(),allowed_streams:[...config.allowed_streams,'ble_reports'],raw_capture:{mode:'sampled',sample_every_n:1,selection:'seq_mod_n_eq_0',max_reports_per_window:4}};seed(config);
  const raw=fixture('ble-reports.request');raw.protocol='campuspulse/2';raw.capture_config_id=config.capture_config_id;raw.items=raw.items.slice(0,1);
  const originalPut=state.env.RAW_BUCKET!.put.bind(state.env.RAW_BUCKET!);vi.spyOn(state.env.RAW_BUCKET!,'put').mockImplementation(async(...args:Parameters<R2Bucket['put']>)=>{const stored=await originalPut(...args);vi.spyOn(Date,'now').mockReturnValue(started+2000);return stored;});
  expect(await data(await upload(raw),410)).toMatchObject({error:{code:'capture_config_expired',retryable:false}});
  expect(state.db.prepare('SELECT COUNT(*) n FROM ingestion_batches_v2').get()?.n).toBe(0);
  expect(state.db.prepare('SELECT COUNT(*) n FROM ingestion_items_v2').get()?.n).toBe(0);
  expect(state.raw.objects.size).toBe(1); // Unreferenced evidence awaits the separate orphan audit.
 });
 it('rejects v1/v2 cross-version receipt IDs and sequence intervals in both directions',async()=>{
  const v1=fixture('ble-windows.request');await data(await upload(v1,1));
  const v2=batch('ble-windows-v2.request');await data(await upload(v2),409);v2.batch_id=crypto.randomUUID();await data(await upload(v2),409);
  v2.boot_id=crypto.randomUUID();await data(await upload(v2));
  v1.boot_id=v2.boot_id;v1.batch_id=crypto.randomUUID();await data(await upload(v1,1),409);
 });
 it('preserves optional accounting loss counters and rejects invalid or unknown values',async()=>{
  const b=batch('node-status-v2.request');Object.assign(b.items[0].loss_totals,{address_summaries_dropped:2,address_table_overflow_reports:9,accounting_overrun_reports:3,unpersisted_window_reports:17});
  await data(await upload(b));
  const stored=state.db.prepare("SELECT item_json FROM ingestion_items_v2 WHERE stream='node_status'").get();
  expect(JSON.parse(String(stored?.item_json)).loss_totals).toMatchObject({address_summaries_dropped:2,address_table_overflow_reports:9,accounting_overrun_reports:3,unpersisted_window_reports:17});
  for(const key of ['accounting_overrun_reports','unpersisted_window_reports'])for(const value of [-1,0.5,null]){const bad=structuredClone(b);bad.items[0].loss_totals[key]=value;expect(()=>validateEnvelopeV2(bad)).toThrow();}
  const unknown=structuredClone(b);unknown.items[0].loss_totals.made_up_loss=1;expect(()=>validateEnvelopeV2(unknown)).toThrow();
 });
 it('does not ACK when storage fails and keeps duplicate-key parsing strict',async()=>{
  const b=batch();const original=state.env.DB.batch;state.env.DB.batch=async()=>{throw new Error('synthetic storage failure');};await data(await upload(b),503);state.env.DB.batch=original;
  expect(state.db.prepare('SELECT COUNT(*) n FROM ingestion_batches_v2').get()?.n).toBe(0);
  const body=JSON.stringify(b).replace('"protocol":"campuspulse/2"','"protocol":"campuspulse/2","protocol":"campuspulse/2"');
  await data(await fetchWorker('/api/v2/ingest',{method:'POST',body,headers:{Authorization:`Bearer ${DEVICE_TOKEN}`,'Content-Type':'application/json','X-Body-SHA256':await sha256(new TextEncoder().encode(body))}}),400);
 });
});
