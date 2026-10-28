import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as miniflare from 'miniflare';
import { createRequire } from 'node:module';
import worker from './worker.mjs';
const require = createRequire(import.meta.url);
const PROTOCOL = 'cp-link-probe/1';
const LIMITS = { maxMessages: 256 };

const token = randomBytes(32).toString('hex');
const auth = { Authorization: `Bearer ${token}` };
let mf;
let noSecret;
const requestedDate = '2026-10-27';
const utcDate = new Date().toISOString().slice(0, 10);
const buildStamp = require('workerd/package.json').version.match(/\.(\d{4})(\d{2})(\d{2})\./);
const binaryDate = buildStamp ? `${buildStamp[1]}-${buildStamp[2]}-${buildStamp[3]}` : requestedDate;
const runtimeDate = [utcDate, requestedDate, binaryDate].sort()[0];
before(async () => {
  if (runtimeDate !== requestedDate) console.info(`Local workerd compatibility date: ${runtimeDate}; deployment date ${requestedDate}. Local binary/UTC ceiling applied.`);
  const opts = {
    modules: true,
    scriptPath: fileURLToPath(new URL('./worker.mjs', import.meta.url)),
    compatibilityDate: runtimeDate,
  };
  // Miniflare 5 beta provides an explicit converter for the stable v4 options.
  const convert = miniflare.convertV4MiniflareOptions ?? ((options) => options);
  mf = new miniflare.Miniflare(convert({ ...opts, bindings: { PROBE_TOKEN: token } }));
  noSecret = new miniflare.Miniflare(convert(opts));
  await Promise.all([mf.ready, noSecret.ready]);
});
after(async () => { await Promise.all([mf?.dispose(), noSecret?.dispose()]); });

function body(size, seq = 0) {
  const bytes = Buffer.alloc(size, 0xa5);
  Buffer.from('00112233445566778899aabbccddeeff', 'hex').copy(bytes);
  bytes.writeUInt32BE(seq, 16);
  return bytes;
}
function post(bytes, headers = {}) {
  return mf.dispatchFetch('https://probe.test/benchmark', {
    method: 'POST', body: bytes, duplex: 'half',
    headers: { ...auth, 'Content-Type': 'application/octet-stream', ...headers },
  });
}
function checkReceipt(ack, bytes) {
  assert.equal(ack.protocol, PROTOCOL);
  assert.equal(ack.kind, 'transport_received');
  assert.equal(ack.run_id, '00112233445566778899aabbccddeeff');
  assert.equal(ack.seq, bytes.readUInt32BE(16));
  assert.equal(ack.bytes, bytes.length);
  assert.equal(ack.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.match(ack.connection_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(typeof ack.colo, 'string');
  assert.deepEqual(Object.keys(ack).sort(), ['protocol', 'kind', 'run_id', 'seq', 'bytes', 'sha256', 'connection_id', 'colo'].sort());
}
function next(socket, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener(name, handler); reject(new Error(`Timed out waiting for ${name}`)); }, 3000);
    const handler = (event) => { clearTimeout(timer); resolve(event); };
    socket.addEventListener(name, handler, { once: true });
  });
}
async function connect() {
  const response = await mf.dispatchFetch('https://probe.test/ws', { headers: { ...auth, Upgrade: 'websocket' } });
  assert.equal(response.status, 101);
  const socket = response.webSocket;
  socket.accept();
  return socket;
}
async function send(socket, bytes) {
  const incoming = next(socket, 'message');
  socket.send(bytes);
  return JSON.parse((await incoming).data);
}

test('auth fails closed before HTTP body or websocket upgrade', async () => {
  for (const Authorization of ['', 'Bearer wrong', `Basic ${token}`, `Bearer ${token}x`]) {
    const response = await mf.dispatchFetch('https://probe.test/ws', { headers: { Authorization, Upgrade: 'websocket' } });
    assert.equal(response.status, 401);
    assert.equal(response.webSocket, null);
  }
  const response = await noSecret.dispatchFetch('https://probe.test/benchmark', { method: 'POST', headers: auth, body: body(1024) });
  assert.equal(response.status, 401);
});

test('HTTP exact receipts, unsigned maximum seq, unique request IDs and fixed Content-Length', async () => {
  const ids = [];
  for (const size of [1024, 8192]) {
    const bytes = body(size, 0xffffffff);
    const response = await post(bytes);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Cache-Control'), /no-store/);
    const text = await response.text();
    assert.equal(Number(response.headers.get('Content-Length')), Buffer.byteLength(text), JSON.stringify([...response.headers]));
    const ack = JSON.parse(text);
    checkReceipt(ack, bytes);
    ids.push(ack.connection_id);
  }
  assert.notEqual(ids[0], ids[1]);
});

test('HTTP rejects wrong size/type/encoding, routes/methods and query credentials', async () => {
  for (const size of [0, 20, 1023, 1025, 8191, 8193, 65536]) {
    assert.equal((await post(body(size < 20 ? 20 : size).subarray(0, size))).status, size > 8192 ? 413 : 400);
  }
  assert.equal((await post(body(1024), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(body(1024), { 'Content-Encoding': 'gzip' })).status, 415);
  for (const [path, method, status] of [['/benchmark', 'GET', 405], ['/ws', 'GET', 426], ['/ws', 'POST', 405], ['/missing', 'GET', 404], ['/ws?token=x', 'GET', 400]]) {
    assert.equal((await mf.dispatchFetch(`https://probe.test${path}`, { method, headers: auth })).status, status);
  }
  assert.equal((await mf.dispatchFetch(`https://probe.test/ws?token=${token}`, { headers: { Upgrade: 'websocket' } })).status, 401);
});

test('HTTP streaming size is bounded without Content-Length', async () => {
  let calls = 0;
  const stream = new ReadableStream({ pull(controller) { calls += 1; controller.enqueue(new Uint8Array(1024)); if (calls === 10) controller.close(); } });
  const response = await post(stream);
  assert.equal(response.status, 413);
});

test('WS reuses one connection ID for 60 mixed-size receipts, closes and reconnects with a new ID', async () => {
  const socket = await connect();
  let id;
  for (let seq = 0; seq < 60; seq += 1) {
    const bytes = body(seq % 2 ? 8192 : 1024, seq);
    const ack = await send(socket, bytes);
    checkReceipt(ack, bytes);
    id ??= ack.connection_id;
    assert.equal(ack.connection_id, id);
  }
  const close = next(socket, 'close');
  const closing = await send(socket, 'close-for-test');
  assert.deepEqual(closing, { protocol: PROTOCOL, kind: 'closing', connection_id: id });
  assert.equal((await close).code, 1000);
  const again = await connect();
  assert.notEqual((await send(again, body(1024))).connection_id, id);
  again.close(1000);
});

test('WS fails closed on text and invalid/large frames', async () => {
  for (const [payload, code] of [['hello', 1003], [body(1023), 1008], [body(8193), 1009]]) {
    const socket = await connect();
    const closed = next(socket, 'close');
    socket.send(payload);
    assert.equal((await closed).code, code, `invalid payload expected close ${code}`);
  }
});

test('overlapping WS handlers close without queuing or later ACK (controlled digest delay)', async () => {
  // Network delivery may serialize tiny workerd digests. Delay only the packet
  // digest here to exercise the defensive overlap branch deterministically.
  const realCrypto = globalThis.crypto;
  const descriptors = Object.fromEntries(['crypto', 'WebSocketPair', 'Response'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const handlers = new Map();
  const sent = [];
  const closes = [];
  let finishHash;
  const server = {
    accept() {}, addEventListener(name, callback) { handlers.set(name, callback); },
    send(message) { sent.push(message); }, close(code, reason) { closes.push({ code, reason }); },
  };
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    randomUUID: () => realCrypto.randomUUID(),
    subtle: {
      timingSafeEqual: (a, b) => Buffer.from(a).equals(Buffer.from(b)),
      digest: (algorithm, bytes) => bytes.byteLength === 8192
        ? new Promise((resolve) => { finishHash = () => resolve(new Uint8Array(32).buffer); })
        : realCrypto.subtle.digest(algorithm, bytes),
    },
  } });
  Object.defineProperty(globalThis, 'WebSocketPair', { configurable: true, value: class { constructor() { return { 0: {}, 1: server }; } } });
  Object.defineProperty(globalThis, 'Response', { configurable: true, value: class { constructor(_, init) { this.status = init.status; } } });
  try {
    assert.equal((await worker.fetch(new Request('https://probe.test/ws', { headers: { ...auth, Upgrade: 'websocket' } }), { PROBE_TOKEN: token })).status, 101);
    handlers.get('message')({ data: body(8192).buffer.slice(0) });
    handlers.get('message')({ data: body(8192).buffer.slice(0) });
    assert.deepEqual(closes, [{ code: 1008, reason: 'pipelining_not_allowed' }]);
    finishHash();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, []);
  } finally {
    handlers.get('close')?.();
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test('WS closes after bounded session message count', async () => {
  const socket = await connect();
  const closed = next(socket, 'close');
  for (let seq = 0; seq < LIMITS.maxMessages; seq += 1) {
    checkReceipt(await send(socket, body(1024, seq)), body(1024, seq));
  }
  assert.equal((await closed).code, 1000);
});
