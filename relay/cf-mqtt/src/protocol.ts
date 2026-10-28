/** Restricted MQTT 3.1.1 RPC transport; it is not a general-purpose broker. */
export const MAX_PACKET_BYTES = 8704;
export const MAX_REQUEST_BYTES = 8192;
export const MAX_REPLY_BYTES = 2048;
export const NODE = /^[a-z0-9_-]{1,15}$/;
export const BOOT = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type Operation = 'contact' | 'config' | 'activation' | 'ingest';
export class ProtocolError extends Error { constructor() { super('Invalid MQTT packet'); } }
export function requireProtocol(ok: unknown): asserts ok { if (!ok) throw new ProtocolError(); }
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export interface Packet { header: number; body: Uint8Array; }

/** One bounded accumulator. Handles split fixed/remaining headers and bodies. */
export class PacketStream {
  private buffer = new Uint8Array(0);
  get partial(): boolean { return this.buffer.length !== 0; }
  feed(bytes: Uint8Array): Packet[] {
    requireProtocol(bytes.length > 0 && bytes.length <= MAX_PACKET_BYTES);
    requireProtocol(this.buffer.length + bytes.length <= MAX_PACKET_BYTES * 2);
    const all = new Uint8Array(this.buffer.length + bytes.length);
    all.set(this.buffer); all.set(bytes, this.buffer.length);
    const packets: Packet[] = [];
    let start = 0;
    while (start < all.length) {
      let end = start + 1, size = 0, shift = 0, complete = false;
      while (end < all.length) {
        const byte = all[end++];
        size += (byte & 127) * 2 ** shift;
        requireProtocol(size <= MAX_PACKET_BYTES - 2);
        if (!(byte & 128)) {
          requireProtocol(shift === 0 || byte !== 0); // shortest Remaining Length
          complete = true; break;
        }
        shift += 7;
        requireProtocol(shift < 28);
      }
      if (!complete) break;
      requireProtocol(end - start + size <= MAX_PACKET_BYTES);
      if (end + size > all.length) break;
      packets.push({ header: all[start], body: all.slice(end, end + size) });
      requireProtocol(packets.length <= 32);
      start = end + size;
    }
    this.buffer = all.slice(start);
    requireProtocol(this.buffer.length <= MAX_PACKET_BYTES);
    return packets;
  }
}

class Reader {
  offset = 0;
  constructor(readonly body: Uint8Array) {}
  byte(): number { requireProtocol(this.offset < this.body.length); return this.body[this.offset++]; }
  u16(): number { return this.byte() * 256 + this.byte(); }
  text(): string {
    const size = this.u16();
    requireProtocol(size > 0 && this.offset + size <= this.body.length);
    let value: string;
    try { value = decoder.decode(this.body.subarray(this.offset, this.offset + size)); }
    catch { throw new ProtocolError(); }
    this.offset += size;
    // MQTT disallows NUL and surrogate code points; the narrower ASCII identity
    // and topic contract below additionally excludes all controls/noncharacters.
    requireProtocol(!/[\u0000-\u001f\u007f-\u009f\ufdd0-\ufdef\ufffe\uffff]/u.test(value));
    return value;
  }
  done(): void { requireProtocol(this.offset === this.body.length); }
}

export function parseConnect(packet: Packet, node: string): { boot: string; keepAlive: number } {
  requireProtocol(packet.header === 0x10);
  const r = new Reader(packet.body);
  requireProtocol(r.text() === 'MQTT' && r.byte() === 4 && r.byte() === 0x82);
  const keepAlive = r.u16();
  requireProtocol(keepAlive === 30 || keepAlive === 60);
  const client = r.text(), username = r.text(); r.done();
  const prefix = node + ':';
  requireProtocol(username === node && client.startsWith(prefix));
  const boot = client.slice(prefix.length);
  requireProtocol(BOOT.test(boot));
  return { boot, keepAlive };
}

export function prefix(node: string, boot: string): string { return `cp/v1/${node}/${boot}`; }
export function parseSubscribe(packet: Packet, node: string, boot: string): number {
  requireProtocol(packet.header === 0x82);
  const r = new Reader(packet.body), id = r.u16();
  requireProtocol(id > 0 && r.text() === `${prefix(node, boot)}/rep/+/+`);
  // Subscription QoS 0 or 1 is accepted; the granted maximum is always QoS 0.
  requireProtocol(r.byte() <= 1); r.done(); return id;
}
export interface Rpc { op: Operation; rpc: number; id: number; dup: boolean; body: Uint8Array; topic: string; }
export function parsePublish(packet: Packet, node: string, boot: string): Rpc {
  requireProtocol(packet.header === 0x32 || packet.header === 0x3a);
  const r = new Reader(packet.body), topic = r.text(), id = r.u16();
  requireProtocol(id > 0 && topic.startsWith(`${prefix(node, boot)}/req/`));
  const suffix = topic.slice(`${prefix(node, boot)}/req/`.length);
  const match = /^(contact|config|activation|ingest)\/([1-9][0-9]{0,9})$/.exec(suffix);
  requireProtocol(match);
  const op = match[1] as Operation, rpc = Number(match[2]);
  requireProtocol(rpc <= 0xffffffff);
  const body = packet.body.slice(r.offset);
  requireProtocol(body.length <= MAX_REQUEST_BYTES && (op !== 'config' || body.length === 0));
  return { op, rpc, id, dup: packet.header === 0x3a, body, topic };
}

export function packet(header: number, body: Uint8Array): Uint8Array {
  const length: number[] = [];
  let remaining = body.length;
  do { const digit = remaining % 128; remaining = Math.floor(remaining / 128); length.push(digit | (remaining ? 128 : 0)); } while (remaining);
  const out = new Uint8Array(1 + length.length + body.length);
  out[0] = header; out.set(length, 1); out.set(body, 1 + length.length); return out;
}
export function idPacket(header: number, id: number, extra: number[] = []): Uint8Array {
  return packet(header, new Uint8Array([id >> 8, id & 255, ...extra]));
}
export function reply(topic: string, status: number, body: Uint8Array): Uint8Array {
  requireProtocol(body.length <= MAX_REPLY_BYTES && status >= 100 && status <= 599);
  const encoded = encoder.encode(topic.replace('/req/', '/rep/'));
  const payload = new Uint8Array(encoded.length + body.length + 4);
  payload[0] = encoded.length >> 8; payload[1] = encoded.length & 255;
  payload.set(encoded, 2); payload[encoded.length + 2] = status >> 8; payload[encoded.length + 3] = status & 255;
  payload.set(body, encoded.length + 4);
  return packet(0x30, payload);
}
