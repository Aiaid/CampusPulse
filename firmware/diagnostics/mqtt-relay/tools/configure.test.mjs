import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const generator=fileURLToPath(new URL('./configure.mjs',import.meta.url));
function run(t,modify=()=>{}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cp-mqtt-config-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const ca=path.join(dir,'public.pem');
  fs.writeFileSync(ca,'-----BEGIN CERTIFICATE-----\nPUBLIC_PLACEHOLDER\n-----END CERTIFICATE-----\n');
  const cfg={broker_uri:'mqtts://broker.example.invalid:8883',client_id:'synthetic',username:'user',password:'SECRET_NEVER_OUTPUT',
    request_topic:'probe/request',reply_topic:'probe/reply',unix_time:Math.floor(Date.now()/1000),synthetic_node_id:'cp_demo000000001',ca_file:ca};
  modify(cfg,dir);
  const input=path.join(dir,'private.json'),output=path.join(dir,'header.h');
  fs.writeFileSync(input,JSON.stringify(cfg),{mode:0o600});
  const result=spawnSync(process.execPath,[generator,input,output],{encoding:'utf8'});
  assert.ok(!result.stdout.includes(cfg.password)); assert.ok(!result.stderr.includes(cfg.password));
  return {cfg,result,output,dir};
}
test('health config generates private header without printing secrets',t=>{
  const {result,output}=run(t); assert.equal(result.status,0,result.stderr); assert.equal(result.stdout,'');
  assert.equal(fs.statSync(output).mode&0o777,0o600);
  assert.match(fs.readFileSync(output,'utf8'),/#define CP_MQTT_HAS_FIXTURE 0/);
});
test('reject insecure or URI-embedded credentials without exposure',t=>{
  for (const uri of ['mqtt://broker.invalid','mqtts://SECRET_NEVER_OUTPUT@broker.invalid','mqtts://127.0.0.1']) {
    const {result}=run(t,c=>{c.broker_uri=uri;}); assert.equal(result.status,1);
  }
});
test('reject control characters that cannot be emitted safely as C JSON strings',t=>{
  const {result}=run(t,c=>{c.password='SECRET_NEVER_OUTPUT\u0001';}); assert.equal(result.status,1);
});
test('reject root account credentials and stale clock',t=>{
  assert.equal(run(t,c=>{c.access_key_secret='SECRET_NEVER_OUTPUT';}).result.status,1);
  assert.equal(run(t,c=>{c.unix_time=1700000000;}).result.status,1);
});
function fixture(c,dir,wrong=false) {
  const value={protocol:'campuspulse/2',dataset:'demo',node_id:c.synthetic_node_id,
    boot_id:'00000000-0000-4000-8000-000000000001',batch_id:'00000000-0000-4000-8000-000000000002',stream:'node_status',items:[{synthetic:true}]};
  const bytes=Buffer.from(JSON.stringify(value)+'\n'); c.body_fixture_file=path.join(dir,'body.json'); fs.writeFileSync(c.body_fixture_file,bytes);
  c.expected_ack={node_id:value.node_id,boot_id:value.boot_id,batch_id:value.batch_id,stream:value.stream,
    body_sha256:crypto.createHash('sha256').update(bytes).digest('hex'),accepted_count:wrong?2:1,durability:'committed'};
}
test('preserve exact fixture file bytes including trailing newline',t=>{
  const {result,output,cfg}=run(t,fixture); assert.equal(result.status,0,result.stderr);
  const header=fs.readFileSync(output,'utf8');
  assert.ok(header.includes(fs.readFileSync(cfg.body_fixture_file).toString('base64')));
  assert.ok(header.includes(cfg.expected_ack.body_sha256));
});
test('reject ACK count not equal to frozen fixture count',t=>{
  assert.equal(run(t,(c,dir)=>fixture(c,dir,true)).result.status,1);
});
