// Synthetic SRP/GATT peer. Math and OpenSSL AES are independent of browser
// WebCrypto code; group and parameters come from the official SDK fixture.
import { createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeProto, join, protoBytes, sessionPacket } from '../../src/admin/provisioning/protocol.js';
import { SESSION_UUID } from '../../src/admin/provisioning/bluetooth.js';
const fixture = JSON.parse(readFileSync(new URL('./idf-security2-fixture.json', import.meta.url)));
export const TEST_PROOF = fixture.pin;
export const TEST_NODE = 'cp_001122aabbcc';
export const TEST_TOKEN = `cpd_${'a'.repeat(64)}`;
export const TEST_NONCE = 'ab'.repeat(16);
const N = BigInt(`0x${fixture.group_N}`), g = BigInt(fixture.group_g);
const num = b => BigInt('0x' + Buffer.from(b).toString('hex'));
const bin = (n, width = 0) => Buffer.from(n.toString(16).padStart(width ? width * 2 : Math.ceil(n.toString(16).length / 2) * 2, '0'), 'hex');
const hash = (...parts) => createHash('sha512').update(Buffer.concat(parts.map(p => Buffer.from(p)))).digest();
const power = (base, exponent) => { let r = 1n; while (exponent) { if (exponent % 2n) r = r * base % N; base = base * base % N; exponent /= 2n; } return r; };
export function createPeer(onCandidate = () => {}, pin = TEST_PROOF) {
  const salt = Buffer.from(fixture.salt, 'hex'), b = num(Buffer.from(fixture.server_private, 'hex'));
  const k = num(hash(bin(N, 384), bin(g, 384))), x = num(hash(salt, hash(Buffer.from(`campuspulse:${pin}`))));
  const verifier = power(g, x), B = (k * verifier + power(g, b)) % N;
  const nonce = Buffer.from(fixture.nonce, 'hex'); let key, client, proof, authenticated = false, attempt, configure = '';
  const increment = () => nonce.writeUInt32BE(nonce.readUInt32BE(8) + 1, 8);
  return async (kind, input) => {
    input = Buffer.from(input);
    if (kind === SESSION_UUID) {
      const outer = decodeProto(input); if (outer.get(2) !== 2) throw new Error('Security 2 required');
      const sec = decodeProto(outer.get(12)), type = sec.get(1) ?? 0;
      if (type === 0) {
        const cmd = decodeProto(sec.get(20)); client = Buffer.from(cmd.get(2));
        if (Buffer.from(cmd.get(1)).toString() !== 'campuspulse' || client.length !== 384) throw new Error('Invalid synthetic client');
        const A = num(client), u = num(hash(client, bin(B, 384)));
        if (!A || A >= N || !u) throw new Error('Invalid synthetic public key');
        key = hash(bin(power(A * power(verifier, u) % N, b)));
        const xor = hash(bin(N, 384)).map((v, i) => v ^ hash(bin(g, 384))[i]);
        proof = hash(xor, hash(Buffer.from('campuspulse')), salt, client, bin(B), key);
        authenticated = false; nonce.writeUInt32BE(1, 8);
        return Array.from(sessionPacket(1, 21, join(protoBytes(2, bin(B)), protoBytes(3, salt))));
      }
      if (!Buffer.from(decodeProto(sec.get(22)).get(1)).equals(proof)) throw new Error('Incorrect synthetic PIN');
      authenticated = true;
      return Array.from(sessionPacket(3, 23, join(protoBytes(2, hash(client, proof, key)), protoBytes(3, nonce))));
    }
    if (!authenticated) throw new Error('Unauthenticated synthetic request');
    const decrypt = createDecipheriv('aes-256-gcm', key.subarray(0, 32), nonce); decrypt.setAuthTag(input.subarray(-16));
    let r = JSON.parse(Buffer.concat([decrypt.update(input.subarray(0, -16)), decrypt.final()]).toString()); increment();
    let chunkBytes;
    if (r.op === 'configure_chunk') { if (r.reset) configure = ''; configure += r.data; chunkBytes = Buffer.byteLength(configure); if (chunkBytes > 1536) throw new Error('Oversized synthetic candidate'); }
    if (r.op === 'configure_commit') { r = JSON.parse(configure); configure = ''; }
    if (r.op === 'configure') { attempt = r.attempt_id; onCandidate(r); }
    const result = r.op === 'info' ? { v: 1, ok: true, node_id: TEST_NODE, board: 'Synthetic ESP32-C3', transport: 'ble', security: 'security2', session_expires_in_ms: 300000 }
      : chunkBytes ? { v: 1, ok: true, received_bytes: chunkBytes } : { v: 1, ok: true, state: 'received', attempt_id: attempt };
    const encrypt = createCipheriv('aes-256-gcm', key.subarray(0, 32), nonce);
    const reply = Buffer.concat([encrypt.update(Buffer.from(JSON.stringify(result))), encrypt.final(), encrypt.getAuthTag()]); increment();
    return Array.from(reply);
  };
}
