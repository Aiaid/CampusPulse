// Independently implemented against ESP-IDF v5.5.3 protocomm Security 2,
// sec_patch_ver=1: SRP6a (3072-bit RFC5054 group, SHA-512) and AES-256-GCM.
// Source schema/formulas: components/protocomm/{proto,src/crypto/srp6a} and
// tools/esp_prov/security/{srp6a,security2}.py. No Security 0/1 fallback.
// SHA-512/AES use WebCrypto; JS BigInt exponentiation is not constant-time.
import { bytes, join, protoBytes, sessionPacket, sessionResponse } from './protocol.js';
export const PIN_PATTERN = /^[0-9]{8}$/;
export const USERNAME = 'campuspulse';
export const SRP_N = BigInt('0x' +
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF');
const integer = input => BigInt('0x' + Array.from(input, v => v.toString(16).padStart(2, '0')).join(''));
export function integerBytes(n, width = 0) { const hex = n.toString(16).padStart(width ? width * 2 : Math.ceil(n.toString(16).length / 2) * 2, '0'); return Uint8Array.from(hex.match(/../g), x => parseInt(x, 16)); }
const mod = n => (n % SRP_N + SRP_N) % SRP_N;
function pow(base, exp) { let result = 1n; base = mod(base); while (exp) { if (exp & 1n) result = result * base % SRP_N; base = base * base % SRP_N; exp >>= 1n; } return result; }
function same(a, b) { if (a?.length !== b?.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]; return diff === 0; }
export class GcmSession {
  constructor(key, nonce, subtle = globalThis.crypto.subtle) { this.key = key; this.nonce = bytes(nonce).slice(); this.subtle = subtle; this.busy = false; }
  close() { this.key = null; this.nonce.fill(0); }
  async apply(input, decrypt) {
    if (!this.key || this.busy) throw new Error('配网加密会话已关闭或忙。');
    this.busy = true;
    try {
      const view = new DataView(this.nonce.buffer), counter = view.getUint32(8);
      if (counter === 0 || counter === 0xffffffff) throw new Error('配网加密计数器耗尽，请重新连接。');
      const result = await this.subtle[decrypt ? 'decrypt' : 'encrypt']({ name: 'AES-GCM', iv: this.nonce, tagLength: 128 }, this.key, bytes(input));
      view.setUint32(8, counter + 1); return new Uint8Array(result);
    } catch { this.close(); throw new Error('配网消息认证失败或会话已过期，请重新连接。'); }
    finally { this.busy = false; }
  }
  encrypt(input) { return this.apply(input, false); }
  decrypt(input) { return this.apply(input, true); }
}
export async function establishSecurity2(exchange, pin, crypto = globalThis.crypto) {
  if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) throw new Error('请输入设备显示的 8 位数字配网码，保留开头的 0。');
  const subtle = crypto.subtle, encode = value => new TextEncoder().encode(value);
  const hash = async (...parts) => new Uint8Array(await subtle.digest('SHA-512', join(...parts)));
  const random = crypto.getRandomValues(new Uint8Array(32)); random[0] |= 0x80;
  let a = integer(random); random.fill(0);
  const A = integerBytes(pow(5n, a), 384), n = integerBytes(SRP_N, 384), g = integerBytes(5n, 384);
  const first = sessionResponse(await exchange(sessionPacket(0, 20, join(protoBytes(1, encode(USERNAME)), protoBytes(2, A)))), 1, 21);
  const remote = first.get(2), salt = first.get(3);
  if (!(remote instanceof Uint8Array) || !remote.length || remote.length > 384 || salt?.length !== 16) throw new Error('设备 Security 2 参数无效。');
  const B = integer(remote); if (B <= 0n || B >= SRP_N) throw new Error('设备 SRP 公钥无效。');
  const k = integer(await hash(n, g)), u = integer(await hash(A, integerBytes(B, 384)));
  if (!u) throw new Error('设备 SRP 挑战无效。');
  const passwordHash = await hash(encode(`${USERNAME}:${pin}`)); pin = '';
  let x = integer(await hash(salt, passwordHash)); passwordHash.fill(0);
  // C server hashes exact salt/A/B bytes in proofs, including leading zeros;
  // only the shared integer S uses its minimal unsigned byte representation.
  const secret = integerBytes(pow(mod(B - k * pow(5n, x)), a + u * x)); a = 0n; x = 0n;
  const key = await hash(secret); secret.fill(0);
  const hn = await hash(n), hg = await hash(g), xor = hn.map((v, i) => v ^ hg[i]);
  const proof = await hash(xor, await hash(encode(USERNAME)), salt, A, remote, key);
  const expected = await hash(A, proof, key);
  try {
    const second = sessionResponse(await exchange(sessionPacket(2, 22, protoBytes(1, proof))), 3, 23);
    if (!same(second.get(2), expected)) throw new Error('配网码不匹配，无法验证设备。');
    const nonce = second.get(3);
    if (nonce?.length !== 12 || new DataView(nonce.buffer, nonce.byteOffset).getUint32(8) !== 1) throw new Error('设备必须支持 Security 2 patch 1。');
    return new GcmSession(await subtle.importKey('raw', key.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']), nonce, subtle);
  } finally { key.fill(0); proof.fill(0); expected.fill(0); }
}
