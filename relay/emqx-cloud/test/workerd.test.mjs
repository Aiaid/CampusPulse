import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

const require=createRequire(import.meta.url);
const root=fileURLToPath(new URL('../',import.meta.url));
const key='k'.repeat(43);const node='synthetic_mqtt';
const boot='11111111-1111-4111-8111-111111111111';
const base={username:'synthetic_user',qos:1,retain:false,payload_b64:''};
const original=' {"synthetic_receipt":true}\n';

test('real Worker/DO routes authenticate, serialize, persist replay and return exact receipt',async()=>{
  await build({entryPoints:[root+'worker.mjs'],outfile:root+'.wrangler/test-worker.mjs',
    bundle:true,format:'esm',platform:'browser',external:['cloudflare:sockets','cloudflare:workers','node:crypto'],
    plugins:[{name:'synthetic-publisher-only',setup(build){
      build.onResolve({filter:/^\.\/mqtt-publish\.mjs$/},()=>({path:root+'test/publisher-fixture.mjs'}));
    }}]});
  const runtime=require('workerd/package.json').version.match(/\d{8}/)[0];
  const date=`${runtime.slice(0,4)}-${runtime.slice(4,6)}-${runtime.slice(6,8)}`;
  const calls=[];const replies=[];let release;let entered;let wait=false;let replyBody=original;
  const entry=new Promise(resolve=>{entered=resolve;});
  await build({entryPoints:[root+'test/backend-fixture.mjs'],outfile:root+'.wrangler/backend-fixture.mjs',
    bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers']});
  const backend=async req=>{
    calls.push({url:req.url,body:await req.text(),receiptOnly:req.headers.get('X-Synthetic-Receipt-Only')});
    if(wait){entered();await new Promise(resolve=>{release=resolve;});}
    return new Response(replyBody);
  };
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{
    name:'emqx-test',modules:true,scriptPath:root+'.wrangler/test-worker.mjs',
    compatibilityDate:date,compatibilityFlags:['nodejs_compat'],
    bindings:{WEBHOOK_KEY:key,
      BROKER_HOST:'broker.example.invalid',MQTT_USERNAME:'synthetic_relay',MQTT_PASSWORD:'synthetic_password'},
    durableObjects:{RPC_GUARDS:{className:'EmqxRpc',useSQLite:true}},
    serviceBindings:{INGEST_SERVICE:{name:'mqtt-api-fixture',entrypoint:'MqttDeviceApi'}},
    outboundService:async req=>{
      assert.equal(new URL(req.url).hostname,'synthetic-reply.invalid');
      replies.push({url:req.url,bytes:Buffer.from(await req.arrayBuffer())});
      return new Response(null,{status:204});
    },
  },{name:'mqtt-api-fixture',modules:true,scriptPath:root+'.wrangler/backend-fixture.mjs',
    compatibilityDate:date,compatibilityFlags:['nodejs_compat'],serviceBindings:{UPSTREAM:backend}}]}));
  const send=async(rpc,op='config',body='',secret=key)=>{
    return mf.dispatchFetch('https://test.invalid/emqx',{method:'POST',
      headers:{'Content-Type':'application/json','X-CP-Webhook-Key':secret},
      body:JSON.stringify({...base,published_at_ms:Date.now(),topic:`cp/v1/${node}/${boot}/req/${op}/${rpc}`,payload_b64:Buffer.from(body).toString('base64')})});
  };
  try {
    await mf.ready;
    assert.equal((await send(1,'config','','wrong')).status,401);
    assert.equal(calls.length,0);
    assert.equal((await send(1)).status,204);
    assert.equal(replies[0].bytes.readUInt16BE(),200);
    assert.equal(replies[0].bytes.subarray(2).toString(),original);
    assert.equal((await send(1)).status,204); // duplicate fetches a fresh lease
    assert.equal(calls.length,2);
    assert.equal((await send(1,'contact',JSON.stringify({boot_id:boot}))).status,409);
    assert.equal(calls.length,2);
    wait=true;const pending=send(3);await entry;
    assert.equal((await send(4)).status,503); // one owner across external await
    wait=false;release();assert.equal((await pending).status,204);
    assert.equal((await send(2)).status,409);
    assert.equal(calls.length,3);
    assert.equal((await send(4)).status,204);
    assert.equal(calls.length,4);
    const frame=(subop,body='',flags=0)=>Buffer.concat([Buffer.from([67,80,86,51,1,subop,flags,0]),Buffer.from(body)]);
    const frozen=' {"synthetic":"测试", "boot_id":"old-frozen-body"}\n';
    assert.equal((await send(5,'ingest',frame(3,frozen,1))).status,204);
    assert.deepEqual(calls.at(-1),{url:'https://pulse.anend.net/api/v3/device/config/ack',body:frozen,receiptOnly:'true'});
    assert.equal(replies.at(-1).bytes.subarray(2).toString(),original);
    assert.equal((await send(5,'ingest',frame(3,frozen,1))).status,204);
    assert.equal(calls.length,6); // identical retry reaches API again
    assert.equal((await send(5,'ingest',frame(3,frozen))).status,409);
    assert.equal((await send(5,'ingest',frame(4,frozen,1))).status,409);
    assert.equal(calls.length,6);
    assert.equal((await send(6,'ingest',frame(2))).status,204);
    assert.deepEqual(calls.at(-1),{url:'https://pulse.anend.net/api/v3/device/config',body:'',receiptOnly:'false'});
    replyBody='x'.repeat(8192);
    assert.equal((await send(7,'ingest',frame(2))).status,204);
    assert.equal(replies.at(-1).bytes.length,8194);
    assert.equal(replies.at(-1).bytes.subarray(2).toString(),replyBody);
    replyBody='x'.repeat(8193);
    assert.equal((await send(8,'ingest',frame(2))).status,204);
    assert.equal(replies.at(-1).bytes.readUInt16BE(),504);
    assert.equal(replies.at(-1).bytes.subarray(2).toString(),'{"error":"gateway_outcome_unknown"}');
  } finally {release?.();await mf.dispose();}
});
