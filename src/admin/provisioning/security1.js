// ESP-IDF 5.5.3 protocomm Security 1 wire protocol. Independently implemented
// from components/protocomm/proto/{session,sec1}.proto and tools/esp_prov.
// X25519, SHA-256 and AES-CTR are provided by WebCrypto; never Security 0.
export const bytes = value => new Uint8Array(value.buffer ?? value, value.byteOffset ?? 0, value.byteLength);
const join = (...values) => { const out = new Uint8Array(values.reduce((n, a) => n + a.length, 0)); let p = 0; for (const a of values) { out.set(a, p); p += a.length; } return out; };
const varint = n => { const out = []; do { out.push((n & 127) | (n > 127 ? 128 : 0)); n = Math.floor(n / 128); } while (n); return new Uint8Array(out); };
export const protoInt = (field, n) => join(varint(field * 8), varint(n));
export const protoBytes = (field, data) => join(varint(field * 8 + 2), varint(data.length), data);
export function decodeProto(data) {
  data = bytes(data); if (data.length > 512) throw new Error('配网消息过大。');
  let p = 0; const result = new Map();
  const read = () => { let v = 0, shift = 0; for (let i = 0; i < 5 && p < data.length; i++) { const n = data[p++]; v += (n & 127) * 2 ** shift; if (!(n & 128)) return v; shift += 7; } throw new Error('配网 protobuf 不完整。'); };
  while (p < data.length) { const tag = read(), key = Math.floor(tag / 8); if (!key || result.has(key)) throw new Error('重复或无效的配网字段。'); if (tag % 8 === 0) result.set(key, read()); else if (tag % 8 === 2) { const n = read(); if (p + n > data.length) throw new Error('配网字段截断。'); result.set(key, data.slice(p, p + n)); p += n; } else throw new Error('不支持的配网字段类型。'); }
  return result;
}
export function sessionPacket(type, payloadField, payload) { return join(protoInt(2, 1), protoBytes(11, join(type ? protoInt(1, type) : new Uint8Array(), protoBytes(payloadField, payload)))); }
export function sessionResponse(data, expectedType, expectedField) {
  const outer = decodeProto(data); if (outer.get(2) !== 1 || !(outer.get(11) instanceof Uint8Array)) throw new Error('设备未使用 Security 1。');
  const sec = decodeProto(outer.get(11)); if (sec.get(1) !== expectedType || !(sec.get(expectedField) instanceof Uint8Array)) throw new Error('配网会话顺序错误。');
  const reply = decodeProto(sec.get(expectedField)); if ((reply.get(1) ?? 0) !== 0) throw new Error('配网码验证失败。'); return reply;
}
// IDF uses one continuous bidirectional CTR stream, including two proofs.
// WebCrypto calls are stateless: preserve byte offset, including partial blocks.
export class CtrStream {
  constructor(key, iv, subtle = globalThis.crypto.subtle) { this.key = key; this.iv = bytes(iv).slice(); this.offset = 0; this.subtle = subtle; }
  async apply(input) {
    input = bytes(input); const counter = this.iv.slice(); let carry = BigInt(Math.floor(this.offset / 16));
    for (let i = 15; i >= 0; i--) { carry += BigInt(counter[i]); counter[i] = Number(carry & 255n); carry >>= 8n; }
    if (carry) throw new Error('配网加密计数器耗尽。');
    const skip = this.offset % 16, zeros = new Uint8Array(skip + input.length);
    const stream = new Uint8Array(await this.subtle.encrypt({ name: 'AES-CTR', counter, length: 128 }, this.key, zeros));
    const out = input.map((v, i) => v ^ stream[skip + i]); this.offset += input.length; stream.fill(0); return out;
  }
}
export async function establishSecurity1(exchange, proof, subtle = globalThis.crypto.subtle) {
  if (!/^[a-f0-9]{32}$/i.test(proof)) throw new Error('请输入设备显示的 32 位配网码。');
  const pair = await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const first = sessionResponse(await exchange(sessionPacket(0, 20, protoBytes(1, pub))), 1, 21);
  const remote = first.get(2), iv = first.get(3); if (remote?.length !== 32 || iv?.length !== 16) throw new Error('设备会话参数无效。');
  const remoteKey = await subtle.importKey('raw', remote, { name: 'X25519' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: remoteKey }, pair.privateKey, 256));
  const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(proof.toLowerCase())));
  shared.forEach((v, i) => { shared[i] = v ^ digest[i]; });
  const aes = await subtle.importKey('raw', shared, 'AES-CTR', false, ['encrypt']); shared.fill(0); digest.fill(0);
  const cipher = new CtrStream(aes, iv, subtle);
  const verification = await cipher.apply(remote);
  const second = sessionResponse(await exchange(sessionPacket(2, 22, protoBytes(2, verification))), 3, 23);
  if (second.get(3)?.length !== 32) throw new Error('设备身份验证无效。');
  const verified = await cipher.apply(second.get(3)); let diff = 0; for (let i = 0; i < 32; i++) diff |= verified[i] ^ pub[i];
  if (diff) throw new Error('配网码不匹配，无法验证设备。');
  return cipher;
}
