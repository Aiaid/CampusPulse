import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { webcrypto, createHash } from 'node:crypto';
import { establishSecurity2, SRP_N, integerBytes } from '../../../../src/admin/provisioning/security2.js';
import { protoBytes, protoInt, sessionPacket, decodeProto } from '../../../../src/admin/provisioning/protocol.js';
const binary=process.argv[2];if(!binary)throw Error('Pass the compiled pinned SDK C peer');
function peer(pin,salt,b) {
  const child=spawn(binary,[pin,salt],{stdio:['pipe','pipe','pipe'],env:{...process.env,...(b?{CP_TEST_SRP_B:Buffer.from(b).toString('hex')}:{})}});const lines=createInterface({input:child.stdout}),queue=[];let stderr='';child.stderr.on('data',b=>stderr+=b);child.stdin.on('error',()=>{});child.on('exit',(code,signal)=>{for(const pending of queue)pending('EXIT '+code+' '+signal);});
  lines.on('line',line=>{const resolve=queue.shift();if(!resolve)throw Error('Unexpected peer output');resolve(line);});
  return {async call(op,data=new Uint8Array()){const result=await new Promise((resolve,reject)=>{queue.push(resolve);child.stdin.write(`${op} ${Buffer.from(data).toString('hex')}\n`,e=>e&&reject(e));});const [status,failures,hex='']=result.split(' ');return{status:Number(status),failures:Number(failures),bytes:new Uint8Array(Buffer.from(hex,'hex'))};},async close(){child.stdin.end();await new Promise(resolve=>child.once('exit',resolve));assert.equal(stderr,'');}};
}
const integer=bytes=>BigInt('0x'+Buffer.from(bytes).toString('hex'));
const hash=(...parts)=>createHash('sha512').update(Buffer.concat(parts.map(p=>Buffer.from(p)))).digest();
function pow(base,n){let out=1n;while(n){if(n&1n)out=out*base%SRP_N;base=base*base%SRP_N;n>>=1n;}return out;}
const threshold=1n<<3064n,firstPrivate=1n<<255n;
let aSeed,apub=pow(5n,firstPrivate);
for(let i=0;i<10000;i++){if(apub>0&&apub<threshold){aSeed=integerBytes(firstPrivate+BigInt(i),32);break;}apub=apub*5n%SRP_N;}assert(aSeed);
function shortB(pin,salt){const v=pow(5n,integer(hash(Buffer.from(salt,'hex'),hash(Buffer.from('campuspulse:'+pin))))),k=integer(hash(integerBytes(SRP_N,384),integerBytes(5n,384)));let gb=pow(5n,firstPrivate);for(let i=0;i<10000;i++){const b=(k*v+gb)%SRP_N;if(b>0&&b<threshold)return integerBytes(firstPrivate+BigInt(i),32);gb=gb*5n%SRP_N;}throw Error('No short B fixture found');}
async function session(pin,salt,random,b,busyConnect=false) {
 const p=peer(pin,salt,b);if(busyConnect){await p.call('G',new Uint8Array([0x10]));assert.equal((await p.call('N')).status,0);await p.call('G',new Uint8Array([0]));}const api=random?{subtle:webcrypto.subtle,getRandomValues:out=>{out.set(random);return out;}}:webcrypto;
 let step=0;const started=performance.now();const cipher=await establishSecurity2(async input=>{
   if(!step&&random){const a=decodeProto(decodeProto(decodeProto(input).get(12)).get(20)).get(2);assert.equal(a.length,384);assert.equal(a[0],0,'Fixture must actually exercise leading-zero A');}
   const r=await p.call('S',input);assert.equal(r.status,0);
   if(!step&&b){const remote=decodeProto(decodeProto(decodeProto(r.bytes).get(12)).get(21)).get(2);assert(remote.length<384,'Fixture must actually exercise minimal short B');}
   step++;return r.bytes;
 },pin,api);
 const plain=new TextEncoder().encode('{"v":1,"op":"info"}');const decrypted=await p.call('D',await cipher.encrypt(plain));assert.equal(decrypted.status,0);assert.deepEqual(decrypted.bytes,plain);
 const reply=new TextEncoder().encode('{"v":1,"ok":true}');const encrypted=await p.call('E',reply);assert.equal(encrypted.status,0);assert.deepEqual(await cipher.decrypt(encrypted.bytes),reply);
 const elapsed=performance.now()-started;await p.close();return elapsed;
}
const ordinary='112233445566778899aabbccddeeff00',leading='002233445566778899aabbccddeeff00';
const durations=[await session('00123456',ordinary),await session('00123456',leading),await session('00123456',leading,aSeed)];
let zeroHashPin='';for(let i=0;i<10000;i++){const pin=String(i).padStart(8,'0');if(hash(Buffer.from('campuspulse:'+pin))[0]===0){zeroHashPin=pin;break;}}assert(zeroHashPin);assert.equal(hash(Buffer.from('campuspulse:'+zeroHashPin))[0],0);durations.push(await session(zeroHashPin,leading,aSeed));
durations.push(await session(zeroHashPin,leading,aSeed,shortB(zeroHashPin,leading)));
durations.push(await session('00123456',ordinary,undefined,undefined,true));
// Wrong PIN retries reconnect the transport but do not reset the shared budget.
const p=peer('00123456',ordinary);
for(let i=1;i<=5;i++){
 if(i>1)assert.equal((await p.call('N')).status,0);
 await assert.rejects(()=>establishSecurity2(async input=>{const r=await p.call('S',input);if(r.status)throw Error('SDK authentication rejected');return r.bytes;},'00123457',webcrypto));
}
assert.equal((await p.call('N')).status,0);assert.notEqual((await p.call('S',new Uint8Array([16,2,98,0]))).status,0);await p.close();
// Strict preflight rejects malformed or mixed/duplicate protobuf before SDK dereference.
for(const malformed of [new Uint8Array([16,2,98,0]),new Uint8Array([16,1,98,0]),new Uint8Array([16,2,16,2,98,0]),sessionPacket(2,22,protoBytes(1,new Uint8Array(63)))]){
 const q=peer('00123456',ordinary);assert.notEqual((await q.call('S',malformed)).status,0);await q.close();
}
// Short/oversized encrypted inputs must never reach SDK inlen-16 arithmetic.
for(const n of [0,1,15,16,513]){const q=peer('00123456',ordinary);assert.notEqual((await q.call('D',new Uint8Array(n))).status,0);await q.close();}
const q=peer('00123456',ordinary);await q.call('X');assert.equal((await q.call('N')).status,0);assert.notEqual((await q.call('S',new Uint8Array([16,2,98,0]))).status,0);await q.close();
console.log(JSON.stringify({sdk:'ESP-IDF 5.5.3 actual security2.c/esp_srp.c/esp_srp_mpi.c',tests:['ordinary handshake/GCM','leading-zero salt','384-byte leading-zero client A','leading-zero SHA512 username:PIN','minimal leading-zero server B','connect while application gate busy then valid handshake','5 failures across reconnects','expired gate','malformed/duplicate protobuf','ciphertext lower/upper bounds'],host_handshake_and_messages_ms:durations.map(x=>Math.round(x))}));
