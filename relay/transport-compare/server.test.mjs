import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import https from 'node:https';
import {once} from 'node:events';
import {randomBytes,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {start,payload,receipt,allowedPublish,allowedSubscribe,PacketBound} from './server.mjs';
import {validate} from '../../firmware/diagnostics/transport-compare/tools/configure.mjs';

test('bounded synthetic body, correlated receipt, ACL and config',()=>{
  const run='10'.repeat(16),b=payload(8192,run,7),r=JSON.parse(receipt(b,'11111111-1111-4111-8111-111111111111'));
  assert.equal(r.bytes,8192);assert.equal(r.seq,7);assert.equal(r.sha256,createHash('sha256').update(b).digest('hex'));
  b[25]^=1;assert.throws(()=>receipt(b,'id'));assert.throws(()=>receipt(Buffer.alloc(9000),'id'));
  const c={id:'bench-'+run};
  assert(allowedPublish(c,{topic:`probe/${c.id}/data`,payload:Buffer.alloc(1024),qos:1,retain:false}));
  for(const topic of [`probe/${c.id}/ack`,'probe/other/data','probe/+/data'])assert(!allowedPublish(c,{topic,payload:Buffer.alloc(1024),qos:1}));
  assert(allowedSubscribe(c,{topic:`probe/${c.id}/ack`,qos:1}));
  for(const topic of ['#','probe/+/ack','probe/other/ack'])assert(!allowedSubscribe(c,{topic,qos:1}));
  const cfg={host:'127.0.0.1',httpsPort:18443,mqttPort:18883,token:'1'.repeat(64),epoch:Math.floor(Date.now()/1000)};
  assert.equal(validate(cfg).bleWindowMs,20);assert.throws(()=>validate({...cfg,bleWindowMs:30}));
  assert.equal(validate(cfg).mqttDirectPublish,0);assert.equal(validate(cfg).mqttOutSize,1024);
  assert.equal(validate(cfg).cpuStats,0);assert.equal(validate({...cfg,cpuStats:1}).cpuStats,1);
  for(const cpuStats of [-1,2,true,'1'])assert.throws(()=>validate({...cfg,cpuStats}));
  assert.equal(validate({...cfg,mqttDirectPublish:1,mqttOutSize:9000}).mqttDirectPublish,1);
  assert.equal(validate({...cfg,mqttDirectPublish:1,mqttOutSize:9000}).mqttOutSize,9000);
  for(const mqttDirectPublish of [-1,2,true,'1',0.5])assert.throws(()=>validate({...cfg,mqttDirectPublish}));
  for(const mqttOutSize of [1023,9001,'1024',1024.5])assert.throws(()=>validate({...cfg,mqttOutSize}));
  assert.throws(()=>validate({...cfg,mqttWarmSamples:999}));assert.throws(()=>validate({...cfg,epoch:1}));
});
test('MQTT packet cap before parser, including fragmented headers',async()=>{
  const p=new PacketBound(),out=[];p.on('data',b=>out.push(b));
  p.write(Buffer.from([0x30,0x80]));p.write(Buffer.from([0x01,...Buffer.alloc(128)]));p.end(Buffer.from([0xc0,0]));
  await once(p,'end');assert.deepEqual(out.map(b=>b.length),[131,2]);
  const bad=new PacketBound();const rejected=once(bad,'error');bad.end(Buffer.from([0x30,0xff,0x7f]));await rejected;
});
async function port(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('same-certificate TLS1.2 HTTPS and MQTT QoS1 receipt integration',{timeout:30000},async()=>{
  const deps=process.env.CP_COMPARE_DEPS;if(!deps)throw Error('Set CP_COMPARE_DEPS to temporary dependency prefix');
  const {Aedes}=await import(pathToFileURL(path.join(deps,'node_modules/aedes/aedes.js')));
  const {connectAsync}=await import(pathToFileURL(path.join(deps,'node_modules/mqtt/build/index.js')));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cp-compare-test-'));let server,client;
  try{
    const key=path.join(dir,'key.pem'),cert=path.join(dir,'cert.pem');
    for(const args of [['ecparam','-name','prime256v1','-genkey','-noout','-out',key],
      ['req','-new','-x509','-key',key,'-sha256','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-out',cert]])
      assert.equal(spawnSync('openssl',args,{stdio:'ignore'}).status,0);
    fs.chmodSync(key,0o600);fs.chmodSync(cert,0o600);
    const cfg={host:'127.0.0.1',httpsPort:await port(),mqttPort:await port(),token:randomBytes(32).toString('hex'),
      keyFile:key,certFile:cert,budgetSeconds:60};server=await start(cfg,Aedes);
    const ca=fs.readFileSync(cert),run=randomBytes(16).toString('hex'),body=payload(1024,run,1);
    const agent=new https.Agent({keepAlive:true,maxSockets:1,ca,minVersion:'TLSv1.2',maxVersion:'TLSv1.2'});
    async function post(data,token=cfg.token){return new Promise((resolve,reject)=>{
      const req=https.request({hostname:cfg.host,port:cfg.httpsPort,path:'/benchmark',method:'POST',agent,
        headers:{Authorization:'Bearer '+token,'Content-Length':data.length}},res=>{const parts=[];res.on('data',b=>parts.push(b));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(parts).toString()}));});
      req.on('error',reject);req.end(data);
    });}
    const a=JSON.parse((await post(body)).body),b=JSON.parse((await post(payload(8192,run,2))).body);
    assert.equal(a.connection_id,b.connection_id);assert.equal(b.bytes,8192);
    assert.equal((await post(body,'bad')).status,400);agent.destroy();
    client=await connectAsync(`mqtts://${cfg.host}:${cfg.mqttPort}`,{ca,username:'probe',password:cfg.token,
      clientId:'bench-'+run,protocolVersion:4,reconnectPeriod:0,connectTimeout:5000,minVersion:'TLSv1.2',maxVersion:'TLSv1.2'});
    client.on('error',()=>{});
    const ack=`probe/bench-${run}/ack`,data=`probe/bench-${run}/data`;
    const grants=await client.subscribeAsync(ack,{qos:1});assert.equal(grants[0].qos,1);
    const message=once(client,'message');await client.publishAsync(data,body,{qos:1});
    const [topic,wire,packet]=await message;assert.equal(topic,ack);assert.equal(packet.qos,1);
    const r=JSON.parse(wire);assert.equal(r.sha256,a.sha256);assert.equal(r.kind,'transport_received');
    await assert.rejects(client.subscribeAsync('probe/+/ack',{qos:1}),e=>e.packet?.granted?.[0]===128);
    await client.endAsync();client=null;
    client=await connectAsync(`mqtts://${cfg.host}:${cfg.mqttPort}`,{ca,username:'probe',password:cfg.token,
      clientId:'bench-'+run,protocolVersion:4,reconnectPeriod:0,connectTimeout:1000});
    client.on('error',()=>{});
    const closed=once(client,'close');client.publish(ack,body,{qos:1},()=>{});await closed;
    await client.endAsync(true);client=null;
    await assert.rejects(connectAsync(`mqtts://${cfg.host}:${cfg.mqttPort}`,{ca,username:'probe',password:'wrong',
      clientId:'bench-'+run,protocolVersion:4,reconnectPeriod:0,connectTimeout:1000}));
    // Reject untrusted CA rather than silently disabling verification.
    await assert.rejects(connectAsync(`mqtts://${cfg.host}:${cfg.mqttPort}`,{rejectUnauthorized:true,
      username:'probe',password:cfg.token,clientId:'bench-'+run,reconnectPeriod:0,connectTimeout:1000}));
  }finally{if(client)await client.endAsync(true);if(server)await server.close();fs.rmSync(dir,{recursive:true,force:true});}
});
