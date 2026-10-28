import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as miniflare from 'miniflare';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
await build({ entryPoints: [root + 'test/entry.ts'], outfile: root + '.build/worker.mjs', bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] });
await build({ entryPoints: [root + 'src/protocol.ts'], outfile: root + '.build/protocol.mjs', bundle: true, format: 'esm', platform: 'browser' });
const { PacketStream, packet, parseConnect, parsePublish, parseSubscribe, prefix, MAX_PACKET_BYTES } = await import('../.build/protocol.mjs');
const TOKEN = randomBytes(24).toString('hex');
const NODE = 'test-node';
const BOOT = '26000000-0000-4000-8000-000000000001';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = value => new TextEncoder().encode(value);
const join = (...parts) => Uint8Array.from(Buffer.concat(parts.map(p => Buffer.from(p))));
const u16 = value => Uint8Array.of(value >> 8, value & 255);
const text = value => join(u16(bytes(value).length), bytes(value));
const connectPacket = (node = NODE, boot = BOOT, flags = 0x82) => packet(0x10, join(text('MQTT'), [4, flags, 0, 30], text(`${node}:${boot}`), text(node)));
const subscribePacket = (node = NODE, boot = BOOT, topic = `${prefix(node, boot)}/rep/+/+`) => packet(0x82, join([0, 1], text(topic), [1]));
const publish = (op, rpc, body = new Uint8Array(), { node = NODE, boot = BOOT, id = rpc % 65535 || 1, header = 0x32 } = {}) => packet(header, join(text(`${prefix(node, boot)}/req/${op}/${rpc}`), u16(id), body));
const decode = bytes => new PacketStream().feed(new Uint8Array(bytes))[0];
function response(bytes) {
  const p = decode(bytes); assert.equal(p.header, 0x30);
  const size = p.body[0] * 256 + p.body[1];
  return { topic: Buffer.from(p.body.subarray(2, 2 + size)).toString(), status: p.body[size + 2] * 256 + p.body[size + 3], body: Buffer.from(p.body.subarray(size + 4)).toString() };
}
let mf, db, calls = [], pendingRelease, backendMode = 'normal', backendDelay = 0;
let active = 0, peak = 0;
const sockets = new Set();

async function backend(request) {
  active++; peak = Math.max(peak, active);
  try {
    const url = new URL(request.url), body = Buffer.from(await request.arrayBuffer());
    assert.equal(url.origin, 'https://pulse.anend.net'); assert.equal(url.search, '');
    assert.equal(request.headers.get('Origin'), null);
    assert.equal(request.headers.get('X-CP-Node'), null);
    const credential = request.headers.get('Authorization');
    const node = await db.prepare('SELECT id FROM device_nodes WHERE credential_sha256=? AND enabled=1').bind(sha(credential?.slice(7) ?? '')).first();
    if (!node) return new Response('{"error":"unauthorized"}', { status: 401 });
    calls.push({ path: url.pathname, method: request.method, body, hash: request.headers.get('X-Body-SHA256') });
    if (backendMode === 'wait') await new Promise(resolve => { pendingRelease = resolve; });
    if (backendDelay) await new Promise(resolve => setTimeout(resolve, backendDelay));
    if (backendMode === 'error') return new Response('{"error":"invalid_fixture"}', { status: 422 });
    if (backendMode === 'unavailable') return new Response('{"error":"unavailable"}', { status: 503 });
    if (backendMode === 'oversize') return new Response('x'.repeat(2049), { status: 200 });
    if (url.pathname === '/api/v2/ingest') {
      assert.equal(request.method, 'POST'); assert.equal(request.headers.get('Content-Type'), 'application/json');
      assert.equal(request.headers.get('X-Body-SHA256'), sha(body));
      const id = JSON.parse(body.toString()).batch_id, hash = sha(body);
      const previous = await db.prepare('SELECT hash, ack FROM test_receipts WHERE id=?').bind(id).first();
      if (previous && previous.hash !== hash) return new Response('{"error":"batch_conflict"}', { status: 409 });
      const ack = previous?.ack ?? JSON.stringify({ batch_id: id, body_sha256: hash, received_at: new Date().toISOString(), committed: true });
      if (!previous) await db.prepare('INSERT INTO test_receipts VALUES(?,?,?)').bind(id, hash, ack).run();
      if (backendMode === 'lose-reply') await new Promise(resolve => { pendingRelease = resolve; });
      return new Response(ack, { status: 200 });
    }
    return new Response('{ "ok": true, "fixture": "synthetic" }', { status: 200 });
  } finally { active--; }
}

before(async () => {
  const convert = miniflare.convertV4MiniflareOptions ?? (options => options);
  const runtimeDate = require('workerd/package.json').version.match(/\d{8}/)?.[0];
  const date = runtimeDate ? `${runtimeDate.slice(0, 4)}-${runtimeDate.slice(4, 6)}-${runtimeDate.slice(6, 8)}` : '2026-10-19';
  mf = new miniflare.Miniflare(convert({
    name: 'gateway-test', modules: true, scriptPath: root + '.build/worker.mjs', compatibilityDate: date,
    bindings: { SESSION_WRAP_KEY: randomBytes(32).toString('base64') },
    durableObjects: { MQTT_SESSIONS: { className: 'MqttSession', useSQLite: true } },
    d1Databases: { DB: 'mqtt-test' }, serviceBindings: { INGEST_SERVICE: backend },
  }));
  await mf.ready; db = await mf.getD1Database('DB');
  await db.exec('CREATE TABLE device_nodes (id TEXT PRIMARY KEY, credential_sha256 TEXT, enabled INTEGER); CREATE TABLE test_receipts(id TEXT PRIMARY KEY, hash TEXT, ack TEXT);');
  await db.prepare('INSERT INTO device_nodes VALUES(?,?,1)').bind(NODE, sha(TOKEN)).run();
});
after(async () => {
  for (const s of sockets) { try { s.close(); } catch { /* already closed */ } }
  pendingRelease?.(); await mf?.dispose();
});

function inbox(socket) {
  const messages = [], waiters = []; let closed = false;
  socket.addEventListener('message', e => { const next = waiters.shift(); if (next) next.resolve(e.data); else messages.push(e.data); });
  const closeWaiters = [];
  socket.addEventListener('close', () => { closed = true; for (const done of closeWaiters) done(); });
  return {
    async next(timeout = 3000) {
      if (messages.length) return messages.shift();
      return new Promise((resolve, reject) => {
        const record = { resolve: value => { clearTimeout(timer); resolve(value); } };
        const timer = setTimeout(() => { waiters.splice(waiters.indexOf(record), 1); reject(new Error('Timed out waiting for MQTT response')); }, timeout);
        waiters.push(record);
      });
    },
    async closed(timeout = 3000) {
      if (closed) return;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for close')), timeout);
        closeWaiters.push(() => { clearTimeout(timer); resolve(); });
      });
    },
  };
}
async function connect({ handshake = true, subscribe = true, headers = {} } = {}) {
  const r = await mf.dispatchFetch('https://gateway.test/mqtt', { headers: {
    Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'mqtt', Authorization: `Bearer ${TOKEN}`, ...headers,
  } });
  assert.equal(r.status, 101); assert.equal(r.headers.get('Sec-WebSocket-Protocol'), 'mqtt');
  const socket = r.webSocket; socket.accept(); sockets.add(socket); const q = inbox(socket);
  if (handshake) { socket.send(connectPacket()); assert.deepEqual(Array.from(new Uint8Array(await q.next())), [0x20, 2, 0, 0]); }
  if (handshake && subscribe) { socket.send(subscribePacket()); assert.deepEqual(Array.from(new Uint8Array(await q.next())), [0x90, 3, 0, 1, 0]); }
  return { socket, q };
}
async function rpc(connection, op, id, body = new Uint8Array(), options) {
  connection.socket.send(publish(op, id, body, options));
  const ack = decode(await connection.q.next()); assert.equal(ack.header, 0x40);
  return response(await connection.q.next(18000));
}

test('handshake authenticates before routing and strips identity/header spoofing', async () => {
  for (const [headers, status] of [[{ Authorization: '' }, 401], [{ Authorization: 'Bearer wrong-token-aaaaaaaa' }, 401], [{ Origin: 'https://evil.test' }, 403], [{ 'Sec-WebSocket-Protocol': 'mqtt, other' }, 400]]) {
    const r = await mf.dispatchFetch('https://gateway.test/mqtt', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'mqtt', Authorization: `Bearer ${TOKEN}`, ...headers } });
    assert.equal(r.status, status); assert.equal(r.webSocket, null);
  }
  for (const url of ['https://gateway.test/mqtt?token=never', 'https://gateway.test/elsewhere']) assert.equal((await mf.dispatchFetch(url)).status, 404);
  const c = await connect({ headers: { 'X-CP-Node': 'victim', 'X-CP-Sealed': 'forged' } });
  assert.equal((await rpc(c, 'config', 1)).status, 200); c.socket.close();
});

test('strict MQTT grammar, fragmented remaining length and deterministic fuzz are bounded', () => {
  const maximum = publish('ingest', 1, new Uint8Array(8192));
  for (let split = 1; split < maximum.length; split += 47) {
    const p = new PacketStream(); assert.equal(p.feed(maximum.subarray(0, split)).length, 0);
    const result = p.feed(maximum.subarray(split)); assert.equal(result.length, 1); assert.equal(parsePublish(result[0], NODE, BOOT).body.length, 8192); assert.equal(p.partial, false);
  }
  for (const malformed of [[0xc0, 0x80, 0], [0xc0, 0xff, 0xff, 0xff, 0x7f], [0xc0, 0x80, 0x80, 0x80, 0x80]]) assert.throws(() => new PacketStream().feed(Uint8Array.from(malformed)));
  for (const flags of [0, 2, 0xc2, 0x86, 0x83]) assert.throws(() => parseConnect(decode(connectPacket(NODE, BOOT, flags)), NODE));
  const badUtf8 = packet(0x10, join(u16(2), [0xc0, 0x80], [4, 0x82, 0, 30], text(`${NODE}:${BOOT}`), text(NODE)));
  assert.throws(() => parseConnect(decode(badUtf8), NODE));
  const withBom = packet(0x10, join(text('\ufeffMQTT'), [4, 0x82, 0, 30], text(`${NODE}:${BOOT}`), text(NODE)));
  assert.throws(() => parseConnect(decode(withBom), NODE));
  assert.throws(() => parseConnect(decode(connectPacket('victim')), NODE));
  for (const topic of ['$SYS/#', `${prefix('victim', BOOT)}/rep/+/+`, `${prefix(NODE, BOOT)}/rep/#`]) assert.throws(() => parseSubscribe(decode(subscribePacket(NODE, BOOT, topic)), NODE, BOOT));
  for (const header of [0x30, 0x31, 0x33, 0x34, 0x36]) assert.throws(() => parsePublish(decode(publish('config', 1, new Uint8Array(), { header })), NODE, BOOT));
  for (const id of [0, '01', 4294967296]) assert.throws(() => parsePublish(decode(publish('config', id)), NODE, BOOT));
  assert.throws(() => parsePublish(decode(publish('config', 1, bytes('x'))), NODE, BOOT));
  assert.throws(() => new PacketStream().feed(new Uint8Array(MAX_PACKET_BYTES + 1)));
  let seed = 0x12345678;
  for (let n = 0; n < 3000; n++) {
    const input = new Uint8Array(n % 173 + 1);
    for (let i = 0; i < input.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; input[i] = seed >>> 24; }
    try { const packets = new PacketStream().feed(input); for (const p of packets) assert.ok(p.body.length <= MAX_PACKET_BYTES); } catch (e) { assert.equal(e.name, 'Error'); }
  }
});

test('all four operations use only fixed paths and preserve exact status/body bytes', async () => {
  calls = []; const c = await connect();
  for (const [index, op] of ['contact', 'config', 'activation', 'ingest'].entries()) {
    const body = op === 'config' ? new Uint8Array() : bytes(`{ "batch_id" : "${randomUUID()}", "spaced" : true }\n`);
    const result = await rpc(c, op, index + 1, body);
    assert.equal(result.status, 200); assert.equal(result.topic, `${prefix(NODE, BOOT)}/rep/${op}/${index + 1}`);
    if (op !== 'ingest') assert.equal(result.body, '{ "ok": true, "fixture": "synthetic" }');
    assert.deepEqual(calls.at(-1).body, Buffer.from(body));
  }
  assert.deepEqual(calls.map(c => [c.path, c.method]), [['/api/v2/device/contact', 'POST'], ['/api/v2/device/config', 'GET'], ['/api/v2/device/config/ack', 'POST'], ['/api/v2/ingest', 'POST']]); c.socket.close();
});

test('8 KiB requests span WS messages and binary replies remain bounded', async () => {
  const c = await connect(); const head = `{"batch_id":"${randomUUID()}","padding":"`;
  const body = bytes(head + 'x'.repeat(8192 - bytes(head).length - 2) + '"}'); assert.equal(body.length, 8192);
  const data = publish('ingest', 1, body);
  for (let i = 0; i < data.length; i += 1024) c.socket.send(data.subarray(i, i + 1024));
  assert.equal(decode(await c.q.next()).header, 0x40);
  assert.equal(JSON.parse(response(await c.q.next()).body).body_sha256, sha(body)); c.socket.close();
});

test('hibernation restores authenticated session/subscription/RPC replay state', async () => {
  const c = await connect(); await rpc(c, 'config', 10);
  await mf.unsafeEvictDurableObject('gateway-test', 'MqttSession', { name: NODE, webSockets: 'hibernate' });
  c.socket.send([0xc0, 0]); assert.equal(decode(await c.q.next()).header, 0xd0);
  assert.equal((await rpc(c, 'config', 11)).status, 200);
  c.socket.send(publish('config', 9)); await c.q.closed();
});

test('attachments encrypt credentials and interrupted pending/partial markers require reconnect', async () => {
  let c = await connect(); const state = await (await mf.dispatchFetch('https://gateway.test/__test/inspect')).json();
  assert.equal(state.length, 1); assert.ok(JSON.stringify(state).length < 2048);
  assert.equal(JSON.stringify(state).includes(TOKEN), false); assert.equal(JSON.stringify(state).includes('Bearer'), false);
  assert.equal(typeof state[0].token.ciphertext, 'string');
  await mf.dispatchFetch('https://gateway.test/__test/interrupt');
  await mf.unsafeEvictDurableObject('gateway-test', 'MqttSession', { name: NODE, webSockets: 'hibernate' });
  c.socket.send(Uint8Array.of(0xc0, 0)); await c.q.closed();
  c = await connect(); await mf.dispatchFetch('https://gateway.test/__test/interrupt?partial=1');
  await mf.unsafeEvictDurableObject('gateway-test', 'MqttSession', { name: NODE, webSockets: 'hibernate' });
  c.socket.send(Uint8Array.of(0xc0, 0)); await c.q.closed();
});

test('revocation is checked by existing backend on each RPC after upgrade', async () => {
  const c = await connect(); await db.prepare('UPDATE device_nodes SET enabled=0 WHERE id=?').bind(NODE).run();
  assert.equal((await rpc(c, 'config', 1)).status, 401); await c.q.closed();
  await db.prepare('UPDATE device_nodes SET enabled=1 WHERE id=?').bind(NODE).run();
});

test('MQTT PUBACK precedes backend receipt; duplicate inflight delivery forwards once', async () => {
  backendMode = 'wait'; calls = []; peak = 0;
  const c = await connect(); const body = bytes(`{"batch_id":"${randomUUID()}"}`);
  c.socket.send(publish('ingest', 1, body)); assert.equal(decode(await c.q.next()).header, 0x40);
  for (let i = 0; i < 40 && !pendingRelease; i++) await new Promise(r => setTimeout(r, 10));
  c.socket.send(publish('ingest', 1, body, { header: 0x3a })); assert.equal(decode(await c.q.next()).header, 0x40);
  assert.equal(calls.length, 1); assert.equal(peak, 1);
  backendMode = 'normal'; pendingRelease(); pendingRelease = undefined;
  assert.equal(response(await c.q.next()).status, 200); c.socket.close();
});

test('another pending RPC and conflicting retransmit close without second forward', async () => {
  for (const duplicateConflict of [false, true]) {
    backendMode = 'wait'; calls = []; const c = await connect();
    c.socket.send(publish('config', 1)); await c.q.next();
    for (let i = 0; i < 40 && !pendingRelease; i++) await new Promise(r => setTimeout(r, 10));
    c.socket.send(duplicateConflict ? publish('contact', 1, bytes('{}'), { header: 0x3a }) : publish('config', 2));
    await c.q.closed(); assert.equal(calls.length, 1);
    backendMode = 'normal'; pendingRelease(); pendingRelease = undefined;
    await new Promise(r => setTimeout(r, 30));
  }
});

test('durable identical batch retries survive lost replies/reconnect; changed bytes conflict', async () => {
  const id = randomUUID(), body = bytes(`{ "batch_id": "${id}" }`);
  let c = await connect(); const first = await rpc(c, 'ingest', 1, body); c.socket.close();
  c = await connect(); const second = await rpc(c, 'ingest', 1, body);
  assert.deepEqual(second, first);
  assert.equal((await rpc(c, 'ingest', 1, body, { header: 0x3a })).body, first.body);
  assert.equal((await rpc(c, 'ingest', 2, bytes(`{"batch_id":"${id}"}`))).status, 409);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM test_receipts WHERE id=?').bind(id).first()).n, 1); c.socket.close();
});

test('commit followed by client disconnect before reply is recovered by frozen retry', async () => {
  const id = randomUUID(), body = bytes(`{"batch_id":"${id}"}`);
  backendMode = 'lose-reply'; let c = await connect(); c.socket.send(publish('ingest', 1, body)); await c.q.next();
  for (let i = 0; i < 100 && !pendingRelease; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(pendingRelease); const stored = await db.prepare('SELECT ack FROM test_receipts WHERE id=?').bind(id).first(); assert.ok(stored);
  c.socket.close(); backendMode = 'normal'; pendingRelease(); pendingRelease = undefined;
  await new Promise(r => setTimeout(r, 30));
  c = await connect(); assert.equal((await rpc(c, 'ingest', 1, body)).body, stored.ack); c.socket.close();
});

test('server 422/503 are relayed unchanged and oversized responses never yield success', async () => {
  const c = await connect();
  for (const [n, mode, status, body] of [[1, 'error', 422, '{"error":"invalid_fixture"}'], [2, 'unavailable', 503, '{"error":"unavailable"}'], [3, 'oversize', 504, '{"error":"gateway_outcome_unknown"}']]) {
    backendMode = mode; const result = await rpc(c, 'config', n); assert.equal(result.status, status); assert.equal(result.body, body);
  }
  backendMode = 'normal'; c.socket.close();
});

test('live fragment timer pins the object until safe timeout, including eviction requests', async () => {
  let c = await connect(); c.socket.send(publish('ingest', 1, bytes('{}')).subarray(0, 3));
  await new Promise(r => setTimeout(r, 30));
  await mf.unsafeEvictDurableObject('gateway-test', 'MqttSession', { name: NODE, webSockets: 'hibernate' });
  c.socket.send(Uint8Array.of(0)); await c.q.closed();
  c = await connect(); c.socket.send(Uint8Array.of(0x32)); await c.q.closed(6500);
});

test('unsupported packets, cross-node topics, malformed text and pre-subscribe publish fail closed', async () => {
  for (const data of [[0x40, 2, 0, 1], [0xc1, 0], [0xe0, 1, 0], publish('config', 1, new Uint8Array(), { node: 'victim' }), publish('config', 1, new Uint8Array(), { header: 0x33 }), 'not binary']) {
    const c = await connect(); c.socket.send(typeof data === 'string' ? data : Uint8Array.from(data)); await c.q.closed();
  }
  const c = await connect({ subscribe: false }); c.socket.send(publish('config', 1)); await c.q.closed();
});

test('per-session frame rate limits remain effective after hibernation', async () => {
  const c = await connect();
  await mf.dispatchFetch('https://gateway.test/__test/rate');
  await mf.unsafeEvictDurableObject('gateway-test', 'MqttSession', { name: NODE, webSockets: 'hibernate' });
  // At the last permitted frame, 32 coalesced PING packets are still valid.
  const ping = Uint8Array.from(Array.from({ length: 32 }, () => [0xc0, 0]).flat());
  c.socket.send(ping);
  for (let i = 0; i < 32; i++) assert.equal(decode(await c.q.next()).header, 0xd0);
  c.socket.send(Uint8Array.of(0xc0, 0)); await c.q.closed();
});

test('deadline returns only outcome-unknown, never a fabricated backend receipt', async () => {
  backendMode = 'normal'; backendDelay = 15500; const c = await connect();
  const result = await rpc(c, 'config', 1); assert.equal(result.status, 504); assert.equal(result.body, '{"error":"gateway_outcome_unknown"}');
  c.socket.close(); backendDelay = 0;
  await new Promise(r => setTimeout(r, 600));
});
