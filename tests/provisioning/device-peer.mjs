// Synthetic GATT peer using Node/OpenSSL, independent from browser AES code.
import { createPrivateKey, createPublicKey, diffieHellman, createHash, createCipheriv } from 'node:crypto';
import { decodeProto, protoBytes, sessionPacket } from '../../src/admin/provisioning/security1.js';
import { SESSION_UUID } from '../../src/admin/provisioning/bluetooth.js';
export const TEST_PROOF='00112233445566778899aabbccddeeff';
export const TEST_NODE='cp_001122aabbcc';
export const TEST_TOKEN=`cpd_${'a'.repeat(64)}`;
const pkcs8=raw=>Buffer.concat([Buffer.from('302e020100300506032b656e04220420','hex'),raw]);
const pub=key=>createPublicKey(key).export({type:'spki',format:'der'}).subarray(-32);
export function createPeer(onCandidate = () => {}) {
  const key=createPrivateKey({key:pkcs8(Buffer.from(Array.from({length:32},(_,i)=>i+33))),type:'pkcs8',format:'der'});
  const iv=Buffer.from(Array.from({length:16},(_,i)=>i));let cipher,client;
  return async(kind,input)=>{
    input=Buffer.from(input);
    if(kind===SESSION_UUID){const sec=decodeProto(decodeProto(input).get(11)),type=sec.get(1)??0;
      if(type===0){client=decodeProto(sec.get(20)).get(1);const shared=diffieHellman({privateKey:key,publicKey:createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b656e032100','hex'),client]),type:'spki',format:'der'})});const h=createHash('sha256').update(TEST_PROOF).digest();for(let i=0;i<32;i++)shared[i]^=h[i];cipher=createCipheriv('aes-256-ctr',shared,iv);return Array.from(sessionPacket(1,21,Buffer.concat([protoBytes(2,pub(key)),protoBytes(3,iv)])));}
      if(!cipher.update(decodeProto(sec.get(22)).get(2)).equals(pub(key)))throw Error('Incorrect synthetic proof');
      return Array.from(sessionPacket(3,23,protoBytes(3,cipher.update(client))));
    }
    const r=JSON.parse(cipher.update(input).toString());if(r.op==='configure')onCandidate(r);
    const result=r.op==='info'?{v:1,ok:true,node_id:TEST_NODE,board:'FoloToy AI Passport / ESP32-C3'}:{v:1,ok:true,state:'received',attempt_id:r.attempt_id};
    return Array.from(cipher.update(Buffer.from(JSON.stringify(result))));
  };
}
