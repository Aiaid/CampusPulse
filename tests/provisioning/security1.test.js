import { describe, it, expect } from 'vitest';
import { webcrypto, createPrivateKey, createPublicKey, diffieHellman, createHash, createCipheriv } from 'node:crypto';
import fixture from './idf-security1-fixture.json';
import { validateAnyCaptureConfig } from '../../worker/device-v2-validation.ts';
import { decodeProto, establishSecurity1, protoBytes, sessionPacket, CtrStream } from '../../src/admin/provisioning/security1.js';
import { connectProvisioning, selectProvisioningDevice, SESSION_UUID, APP_UUID } from '../../src/admin/provisioning/bluetooth.js';
import { cloudProgress, provisionConfig, assignProvisionConfig } from '../../src/admin/provisioning/enrollment.js';
const fromHex = h => new Uint8Array(Buffer.from(h, 'hex'));
const pkcs8 = raw => Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]);
const rawPublic = privateKey => createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32);
const subtleFixed = { generateKey: async () => ({ privateKey: await webcrypto.subtle.importKey('pkcs8', pkcs8(Buffer.from(fixture.client_private, 'hex')), { name: 'X25519' }, false, ['deriveBits']), publicKey: await webcrypto.subtle.importKey('raw', rawPublic(createPrivateKey({ key: pkcs8(Buffer.from(fixture.client_private, 'hex')), type: 'pkcs8', format: 'der' })), 'X25519', true, []) }), ...Object.fromEntries(['exportKey','importKey','deriveBits','digest','encrypt'].map(k => [k, webcrypto.subtle[k].bind(webcrypto.subtle)])) };
export function createDevicePeer(proof = fixture.proof) {
  const key = createPrivateKey({ key: pkcs8(Buffer.from(fixture.device_private, 'hex')), type: 'pkcs8', format: 'der' });
  let cipher, clientPub; const calls = [];
  return { calls, async exchange(kind, input) {
    input = Buffer.from(input);
    if (kind === SESSION_UUID) {
      const sec = decodeProto(decodeProto(input).get(11)), type = sec.get(1) ?? 0;
      if (type === 0) {
        clientPub = decodeProto(sec.get(20)).get(1);
        const shared = diffieHellman({ privateKey: key, publicKey: createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100','hex'), clientPub]), format: 'der', type: 'spki' }) });
        const digest = createHash('sha256').update(proof).digest(); for (let i=0;i<32;i++) shared[i]^=digest[i];
        cipher = createCipheriv('aes-256-ctr',shared,Buffer.from(fixture.iv,'hex'));
        return sessionPacket(1,21,new Uint8Array(Buffer.concat([protoBytes(2,rawPublic(key)),protoBytes(3,fromHex(fixture.iv))])));
      }
      const verify = cipher.update(decodeProto(sec.get(22)).get(2)); if (!verify.equals(rawPublic(key))) throw new Error('Wrong proof');
      return sessionPacket(3,23,protoBytes(3,cipher.update(clientPub)));
    }
    const request = JSON.parse(cipher.update(input).toString()); calls.push(request);
    return cipher.update(Buffer.from(JSON.stringify(request.op==='info' ? {v:1,ok:true,node_id:'cp_001122aabbcc',board:'Test board'} : {v:1,ok:true,state:'received',attempt_id:request.attempt_id})));
  } };
}
describe('ESP-IDF 5.5.3 Security 1 interoperability', () => {
  it('matches packets produced by the official Python client and continuous partial CTR blocks', async () => {
    let step=0; const cipher=await establishSecurity1(async data=>{expect(Buffer.from(data).toString('hex')).toBe(step===0?fixture.cmd0:fixture.cmd1);return fromHex(step++===0?fixture.resp0:fixture.resp1);},fixture.proof,subtleFixed);
    expect(step).toBe(2); for(const m of fixture.stream) expect(Buffer.from(await cipher.apply(fromHex(m.plain))).toString('hex')).toBe(m.cipher);
  });
  it('rejects Security 0, malformed protobuf and duplicate fields', async () => {
    await expect(establishSecurity1(async()=>new Uint8Array([16,0]),fixture.proof,subtleFixed)).rejects.toThrow('Security 1');
    expect(()=>decodeProto(new Uint8Array([18,9,1]))).toThrow(); expect(()=>decodeProto(new Uint8Array([16,1,16,1]))).toThrow();
  });
  it('rejects incorrect possession proof', async () => {
    const peer=createDevicePeer(); await expect(establishSecurity1(data=>peer.exchange(SESSION_UUID,data),'ffffffffffffffffffffffffffffffff')).rejects.toThrow();
  });
  it('uses requestDevice synchronously and sends sensitive fields only in encrypted application exchange', async () => {
    let requested=false;const peer=createDevicePeer();let connected=false;const cache=new Map();
    const device={id:'browser-opaque-not-factory-id',gatt:{get connected(){return connected},disconnect(){connected=false},async connect(){connected=true;return {getPrimaryService:async()=>({getCharacteristic:async uuid=>({async writeValueWithResponse(value){if(uuid===APP_UUID)expect(Buffer.from(value).toString()).not.toContain('test-password');cache.set(uuid,await peer.exchange(uuid,value))},async readValue(){const b=cache.get(uuid);return new DataView(b.buffer,b.byteOffset,b.byteLength)}})})}}}};
    const selection=selectProvisioningDevice({bluetooth:{requestDevice:()=>{requested=true;return Promise.resolve(device)}}});expect(requested).toBe(true);
    const {client,identity}=await connectProvisioning(await selection,fixture.proof);expect(identity.node_id).toBe('cp_001122aabbcc');
    const result=await client.request({op:'configure',attempt_id:'11111111-2222-4333-8444-555555555555',ssid:'test',password:'test-password',device_token:`cpd_${'a'.repeat(64)}`});
    expect(result.state).toBe('received');expect(peer.calls[1].password).toBe('test-password');client.close();expect(connected).toBe(false);
  });
  it('keeps CTR boundaries correct across hundreds of fragmented requests', async () => {
    const raw=Buffer.alloc(32,7),iv=Buffer.alloc(16,9),key=await webcrypto.subtle.importKey('raw',raw,'AES-CTR',false,['encrypt']);const stream=new CtrStream(key,iv);const reference=createCipheriv('aes-256-ctr',raw,iv);
    for(let i=0;i<200;i++){const data=Buffer.alloc(i%37+1,i);expect(Buffer.from(await stream.apply(data))).toEqual(reference.update(data));}
  });
});
describe('enrollment state boundaries',()=>{
  it('publishes supported v2 defaults with explicit dataset',()=>{const c=provisionConfig('cp_001122aabbcc','p','c');expect(validateAnyCaptureConfig(c)).toEqual(c);expect(c.protocol).toBe('campuspulse/2');expect(c.dataset).toBe('controlled_test');expect(c.summary).toEqual({window_ms:30000,bin_ms:5000,max_addresses:64});expect(c.upload_policy.max_body_bytes).toBe(8192);});
  it('requires fresh contact and the same applied config, not registration alone',()=>{
    const d={device:{desired_config_id:'c',applied_config_id:'c',config_state:'applied',last_seen_at:'2026-10-24T00:00:00Z'}};
    expect(cloudProgress(d,'c',Date.parse('2026-10-24T01:00:00Z')).applied).toBe(false);
    d.device.latest_control={received_at:'2026-10-24T02:00:00Z'};expect(cloudProgress(d,'c',Date.parse('2026-10-24T01:00:00Z')).applied).toBe(true);
  });
  it('reconciles already-published assignment with no writes',async()=>{const calls=[];const id=await assignProvisionConfig(async(path,opts)=>{calls.push([path,opts]);return{device:{desired_config_id:'cp_001122aabbcc-c-1111111122224333'}}},'cp_001122aabbcc','11111111-2222-4333-8444-555555555555','p','field');expect(id).toBe('cp_001122aabbcc-c-1111111122224333');expect(calls).toHaveLength(1);expect(calls[0][1]).toBeUndefined();});
});
