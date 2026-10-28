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
  const calls=[];const replies=[];let release;let entered;let wait=false;
  const entry=new Promise(resolve=>{entered=resolve;});
  await build({entryPoints:[root+'test/backend-fixture.mjs'],outfile:root+'.wrangler/backend-fixture.mjs',
    bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers']});
  const backend=async req=>{
    calls.push({url:req.url,body:await req.text()});
    if(wait){entered();await new Promise(resolve=>{release=resolve;});}
    return new Response(original);
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
  } finally {release?.();await mf.dispose();}
});
