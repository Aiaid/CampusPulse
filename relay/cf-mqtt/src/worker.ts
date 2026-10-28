import { DurableObject } from 'cloudflare:workers';
// Reuse the exact existing credential SHA-256/enabled/origin checks, read-only.
import { device } from '../../../worker/ingest';
import { IngestError } from '../../../worker/ingest-validation';
import {
  MAX_PACKET_BYTES, MAX_REPLY_BYTES, NODE, PacketStream, ProtocolError,
  idPacket, packet, parseConnect, parsePublish, parseSubscribe, reply, requireProtocol,
  type Packet, type Rpc,
} from './protocol';

const ORIGIN = 'https://pulse.anend.net';
const PARTIAL_MS = 5000;
const BACKEND_MS = 15000;
const PATHS = {
  contact: '/api/v2/device/contact', config: '/api/v2/device/config',
  activation: '/api/v2/device/config/ack', ingest: '/api/v2/ingest',
} as const;
const encoder = new TextEncoder();
interface Sealed { iv: string; ciphertext: string; }
interface Attachment {
  version: 1; node: string; session: string; token: Sealed;
  boot: string | null; keepAlive: number; subscribed: boolean; lastActivity: number;
  partial: boolean; pending: boolean;
  lastRpc: number; lastHash: string; lastOp: string; lastId: number;
  rateStart: number; frames: number; bytes: number; requests: number;
}
interface Connection { state: Attachment; stream: PacketStream; timer?: ReturnType<typeof setTimeout>; }
interface Pending { socket: WebSocket; request: Rpc; }

function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function unbase64(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
async function wrappingKey(secret: string): Promise<CryptoKey> {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(secret)) throw new Error('Key unavailable');
  const bytes = unbase64(secret);
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(token: string, key: CryptoKey, context: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, key, encoder.encode(token));
  return { iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
}
async function unseal(state: Attachment, secret: string): Promise<string> {
  const value = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(state.token.iv), additionalData: encoder.encode(`${state.node}:${state.session}`) }, await wrappingKey(secret), unbase64(state.token.ciphertext));
  const token = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);
  if (!/^Bearer [!-~]{16,256}$/.test(token)) throw new Error('Invalid session');
  return token;
}
async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
async function readBounded(response: Response): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.length;
      if (total > MAX_REPLY_BYTES) throw new Error('Response limit');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
function errorResponse(status: number): Response {
  return Response.json({ error: 'mqtt_gateway_rejected' }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/mqtt' || url.search) return errorResponse(404);
    if (request.method !== 'GET') return errorResponse(405);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return errorResponse(426);
    if (request.headers.get('Sec-WebSocket-Protocol') !== 'mqtt') return errorResponse(400);
    try {
      const node = await device(request, env);
      if (!NODE.test(node)) return errorResponse(403);
      const session = crypto.randomUUID();
      const token = await seal(request.headers.get('Authorization')!, await wrappingKey(env.SESSION_WRAP_KEY), `${node}:${session}`);
      // Build a new request: no client-chosen node, forwarding or origin headers
      // cross this boundary. Raw authorization never enters the DO request.
      return await env.MQTT_SESSIONS.getByName(node, { locationHint: 'apac' }).fetch(new Request('https://mqtt.internal/mqtt', {
        headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'mqtt',
          'X-CP-Node': node, 'X-CP-Session': session, 'X-CP-Sealed': JSON.stringify(token) },
      }));
    } catch (error) {
      return errorResponse(error instanceof IngestError ? error.status : 503);
    }
  },
} satisfies ExportedHandler<Env>;

export class MqttSession extends DurableObject<Env> {
  private connections = new Map<WebSocket, Connection>();
  private pending?: Pending;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setHibernatableWebSocketEventTimeout(BACKEND_MS + 2000);
    for (const socket of this.ctx.getWebSockets()) {
      const state = socket.deserializeAttachment() as Attachment | null;
      if (!state || state.version !== 1 || state.partial || state.pending) {
        // Normal hibernation cannot interrupt a pending timer/I/O. A forced
        // restart may; close rather than treating lost RAM as a complete packet
        // or inventing a durable receipt. Frozen batch retry remains safe.
        socket.close(1012, 'Reconnect');
      } else this.connections.set(socket, { state, stream: new PacketStream() });
    }
  }
  async fetch(request: Request): Promise<Response> {
    if (request.url !== 'https://mqtt.internal/mqtt' || request.headers.get('Upgrade') !== 'websocket') return errorResponse(404);
    const node = request.headers.get('X-CP-Node') ?? '', session = request.headers.get('X-CP-Session') ?? '';
    if (!NODE.test(node) || session.length !== 36) return errorResponse(403);
    const state: Attachment = {
      version: 1, node, session, token: JSON.parse(request.headers.get('X-CP-Sealed') ?? 'null') as Sealed,
      boot: null, keepAlive: 30, subscribed: false, lastActivity: Date.now(),
      partial: false, pending: false, lastRpc: 0, lastHash: '', lastOp: '', lastId: 0,
      rateStart: Date.now(), frames: 0, bytes: 0, requests: 0,
    };
    try { await unseal(state, this.env.SESSION_WRAP_KEY); } catch { return errorResponse(403); }
    // A replacement connection cannot race the previous request into the backend.
    if (this.pending) return errorResponse(409);
    for (const old of this.connections.keys()) this.close(old, 1000);
    const pair = new WebSocketPair(), client = pair[0], socket = pair[1];
    this.ctx.acceptWebSocket(socket);
    this.connections.set(socket, { state, stream: new PacketStream() });
    this.save(socket, state);
    await this.ctx.storage.setAlarm(Date.now() + 10000); // bounded CONNECT deadline
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'mqtt' } });
  }
  private save(socket: WebSocket, state: Attachment): void { socket.serializeAttachment(state); }
  private close(socket: WebSocket, code = 1008): void {
    const connection = this.connections.get(socket);
    if (connection?.timer) clearTimeout(connection.timer);
    this.connections.delete(socket);
    try { socket.close(code, code === 1000 ? 'Closed' : 'Reconnect'); } catch { /* already disconnected */ }
  }
  private send(socket: WebSocket, bytes: Uint8Array): void {
    if (this.connections.has(socket)) socket.send(bytes);
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const connection = this.connections.get(socket); if (!connection) return;
    const state = connection.state;
    try {
      requireProtocol(message instanceof ArrayBuffer && message.byteLength <= MAX_PACKET_BYTES);
      if (Date.now() - state.rateStart >= 60000) {
        state.rateStart = Date.now(); state.frames = 0; state.bytes = 0; state.requests = 0;
      }
      state.frames++; state.bytes += message.byteLength;
      requireProtocol(state.frames <= 4096 && state.bytes <= 4 * 1024 * 1024);
      const packets = connection.stream.feed(new Uint8Array(message));
      state.partial = connection.stream.partial;
      if (state.partial && !connection.timer) {
        connection.timer = setTimeout(() => this.close(socket), PARTIAL_MS);
      } else if (!state.partial && connection.timer) {
        clearTimeout(connection.timer); connection.timer = undefined;
      }
      this.save(socket, state);
      for (const current of packets) {
        if (!this.connections.has(socket)) break;
        if (state.boot && Date.now() - state.lastActivity > state.keepAlive * 1500) throw new ProtocolError();
        state.lastActivity = Date.now(); this.save(socket, state);
        await this.handlePacket(socket, connection, current);
      }
    } catch { this.close(socket); }
  }
  private async handlePacket(socket: WebSocket, connection: Connection, current: Packet): Promise<void> {
    const state = connection.state;
    if (!state.boot) {
      const { boot, keepAlive } = parseConnect(current, state.node);
      state.boot = boot; state.keepAlive = keepAlive; this.save(socket, state);
      this.send(socket, packet(0x20, new Uint8Array([0, 0]))); return;
    }
    switch (current.header >> 4) {
      case 8: {
        const id = parseSubscribe(current, state.node, state.boot);
        state.subscribed = true; this.save(socket, state);
        this.send(socket, idPacket(0x90, id, [0])); return;
      }
      case 12:
        requireProtocol(current.header === 0xc0 && current.body.length === 0);
        this.send(socket, packet(0xd0, new Uint8Array())); return;
      case 14:
        requireProtocol(current.header === 0xe0 && current.body.length === 0);
        this.close(socket, 1000); return;
      case 3:
        requireProtocol(state.subscribed);
        await this.forward(socket, state, parsePublish(current, state.node, state.boot)); return;
      default: throw new ProtocolError();
    }
  }
  private async forward(socket: WebSocket, state: Attachment, rpc: Rpc): Promise<void> {
    requireProtocol(++state.requests <= 600);
    if (this.pending) {
      const previous = this.pending;
      requireProtocol(previous.socket === socket && rpc.dup && rpc.rpc === previous.request.rpc &&
        rpc.id === previous.request.id && rpc.topic === previous.request.topic && equal(rpc.body, previous.request.body));
      this.send(socket, idPacket(0x40, rpc.id)); return;
    }
    // Reserve before the first await so separate WS messages cannot start two RPCs.
    const pending: Pending = { socket, request: rpc }; this.pending = pending;
    state.pending = true; this.save(socket, state);
    try {
      const hash = await sha256(new Uint8Array(rpc.body));
      requireProtocol(rpc.rpc > state.lastRpc || (rpc.dup && rpc.rpc === state.lastRpc &&
        state.lastHash === hash && state.lastOp === rpc.op && state.lastId === rpc.id));
      state.lastRpc = rpc.rpc; state.lastHash = hash; state.lastOp = rpc.op; state.lastId = rpc.id;
      this.save(socket, state);
      if (!this.connections.has(socket)) return;
      // This only acknowledges MQTT delivery. The application MUST await and
      // validate the HTTP-status + original CF receipt before releasing a batch.
      this.send(socket, idPacket(0x40, rpc.id));
      const authorization = await unseal(state, this.env.SESSION_WRAP_KEY);
      if (!this.connections.has(socket)) return;
      const abort = new AbortController(); let timeout: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => { abort.abort(); reject(new Error('Backend deadline')); }, BACKEND_MS);
      });
      try {
        const work = async (): Promise<{ status: number; body: Uint8Array }> => {
          const response = await this.env.INGEST_SERVICE.fetch(new Request(ORIGIN + PATHS[rpc.op], {
            method: rpc.op === 'config' ? 'GET' : 'POST',
            headers: { Authorization: authorization, ...(rpc.op === 'config' ? {} : { 'Content-Type': 'application/json' }),
              ...(rpc.op === 'ingest' ? { 'X-Body-SHA256': hash } : {}) },
            body: rpc.op === 'config' ? undefined : new Uint8Array(rpc.body),
            redirect: 'manual', signal: abort.signal,
          }));
          return { status: response.status, body: await readBounded(response) };
        };
        const result = await Promise.race([work(), timedOut]);
        this.send(socket, reply(rpc.topic, result.status, result.body));
        if (result.status === 401 || result.status === 403) this.close(socket);
      } catch {
        // 504 says the outcome is unknown. The backend may have committed;
        // only its retried, validated receipt establishes durability.
        abort.abort();
        this.send(socket, reply(rpc.topic, 504, encoder.encode('{"error":"gateway_outcome_unknown"}')));
      } finally { if (timeout) clearTimeout(timeout); }
    } finally {
      if (this.pending === pending) this.pending = undefined;
      state.pending = false;
      if (this.connections.has(socket)) this.save(socket, state);
    }
  }
  async alarm(): Promise<void> {
    const now = Date.now(); let next = Infinity;
    for (const [socket, connection] of this.connections) {
      const state = connection.state;
      const deadline = state.lastActivity + (state.boot ? state.keepAlive * 1500 : 10000);
      if (deadline <= now) this.close(socket); else next = Math.min(next, deadline);
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
  }
  webSocketClose(socket: WebSocket): void { this.close(socket, 1000); }
  webSocketError(socket: WebSocket): void { this.close(socket); }
}
