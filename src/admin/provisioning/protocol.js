// Bounded protobuf subset used by the pinned ESP-IDF protocomm session schema.
export const bytes = value => new Uint8Array(value.buffer ?? value, value.byteOffset ?? 0, value.byteLength);
export const join = (...values) => { const out = new Uint8Array(values.reduce((n, a) => n + a.length, 0)); let p = 0; for (const a of values) { out.set(a, p); p += a.length; } return out; };
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
export function sessionPacket(type, payloadField, payload) { return join(protoInt(2, 2), protoBytes(12, join(type ? protoInt(1, type) : new Uint8Array(), protoBytes(payloadField, payload)))); }
export function sessionResponse(data, expectedType, expectedField) {
  const outer = decodeProto(data); if (outer.get(2) !== 2 || outer.size !== 2 || !(outer.get(12) instanceof Uint8Array)) throw new Error('设备未使用 Security 2，请更新固件或选择 USB 配网。');
  const sec = decodeProto(outer.get(12)); if (sec.get(1) !== expectedType || sec.size !== 2 || !(sec.get(expectedField) instanceof Uint8Array)) throw new Error('配网会话顺序错误。');
  const reply = decodeProto(sec.get(expectedField)); if ((reply.get(1) ?? 0) !== 0) throw new Error('配网码验证失败或已过期，请检查设备。'); return reply;
}
export class ProvisioningError extends Error { constructor(reason) { super(reason); this.code = reason; } }
export function checkedReply(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.v !== 1 || typeof data.ok !== 'boolean') throw new Error('设备响应格式无效。');
  if (!data.ok) throw new ProvisioningError(typeof data.reason === 'string' && /^[a-z_]{1,64}$/.test(data.reason) ? data.reason : 'device_rejected');
  return data;
}
