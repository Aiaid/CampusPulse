// Explicit synthetic LOCAL browser-test data. Never verifies a live broker.
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID,webcrypto} from 'node:crypto';
import {spawnSync} from 'node:child_process';
assert.equal(process.env.CAMPUSPULSE_LOCAL_MQTT_FIXTURES,'synthetic','Explicit synthetic local-fixture mode required');
const envFile=process.env.CAMPUSPULSE_LOCAL_MQTT_ENV_FILE||'.dev.vars';
const config=process.env.CAMPUSPULSE_LOCAL_MQTT_CONFIG||'wrangler.jsonc';
assert.equal(statSync(envFile).mode&0o077,0,'Local env must be private');
const vars=readFileSync(envFile,'utf8');
const secret=vars.match(/^MQTT_PROVISIONING_KEY=([A-Za-z0-9_-]{43})$/m)?.[1];
assert.ok(secret,'Disposable local MQTT key required');
const key=await webcrypto.subtle.importKey('raw',Buffer.from(secret,'base64url'),'AES-GCM',false,['encrypt']);
const uri='mqtts://q9a692f8.ala.cn-hangzhou.emqxsl.cn:8883';
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const statements=[];
for(let i=0;i<8;i++){
  const id=randomUUID(),username='ci'+randomBytes(6).toString('hex'),iv=randomBytes(12);
  const aad=Buffer.from(`campuspulse/mqtt/1\n${id}\n${username}\n${username}\n${uri}`);
  // The encrypted plaintext must match the production ASCII credential grammar.
  const password=randomBytes(32).toString('base64url');
  const encrypted=await webcrypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},key,Buffer.from(password));
  const value=`v1.${iv.toString('base64url')}.${Buffer.from(encrypted).toString('base64url')}`;
  const now=new Date().toISOString();
  statements.push(`INSERT INTO mqtt_credentials(id,username,namespace,password_ciphertext,state,created_at,verified_at) VALUES(${[id,username,username,value,'ready',now,now].map(quote).join(',')});`);
}
const folder=mkdtempSync(join(tmpdir(),'campuspulse-local-mqtt-fixture-'));
try {
  const file=join(folder,'synthetic.sql');writeFileSync(file,statements.join('\n'),{mode:0o600});
  const args=['node_modules/wrangler/bin/wrangler.js','d1','execute','campuspulse','--local','--config',config,'--file',file];
  if(process.env.CAMPUSPULSE_LOCAL_MQTT_PERSIST)args.push('--persist-to',process.env.CAMPUSPULSE_LOCAL_MQTT_PERSIST);
  const result=spawnSync(process.execPath,args,{encoding:'utf8',env:process.env});
  assert.equal(result.status,0,'Local synthetic fixture seed failed; no remote mode is supported');
  console.log('Seeded 8 synthetic LOCAL MQTT identities for browser acceptance; no broker verification claimed.');
} finally {rmSync(folder,{recursive:true,force:true});}
