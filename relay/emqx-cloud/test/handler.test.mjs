import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {handleWebhook, handleBrokerEvent} from '../handler.mjs';
import {RpcGuard, RpcGuardError} from '../rpc-guard.mjs';
const namespace='synthetic_mqtt';const node='registered_factory_node';
const boot='11111111-1111-4111-8111-111111111111';const key='k'.repeat(43);
const bytes=value=>new TextEncoder().encode(value);
const frame=(subop,body=subop===2?'':'{}',flags=0)=>Buffer.concat([Buffer.from([67,80,86,51,1,subop,flags,0]),Buffer.from(body)]);
function event(op='ingest',body=frame(2),changes={}) {
  return {username:'synthetic_user',topic:`cp/v1/${namespace}/${boot}/req/${op}/1`,
    qos:1,retain:false,published_at_ms:Date.now(),payload_b64:Buffer.from(body).toString('base64'),...changes};
}
function setup(upstream=()=>({status:200,body:bytes('{"synthetic":true}')})) {
  const calls=[];const replies=[];const checks=[];
  const env={WEBHOOK_KEY:key,BROKER_HOST:'broker.example.invalid',MQTT_USERNAME:'synthetic_relay',MQTT_PASSWORD:'synthetic_mqtt_password',
    INGEST_SERVICE:{
      authorize:async input=>{checks.push(input);return input.username==='synthetic_user'&&input.namespace===namespace?{node_id:node}:null;},
      dispatch:async input=>{calls.push(input);return upstream(input);},
    }};
  const publish=async options=>{replies.push(options);return {acknowledged:true};};
  return {env,calls,replies,checks,publish};
}
function request(value=event(),headers={}) {
  return new Request('https://worker.example.invalid/emqx',{method:'POST',
    headers:{'X-CP-Webhook-Key':key,'Content-Type':'application/json',...headers},body:JSON.stringify(value)});
}
const run=(s,value=event(),headers={})=>handleWebhook(request(value,headers),s.env,s.publish);
const decode=reply=>({status:reply.payload[0]*256+reply.payload[1],body:Buffer.from(reply.payload.slice(2)).toString()});
test('dynamic authorized namespace resolves factory node without a device-token map',async()=>{
  const original=' {"lease":"synthetic", "unicode":"测试"}\n';const s=setup(()=>({status:200,body:bytes(original)}));
  assert.equal((await run(s)).status,204);
  assert.deepEqual(s.calls[0],{username:'synthetic_user',namespace,boot,op:'ingest',rpc:1,body:new Uint8Array(),v3:{subop:2,receiptOnly:false}});
  assert.equal('DEVICE_MAP' in s.env,false);assert.equal('token' in s.calls[0],false);
  assert.deepEqual(decode(s.replies[0]),{status:200,body:original});assert.match(s.replies[0].topic,/\/rep\/ingest\/1$/);
  assert.equal((await run(s)).status,204);assert.equal(s.calls.length,2);
});
test('frozen old-boot ingest bytes reach private API unchanged',async()=>{
  const body=` {"node_id":"${node}", "boot_id":"22222222-2222-4222-8222-222222222222", "data":"测试"}\n`;
  const s=setup(()=>({status:201,body:bytes(' {"receipt":"synthetic"}\n')}));
  assert.equal((await run(s,event('ingest',frame(5,body)))).status,204);assert.equal(Buffer.from(s.calls[0].body).toString(),body);
  assert.equal(s.calls[0].namespace,namespace);assert.equal(decode(s.replies[0]).status,201);
});
for(const op of ['contact','config','activation'])test(`legacy ${op} topics are retired before authorization`,async()=>{
  const s=setup();assert.equal((await run(s,event(op,'{}'))).status,400);
  assert.equal(s.calls.length,0);assert.equal(s.checks.length,0);assert.equal(s.replies.length,0);
});
test('unframed legacy ingest is retired before registry or storage',async()=>{
  const s=setup();assert.equal((await run(s,event('ingest','{"protocol":"campuspulse/2"}'))).status,400);
  assert.equal(s.calls.length,0);assert.equal(s.checks.length,0);assert.equal(s.replies.length,0);
});
for(const status of [401,403,409,422,500,503,302])test(`private API ${status} stays exact status/body`,async()=>{
  const body='{"error":"synthetic_'+status+'"}';const s=setup(()=>({status,body:bytes(body)}));
  assert.equal((await run(s)).status,204);assert.deepEqual(decode(s.replies[0]),{status,body});
});
for(const headers of [{'X-CP-Webhook-Key':'wrong'},{'X-CP-Webhook-Key':''},{'Content-Type':'text/plain'},
  {'Content-Encoding':'gzip'},{'Content-Length':'12289'}])test(`invalid HTTP envelope ${Object.keys(headers)} cannot allocate DO`,async()=>{
  const s=setup();assert.ok((await run(s,event(),headers)).status>=400);
  assert.equal(s.calls.length,0);assert.equal(s.replies.length,0);assert.equal(s.checks.length,0);
});
for(const changes of [{username:'another_user'},{username:'invalid\nuser'},
  {topic:`cp/v1/other/${boot}/req/config/1`},{qos:0},{retain:true},{extra:'bad'},
  {payload_b64:'AB=='},{payload_b64:'AA'},{topic:`cp/v1/${namespace}/${boot}/req/config/4294967296`},
  {topic:`cp/v1/${namespace}/${boot}/req/config/01`},{topic:`cp/v1/${namespace}/${boot}/req/config/1/extra`},
  {payload_b64:Buffer.from('not empty').toString('base64')}])test(`invalid broker event ${JSON.stringify(changes)}`,async()=>{
  const s=setup();assert.ok((await run(s,event('config','',changes))).status>=400);assert.equal(s.calls.length,0);assert.equal(s.replies.length,0);
});
test('streaming event bound applies before registry authorization',async()=>{
  const s=setup();const req=new Request('https://worker.example.invalid/emqx',{method:'POST',duplex:'half',
    headers:{'Content-Type':'application/json','X-CP-Webhook-Key':key},
    body:new ReadableStream({start(c){c.enqueue(new Uint8Array(12289));c.close();}})});
  assert.equal((await handleWebhook(req,s.env,s.publish)).status,413);assert.equal(s.checks.length,0);
});
test('8192-byte ingest stays exact and8193 is rejected',async()=>{
  for(const size of [8192,8193]){
    const prefix=`{"node_id":"${node}","padding":"`;const body=prefix+'x'.repeat(size-Buffer.byteLength(prefix)-2)+'"}';
    const s=setup();assert.equal(Buffer.byteLength(body),size);assert.equal((await run(s,event('ingest',frame(5,body)))).status,size===8192?204:400);
    assert.equal(s.calls.length,size===8192?1:0);
  }
});
for(const variant of ['throw','overflow','wrong_type','invalid_status'])test(`uncertain private API ${variant} never fabricates custody`,async()=>{
  const s=setup(()=>{if(variant==='throw')throw new Error('private exception');
    if(variant==='overflow')return {status:200,body:new Uint8Array(8193)};
    if(variant==='wrong_type')return {status:200,body:'incorrect type'};
    return {status:999,body:new Uint8Array()};});
  assert.equal((await run(s)).status,204);assert.deepEqual(decode(s.replies[0]),{status:504,body:'{"error":"gateway_outcome_unknown"}'});
});
test('failed response publication remains retryable',async()=>{
  const s=setup();s.publish=async()=>{throw new Error('private MQTT exception');};assert.equal((await run(s)).status,503);assert.equal(s.calls.length,1);
});
test('public DO routing uses resolved factory identity rather than namespace',async()=>{
  const s=setup();const value=event();let seen;const result=await handleWebhook(request(value),s.env,undefined,async(nodeId,data)=>{
    seen={nodeId,event:JSON.parse(Buffer.from(data).toString())};return 503;});
  assert.equal(result.status,503);assert.deepEqual(seen,{nodeId:node,event:value});assert.equal(s.calls.length,0);
});
test('registry revocation is rechecked after routing before forward',async()=>{
  const s=setup();let routed=false;const result=await handleWebhook(request(),s.env,undefined,async(_node,data)=>{
    routed=true;s.env.INGEST_SERVICE.authorize=async()=>null;return handleBrokerEvent(data,s.env,s.publish);});
  assert.equal(routed,true);assert.equal(result.status,403);assert.equal(s.calls.length,0);assert.equal(s.replies.length,0);
});
test('guard sees canonical identity and exact digest without credentials',async()=>{
  const s=setup();let guard;const result=await handleBrokerEvent(bytes(JSON.stringify(event())),s.env,s.publish,async rpc=>{guard=rpc;return 409;});
  assert.equal(result,409);assert.deepEqual({...guard,publishedAtMs:undefined},{node,boot,op:'ingest',rpc:1,digest:createHash('sha256').update(frame(2)).digest('hex'),bytes:8,v3:{subop:2,receiptOnly:false},publishedAtMs:undefined});
  assert.ok(Math.abs(Date.now()-guard.publishedAtMs)<1000);
  assert.equal(s.calls.length,0);
});
test('health/method/path do not contact registry or broker',async()=>{
  const s=setup();for(const [path,method,status] of [['/health','GET',204],['/emqx','GET',405],['/emqx?x=1','POST',404],['/','GET',404]])
    assert.equal((await handleWebhook(new Request('https://worker.example.invalid'+path,{method}),s.env,s.publish)).status,status);
  assert.equal(s.checks.length,0);assert.equal(s.calls.length,0);assert.equal(s.replies.length,0);
});

for(const subop of [1,2,3,4,5])test(`CPV3 subop${subop} unwraps exact bytes on existing ingest topic`,async()=>{
  const original=subop===2?'':' {"synthetic":"测试", "boot_id":"old-frozen-body"}\n';
  const s=setup();const wire=frame(subop,original);
  assert.equal((await run(s,event('ingest',wire))).status,204);
  assert.deepEqual(s.calls[0],{username:'synthetic_user',namespace,boot,op:'ingest',rpc:1,
    body:bytes(original),v3:{subop,receiptOnly:false}});
  assert.match(s.replies[0].topic,/\/rep\/ingest\/1$/);
});

for(const subop of [3,4])test(`CPV3 receipt-only flag forwards for subop${subop}`,async()=>{
  const s=setup();assert.equal((await run(s,event('ingest',frame(subop,'{}',1)))).status,204);
  assert.deepEqual(s.calls[0].v3,{subop,receiptOnly:true});
});

test('CPV3 malformed framing/flags/JSON is rejected before registry authorization',async()=>{
  const modified=(index,value)=>{const out=frame(1);out[index]=value;return out;};
  const invalid=[...Array.from({length:8},(_,size)=>frame(1).subarray(0,size)),
    modified(0,0),modified(4,0),modified(4,2),modified(5,0),modified(5,6),modified(5,255),
    modified(7,1),modified(6,2),modified(6,255),
    ...[1,2,5].map(op=>frame(op,op===2?'':'{}',1)),
    frame(2,'{}'),frame(2,' '),frame(1,''),frame(3,'[]'),frame(4,'null'),frame(5,'true'),
    frame(1,'{"broken":'),frame(1,Buffer.from([0xff])),frame(1,Buffer.from([0xef,0xbb,0xbf,123,125]))];
  for(const wire of invalid){
    const s=setup();assert.equal((await run(s,event('ingest',wire))).status,400);
    assert.equal(s.checks.length,0);assert.equal(s.calls.length,0);assert.equal(s.replies.length,0);
  }
  for(const op of ['contact','config','activation']){
    const s=setup();assert.equal((await run(s,event(op,frame(2)))).status,400);assert.equal(s.checks.length,0);
  }
});

test('CPV3 original body cap8192 permits wire8200 without increasing legacy cap',async()=>{
  for(const size of [8192,8193]){
    const original='{"padding":"'+'x'.repeat(size-14)+'"}';
    assert.equal(Buffer.byteLength(original),size);
    const s=setup();const wire=frame(5,original);
    assert.equal(wire.length,size+8);
    assert.equal((await run(s,event('ingest',wire))).status,size===8192?204:400);
    if(size===8192)assert.deepEqual(s.calls[0].body,bytes(original));
    else assert.equal(s.checks.length,0);
  }
});

test('only CPV3 config enables8192-byte replies, including unchanged error bodies',async()=>{
  for(const [subop,size,status,expected] of [[2,8192,200,200],[2,8192,422,422],
    [2,8193,200,504],[1,2048,200,200],[1,2049,200,504],[5,8192,200,504]]){
    const original='x'.repeat(size);const s=setup(()=>({status,body:bytes(original)}));
    assert.equal((await run(s,event('ingest',frame(subop)))).status,204);
    assert.equal(decode(s.replies[0]).status,expected);
    assert.equal(s.replies[0].maxPayloadBytes,subop===2?8194:undefined);
    if(expected!==504)assert.equal(decode(s.replies[0]).body,original);
    else assert.equal(decode(s.replies[0]).body,'{"error":"gateway_outcome_unknown"}');
  }
});

test('CPV3 wire digest/byte charge includes header and detects operation/flag conflicts',async()=>{
  const values=new Map();const guard=new RpcGuard({transaction:async work=>work({
    get:async key=>structuredClone(values.get(key)),put:async(key,value)=>{values.set(key,structuredClone(value));},
  })});
  const seen=[];const reserve=async input=>{seen.push(input);try{await guard.begin(input);}
    catch(error){if(error instanceof RpcGuardError)return error.status;throw error;}};
  const s=setup();const wire=frame(3,' {"synthetic":true}\n');
  const deliver=body=>handleBrokerEvent(bytes(JSON.stringify(event('ingest',body))),s.env,s.publish,reserve);
  assert.equal(await deliver(wire),204);assert.equal(await deliver(wire),204);
  assert.equal(await deliver(frame(4,' {"synthetic":true}\n')),409);
  assert.equal(await deliver(frame(3,' {"synthetic":true}\n',1)),409);
  assert.equal(await deliver(frame(3,'{"synthetic":true}')),409);
  assert.equal(s.calls.length,2);assert.equal(s.replies.length,2);
  assert.equal(seen[0].digest,createHash('sha256').update(wire).digest('hex'));
  assert.equal(seen[0].bytes,wire.length);
  assert.equal([...values.values()][0].rate.bytes,seen.reduce((sum,row)=>sum+row.bytes,0));
  const persisted=JSON.stringify([...values.values()]);
  assert.equal(persisted.includes('synthetic'),false);assert.equal(persisted.includes('receiptOnly'),false);
});

test('CPV3 exact retry reaches service again after unknown outcome or failed publish',async()=>{
  const wire=frame(5);let attempt=0;const s=setup(()=>{
    if(++attempt===1)throw new Error('synthetic');return {status:201,body:bytes('{"receipt":"synthetic"}')};});
  assert.equal((await run(s,event('ingest',wire))).status,204);assert.equal(decode(s.replies[0]).status,504);
  const publish=s.publish;s.publish=async()=>{throw new Error('synthetic');};
  assert.equal((await run(s,event('ingest',wire))).status,503);
  s.publish=publish;assert.equal((await run(s,event('ingest',wire))).status,204);
  assert.equal(s.calls.length,3);assert.equal(decode(s.replies[1]).status,201);
});
