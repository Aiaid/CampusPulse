import { checkedReply } from './protocol.js';
export const SERIAL_PREFIX = '\x1eCPSETUP/1 ';
export const SERIAL_MAX_JSON = 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();
export function serialSupport(nav = globalThis.navigator) { return !!(globalThis.isSecureContext && nav?.serial?.requestPort && globalThis.crypto?.randomUUID); }
// Must execute in the click handler, before an await or an API request.
export function selectProvisioningPort(nav = globalThis.navigator) { return nav.serial.requestPort(); }
export function serialFrame(id, body) {
  if (!UUID.test(id)) throw new Error('USB 请求标识无效。');
  const json = JSON.stringify(body), data = encoder.encode(json);
  if (!body || typeof body !== 'object' || Array.isArray(body) || data.length > SERIAL_MAX_JSON) throw new Error('USB 配网请求超过 1024 字节限制。');
  return encoder.encode(`${SERIAL_PREFIX}${id} ${json}\n`);
}
// Byte-bounded state machine: unrelated logs are discarded without retaining
// or exposing them. A new RS recovers from interrupted/oversized console lines.
export class SerialFrames {
  constructor(onFrame) { this.onFrame = onFrame; this.buffer = new Uint8Array(SERIAL_PREFIX.length + 36 + 1 + SERIAL_MAX_JSON); this.length = 0; this.active = false; }
  push(input) {
    for (const byte of input) {
      if (byte === 30) { this.buffer.fill(0); this.buffer[0] = byte; this.length = 1; this.active = true; continue; }
      if (!this.active) continue;
      if (byte === 10) {
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(0, this.length));
          if (text.startsWith(SERIAL_PREFIX)) {
            const id = text.slice(SERIAL_PREFIX.length, SERIAL_PREFIX.length + 36), separator = SERIAL_PREFIX.length + 36;
            if (UUID.test(id) && text[separator] === ' ') {
              let body; try { body = JSON.parse(text.slice(separator + 1)); } catch { /* Reply with a generic parse failure, never raw console data. */ }
              this.onFrame(id, body);
            }
          }
        } catch { /* Ignore malformed UTF-8; bounded request timeout handles it. */ }
        this.buffer.fill(0); this.length = 0; this.active = false;
      } else if (this.length < this.buffer.length) this.buffer[this.length++] = byte;
      else { this.buffer.fill(0); this.length = 0; this.active = false; }
    }
  }
  clear() { this.buffer.fill(0); this.length = 0; this.active = false; }
}
export async function openSerialClient(port, { timeoutMs = 8000, onDisconnect = () => {} } = {}) {
  await port.open({ baudRate: 115200, bufferSize: 4096 });
  let reader, writer;
  try { reader = port.readable.getReader(); writer = port.writable.getWriter(); }
  catch { await port.close().catch(() => {}); throw new Error('USB 串口无法读取或写入，请关闭其他串口程序。'); }
  let pending = null, closed = false, busy = false, loop, closing;
  const failPending = () => { if (pending) { clearTimeout(pending.timer); pending.reject(new Error('USB 连接已断开，请检查设备后重新连接。')); pending = null; } };
  const frames = new SerialFrames((id, body) => {
    if (id !== pending?.id) return;
    const current = pending; pending = null; clearTimeout(current.timer);
    try { current.resolve(checkedReply(body)); } catch (error) { current.reject(error); }
  });
  const client = {
    transport: 'usb',
    close() {
      if (closing) return closing;
      closed = true; failPending(); frames.clear();
      closing = (async () => { await reader.cancel().catch(() => {}); await loop; writer.releaseLock(); await port.close().catch(() => {}); })();
      return closing;
    },
    async request(body) {
      if (closed || busy) throw new Error('USB 会话忙或已关闭，请等待当前请求完成。');
      const id = crypto.randomUUID(), frame = serialFrame(id, { v: 1, ...body });
      busy = true;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { if (pending?.id === id) { pending = null; reject(new Error('USB 请求超时；请先检查设备状态，再决定是否重试。')); } }, timeoutMs);
        pending = { id, resolve, reject, timer };
      });
      // Install rejection handling immediately, including while writer.write waits.
      const write = writer.write(frame).catch(() => { failPending(); throw new Error('USB 写入失败，请重新连接。'); }).finally(() => frame.fill(0));
      try { const [, result] = await Promise.all([write, response]); return result; } finally { busy = false; }
    },
  };
  loop = (async () => {
    try { while (!closed) { const { value, done } = await reader.read(); if (done) break; frames.push(value); } }
    catch { /* Transport errors carry no captured console contents. */ }
    finally { reader.releaseLock(); if (!closed) { failPending(); onDisconnect(); void client.close(); } }
  })();
  return client;
}
export async function connectSerialProvisioning(port, options = {}) {
  const { readyTimeoutMs = 30000, pollMs = 300, ...transportOptions } = options;
  const client = await openSerialClient(port, transportOptions);
  try {
    const begin = await client.request({ op: 'begin' });
    if (begin.state !== 'starting') throw new Error('设备没有确认进入 USB 配网模式。');
    const deadline = Date.now() + readyTimeoutMs; let identity;
    do {
      try { identity = await client.request({ op: 'info' }); break; }
      catch (error) { if (!['setup_not_ready', 'session_busy'].includes(error.code)) throw error; }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    } while (Date.now() < deadline);
    if (!identity || !/^cp_[a-f0-9]{12}$/.test(identity.node_id) || identity.transport !== 'usb' || identity.security !== 'physical-usb' || !/^[a-f0-9]{32}$/.test(identity.nonce)) throw new Error('USB 配网尚未准备好或设备身份无效，请检查设备后重试。');
    let nonce = identity.nonce, configuring = false;
    return { identity, client: {
      transport: 'usb', close: () => { nonce = ''; return client.close(); },
      async request(body) {
        if (configuring) throw new Error('USB 会话忙，请等待当前请求完成。');
        if (body.op !== 'configure') return client.request(body);
        configuring = true;
        try {
          // Failed validation starts a fresh local session and rotates its nonce.
          // Re-read readiness before every candidate; never reuse a stale nonce
          // or write an existing cloud credential to a different factory node.
          const current = await client.request({ op: 'info' });
          if (current.node_id !== identity.node_id || body.node_id !== identity.node_id || current.transport !== 'usb' || current.security !== 'physical-usb' || !/^[a-f0-9]{32}$/.test(current.nonce)) {
            await client.close(); throw new Error('USB 设备身份或会话已变化，请核对现场设备后重新开始。');
          }
          nonce = current.nonce;
          return await client.request({ ...body, nonce });
        } finally { configuring = false; }
      },
    } };
  } catch (error) { await client.close(); throw error; }
}
