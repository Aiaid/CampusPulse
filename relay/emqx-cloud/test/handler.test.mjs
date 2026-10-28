import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {handleWebhook, handleBrokerEvent} from '../handler.mjs';
const namespace='synthetic_mqtt';const node='registered_factory_node';
const boot='11111111-1111-4111-8111-111111111111';const key='k'.repeat(43);
const bytes=value=>new TextEncoder().encode(value);
function event(op='config',body='',changes={}) {
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
  assert.deepEqual(s.calls[0],{username:'synthetic_user',namespace,boot,op:'config',rpc:1,body:new Uint8Array()});
  assert.equal('DEVICE_MAP' in s.env,false);assert.equal('token' in s.calls[0],false);
  assert.deepEqual(decode(s.replies[0]),{status:200,body:original});assert.match(s.replies[0].topic,/\/rep\/config\/1$/);
  assert.equal((await run(s)).status,204);assert.equal(s.calls.length,2);
});
test('frozen old-boot ingest bytes reach private API unchanged',async()=>{
  const body=` {"node_id":"${node}", "boot_id":"22222222-2222-4222-8222-222222222222", "data":"测试"}\n`;
  const s=setup(()=>({status:201,body:bytes(' {"receipt":"synthetic"}\n')}));
  assert.equal((await run(s,event('ingest',body))).status,204);assert.equal(Buffer.from(s.calls[0].body).toString(),body);
  assert.equal(s.calls[0].namespace,namespace);assert.equal(decode(s.replies[0]).status,201);
});
for(const op of ['contact','activation'])test(`${op} retains current topic boot and fixed operation`,async()=>{
  const s=setup();const body=JSON.stringify({boot_id:boot});assert.equal((await run(s,event(op,body))).status,204);
  assert.equal(s.calls[0].op,op);assert.equal((await run(s,event(op,'{"boot_id":"old"}'))).status,400);assert.equal(s.calls.length,1);
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
    const s=setup();assert.equal(Buffer.byteLength(body),size);assert.equal((await run(s,event('ingest',body))).status,size===8192?204:400);
    assert.equal(s.calls.length,size===8192?1:0);
  }
});
for(const variant of ['throw','overflow','wrong_type','invalid_status'])test(`uncertain private API ${variant} never fabricates custody`,async()=>{
  const s=setup(()=>{if(variant==='throw')throw new Error('private exception');
    if(variant==='overflow')return {status:200,body:new Uint8Array(2049)};
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
  assert.equal(result,409);assert.deepEqual({...guard,publishedAtMs:undefined},{node,boot,op:'config',rpc:1,digest:createHash('sha256').update('').digest('hex'),bytes:0,publishedAtMs:undefined});
  assert.ok(Math.abs(Date.now()-guard.publishedAtMs)<1000);
  assert.equal(s.calls.length,0);
});
test('health/method/path do not contact registry or broker',async()=>{
  const s=setup();for(const [path,method,status] of [['/health','GET',204],['/emqx','GET',405],['/emqx?x=1','POST',404],['/','GET',404]])
    assert.equal((await handleWebhook(new Request('https://worker.example.invalid'+path,{method}),s.env,s.publish)).status,status);
  assert.equal(s.checks.length,0);assert.equal(s.calls.length,0);assert.equal(s.replies.length,0);
});
