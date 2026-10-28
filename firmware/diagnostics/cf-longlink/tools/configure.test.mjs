import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate,generate } from './configure.mjs';
const base=()=>({httpsOrigin:'https://probe.example.com',token:'fake_test_only_token_123456789',epoch:Math.floor(Date.now()/1000)});
test('strict public HTTPS origin, bearer and finite counts',()=>{
  assert.equal(validate(base()).budgetSeconds,540);
  assert.equal(validate(base()).wsSamples,12);
  for(const httpsOrigin of ['http://probe.example.com','https://127.0.0.1','https://localhost','https://probe.local','https://probe.invalid','https://u:p@probe.example.com','https://probe.example.com/ws','https://probe.example.com/?x=1','https://probe.example.com:8443'])
    assert.throws(()=>validate({...base(),httpsOrigin}));
  for(const changed of [{token:'bad\r\nheader'},{epoch:1},{freshSamples:7},{reuseSamples:0},{wsSamples:13},{reconnectSamples:5},{budgetSeconds:601},{budgetSeconds:299},{unknown:'value'}])
    assert.throws(()=>validate({...base(),...changed}));
});
test('external private file, bounded input, private ignored output only',()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'cf-link-config-test-'));
  const input=path.join(folder,'config.json');fs.writeFileSync(input,JSON.stringify(base()),{mode:0o600});
  assert.throws(()=>generate(input,path.join(folder,'secret.h')));
  const build=new URL('../build/',import.meta.url);fs.mkdirSync(build,{recursive:true,mode:0o700});
  const output=new URL('config-test.h',build).pathname;
  generate(input,output);assert.equal(fs.statSync(output).mode&0o777,0o600);
  const text=fs.readFileSync(output,'utf8');assert.match(text,/cfg_authorization/);assert.match(text,/#define CFG_freshSamples 6LL/);
  fs.chmodSync(input,0o644);assert.throws(()=>generate(input,output));
  fs.chmodSync(input,0o600);fs.writeFileSync(input,'{"token":"secret_do_not_echo');assert.throws(()=>generate(input,output));
  fs.rmSync(output);fs.rmSync(folder,{recursive:true});
});
